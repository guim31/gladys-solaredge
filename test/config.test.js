import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  connectionFingerprint,
  isConfigured,
  normalizeConfig,
  tokensToConfig,
} from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  const config = normalizeConfig();
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
  assert.equal(config.site_id, '');
  assert.equal(config.api_key, undefined);
});

test('normalizeConfig coerces the numbers coming from the generated form', () => {
  const config = normalizeConfig({ poll_frequency: '1800', monthly_credits: '20000' });
  assert.equal(config.poll_frequency, 1800);
  assert.equal(config.monthly_credits, 20000);
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

const TOKENS = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: 1_000,
  obtainedAt: 500,
};
const APP = { client_id: 'client', client_secret: 'secret', site_id: '1' };

test('the auth mode: an application wins over a (retired V1) key left in the field', () => {
  assert.equal(normalizeConfig().auth_mode, 'none');
  assert.equal(normalizeConfig({ api_key: 'KEY' }).auth_mode, 'fleet');
  assert.equal(normalizeConfig({ ...APP, api_key: 'OLDV1' }).auth_mode, 'connect');
  const connected = normalizeConfig({ ...APP, api_key: 'OLDV1', ...tokensToConfig(TOKENS) });
  assert.equal(connected.auth_mode, 'oauth');
  assert.deepEqual(connected.oauth_tokens, TOKENS);
  // An application missing its secret is not an application.
  assert.equal(normalizeConfig({ client_id: 'client', api_key: 'KEY' }).auth_mode, 'fleet');
});

test('isConfigured needs a Fleet key or a connected application', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ api_key: '' })), false);
  assert.equal(isConfigured(normalizeConfig({ api_key: 'KEY' })), true);
  assert.equal(isConfigured(normalizeConfig(APP)), false, '"Connect" not done yet');
  assert.equal(isConfigured(normalizeConfig({ ...APP, ...tokensToConfig(TOKENS) })), true);
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

test('rotating tokens never rebuild the client; a new application does', () => {
  const connected = normalizeConfig({ ...APP, ...tokensToConfig(TOKENS) });
  const rotated = normalizeConfig({
    ...APP,
    ...tokensToConfig({ ...TOKENS, refreshToken: 'refresh-2', obtainedAt: 900 }),
  });
  assert.equal(connectionFingerprint(rotated), connectionFingerprint(connected));
  assert.notEqual(
    connectionFingerprint(
      normalizeConfig({ ...APP, client_id: 'other', ...tokensToConfig(TOKENS) }),
    ),
    connectionFingerprint(connected),
  );
});
