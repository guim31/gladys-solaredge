import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  connectionFingerprint,
  isConfigured,
  normalizeConfig,
} from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  const config = normalizeConfig();
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
  assert.equal(config.site_id, '');
  assert.equal(config.api_key, undefined);
});

test('normalizeConfig coerces the numbers coming from the generated form', () => {
  const config = normalizeConfig({
    poll_frequency: '600',
    energy_details_frequency: '3600',
    daily_request_limit: '250',
  });
  assert.equal(config.poll_frequency, 600);
  assert.equal(config.energy_details_frequency, 3600);
  assert.equal(config.daily_request_limit, 250);
});

test('normalizeConfig falls back to the default for an unusable number', () => {
  const config = normalizeConfig({ poll_frequency: 'often' });
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

test('the API key is trimmed: a pasted key often carries a trailing newline', () => {
  assert.equal(normalizeConfig({ api_key: '  ABC123\n' }).api_key, 'ABC123');
  assert.equal(normalizeConfig({ site_id: ' 42 ' }).site_id, '42');
});

test('storage_details is only on for an explicit true', () => {
  assert.equal(normalizeConfig().storage_details, false);
  assert.equal(normalizeConfig({ storage_details: 'yes' }).storage_details, false);
  assert.equal(normalizeConfig({ storage_details: true }).storage_details, true);
});

test('an unknown currency falls back to the default instead of breaking a feature', () => {
  assert.equal(normalizeConfig({ currency: 'zloty' }).currency, 'euro');
  assert.equal(normalizeConfig({ currency: 'dollar' }).currency, 'dollar');
});

test('isConfigured only needs the API key: the site can be auto-detected', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ api_key: '' })), false);
  assert.equal(isConfigured(normalizeConfig({ api_key: 'KEY' })), true);
});

test('the fingerprint changes exactly when the client must be rebuilt', () => {
  const base = normalizeConfig({ api_key: 'KEY', site_id: '1' });
  // A new polling interval reuses the client (and its request counter)...
  assert.equal(
    connectionFingerprint(normalizeConfig({ api_key: 'KEY', site_id: '1', poll_frequency: 600 })),
    connectionFingerprint(base),
  );
  // ...but another key or another site is a different installation.
  assert.notEqual(
    connectionFingerprint(normalizeConfig({ api_key: 'OTHER', site_id: '1' })),
    connectionFingerprint(base),
  );
  assert.notEqual(
    connectionFingerprint(normalizeConfig({ api_key: 'KEY', site_id: '2' })),
    connectionFingerprint(base),
  );
});
