// -----------------------------------------------------------------------------
// Integration configuration.
//
// The values are filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches them
// (`gladys.getConfig()`) and notifies every change through
// `gladys.onConfigUpdated()`.
//
// This module only holds the defaults and normalizes the received object, so
// the rest of the code never deals with `undefined` nor with numbers arriving
// as strings from the generated form.
//
// Two ways to reach SolarEdge (Monitoring API V2, see src/solaredge/client.js):
//   - `oauth`: a homeowner's own "Site Access" application (`client_id`,
//     `client_secret`) authorized with the "Connect" button. The tokens are
//     stored by the integration itself, as config keys OUTSIDE the schema
//     (`oauth_*`): never shown, never sent to the front;
//   - `fleet`: an installer's Fleet API key (`api_key`).
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (a unit test enforces it).
//
// Secrets (`client_secret`, `api_key`) never have a default: the manifest
// forbids it, and an absent value means "not configured yet".
export const DEFAULT_CONFIG = {
  client_id: '',
  site_id: '',
  // Wished refresh interval, in seconds. Stretched by the service until a
  // month of refresh cycles fits in the monthly credits (refreshInterval()).
  poll_frequency: 900,
  // The SolarEdge developer account's monthly allowance: 2,000 on the Free
  // tier. Shared by every application of the account.
  monthly_credits: 2000,
  // Extra `storage/status` call per cycle: the battery temperature.
  storage_details: false,
};

/** Currencies offered by the manifest, mapped to the Gladys unit name. */
export const CURRENCY_UNITS = {
  euro: 'euro',
  dollar: 'dollar',
  'pound-sterling': 'pound-sterling',
};

/** Config keys outside the schema where the OAuth tokens live. */
export const TOKEN_KEYS = {
  ACCESS: 'oauth_access_token',
  REFRESH: 'oauth_refresh_token',
  EXPIRES_AT: 'oauth_expires_at',
  OBTAINED_AT: 'oauth_obtained_at',
};

/** The config values that store a token pair (for `gladys.setConfig`). */
export function tokensToConfig(tokens) {
  return {
    [TOKEN_KEYS.ACCESS]: tokens.accessToken,
    [TOKEN_KEYS.REFRESH]: tokens.refreshToken,
    [TOKEN_KEYS.EXPIRES_AT]: tokens.expiresAt,
    [TOKEN_KEYS.OBTAINED_AT]: tokens.obtainedAt,
  };
}

/**
 * Merge the user configuration with the defaults and force the types.
 * @param {Record<string, unknown>} raw configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const refreshToken = text(raw[TOKEN_KEYS.REFRESH]);
  const config = {
    ...DEFAULT_CONFIG,
    ...raw,
    // Trimmed to survive a paste with a trailing newline.
    api_key: text(raw.api_key) || undefined,
    client_id: text(raw.client_id),
    client_secret: text(raw.client_secret) || undefined,
    site_id: String(raw.site_id ?? DEFAULT_CONFIG.site_id).trim(),
    poll_frequency: toNumber(raw.poll_frequency, DEFAULT_CONFIG.poll_frequency),
    monthly_credits: toNumber(raw.monthly_credits, DEFAULT_CONFIG.monthly_credits),
    storage_details: raw.storage_details === true,
    // V2 reports no revenue: the "Revenue currency" field left with V1. Kept
    // for the dormant revenue code (src/devices/production.js, widgets).
    currency: CURRENCY_UNITS[raw.currency] ? raw.currency : 'euro',
    oauth_tokens: refreshToken
      ? {
          accessToken: text(raw[TOKEN_KEYS.ACCESS]) || undefined,
          refreshToken,
          expiresAt: toNumber(raw[TOKEN_KEYS.EXPIRES_AT], 0),
          obtainedAt: toNumber(raw[TOKEN_KEYS.OBTAINED_AT], 0),
        }
      : null,
  };
  config.auth_mode = authMode(config);
  return config;
}

/**
 * How the integration authenticates. A homeowner application wins over an
 * API key: a key left in the field by version 1.x is a retired V1 key.
 *
 * - `oauth`:     client id + secret + tokens from a "Connect";
 * - `connect`:   client id + secret, "Connect" not done yet;
 * - `fleet`:     an API key alone;
 * - `none`:      nothing usable.
 */
function authMode(config) {
  if (config.client_id && config.client_secret) {
    return config.oauth_tokens ? 'oauth' : 'connect';
  }
  return config.api_key ? 'fleet' : 'none';
}

/** True when the integration has everything it needs to talk to SolarEdge. */
export function isConfigured(config) {
  return config.auth_mode === 'oauth' || config.auth_mode === 'fleet';
}

/**
 * Fingerprint of the settings that define the SolarEdge client: when it
 * changes, the service (and its caches) must be rebuilt instead of updated.
 * The tokens are not part of it: they rotate every two hours, and a new
 * "Connect" is handed to the running client (`adoptTokens`).
 */
export function connectionFingerprint(config) {
  return [
    config.auth_mode,
    config.auth_mode === 'fleet' ? (config.api_key ?? '') : '',
    config.client_id,
    config.client_secret ?? '',
    config.site_id,
  ].join('|');
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return value !== null && value !== '' && Number.isFinite(parsed) ? parsed : fallback;
}
