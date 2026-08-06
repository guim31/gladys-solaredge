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
  CURRENT_POWER_FLOW,
  ENERGY_DETAILS,
  OVERVIEW,
  SITE_DETAILS,
  STORAGE_DATA,
} from './helpers/solaredgeFixtures.js';

/** A `fetch` answering the real SolarEdge routes, recording every URL. */
function createFakeFetch() {
  const urls = [];
  const routes = [
    [/\/sites\/list$/, { sites: { count: 1, site: [{ id: 1234567, name: 'Maison' }] } }],
    [/\/site\/\d+\/details$/, { details: SITE_DETAILS }],
    [/\/site\/\d+\/currentPowerFlow$/, { siteCurrentPowerFlow: CURRENT_POWER_FLOW }],
    [/\/site\/\d+\/overview$/, { overview: OVERVIEW }],
    [/\/site\/\d+\/energyDetails$/, { energyDetails: ENERGY_DETAILS }],
    [/\/site\/\d+\/storageData$/, { storageData: STORAGE_DATA }],
  ];

  const impl = async (rawUrl) => {
    const url = new URL(rawUrl);
    urls.push(url);
    const route = routes.find(([pattern]) => pattern.test(url.pathname));
    if (!route) {
      return { ok: false, status: 404, text: async () => 'no such route' };
    }
    return { ok: true, status: 200, json: async () => route[1] };
  };
  impl.urls = urls;
  return impl;
}

function createService(configOverrides = {}) {
  const fetchImpl = createFakeFetch();
  const config = normalizeConfig({ api_key: 'TESTKEY', ...configOverrides });
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
  assert.equal(stateOf(gladys, 'temperature'), 25.1);
  assert.equal(gladys.texts[0].text, 'En charge');
});

test('the requests carry the API key, the meters and a site-local period', async () => {
  const { service, fetchImpl } = createService();
  await service.getSnapshot();

  for (const url of fetchImpl.urls) {
    assert.equal(url.searchParams.get('api_key'), 'TESTKEY', `${url.pathname} has no API key`);
  }

  const energy = fetchImpl.urls.find((u) => u.pathname.endsWith('/energyDetails'));
  assert.equal(energy.searchParams.get('timeUnit'), 'DAY');
  assert.equal(
    energy.searchParams.get('meters'),
    'PRODUCTION,CONSUMPTION,SELFCONSUMPTION,FEEDIN,PURCHASED',
  );
  // 13:42 UTC is 15:42 in Europe/Paris, the timezone of the site details.
  assert.equal(energy.searchParams.get('startTime'), '2024-05-18 00:00:00');
  assert.equal(energy.searchParams.get('endTime'), '2024-05-18 15:42:00');
});

test('four devices polling one cycle cost 2 live requests, not 8', async () => {
  const gladys = createFakeGladys();
  const { service, config, fetchImpl } = createService();

  const capabilities = await service.getCapabilities();
  const context = {
    config,
    capabilities,
    siteId: await service.resolveSiteId(),
    site: await service.getSite(),
  };

  const before = fetchImpl.urls.length;
  // Gladys polls the four devices back to back, as it does in production.
  await Promise.all(
    availableBlueprints(capabilities).map(async (bp) =>
      bp.onPoll(gladys, context, await service.getSnapshot()),
    ),
  );

  assert.equal(fetchImpl.urls.length - before, 0, 'the cycle snapshot was already cached');

  // And the whole bootstrap stayed cheap: sites, details, flow, overview,
  // energyDetails — five requests, once.
  assert.equal(fetchImpl.urls.length, 5);
});
