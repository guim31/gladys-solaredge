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
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (a unit test enforces it).
//
// `api_key` is a `secret` field: the manifest forbids a default on it, and it
// never appears here either — an absent key means "not configured yet".
export const DEFAULT_CONFIG = {
  site_id: '',
  // How often Gladys asks the devices to refresh, in seconds. Every device of
  // the integration shares ONE snapshot per cycle (see src/solaredge/service.js),
  // so a cycle costs 2 SolarEdge requests, not 2 per device.
  poll_frequency: 900,
  // The daily energy breakdown (consumption, self-consumption, import, export)
  // only moves slowly: it is refreshed on its own, slower cadence.
  energy_details_frequency: 1800,
  // Extra `storageData` call: stored energy and battery temperature. Off by
  // default because it costs one more request per energy-details cycle.
  storage_details: false,
  // SolarEdge caps an API key at 300 requests/day/site. The client refuses to
  // go past this budget instead of getting the key throttled by SolarEdge.
  daily_request_limit: 300,
  currency: 'euro',
};

/** Currencies offered by the manifest, mapped to the Gladys unit name. */
export const CURRENCY_UNITS = {
  euro: 'euro',
  dollar: 'dollar',
  'pound-sterling': 'pound-sterling',
};

/**
 * Merge the user configuration with the defaults and force the types.
 * @param {Record<string, unknown>} raw configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // `api_key` stays as provided (or undefined): trimmed to survive a paste
    // with a trailing newline, which SolarEdge would reject with a 403.
    api_key: typeof raw.api_key === 'string' ? raw.api_key.trim() : undefined,
    site_id: String(raw.site_id ?? DEFAULT_CONFIG.site_id).trim(),
    poll_frequency: toNumber(raw.poll_frequency, DEFAULT_CONFIG.poll_frequency),
    energy_details_frequency: toNumber(
      raw.energy_details_frequency,
      DEFAULT_CONFIG.energy_details_frequency,
    ),
    daily_request_limit: toNumber(raw.daily_request_limit, DEFAULT_CONFIG.daily_request_limit),
    storage_details: raw.storage_details === true,
    currency: CURRENCY_UNITS[raw.currency] ? raw.currency : DEFAULT_CONFIG.currency,
  };
}

/** True when the integration has everything it needs to talk to SolarEdge. */
export function isConfigured(config) {
  return typeof config.api_key === 'string' && config.api_key.length > 0;
}

/**
 * Fingerprint of the settings that define the SolarEdge client: when it
 * changes, the service (and its caches) must be rebuilt instead of updated.
 */
export function connectionFingerprint(config) {
  return [config.api_key ?? '', config.site_id, config.daily_request_limit].join('|');
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
