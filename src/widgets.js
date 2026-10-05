// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1+), content builders — pure functions.
//
//   - energy_flow : the installation at a glance: live power tiles (PV, home,
//                   grid, battery), the power chart, today's balance and a
//                   "Refresh" button;
//   - production  : today / month / year / lifetime production tiles and the
//                   PV power curve;
//   - battery     : charge gauge, battery power, state, stored energy,
//                   temperature and the low-battery flag.
//
// Two rules shape everything here:
//
//   1. A widget NEVER costs a SolarEdge request. Every open dashboard pulls the
//      widget content, so a widget that refreshed SolarEdge would burn the
//      300 requests/day budget on page loads. The builders read the LAST
//      snapshot kept in memory (see SolarEdgeService.lastSnapshot), and the
//      tiles and charts are bound to the published device features
//      (`device_feature` / `device_features`): the core keeps them live from
//      its own history, with no work — and no request — on our side.
//   2. The builders are pure: feature ids, snapshot and settings in, a content
//      object out. index.js only wires them to the SDK, so the whole surface
//      is unit-tested without a Gladys instance.
//
// Texts are multi-language objects (`{ en, fr }`): the core picks the user's
// language, so the content does not depend on the request language. The
// core's content budget: 8 components, 6 tiles (value | gauge), 1 focal
// (chart), 1 status (≤ 10 rows), 2 texts (1 body), 4 buttons. No `primary`
// button style: Gladys paints it like the others in dark mode.
// -----------------------------------------------------------------------------

import {
  WIDGET_CHART_INTERVALS,
  WIDGET_CHART_TYPES,
  WIDGET_COLORS,
  WIDGET_TEXT_VARIANTS,
} from '@gladysassistant/integration-sdk';
import { BATTERY_STATES } from './solaredge/snapshot.js';
import { production } from './devices/production.js';
import { consumption } from './devices/consumption.js';
import { grid } from './devices/grid.js';
import { battery } from './devices/battery.js';

/** Widget keys, declared in the manifest `widgets` (forever: never rename). */
export const WIDGET = {
  ENERGY_FLOW: 'energy_flow',
  PRODUCTION: 'production',
  BATTERY: 'battery',
};

/** Action keys of the widget buttons (unique within a content). */
export const WIDGET_ACTION = {
  REFRESH: 'refresh',
};

/** The `interval` setting of each chart widget: offered values and default. */
export const DEFAULT_INTERVAL = WIDGET_CHART_INTERVALS.LAST_DAY;
export const ENERGY_FLOW_INTERVALS = [
  WIDGET_CHART_INTERVALS.LAST_DAY,
  WIDGET_CHART_INTERVALS.LAST_WEEK,
];
export const PRODUCTION_INTERVALS = [
  WIDGET_CHART_INTERVALS.LAST_DAY,
  WIDGET_CHART_INTERVALS.LAST_WEEK,
  WIDGET_CHART_INTERVALS.LAST_MONTH,
];

/**
 * Freshness of a content, in seconds. The snapshot moves every "Refresh
 * interval" (15 min by default): 5 min keeps the status rows at most a few
 * minutes behind, and the live tiles need no TTL at all.
 */
export const WIDGET_TTL = 300;
/** A content that only changes with the installation (no battery…). */
const STATIC_TTL = 3600;
/** A content shown while the integration is not initialized yet. */
const WAITING_TTL = 60;

/** Multi-language labels, in one place. */
const TEXT = {
  production: { en: 'Production', fr: 'Production' },
  consumption: { en: 'Consumption', fr: 'Consommation' },
  grid: { en: 'Grid', fr: 'Réseau' },
  battery: { en: 'Battery', fr: 'Batterie' },
  productionToday: { en: 'Production today', fr: 'Production du jour' },
  consumptionToday: { en: 'Consumption today', fr: 'Consommation du jour' },
  selfConsumption: { en: 'Self-consumption', fr: 'Autoconsommation' },
  imported: { en: 'Imported', fr: 'Soutiré' },
  exported: { en: 'Exported', fr: 'Injecté' },
  revenueToday: { en: 'Revenue today', fr: 'Revenu du jour' },
  today: { en: 'Today', fr: "Aujourd'hui" },
  thisMonth: { en: 'This month', fr: 'Ce mois' },
  thisYear: { en: 'This year', fr: 'Cette année' },
  total: { en: 'Total', fr: 'Total' },
  chargeLevel: { en: 'Charge level', fr: 'Niveau de charge' },
  power: { en: 'Power', fr: 'Puissance' },
  state: { en: 'State', fr: 'État' },
  energyStored: { en: 'Stored energy', fr: 'Énergie stockée' },
  temperature: { en: 'Temperature', fr: 'Température' },
  batteryLow: { en: 'Battery low', fr: 'Batterie faible' },
  yes: { en: 'Yes', fr: 'Oui' },
  updatedAt: { en: 'Updated at', fr: 'Actualisé à' },
  refresh: { en: 'Refresh', fr: 'Actualiser' },
  noBattery: {
    en: 'No battery on this SolarEdge site.',
    fr: 'Aucune batterie sur ce site SolarEdge.',
  },
  noReading: {
    en: 'No SolarEdge reading yet: the first refresh is on its way.',
    fr: 'Aucune lecture SolarEdge pour le moment : la première interrogation est en cours.',
  },
  notConnected: {
    en: 'SolarEdge is not connected yet: check the integration settings.',
    fr: "SolarEdge n'est pas encore connecté : vérifiez la configuration de l'intégration.",
  },
};

/** Battery states: the same wording as the device's text feature. */
const BATTERY_STATE_TEXT = {
  [BATTERY_STATES.CHARGING]: {
    text: { en: 'Charging', fr: 'En charge' },
    color: WIDGET_COLORS.SUCCESS,
  },
  [BATTERY_STATES.DISCHARGING]: {
    text: { en: 'Discharging', fr: 'En décharge' },
    color: WIDGET_COLORS.INFO,
  },
  [BATTERY_STATES.IDLE]: { text: { en: 'Idle', fr: 'Au repos' }, color: WIDGET_COLORS.NEUTRAL },
  [BATTERY_STATES.DISABLED]: {
    text: { en: 'Disabled', fr: 'Désactivée' },
    color: WIDGET_COLORS.NEUTRAL,
  },
};

/** Symbol of each manifest `currency` value, for the revenue row. */
const CURRENCY_SYMBOLS = {
  euro: '€',
  dollar: '$',
  'pound-sterling': '£',
};

/**
 * The feature external_ids the widgets bind to, per device — `null` for a
 * device this installation does not have (no meter, no battery).
 *
 * @param {object} gladys the SDK instance (for `externalIds`)
 * @param {object} context the integration context (`siteId`, `capabilities`)
 * @returns {{ production: object, consumption: object|null, grid: object|null,
 *   battery: object|null }}
 */
export function widgetFeatures(gladys, context) {
  const of = (blueprint) =>
    blueprint.isAvailable(context.capabilities) ? blueprint.featureIds(gladys, context) : null;
  return {
    production: of(production),
    consumption: of(consumption),
    grid: of(grid),
    battery: of(battery),
  };
}

/**
 * The chart interval of a widget: the one picked in its settings when it is
 * among the offered values, the default otherwise (the core validates the
 * settings, but an old dashboard may carry a value a later version dropped).
 * @param {object|undefined} settings the widget settings
 * @param {string[]} allowed the offered intervals
 */
export function pickInterval(settings, allowed) {
  const value = settings?.interval;
  return allowed.includes(value) ? value : DEFAULT_INTERVAL;
}

/**
 * Content of the energy_flow widget.
 *
 * @param {object} view what the integration knows (see index.js `widgetView`)
 * @param {object} view.features from widgetFeatures()
 * @param {object|null} view.snapshot the last SolarEdge snapshot in memory
 * @param {string} [view.currency] manifest `currency` value, for the revenue
 * @param {string} [view.timeZone] IANA timezone of the site
 * @param {object} [settings] the widget settings (`interval`)
 */
export function buildEnergyFlowContent(view, settings) {
  const { features, snapshot } = view;
  const components = [
    tile(features.production.POWER, TEXT.production, 'sun'),
    features.consumption ? tile(features.consumption.POWER, TEXT.consumption, 'home') : null,
    features.grid ? tile(features.grid.POWER, TEXT.grid, 'zap') : null,
    features.battery ? tile(features.battery.POWER, TEXT.battery, 'battery') : null,
    {
      type: 'chart',
      device_features: [
        features.production.POWER,
        features.consumption?.POWER,
        features.grid?.POWER,
      ].filter(Boolean),
      interval: pickInterval(settings, ENERGY_FLOW_INTERVALS),
      chart_type: WIDGET_CHART_TYPES.LINE,
    },
  ];

  if (snapshot) {
    components.push(status(energyFlowRows(view)), updatedAt(snapshot, view.timeZone));
  } else {
    components.push(body(TEXT.noReading));
  }

  components.push({
    type: 'button',
    label: TEXT.refresh,
    icon: 'refresh-cw',
    action: { key: WIDGET_ACTION.REFRESH },
  });

  return { ttl_seconds: WIDGET_TTL, components: components.filter(Boolean) };
}

/** Today's balance, from the snapshot: only the readings SolarEdge gave. */
function energyFlowRows({ snapshot, currency }) {
  const { overview, energy, flow } = snapshot;
  const rows = [
    energyRow(TEXT.productionToday, overview?.energyToday),
    energyRow(TEXT.consumptionToday, energy?.consumption),
    energyRow(TEXT.selfConsumption, energy?.selfConsumption),
    energyRow(TEXT.imported, energy?.purchased),
    energyRow(TEXT.exported, energy?.feedIn),
    revenueRow(overview?.revenueToday, currency),
  ];
  if (flow?.battery) {
    const level = snapshot.storage?.level ?? flow.battery.level;
    const state = batteryState(flow.battery);
    rows.push({
      label: TEXT.battery,
      value: isNumber(level) ? join(formatNumber(level, 0, '%'), state.text) : state.text,
      color: flow.battery.critical ? WIDGET_COLORS.DANGER : state.color,
    });
  }
  return rows.filter(Boolean);
}

/**
 * Content of the production widget.
 * @param {object} view see buildEnergyFlowContent
 * @param {object} [settings] the widget settings (`interval`)
 */
export function buildProductionContent(view, settings) {
  const { features, snapshot } = view;
  const ids = features.production;
  const components = [
    tile(ids.ENERGY_TODAY, TEXT.today, 'sun'),
    tile(ids.ENERGY_MONTH, TEXT.thisMonth, 'calendar'),
    tile(ids.ENERGY_YEAR, TEXT.thisYear, 'trending-up'),
    tile(ids.ENERGY_TOTAL, TEXT.total, 'database'),
    {
      type: 'chart',
      device_features: [ids.POWER],
      interval: pickInterval(settings, PRODUCTION_INTERVALS),
      chart_type: WIDGET_CHART_TYPES.AREA,
    },
  ];

  if (snapshot) {
    components.push(
      status([
        revenueRow(snapshot.overview?.revenueToday, view.currency),
        { label: TEXT.updatedAt, value: formatTime(snapshot.fetchedAt, view.timeZone) },
      ]),
    );
  } else {
    components.push(body(TEXT.noReading));
  }

  return { ttl_seconds: WIDGET_TTL, components: components.filter(Boolean) };
}

/**
 * Content of the battery widget.
 * @param {object} view see buildEnergyFlowContent
 */
export function buildBatteryContent(view) {
  const { features, snapshot } = view;
  if (!features.battery) {
    return { ttl_seconds: STATIC_TTL, components: [body(TEXT.noBattery)] };
  }

  const components = [
    { type: 'gauge', device_feature: features.battery.LEVEL, label: TEXT.chargeLevel },
    tile(features.battery.POWER, TEXT.power, 'battery-charging'),
  ];

  const reading = snapshot?.flow?.battery;
  if (reading) {
    const state = batteryState(reading);
    components.push(
      status([
        { label: TEXT.state, value: state.text, color: state.color },
        energyRow(TEXT.energyStored, snapshot.storage?.energyStored),
        isNumber(snapshot.storage?.temperature)
          ? {
              label: TEXT.temperature,
              value: formatNumber(snapshot.storage.temperature, 1, '°C'),
            }
          : null,
        reading.critical
          ? { label: TEXT.batteryLow, value: TEXT.yes, color: WIDGET_COLORS.DANGER }
          : null,
      ]),
      updatedAt(snapshot, view.timeZone),
    );
  } else {
    components.push(body(TEXT.noReading));
  }

  return { ttl_seconds: WIDGET_TTL, components: components.filter(Boolean) };
}

/** Content of any widget while the integration has no site yet. */
export function buildUnavailableContent() {
  return { ttl_seconds: WAITING_TTL, components: [body(TEXT.notConnected)] };
}

// --- Components --------------------------------------------------------------

/** A live tile bound to a published feature. */
function tile(deviceFeature, label, icon) {
  return { type: 'value', device_feature: deviceFeature, label, icon };
}

function body(text) {
  return { type: 'text', variant: WIDGET_TEXT_VARIANTS.BODY, text };
}

/** The status list, or nothing when no row survived (the core refuses 0 rows). */
function status(rows) {
  const items = rows.filter(Boolean);
  return items.length > 0 ? { type: 'status', items } : null;
}

/** "Updated at HH:MM", the local time of the snapshot. */
function updatedAt(snapshot, timeZone) {
  const time = formatTime(snapshot.fetchedAt, timeZone);
  return {
    type: 'text',
    variant: WIDGET_TEXT_VARIANTS.CAPTION,
    text: { en: `${TEXT.updatedAt.en} ${time}`, fr: `${TEXT.updatedAt.fr} ${time}` },
  };
}

/** A status row for an energy, or nothing when SolarEdge did not report it. */
function energyRow(label, kwh) {
  return isNumber(kwh) ? { label, value: formatNumber(kwh, 2, 'kWh') } : null;
}

/** The revenue row, only when SolarEdge computes one (a tariff was entered). */
function revenueRow(revenue, currency) {
  return isNumber(revenue)
    ? { label: TEXT.revenueToday, value: formatMoney(revenue, currency) }
    : null;
}

function batteryState(reading) {
  return BATTERY_STATE_TEXT[reading.state] ?? BATTERY_STATE_TEXT[BATTERY_STATES.IDLE];
}

// --- Formatting --------------------------------------------------------------

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Join two multi-language texts with a middle dot. */
function join(left, right) {
  return { en: `${left.en} · ${right.en}`, fr: `${left.fr} · ${right.fr}` };
}

const LOCALES = { en: 'en-GB', fr: 'fr-FR' };

/**
 * A number for one language: the decimal separator of the language, no
 * thousands grouping. The grouping character is what moves between ICU
 * versions (fr: U+00A0, then U+202F), and the values shown here (today's
 * energies, a revenue) have no use for it.
 * @param {number} value
 * @param {number} digits maximum fraction digits
 * @param {string} locale
 */
function localizeNumber(value, digits, locale) {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: digits,
    useGrouping: false,
  }).format(value);
}

/**
 * A number with its unit, in both languages (`21.4 kWh` / `21,4 kWh`).
 * @param {number} value
 * @param {number} digits maximum fraction digits
 * @param {string} unit
 */
export function formatNumber(value, digits, unit) {
  return {
    en: `${localizeNumber(value, digits, LOCALES.en)} ${unit}`,
    fr: `${localizeNumber(value, digits, LOCALES.fr)} ${unit}`,
  };
}

/**
 * An amount in the configured currency (`€3.21` / `3,21 €`).
 * @param {number} value
 * @param {string} [currency] manifest `currency` value
 */
export function formatMoney(value, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] ?? CURRENCY_SYMBOLS.euro;
  return {
    en: `${symbol}${localizeNumber(value, 2, LOCALES.en)}`,
    fr: `${localizeNumber(value, 2, LOCALES.fr)} ${symbol}`,
  };
}

/**
 * `HH:MM` of an ISO date in the site's timezone — the time the user reads on
 * the monitoring portal — falling back to the container clock (the Gladys
 * timezone, injected as TZ) when the site has none or an unknown one.
 * @param {string} iso
 * @param {string} [timeZone] IANA timezone
 */
export function formatTime(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '--:--';
  }
  const options = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', timeZone ? { ...options, timeZone } : options);
  } catch {
    formatter = new Intl.DateTimeFormat('en-GB', options);
  }
  return formatter.format(date);
}
