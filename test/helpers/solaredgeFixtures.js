// -----------------------------------------------------------------------------
// Sample SolarEdge Monitoring API V2 payloads, shaped after the OpenAPI
// specification published on api-docs.solaredge.com (Basic Monitoring API
// 2.2.0). NOT recorded from a real site: no V2 credential was available when
// the integration was migrated (2026-11-14).
//
// The scenario is a spring afternoon on a site with a grid meter (import and
// export, no production meter) and a battery: the panels produce 4.2 kW, the
// house eats 1.1 kW, the battery is charging at 1.5 kW and the surplus
// (1.6 kW) is exported to the grid.
// -----------------------------------------------------------------------------

export const SITE_ID = 1234567;

export const SITE_DETAILS = {
  siteId: SITE_ID,
  name: 'Maison',
  accountId: 42,
  peakPower: 6.4,
  installationDate: '2019-04-02T00:00:00Z',
  lastUpdateTime: '2024-05-18T15:42:11+02:00',
  location: { country: 'France', city: 'Nantes', timezone: 'Europe/Paris' },
  activationStatus: 'ACTIVE',
};

export const DEVICES = [
  {
    type: 'METER',
    serialNumber: '606A0000-01',
    name: 'Meter 1',
    meterType: 'FeedIn',
    active: true,
  },
  {
    type: 'BATTERY',
    serialNumber: 'B1234',
    name: 'Battery 1',
    nameplate: 9700,
    active: true,
  },
];

const PERIOD = { from: '2024-05-18T15:00:00+02:00', to: '2024-05-18T15:45:00+02:00' };
const stamps = [
  '2024-05-18T15:00:00+02:00',
  '2024-05-18T15:15:00+02:00',
  '2024-05-18T15:30:00+02:00',
];
/** A V2 series: `values` in order, `null` for a bucket without data. */
export function series(unit, values) {
  return { unit, values: values.map((value, i) => ({ timestamp: stamps[i], value })) };
}

export const OVERVIEW = {
  siteId: SITE_ID,
  production: {
    total: 21_400,
    unit: 'WH',
    toSelfConsumption: 5400,
    toStorage: 1900,
    toGrid: 14_100,
  },
  consumption: { total: 9800, unit: 'WH', fromPv: 5400, fromStorage: 1900, fromGrid: 2500 },
};

export const POWER = {
  period: PERIOD,
  unit: 'W',
  resolution: 'QUARTER_HOUR',
  values: [
    { timestamp: stamps[0], value: 4050 },
    { timestamp: stamps[1], value: 4200 },
    // The bucket still filling up: no value yet.
    { timestamp: stamps[2], value: null },
  ],
};

export const METERS_TELEMETRY = {
  period: PERIOD,
  resolution: 'QUARTER_HOUR',
  meters: {
    '606A0000-01': {
      consumptionPower: series('W', [1000, 1100, null]),
      consumptionEnergy: series('WH', [250, 275, null]),
      importPower: series('W', [0, 0, null]),
      importEnergy: series('WH', [0, 0, null]),
      exportPower: series('W', [1500, 1600, null]),
      exportEnergy: series('WH', [375, 400, null]),
    },
  },
};

export const STORAGE_TELEMETRY = {
  period: PERIOD,
  resolution: 'QUARTER_HOUR',
  storage: {
    B1234: {
      chargePower: series('W', [1400, 1500, null]),
      dischargePower: series('W', [0, 0, null]),
      stateOfEnergy: series('PERCENTAGE', [60, 62, null]),
      remainingEnergy: series('WH', [5760, 5952, null]),
      chargeEnergy: series('WH', [350, 375, null]),
      dischargeEnergy: series('WH', [0, 0, null]),
    },
  },
};

export const STORAGE_STATUS = {
  period: PERIOD,
  resolution: 'QUARTER_HOUR',
  storage: {
    B1234: {
      batteryState: { values: [{ timestamp: stamps[1], value: 3 }] },
      internalTemperature: {
        unit: 'CELSIUS',
        values: [
          { timestamp: stamps[0], value: 24.5 },
          { timestamp: stamps[1], value: 25.1 },
        ],
      },
    },
  },
};

/** `energy?resolution=MONTH` from 2023-12-31: December is left out, May is this month. */
export const ENERGY_MONTHLY = {
  period: { from: '2023-12-01T00:00:00+01:00', to: '2024-05-18T15:45:00+02:00' },
  unit: 'WH',
  resolution: 'MONTH',
  values: [
    { timestamp: '2023-12-01T00:00:00+01:00', value: 150_000 },
    { timestamp: '2024-01-01T00:00:00+01:00', value: 420_000 },
    { timestamp: '2024-02-01T00:00:00+01:00', value: 610_000 },
    { timestamp: '2024-03-01T00:00:00+01:00', value: 1_050_000 },
    { timestamp: '2024-04-01T00:00:00+02:00', value: 1_428_000 },
    { timestamp: '2024-05-01T00:00:00+02:00', value: 612_000 },
  ],
};

export const LIFETIME_ENERGY = {
  energy: 18_540_000,
  unit: 'WH',
  lastUpdateTime: '2024-05-18T15:40:00+02:00',
};

export const METERS_LIFETIME = {
  meters: [
    {
      serialNumber: '606A0000-01',
      productionEnergy: [],
      consumptionEnergy: [],
      importEnergy: [
        { timestamp: stamps[0], value: 3_456_700 },
        { timestamp: stamps[1], value: 3_456_700 },
      ],
      exportEnergy: [],
      unit: 'WH',
    },
  ],
};

/**
 * A client stub answering the fixtures above, counting the calls it received.
 * Any endpoint can be overridden (a value, or an Error to throw) to simulate a
 * site without that hardware or a failing endpoint.
 */
export function createFakeClient(overrides = {}) {
  const calls = [];
  const record = (name, value) => {
    calls.push(name);
    if (value instanceof Error) {
      return Promise.reject(value);
    }
    return Promise.resolve(value);
  };
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);

  return {
    calls,
    mode: overrides.mode ?? 'fleet',
    monthlyCredits: 2000,
    dailyRequestLimit: overrides.dailyRequestLimit ?? 64,
    usage: { day: '2024-05-18', count: 0, limit: 64, remaining: 64 },
    getSites: () => record('sites', pick('sites', [{ siteId: SITE_ID, name: 'Maison' }])),
    getSiteDetails: () => record('details', pick('details', SITE_DETAILS)),
    getOverview: () => record('overview', pick('overview', OVERVIEW)),
    getPower: () => record('power', pick('power', POWER)),
    getEnergy: () => record('energy', pick('energy', ENERGY_MONTHLY)),
    getLifetimeEnergy: () => record('lifetime', pick('lifetime', LIFETIME_ENERGY)),
    getDevices: () => record('devices', pick('devices', DEVICES)),
    getMetersTelemetry: () => record('meters', pick('meters', METERS_TELEMETRY)),
    getMetersLifetimeEnergy: () => record('importCounter', pick('importCounter', METERS_LIFETIME)),
    getStorageTelemetry: () => record('storage', pick('storage', STORAGE_TELEMETRY)),
    getStorageStatus: () => record('storageStatus', pick('storageStatus', STORAGE_STATUS)),
  };
}

// -----------------------------------------------------------------------------
// A lone inverter — no meter, no battery — on an October evening: the SE3000H
// of the first real test (2026-10-09, V1), rewritten in the V2 shapes. The
// figures are that site's (production 9.844 kWh that day, 26,618.8 kWh
// lifetime); the V2 envelopes follow the specification, not a recording:
//   - the inventory asked for meters and batteries is empty;
//   - the overview has no consumption or grid figure;
//   - the inverter sleeps: its power buckets are `null`.
// -----------------------------------------------------------------------------

export const INVERTER_ONLY_SITE_DETAILS = {
  siteId: 1000001,
  name: 'Onduleur seul',
  peakPower: 3,
  installationDate: '2019-04-02T00:00:00Z',
  location: { country: 'France', timezone: 'Europe/Paris' },
  activationStatus: 'ACTIVE',
};

export const INVERTER_ONLY_OVERVIEW = {
  siteId: 1000001,
  production: { total: 9844.0, unit: 'WH', toSelfConsumption: null, toStorage: null, toGrid: null },
  consumption: { total: null, unit: 'WH', fromPv: null, fromStorage: null, fromGrid: null },
};

export const INVERTER_ONLY_POWER = {
  period: { from: '2026-10-09T18:20:00+02:00', to: '2026-10-09T19:05:00+02:00' },
  unit: 'W',
  resolution: 'QUARTER_HOUR',
  values: [
    { timestamp: '2026-10-09T18:15:00+02:00', value: null },
    { timestamp: '2026-10-09T18:30:00+02:00', value: null },
    { timestamp: '2026-10-09T18:45:00+02:00', value: null },
  ],
};

export const INVERTER_ONLY_ENERGY_MONTHLY = {
  unit: 'WH',
  resolution: 'MONTH',
  values: [
    { timestamp: '2026-01-01T00:00:00+01:00', value: 100_000 },
    { timestamp: '2026-09-01T00:00:00+02:00', value: 2_892_773 },
    { timestamp: '2026-10-01T00:00:00+02:00', value: 59_764 },
  ],
};

export const INVERTER_ONLY_LIFETIME = { energy: 2.6618836e7, unit: 'WH' };

/** The client stub of `createFakeClient`, answering as the inverter-only site. */
export function createInverterOnlyClient() {
  return createFakeClient({
    details: INVERTER_ONLY_SITE_DETAILS,
    devices: [],
    overview: INVERTER_ONLY_OVERVIEW,
    power: INVERTER_ONLY_POWER,
    energy: INVERTER_ONLY_ENERGY_MONTHLY,
    lifetime: INVERTER_ONLY_LIFETIME,
    sites: [{ siteId: INVERTER_ONLY_SITE_DETAILS.siteId, name: INVERTER_ONLY_SITE_DETAILS.name }],
  });
}

/**
 * The snapshot the service builds from the fixtures above (asserted in
 * service.test.js), for the device and widget tests that need one directly.
 */
export const SNAPSHOT = {
  flow: {
    pv: 4200,
    load: 1100,
    grid: -1600,
    battery: { power: 1500, level: 62, energyStored: 5.95, state: 'charging', critical: false },
  },
  overview: {
    currentPower: null,
    energyToday: 21.4,
    energyMonth: 612,
    energyYear: 4120,
    energyLifetime: 18540,
    revenueToday: null,
    revenueLifetime: null,
  },
  energy: {
    production: 21.4,
    feedIn: 14.1,
    consumption: 9.8,
    selfConsumption: 7.3,
    purchased: 2.5,
  },
  storage: { level: 62, energyStored: 5.95, temperature: 25.1 },
  gridImportIndex: 3456.7,
  fetchedAt: '2024-05-18T13:42:00.000Z',
};
