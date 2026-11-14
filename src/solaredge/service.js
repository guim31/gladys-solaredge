// -----------------------------------------------------------------------------
// SolarEdge service: the ONE object that owns the site, its capabilities and
// the shared snapshot every device reads from.
//
// Why a shared snapshot? Every device (production, consumption, grid, battery)
// reads the same SolarEdge figures: one refresh feeds them all, and concurrent
// callers share the same in-flight promise instead of racing.
//
// Cost of one cycle on the Monitoring API V2 (1 credit per call):
//   - `overview`                 today's balance (production, consumption,
//                                imported, exported, self-consumption);
//   - `power`                    the live PV power — skipped when a production
//                                meter already reports it;
//   - `meters/telemetry`         live home and grid powers (sites with a meter);
//   - `storage/telemetry`        battery power, charge, stored energy;
//   - `storage/status`           battery temperature (optional setting).
// Once a day (site day): `energy` by month (this month, this year) and
// `lifetime-energy` (the lifetime production counter), plus
// `meters/lifetime-energy` for the grid import index of a metered site.
//
// The Free tier gives 2,000 credits a month: `refreshInterval()` stretches the
// user's interval until a month of cycles fits in the allowance.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { SolarEdgeClient, SolarEdgeError, ERROR_CODES } from './client.js';
import {
  addDays,
  isoInstant,
  parseDevices,
  parseImportCounter,
  parseLifetimeEnergy,
  parseMetersTelemetry,
  parseMonthlyEnergy,
  parseOverview,
  parsePower,
  parseSiteDetails,
  parseStorageStatus,
  parseStorageTelemetry,
  round,
  siteDay,
} from './snapshot.js';

const logger = createLogger({ name: 'solaredge' });

/** Live readings: the last 45 minutes hold the latest complete 15-minute bucket. */
const LIVE_WINDOW_MS = 45 * 60_000;
/** A failed once-a-day read is retried at most this often. */
const DAILY_RETRY_MS = 60 * 60_000;
/**
 * Requests left aside every day for the user's own buttons ("Test the
 * connection", "Refresh now") and a restart (site details, detection).
 */
export const DAILY_RESERVE = 6;

export class SolarEdgeService {
  /**
   * @param {object} config normalized integration configuration
   * @param {object} [deps]
   * @param {SolarEdgeClient} [deps.client] injectable client, for tests
   * @param {(tokens: object) => Promise<void>} [deps.onTokens] persists renewed OAuth tokens
   * @param {() => Date} [deps.now] injectable clock, for tests
   */
  constructor(config, { client, onTokens, now = () => new Date() } = {}) {
    this.config = config;
    this.now = now;
    this.client =
      client ??
      new SolarEdgeClient({
        apiKey: config.api_key,
        oauth:
          config.auth_mode === 'oauth'
            ? {
                clientId: config.client_id,
                clientSecret: config.client_secret,
                tokens: config.oauth_tokens,
              }
            : null,
        onTokens,
        monthlyCredits: config.monthly_credits,
        now,
      });

    this.siteId = null;
    this.site = null; // details: name, timezone, peak power
    this.hardware = null; // { meters, productionMeter, batteries }
    this.capabilities = null;
    this.snapshot = null;
    this.snapshotAt = 0;
    // Once-a-day reads, tied to a site day: `base + today` gives the month,
    // the year, the lifetime production and the grid import index all day.
    this.daily = null; // { day, month, year, lifetime, import }
    this.dailyFailedAt = 0;
    this.lifetimeIndex = null;
    this.importIndex = null;
    this.inFlight = null;
    this.lastError = null;
    // Endpoints whose last call failed: a failure is logged once, at `warn`,
    // and its recovery once, at `info` — not one line per refresh cycle.
    this.failing = new Set();
  }

  /** Apply a configuration change that does NOT require a new client. */
  updateConfig(config) {
    this.config = config;
    this.client.monthlyCredits = config.monthly_credits;
    this.client.adoptTokens?.(config.oauth_tokens);
  }

  /** Daily budget state, surfaced by the "API usage" action. */
  get usage() {
    return this.client.usage;
  }

  /**
   * The last snapshot read, however old — or `null` before the first one.
   *
   * This is what the dashboard widgets read: a widget is pulled by every open
   * dashboard, and letting it refresh SolarEdge would spend the monthly
   * credits on page loads.
   */
  get lastSnapshot() {
    return this.snapshot;
  }

  /** Requests one refresh cycle costs on this site. */
  get callsPerCycle() {
    const hw = this.hardware ?? { meters: 0, productionMeter: false, batteries: 0 };
    let calls = 1; // overview
    if (hw.meters > 0) {
      calls += 1;
    }
    if (!hw.productionMeter) {
      calls += 1; // power
    }
    if (hw.batteries > 0) {
      calls += this.config.storage_details ? 2 : 1;
    }
    return calls;
  }

  /** Requests the once-a-day reads cost on this site. */
  get callsPerDay() {
    return 2 + (this.capabilities?.gridImport ? 1 : 0);
  }

  /**
   * The refresh interval actually used, in seconds: the user's, stretched
   * until a day of cycles fits in the daily share of the monthly credits.
   */
  refreshInterval() {
    const spendable = Math.max(1, this.client.dailyRequestLimit - this.callsPerDay - DAILY_RESERVE);
    const needed = Math.ceil((86_400 * this.callsPerCycle) / spendable);
    return Math.max(this.config.poll_frequency, needed);
  }

  /**
   * Resolve the site to work on: the one configured by the user, or — with a
   * Fleet API key and the field left empty — the single site it covers. An
   * OAuth token cannot list sites, and Gladys does not relay the `site_id`
   * SolarEdge appends to its redirect: the user types it.
   */
  async resolveSiteId() {
    if (this.siteId) {
      return this.siteId;
    }
    if (this.config.site_id) {
      this.siteId = this.config.site_id;
      return this.siteId;
    }
    if (this.client.mode === 'oauth') {
      throw new SolarEdgeError('Fill in the "Site ID" setting.', {
        code: ERROR_CODES.NOT_FOUND,
      });
    }

    const sites = await this.client.getSites();
    if (sites.length === 0) {
      throw new SolarEdgeError('This API key gives access to no site.', {
        code: ERROR_CODES.NOT_FOUND,
      });
    }
    if (sites.length > 1) {
      const ids = sites.map((site) => site.siteId).join(', ');
      throw new SolarEdgeError(
        `This API key gives access to ${sites.length} sites (${ids}): fill in the "Site ID" setting.`,
        { code: ERROR_CODES.NOT_FOUND },
      );
    }
    this.siteId = String(sites[0].siteId);
    logger.info(`Site auto-detected: ${sites[0].name} (${this.siteId})`);
    return this.siteId;
  }

  /** Site details, fetched once (name, timezone, peak power). */
  async getSite() {
    if (this.site) {
      return this.site;
    }
    const siteId = await this.resolveSiteId();
    this.site = parseSiteDetails(await this.client.getSiteDetails(siteId));
    return this.site;
  }

  /** Sites reachable with the Fleet API key (the "List my sites" action). */
  async listSites() {
    if (this.client.mode === 'oauth') {
      // An authorization covers exactly one site: say which.
      const site = await this.getSite();
      return [{ siteId: site.id ?? this.siteId, name: site.name }];
    }
    return this.client.getSites();
  }

  /**
   * The meters and batteries of the site. A failure (an OAuth app authorized
   * without the DEVICE_DATA scope answers 403) falls back to "inverter only":
   * production still works, and the next scan probes again.
   */
  async #getHardware({ force = false } = {}) {
    if (this.hardware && !force) {
      return this.hardware;
    }
    const siteId = await this.resolveSiteId();
    try {
      const hardware = parseDevices(await this.client.getDevices(siteId, ['METER', 'BATTERY']));
      // Hardware does not leave between two probes of the same process.
      const seen = this.hardware ?? { meters: 0, productionMeter: false, batteries: 0 };
      this.hardware = {
        meters: Math.max(seen.meters, hardware.meters),
        productionMeter: seen.productionMeter || hardware.productionMeter,
        batteries: Math.max(seen.batteries, hardware.batteries),
      };
      this.#recovered('devices');
    } catch (err) {
      if (err?.code === ERROR_CODES.RECONNECT || err?.code === ERROR_CODES.QUOTA_EXCEEDED) {
        throw err;
      }
      this.#failed('devices', err);
      this.hardware ??= { meters: 0, productionMeter: false, batteries: 0 };
    }
    return this.hardware;
  }

  /**
   * What this installation can actually feed, derived from a real snapshot:
   * a NUMBER for the home or grid power, a battery reading. Presence of a
   * meter in the inventory alone proves nothing.
   */
  async getCapabilities({ force = false } = {}) {
    if (this.capabilities && !force) {
      return this.capabilities;
    }
    await this.getSite();
    await this.#getHardware({ force });
    const snapshot = await this.getSnapshot({ force: true });
    const { flow, energy } = snapshot;

    const seen = this.capabilities ?? {};
    const grid = seen.grid || hasValue(flow?.grid);
    this.capabilities = {
      // A SolarEdge site always produces: the production device is the floor.
      production: true,
      consumption: seen.consumption || hasValue(flow?.load),
      grid,
      battery: seen.battery || Boolean(flow?.battery),
      // The grid import index reads the meter's onboard import counter.
      gridImport: seen.gridImport || (grid && hasValue(energy?.purchased)),
      // V2 reports no revenue at all: the feature is gone with V1.
      revenue: false,
    };
    logger.info(`Capabilities detected: ${JSON.stringify(this.capabilities)}`);
    return this.capabilities;
  }

  /**
   * The shared snapshot. Returns the cached one while it is fresh enough for
   * the refresh interval, and never runs two refreshes at once.
   *
   * @param {{force?: boolean}} [options] `force: true` bypasses the freshness
   *   check (used by the capability probe and the "Refresh now" action)
   */
  async getSnapshot({ force = false } = {}) {
    const age = this.now().getTime() - this.snapshotAt;
    // 80% of the interval: short enough that the next cycle really refreshes,
    // long enough that the devices of one cycle share a single read.
    const ttl = Math.max(30, this.refreshInterval() * 0.8) * 1000;
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
    const hardware = await this.#getHardware();
    const timeZone = site?.location?.timeZone;
    const now = this.now();
    const window = {
      from: isoInstant(new Date(now.getTime() - LIVE_WINDOW_MS)),
      to: isoInstant(now),
    };

    // Today's balance is the backbone of the cycle: without it there is no
    // reading worth publishing, so its failure fails the cycle and the
    // devices report themselves unreachable.
    const energy = parseOverview(await this.client.getOverview(siteId));
    this.#recovered('overview');
    const day = siteDay(now, timeZone);

    const meters =
      hardware.meters > 0
        ? await this.#optional('meters/telemetry', () =>
            this.client.getMetersTelemetry(siteId, window),
          ).then((body) => (body ? parseMetersTelemetry(body) : null))
        : null;
    let pv = meters?.pv ?? null;
    if (pv === null) {
      const body = await this.#optional('power', () => this.client.getPower(siteId, window));
      // A sleeping inverter (night) sends nothing: its buckets come back
      // `null`. No data from the inverter means no production — and a power
      // stuck on the last daylight value all night would be worse.
      pv = body ? (parsePower(body) ?? 0) : (this.snapshot?.flow?.pv ?? null);
    }

    let battery = null;
    let storage = null;
    if (hardware.batteries > 0) {
      const body = await this.#optional('storage/telemetry', () =>
        this.client.getStorageTelemetry(siteId, window),
      );
      battery = body ? parseStorageTelemetry(body) : (this.snapshot?.flow?.battery ?? null);
      let temperature = null;
      if (this.config.storage_details && battery) {
        const status = await this.#optional('storage/status', () =>
          this.client.getStorageStatus(siteId, window),
        );
        temperature = status
          ? parseStorageStatus(status)
          : (this.snapshot?.storage?.temperature ?? null);
      }
      if (battery) {
        storage = { level: battery.level, energyStored: battery.energyStored, temperature };
      }
    }

    const flow = {
      pv,
      load: meters?.load ?? (hardware.meters > 0 ? (this.snapshot?.flow?.load ?? null) : null),
      grid: meters?.grid ?? (hardware.meters > 0 ? (this.snapshot?.flow?.grid ?? null) : null),
      battery,
    };

    await this.#refreshDaily(siteId, day, now, energy);
    const overview = this.#overview(energy);
    const gridImportIndex = this.#gridImportIndex(energy);

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

  /** A secondary read: its failure keeps the cycle (and is logged once). */
  async #optional(endpoint, call) {
    try {
      const body = await call();
      this.#recovered(endpoint);
      return body;
    } catch (err) {
      if (err?.code === ERROR_CODES.RECONNECT) {
        throw err;
      }
      this.#failed(endpoint, err);
      return null;
    }
  }

  /**
   * The once-a-day reads, stored as BASES: the value minus today's figure read
   * in the same cycle. `base + today` then follows the day for free:
   *
   *     month    = (month production at the read - today at the read) + today
   *     lifetime = (lifetime counter at the read  - today at the read) + today
   *     import   = (import counter at the read    - imported today)   + imported today
   *
   * Tied to the site day of the overview: the overview restarts at the
   * site's midnight, and so do the bases.
   */
  async #refreshDaily(siteId, day, now, energy) {
    if (now.getTime() - this.dailyFailedAt < DAILY_RETRY_MS) {
      return;
    }
    try {
      if (this.daily?.day !== day) {
        const today = energy?.production;
        if (!hasValue(today)) {
          return;
        }
        // From a day before January 1 (UTC), so the site's local January is
        // covered whatever its offset; parseMonthlyEnergy keeps this year only.
        const monthly = parseMonthlyEnergy(
          await this.client.getEnergy(siteId, {
            from: `${addDays(`${day.slice(0, 4)}-01-01`, -1)}T00:00:00Z`,
            to: isoInstant(now),
            resolution: 'MONTH',
          }),
          day,
        );
        const lifetime = parseLifetimeEnergy(await this.client.getLifetimeEnergy(siteId));
        this.daily = {
          day,
          month: baseOf(monthly.month, today),
          year: baseOf(monthly.year, today),
          lifetime: baseOf(lifetime, today),
          import: null,
          importRead: false,
        };
      }
      // Read on its own: the capability is only known after the first cycle
      // of the detection, which already took the other daily totals.
      if (this.capabilities?.gridImport && !this.daily.importRead && hasValue(energy?.purchased)) {
        const counter = parseImportCounter(
          await this.client.getMetersLifetimeEnergy(siteId, {
            from: isoInstant(new Date(now.getTime() - LIVE_WINDOW_MS)),
            to: isoInstant(now),
            meters: ['PURCHASED'],
          }),
        );
        this.daily.import = baseOf(counter, energy.purchased);
        this.daily.importRead = true;
      }
      this.dailyFailedAt = 0;
      this.#recovered('daily totals');
    } catch (err) {
      if (err?.code === ERROR_CODES.RECONNECT) {
        throw err;
      }
      this.dailyFailedAt = now.getTime();
      this.#failed('daily totals', err);
    }
  }

  /** The production totals the devices and the widgets read. */
  #overview(energy) {
    const today = energy?.production ?? null;
    const plus = (base) => (hasValue(base) && hasValue(today) ? round(base + today, 2) : null);
    const lifetime = plus(this.daily?.lifetime);
    if (lifetime !== null) {
      // An index never goes backwards: a counter read a little late in the
      // morning must not read as a reset.
      this.lifetimeIndex = Math.max(this.lifetimeIndex ?? 0, lifetime);
    }
    return {
      currentPower: null,
      energyToday: today,
      energyMonth: plus(this.daily?.month),
      energyYear: plus(this.daily?.year),
      energyLifetime: this.lifetimeIndex,
      revenueToday: null,
      revenueLifetime: null,
    };
  }

  /**
   * The grid import INDEX: every kWh the meter counted from the grid, never
   * going down — or `null` without a meter reading.
   *
   * Why: the Gladys energy module (30-minute consumption, cost) only reads a
   * cumulative consumption index, and what a metered site pays its supplier is
   * the energy PURCHASED from the grid — not the house consumption, which
   * includes the free self-consumed solar.
   */
  #gridImportIndex(energy) {
    const base = this.daily?.import;
    if (!hasValue(base) || !hasValue(energy?.purchased)) {
      return null;
    }
    this.importIndex = Math.max(this.importIndex ?? 0, round(base + energy.purchased, 2));
    return this.importIndex;
  }

  /** A partial failure: logged once until the endpoint answers again. */
  #failed(endpoint, err) {
    const message = `SolarEdge ${endpoint} failed: ${err?.message ?? err}`;
    if (this.failing.has(endpoint)) {
      logger.debug(message);
      return;
    }
    this.failing.add(endpoint);
    logger.warn(message);
  }

  /** The recovery line matching the single failure line above. */
  #recovered(endpoint) {
    if (this.failing.delete(endpoint)) {
      logger.info(`SolarEdge ${endpoint} answers again`);
    }
  }
}

/** `value - today`, or `null` when either is missing. */
function baseOf(value, today) {
  return hasValue(value) && hasValue(today) ? round(value - today, 2) : null;
}

/** A real number, as opposed to "SolarEdge did not report this". 0 counts. */
function hasValue(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
