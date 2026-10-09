// -----------------------------------------------------------------------------
// Dashboard widgets: the contents the builders produce, checked against the
// core's own rules (validateWidgetContent) and against the devices actually
// published — a tile bound to an undeclared feature would stay empty forever.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import {
  DEFAULT_INTERVAL,
  ENERGY_FLOW_INTERVALS,
  PRODUCTION_INTERVALS,
  WIDGET_ACTION,
  WIDGET_TTL,
  buildBatteryContent,
  buildEnergyFlowContent,
  buildProductionContent,
  buildUnavailableContent,
  formatEnergy,
  formatMoney,
  formatNumber,
  formatTime,
  pickInterval,
  widgetFeatures,
} from '../src/widgets.js';
import { buildDiscoveredDevices } from '../src/devices/index.js';
import { normalizeConfig } from '../src/config.js';
import {
  parseEnergyDetails,
  parseOverview,
  parsePowerFlow,
  parseStorageData,
} from '../src/solaredge/snapshot.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  CURRENT_POWER_FLOW,
  ENERGY_DETAILS,
  OVERVIEW,
  SITE_DETAILS,
  STORAGE_DATA,
} from './helpers/solaredgeFixtures.js';

const gladys = createFakeGladys();
const FULL = { production: true, consumption: true, grid: true, battery: true, revenue: true };
const PRODUCTION_ONLY = {
  production: true,
  consumption: false,
  grid: false,
  battery: false,
  revenue: false,
};

function createContext({ capabilities = FULL, config = {} } = {}) {
  return {
    config: normalizeConfig({ api_key: 'K', ...config }),
    siteId: '1234567',
    site: SITE_DETAILS,
    capabilities,
  };
}

/** The fixtures' spring afternoon, as the service would snapshot it (13:42 UTC). */
function createSnapshot({
  flow = CURRENT_POWER_FLOW,
  storage = STORAGE_DATA,
  overview = OVERVIEW,
} = {}) {
  return {
    flow: parsePowerFlow(flow),
    overview: parseOverview(overview),
    energy: parseEnergyDetails(ENERGY_DETAILS),
    storage: storage ? parseStorageData(storage) : null,
    fetchedAt: '2024-05-18T13:42:00Z',
  };
}

function createView({ context = createContext(), snapshot = createSnapshot() } = {}) {
  return {
    features: widgetFeatures(gladys, context),
    snapshot,
    currency: context.config.currency,
    timeZone: context.site?.location?.timeZone,
  };
}

const byType = (content, type) => content.components.filter((c) => c.type === type);
const one = (content, type) => {
  const found = byType(content, type);
  assert.equal(found.length, 1, `expected one ${type} component`);
  return found[0];
};
const rowLabels = (status) => status.items.map((item) => item.label.fr);
const row = (status, labelFr) => status.items.find((item) => item.label.fr === labelFr);

/** Every text the core would show must exist in both languages. */
function assertBilingual(value, path = 'content') {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertBilingual(item, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    if ('en' in value || 'fr' in value) {
      assert.ok(value.en && value.fr, `${path} is not bilingual: ${JSON.stringify(value)}`);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      assertBilingual(child, `${path}.${key}`);
    }
  }
}

/** Every bound feature must be one the discovery payload declares. */
function assertBoundFeaturesDeclared(content, context) {
  const declared = new Set(
    buildDiscoveredDevices(gladys, context).flatMap((d) => d.features.map((f) => f.external_id)),
  );
  for (const component of content.components) {
    for (const id of [component.device_feature, ...(component.device_features ?? [])]) {
      if (id !== undefined) {
        assert.ok(declared.has(id), `bound to an undeclared feature: ${id}`);
      }
    }
  }
}

/** The house rules every content must follow, whatever the site. */
function assertWellFormed(content, context) {
  assert.deepEqual(validateWidgetContent(content), []);
  assertBilingual(content);
  assertBoundFeaturesDeclared(content, context);
  const buttons = byType(content, 'button');
  const keys = buttons.map((b) => b.action?.key);
  assert.equal(new Set(keys).size, keys.length, 'action keys must be unique');
  for (const button of buttons) {
    assert.notEqual(button.style, 'primary', 'primary is invisible in dark mode');
  }
}

// --- energy_flow -------------------------------------------------------------

test('energy_flow on a full site: four live tiles, three-series chart, balance, button', () => {
  const context = createContext();
  const view = createView({ context });
  const content = buildEnergyFlowContent(view, {});
  assertWellFormed(content, context);
  assert.equal(content.ttl_seconds, WIDGET_TTL);
  assert.equal(content.components.length, 8, 'exactly the core budget');

  const tiles = byType(content, 'value');
  assert.deepEqual(
    tiles.map((t) => t.device_feature),
    [
      view.features.production.POWER,
      view.features.consumption.POWER,
      view.features.grid.POWER,
      view.features.battery.POWER,
    ],
  );
  assert.deepEqual(
    tiles.map((t) => t.icon),
    ['sun', 'home', 'zap', 'battery'],
  );

  const chart = one(content, 'chart');
  assert.deepEqual(chart.device_features, [
    view.features.production.POWER,
    view.features.consumption.POWER,
    view.features.grid.POWER,
  ]);
  assert.equal(chart.interval, DEFAULT_INTERVAL);

  const status = one(content, 'status');
  assert.deepEqual(rowLabels(status), [
    'Production du jour',
    'Consommation du jour',
    'Autoconsommation',
    'Soutiré',
    'Injecté',
    'Revenu du jour',
    'Batterie',
  ]);
  assert.deepEqual(row(status, 'Production du jour').value, { en: '21.4 kWh', fr: '21,4 kWh' });
  assert.deepEqual(row(status, 'Revenu du jour').value, { en: '€3.21', fr: '3,21 €' });
  const batteryRow = row(status, 'Batterie');
  assert.deepEqual(batteryRow.value, { en: '62% · Charging', fr: '62 % · En charge' });
  assert.equal(batteryRow.color, 'success');

  const caption = one(content, 'text');
  assert.equal(caption.variant, 'caption');
  // 13:42 UTC is 15:42 at the site (Europe/Paris).
  assert.equal(caption.text.fr, 'Actualisé à 15:42');

  const button = one(content, 'button');
  assert.equal(button.action.key, WIDGET_ACTION.REFRESH);
  assert.equal(button.icon, 'refresh-cw');
});

test('energy_flow on a production-only site: no meter, no battery, no error', () => {
  const context = createContext({ capabilities: PRODUCTION_ONLY });
  const snapshot = createSnapshot({
    flow: { unit: 'kW', connections: [], PV: { status: 'Active', currentPower: 4.2 } },
    storage: null,
    overview: {
      ...OVERVIEW,
      lifeTimeData: { energy: 18_540_000 },
      lastDayData: { energy: 21_400 },
    },
  });
  snapshot.energy = null;
  const view = createView({ context, snapshot });
  const content = buildEnergyFlowContent(view, {});
  assertWellFormed(content, context);

  assert.equal(byType(content, 'value').length, 1);
  assert.deepEqual(one(content, 'chart').device_features, [view.features.production.POWER]);
  // Nothing SolarEdge did not report: no consumption, no grid, no revenue, no battery.
  assert.deepEqual(rowLabels(one(content, 'status')), ['Production du jour']);
});

test('energy_flow: the interval setting drives the chart, unknown values fall back', () => {
  const view = createView();
  assert.equal(
    one(buildEnergyFlowContent(view, { interval: 'last-week' }), 'chart').interval,
    'last-week',
  );
  assert.equal(
    one(buildEnergyFlowContent(view, { interval: 'last-year' }), 'chart').interval,
    DEFAULT_INTERVAL,
  );
  assert.equal(one(buildEnergyFlowContent(view, undefined), 'chart').interval, DEFAULT_INTERVAL);
  assert.equal(pickInterval({ interval: 'last-month' }, ENERGY_FLOW_INTERVALS), DEFAULT_INTERVAL);
  assert.equal(pickInterval({ interval: 'last-month' }, PRODUCTION_INTERVALS), 'last-month');
});

test('energy_flow before the first reading: live tiles, an explicit sentence, the button', () => {
  const context = createContext();
  const content = buildEnergyFlowContent(createView({ context, snapshot: null }), {});
  assertWellFormed(content, context);
  assert.equal(byType(content, 'status').length, 0);
  const [text] = byType(content, 'text');
  assert.equal(text.variant, 'body');
  assert.match(text.fr ?? text.text.fr, /Aucune lecture SolarEdge/);
  assert.equal(byType(content, 'button').length, 1);
});

test('energy_flow: a critical battery turns its row red', () => {
  const flow = {
    ...CURRENT_POWER_FLOW,
    STORAGE: { status: 'Discharging', currentPower: 0.8, chargeLevel: 9, critical: true },
    connections: [{ from: 'Storage', to: 'Load' }],
  };
  const content = buildEnergyFlowContent(
    createView({ snapshot: createSnapshot({ flow, storage: null }) }),
    {},
  );
  const batteryRow = row(one(content, 'status'), 'Batterie');
  assert.equal(batteryRow.color, 'danger');
  assert.equal(batteryRow.value.fr, '9 % · En décharge');
});

// --- production --------------------------------------------------------------

test('production: four counters, an area chart, the revenue and the time', () => {
  const context = createContext();
  const view = createView({ context });
  const content = buildProductionContent(view, { interval: 'last-month' });
  assertWellFormed(content, context);
  assert.equal(content.ttl_seconds, WIDGET_TTL);

  const ids = view.features.production;
  const tiles = byType(content, 'value');
  // Today is live; month, year and lifetime come from the snapshot.
  assert.deepEqual(
    tiles.map((t) => t.device_feature),
    [ids.ENERGY_TODAY, undefined, undefined, undefined],
  );
  assert.deepEqual(
    tiles.slice(1).map((t) => [t.label.fr, t.value.fr, t.value.en, t.unit]),
    [
      ['Ce mois', '612', '612', 'kWh'],
      ['Cette année', '4120', '4120', 'kWh'],
      ['Total', '18540', '18540', 'kWh'],
    ],
  );
  const chart = one(content, 'chart');
  assert.deepEqual(chart.device_features, [ids.POWER]);
  assert.equal(chart.chart_type, 'area');
  assert.equal(chart.interval, 'last-month');

  const status = one(content, 'status');
  assert.deepEqual(rowLabels(status), ['Revenu du jour', 'Actualisé à']);
  assert.equal(row(status, 'Actualisé à').value, '15:42');
  assert.equal(byType(content, 'text').length, 0, 'the time is a status row here');
});

test('production without a tariff: no revenue row, the time stays', () => {
  const context = createContext({ capabilities: { ...FULL, revenue: false } });
  const snapshot = createSnapshot({
    overview: {
      ...OVERVIEW,
      lifeTimeData: { energy: 18_540_000 },
      lastDayData: { energy: 21_400 },
    },
  });
  const content = buildProductionContent(createView({ context, snapshot }), {});
  assertWellFormed(content, context);
  assert.deepEqual(rowLabels(one(content, 'status')), ['Actualisé à']);
});

test('production before the first reading: the live counter and a sentence', () => {
  const context = createContext();
  const content = buildProductionContent(createView({ context, snapshot: null }), {});
  assertWellFormed(content, context);
  // The snapshot tiles need a value: without a reading only the live one stays.
  assert.equal(byType(content, 'value').length, 1);
  assert.equal(byType(content, 'status').length, 0);
  assert.equal(one(content, 'text').variant, 'body');
});

// --- battery -----------------------------------------------------------------

test('battery with detailed telemetry: gauge, power, state, stored energy, temperature', () => {
  const context = createContext({ config: { storage_details: true } });
  const view = createView({ context });
  const content = buildBatteryContent(view);
  assertWellFormed(content, context);
  assert.equal(content.ttl_seconds, WIDGET_TTL);

  const gauge = one(content, 'gauge');
  assert.equal(gauge.device_feature, view.features.battery.LEVEL);
  assert.equal(gauge.min, undefined, 'the range comes from the feature (0-100)');
  assert.equal(one(content, 'value').device_feature, view.features.battery.POWER);

  const status = one(content, 'status');
  assert.deepEqual(rowLabels(status), ['État', 'Énergie stockée', 'Température']);
  assert.equal(row(status, 'État').value.fr, 'En charge');
  assert.equal(row(status, 'État').color, 'success');
  // 9600 Wh usable × 62 % = 5952 Wh.
  assert.deepEqual(row(status, 'Énergie stockée').value, { en: '5.95 kWh', fr: '5,95 kWh' });
  assert.deepEqual(row(status, 'Température').value, { en: '25.1 °C', fr: '25,1 °C' });
  assert.equal(one(content, 'text').text.fr, 'Actualisé à 15:42');
});

test('battery without telemetry: only what the power flow gives', () => {
  const context = createContext();
  const content = buildBatteryContent(
    createView({ context, snapshot: createSnapshot({ storage: null }) }),
  );
  assertWellFormed(content, context);
  assert.deepEqual(rowLabels(one(content, 'status')), ['État']);
});

test('battery states: discharging is info, idle neutral, critical adds a red row', () => {
  const stateOf = (STORAGE, connections) => {
    const content = buildBatteryContent(
      createView({
        snapshot: createSnapshot({
          flow: { ...CURRENT_POWER_FLOW, STORAGE, connections },
          storage: null,
        }),
      }),
    );
    return one(content, 'status');
  };
  const discharging = stateOf(
    { status: 'Discharging', currentPower: 0.8, chargeLevel: 40, critical: false },
    [{ from: 'Storage', to: 'Load' }],
  );
  assert.equal(row(discharging, 'État').value.fr, 'En décharge');
  assert.equal(row(discharging, 'État').color, 'info');
  assert.equal(row(discharging, 'Batterie faible'), undefined);

  const idle = stateOf({ status: 'Idle', currentPower: 0, chargeLevel: 100, critical: false }, []);
  assert.equal(row(idle, 'État').value.fr, 'Au repos');
  assert.equal(row(idle, 'État').color, 'neutral');

  const low = stateOf({ status: 'Disabled', currentPower: 0, chargeLevel: 5, critical: true }, []);
  assert.equal(row(low, 'État').value.fr, 'Désactivée');
  assert.equal(row(low, 'Batterie faible').color, 'danger');
  assert.deepEqual(row(low, 'Batterie faible').value, { en: 'Yes', fr: 'Oui' });
});

test('battery on a site without storage: a sentence, not an error', () => {
  const context = createContext({ capabilities: PRODUCTION_ONLY });
  const content = buildBatteryContent(
    createView({ context, snapshot: createSnapshot({ storage: null }) }),
  );
  assertWellFormed(content, context);
  assert.equal(content.components.length, 1);
  assert.equal(content.components[0].text.fr, 'Aucune batterie sur ce site SolarEdge.');
  assert.ok(content.ttl_seconds > WIDGET_TTL, 'nothing to refresh until the next scan');
});

test('battery declared but not in the last snapshot: the sentence replaces the status', () => {
  const context = createContext();
  const content = buildBatteryContent(createView({ context, snapshot: null }));
  assertWellFormed(content, context);
  assert.equal(byType(content, 'gauge').length, 1);
  assert.equal(byType(content, 'status').length, 0);
  assert.match(one(content, 'text').text.fr, /Aucune lecture/);
});

// --- shared ------------------------------------------------------------------

test('the waiting content is valid and says what to do', () => {
  const content = buildUnavailableContent();
  assert.deepEqual(validateWidgetContent(content), []);
  assertBilingual(content);
  assert.match(content.components[0].text.fr, /configuration/);
});

test('numbers, money and times are formatted for each language', () => {
  // No thousands grouping: its character differs between ICU versions.
  assert.deepEqual(formatNumber(1234.5, 1, 'kWh'), { en: '1234.5 kWh', fr: '1234,5 kWh' });
  assert.deepEqual(formatNumber(21.4, 2, 'kWh'), { en: '21.4 kWh', fr: '21,4 kWh' });
  assert.deepEqual(formatNumber(62, 0, '%'), { en: '62%', fr: '62 %' });
  // Energies: two decimals for a day, none from 1000 kWh on (narrow tiles).
  assert.deepEqual(formatEnergy(9.844), { en: '9.84 kWh', fr: '9,84 kWh' });
  assert.deepEqual(formatEnergy(999.99), { en: '999.99 kWh', fr: '999,99 kWh' });
  assert.deepEqual(formatEnergy(3052.54), { en: '3053 kWh', fr: '3053 kWh' });
  assert.deepEqual(formatEnergy(26618.84), { en: '26619 kWh', fr: '26619 kWh' });
  // Money always carries two decimals.
  assert.deepEqual(formatMoney(3.2, 'euro'), { en: '€3.20', fr: '3,20 €' });
  assert.deepEqual(formatMoney(0, 'euro'), { en: '€0.00', fr: '0,00 €' });
  assert.deepEqual(formatMoney(3.21, 'dollar'), { en: '$3.21', fr: '3,21 $' });
  assert.deepEqual(formatMoney(3.21, 'pound-sterling'), { en: '£3.21', fr: '3,21 £' });
  assert.deepEqual(formatMoney(3.21, 'unknown'), { en: '€3.21', fr: '3,21 €' });

  assert.equal(formatTime('2024-05-18T13:42:00Z', 'Europe/Paris'), '15:42');
  assert.equal(formatTime('2024-05-18T13:42:00Z', 'UTC'), '13:42');
  // An unknown timezone falls back to the container clock instead of throwing.
  assert.match(formatTime('2024-05-18T13:42:00Z', 'Mars/Olympus'), /^\d{2}:\d{2}$/);
  assert.equal(formatTime('not a date'), '--:--');
});
