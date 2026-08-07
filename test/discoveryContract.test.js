// -----------------------------------------------------------------------------
// The discovery payload against the REAL Gladys admission rules.
//
// Why this file exists: the integration once shipped `poll_frequency: 900`,
// meaning "900 seconds" — but the core validates that field against a CLOSED
// enum expressed in MILLISECONDS and rejected the whole payload with
// `devices[0].poll_frequency: invalid poll frequency`. Every unit test passed,
// because the test double accepted anything. The bug was only visible against
// a running Gladys.
//
// So this file re-implements, check for check, what
// `externalIntegration.setDiscoveredDevices.js` does server side. It is
// deliberately a duplicate of someone else's validation: a payload that fails
// here is a payload Gladys would refuse, and finding that out takes a test run
// instead of a Docker build, a release and a manual install.
//
// The reference lists come from the SDK, which mirrors the Gladys constants
// verbatim — except DEVICE_POLL_FREQUENCIES, which the SDK does not export and
// which is therefore transcribed below.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import { GLADYS_POLL_FREQUENCY } from '../src/devices/helpers.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { SITE_DETAILS } from './helpers/solaredgeFixtures.js';

/** server/utils/constants.js — DEVICE_POLL_FREQUENCIES, in milliseconds. */
const DEVICE_POLL_FREQUENCIES_LIST = [60 * 1000, 30 * 1000, 15 * 1000, 10 * 1000, 2 * 1000, 1000];

/** server/utils/constants.js — createList(): flattens one nesting level. */
function createList(obj) {
  return Object.values(obj).flatMap((value) =>
    typeof value === 'object' && value !== null ? Object.values(value) : [value],
  );
}

const CATEGORIES = createList(DEVICE_FEATURE_CATEGORIES);
const TYPES = createList(DEVICE_FEATURE_TYPES);
const UNITS = createList(DEVICE_FEATURE_UNITS);

const MAX_DISCOVERED_DEVICES = 100;
const EXTERNAL_ID_PREFIX = 'ext:solaredge:';

/**
 * Run the core's admission checks, in their order, and return every problem
 * instead of only the first — the server throws on the first one, which is
 * exactly what made the original bug take a round-trip per defect to find.
 */
function validateDiscoveredDevices(devices) {
  const problems = [];
  if (!Array.isArray(devices)) {
    return ['devices: must be an array'];
  }
  if (devices.length > MAX_DISCOVERED_DEVICES) {
    problems.push(`devices: max ${MAX_DISCOVERED_DEVICES} devices`);
  }

  devices.forEach((device, index) => {
    if (device === null || typeof device !== 'object') {
      problems.push(`devices[${index}]: must be an object`);
      return;
    }
    if (typeof device.name !== 'string' || device.name.length === 0) {
      problems.push(`devices[${index}].name: must be a non-empty string`);
    }
    if (
      typeof device.external_id !== 'string' ||
      !device.external_id.startsWith(EXTERNAL_ID_PREFIX)
    ) {
      problems.push(`devices[${index}].external_id: must start with "${EXTERNAL_ID_PREFIX}"`);
    }
    if (
      device.poll_frequency !== undefined &&
      !DEVICE_POLL_FREQUENCIES_LIST.includes(device.poll_frequency)
    ) {
      problems.push(`devices[${index}].poll_frequency: invalid poll frequency`);
    }
    if (!Array.isArray(device.features)) {
      problems.push(`devices[${index}].features: must be an array`);
      return;
    }
    device.features.forEach((feature, featureIndex) => {
      const path = `devices[${index}].features[${featureIndex}]`;
      if (feature === null || typeof feature !== 'object') {
        problems.push(`${path}: must be an object`);
        return;
      }
      if (
        typeof feature.external_id !== 'string' ||
        !feature.external_id.startsWith(EXTERNAL_ID_PREFIX)
      ) {
        problems.push(`${path}.external_id: must start with "${EXTERNAL_ID_PREFIX}"`);
      }
      if (!CATEGORIES.includes(feature.category)) {
        problems.push(`${path}.category: unknown category (${feature.category})`);
      }
      if (!TYPES.includes(feature.type)) {
        problems.push(`${path}.type: unknown type (${feature.type})`);
      }
      if (feature.unit !== undefined && feature.unit !== null && !UNITS.includes(feature.unit)) {
        problems.push(`${path}.unit: unknown unit (${feature.unit})`);
      }
    });
  });

  return problems;
}

/**
 * Would the core actually SCHEDULE this device for polling?
 *
 * `server/lib/device/device.add.js` gates it on both fields:
 *
 *     if (device.should_poll === true && device.poll_frequency) { ... }
 *
 * Nothing rejects a device that declares only `poll_frequency`: the discovery
 * endpoint accepts it, the user creates it, and it is then never polled — the
 * dashboard shows "no recent value" forever and no log line says why. So this
 * belongs in the contract just as much as the admission rules above.
 */
function wouldBePolled(device) {
  return device.should_poll === true && Boolean(device.poll_frequency);
}

const ALL_CAPABILITIES = { production: true, consumption: true, grid: true, battery: true };

function buildPayload(overrides = {}) {
  return buildDiscoveredDevices(createFakeGladys(), {
    config: normalizeConfig({ api_key: 'K', ...overrides.config }),
    siteId: '1155110',
    site: SITE_DETAILS,
    capabilities: { ...ALL_CAPABILITIES, ...overrides.capabilities },
  });
}

test('the full catalog passes the Gladys admission rules', () => {
  assert.deepEqual(validateDiscoveredDevices(buildPayload()), []);
});

test('the catalog still passes with every optional feature enabled', () => {
  // The battery telemetry features only exist with this setting on, so the
  // nominal payload would never exercise their category/type/unit.
  assert.deepEqual(
    validateDiscoveredDevices(buildPayload({ config: { storage_details: true } })),
    [],
  );
});

test('every currency offered by the manifest is a unit Gladys knows', () => {
  for (const currency of ['euro', 'dollar', 'pound-sterling']) {
    assert.deepEqual(
      validateDiscoveredDevices(buildPayload({ config: { currency } })),
      [],
      `currency "${currency}" produces an invalid unit`,
    );
  }
});

test('a production-only installation passes too', () => {
  const payload = buildPayload({
    capabilities: { consumption: false, grid: false, battery: false },
  });
  assert.equal(payload.length, 1);
  assert.deepEqual(validateDiscoveredDevices(payload), []);
});

test('poll_frequency is one of the values the core accepts, in milliseconds', () => {
  assert.ok(
    DEVICE_POLL_FREQUENCIES_LIST.includes(GLADYS_POLL_FREQUENCY),
    `${GLADYS_POLL_FREQUENCY} is not in the DEVICE_POLL_FREQUENCIES enum`,
  );
  for (const device of buildPayload()) {
    assert.equal(device.poll_frequency, GLADYS_POLL_FREQUENCY);
  }
});

test('the poll frequency is a Gladys tick, never the SolarEdge refresh rate', () => {
  // The user-facing "Refresh interval" is in SECONDS and goes up to 3600.
  // Feeding it to poll_frequency is the original bug; this pins the two apart.
  const slowConfig = normalizeConfig({ api_key: 'K', poll_frequency: 3600 });
  const devices = buildDiscoveredDevices(createFakeGladys(), {
    config: slowConfig,
    siteId: '1155110',
    site: SITE_DETAILS,
    capabilities: ALL_CAPABILITIES,
  });
  for (const device of devices) {
    assert.notEqual(
      device.poll_frequency,
      slowConfig.poll_frequency,
      'the SolarEdge cadence must not leak into poll_frequency',
    );
  }
  assert.deepEqual(validateDiscoveredDevices(devices), []);
});

test('every published device is one the core will actually poll', () => {
  // Every device of this integration is read-only and refreshed by polling:
  // one that Gladys never schedules would show nothing, forever.
  for (const device of buildPayload()) {
    assert.ok(wouldBePolled(device), `${device.name} would never be polled by Gladys`);
  }
  for (const device of buildPayload({
    capabilities: { consumption: false, grid: false, battery: false },
  })) {
    assert.ok(wouldBePolled(device), `${device.name} would never be polled by Gladys`);
  }
});

test('poll_frequency without should_poll is recognised as never-polled', () => {
  // Guard the guard: this is exactly the payload that shipped and left every
  // feature on "no recent value".
  const device = buildPayload()[0];
  assert.equal(wouldBePolled({ ...device, should_poll: undefined }), false);
  assert.equal(wouldBePolled({ ...device, should_poll: 'true' }), false, 'the core tests === true');
  assert.equal(wouldBePolled({ ...device, poll_frequency: undefined }), false);
});

test('the validator itself catches the bug that shipped', () => {
  // Guard the guard: a validator that never fails would be worthless.
  const broken = buildPayload();
  broken[0].poll_frequency = 900;
  assert.deepEqual(validateDiscoveredDevices(broken), [
    'devices[0].poll_frequency: invalid poll frequency',
  ]);

  const badUnit = buildPayload();
  badUnit[0].features[0].unit = 'kilowatts-peak';
  assert.equal(validateDiscoveredDevices(badUnit).length, 1);
});
