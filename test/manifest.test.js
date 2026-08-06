// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ACTIONS } from '../src/actions.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

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
