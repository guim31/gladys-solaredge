// -----------------------------------------------------------------------------
// End-to-end path, with only `fetch` stubbed: real client, real service, real
// device modules. This is the test that would catch a mismatch between the
// layers — a query parameter the client forgets, an envelope the service does
// not unwrap, a feature id the device builds differently at discovery and at
// poll time.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { SolarEdgeService } from '../src/solaredge/service.js';
import { SolarEdgeClient } from '../src/solaredge/client.js';
import { availableBlueprints, buildDiscoveredDevices } from '../src/devices/index.js';
import { createFakeGladys, stateOf } from './helpers/fakeGladys.js';
import {
  DEVICES,
  ENERGY_MONTHLY,
  LIFETIME_ENERGY,
  METERS_LIFETIME,
  METERS_TELEMETRY,
  OVERVIEW,
  POWER,
  SITE_DETAILS,
  STORAGE_STATUS,
  STORAGE_TELEMETRY,
} from './helpers/solaredgeFixtures.js';

const json = (status, body) => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** A `fetch` answering the SolarEdge V2 routes, recording every request. */
function createFakeFetch() {
  const requests = [];
  const routes = [
    [/^\/v2\/sites$/, { sites: { count: 1, site: [{ siteId: 1234567, name: 'Maison' }] } }],
    [/^\/v2\/sites\/\d+$/, SITE_DETAILS],
    [/^\/v2\/sites\/\d+\/overview$/, OVERVIEW],
    [/^\/v2\/sites\/\d+\/power$/, POWER],
    [/^\/v2\/sites\/\d+\/energy$/, ENERGY_MONTHLY],
    [/^\/v2\/sites\/\d+\/lifetime-energy$/, LIFETIME_ENERGY],
    [/^\/v2\/sites\/\d+\/devices$/, DEVICES],
    [/^\/v2\/sites\/\d+\/meters\/telemetry$/, METERS_TELEMETRY],
    [/^\/v2\/sites\/\d+\/meters\/lifetime-energy$/, METERS_LIFETIME],
    [/^\/v2\/sites\/\d+\/storage\/telemetry$/, STORAGE_TELEMETRY],
    [/^\/v2\/sites\/\d+\/storage\/status$/, STORAGE_STATUS],
  ];

  const impl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    requests.push({ url, headers: init.headers ?? {} });
    // Anything outside /v2 is the retired V1 API.
    if (!url.pathname.startsWith('/v2/')) {
      return json(410, { title: 'API Version Deprecated', status: 410 });
    }
    const route = routes.find(([pattern]) => pattern.test(url.pathname));
    return route ? json(200, route[1]) : json(404, { title: 'Not Found' });
  };
  impl.requests = requests;
  return impl;
}

function createService(configOverrides = {}) {
  const fetchImpl = createFakeFetch();
  const config = normalizeConfig({ api_key: 'FLEETKEY', ...configOverrides });
  const now = () => new Date('2024-05-18T13:42:00Z');
  const service = new SolarEdgeService(config, {
    client: new SolarEdgeClient({ apiKey: config.api_key, fetchImpl, now }),
    now,
  });
  return { service, config, fetchImpl };
}

test('a full cycle publishes every device from real HTTP responses', async () => {
  const gladys = createFakeGladys();
  const { service, config } = createService({ storage_details: true });

  const capabilities = await service.getCapabilities();
  const siteId = await service.resolveSiteId();
  const site = await service.getSite();
  const context = { config, siteId, site, capabilities };

  const devices = buildDiscoveredDevices(gladys, context);
  assert.equal(devices.length, 4, 'production, consumption, grid and battery');

  const snapshot = await service.getSnapshot();
  for (const blueprint of availableBlueprints(capabilities)) {
    await blueprint.onPoll(gladys, context, snapshot);
  }

  // Every published state must belong to a feature declared at discovery:
  // a mismatch here means Gladys would drop the value on the floor.
  const declared = new Set(devices.flatMap((d) => d.features.map((f) => f.external_id)));
  for (const entry of [...gladys.published, ...gladys.texts]) {
    assert.ok(
      declared.has(entry.featureExternalId),
      `published an undeclared feature: ${entry.featureExternalId}`,
    );
  }

  // ...and the values are the ones the fixtures describe.
  assert.equal(stateOf(gladys, 'energy-today'), 21.4);
  assert.equal(stateOf(gladys, 'self-consumption-today'), 7.3);
  assert.equal(stateOf(gladys, 'imported-today'), 2.5);
  assert.equal(stateOf(gladys, 'charge-level'), 62);
  assert.equal(stateOf(gladys, 'power'), 4200);
  assert.equal(stateOf(gladys, 'energy-total'), 18540);
  assert.equal(stateOf(gladys, 'temperature'), 25.1);
  assert.equal(gladys.texts[0].text, 'En charge');
});

test('the requests go to /v2 with the key in a header and UTC instants', async () => {
  const { service, fetchImpl } = createService();
  await service.getSnapshot();

  for (const { url, headers } of fetchImpl.requests) {
    assert.match(url.pathname, /^\/v2\//);
    assert.equal(url.searchParams.get('api_key'), null, `${url.pathname} leaks the key`);
    assert.equal(headers['X-API-Key'], 'FLEETKEY');
  }
  const power = fetchImpl.requests.find((r) => r.url.pathname.endsWith('/power')).url;
  assert.equal(power.searchParams.get('from'), '2024-05-18T12:57:00Z');
  assert.equal(power.searchParams.get('to'), '2024-05-18T13:42:00Z');
  const energy = fetchImpl.requests.find((r) => r.url.pathname.endsWith('/energy')).url;
  assert.equal(energy.searchParams.get('resolution'), 'MONTH');
  assert.equal(energy.searchParams.get('from'), '2023-12-31T00:00:00Z');
});

test('the whole detection stays cheap, and a cycle is shared by every device', async () => {
  const gladys = createFakeGladys();
  const { service, config, fetchImpl } = createService();

  const capabilities = await service.getCapabilities();
  const context = {
    config,
    capabilities,
    siteId: await service.resolveSiteId(),
    site: await service.getSite(),
  };

  const before = fetchImpl.requests.length;
  await Promise.all(
    availableBlueprints(capabilities).map(async (bp) =>
      bp.onPoll(gladys, context, await service.getSnapshot()),
    ),
  );
  assert.equal(fetchImpl.requests.length - before, 0, 'the cycle snapshot was already cached');
  // sites, details, devices, overview, meters, power, storage, energy, lifetime.
  assert.equal(fetchImpl.requests.length, 9);
});
