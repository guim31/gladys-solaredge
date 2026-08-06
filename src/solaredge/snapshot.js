// -----------------------------------------------------------------------------
// Pure translation layer: SolarEdge payloads -> the numbers Gladys publishes.
//
// Everything here is a pure function of an API response — no network, no cache,
// no clock beyond what is passed in. That is what makes the tricky parts (unit
// juggling, power SIGNS, site-local day boundaries) cheap to unit-test.
//
// Two conventions are applied once, here, and relied upon by every device:
//   - powers are published in WATTS, energies in KILOWATT-HOURS;
//   - directional powers are SIGNED, from the home's point of view:
//       grid    > 0 imported from the grid   | < 0 exported to the grid
//       battery > 0 charging (energy stored) | < 0 discharging (energy used)
// -----------------------------------------------------------------------------

/** Battery states, published as a text feature and used to sign its power. */
export const BATTERY_STATES = {
  CHARGING: 'charging',
  DISCHARGING: 'discharging',
  IDLE: 'idle',
  DISABLED: 'disabled',
};

/** Meters requested to `energyDetails` for the daily breakdown. */
export const ENERGY_METERS = [
  'PRODUCTION',
  'CONSUMPTION',
  'SELFCONSUMPTION',
  'FEEDIN',
  'PURCHASED',
];

/**
 * Convert a power reading to watts. `currentPowerFlow` announces its own unit
 * ("W" or "kW" depending on the site), so it must never be assumed.
 * @param {number} value
 * @param {string} [unit] unit announced by the API
 */
export function toWatts(value, unit = 'W') {
  if (!hasValue(value)) {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  switch (String(unit).trim().toLowerCase()) {
    case 'kw':
      return number * 1000;
    case 'mw':
      return number * 1_000_000;
    case 'w':
    default:
      return number;
  }
}

/** Watt-hours -> kilowatt-hours, rounded to 2 decimals (what a UI shows). */
export function whToKwh(value) {
  return hasValue(value) ? round(Number(value) / 1000, 2) : null;
}

/**
 * Round to `digits` decimals, keeping `null` for "no value".
 *
 * The `hasValue` guard is what stops a missing reading from becoming a zero:
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a plain numeric
 * check would silently turn "this site has no consumption meter" into "the
 * house consumes 0 W" — and draw that flat line in the Gladys history.
 */
export function round(value, digits = 0) {
  if (!hasValue(value) || !Number.isFinite(Number(value))) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/** Anything but "the API did not give us this number". */
function hasValue(value) {
  return value !== null && value !== undefined && value !== '' && typeof value !== 'boolean';
}

/**
 * Normalize `GET /site/{id}/currentPowerFlow`.
 *
 * The API reports every power as a POSITIVE magnitude and describes the
 * direction separately, in the `connections` array (`{ from: 'GRID', to:
 * 'Load' }`, with inconsistent casing). We fold both into a signed value.
 *
 * @returns {null | {pv: number|null, load: number|null, grid: number|null,
 *   battery: null | {power: number|null, level: number|null, state: string,
 *   critical: boolean}}}
 */
export function parsePowerFlow(flow) {
  // A site without the matching hardware answers `{}`: not an error.
  if (!flow || typeof flow !== 'object' || Object.keys(flow).length === 0) {
    return null;
  }

  const unit = flow.unit ?? 'W';
  const connections = Array.isArray(flow.connections) ? flow.connections : [];
  const flowsFrom = (node) =>
    connections.some((c) => String(c?.from ?? '').toLowerCase() === node.toLowerCase());
  const flowsTo = (node) =>
    connections.some((c) => String(c?.to ?? '').toLowerCase() === node.toLowerCase());

  const pv = flow.PV ? toWatts(flow.PV.currentPower, unit) : null;
  const load = flow.LOAD ? toWatts(flow.LOAD.currentPower, unit) : null;

  let grid = null;
  if (flow.GRID) {
    const magnitude = Math.abs(toWatts(flow.GRID.currentPower, unit) ?? 0);
    // Exporting is the only case that flips the sign; when the grid appears on
    // neither side of a connection nothing is flowing, and 0 is the truth.
    grid = flowsTo('grid') && !flowsFrom('grid') ? -magnitude : magnitude;
  }

  let battery = null;
  if (flow.STORAGE) {
    const state = parseBatteryState(flow.STORAGE.status, { flowsFrom, flowsTo });
    const magnitude = Math.abs(toWatts(flow.STORAGE.currentPower, unit) ?? 0);
    battery = {
      power: state === BATTERY_STATES.DISCHARGING ? -magnitude : magnitude,
      level: round(flow.STORAGE.chargeLevel, 0),
      state,
      critical: flow.STORAGE.critical === true,
    };
    if (state === BATTERY_STATES.IDLE || state === BATTERY_STATES.DISABLED) {
      battery.power = 0;
    }
  }

  return { pv: round(pv, 0), load: round(load, 0), grid: round(grid, 0), battery };
}

/**
 * Map the SolarEdge battery status to our own vocabulary. The status string is
 * authoritative when present; the connections are the fallback for firmwares
 * that leave it empty.
 */
function parseBatteryState(status, { flowsFrom, flowsTo }) {
  switch (String(status ?? '').toLowerCase()) {
    case 'charging':
      return BATTERY_STATES.CHARGING;
    case 'discharging':
      return BATTERY_STATES.DISCHARGING;
    case 'disabled':
      return BATTERY_STATES.DISABLED;
    case 'idle':
      return BATTERY_STATES.IDLE;
    default:
      if (flowsTo('storage')) {
        return BATTERY_STATES.CHARGING;
      }
      if (flowsFrom('storage')) {
        return BATTERY_STATES.DISCHARGING;
      }
      return BATTERY_STATES.IDLE;
  }
}

/**
 * Normalize `GET /site/{id}/overview` — the production totals, in Wh in the
 * payload, published in kWh.
 */
export function parseOverview(overview) {
  if (!overview || typeof overview !== 'object') {
    return null;
  }
  return {
    currentPower: round(overview.currentPower?.power, 0),
    energyToday: whToKwh(overview.lastDayData?.energy),
    energyMonth: whToKwh(overview.lastMonthData?.energy),
    energyYear: whToKwh(overview.lastYearData?.energy),
    energyLifetime: whToKwh(overview.lifeTimeData?.energy),
    revenueToday: round(overview.lastDayData?.revenue, 2),
    revenueLifetime: round(overview.lifeTimeData?.revenue, 2),
    lastUpdateTime: overview.lastUpdateTime ?? null,
  };
}

/**
 * Normalize `GET /site/{id}/energyDetails`, summing every bucket of the
 * requested period (we ask for a single DAY bucket, but a site can answer with
 * several when the period straddles a boundary).
 *
 * @returns {null | Record<'production'|'consumption'|'selfConsumption'|'feedIn'|'purchased', number|null>}
 */
export function parseEnergyDetails(details) {
  if (!details || !Array.isArray(details.meters)) {
    return null;
  }
  const unit = String(details.unit ?? 'Wh').toLowerCase();
  const divisor = unit === 'kwh' ? 1 : 1000;

  const totals = {
    production: null,
    consumption: null,
    selfConsumption: null,
    feedIn: null,
    purchased: null,
  };

  for (const meter of details.meters) {
    const key = METER_KEYS[String(meter?.type ?? '').toLowerCase()];
    if (!key) {
      continue;
    }
    // A meter with no reading at all stays `null` (nothing to publish), which
    // is not the same as a meter reporting 0 kWh.
    let sum = null;
    for (const point of meter.values ?? []) {
      if (Number.isFinite(Number(point?.value))) {
        sum = (sum ?? 0) + Number(point.value);
      }
    }
    totals[key] = sum === null ? null : round(sum / divisor, 2);
  }

  return totals;
}

const METER_KEYS = {
  production: 'production',
  consumption: 'consumption',
  selfconsumption: 'selfConsumption',
  feedin: 'feedIn',
  purchased: 'purchased',
};

/**
 * Normalize `GET /site/{id}/storageData`: keep the most recent telemetry of
 * each battery and aggregate them (a site can hold several packs).
 */
export function parseStorageData(storageData) {
  const batteries = storageData?.batteries;
  if (!Array.isArray(batteries) || batteries.length === 0) {
    return null;
  }

  let energyStored = null;
  let temperature = null;
  let temperatureCount = 0;
  let level = null;
  let levelCount = 0;

  for (const battery of batteries) {
    const telemetries = Array.isArray(battery?.telemetries) ? battery.telemetries : [];
    const last = telemetries[telemetries.length - 1];
    if (!last) {
      continue;
    }
    // `fullPackEnergyAvailable` is the usable capacity, `batteryState` the
    // state of charge in %: their product is the energy actually stored.
    const capacity = Number(last.fullPackEnergyAvailable);
    const state = Number(last.batteryState);
    if (Number.isFinite(capacity) && Number.isFinite(state)) {
      energyStored = (energyStored ?? 0) + (capacity * state) / 100;
    }
    if (Number.isFinite(state)) {
      level = (level ?? 0) + state;
      levelCount += 1;
    }
    if (Number.isFinite(Number(last.internalTemp))) {
      temperature = (temperature ?? 0) + Number(last.internalTemp);
      temperatureCount += 1;
    }
  }

  return {
    energyStored: energyStored === null ? null : whToKwh(energyStored),
    // Averaged: several packs of the same installation share one charge level.
    level: level === null ? null : round(level / levelCount, 0),
    temperature: temperature === null ? null : round(temperature / temperatureCount, 1),
  };
}

/**
 * Format a date the way the Monitoring API expects it (`YYYY-MM-DD HH:mm:ss`),
 * expressed in the SITE's timezone — SolarEdge interprets the period in local
 * site time, so using UTC would shift "today" by the site's offset.
 *
 * @param {Date} date
 * @param {string} [timeZone] IANA timezone from the site details
 */
export function formatSiteDateTime(date, timeZone) {
  const parts = siteDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Period covering the site's current day, from local midnight to now. */
export function siteDayRange(date, timeZone) {
  const parts = siteDateParts(date, timeZone);
  return {
    startTime: `${parts.year}-${parts.month}-${parts.day} 00:00:00`,
    endTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

/** Period covering the last `minutes` minutes, in site local time. */
export function siteRecentRange(date, timeZone, minutes = 30) {
  return {
    startTime: formatSiteDateTime(new Date(date.getTime() - minutes * 60_000), timeZone),
    endTime: formatSiteDateTime(date, timeZone),
  };
}

function siteDateParts(date, timeZone) {
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  };
  let formatter;
  try {
    // An unknown/absent timezone must not break the refresh: fall back to the
    // container's own clock rather than throwing.
    formatter = new Intl.DateTimeFormat('en-CA', timeZone ? { ...options, timeZone } : options);
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', options);
  }
  const parts = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    parts[type] = value;
  }
  return parts;
}
