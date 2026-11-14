// -----------------------------------------------------------------------------
// SolarEdge Monitoring API V2 client.
//
// This is the only file that talks to the outside world. SolarEdge retired the
// V1 API (`?api_key=` in the URL) on 2026-11-03: every V1 call now answers
// HTTP 410. V2 lives under https://monitoringapi.solaredge.com/v2 and takes one
// of two credentials (developer docs, "Authentication"):
//
//   - a homeowner authorizes a "Site Access" application of their own SolarEdge
//     developer account through OAuth 2.0: `Authorization: Bearer <token>`,
//     a 2-hour access token renewed with a refresh token that ROTATES (the old
//     one dies at each refresh) and expires after 14 days without use;
//   - an installer uses the "Fleet API key" of their company account:
//     `X-API-Key: <key>`, static.
//
// On top of the credentials, every call needs:
//   1. a DAILY REQUEST BUDGET. The Free tier gives 2,000 credits a month for the
//      whole developer account (1 credit per successful call, 10 calls per
//      minute) and answers 429 until the next billing cycle once they are
//      spent. We count our own requests against a daily share of the monthly
//      allowance and stop BEFORE SolarEdge does: a too-short interval degrades
//      the refresh rate instead of locking the account for weeks;
//   2. typed errors, so the callers can tell "reconnect" from "out of budget".
//
// Node 20+ provides `fetch` natively: no HTTP dependency.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'solaredge-api' });

export const DEFAULT_BASE_URL = 'https://monitoringapi.solaredge.com/v2';
export const AUTHORIZE_URL = 'https://connect.solaredge.com/authorize';
/** OAuth scopes: site totals (overview, power, energy) and device telemetry (meters, battery). */
export const OAUTH_SCOPES = 'SITE_DATA DEVICE_DATA';

/** Renew the access token this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/** Reasons a SolarEdge call can fail, used by the callers to react properly. */
export const ERROR_CODES = {
  UNAUTHORIZED: 'unauthorized', // credentials refused (bad key, wrong site, missing scope)
  RECONNECT: 'reconnect', // the OAuth authorization is gone: press "Connect" again
  API_RETIRED: 'api_retired', // HTTP 410: the endpoint belongs to the retired V1 API
  TIER: 'tier', // 403 tier_insufficient: the endpoint needs a paid plan
  NOT_FOUND: 'not_found', // unknown site id
  RATE_LIMITED: 'rate_limited', // SolarEdge refused: too many calls this minute
  CREDITS_EXHAUSTED: 'credits_exhausted', // SolarEdge refused: monthly credits spent
  QUOTA_EXCEEDED: 'quota_exceeded', // OUR own daily budget is spent
  NOT_READY: 'not_ready', // the integration has not reached SolarEdge yet (no site known)
  UNAVAILABLE: 'unavailable', // network error, timeout, 5xx
  UNEXPECTED: 'unexpected',
};

export class SolarEdgeError extends Error {
  constructor(message, { code = ERROR_CODES.UNEXPECTED, status, cause } = {}) {
    super(message, { cause });
    this.name = 'SolarEdgeError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The daily share of a monthly credit allowance. A month has at most 31 days
 * and the billing cycle starts on an unknown day of it: spending 1/31 a day
 * can never run the allowance out before the cycle resets.
 */
export function dailyBudget(monthlyCredits) {
  return Math.max(1, Math.floor(Number(monthlyCredits) / 31));
}

/** The authorization URL the "Connect" button opens. */
export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', OAUTH_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

export class SolarEdgeClient {
  /**
   * @param {object} options
   * @param {string} [options.apiKey] Fleet API key (installer accounts)
   * @param {object} [options.oauth] Site Access credentials
   * @param {string} options.oauth.clientId
   * @param {string} options.oauth.clientSecret
   * @param {{ accessToken?: string, refreshToken: string, expiresAt?: number }} options.oauth.tokens
   * @param {(tokens: object) => Promise<void>} [options.onTokens] persists a renewed token pair
   * @param {number} [options.monthlyCredits] the developer account's allowance (default 2000)
   * @param {string} [options.baseUrl] override, for tests
   * @param {typeof fetch} [options.fetchImpl] override, for tests
   * @param {() => Date} [options.now] injectable clock, for tests
   * @param {number} [options.timeout] per-request timeout in ms
   */
  constructor({
    apiKey,
    oauth,
    onTokens = async () => {},
    monthlyCredits = 2000,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    now = () => new Date(),
    timeout = 15_000,
  }) {
    this.apiKey = apiKey;
    this.oauth = oauth ?? null;
    this.tokens = oauth?.tokens ? { ...oauth.tokens } : null;
    this.onTokens = onTokens;
    this.monthlyCredits = monthlyCredits;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeout = timeout;
    // Budget bookkeeping, reset on the first request of a new UTC day.
    this.usageDay = null;
    this.usageCount = 0;
    this.refreshing = null;
  }

  /** `oauth` (homeowner Site Access) or `fleet` (installer API key). */
  get mode() {
    return this.oauth ? 'oauth' : 'fleet';
  }

  get dailyRequestLimit() {
    return dailyBudget(this.monthlyCredits);
  }

  /** Current state of the daily budget, surfaced by the "API usage" action. */
  get usage() {
    const day = utcDay(this.now());
    const count = this.usageDay === day ? this.usageCount : 0;
    return {
      day,
      count,
      limit: this.dailyRequestLimit,
      remaining: Math.max(0, this.dailyRequestLimit - count),
    };
  }

  /**
   * Adopt tokens saved elsewhere (a new "Connect"), unless ours are newer: a
   * configuration echo must never bring back a refresh token we already
   * rotated, SolarEdge would refuse it.
   */
  adoptTokens(tokens) {
    if (!this.oauth || !tokens?.refreshToken) {
      return;
    }
    if (!this.tokens || (tokens.obtainedAt ?? 0) > (this.tokens.obtainedAt ?? 0)) {
      this.tokens = { ...tokens };
    }
  }

  /**
   * Perform a GET on the Monitoring API and return the parsed JSON body.
   * @param {string} path e.g. `/sites/123/overview`
   * @param {Record<string, string|number|string[]>} [params] query parameters
   */
  async request(path, params = {}) {
    this.#consumeBudget(path);

    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined && item !== null && item !== '') {
          url.searchParams.append(key, String(item));
        }
      }
    }
    logger.debug(`GET ${path}`, params);

    let response = await this.#get(url, path);
    // An access token can die before its announced expiry (revoked, clock
    // skew): renew it once and replay, as the docs advise on a 401.
    if (response.status === 401 && this.oauth) {
      await this.#refreshTokens();
      response = await this.#get(url, path);
    }
    if (!response.ok) {
      throw await buildHttpError(response, path, this.mode);
    }
    try {
      return await response.json();
    } catch (err) {
      throw new SolarEdgeError(`SolarEdge returned an unreadable body (${path})`, {
        code: ERROR_CODES.UNEXPECTED,
        cause: err,
      });
    }
  }

  async #get(url, path) {
    const headers = { Accept: 'application/json', ...(await this.#authHeaders()) };
    try {
      return await this.fetchImpl(url.toString(), {
        headers,
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (err) {
      throw new SolarEdgeError(`SolarEdge unreachable (${path}): ${err.message}`, {
        code: ERROR_CODES.UNAVAILABLE,
        cause: err,
      });
    }
  }

  async #authHeaders() {
    if (!this.oauth) {
      return { 'X-API-Key': this.apiKey };
    }
    const expiresAt = this.tokens?.expiresAt ?? 0;
    if (!this.tokens?.accessToken || expiresAt - TOKEN_MARGIN_MS <= this.now().getTime()) {
      await this.#refreshTokens();
    }
    return { Authorization: `Bearer ${this.tokens.accessToken}` };
  }

  /**
   * Renew the access token. Concurrent callers share one refresh: two would
   * spend the same refresh token, and the second would be refused.
   */
  async #refreshTokens() {
    if (this.refreshing) {
      return this.refreshing;
    }
    const used = this.tokens?.refreshToken;
    this.refreshing = (async () => {
      if (!used) {
        throw new SolarEdgeError('No SolarEdge authorization: press "Connect".', {
          code: ERROR_CODES.RECONNECT,
        });
      }
      const tokens = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: used });
      this.tokens = tokens;
      logger.debug('SolarEdge access token renewed');
      try {
        await this.onTokens(tokens);
      } catch (err) {
        // Kept in memory anyway: this process goes on working, only a restart
        // before the next successful save would need a new "Connect".
        logger.error(`Could not save the renewed SolarEdge tokens: ${err.message}`);
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Exchange an authorization code (the "Connect" callback) for a token pair. */
  async exchangeCode({ code, redirectUri }) {
    const tokens = await this.#tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    this.tokens = tokens;
    return tokens;
  }

  /**
   * POST /v2/oauth2/token with a JSON body (docs, "Authentication", steps 4
   * and 6). Not counted in the budget: it is no Monitoring API call.
   */
  async #tokenRequest(body) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          ...body,
          client_id: this.oauth.clientId,
          client_secret: this.oauth.clientSecret,
        }),
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (err) {
      throw new SolarEdgeError(`SolarEdge token endpoint unreachable: ${err.message}`, {
        code: ERROR_CODES.UNAVAILABLE,
        cause: err,
      });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok || !payload?.access_token) {
      const reason = [payload?.error, payload?.error_description].filter(Boolean).join(': ');
      const detail = reason || `HTTP ${response.status}`;
      // 400/401 are deterministic (wrong secret, used code, dead refresh
      // token): only a new "Connect" (or fixing the secret) gets out of it.
      if (response.status === 400 || response.status === 401) {
        throw new SolarEdgeError(`SolarEdge refused the authorization (${detail})`, {
          code: ERROR_CODES.RECONNECT,
          status: response.status,
        });
      }
      // A busy minute or a hiccup: the refresh token is intact, retry later.
      throw new SolarEdgeError(`SolarEdge token endpoint failed (${detail})`, {
        code: response.status === 429 ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.UNAVAILABLE,
        status: response.status,
      });
    }
    const obtainedAt = this.now().getTime();
    return {
      accessToken: payload.access_token,
      // A response without a new refresh token keeps the current one.
      refreshToken: payload.refresh_token ?? body.refresh_token,
      expiresAt: obtainedAt + Number(payload.expires_in ?? 7200) * 1000,
      obtainedAt,
    };
  }

  /** Sites the Fleet API key gives access to (OAuth tokens cannot list sites). */
  async getSites() {
    const body = await this.request('/sites', { page: 1, 'sites-in-page': 100 });
    return body?.sites?.site ?? [];
  }

  /** Static description of a site: name, peak power, timezone, installation date. */
  async getSiteDetails(siteId) {
    return this.request(`/sites/${encodeURIComponent(siteId)}`);
  }

  /** Today's energy balance (local site day): production and consumption, split. */
  async getOverview(siteId) {
    return this.request(`/sites/${encodeURIComponent(siteId)}/overview`);
  }

  /** PV production power series (15-minute averages). */
  async getPower(siteId, { from, to }) {
    return this.request(`/sites/${encodeURIComponent(siteId)}/power`, {
      from,
      to,
      resolution: 'QUARTER_HOUR',
      unit: 'W',
    });
  }

  /** PV production energy series. */
  async getEnergy(siteId, { from, to, resolution }) {
    return this.request(`/sites/${encodeURIComponent(siteId)}/energy`, {
      from,
      to,
      resolution,
      unit: 'WH',
    });
  }

  /** The site's lifetime production, from the onboard counters. */
  async getLifetimeEnergy(siteId) {
    return this.request(`/sites/${encodeURIComponent(siteId)}/lifetime-energy`);
  }

  /** Meters and batteries of the site (hardware detection). */
  async getDevices(siteId, types) {
    return this.request(`/sites/${encodeURIComponent(siteId)}/devices`, { types });
  }

  /** Production, consumption, import and export powers of every meter. */
  async getMetersTelemetry(siteId, { from, to }) {
    return this.request(`/sites/${encodeURIComponent(siteId)}/meters/telemetry`, {
      from,
      to,
      resolution: 'QUARTER_HOUR',
    });
  }

  /** Lifetime counters of the meters (the grid import index). */
  async getMetersLifetimeEnergy(siteId, { from, to, meters }) {
    return this.request(`/sites/${encodeURIComponent(siteId)}/meters/lifetime-energy`, {
      from,
      to,
      meters: meters?.join(','),
    });
  }

  /** Charge / discharge power, state of energy and stored energy of every battery. */
  async getStorageTelemetry(siteId, { from, to }) {
    return this.request(`/sites/${encodeURIComponent(siteId)}/storage/telemetry`, {
      from,
      to,
      resolution: 'QUARTER_HOUR',
    });
  }

  /** Battery internal temperature (and an opaque state code). */
  async getStorageStatus(siteId, { from, to }) {
    return this.request(`/sites/${encodeURIComponent(siteId)}/storage/status`, { from, to });
  }

  /**
   * Reserve one request in the daily budget, or refuse the call.
   * Counting BEFORE the request (and not only on success) is deliberate: the
   * calls-per-minute limit counts failures too, and erring on the safe side
   * keeps the monthly allowance whole.
   */
  #consumeBudget(path) {
    const day = utcDay(this.now());
    if (this.usageDay !== day) {
      this.usageDay = day;
      this.usageCount = 0;
    }
    if (this.usageCount >= this.dailyRequestLimit) {
      throw new SolarEdgeError(
        `Daily SolarEdge request budget spent (${this.dailyRequestLimit}/day), skipping ${path}`,
        { code: ERROR_CODES.QUOTA_EXCEEDED },
      );
    }
    this.usageCount += 1;
  }
}

/** UTC day key (YYYY-MM-DD) used to reset the request counter at midnight. */
function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

/** Map an HTTP failure to a SolarEdgeError the callers can branch on. */
async function buildHttpError(response, path, mode) {
  // V2 answers RFC 7807 problem details (400/403/404) or the gateway's own
  // JSON (401/429); either way we only keep a short excerpt for the logs.
  let detail;
  try {
    detail = (await response.text()).slice(0, 300).replace(/\s+/g, ' ').trim();
  } catch {
    detail = '';
  }
  const suffix = detail ? ` — ${detail}` : '';
  const status = response.status;

  switch (status) {
    case 401:
      return new SolarEdgeError(
        mode === 'oauth'
          ? `SolarEdge refused the authorization (${path})${suffix}`
          : `SolarEdge refused the API key (${path})${suffix}`,
        { code: mode === 'oauth' ? ERROR_CODES.RECONNECT : ERROR_CODES.UNAUTHORIZED, status },
      );
    case 403:
      return new SolarEdgeError(`SolarEdge denied access (${path})${suffix}`, {
        code: /tier/i.test(detail) ? ERROR_CODES.TIER : ERROR_CODES.UNAUTHORIZED,
        status,
      });
    case 404:
      return new SolarEdgeError(`SolarEdge resource not found (${path})${suffix}`, {
        code: ERROR_CODES.NOT_FOUND,
        status,
      });
    case 410:
      return new SolarEdgeError(`SolarEdge retired this API (${path})${suffix}`, {
        code: ERROR_CODES.API_RETIRED,
        status,
      });
    case 429: {
      // Same status, two meanings. The OpenAPI spec flags a spent month with
      // `x-ratelimit-remaining-month: 0`; the "Authentication" page tells them
      // apart by `x-ratelimit-remaining-minute` (0 for the minute window) and
      // the body. The month header wins when present.
      const month = response.headers?.get?.('x-ratelimit-remaining-month');
      const minute = response.headers?.get?.('x-ratelimit-remaining-minute');
      const monthly =
        month === '0' ||
        (month == null && (/credit/i.test(detail) || (minute != null && Number(minute) > 0)));
      return new SolarEdgeError(
        monthly
          ? `SolarEdge monthly credits spent (${path})${suffix}`
          : `SolarEdge rate limit reached (${path})${suffix}`,
        { code: monthly ? ERROR_CODES.CREDITS_EXHAUSTED : ERROR_CODES.RATE_LIMITED, status },
      );
    }
    default:
      return new SolarEdgeError(`SolarEdge HTTP ${status} (${path})${suffix}`, {
        code: status >= 500 ? ERROR_CODES.UNAVAILABLE : ERROR_CODES.UNEXPECTED,
        status,
      });
  }
}
