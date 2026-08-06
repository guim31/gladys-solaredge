// -----------------------------------------------------------------------------
// The translation layer is where the subtle bugs live: units announced by the
// payload, power signs derived from the `connections` array, site-local day
// boundaries. These tests pin all three.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATTERY_STATES,
  formatSiteDateTime,
  parseEnergyDetails,
  parseOverview,
  parsePowerFlow,
  parseStorageData,
  siteDayRange,
  siteRecentRange,
  toWatts,
  whToKwh,
} from '../src/solaredge/snapshot.js';
import {
  CURRENT_POWER_FLOW,
  ENERGY_DETAILS,
  OVERVIEW,
  STORAGE_DATA,
} from './helpers/solaredgeFixtures.js';

test('toWatts honours the unit announced by the payload', () => {
  assert.equal(toWatts(4.2, 'kW'), 4200);
  assert.equal(toWatts(4200, 'W'), 4200);
  assert.equal(toWatts(0.0042, 'MW'), 4200);
  // The API is not consistent about the casing of its own unit.
  assert.equal(toWatts(4.2, 'kw'), 4200);
  assert.equal(toWatts('nope', 'kW'), null);
});

test('whToKwh converts and rounds to 2 decimals', () => {
  assert.equal(whToKwh(21_400), 21.4);
  assert.equal(whToKwh(18_540_000), 18540);
  assert.equal(whToKwh(1234), 1.23);
  assert.equal(whToKwh(undefined), null);
});

test('parsePowerFlow converts kW to W and reads the battery', () => {
  const flow = parsePowerFlow(CURRENT_POWER_FLOW);
  assert.equal(flow.pv, 4200);
  assert.equal(flow.load, 1100);
  assert.equal(flow.battery.level, 62);
  assert.equal(flow.battery.state, BATTERY_STATES.CHARGING);
  assert.equal(flow.battery.critical, false);
});

test('parsePowerFlow signs the grid power: exporting is negative', () => {
  // The fixture has a `LOAD -> Grid` connection: surplus is being exported.
  assert.equal(parsePowerFlow(CURRENT_POWER_FLOW).grid, -1600);

  const importing = parsePowerFlow({
    ...CURRENT_POWER_FLOW,
    connections: [{ from: 'GRID', to: 'Load' }],
    GRID: { status: 'Active', currentPower: 2.4 },
  });
  assert.equal(importing.grid, 2400);
});

test('parsePowerFlow signs the battery power: discharging is negative', () => {
  const discharging = parsePowerFlow({
    ...CURRENT_POWER_FLOW,
    connections: [{ from: 'STORAGE', to: 'Load' }],
    STORAGE: { status: 'Discharging', currentPower: 2.1, chargeLevel: 41, critical: false },
  });
  assert.equal(discharging.battery.power, -2100);
  assert.equal(discharging.battery.state, BATTERY_STATES.DISCHARGING);
});

test('parsePowerFlow reports 0 W for an idle battery', () => {
  const idle = parsePowerFlow({
    ...CURRENT_POWER_FLOW,
    connections: [],
    STORAGE: { status: 'Idle', currentPower: 0, chargeLevel: 100, critical: false },
  });
  assert.equal(idle.battery.power, 0);
  assert.equal(idle.battery.state, BATTERY_STATES.IDLE);
});

test('parsePowerFlow falls back to the connections when the status is missing', () => {
  const flow = parsePowerFlow({
    unit: 'kW',
    connections: [{ from: 'Storage', to: 'Load' }],
    STORAGE: { currentPower: 1, chargeLevel: 30 },
  });
  assert.equal(flow.battery.state, BATTERY_STATES.DISCHARGING);
  assert.equal(flow.battery.power, -1000);
});

test('parsePowerFlow returns null for a site that does not support it', () => {
  // Documented behaviour of the endpoint: an empty object, not an error.
  assert.equal(parsePowerFlow({}), null);
  assert.equal(parsePowerFlow(null), null);
});

test('parsePowerFlow omits the nodes the installation does not have', () => {
  const flow = parsePowerFlow({
    unit: 'W',
    connections: [{ from: 'PV', to: 'Load' }],
    PV: { status: 'Active', currentPower: 900 },
  });
  assert.equal(flow.pv, 900);
  assert.equal(flow.load, null);
  assert.equal(flow.grid, null);
  assert.equal(flow.battery, null);
});

test('parseOverview converts every counter to kWh', () => {
  const overview = parseOverview(OVERVIEW);
  assert.equal(overview.currentPower, 4200);
  assert.equal(overview.energyToday, 21.4);
  assert.equal(overview.energyMonth, 612);
  assert.equal(overview.energyYear, 4120);
  assert.equal(overview.energyLifetime, 18540);
  assert.equal(overview.revenueToday, 3.21);
});

test('parseEnergyDetails maps every meter to kWh', () => {
  const energy = parseEnergyDetails(ENERGY_DETAILS);
  assert.equal(energy.production, 21.4);
  assert.equal(energy.consumption, 9.8);
  assert.equal(energy.selfConsumption, 7.3);
  assert.equal(energy.feedIn, 14.1);
  assert.equal(energy.purchased, 2.5);
});

test('parseEnergyDetails keeps null for a meter the site does not have', () => {
  const energy = parseEnergyDetails({
    unit: 'Wh',
    meters: [{ type: 'Production', values: [{ value: 1000 }] }],
  });
  assert.equal(energy.production, 1);
  assert.equal(energy.consumption, null, 'a missing meter is not a zero');
});

test('parseEnergyDetails sums several buckets and honours a kWh payload', () => {
  const energy = parseEnergyDetails({
    unit: 'kWh',
    meters: [{ type: 'Consumption', values: [{ value: 3 }, { value: 4.5 }, { value: null }] }],
  });
  assert.equal(energy.consumption, 7.5);
});

test('parseStorageData keeps the latest telemetry of each battery', () => {
  const storage = parseStorageData(STORAGE_DATA);
  assert.equal(storage.level, 62, 'the most recent state of charge');
  assert.equal(storage.temperature, 25.1);
  // 9600 Wh of usable capacity at 62% = 5952 Wh.
  assert.equal(storage.energyStored, 5.95);
});

test('parseStorageData returns null when the site has no battery', () => {
  assert.equal(parseStorageData({ batteries: [] }), null);
  assert.equal(parseStorageData(null), null);
});

test('site periods are expressed in the site timezone, not in UTC', () => {
  // 22:30 UTC is already the next day in Paris (UTC+2 in May).
  const date = new Date('2024-05-18T22:30:00Z');
  assert.equal(formatSiteDateTime(date, 'Europe/Paris'), '2024-05-19 00:30:00');

  const range = siteDayRange(date, 'Europe/Paris');
  assert.equal(range.startTime, '2024-05-19 00:00:00');
  assert.equal(range.endTime, '2024-05-19 00:30:00');
});

test('siteRecentRange walks back the requested number of minutes', () => {
  const range = siteRecentRange(new Date('2024-05-18T12:00:00Z'), 'UTC', 60);
  assert.equal(range.startTime, '2024-05-18 11:00:00');
  assert.equal(range.endTime, '2024-05-18 12:00:00');
});

test('an unknown timezone falls back instead of throwing', () => {
  assert.doesNotThrow(() => formatSiteDateTime(new Date(), 'Not/AZone'));
});
