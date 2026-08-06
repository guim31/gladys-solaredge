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
