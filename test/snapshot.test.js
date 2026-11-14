// -----------------------------------------------------------------------------
// The translation layer is where the subtle bugs live: units announced by the
// payload, power signs, buckets without data, site-local dates. These tests
// pin them on the V2 shapes.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATTERY_STATES,
  isoInstant,
  lastValue,
  parseDevices,
  parseImportCounter,
  parseLifetimeEnergy,
  parseMetersTelemetry,
  parseMonthlyEnergy,
  parseOverview,
  parsePower,
  parseSiteDetails,
  parseStorageStatus,
  parseStorageTelemetry,
  siteDay,
  toKwh,
  toWatts,
  whToKwh,
} from '../src/solaredge/snapshot.js';
import {
  DEVICES,
  ENERGY_MONTHLY,
  INVERTER_ONLY_OVERVIEW,
  INVERTER_ONLY_POWER,
  LIFETIME_ENERGY,
  METERS_LIFETIME,
  METERS_TELEMETRY,
  OVERVIEW,
  POWER,
  SITE_DETAILS,
  STORAGE_STATUS,
  STORAGE_TELEMETRY,
  series,
} from './helpers/solaredgeFixtures.js';

test('toWatts and toKwh honour the unit announced by the payload, in any case', () => {
  assert.equal(toWatts(4.2, 'KW'), 4200);
  assert.equal(toWatts(4200, 'W'), 4200);
  assert.equal(toWatts(0.0042, 'MW'), 4200);
  assert.equal(toWatts('nope', 'KW'), null);
  assert.equal(toKwh(21_400, 'WH'), 21.4);
  assert.equal(toKwh(21.4, 'KWH'), 21.4);
  assert.equal(toKwh(0.0214, 'MWH'), 21.4);
  assert.equal(toKwh(null, 'WH'), null);
  assert.equal(whToKwh(1234), 1.23);
});

test('lastValue skips the buckets without data', () => {
  assert.equal(lastValue(POWER), 4200);
  assert.equal(lastValue(INVERTER_ONLY_POWER), null);
  assert.equal(lastValue(undefined), null);
});

test('parseSiteDetails exposes the V1 names the rest of the code reads', () => {
  const site = parseSiteDetails(SITE_DETAILS);
  assert.equal(site.id, 1234567);
  assert.equal(site.location.timeZone, 'Europe/Paris');
  assert.equal(site.peakPower, 6.4);
  assert.deepEqual(parseSiteDetails(null), {});
});

test('parseOverview splits today into production, consumption and the grid', () => {
  assert.deepEqual(parseOverview(OVERVIEW), {
    production: 21.4,
    feedIn: 14.1,
    consumption: 9.8,
    // What the panels AND the battery covered: V1's SelfConsumption meter.
    selfConsumption: 7.3,
    purchased: 2.5,
  });
});

test('parseOverview keeps null for what a lone inverter cannot measure', () => {
  assert.deepEqual(parseOverview(INVERTER_ONLY_OVERVIEW), {
    production: 9.84,
    feedIn: null,
    consumption: null,
    selfConsumption: null,
    purchased: null,
  });
  assert.equal(parseOverview(null), null);
});

test('parsePower reads the latest PV power, null when the inverter sent nothing', () => {
  assert.equal(parsePower(POWER), 4200);
  assert.equal(parsePower({ unit: 'KW', values: [{ value: 1.5 }] }), 1500);
  assert.equal(parsePower(INVERTER_ONLY_POWER), null);
});

test('parseMetersTelemetry signs the grid: exporting is negative', () => {
  assert.deepEqual(parseMetersTelemetry(METERS_TELEMETRY), { pv: null, load: 1100, grid: -1600 });
  const importing = {
    meters: { m: { importPower: series('W', [800]), exportPower: series('W', [0]) } },
  };
  assert.equal(parseMetersTelemetry(importing).grid, 800);
});

test('parseMetersTelemetry adds several meters and reads a production meter', () => {
  const body = {
    meters: {
      a: { productionPower: series('W', [3000]), consumptionPower: series('KW', [0.4]) },
      b: { consumptionPower: series('W', [600]) },
    },
  };
  assert.deepEqual(parseMetersTelemetry(body), { pv: 3000, load: 1000, grid: null });
  assert.deepEqual(parseMetersTelemetry({ meters: {} }), { pv: null, load: null, grid: null });
});

test('parseStorageTelemetry signs the battery: charging is positive', () => {
  assert.deepEqual(parseStorageTelemetry(STORAGE_TELEMETRY), {
    power: 1500,
    level: 62,
    energyStored: 5.95,
    state: BATTERY_STATES.CHARGING,
    critical: false,
  });
});

test('parseStorageTelemetry: discharging is negative, a few watts are idle', () => {
  const pack = (charge, discharge, level) => ({
    storage: {
      b: {
        chargePower: series('W', [charge]),
        dischargePower: series('W', [discharge]),
        stateOfEnergy: series('PERCENTAGE', [level]),
      },
    },
  });
  const discharging = parseStorageTelemetry(pack(0, 900, 40));
  assert.equal(discharging.power, -900);
  assert.equal(discharging.state, BATTERY_STATES.DISCHARGING);
  const idle = parseStorageTelemetry(pack(5, 0, 40));
  assert.equal(idle.power, 0);
  assert.equal(idle.state, BATTERY_STATES.IDLE);
});

test('parseStorageTelemetry flags a battery at its low level, and averages packs', () => {
  const body = {
    storage: {
      a: { stateOfEnergy: series('PERCENTAGE', [8]), chargePower: series('W', [0]) },
      b: { stateOfEnergy: series('PERCENTAGE', [12]), chargePower: series('W', [0]) },
    },
  };
  const battery = parseStorageTelemetry(body);
  assert.equal(battery.level, 10);
  assert.equal(battery.critical, true);
  assert.equal(parseStorageTelemetry({ storage: {} }), null);
});

test('parseStorageStatus reads the internal temperature', () => {
  assert.equal(parseStorageStatus(STORAGE_STATUS), 25.1);
  assert.equal(parseStorageStatus({ storage: {} }), null);
});

test('parseMonthlyEnergy keeps this month and this year, by the local date', () => {
  // December 2023 is in the answer (the request starts a day early): left out.
  assert.deepEqual(parseMonthlyEnergy(ENERGY_MONTHLY, '2024-05-18'), { month: 612, year: 4120 });
  assert.deepEqual(parseMonthlyEnergy({ values: [] }, '2024-05-18'), { month: null, year: null });
});

test('parseLifetimeEnergy and parseImportCounter read the onboard counters', () => {
  assert.equal(parseLifetimeEnergy(LIFETIME_ENERGY), 18540);
  assert.equal(parseImportCounter(METERS_LIFETIME), 3456.7);
  assert.equal(parseImportCounter({ meters: [{ importEnergy: [] }] }), null);
});

test('parseDevices counts the active meters and batteries', () => {
  assert.deepEqual(parseDevices(DEVICES), { meters: 1, productionMeter: false, batteries: 1 });
  assert.deepEqual(
    parseDevices([
      { type: 'METER', meterType: 'Production' },
      { type: 'BATTERY', active: false },
    ]),
    { meters: 1, productionMeter: true, batteries: 0 },
  );
  assert.deepEqual(parseDevices([]), { meters: 0, productionMeter: false, batteries: 0 });
});

test('dates: V2 instants in UTC, the site day in the site timezone', () => {
  const date = new Date('2024-05-18T22:30:00.123Z');
  assert.equal(isoInstant(date), '2024-05-18T22:30:00Z');
  // 00:30 in Paris: already the next day there.
  assert.equal(siteDay(date, 'Europe/Paris'), '2024-05-19');
  assert.equal(siteDay(date, 'Not/AZone'), siteDay(date));
});
