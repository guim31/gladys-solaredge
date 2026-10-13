// -----------------------------------------------------------------------------
// Entry point of the SolarEdge integration for Gladys Assistant.
//
// Role of this file: wire the SDK to the SolarEdge service and to the device
// catalog. It holds no SolarEdge logic — the API lives in src/solaredge/, the
// device payloads in src/devices/ — only the lifecycle:
//   1. instantiate the SDK (connection, auth, reconnection: handled for you);
//   2. register the event handlers BEFORE connect();
//   3. once connected, bootstrap the site (resolve it, detect what it has,
//      publish the matching devices) and keep retrying until it works;
//   4. publish the states on the integration's own timer (src/poller.js),
//      with Gladys's `onPoll` kept as a fallback;
//   5. serve the dashboard widgets from the snapshot already in memory — a
//      widget never triggers a SolarEdge request (src/widgets.js).
//
// Environment variables injected by the Gladys supervisor:
//   - GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { connectionFingerprint, isConfigured, normalizeConfig } from './src/config.js';
import { SolarEdgeService } from './src/solaredge/service.js';
import { ERROR_CODES, SolarEdgeError } from './src/solaredge/client.js';
import {
  ACTIONS,
  MISSING_KEY_STATUS,
  NOT_CONFIGURED_MESSAGE,
  WIDGET_ACTIONS,
  describeError,
  quotaNearlySpentStatus,
} from './src/actions.js';
import { SnapshotPublisher } from './src/publisher.js';
import { SnapshotPoller } from './src/poller.js';
import {
  WIDGET,
  buildBatteryContent,
  buildEnergyFlowContent,
  buildProductionContent,
  buildUnavailableContent,
  widgetFeatures,
} from './src/widgets.js';
import {
  buildDiscoveredDevices,
  buildTransportEntries,
  findBlueprintByDevice,
} from './src/devices/index.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded through onConfigUpdated).
let config = normalizeConfig();
// The SolarEdge service, rebuilt whenever the credentials change.
let service = null;
// Integration context handed to the device modules once the site is known.
let context = null;
// Retry timer of the bootstrap sequence (see scheduleBootstrapRetry).
let retryTimer = null;
let retryDelay = 0;
// Last transport published, to avoid re-publishing an unchanged badge.
let lastTransportKey = null;
// Which snapshot each device already published on a tick (src/publisher.js).
const publisher = new SnapshotPublisher(gladys);
// The internal polling timer: the source of the states (src/poller.js).
const poller = new SnapshotPoller(gladys, publisher, () => ({ context, service }), {
  onSuccess: async (snapshot) => {
    nudgeWidgets(snapshot);
    await reportHealth(null);
  },
  onError: (err) => reportHealth(err),
});
// Devices `onPoll` already warned about, so an unknown device is one line,
// not one per minute.
const unknownPolledDevices = new Set();
// The last initialization failure logged, so a retry loop failing the same
// way writes one error line, not one per attempt.
let lastBootstrapFailure = null;
// Timestamp of the last snapshot the widgets were nudged for: one nudge per
// SolarEdge reading, not one per device publishing it.
let lastNudgedSnapshot = null;

const RETRY_MIN_DELAY = 60_000;
const RETRY_MAX_DELAY = 1_800_000;
// A spent quota does not heal in a few minutes: it resets at UTC midnight.
const RETRY_QUOTA_DELAY = 3_600_000;
// Requests kept aside for the user's own actions ("Test the connection",
// "Refresh now") so a retry loop can never leave them with nothing to press.
const BUDGET_RESERVE = 12;

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> the Discovery screen asked for the device list');
  try {
    if (context) {
      // Answer from what we already know FIRST: re-publishing is instant and
      // costs zero SolarEdge request, so the Discovery screen fills up even
      // when the re-probe below is slow or fails outright.
      const devices = buildDiscoveredDevices(gladys, context);
      await gladys.publishDiscoveredDevices(devices);
      logger.debug(`Scan answered immediately with ${devices.length} known device(s)`);
    }
    // Then re-probe: a battery or a consumption meter may have been added to
    // the installation since the last detection.
    await bootstrap({ force: true });
  } catch (err) {
    // The SDK only `debug`-logs a scan handler that throws (it sends no ack
    // for SCAN_REQUEST), so an error here is invisible at the default log
    // level. Log it ourselves, or the user gets a silent failure.
    logger.error(`Scan failed: ${err.message}`, err);
  }
});

// --- Polling fallback: Gladys asks to refresh a device -----------------------
// The internal timer (src/poller.js) is what publishes the states: Gladys only
// polls a device created with `should_poll: true` (Gladys#3198). When it does,
// this handler reads the same shared snapshot and the publisher skips what the
// timer already delivered: no extra SolarEdge request, no duplicate state.
gladys.onPoll(async (device) => {
  if (!context) {
    logger.debug('onPoll ignored: the integration is not initialized yet');
    return;
  }
  const blueprint = findBlueprintByDevice(gladys, context, device);
  if (!blueprint) {
    if (!unknownPolledDevices.has(device.external_id)) {
      unknownPolledDevices.add(device.external_id);
      logger.warn(`onPoll ignored: unknown device ${device.external_id}`);
    }
    return;
  }
  if (!blueprint.isAvailable(context.capabilities)) {
    // Created in Gladys by an earlier version, no longer published (a "Grid"
    // device on a site without a meter): nothing to say about it.
    logger.debug(`onPoll ignored: ${device.external_id} is not part of this installation`);
    return;
  }

  try {
    const snapshot = await service.getSnapshot();

    // Most ticks hand back the snapshot this device already published: the
    // publisher skips them (src/publisher.js explains why, and why a forced
    // refresh does not count as published).
    if (!(await publisher.tick(blueprint, context, device, snapshot))) {
      logger.debug(`Tick ignored for ${device.external_id}: snapshot unchanged`);
      return;
    }
    nudgeWidgets(snapshot);
    await reportHealth(null);
  } catch (err) {
    await reportHealth(err);
    // Rethrow: the SDK acknowledges the failure to Gladys instead of letting
    // it believe the refresh went through.
    throw err;
  }
});

// --- A device created or updated from the Discovery tab -----------------------
// Deliver the current reading at once instead of at the next timer cycle. The
// device may hold new features ("Update"), so what it published before is
// forgotten. Reads the cached snapshot: no request while it is fresh.
async function publishToNewDevice(device) {
  publisher.forget(device.external_id);
  await poller.runOnce();
}
gladys.onDeviceCreated(publishToNewDevice);
gladys.onDeviceUpdated(publishToNewDevice);

// --- Manifest actions: buttons in the Configuration screen -------------------
for (const [key, handler] of Object.entries(ACTIONS)) {
  gladys.onAction(key, async (fields) => {
    if (!service) {
      // Resolved, not thrown: a thrown error is a single string, this is multilingual.
      return NOT_CONFIGURED_MESSAGE;
    }
    return handler(gladys, { fields, config, service, refreshAll });
  });
}

// --- Dashboard widgets (Gladys 5.1+) -----------------------------------------
// Pure builders (src/widgets.js) fed with what is already in memory: the
// feature ids of the published devices and the last snapshot. Nothing here
// calls SolarEdge — a dashboard load must never cost a request.
gladys.onWidgetGet(WIDGET.ENERGY_FLOW, async ({ settings }) => {
  const view = widgetView();
  return view ? buildEnergyFlowContent(view, settings) : buildUnavailableContent();
});

gladys.onWidgetGet(WIDGET.PRODUCTION, async ({ settings }) => {
  const view = widgetView();
  return view ? buildProductionContent(view, settings) : buildUnavailableContent();
});

gladys.onWidgetGet(WIDGET.BATTERY, async () => {
  const view = widgetView();
  return view ? buildBatteryContent(view) : buildUnavailableContent();
});

// The "Refresh" button of the energy_flow widget: the only widget action.
gladys.onWidgetAction(WIDGET.ENERGY_FLOW, async (actionKey) => {
  const handler = WIDGET_ACTIONS[actionKey];
  if (!handler) {
    throw new Error(`Unknown widget action: ${actionKey}`);
  }
  if (!service) {
    return NOT_CONFIGURED_MESSAGE;
  }
  return handler(gladys, { config, service, refreshAll });
});

/** What the widget builders need, or `null` before the site is known. */
function widgetView() {
  if (!context) {
    return null;
  }
  return {
    features: widgetFeatures(gladys, context),
    snapshot: service.lastSnapshot,
    currency: config.currency,
    timeZone: context.site?.location?.timeZone,
  };
}

/**
 * Tell the core a new SolarEdge reading landed, so the open dashboards re-pull
 * the status rows now instead of at the end of the content TTL. The live
 * tiles and charts need none of this: they follow the published states.
 */
function nudgeWidgets(snapshot) {
  if (!snapshot || snapshot.fetchedAt === lastNudgedSnapshot) {
    return;
  }
  lastNudgedSnapshot = snapshot.fetchedAt;
  for (const key of Object.values(WIDGET)) {
    try {
      gladys.requestWidgetRefresh(key);
    } catch (err) {
      logger.debug(`Widget nudge skipped for ${key}: ${err.message}`);
    }
  }
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  // A new setting deserves its own error line, even if it fails like the last one.
  lastBootstrapFailure = null;
  const previousFingerprint = connectionFingerprint(config);
  config = normalizeConfig(newConfig);

  if (!service || connectionFingerprint(config) !== previousFingerprint) {
    // The API key or the site changed: everything cached (site details,
    // capabilities, snapshot, request counter) is about another installation.
    service = null;
    context = null;
  } else {
    service.updateConfig(config);
  }
  await bootstrap({ force: true });
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under the `gladys-sdk` name):
// this handler only runs the integration's own initialization.
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
  } catch (err) {
    logger.error('Could not read the configuration', err);
  }
  await bootstrap({ force: true });
});

gladys.on('disconnected', () => {
  cancelBootstrapRetry();
  // Restarted by the bootstrap of the next connection.
  poller.stop();
});

/**
 * Bring the integration to a working state: resolve the SolarEdge site, detect
 * what the installation is made of, publish the matching devices.
 *
 * Failing here is expected (a key not pasted yet, SolarEdge down, quota spent),
 * so a failure is reported to the user and retried in the background instead of
 * killing the integration: without published devices Gladys would never poll,
 * and nothing would ever trigger a second attempt.
 */
async function bootstrap({ force = false } = {}) {
  cancelBootstrapRetry();

  if (!isConfigured(config)) {
    logger.warn('No SolarEdge API key configured yet');
    await setStatus(false, MISSING_KEY_STATUS);
    return;
  }

  if (!service) {
    service = new SolarEdgeService(config);
  }

  // Detecting the installation costs 3 to 4 SolarEdge requests. Retrying that
  // blindly is how a transient failure turns into a permanent one: the retry
  // loop eats the 300/day budget, and then EVERY call fails with a spent quota
  // — including the buttons the user would press to diagnose it.
  const usage = service.usage;
  if (usage.remaining <= BUDGET_RESERVE) {
    logBootstrapFailure(
      'budget',
      `Skipping detection: only ${usage.remaining} SolarEdge request(s) left today`,
      'warn',
    );
    await setStatus(false, quotaNearlySpentStatus(usage));
    scheduleBootstrapRetry({ code: ERROR_CODES.QUOTA_EXCEEDED });
    return;
  }

  try {
    const capabilities = await service.getCapabilities({ force });
    const siteId = await service.resolveSiteId();
    const site = await service.getSite();

    context = { config, siteId, site, capabilities };

    const devices = buildDiscoveredDevices(gladys, context);
    await gladys.publishDiscoveredDevices(devices);
    // Name every device: when the Discovery screen looks empty, these lines are
    // what tell you whether the integration published nothing or Gladys
    // refused what it published.
    logger.info(
      `Published ${devices.length} device(s) for site ${siteId}: ${devices.map((d) => d.name).join(', ')}`,
    );

    if (lastTransportKey && lastTransportKey !== 'ok') {
      logger.info('SolarEdge answers again');
    }
    lastTransportKey = null;
    await reportHealth(null);
    await setStatus(true);
    retryDelay = 0;
    lastBootstrapFailure = null;
    // The states now come from our own timer, at the user's refresh interval.
    poller.start(config.poll_frequency * 1000);
  } catch (err) {
    // `err.code` is the SolarEdge failure class, `err.status` the HTTP status:
    // both matter to tell "bad key" from "quota spent" from "Gladys refused
    // the payload" when reading the logs.
    const failure = `${err.code ?? 'no-code'}${err.status ? ` HTTP ${err.status}` : ''}`;
    logBootstrapFailure(
      failure,
      `Initialization failed [${failure}]: ${err.message}`,
      'error',
      err,
    );
    await setStatus(false, describeError(err));
    scheduleBootstrapRetry(err);
    // A failed re-detection (a reconnection while SolarEdge hiccups) keeps
    // the site known: keep publishing for it in the meantime.
    if (context && !poller.running) {
      poller.start(config.poll_frequency * 1000);
    }
  }
}

/**
 * Log an initialization failure once: the retry loop failing the same way
 * again goes to `debug`. A different failure, or a success in between, logs
 * again.
 */
function logBootstrapFailure(key, message, level, err) {
  if (key === lastBootstrapFailure) {
    logger.debug(message);
    return;
  }
  lastBootstrapFailure = key;
  if (err) {
    logger[level](message, err);
  } else {
    logger[level](message);
  }
}

/**
 * Force a refresh of every device, outside of the polling schedule (the
 * "Refresh now" action). Returns the number of states published.
 */
async function refreshAll() {
  if (!context) {
    await bootstrap({ force: true });
  }
  if (!context) {
    // A coded error: describeError turns it into a multilingual message, for the
    // Configuration screen and for the widget toast alike.
    throw new SolarEdgeError('The integration has not reached SolarEdge yet.', {
      code: ERROR_CODES.NOT_READY,
    });
  }

  const snapshot = await service.getSnapshot({ force: true });
  // Not recorded as published: the devices may not be added in Gladys yet,
  // and the next tick then delivers this reading for real.
  const published = await publisher.publishAll(context, snapshot);
  nudgeWidgets(snapshot);
  await reportHealth(null);
  return published;
}

/**
 * Publish the cloud/unreachable badge of every device — but only when it
 * actually changed, so a healthy integration does not re-post the same badge
 * on every single poll.
 */
async function reportHealth(error) {
  if (!context) {
    return;
  }
  const key = error ? (error.code ?? 'error') : 'ok';
  if (key === lastTransportKey) {
    return;
  }
  // The badge only moves on a change: so do the logs — one line when
  // SolarEdge stops answering, one when it is back, none per cycle.
  if (error) {
    logger.warn(`SolarEdge unreachable [${key}]: ${error.message}`);
  } else if (lastTransportKey && lastTransportKey !== 'ok') {
    logger.info('SolarEdge answers again');
  }
  lastTransportKey = key;

  try {
    await gladys.publishTransports(buildTransportEntries(gladys, context, { error }));
  } catch (err) {
    logger.error('Could not publish the device transports', err);
  }
}

/** Application-level status shown in the Configuration screen. */
async function setStatus(connected, message) {
  try {
    await gladys.setConnectionStatus(connected, message);
  } catch (err) {
    logger.error('Could not publish the connection status', err);
  }
}

/**
 * Retry the bootstrap with an exponential backoff, capped at 30 minutes — and
 * at a full hour when the quota is what failed, since it only resets at UTC
 * midnight and every attempt still spends requests we will need tomorrow.
 *
 * The retry does NOT force a re-probe: forcing would discard capabilities that
 * a concurrent attempt may have just resolved, for no gain.
 */
function scheduleBootstrapRetry(err) {
  const quotaSpent =
    err?.code === ERROR_CODES.QUOTA_EXCEEDED || err?.code === ERROR_CODES.RATE_LIMITED;
  retryDelay = quotaSpent
    ? RETRY_QUOTA_DELAY
    : retryDelay === 0
      ? RETRY_MIN_DELAY
      : Math.min(retryDelay * 2, RETRY_MAX_DELAY);

  logger.debug(`Next initialization attempt in ${Math.round(retryDelay / 60_000)} min`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    bootstrap().catch((retryErr) => logger.error('Retry failed', retryErr));
  }, retryDelay);
  // Do not hold the event loop open just for a retry timer.
  retryTimer.unref?.();
}

function cancelBootstrapRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  cancelBootstrapRetry();
  poller.stop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the SolarEdge integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
