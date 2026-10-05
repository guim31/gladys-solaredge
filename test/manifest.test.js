// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ACTIONS, WIDGET_ACTIONS } from '../src/actions.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  DEFAULT_INTERVAL,
  ENERGY_FLOW_INTERVALS,
  PRODUCTION_INTERVALS,
  WIDGET,
  WIDGET_ACTION,
} from '../src/widgets.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('every manifest action has a registered handler, and vice versa', () => {
  const declared = new Set((manifest.actions ?? []).map((a) => a.key));
  const handled = new Set(Object.keys(ACTIONS));

  for (const key of declared) {
    assert.ok(handled.has(key), `manifest action "${key}" has no handler`);
  }
  for (const key of handled) {
    assert.ok(declared.has(key), `handler "${key}" is not declared in the manifest`);
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every non-section field the code reads is declared in the manifest', () => {
  const declared = new Set(
    manifest.config_schema.filter((f) => f.type !== 'section').map((f) => f.key),
  );
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    assert.ok(declared.has(key), `"${key}" has a default but no field in the manifest`);
  }
  // The API key is a `secret` field: the manifest forbids a default on it, so
  // it is declared without ever appearing in DEFAULT_CONFIG.
  assert.ok(declared.has('api_key'));
});

test('the API key is a secret field and is required', () => {
  const field = manifest.config_schema.find((f) => f.key === 'api_key');
  assert.equal(field.type, 'secret');
  assert.equal(field.required, true);
  assert.equal(field.default, undefined, 'a secret field cannot carry a default');
});

test('section fields are purely presentational', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.equal(section.placeholder, undefined);
    assert.ok(section.label?.en && section.label?.fr);
    assert.ok(!(section.key in DEFAULT_CONFIG), 'a section stores no value');
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('the declared transport matches what the integration can do', () => {
  // SolarEdge is only reachable through its cloud API: declaring "local" would
  // make Gladys show a "prefer local" toggle this integration cannot honour.
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('every user-facing string is available in English and in French', () => {
  const texts = [
    manifest.description,
    ...manifest.config_schema.flatMap((f) => [
      f.label,
      f.description,
      f.placeholder,
      ...(f.options ?? []).map((o) => o.label),
      ...(f.links ?? []).map((l) => l.label),
    ]),
    ...(manifest.actions ?? []).flatMap((a) => [a.label, a.description]),
    ...(manifest.widgets ?? []).flatMap((w) => [
      w.label,
      w.description,
      ...(w.settings ?? []).flatMap((f) => [
        f.label,
        f.description,
        ...(f.options ?? []).map((o) => o.label),
      ]),
    ]),
  ].filter(Boolean);

  for (const text of texts) {
    assert.ok(text.en, `missing English text: ${JSON.stringify(text)}`);
    assert.ok(text.fr, `missing French text: ${JSON.stringify(text)}`);
  }
});

test('the manifest version matches package.json and the image tag', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    'the image tag must follow the manifest version',
  );
});

// --- Dashboard widgets -------------------------------------------------------

test('every declared widget has a content handler in index.js, and only those', () => {
  assert.deepEqual(manifest.widgets.map((w) => w.key).sort(), Object.values(WIDGET).sort());
  for (const [name, key] of Object.entries(WIDGET)) {
    assert.ok(indexSource.includes(`onWidgetGet(WIDGET.${name}`), `no onWidgetGet for ${key}`);
  }
  // The only widget with buttons is the only one with an action handler.
  assert.ok(indexSource.includes('onWidgetAction(WIDGET.ENERGY_FLOW'));
  assert.deepEqual(Object.keys(WIDGET_ACTIONS).sort(), Object.values(WIDGET_ACTION).sort());
});

test('widgets need Gladys 5.1: the manifest says so', () => {
  const [, major, minor] = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/).map(Number);
  assert.ok(major > 5 || (major === 5 && minor >= 1), manifest.gladys_version);
});

test('widget declarations fit the store limits', () => {
  assert.ok(manifest.widgets.length >= 1 && manifest.widgets.length <= 5);
  for (const widget of manifest.widgets) {
    assert.match(widget.key, /^[a-z0-9_]{2,32}$/);
    assert.match(widget.icon, /^[a-z0-9-]{1,40}$/, 'a Feather icon name');
    for (const text of Object.values(widget.label)) {
      assert.ok(text.length >= 3 && text.length <= 30, `${widget.key} label: ${text}`);
    }
    for (const text of Object.values(widget.description)) {
      assert.ok(text.length <= 100, `${widget.key} description: ${text.length} characters`);
    }
    assert.ok((widget.settings ?? []).length <= 10);
    for (const field of widget.settings ?? []) {
      assert.ok(['string', 'number', 'boolean', 'select', 'section'].includes(field.type));
      assert.match(field.key, /^[a-z0-9_]+$/);
      if (field.type === 'select') {
        assert.ok(field.options.length >= 1);
        assert.ok(
          field.options.some((o) => o.value === field.default),
          `${widget.key}.${field.key}: the default must be one of the options`,
        );
      }
    }
    if (widget.action_timeout_seconds !== undefined) {
      assert.ok(widget.action_timeout_seconds >= 5 && widget.action_timeout_seconds <= 120);
    }
  }
});

test('the chart interval settings offer exactly what the builders accept', () => {
  const intervalOf = (key) =>
    manifest.widgets.find((w) => w.key === key).settings.find((f) => f.key === 'interval');

  const energyFlow = intervalOf(WIDGET.ENERGY_FLOW);
  assert.deepEqual(
    energyFlow.options.map((o) => o.value),
    ENERGY_FLOW_INTERVALS,
  );
  assert.equal(energyFlow.default, DEFAULT_INTERVAL);

  const production = intervalOf(WIDGET.PRODUCTION);
  assert.deepEqual(
    production.options.map((o) => o.value),
    PRODUCTION_INTERVALS,
  );
  assert.equal(production.default, DEFAULT_INTERVAL);

  // The battery widget has nothing to configure.
  assert.equal(manifest.widgets.find((w) => w.key === WIDGET.BATTERY).settings, undefined);
});

test('the widget with a button declares an action timeout that covers a refresh', () => {
  const energyFlow = manifest.widgets.find((w) => w.key === WIDGET.ENERGY_FLOW);
  // A refresh is 2 to 4 SolarEdge requests: well under 30 s, but never under
  // the 15 s a slow cloud afternoon can take.
  assert.ok(energyFlow.action_timeout_seconds >= 15);
});
