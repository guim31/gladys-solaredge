// -----------------------------------------------------------------------------
// Entry point of the SolarEdge integration for Gladys Assistant.
//
// Role of this file: wire the SDK to the SolarEdge service and to the device
// catalog. It holds no SolarEdge logic — the API lives in src/solaredge/, the
// device payloads in src/devices/ — only the lifecycle:
//   1. instantiate the SDK (connection, auth, reconnection: handled for you);
//   2. register the event handlers BEFORE connect();
//   3. once connected, bootstrap the site (resolve it, detect what it has,
//      publish the matching devices) and keep retrying until it works.
//
// Environment variables injected by the Gladys supervisor:
//   - GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { connectionFingerprint, isConfigured, normalizeConfig } from './src/config.js';
import { SolarEdgeService } from './src/solaredge/service.js';
import { ERROR_CODES } from './src/solaredge/client.js';
import { ACTIONS } from './src/actions.js';
import {
  availableBlueprints,
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

const RETRY_MIN_DELAY = 30_000;
const RETRY_MAX_DELAY = 300_000;

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> re-detecting the installation');
  // A scan is the user's explicit "try again": re-probe rather than trusting
  // the capabilities cached at startup (a battery may have been added since).
  await bootstrap({ force: true });
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// Every device polls on its own schedule, but they all read ONE snapshot: the
// first device of a cycle triggers the SolarEdge calls, the others reuse them.
gladys.onPoll(async (device) => {
  if (!context) {
    logger.debug('onPoll ignored: the integration is not initialized yet');
    return;
  }
  const blueprint = findBlueprintByDevice(gladys, context, device);
  if (!blueprint) {
    logger.warn(`onPoll ignored: unknown device ${device.external_id}`);
    return;
  }

  try {
    const snapshot = await service.getSnapshot();
    await blueprint.onPoll(gladys, context, snapshot);
    await reportHealth(null);
  } catch (err) {
    await reportHealth(err);
    // Rethrow: the SDK acknowledges the failure to Gladys instead of letting
    // it believe the refresh went through.
    throw err;
  }
});

// --- Manifest actions: buttons in the Configuration screen -------------------
for (const [key, handler] of Object.entries(ACTIONS)) {
  gladys.onAction(key, async (fields) => {
    if (!service) {
      throw new Error("L'intégration n'est pas configurée : renseignez votre clé d'API SolarEdge.");
    }
    return handler(gladys, { fields, config, service, refreshAll });
  });
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
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
    await setStatus(false, {
      en: 'Paste your SolarEdge Monitoring API key in the settings above.',
      fr: "Renseignez votre clé d'API SolarEdge Monitoring dans les réglages ci-dessus.",
    });
    return;
  }

  try {
    if (!service) {
      service = new SolarEdgeService(config);
    }
    const capabilities = await service.getCapabilities({ force });
    const siteId = await service.resolveSiteId();
    const site = await service.getSite();

    context = { config, siteId, site, capabilities };

    const devices = buildDiscoveredDevices(gladys, context);
    await gladys.publishDiscoveredDevices(devices);
    logger.info(`${devices.length} device(s) published for site ${siteId}`);

    lastTransportKey = null;
    await reportHealth(null);
    await setStatus(true);
    retryDelay = 0;
  } catch (err) {
    logger.error(`Initialization failed: ${err.message}`);
    await setStatus(false, describeError(err));
    scheduleBootstrapRetry();
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
    throw new Error("L'intégration n'a pas encore pu joindre SolarEdge.");
  }

  const snapshot = await service.getSnapshot({ force: true });
  let published = 0;
  for (const blueprint of availableBlueprints(context.capabilities)) {
    const states = await blueprint.onPoll(gladys, context, snapshot);
    published += states?.length ?? 0;
  }
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

/** Turn a SolarEdge failure into something the user can act on. */
function describeError(err) {
  switch (err?.code) {
    case ERROR_CODES.UNAUTHORIZED:
      return {
        en: 'SolarEdge refused the API key: check it in the monitoring portal (Admin > Site Access).',
        fr: "SolarEdge a refusé la clé d'API : vérifiez-la dans le portail de supervision (Admin > Accès au site).",
      };
    case ERROR_CODES.NOT_FOUND:
      return {
        en: `SolarEdge could not resolve the site: ${err.message}`,
        fr: `Site SolarEdge introuvable : ${err.message}`,
      };
    case ERROR_CODES.QUOTA_EXCEEDED:
    case ERROR_CODES.RATE_LIMITED:
      return {
        en: 'SolarEdge daily request quota reached: increase the refresh interval, retry tomorrow.',
        fr: "Quota de requêtes SolarEdge atteint : augmentez l'intervalle de rafraîchissement et réessayez demain.",
      };
    default:
      return {
        en: `Could not reach SolarEdge: ${err?.message ?? 'unknown error'}`,
        fr: `Impossible de joindre SolarEdge : ${err?.message ?? 'erreur inconnue'}`,
      };
  }
}

/** Retry the bootstrap with an exponential backoff, capped at 5 minutes. */
function scheduleBootstrapRetry() {
  retryDelay = retryDelay === 0 ? RETRY_MIN_DELAY : Math.min(retryDelay * 2, RETRY_MAX_DELAY);
  logger.info(`Next initialization attempt in ${Math.round(retryDelay / 1000)}s`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    bootstrap({ force: true }).catch((err) => logger.error('Retry failed', err));
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
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the SolarEdge integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
