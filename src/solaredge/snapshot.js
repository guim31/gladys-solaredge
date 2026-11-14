// -----------------------------------------------------------------------------
// Pure translation layer: SolarEdge Monitoring API V2 payloads -> the numbers
// Gladys publishes.
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
//
// V2 series share one envelope, `{ unit, values: [{ timestamp, value }] }`,
// where `value` is `null` for a bucket with no data; the last bucket of a
// window covering "now" is the one still filling up.
// -----------------------------------------------------------------------------

/** Battery states, published as a text feature and used by the battery widget. */
export const BATTERY_STATES = {
  CHARGING: 'charging',
  DISCHARGING: 'discharging',
  IDLE: 'idle',
  DISABLED: 'disabled',
};

/** Below this, a battery power is noise: the pack is idle. */
const BATTERY_IDLE_WATTS = 20;
/**
 * V2 has no "critical" flag any more (V1's `currentPowerFlow` had one, and the
 * live power flow is now a paid Advanced Monitoring endpoint): the "Battery
 * low" feature reads a state of charge at or below this level.
 */
export const BATTERY_LOW_LEVEL = 10;

/**
 * Convert a power reading to watts. V2 announces the unit of every series
 * (`W`, `KW`, `MW`), in upper case.
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
    default:
      return number;
  }
}

/** An energy in its announced unit (`WH`, `KWH`, `MWH`, `GWH`) -> kWh, 2 decimals. */
export function toKwh(value, unit = 'WH') {
  if (!hasValue(value) || !Number.isFinite(Number(value))) {
    return null;
  }
  const factor = { wh: 0.001, kwh: 1, mwh: 1000, gwh: 1_000_000 }[
    String(unit ?? 'WH')
      .trim()
      .toLowerCase()
  ];
  return round(Number(value) * (factor ?? 0.001), 2);
}

/** Watt-hours -> kilowatt-hours, rounded to 2 decimals (what a UI shows). */
export function whToKwh(value) {
  return toKwh(value, 'WH');
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

/** The last bucket of a series that holds a number, or `null`. */
export function lastValue(series) {
  const values = Array.isArray(series?.values) ? series.values : [];
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (hasValue(values[i]?.value) && Number.isFinite(Number(values[i].value))) {
      return Number(values[i].value);
    }
  }
  return null;
}

/** Sum of `pick(device)` over the devices that report it, `null` when none does. */
function sumOver(devices, pick) {
  let sum = null;
  for (const device of devices) {
    const value = pick(device);
    if (value !== null) {
      sum = (sum ?? 0) + value;
    }
  }
  return sum;
}

/**
 * Normalize `GET /sites/{id}` (the V2 site details). The rest of the
 * integration reads `id` and `location.timeZone`, V1's names: V2 calls them
 * `siteId` and `location.timezone`.
 */
export function parseSiteDetails(details) {
  if (!details || typeof details !== 'object') {
    return {};
  }
  const location = details.location ?? {};
  return {
    ...details,
    id: details.siteId ?? details.id,
    location: { ...location, timeZone: location.timeZone ?? location.timezone },
  };
}

/**
 * Normalize `GET /sites/{id}/overview` without a period: today's balance, from
 * the site's local midnight to now.
 *
 *   production.total             -> production today
 *   production.toGrid            -> exported (feed-in)
 *   consumption.total            -> consumption
 *   consumption.fromPv/Storage   -> self-consumption (what the panels and the
 *                                   battery covered: V1's SelfConsumption meter)
 *   consumption.fromGrid         -> imported (purchased)
 *
 * The consumption and grid figures need a meter: without one they stay `null`.
 */
export function parseOverview(overview) {
  if (!overview || typeof overview !== 'object') {
    return null;
  }
  const production = overview.production ?? {};
  const consumption = overview.consumption ?? {};
  const pUnit = production.unit ?? 'WH';
  const cUnit = consumption.unit ?? 'WH';
  const fromPv = toKwh(consumption.fromPv, cUnit);
  const fromStorage = toKwh(consumption.fromStorage, cUnit);
  return {
    production: toKwh(production.total, pUnit),
    feedIn: toKwh(production.toGrid, pUnit),
    consumption: toKwh(consumption.total, cUnit),
    selfConsumption:
      fromPv === null && fromStorage === null ? null : round((fromPv ?? 0) + (fromStorage ?? 0), 2),
    purchased: toKwh(consumption.fromGrid, cUnit),
  };
}

/** `GET /sites/{id}/power`: the latest PV power, in W. */
export function parsePower(body) {
  return round(toWatts(lastValue(body), body?.unit ?? 'W'), 0);
}

/**
 * `GET /sites/{id}/meters/telemetry` (QUARTER_HOUR): the latest power of every
 * meter, summed per direction. `grid` is signed: import minus export.
 *
 * @returns {{ pv: number|null, load: number|null, grid: number|null }}
 */
export function parseMetersTelemetry(body) {
  const meters = Object.values(body?.meters ?? {});
  const power = (meter, key) => toWatts(lastValue(meter?.[key]), meter?.[key]?.unit ?? 'W');
  const imported = sumOver(meters, (m) => power(m, 'importPower'));
  const exported = sumOver(meters, (m) => power(m, 'exportPower'));
  return {
    pv: round(
      sumOver(meters, (m) => power(m, 'productionPower')),
      0,
    ),
    load: round(
      sumOver(meters, (m) => power(m, 'consumptionPower')),
      0,
    ),
    grid:
      imported === null && exported === null ? null : round((imported ?? 0) - (exported ?? 0), 0),
  };
}

/**
 * `GET /sites/{id}/storage/telemetry` (QUARTER_HOUR): the battery as one pack.
 * Several packs share one installation: powers and stored energies add up,
 * the state of charge is averaged.
 *
 * @returns {null | { power: number|null, level: number|null, energyStored: number|null,
 *   state: string, critical: boolean }}
 */
export function parseStorageTelemetry(body) {
  const packs = Object.values(body?.storage ?? {});
  if (packs.length === 0) {
    return null;
  }
  const watts = (pack, key) => toWatts(lastValue(pack?.[key]), pack?.[key]?.unit ?? 'W');
  const charge = sumOver(packs, (p) => watts(p, 'chargePower'));
  const discharge = sumOver(packs, (p) => watts(p, 'dischargePower'));
  const levels = packs.map((p) => lastValue(p?.stateOfEnergy)).filter((v) => v !== null);
  const stored = sumOver(packs, (p) => {
    const value = lastValue(p?.remainingEnergy);
    return value === null ? null : toKwh(value, p.remainingEnergy?.unit ?? 'WH');
  });

  const level = levels.length ? round(levels.reduce((a, b) => a + b, 0) / levels.length, 0) : null;
  if (charge === null && discharge === null && level === null) {
    return null;
  }
  const power = charge === null && discharge === null ? null : (charge ?? 0) - (discharge ?? 0);
  let state = BATTERY_STATES.IDLE;
  if (power !== null && power > BATTERY_IDLE_WATTS) {
    state = BATTERY_STATES.CHARGING;
  } else if (power !== null && power < -BATTERY_IDLE_WATTS) {
    state = BATTERY_STATES.DISCHARGING;
  }
  return {
    power: state === BATTERY_STATES.IDLE && power !== null ? 0 : round(power, 0),
    level,
    energyStored: round(stored, 2),
    state,
    critical: level !== null && level <= BATTERY_LOW_LEVEL,
  };
}

/** `GET /sites/{id}/storage/status`: the average internal temperature, in °C. */
export function parseStorageStatus(body) {
  const temperatures = Object.values(body?.storage ?? {})
    .map((pack) => lastValue(pack?.internalTemperature))
    .filter((v) => v !== null);
  if (temperatures.length === 0) {
    return null;
  }
  return round(temperatures.reduce((a, b) => a + b, 0) / temperatures.length, 1);
}

/**
 * `GET /sites/{id}/energy?resolution=MONTH`: the production of the site's
 * current month and of its current year, in kWh. Timestamps are in the site's
 * local time (`2026-11-01T00:00:00+01:00`), so the buckets are picked by their
 * local date: the request may start a day early to be sure to cover January 1.
 *
 * @param {object} body
 * @param {string} day the site's current day, `YYYY-MM-DD`
 */
export function parseMonthlyEnergy(body, day) {
  const values = Array.isArray(body?.values) ? body.values : [];
  const unit = body?.unit ?? 'WH';
  const year = day.slice(0, 4);
  const month = day.slice(0, 7);
  let yearTotal = null;
  let monthTotal = null;
  for (const bucket of values) {
    const stamp = String(bucket?.timestamp ?? '');
    const kwh = toKwh(bucket?.value, unit);
    if (kwh === null || !stamp.startsWith(year)) {
      continue;
    }
    yearTotal = (yearTotal ?? 0) + kwh;
    if (stamp.startsWith(month)) {
      monthTotal = (monthTotal ?? 0) + kwh;
    }
  }
  return { month: round(monthTotal, 2), year: round(yearTotal, 2) };
}

/** `GET /sites/{id}/lifetime-energy`: the onboard production counter, in kWh. */
export function parseLifetimeEnergy(body) {
  return toKwh(body?.energy, body?.unit ?? 'WH');
}

/**
 * `GET /sites/{id}/meters/lifetime-energy?meters=PURCHASED`: the grid import
 * counter, in kWh — the latest reading of every meter, summed.
 */
export function parseImportCounter(body) {
  const meters = Array.isArray(body?.meters) ? body.meters : [];
  return round(
    sumOver(meters, (meter) => {
      const value = lastValue({ values: meter?.importEnergy });
      return value === null ? null : toKwh(value, meter.unit ?? 'WH');
    }),
    2,
  );
}

/**
 * `GET /sites/{id}/devices?types=METER&types=BATTERY`: what the site holds.
 * @returns {{ meters: number, productionMeter: boolean, batteries: number }}
 */
export function parseDevices(body) {
  const devices = (Array.isArray(body) ? body : (body?.devices ?? [])).filter(
    (d) => d && d.active !== false,
  );
  const meters = devices.filter((d) => d.type === 'METER');
  return {
    meters: meters.length,
    productionMeter: meters.some((m) => String(m.meterType ?? '').toLowerCase() === 'production'),
    batteries: devices.filter((d) => d.type === 'BATTERY').length,
  };
}

/** A V2 `from`/`to` value: an ISO 8601 instant in UTC, to the second. */
export function isoInstant(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function siteDateParts(date, timeZone) {
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
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

/** The site's current day, `YYYY-MM-DD`, in the site's timezone. */
export function siteDay(date, timeZone) {
  const parts = siteDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** `YYYY-MM-DD` shifted by `days` calendar days (no timezone involved). */
export function addDays(day, days) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}
