// -----------------------------------------------------------------------------
// The grid import index: every kWh bought from the grid since commissioning,
// rebuilt from SolarEdge's per-period answers. It feeds the Gladys energy
// module (30-minute consumption and cost), so the two ways it can go wrong
// both cost the user money on screen: a day counted twice (a spike billed as
// consumption) and an index going down (read as a meter reset).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SolarEdgeService } from '../src/solaredge/service.js';
import { SolarEdgeError } from '../src/solaredge/client.js';
import { normalizeConfig } from '../src/config.js';
import { addDays, installationDay, siteDay } from '../src/solaredge/snapshot.js';
import { CURRENT_POWER_FLOW, OVERVIEW, SITE_DETAILS } from './helpers/solaredgeFixtures.js';

const meter = (type, wh, date = '2024-01-01 00:00:00') => ({
  type,
  values: wh === undefined ? [{ date }] : [{ date, value: wh }],
});

/**
 * A client whose `energyDetails` answers depend on the request, like the real
 * one: the daily breakdown (five meters), the past years (YEAR buckets) and
 * this year up to yesterday (DAY buckets).
 */
function createClient({
  installationDate = '2019-06-01',
  today = { purchased: 2500 },
  pastYearsWh = 1_000_000,
  thisYearWh = 300_000,
  refuseYear = false,
} = {}) {
  const calls = [];
  const client = {
    calls,
    today,
    dailyRequestLimit: 300,
    usage: { remaining: 300 },
    getSites: async () => [{ id: 1234567, name: 'Maison' }],
    getSiteDetails: async () => ({ ...SITE_DETAILS, installationDate }),
    getCurrentPowerFlow: async () => CURRENT_POWER_FLOW,
    getOverview: async () => OVERVIEW,
    getStorageData: async () => null,
    async getEnergyDetails(siteId, { startTime, endTime, timeUnit, meters }) {
      calls.push({ startTime, endTime, timeUnit, meters: meters.join(',') });
      if (meters.length > 1) {
        return {
          unit: 'Wh',
          meters: [
            meter('Production', 21_400),
            meter('Consumption', 9800),
            meter('Purchased', client.today.purchased),
          ],
        };
      }
      if (timeUnit === 'YEAR') {
        if (refuseYear) {
          throw new SolarEdgeError('period too long', { status: 403 });
        }
        return { unit: 'Wh', meters: [meter('Purchased', pastYearsWh)] };
      }
      // DAY buckets: this year, or one past year in the fallback.
      const wh = startTime.startsWith('2024') ? thisYearWh : 200_000;
      return { unit: 'Wh', meters: [meter('Purchased', wh)] };
    },
  };
  return client;
}

function createService(client, start = '2024-05-18T13:42:00Z') {
  let clock = new Date(start).getTime();
  const service = new SolarEdgeService(normalizeConfig({ api_key: 'K' }), {
    client,
    now: () => new Date(clock),
  });
  return { service, setTime: (iso) => (clock = new Date(iso).getTime()) };
}

const historyCalls = (client) => client.calls.filter((c) => c.meters === 'PURCHASED');

test('the index is the purchased energy since commissioning, in kWh', async () => {
  const client = createClient();
  const { service } = createService(client);

  const capabilities = await service.getCapabilities();
  assert.equal(capabilities.gridImport, true);

  // 1000 kWh (2019–2023) + 300 kWh (2024-01-01 → 05-17) + 2.5 kWh today.
  assert.equal(service.lastSnapshot.gridImportIndex, 1302.5);
  assert.deepEqual(historyCalls(client), [
    {
      startTime: '2019-06-01 00:00:00',
      endTime: '2023-12-31 23:59:59',
      timeUnit: 'YEAR',
      meters: 'PURCHASED',
    },
    {
      startTime: '2024-01-01 00:00:00',
      endTime: '2024-05-17 23:59:59',
      timeUnit: 'DAY',
      meters: 'PURCHASED',
    },
  ]);
});

test('the history costs its requests once a day, not once per refresh', async () => {
  const client = createClient();
  const { service, setTime } = createService(client);
  await service.getCapabilities();

  // Later the same day: a new breakdown, the same base.
  client.today = { purchased: 4000 };
  setTime('2024-05-18T16:42:00Z');
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.gridImportIndex, 1304);
  assert.equal(historyCalls(client).length, 2, 'no new history request');
});

test('midnight never counts a day twice, and the index never goes down', async () => {
  const client = createClient({ today: { purchased: 5000 } });
  // 23:50 in Paris.
  const { service, setTime } = createService(client, '2024-05-18T21:50:00Z');
  await service.getCapabilities();
  assert.equal(service.lastSnapshot.gridImportIndex, 1305);

  // 00:10: a new live reading, but the breakdown (every 30 min) is still
  // yesterday's 5 kWh. Adding it to a base that includes yesterday would be
  // a 5 kWh spike billed as consumption: the base must stay yesterday's too.
  setTime('2024-05-18T22:10:00Z');
  const justAfterMidnight = await service.getSnapshot({ force: true });
  assert.equal(justAfterMidnight.gridImportIndex, 1305);
  assert.equal(historyCalls(client).length, 2);

  // 00:25: the breakdown is due, for the new day. The base now includes the
  // whole of May 18 (5.2 kWh: the last minutes landed after 23:50).
  client.today = { purchased: 100 };
  setTime('2024-05-18T22:25:00Z');
  const nextDay = createdBase(client, 305_200);
  const snapshot = await service.getSnapshot({ force: true });
  assert.equal(snapshot.gridImportIndex, 1305.3); // 1000 + 305.2 + 0.1
  assert.equal(nextDay.calls(), 1, 'one request for the new day, the past years are cached');

  // SolarEdge revising May 18 down a little must not make the index go back.
  client.today = { purchased: 100 };
  nextDay.set(305_000);
  service.importBase = null; // force the base to be read again
  setTime('2024-05-18T23:30:00Z');
  const revised = await service.getSnapshot({ force: true });
  assert.equal(revised.gridImportIndex, 1305.3);
});

/** Make this year's DAY answer `wh`, and count the requests made for it. */
function createdBase(client, wh) {
  let value = wh;
  const before = historyCalls(client).length;
  const original = client.getEnergyDetails.bind(client);
  client.getEnergyDetails = async (siteId, params) => {
    if (params.meters.length === 1 && params.timeUnit === 'DAY') {
      client.calls.push({ ...params, meters: params.meters.join(',') });
      return { unit: 'Wh', meters: [meter('Purchased', value)] };
    }
    return original(siteId, params);
  };
  return {
    calls: () => historyCalls(client).length - before,
    set: (next) => (value = next),
  };
}

test('a refused multi-year period falls back to one request per past year', async () => {
  const client = createClient({ refuseYear: true });
  const { service } = createService(client);
  await service.getCapabilities();

  const days = historyCalls(client).filter((c) => c.timeUnit === 'DAY');
  assert.deepEqual(
    days.map((c) => [c.startTime.slice(0, 10), c.endTime.slice(0, 10)]),
    [
      ['2019-06-01', '2019-12-31'],
      ['2020-01-01', '2020-12-31'],
      ['2021-01-01', '2021-12-31'],
      ['2022-01-01', '2022-12-31'],
      ['2023-01-01', '2023-12-31'],
      ['2024-01-01', '2024-05-17'],
    ],
  );
  // 5 past years × 200 kWh + 300 kWh + 2.5 kWh.
  assert.equal(service.lastSnapshot.gridImportIndex, 1302.5);
});

test('a site commissioned this year needs no past years, and none on its first day', async () => {
  const client = createClient({ installationDate: '2024-05-18' });
  const { service } = createService(client);
  await service.getCapabilities();
  assert.deepEqual(historyCalls(client), []);
  assert.equal(service.lastSnapshot.gridImportIndex, 2.5);
});

test('no purchased reading, or no commissioning date: no index at all', async () => {
  const noMeter = createClient({ today: { purchased: undefined } });
  const a = createService(noMeter);
  assert.equal((await a.service.getCapabilities()).gridImport, false);
  assert.equal(a.service.lastSnapshot.gridImportIndex, null);
  assert.deepEqual(historyCalls(noMeter), []);

  const noDate = createClient({ installationDate: null });
  const b = createService(noDate);
  assert.equal((await b.service.getCapabilities()).gridImport, false);
  assert.equal(b.service.lastSnapshot.gridImportIndex, null);
});

test('a failed history request publishes no index rather than a wrong one', async () => {
  const client = createClient();
  client.getEnergyDetails = async (siteId, params) => {
    if (params.meters.length === 1) {
      throw new SolarEdgeError('timeout', { status: 504 });
    }
    return { unit: 'Wh', meters: [meter('Purchased', 2500)] };
  };
  const { service } = createService(client);
  await service.getCapabilities();
  assert.equal(service.lastSnapshot.gridImportIndex, null);
  assert.equal(service.lastSnapshot.energy.purchased, 2.5, 'the daily breakdown still works');

  // Not retried at every refresh of the same day: the budget is not spent on it.
  let attempts = 0;
  const failing = client.getEnergyDetails;
  client.getEnergyDetails = async (siteId, params) => {
    if (params.meters.length === 1) {
      attempts += 1;
    }
    return failing(siteId, params);
  };
  await service.getSnapshot({ force: true });
  await service.getSnapshot({ force: true });
  assert.equal(attempts, 0);
});

test('site days and commissioning dates', () => {
  assert.equal(siteDay(new Date('2024-05-18T22:10:00Z'), 'Europe/Paris'), '2024-05-19');
  assert.equal(siteDay(new Date('2024-05-18T22:10:00Z'), 'UTC'), '2024-05-18');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(addDays('2024-01-01', -1), '2023-12-31');
  assert.equal(installationDay({ installationDate: '2019-06-01' }), '2019-06-01');
  assert.equal(installationDay({ installationDate: '2019-06-01 00:00:00' }), '2019-06-01');
  assert.equal(installationDay({ installationDate: 'n/a' }), null);
  assert.equal(installationDay({}), null);
});
