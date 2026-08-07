// -----------------------------------------------------------------------------
// The service is what keeps the integration inside the SolarEdge budget: one
// snapshot shared by every device, a slower cadence for the daily breakdown,
// and capabilities derived from what the installation actually answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SolarEdgeService } from '../src/solaredge/service.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeClient } from './helpers/solaredgeFixtures.js';

function createService({ overrides = {}, config = {}, start = 0 } = {}) {
  const client = createFakeClient(overrides);
  let clock = start;
  const service = new SolarEdgeService(normalizeConfig({ api_key: 'K', ...config }), {
    client,
    now: () => new Date(clock),
  });
  return { service, client, advance: (seconds) => (clock += seconds * 1000) };
}

test('a snapshot costs 2 live requests, whatever the number of readers', async () => {
  const { service, client } = createService();

  await service.getSnapshot();
  await service.getSnapshot();
  await service.getSnapshot();
  await service.getSnapshot();

  // sites + details + flow + overview + energy, then nothing more.
  assert.deepEqual(client.calls, ['sites', 'details', 'flow', 'overview', 'energy']);
});

test('concurrent readers share a single in-flight refresh', async () => {
  const { service, client } = createService();

  await Promise.all([service.getSnapshot(), service.getSnapshot(), service.getSnapshot()]);

  assert.equal(client.calls.filter((c) => c === 'flow').length, 1);
});

test('the snapshot is refreshed once the polling interval has passed', async () => {
  const { service, client, advance } = createService({ config: { poll_frequency: 900 } });

  await service.getSnapshot();
  advance(600); // still inside the 80% freshness window
  await service.getSnapshot();
  assert.equal(client.calls.filter((c) => c === 'flow').length, 1);

  advance(300); // 900 s elapsed: a new cycle
  await service.getSnapshot();
  assert.equal(client.calls.filter((c) => c === 'flow').length, 2);
});

test('the daily breakdown follows its own, slower cadence', async () => {
  const { service, client, advance } = createService({
    config: { poll_frequency: 300, energy_details_frequency: 1800 },
  });

  for (let i = 0; i < 5; i += 1) {
    await service.getSnapshot();
    advance(300);
  }

  assert.equal(client.calls.filter((c) => c === 'flow').length, 5);
  assert.equal(
    client.calls.filter((c) => c === 'energy').length,
    1,
    'energyDetails must not follow every live cycle',
  );

  advance(1800);
  await service.getSnapshot();
  assert.equal(client.calls.filter((c) => c === 'energy').length, 2);
});

test('storageData is only fetched when the user asked for it', async () => {
  const off = createService();
  await off.service.getSnapshot();
  assert.equal(off.client.calls.includes('storage'), false);

  const on = createService({ config: { storage_details: true } });
  const snapshot = await on.service.getSnapshot();
  assert.equal(on.client.calls.includes('storage'), true);
  assert.equal(snapshot.storage.level, 62);
});

test('capabilities follow what the installation really reports', async () => {
  const full = createService();
  assert.deepEqual(await full.service.getCapabilities(), {
    production: true,
    consumption: true,
    grid: true,
    battery: true,
    revenue: true,
  });

  // Production-only site: no consumption meter, no battery, empty power flow.
  const bare = createService({
    overrides: {
      flow: {},
      energy: { unit: 'Wh', meters: [{ type: 'Production', values: [{ value: 1000 }] }] },
    },
  });
  assert.deepEqual(await bare.service.getCapabilities(), {
    production: true,
    consumption: false,
    grid: false,
    battery: false,
    // The overview fixture carries a revenue, so a tariff IS configured even
    // on this bare site: the capability is about the tariff, not the hardware.
    revenue: true,
  });
});

test('a site with meters but no live power flow still gets its devices', async () => {
  // Some older sites answer `{}` on currentPowerFlow yet do have meters.
  const { service } = createService({ overrides: { flow: {} } });
  const capabilities = await service.getCapabilities();
  assert.equal(capabilities.consumption, true);
  assert.equal(capabilities.grid, true);
  assert.equal(capabilities.battery, false);
});

test('the site id is auto-detected when the user left the field empty', async () => {
  const { service } = createService();
  assert.equal(await service.resolveSiteId(), '1234567');
});

test('several sites and no site_id is a configuration error, not a guess', async () => {
  const { service } = createService({
    overrides: {
      sites: [
        { id: 1, name: 'Maison' },
        { id: 2, name: 'Bureau' },
      ],
    },
  });
  await assert.rejects(() => service.resolveSiteId(), /fill in the "Site ID" setting/);
});

test('a configured site id short-circuits the sites listing', async () => {
  const { service, client } = createService({ config: { site_id: '42' } });
  assert.equal(await service.resolveSiteId(), '42');
  assert.equal(client.calls.includes('sites'), false);
});

test('one failing live endpoint does not lose the other', async () => {
  const { service } = createService({ overrides: { flow: new Error('boom') } });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.flow, null);
  assert.equal(snapshot.overview.energyToday, 21.4, 'the overview still went through');
});

test('a fully failed cycle rejects instead of serving stale values silently', async () => {
  const { service } = createService({
    overrides: { flow: new Error('down'), overview: new Error('down') },
  });
  await assert.rejects(() => service.getSnapshot(), /down/);
  assert.ok(service.lastError, 'the failure is recorded for the transport badge');
});

test('a failed energyDetails refresh keeps the previous breakdown', async () => {
  const { service, client, advance } = createService({
    config: { poll_frequency: 300, energy_details_frequency: 300 },
  });
  const first = await service.getSnapshot();
  assert.equal(first.energy.consumption, 9.8);

  client.getEnergyDetails = () => Promise.reject(new Error('nope'));
  advance(600);
  const second = await service.getSnapshot();
  assert.equal(second.energy.consumption, 9.8, 'the last known breakdown is kept');
});
