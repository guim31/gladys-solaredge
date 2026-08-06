// -----------------------------------------------------------------------------
// SolarEdge Monitoring API client.
//
// This is the only file that talks to the outside world. It wraps the public
// SolarEdge Monitoring API (https://monitoringapi.solaredge.com) with the three
// things every call needs:
//
//   1. the API key, appended as a query parameter to every request;
//   2. a DAILY REQUEST BUDGET — SolarEdge allows 300 requests per day per API
//      key and per site, and answers 429 once the quota is spent. We count our
//      own requests and stop BEFORE SolarEdge does, so a misconfigured polling
//      interval degrades the refresh rate instead of locking the key out for
//      the rest of the day;
//   3. typed errors, so the callers can tell "wrong API key" from "site has no
//      battery" from "we are out of budget".
//
// Node 20+ provides `fetch` natively: no HTTP dependency.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'solaredge-api' });

export const DEFAULT_BASE_URL = 'https://monitoringapi.solaredge.com';

/** Reasons a SolarEdge call can fail, used by the callers to react properly. */
export const ERROR_CODES = {
  UNAUTHORIZED: 'unauthorized', // bad API key, or key not allowed on this site
  NOT_FOUND: 'not_found', // unknown site id
  RATE_LIMITED: 'rate_limited', // SolarEdge refused: too many requests
  QUOTA_EXCEEDED: 'quota_exceeded', // OUR own daily budget is spent
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

export class SolarEdgeClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey SolarEdge Monitoring API key
   * @param {number} [options.dailyRequestLimit] our own budget (default 300)
   * @param {string} [options.baseUrl] override, for tests
   * @param {typeof fetch} [options.fetchImpl] override, for tests
   * @param {() => Date} [options.now] injectable clock, for tests
   * @param {number} [options.timeout] per-request timeout in ms
   */
  constructor({
    apiKey,
    dailyRequestLimit = 300,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = fetch,
    now = () => new Date(),
    timeout = 15_000,
  }) {
    this.apiKey = apiKey;
    this.dailyRequestLimit = dailyRequestLimit;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeout = timeout;
    // Budget bookkeeping, reset on the first request of a new UTC day.
    this.usageDay = null;
    this.usageCount = 0;
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
   * Perform a GET on the Monitoring API and return the parsed JSON body.
   * @param {string} path e.g. `/site/123/overview`
   * @param {Record<string, string|number>} [params] extra query parameters
   */
  async request(path, params = {}) {
    this.#consumeBudget(path);

    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    // The key is set last and never logged: `url.pathname` is what we trace.
    url.searchParams.set('api_key', this.apiKey);

    logger.debug(`GET ${path}`, params);

    let response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (err) {
      throw new SolarEdgeError(`SolarEdge unreachable (${path}): ${err.message}`, {
        code: ERROR_CODES.UNAVAILABLE,
        cause: err,
      });
    }

    if (!response.ok) {
      throw await buildHttpError(response, path);
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

  /** Sites the API key gives access to. */
  async getSites() {
    const body = await this.request('/sites/list', { size: 100 });
    return body?.sites?.site ?? [];
  }

  /** Static description of a site: name, peak power, timezone, currency. */
  async getSiteDetails(siteId) {
    const body = await this.request(`/site/${encodeURIComponent(siteId)}/details`);
    return body?.details ?? null;
  }

  /** Production totals: current power, day / month / year / lifetime energy. */
  async getOverview(siteId) {
    const body = await this.request(`/site/${encodeURIComponent(siteId)}/overview`);
    return body?.overview ?? null;
  }

  /**
   * Live power flow between PV, home, grid and battery.
   * Sites without the required hardware answer an empty object.
   */
  async getCurrentPowerFlow(siteId) {
    const body = await this.request(`/site/${encodeURIComponent(siteId)}/currentPowerFlow`);
    return body?.siteCurrentPowerFlow ?? null;
  }

  /**
   * Energy split per meter (Production, Consumption, SelfConsumption, FeedIn,
   * Purchased) over a period.
   */
  async getEnergyDetails(siteId, { startTime, endTime, timeUnit = 'DAY', meters }) {
    const body = await this.request(`/site/${encodeURIComponent(siteId)}/energyDetails`, {
      startTime,
      endTime,
      timeUnit,
      meters: meters?.join(','),
    });
    return body?.energyDetails ?? null;
  }

  /** Battery telemetry (state of energy, temperature, lifetime energy). */
  async getStorageData(siteId, { startTime, endTime }) {
    const body = await this.request(`/site/${encodeURIComponent(siteId)}/storageData`, {
      startTime,
      endTime,
    });
    return body?.storageData ?? null;
  }

  /**
   * Reserve one request in the daily budget, or refuse the call.
   * Counting BEFORE the request (and not only on success) is deliberate:
   * SolarEdge counts every request it receives, successful or not.
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
async function buildHttpError(response, path) {
  // SolarEdge answers errors as JSON (`{"String":"..."}`) or as plain text;
  // either way we only keep a short excerpt for the logs.
  let detail;
  try {
    detail = (await response.text()).slice(0, 200).replace(/\s+/g, ' ').trim();
  } catch {
    detail = '';
  }

  const suffix = detail ? ` — ${detail}` : '';
  switch (response.status) {
    case 401:
    case 403:
      return new SolarEdgeError(`SolarEdge refused the API key (${path})${suffix}`, {
        code: ERROR_CODES.UNAUTHORIZED,
        status: response.status,
      });
    case 404:
      return new SolarEdgeError(`SolarEdge resource not found (${path})${suffix}`, {
        code: ERROR_CODES.NOT_FOUND,
        status: response.status,
      });
    case 429:
      return new SolarEdgeError(`SolarEdge rate limit reached (${path})${suffix}`, {
        code: ERROR_CODES.RATE_LIMITED,
        status: response.status,
      });
    default:
      return new SolarEdgeError(`SolarEdge HTTP ${response.status} (${path})${suffix}`, {
        code: response.status >= 500 ? ERROR_CODES.UNAVAILABLE : ERROR_CODES.UNEXPECTED,
        status: response.status,
      });
  }
}
