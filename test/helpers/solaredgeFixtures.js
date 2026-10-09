// -----------------------------------------------------------------------------
// Sample SolarEdge Monitoring API payloads, shaped like the real ones.
//
// The scenario is a spring afternoon on a site with a consumption meter and a
// battery: the panels produce 4.2 kW, the house eats 1.1 kW, the battery is
// charging at 1.5 kW and the surplus (1.6 kW) is exported to the grid.
// -----------------------------------------------------------------------------

export const SITE_DETAILS = {
  id: 1234567,
  name: 'Maison',
  peakPower: 6.4,
  currency: 'EUR',
  status: 'Active',
  location: { country: 'France', city: 'Nantes', timeZone: 'Europe/Paris' },
};

export const CURRENT_POWER_FLOW = {
  unit: 'kW',
  connections: [
    { from: 'PV', to: 'Load' },
    { from: 'PV', to: 'Storage' },
    { from: 'LOAD', to: 'Grid' },
  ],
  GRID: { status: 'Active', currentPower: 1.6 },
  LOAD: { status: 'Active', currentPower: 1.1 },
  PV: { status: 'Active', currentPower: 4.2 },
  STORAGE: { status: 'Charging', currentPower: 1.5, chargeLevel: 62, critical: false },
};

export const OVERVIEW = {
  lastUpdateTime: '2024-05-18 15:42:11',
  lifeTimeData: { energy: 18_540_000, revenue: 2781.5 },
  lastYearData: { energy: 4_120_000 },
  lastMonthData: { energy: 612_000 },
  lastDayData: { energy: 21_400, revenue: 3.21 },
  currentPower: { power: 4200 },
};

export const ENERGY_DETAILS = {
  timeUnit: 'DAY',
  unit: 'Wh',
  meters: [
    { type: 'Production', values: [{ date: '2024-05-18 00:00:00', value: 21_400 }] },
    { type: 'Consumption', values: [{ date: '2024-05-18 00:00:00', value: 9800 }] },
    { type: 'SelfConsumption', values: [{ date: '2024-05-18 00:00:00', value: 7300 }] },
    { type: 'FeedIn', values: [{ date: '2024-05-18 00:00:00', value: 14_100 }] },
    { type: 'Purchased', values: [{ date: '2024-05-18 00:00:00', value: 2500 }] },
  ],
};

export const STORAGE_DATA = {
  batteryCount: 1,
  batteries: [
    {
      serialNumber: 'B1234',
      modelNumber: 'SE-BAT-10K',
      nameplate: 9700,
      telemetryCount: 2,
      telemetries: [
        {
          timeStamp: '2024-05-18 15:30:00',
          power: 1400,
          batteryState: 60,
          fullPackEnergyAvailable: 9600,
          internalTemp: 24.5,
        },
        {
          timeStamp: '2024-05-18 15:45:00',
          power: 1500,
          batteryState: 62,
          fullPackEnergyAvailable: 9600,
          internalTemp: 25.1,
        },
      ],
    },
  ],
};

/**
 * A client stub answering the fixtures above, counting the calls it received.
 * Any endpoint can be overridden to simulate a site without that hardware.
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

  return {
    calls,
    dailyRequestLimit: 300,
    usage: { day: '2024-05-18', count: calls.length, limit: 300, remaining: 300 },
    getSites: () => record('sites', overrides.sites ?? [{ id: 1234567, name: 'Maison' }]),
    getSiteDetails: () => record('details', overrides.details ?? SITE_DETAILS),
    getOverview: () => record('overview', overrides.overview ?? OVERVIEW),
    getCurrentPowerFlow: () => record('flow', overrides.flow ?? CURRENT_POWER_FLOW),
    getEnergyDetails: () => record('energy', overrides.energy ?? ENERGY_DETAILS),
    getStorageData: () => record('storage', overrides.storage ?? STORAGE_DATA),
  };
}

// -----------------------------------------------------------------------------
// A REAL site: one SE3000H inverter alone — no meter, no battery, no tariff —
// on an October evening (the answers of the first real test, 2026-10-09; site
// id and serial number replaced). What it teaches:
//   - `currentPowerFlow` still lists GRID and LOAD, with a status and NO
//     `currentPower`: the slots of the diagram, not measurements;
//   - `energyDetails` lists every meter, with dates and no `value`, except
//     Production;
//   - `overview` reports `lifeTimeData.revenue: 0.0` and no daily revenue: the
//     owner never entered a feed-in tariff.
// -----------------------------------------------------------------------------

export const INVERTER_ONLY_SITE_DETAILS = {
  id: 1000001,
  name: 'Onduleur seul',
  peakPower: 3,
  currency: 'EUR',
  status: 'Active',
  location: { country: 'France', timeZone: 'Europe/Paris' },
};

export const INVERTER_ONLY_POWER_FLOW = {
  updateRefreshRate: 3,
  unit: 'kW',
  connections: [],
  GRID: { status: 'Inactive' },
  LOAD: { status: 'Inactive' },
  PV: { status: 'Idle', currentPower: 0.0 },
};

export const INVERTER_ONLY_OVERVIEW = {
  lastUpdateTime: '2026-10-09 19:05:38',
  lifeTimeData: { energy: 2.6618836e7, revenue: 0.0 },
  lastYearData: { energy: 3052537.0 },
  lastMonthData: { energy: 59764.0 },
  lastDayData: { energy: 9844.0 },
  currentPower: { power: 0.0 },
  measuredBy: '',
};

export const INVERTER_ONLY_ENERGY_DETAILS = {
  timeUnit: 'DAY',
  unit: 'Wh',
  meters: [
    { type: 'Consumption', values: [{ date: '2026-10-09 00:00:00' }] },
    { type: 'FeedIn', values: [{ date: '2026-10-09 00:00:00' }] },
    { type: 'Purchased', values: [{ date: '2026-10-09 00:00:00' }] },
    { type: 'SelfConsumption', values: [{ date: '2026-10-09 00:00:00' }] },
    { type: 'Production', values: [{ date: '2026-10-09 00:00:00', value: 9844.0 }] },
  ],
};

/** `/site/{id}/inventory` of the same site (not called by the integration). */
export const INVERTER_ONLY_INVENTORY = {
  inverters: [
    {
      name: 'Inverter 1',
      manufacturer: 'SolarEdge',
      communicationMethod: 'ETHERNET',
      connectedOptimizers: 8,
      partNumber: 'SE3000H-RW000NNN2',
      SN: 'XXXXXXXX-XX',
    },
  ],
  batteries: [],
  gateways: [],
  sensors: [],
  meters: [],
};

/** The client stub of `createFakeClient`, answering as the inverter-only site. */
export function createInverterOnlyClient() {
  return createFakeClient({
    details: INVERTER_ONLY_SITE_DETAILS,
    flow: INVERTER_ONLY_POWER_FLOW,
    overview: INVERTER_ONLY_OVERVIEW,
    energy: INVERTER_ONLY_ENERGY_DETAILS,
    sites: [{ id: INVERTER_ONLY_SITE_DETAILS.id, name: INVERTER_ONLY_SITE_DETAILS.name }],
  });
}
