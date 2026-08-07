// -----------------------------------------------------------------------------
// SolarEdge service: the ONE object that owns the site, its capabilities and
// the shared snapshot every device reads from.
//
// Why a shared snapshot? Gladys polls each device independently: with four
// devices (production, consumption, grid, battery) a naive implementation would
// fire four times the API calls and burn the 300 requests/day budget in a few
// hours. Here, the first device of a polling cycle triggers ONE refresh, the
// three others read the freshly cached values — and concurrent calls share the
// same in-flight promise instead of racing.
//
// Cost of one cycle: 2 requests (`currentPowerFlow` + `overview`), plus the
// slower `energyDetails` (and optionally `storageData`) refresh.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { SolarEdgeClient, SolarEdgeError, ERROR_CODES } from './client.js';
import {
  ENERGY_METERS,
  parseEnergyDetails,
  parseOverview,
  parsePowerFlow,
  parseStorageData,
  siteDayRange,
  siteRecentRange,
} from './snapshot.js';

const logger = createLogger({ name: 'solaredge' });

export class SolarEdgeService {
  /**
   * @param {object} config normalized integration configuration
   * @param {object} [deps]
   * @param {SolarEdgeClient} [deps.client] injectable client, for tests
   * @param {() => Date} [deps.now] injectable clock, for tests
   */
  constructor(config, { client, now = () => new Date() } = {}) {
    this.config = config;
    this.now = now;
    this.client =
      client ??
      new SolarEdgeClient({
        apiKey: config.api_key,
        dailyRequestLimit: config.daily_request_limit,
        now,
      });

    this.siteId = null;
    this.site = null; // details: name, timezone, peak power
    this.capabilities = null;
    this.snapshot = null;
    this.snapshotAt = 0;
    this.energyAt = 0;
    this.storageAt = 0;
    this.inFlight = null;
    this.lastError = null;
  }

  /** Apply a configuration change that does NOT require a new client. */
  updateConfig(config) {
    this.config = config;
    this.client.dailyRequestLimit = config.daily_request_limit;
  }

  /** Daily budget state, surfaced by the "API usage" action. */
  get usage() {
    return this.client.usage;
  }

  /**
   * Resolve the site to work on: the one configured by the user, or — when the
   * field is left empty — the single site the API key gives access to.
   */
  async resolveSiteId() {
    if (this.siteId) {
      return this.siteId;
    }
    if (this.config.site_id) {
      this.siteId = this.config.site_id;
      return this.siteId;
    }

    const sites = await this.client.getSites();
    if (sites.length === 0) {
      throw new SolarEdgeError('This API key gives access to no site.', {
        code: ERROR_CODES.NOT_FOUND,
      });
    }
    if (sites.length > 1) {
      const ids = sites.map((site) => site.id).join(', ');
      throw new SolarEdgeError(
        `This API key gives access to ${sites.length} sites (${ids}): fill in the "Site ID" setting.`,
        { code: ERROR_CODES.NOT_FOUND },
      );
    }
    this.siteId = String(sites[0].id);
    logger.info(`Site auto-detected: ${sites[0].name} (${this.siteId})`);
    return this.siteId;
  }

  /** Site details, fetched once (name, timezone, peak power, currency). */
  async getSite() {
    if (this.site) {
      return this.site;
    }
    const siteId = await this.resolveSiteId();
    this.site = (await this.client.getSiteDetails(siteId)) ?? {};
    return this.site;
  }

  /** Sites reachable with the configured API key (used by the manifest action). */
  async listSites() {
    return this.client.getSites();
  }

  /**
   * What this installation can actually feed. Derived from a real snapshot:
   * `currentPowerFlow` only exposes LOAD/GRID/STORAGE when the matching
   * hardware (consumption meter, battery) is installed, and `energyDetails`
   * confirms the meters for sites whose flow endpoint stays empty.
   */
  async getCapabilities({ force = false } = {}) {
    if (this.capabilities && !force) {
      return this.capabilities;
    }
    const snapshot = await this.getSnapshot({ force: true });
    const flow = snapshot.flow;
    const energy = snapshot.energy;
    const overview = snapshot.overview;

    this.capabilities = {
      // A SolarEdge site always produces: the production device is the floor.
      production: true,
      consumption:
        Boolean(flow?.load !== null && flow?.load !== undefined) || hasMeter(energy, 'consumption'),
      grid:
        Boolean(flow?.grid !== null && flow?.grid !== undefined) ||
        hasMeter(energy, 'purchased') ||
        hasMeter(energy, 'feedIn'),
      battery: Boolean(flow?.battery),
      // Revenue is not hardware: SolarEdge computes it as "feed-in tariff ×
      // energy produced", and only when the owner has entered that tariff in
      // the monitoring portal (Admin > Revenue). Without it the API returns no
      // revenue at all, and a feature that can never hold a value is worse
      // than no feature — it reads as a broken sensor forever.
      //
      // The lifetime total is the reliable signal: today's revenue is
      // legitimately 0 (not absent) just after midnight on a site that HAS a
      // tariff, so testing it alone would flip the capability with the clock.
      revenue: hasValue(overview?.revenueLifetime) || hasValue(overview?.revenueToday),
    };
    logger.info(`Capabilities detected: ${JSON.stringify(this.capabilities)}`);
    return this.capabilities;
  }

  /**
   * The shared snapshot. Returns the cached one while it is fresh enough for
   * the current polling interval, and never runs two refreshes at once.
   *
   * @param {{force?: boolean}} [options] `force: true` bypasses the freshness
   *   check (used by the capability probe and the "Refresh now" action)
   */
  async getSnapshot({ force = false } = {}) {
    const age = this.now().getTime() - this.snapshotAt;
    // 80% of the polling interval: short enough that the next cycle really
    // refreshes, long enough that the devices of one cycle share a single read.
    const ttl = Math.max(30, this.config.poll_frequency * 0.8) * 1000;
    if (this.snapshot && !force && age < ttl) {
      return this.snapshot;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.#refresh()
      .catch((err) => {
        this.lastError = err;
        throw err;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async #refresh() {
    const siteId = await this.resolveSiteId();
    const site = await this.getSite();
    const timeZone = site?.location?.timeZone;
    const now = this.now();

    // The two live endpoints, in parallel: one round-trip per cycle.
    const [flowResult, overviewResult] = await Promise.allSettled([
      this.client.getCurrentPowerFlow(siteId),
      this.client.getOverview(siteId),
    ]);

    // A cycle that fails entirely must not silently serve stale values: it
    // rejects, and the devices report themselves unreachable.
    if (flowResult.status === 'rejected' && overviewResult.status === 'rejected') {
      throw flowResult.reason;
    }

    const flow =
      flowResult.status === 'fulfilled'
        ? parsePowerFlow(flowResult.value)
        : (logWarn('currentPowerFlow', flowResult.reason), this.snapshot?.flow ?? null);
    const overview =
      overviewResult.status === 'fulfilled'
        ? parseOverview(overviewResult.value)
        : (logWarn('overview', overviewResult.reason), this.snapshot?.overview ?? null);

    const energy = await this.#refreshEnergyDetails(siteId, timeZone, now);
    const storage = await this.#refreshStorageData(siteId, timeZone, now, flow);

    this.snapshot = { flow, overview, energy, storage, fetchedAt: now.toISOString() };
    this.snapshotAt = now.getTime();
    this.lastError = null;
    return this.snapshot;
  }

  /**
   * Daily energy breakdown, on its own slower cadence: consumption,
   * self-consumption, import and export barely move between two live reads,
   * and each refresh costs one request out of the daily budget.
   */
  async #refreshEnergyDetails(siteId, timeZone, now) {
    const due = now.getTime() - this.energyAt >= this.config.energy_details_frequency * 1000;
    if (!due && this.snapshot?.energy) {
      return this.snapshot.energy;
    }
    try {
      const { startTime, endTime } = siteDayRange(now, timeZone);
      const details = await this.client.getEnergyDetails(siteId, {
        startTime,
        endTime,
        timeUnit: 'DAY',
        meters: ENERGY_METERS,
      });
      this.energyAt = now.getTime();
      return parseEnergyDetails(details);
    } catch (err) {
      logWarn('energyDetails', err);
      // Keep the previous breakdown: a missed refresh is better than a hole.
      return this.snapshot?.energy ?? null;
    }
  }

  /** Optional battery telemetry (stored energy, temperature). */
  async #refreshStorageData(siteId, timeZone, now, flow) {
    if (!this.config.storage_details || !flow?.battery) {
      return null;
    }
    const due = now.getTime() - this.storageAt >= this.config.energy_details_frequency * 1000;
    if (!due && this.snapshot?.storage) {
      return this.snapshot.storage;
    }
    try {
      const { startTime, endTime } = siteRecentRange(now, timeZone, 60);
      const storageData = await this.client.getStorageData(siteId, { startTime, endTime });
      this.storageAt = now.getTime();
      return parseStorageData(storageData);
    } catch (err) {
      logWarn('storageData', err);
      return this.snapshot?.storage ?? null;
    }
  }
}

/** True when `energyDetails` returned a real reading for that meter. */
function hasMeter(energy, key) {
  return Boolean(energy) && energy[key] !== null && energy[key] !== undefined;
}

/** A real number, as opposed to "SolarEdge did not report this". 0 counts. */
function hasValue(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function logWarn(endpoint, err) {
  logger.warn(`SolarEdge ${endpoint} failed: ${err?.message ?? err}`);
}
