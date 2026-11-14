// -----------------------------------------------------------------------------
// The service is what keeps the integration inside the SolarEdge credits: one
// snapshot shared by every device, only the calls the hardware needs, the
// expensive totals once a day, an interval stretched to fit the month, and
// capabilities derived from what the installation actually answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SolarEdgeService } from '../src/solaredge/service.js';
import { ERROR_CODES, SolarEdgeError } from '../src/solaredge/client.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeClient, createInverterOnlyClient } from './helpers/solaredgeFixtures.js';

// 15:42 in Nantes, the afternoon of the fixtures.
const START = new Date('2024-05-18T13:42:00Z').getTime();

function createService({ overrides = {}, config = {}, client } = {}) {
  const fake = client ?? createFakeClient(overrides);
  let clock = START;
  const service = new SolarEdgeService(normalizeConfig({ api_key: 'K', ...config }), {
    client: fake,
    now: () => new Date(clock),
  });
  return {
    service,
    client: fake,
    advance: (seconds) => (clock += seconds * 1000),
    count: (name) => fake.calls.filter((c) => c === name).length,
  };
}

test('a first snapshot reads what the hardware needs, then the daily totals', async () => {
  const { service, client } = createService();
  await service.getSnapshot();
  assert.deepEqual(client.calls, [
    'sites',
    'details',
    'devices',
    'overview',
    'meters',
    // The meter has no production direction: the PV power comes from /power.
    'power',
    'storage',
    'energy',
    'lifetime',
  ]);
});

test('every reader shares one snapshot, and concurrent readers one refresh', async () => {
  const { service, count } = createService();
  await Promise.all([service.getSnapshot(), service.getSnapshot(), service.getSnapshot()]);
  await service.getSnapshot();
  assert.equal(count('overview'), 1);
});

test('the snapshot maps V2 onto the figures the devices read', async () => {
  const { service } = createService({ config: { storage_details: true } });
  const snapshot = await service.getSnapshot();
  assert.deepEqual(snapshot.flow, {
    pv: 4200,
    load: 1100,
    grid: -1600,
    battery: { power: 1500, level: 62, energyStored: 5.95, state: 'charging', critical: false },
  });
  assert.deepEqual(snapshot.energy, {
    production: 21.4,
    feedIn: 14.1,
    consumption: 9.8,
    selfConsumption: 7.3,
    purchased: 2.5,
  });
  assert.deepEqual(snapshot.overview, {
    currentPower: null,
    energyToday: 21.4,
    energyMonth: 612,
    energyYear: 4120,
    energyLifetime: 18540,
    revenueToday: null,
    revenueLifetime: null,
  });
  assert.deepEqual(snapshot.storage, { level: 62, energyStored: 5.95, temperature: 25.1 });
});

test('a lone inverter costs 2 requests a cycle: overview and power', async () => {
  const { service, client, advance } = createService({ client: createInverterOnlyClient() });
  await service.getSnapshot();
  client.calls.length = 0;
  advance(service.refreshInterval());
  await service.getSnapshot();
  assert.deepEqual(client.calls, ['overview', 'power']);
  assert.equal(service.callsPerCycle, 2);
});

test('a production meter spares the /power call', async () => {
  const { service, client } = createService({
    overrides: {
      devices: [{ type: 'METER', meterType: 'Production', active: true }],
      meters: {
        meters: { m: { productionPower: { unit: 'W', values: [{ value: 3900 }] } } },
      },
    },
  });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.flow.pv, 3900);
  assert.equal(client.calls.includes('power'), false);
  assert.equal(service.callsPerCycle, 2);
});

test('the battery temperature is only fetched when the user asked for it', async () => {
  const off = createService();
  await off.service.getSnapshot();
  assert.equal(off.count('storageStatus'), 0);
  assert.equal((await off.service.getSnapshot()).storage.temperature, null);

  const on = createService({ config: { storage_details: true } });
  await on.service.getSnapshot();
  assert.equal(on.count('storageStatus'), 1);
  assert.equal(on.service.callsPerCycle, 5);
});

test('the interval is stretched until a month of cycles fits in the credits', async () => {
  const lone = createService({ client: createInverterOnlyClient() });
  await lone.service.getCapabilities();
  // 64 a day - 2 daily totals - 6 kept aside = 56; 2 per cycle: 28 cycles a day.
  assert.equal(lone.service.refreshInterval(), Math.ceil((86_400 * 2) / 56));

  const full = createService();
  await full.service.getCapabilities();
  // 4 per cycle, 3 daily totals (the import counter too).
  assert.equal(full.service.refreshInterval(), Math.ceil((86_400 * 4) / 55));

  // A paid plan: the user's own interval wins.
  const paid = createService({ config: { monthly_credits: 20_000, poll_frequency: 900 } });
  paid.client.dailyRequestLimit = 645;
  await paid.service.getCapabilities();
  assert.equal(paid.service.refreshInterval(), 900);
});

test('the snapshot is refreshed once the refresh interval has passed', async () => {
  const { service, advance, count } = createService();
  await service.getSnapshot();
  const interval = service.refreshInterval();
  advance(interval * 0.5);
  await service.getSnapshot();
  assert.equal(count('overview'), 1);
  advance(interval * 0.5);
  await service.getSnapshot();
  assert.equal(count('overview'), 2);
});

test('the daily totals are read once per site day, and follow the day for free', async () => {
  const overview = (wh) => ({
    production: { total: wh, unit: 'WH' },
    consumption: { total: null, unit: 'WH' },
  });
  const { service, client, advance, count } = createService({ client: createInverterOnlyClient() });
  client.getOverview = async () => (client.calls.push('overview'), overview(9844));
  client.getEnergy = async () => (
    client.calls.push('energy'),
    {
      unit: 'WH',
      values: [
        { timestamp: '2024-01-01T00:00:00+01:00', value: 3_000_000 },
        { timestamp: '2024-05-01T00:00:00+02:00', value: 52_537 },
      ],
    }
  );
  const first = await service.getSnapshot();
  assert.equal(first.overview.energyLifetime, 26618.84);
  assert.equal(first.overview.energyYear, 3052.54);

  // Two hours later, 1 kWh more today: the totals move with it, no new read.
  client.getOverview = async () => (client.calls.push('overview'), overview(10_844));
  advance(7200);
  const later = await service.getSnapshot();
  assert.equal(later.overview.energyLifetime, 26619.84);
  assert.equal(later.overview.energyMonth, 53.54);
  assert.equal(later.overview.energyYear, 3053.54);
  assert.equal(count('lifetime'), 1);
  assert.equal(count('energy'), 1);

  // Past the site's midnight (22:00 UTC in May): read again.
  client.getOverview = async () => (client.calls.push('overview'), overview(0));
  advance(8 * 3600 + 600);
  await service.getSnapshot();
  assert.equal(count('lifetime'), 2);
});

test('the lifetime production never goes backwards', async () => {
  const { service, client, advance } = createService({ client: createInverterOnlyClient() });
  await service.getSnapshot();
  // Next day, the counter was read a little late: lower than what was published.
  client.getLifetimeEnergy = async () => ({ energy: 26_600_000, unit: 'WH' });
  advance(12 * 3600);
  const next = await service.getSnapshot();
  assert.equal(next.overview.energyLifetime, 26618.84);
});

test('a failed daily read is retried an hour later, not every cycle', async () => {
  const { service, client, advance, count } = createService({
    client: createInverterOnlyClient(),
    config: { monthly_credits: 100_000 },
  });
  client.dailyRequestLimit = 3000;
  client.getLifetimeEnergy = async () => {
    client.calls.push('lifetime');
    throw new SolarEdgeError('boom', { code: ERROR_CODES.UNAVAILABLE });
  };
  const first = await service.getSnapshot();
  assert.equal(first.overview.energyLifetime, null);
  assert.equal(first.overview.energyToday, 9.84, 'the cycle itself went through');
  advance(900);
  await service.getSnapshot();
  assert.equal(count('lifetime'), 1);
  advance(3600);
  await service.getSnapshot();
  assert.equal(count('lifetime'), 2);
});

test('capabilities follow what the installation really reports', async () => {
  const full = createService();
  assert.deepEqual(await full.service.getCapabilities(), {
    production: true,
    consumption: true,
    grid: true,
    battery: true,
    gridImport: true,
    revenue: false,
  });

  const lone = createService({ client: createInverterOnlyClient() });
  assert.deepEqual(await lone.service.getCapabilities(), {
    production: true,
    consumption: false,
    grid: false,
    battery: false,
    gridImport: false,
    revenue: false,
  });
});

test('a meter in the inventory without a reading is no capability', async () => {
  const { service } = createService({
    overrides: { meters: { meters: {} }, devices: [{ type: 'METER', meterType: 'FeedIn' }] },
  });
  const capabilities = await service.getCapabilities();
  assert.equal(capabilities.consumption, false);
  assert.equal(capabilities.grid, false);
});

test('a re-probe without a reading keeps the hardware already detected', async () => {
  const { service, client, advance } = createService();
  assert.equal((await service.getCapabilities()).grid, true);
  advance(3600);
  client.getMetersTelemetry = async () => {
    throw new Error('timeout');
  };
  client.getDevices = async () => [];
  const again = await service.getCapabilities({ force: true });
  assert.equal(again.grid, true);
  assert.equal(again.consumption, true);
  assert.equal(again.battery, true);
});

test('an inventory refused (no DEVICE_DATA scope) falls back to production only', async () => {
  const { service } = createService({
    overrides: {
      devices: new SolarEdgeError('denied', { code: ERROR_CODES.UNAUTHORIZED, status: 403 }),
    },
  });
  const capabilities = await service.getCapabilities();
  assert.equal(capabilities.production, true);
  assert.equal(capabilities.grid, false);
});

test('the grid import index is the meter counter, read once the capability is known', async () => {
  const { service, client, advance, count } = createService();
  await service.getCapabilities();
  assert.equal(count('importCounter'), 0, 'unknown during the first detection cycle');

  advance(service.refreshInterval());
  const snapshot = await service.getSnapshot();
  assert.equal(count('importCounter'), 1);
  assert.equal(snapshot.gridImportIndex, 3456.7);

  // Later the same day, 0.4 kWh more bought: the index follows, no new read.
  client.getOverview = async () => ({
    production: { total: 21_400, unit: 'WH' },
    consumption: { total: 10_200, unit: 'WH', fromPv: 5400, fromStorage: 1900, fromGrid: 2900 },
  });
  advance(service.refreshInterval());
  const later = await service.getSnapshot();
  assert.equal(later.gridImportIndex, 3457.1);
  assert.equal(count('importCounter'), 1);
});

test('the site id is auto-detected with a Fleet key covering one site', async () => {
  const { service } = createService();
  assert.equal(await service.resolveSiteId(), '1234567');
});

test('several sites and no site_id is a configuration error, not a guess', async () => {
  const { service } = createService({
    overrides: {
      sites: [
        { siteId: 1, name: 'Maison' },
        { siteId: 2, name: 'Bureau' },
      ],
    },
  });
  await assert.rejects(() => service.resolveSiteId(), /\(1, 2\): fill in the "Site ID" setting/);
});

test('with OAuth the site id is required: a token cannot list sites', async () => {
  const { service, client } = createService({ overrides: { mode: 'oauth' } });
  await assert.rejects(
    () => service.resolveSiteId(),
    (err) => err.code === ERROR_CODES.NOT_FOUND && /Site ID/.test(err.message),
  );
  assert.equal(client.calls.includes('sites'), false);
});

test('a configured site id short-circuits the sites listing', async () => {
  const { service, client } = createService({ config: { site_id: '42' } });
  assert.equal(await service.resolveSiteId(), '42');
  assert.equal(client.calls.includes('sites'), false);
});

test('one failing live endpoint keeps the cycle and the last value', async () => {
  const { service, client, advance } = createService();
  await service.getSnapshot();
  client.getMetersTelemetry = async () => {
    throw new Error('boom');
  };
  advance(service.refreshInterval());
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.flow.load, 1100, 'the last known home power is kept');
  assert.equal(snapshot.energy.consumption, 9.8, 'the overview still went through');
});

test('a sleeping inverter reads 0 W, not its last daylight value', async () => {
  const { service } = createService({ client: createInverterOnlyClient() });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.flow.pv, 0);
  assert.equal(snapshot.flow.load, null);
  assert.equal(snapshot.flow.grid, null);
});

test('a failed overview fails the cycle instead of serving stale values silently', async () => {
  const { service } = createService({ overrides: { overview: new Error('down') } });
  await assert.rejects(() => service.getSnapshot(), /down/);
  assert.ok(service.lastError, 'the failure is recorded for the transport badge');
});

test('an authorization to renew fails the cycle, even from a secondary endpoint', async () => {
  const { service } = createService({
    overrides: { power: new SolarEdgeError('expired', { code: ERROR_CODES.RECONNECT }) },
  });
  await assert.rejects(
    () => service.getSnapshot(),
    (err) => err.code === ERROR_CODES.RECONNECT,
  );
});

test('lastSnapshot hands back the cache without a single request, however old', async () => {
  const { service, client, advance } = createService();
  assert.equal(service.lastSnapshot, null, 'nothing before the first refresh');
  assert.deepEqual(client.calls, []);

  const snapshot = await service.getSnapshot();
  const before = client.calls.length;
  advance(6 * 3600);
  assert.equal(service.lastSnapshot, snapshot);
  assert.equal(client.calls.length, before);
});
