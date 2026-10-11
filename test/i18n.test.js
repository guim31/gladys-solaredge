// -----------------------------------------------------------------------------
// Languages: every text Gladys may show carries exactly English, French,
// German and Spanish — the languages of the Gladys interface — and fits the
// room the core gives it.
//
// A multi-language object is any object with one of these keys: the walkers
// below check ALL of them, in the manifest and in what the code produces, so a
// text added in two languages only fails here instead of reaching a German
// user in English.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GladysApiError, validateWidgetContent } from '@gladysassistant/integration-sdk';
import { LANGUAGES } from '../src/i18n.js';
import {
  ACTIONS,
  MISSING_KEY_STATUS,
  NOT_CONFIGURED_MESSAGE,
  QUOTA_TRANSPORT_MESSAGE,
  WIDGET_ACTIONS,
  describeError,
  quotaNearlySpentStatus,
} from '../src/actions.js';
import {
  BATTERY_STATE_TEXT,
  TEXT,
  buildBatteryContent,
  buildEnergyFlowContent,
  buildProductionContent,
  buildUnavailableContent,
  widgetFeatures,
} from '../src/widgets.js';
import { buildTransportEntries } from '../src/devices/index.js';
import { normalizeConfig } from '../src/config.js';
import { ERROR_CODES, SolarEdgeError } from '../src/solaredge/client.js';
import { SolarEdgeService } from '../src/solaredge/service.js';
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
  createFakeClient,
} from './helpers/solaredgeFixtures.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

// Bounds, in characters per language value.
const MANIFEST_DESCRIPTION = 100; // store schema: `description`
const WIDGET_LABEL = 30; // store schema: `widgets[].label`
const WIDGET_DESCRIPTION = 100; // store schema: `widgets[].description`
const SECTION_TEXT = 1000; // store schema: `sectionText`
const TILE_LABEL = 24; // SDK TEXT_BOUNDS.tileLabel (also buttonLabel)
const STATUS_VALUE = 40; // SDK TEXT_BOUNDS.statusValue
const BODY = 300; // SDK TEXT_BOUNDS.body
const WIDGET_MESSAGE = 200; // core MAX_WIDGET_MESSAGE_LENGTH (widget action toast)
const TRANSPORT_MESSAGE = 200; // core MAX_TRANSPORT_MESSAGE_LENGTH

const isLocalized = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  LANGUAGES.some((language) => language in value);

/** Exactly the four languages, each a non-empty string within `max`. */
function assertLocalized(value, path, max = Infinity) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...LANGUAGES].sort(),
    `${path} must carry exactly ${LANGUAGES.join(', ')}: ${JSON.stringify(value)}`,
  );
  for (const language of LANGUAGES) {
    const text = value[language];
    assert.equal(typeof text, 'string', `${path}.${language} is not a string`);
    assert.ok(text.trim().length > 0, `${path}.${language} is empty`);
    assert.ok(
      text.trim().length <= max,
      `${path}.${language} is ${text.trim().length} characters long, ${max} allowed: "${text}"`,
    );
  }
}

/** Every multi-language object found under `value`, with its path. */
function collect(value, path, found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => collect(item, `${path}[${i}]`, found));
  } else if (isLocalized(value)) {
    found.push({ path, value });
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collect(child, `${path}.${key}`, found);
    }
  }
  return found;
}

/** The bound of a manifest text, from its path. */
function manifestBound(path) {
  if (path === 'manifest.description') return MANIFEST_DESCRIPTION;
  if (/^manifest\.widgets\[\d+\]\.label$/.test(path)) return WIDGET_LABEL;
  if (/^manifest\.widgets\[\d+\]\.description$/.test(path)) return WIDGET_DESCRIPTION;
  if (/^manifest\.config_schema\[\d+\]\.description$/.test(path)) return SECTION_TEXT;
  return Infinity;
}

test('every multi-language object of the manifest has en, fr, de and es', () => {
  const found = collect(manifest, 'manifest');
  // The walker must see the whole manifest: 46 objects at the time of writing.
  assert.ok(found.length >= 46, `only ${found.length} multi-language objects found`);
  for (const { path, value } of found) {
    assertLocalized(value, path, manifestBound(path));
  }
});

test('no manifest text is a bare string where a multi-language object is expected', () => {
  const textKeys = new Set(['label', 'description', 'placeholder']);
  (function walk(value, path) {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (value && typeof value === 'object' && !isLocalized(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (textKeys.has(key)) {
          assert.ok(isLocalized(child), `${path}.${key} is not a multi-language object`);
        }
        walk(child, `${path}.${key}`);
      }
    }
  })(manifest, 'manifest');
});

test('the widget labels of the code fit a tile, the long texts a body', () => {
  const long = new Set(['noBattery', 'noReading', 'notConnected']);
  for (const [key, value] of Object.entries(TEXT)) {
    assertLocalized(value, `TEXT.${key}`, long.has(key) ? BODY : TILE_LABEL);
  }
  for (const [state, { text }] of Object.entries(BATTERY_STATE_TEXT)) {
    // Shown after "100 % · " in the battery row of the status.
    assertLocalized(text, `BATTERY_STATE_TEXT.${state}`, STATUS_VALUE - '100 % · '.length);
  }
});

test('connection statuses and the quota badge are in every language', () => {
  assertLocalized(NOT_CONFIGURED_MESSAGE, 'NOT_CONFIGURED_MESSAGE', WIDGET_MESSAGE);
  assertLocalized(MISSING_KEY_STATUS, 'MISSING_KEY_STATUS');
  assertLocalized(quotaNearlySpentStatus({ count: 299, limit: 300 }), 'quotaNearlySpentStatus');
  assertLocalized(QUOTA_TRANSPORT_MESSAGE, 'QUOTA_TRANSPORT_MESSAGE', TRANSPORT_MESSAGE);

  const context = { siteId: '1234567', capabilities: { production: true, battery: true } };
  const entries = buildTransportEntries(createFakeGladys(), context, {
    error: { code: ERROR_CODES.QUOTA_EXCEEDED },
  });
  for (const { path, value } of collect(entries, 'transports')) {
    assertLocalized(value, path, TRANSPORT_MESSAGE);
  }
});

test('every failure the user can read is in every language, short enough for a toast', () => {
  const errors = [
    new GladysApiError(422, 'BAD_REQUEST', 'min is required'),
    ...Object.values(ERROR_CODES).map((code) => new SolarEdgeError('site 1', { code })),
    new Error('ECONNRESET'),
    undefined,
  ];
  for (const err of errors) {
    assertLocalized(describeError(err), `describeError(${err?.code ?? err})`, WIDGET_MESSAGE);
  }
});

function createDeps({ capabilities, refreshAll } = {}) {
  const config = normalizeConfig({ api_key: 'K' });
  const overrides =
    capabilities === 'production-only' ? { flow: {}, energy: { unit: 'Wh', meters: [] } } : {};
  const service = new SolarEdgeService(config, {
    client: createFakeClient(overrides),
    now: () => new Date('2024-05-18T13:42:00Z'),
  });
  return { config, service, refreshAll: refreshAll ?? (async () => 12) };
}

test('every action answers in every language, whatever the site and the counts', async () => {
  const gladys = createFakeGladys();
  const scenarios = [
    createDeps(),
    createDeps({ capabilities: 'production-only', refreshAll: async () => 1 }),
  ];
  for (const deps of scenarios) {
    for (const [key, handler] of Object.entries(ACTIONS)) {
      assertLocalized(await handler(gladys, deps), `ACTIONS.${key}`);
    }
    for (const [key, handler] of Object.entries(WIDGET_ACTIONS)) {
      assertLocalized(await handler(gladys, deps), `WIDGET_ACTIONS.${key}`, WIDGET_MESSAGE);
    }
  }
  const failing = createDeps({
    refreshAll: async () => {
      throw new SolarEdgeError('quota', { code: ERROR_CODES.QUOTA_EXCEEDED });
    },
  });
  for (const [key, handler] of Object.entries(WIDGET_ACTIONS)) {
    assertLocalized(await handler(gladys, failing), `WIDGET_ACTIONS.${key}`, WIDGET_MESSAGE);
  }
});

test('every widget content is in every language and reaches the dashboard untruncated', () => {
  const gladys = createFakeGladys();
  const full = {
    production: true,
    consumption: true,
    grid: true,
    battery: true,
    gridImport: true,
    revenue: true,
  };
  const context = {
    config: normalizeConfig({ api_key: 'K', storage_details: true }),
    siteId: '1234567',
    site: SITE_DETAILS,
    capabilities: full,
  };
  const snapshot = {
    flow: parsePowerFlow(CURRENT_POWER_FLOW),
    overview: parseOverview(OVERVIEW),
    energy: parseEnergyDetails(ENERGY_DETAILS),
    storage: parseStorageData(STORAGE_DATA),
    fetchedAt: '2024-05-18T13:42:00Z',
  };
  const view = (snap, capabilities = full) => ({
    features: widgetFeatures(gladys, { ...context, capabilities }),
    snapshot: snap,
    currency: context.config.currency,
    timeZone: SITE_DETAILS.location?.timeZone,
  });
  const contents = {
    energyFlow: buildEnergyFlowContent(view(snapshot), {}),
    energyFlowWaiting: buildEnergyFlowContent(view(null), {}),
    production: buildProductionContent(view(snapshot), {}),
    productionWaiting: buildProductionContent(view(null), {}),
    battery: buildBatteryContent(view(snapshot)),
    batteryWaiting: buildBatteryContent(view(null)),
    noBattery: buildBatteryContent(view(snapshot, { ...full, battery: false })),
    unavailable: buildUnavailableContent(),
  };
  for (const [name, content] of Object.entries(contents)) {
    const found = collect(content, name);
    assert.ok(found.length > 0, `${name} has no text`);
    for (const { path, value } of found) {
      assertLocalized(value, path);
    }
    // The SDK's own bounds, per language value: a truncated text is reported.
    assert.deepEqual(validateWidgetContent(content), [], name);
  }
});
