// -----------------------------------------------------------------------------
// Device catalog: discovery payloads, dispatch, and the states each device
// publishes from a shared snapshot.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import {
  DEVICE_BLUEPRINTS,
  availableBlueprints,
  buildDiscoveredDevices,
  buildTransportEntries,
  findBlueprintByDevice,
} from '../src/devices/index.js';
import { GLADYS_POLL_FREQUENCY } from '../src/devices/helpers.js';
import { normalizeConfig } from '../src/config.js';
import { SolarEdgeService } from '../src/solaredge/service.js';
import { createFakeGladys, stateOf } from './helpers/fakeGladys.js';
import { createFakeClient, SITE_DETAILS } from './helpers/solaredgeFixtures.js';

const FULL_CAPABILITIES = { production: true, consumption: true, grid: true, battery: true };

function createContext(overrides = {}) {
  return {
    config: normalizeConfig({ api_key: 'K', ...overrides.config }),
    siteId: '1234567',
    site: SITE_DETAILS,
    capabilities: { ...FULL_CAPABILITIES, ...overrides.capabilities },
  };
}

/** A real snapshot, produced by the service from the fixtures. */
async function buildSnapshot(config = {}) {
  const service = new SolarEdgeService(normalizeConfig({ api_key: 'K', ...config }), {
    client: createFakeClient(),
    now: () => new Date('2024-05-18T13:42:00Z'),
  });
  return service.getSnapshot();
}

test('every blueprint exposes the required shape', () => {
  for (const bp of DEVICE_BLUEPRINTS) {
    assert.equal(typeof bp.key, 'string');
    assert.equal(typeof bp.isAvailable, 'function');
    assert.equal(typeof bp.deviceExternalId, 'function');
    assert.equal(typeof bp.buildDevice, 'function');
    assert.equal(typeof bp.onPoll, 'function');
  }
});

test('discovery publishes one payload per available device', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, createContext());

  assert.equal(devices.length, DEVICE_BLUEPRINTS.length);
  for (const device of devices) {
    assert.equal(typeof device.name, 'string');
    assert.ok(device.external_id);
    assert.ok(Array.isArray(device.features) && device.features.length > 0);
    // The Gladys tick, not the SolarEdge cadence — see helpers.js. This
    // assertion used to read `900`, which is what let the invalid value ship.
    assert.equal(device.poll_frequency, GLADYS_POLL_FREQUENCY);
    for (const feature of device.features) {
      assert.ok(feature.external_id, `${device.name}: every feature needs an external_id`);
      assert.ok(feature.category && feature.type);
      assert.equal(feature.read_only, true, 'SolarEdge is read-only: nothing is commandable');
    }
  }
});

test('device and feature external_ids are unique across the catalog', () => {
  const gladys = createFakeGladys();
  const devices = buildDiscoveredDevices(gladys, createContext());

  const deviceIds = devices.map((d) => d.external_id);
  assert.equal(new Set(deviceIds).size, deviceIds.length);

  const featureIds = devices.flatMap((d) => d.features.map((f) => f.external_id));
  assert.equal(new Set(featureIds).size, featureIds.length);
});

test('external_ids are derived from the site id, so two sites never collide', () => {
  const gladys = createFakeGladys();
  const first = buildDiscoveredDevices(gladys, createContext()).map((d) => d.external_id);
  const second = buildDiscoveredDevices(gladys, { ...createContext(), siteId: '7654321' }).map(
    (d) => d.external_id,
  );
  assert.equal(
    first.some((id) => second.includes(id)),
    false,
  );
});

test('a production-only installation gets exactly one device', () => {
  const gladys = createFakeGladys();
  const context = createContext({
    capabilities: { consumption: false, grid: false, battery: false },
  });
  const devices = buildDiscoveredDevices(gladys, context);

  assert.equal(devices.length, 1);
  assert.match(devices[0].name, /Production/);
});

test('the battery telemetry features only exist when the setting is on', () => {
  const gladys = createFakeGladys();
  const withoutDetails = buildDiscoveredDevices(gladys, createContext()).find((d) =>
    d.name.includes('Batterie'),
  );
  const withDetails = buildDiscoveredDevices(
    gladys,
    createContext({ config: { storage_details: true } }),
  ).find((d) => d.name.includes('Batterie'));

  assert.equal(withoutDetails.features.length, 4);
  assert.equal(withDetails.features.length, 6);
  assert.ok(
    withDetails.features.some(
      (f) => f.category === DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR,
    ),
  );
});

test('findBlueprintByDevice routes an external_id back to its owner', () => {
  const gladys = createFakeGladys();
  const context = createContext();
  for (const bp of DEVICE_BLUEPRINTS) {
    const external_id = bp.deviceExternalId(gladys, context);
    assert.equal(findBlueprintByDevice(gladys, context, { external_id }), bp);
  }
  assert.equal(
    findBlueprintByDevice(gladys, context, { external_id: 'does-not-exist' }),
    undefined,
  );
});

test('the production device publishes power and every counter', async () => {
  const gladys = createFakeGladys();
  const snapshot = await buildSnapshot();
  const bp = DEVICE_BLUEPRINTS.find((b) => b.key === 'solaredge-production');

  await bp.onPoll(gladys, createContext(), snapshot);

  assert.equal(stateOf(gladys, 'power'), 4200);
  assert.equal(stateOf(gladys, 'energy-today'), 21.4);
  assert.equal(stateOf(gladys, 'energy-month'), 612);
  assert.equal(stateOf(gladys, 'energy-year'), 4120);
  assert.equal(stateOf(gladys, 'energy-total'), 18540);
  assert.equal(stateOf(gladys, 'revenue-today'), 3.21);
});

test('the grid device publishes the signed power and both daily counters', async () => {
  const gladys = createFakeGladys();
  const snapshot = await buildSnapshot();
  const bp = DEVICE_BLUEPRINTS.find((b) => b.key === 'solaredge-grid');

  await bp.onPoll(gladys, createContext(), snapshot);

  assert.equal(stateOf(gladys, 'power'), -1600, 'exporting the surplus is negative');
  assert.equal(stateOf(gladys, 'imported-today'), 2.5);
  assert.equal(stateOf(gladys, 'exported-today'), 14.1);
});

test('the consumption device publishes load and self-consumption', async () => {
  const gladys = createFakeGladys();
  const snapshot = await buildSnapshot();
  const bp = DEVICE_BLUEPRINTS.find((b) => b.key === 'solaredge-consumption');

  await bp.onPoll(gladys, createContext(), snapshot);

  assert.equal(stateOf(gladys, 'power'), 1100);
  assert.equal(stateOf(gladys, 'energy-today'), 9.8);
  assert.equal(stateOf(gladys, 'self-consumption-today'), 7.3);
});

test('the battery publishes its level, its signed power and a text state', async () => {
  const gladys = createFakeGladys();
  const snapshot = await buildSnapshot();
  const bp = DEVICE_BLUEPRINTS.find((b) => b.key === 'solaredge-battery');

  await bp.onPoll(gladys, createContext(), snapshot);

  assert.equal(stateOf(gladys, 'charge-level'), 62);
  assert.equal(stateOf(gladys, 'power'), 1500, 'charging is positive');
  assert.equal(stateOf(gladys, 'critical'), 0);
  assert.equal(gladys.texts.length, 1);
  assert.equal(gladys.texts[0].text, 'En charge');
});

test('a missing reading is skipped, never published as a zero', async () => {
  const gladys = createFakeGladys();
  const snapshot = await buildSnapshot();
  // Simulate an `energyDetails` refresh that never succeeded.
  snapshot.energy = null;
  const bp = DEVICE_BLUEPRINTS.find((b) => b.key === 'solaredge-consumption');

  await bp.onPoll(gladys, createContext(), snapshot);

  assert.equal(stateOf(gladys, 'power'), 1100);
  assert.equal(stateOf(gladys, 'energy-today'), undefined);
  assert.equal(stateOf(gladys, 'self-consumption-today'), undefined);
});

test('the battery device stays quiet when the snapshot has no storage', async () => {
  const gladys = createFakeGladys();
  const snapshot = await buildSnapshot();
  snapshot.flow.battery = null;
  const bp = DEVICE_BLUEPRINTS.find((b) => b.key === 'solaredge-battery');

  await bp.onPoll(gladys, createContext(), snapshot);

  assert.equal(gladys.published.length, 0);
  assert.equal(gladys.texts.length, 0);
});

test('transports report the cloud, and flag the quota instead of hiding it', () => {
  const gladys = createFakeGladys();
  const context = createContext();

  const healthy = buildTransportEntries(gladys, context, {});
  assert.equal(healthy.length, availableBlueprints(context.capabilities).length);
  for (const entry of healthy) {
    assert.equal(entry.transport, DEVICE_TRANSPORTS.CLOUD);
    assert.equal(entry.degraded, undefined, 'a nominal entry clears a previous degraded state');
  }

  const quota = buildTransportEntries(gladys, context, { error: { code: 'quota_exceeded' } });
  assert.equal(quota[0].transport, DEVICE_TRANSPORTS.CLOUD);
  assert.equal(quota[0].degraded, true);
  assert.ok(quota[0].message.en);

  const down = buildTransportEntries(gladys, context, { error: { code: 'unavailable' } });
  assert.equal(down[0].transport, DEVICE_TRANSPORTS.UNREACHABLE);
});
