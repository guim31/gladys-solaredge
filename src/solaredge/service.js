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
// slower `energyDetails` (and optionally `storageData`) refresh, plus one
// request a day for the grid import index of a metered site.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { SolarEdgeClient, SolarEdgeError, ERROR_CODES } from './client.js';
import {
  ENERGY_METERS,
  addDays,
  installationDay,
  parseEnergyDetails,
  parseOverview,
  parsePowerFlow,
  parseStorageData,
  round,
  siteDay,
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
    // Site day the cached `energyDetails` breakdown covers.
    this.energyDay = null;
    // Grid import index: purchased energy up to the end of the day before
    // `day`, the full past years of it, and the highest index published.
    this.importBase = null; // { day, kwh }
    this.importPastYears = null; // { year, kwh }
    this.importIndex = null;
    this.importFailedDay = null; // a day whose history failed: not retried
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
   * The last snapshot read, however old — or `null` before the first one.
   *
   * This is what the dashboard widgets read: a widget is pulled by every open
   * dashboard, and letting it refresh SolarEdge would spend the 300 requests/day
   * budget on page loads. The snapshot only moves on the polling schedule (and
   * on "Refresh now"); the live tiles follow the published states on their own.
   */
  get lastSnapshot() {
    return this.snapshot;
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
   * a NUMBER in `currentPowerFlow` (LOAD/GRID power, a STORAGE node), or a
   * real reading in `energyDetails` for sites whose flow endpoint stays empty.
   *
   * Presence alone proves nothing. A site with an inverter and no meter still
   * answers `GRID: { status: 'Inactive' }` in the flow and lists the
   * Consumption/FeedIn/Purchased meters in `energyDetails` with dates and no
   * `value` (a real SE3000H, 2026-10-09): testing for the node created a
   * "Grid" device stuck at 0 W. `parsePowerFlow` and `parseEnergyDetails`
   * already turn those into `null`, so a `null` here means "not measured".
   */
  async getCapabilities({ force = false } = {}) {
    if (this.capabilities && !force) {
      return this.capabilities;
    }
    const snapshot = await this.getSnapshot({ force: true });
    const flow = snapshot.flow;
    const energy = snapshot.energy;
    const overview = snapshot.overview;

    // Hardware does not leave between two probes of the same process: a
    // re-probe (a scan) that lands on a meter between two readings, with
    // `energyDetails` failing too, must not take a device away.
    const seen = this.capabilities ?? {};
    this.capabilities = {
      // A SolarEdge site always produces: the production device is the floor.
      production: true,
      consumption: seen.consumption || hasValue(flow?.load) || hasMeter(energy, 'consumption'),
      grid:
        seen.grid ||
        hasValue(flow?.grid) ||
        hasMeter(energy, 'purchased') ||
        hasMeter(energy, 'feedIn'),
      battery: seen.battery || Boolean(flow?.battery),
      // A cumulative grid import index needs the purchased energy of the day
      // and the commissioning date to add up the days before it.
      gridImport:
        seen.gridImport || (hasMeter(energy, 'purchased') && installationDay(this.site) !== null),
      // Revenue is not hardware: SolarEdge computes it as "feed-in tariff ×
      // energy produced", and only when the owner has entered that tariff in
      // the monitoring portal (Admin > Revenue). A feature that can never hold
      // a value is worse than no feature — it reads as a broken sensor forever.
      //
      // Without a tariff the API still answers `lifeTimeData.revenue: 0.0` and
      // no `lastDayData.revenue` at all (same real site): a lifetime 0 is the
      // absence of a tariff, not a revenue. So: today's revenue when SolarEdge
      // gives one (0 included — just after midnight on a site WITH a tariff),
      // or a lifetime total that actually grew.
      revenue: hasValue(overview?.revenueToday) || overview?.revenueLifetime > 0,
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
    const gridImportIndex = await this.#gridImportIndex(siteId, site, energy);

    this.snapshot = {
      flow,
      overview,
      energy,
      storage,
      gridImportIndex,
      fetchedAt: now.toISOString(),
    };
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
      this.energyDay = siteDay(now, timeZone);
      return parseEnergyDetails(details);
    } catch (err) {
      logWarn('energyDetails', err);
      // Keep the previous breakdown: a missed refresh is better than a hole.
      return this.snapshot?.energy ?? null;
    }
  }

  /**
   * The grid import INDEX: every kWh bought from the grid since the site was
   * commissioned, in kWh, never going down — or `null` when it cannot be
   * built (no purchased reading, no commissioning date, a failed request).
   *
   * Why: the Gladys energy module (30-minute consumption, cost, energy
   * dashboard) only reads a cumulative consumption index. What a metered
   * SolarEdge site pays its supplier is the energy PURCHASED from the grid —
   * not the house consumption, which includes the free self-consumed solar.
   * SolarEdge has no lifetime purchased counter, so it is rebuilt:
   *
   *     index = purchased up to the end of yesterday   (once a day)
   *           + purchased today                        (the daily breakdown)
   *
   * Both halves are tied to the SAME site day (`energyDay`, the day of the
   * cached breakdown): just after midnight the breakdown still holds
   * yesterday's total, and adding it to a base that already includes
   * yesterday would count the day twice — a spike billed as consumption.
   */
  async #gridImportIndex(siteId, site, energy) {
    const purchasedToday = energy?.purchased;
    const day = this.energyDay;
    const installed = installationDay(site);
    if (!hasValue(purchasedToday) || !day || !installed || this.importFailedDay === day) {
      return null;
    }
    let base;
    try {
      base = await this.#importBase(siteId, installed, day);
    } catch (err) {
      // Not retried before tomorrow: a history SolarEdge keeps refusing would
      // otherwise spend requests at every refresh, up to the whole budget.
      this.importFailedDay = day;
      logWarn('energyDetails (grid import index, retried tomorrow)', err);
      return null;
    }
    // Never backwards: a day SolarEdge revises down by a few Wh must not read
    // as a meter reset (the core skips negative deltas, then counts the jump
    // back up as consumption).
    this.importIndex = Math.max(this.importIndex ?? 0, round(base + purchasedToday, 2));
    return this.importIndex;
  }

  /** Purchased energy from commissioning to the end of the day before `day`. */
  async #importBase(siteId, installed, day) {
    if (this.importBase?.day === day) {
      return this.importBase.kwh;
    }
    const year = Number(day.slice(0, 4));
    const yearStart = `${year}-01-01`;
    const yesterday = addDays(day, -1);

    let kwh = 0;
    if (installed < yearStart) {
      kwh += await this.#importPastYears(siteId, installed, year);
    }
    // This year, day by day: one bucket per day, nothing ambiguous.
    const from = installed > yearStart ? installed : yearStart;
    if (from <= yesterday) {
      kwh += await this.#purchased(siteId, from, yesterday, 'DAY');
    }
    this.importBase = { day, kwh };
    return kwh;
  }

  /**
   * Purchased energy of the full years before `year`, cached for the year.
   * One YEAR-bucket request; if SolarEdge refuses the period (the API caps
   * some time units to a period, answering 400/403), one DAY request per year.
   */
  async #importPastYears(siteId, installed, year) {
    if (this.importPastYears?.year === year) {
      return this.importPastYears.kwh;
    }
    const lastDay = `${year - 1}-12-31`;
    let kwh;
    try {
      kwh = await this.#purchased(siteId, installed, lastDay, 'YEAR');
    } catch (err) {
      if (err?.status !== 400 && err?.status !== 403) {
        throw err;
      }
      logger.info(
        `energyDetails refused a multi-year period (${err.message}): one request per year`,
      );
      kwh = 0;
      for (let y = Number(installed.slice(0, 4)); y < year; y += 1) {
        const start = y === Number(installed.slice(0, 4)) ? installed : `${y}-01-01`;
        kwh += await this.#purchased(siteId, start, `${y}-12-31`, 'DAY');
      }
    }
    this.importPastYears = { year, kwh };
    return kwh;
  }

  /** Purchased kWh over whole site days, 0 when the meter reported nothing. */
  async #purchased(siteId, fromDay, toDay, timeUnit) {
    const details = await this.client.getEnergyDetails(siteId, {
      startTime: `${fromDay} 00:00:00`,
      endTime: `${toDay} 23:59:59`,
      timeUnit,
      meters: ['PURCHASED'],
    });
    // A year before the meter was fitted has no value: nothing was measured,
    // and nothing is owed to the index either.
    return parseEnergyDetails(details)?.purchased ?? 0;
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
