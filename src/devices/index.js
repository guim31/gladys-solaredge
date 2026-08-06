// -----------------------------------------------------------------------------
// Device registry.
//
// Each device lives in its own file and exposes the same shape:
//   - key                             : short identifier (used in logs)
//   - isAvailable(capabilities)       : does THIS installation have it?
//   - deviceExternalId(gladys, ctx)   : the device external_id (for dispatch)
//   - buildDevice(gladys, ctx)        : the discovery payload sent to Gladys
//   - onPoll(gladys, ctx, snapshot)   : publish the states of one refresh
//
// `ctx` (the integration context) carries what every device needs: the
// normalized `config`, the resolved `siteId` and the `site` details. Unlike the
// official template, the device functions receive that context instead of the
// bare config: the external_ids are derived from the SolarEdge site id, which
// can be auto-detected at runtime rather than typed by the user.
//
// `snapshot` is the SHARED reading of the SolarEdge API for the current cycle
// (see src/solaredge/service.js) — devices never call the API themselves.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { production } from './production.js';
import { consumption } from './consumption.js';
import { grid } from './grid.js';
import { battery } from './battery.js';

export const DEVICE_BLUEPRINTS = [production, consumption, grid, battery];

/** The blueprints this installation can actually feed. */
export function availableBlueprints(capabilities) {
  return DEVICE_BLUEPRINTS.filter((bp) => bp.isAvailable(capabilities));
}

/** Build the discovery payload for Gladys (all the available devices). */
export function buildDiscoveredDevices(gladys, context) {
  return availableBlueprints(context.capabilities).map((bp) => bp.buildDevice(gladys, context));
}

/**
 * Find the blueprint that owns a device, from its external_id — used to route
 * `onPoll` to the right module.
 */
export function findBlueprintByDevice(gladys, context, device) {
  return DEVICE_BLUEPRINTS.find(
    (bp) => bp.deviceExternalId(gladys, context) === device.external_id,
  );
}

/**
 * Build the `publishTransports` payload.
 *
 * Every device of this integration is reached through the SolarEdge cloud (the
 * manifest declares `"transports": ["cloud"]`), so the badge is not about
 * choosing a channel: it is about telling the user, on the device cards
 * themselves, that the cloud is currently answering — or why it is not.
 *
 * @param {object} health `{ error }` — the last refresh error, if any
 */
export function buildTransportEntries(gladys, context, health = {}) {
  const entry = transportFor(health);
  return availableBlueprints(context.capabilities).map((bp) => ({
    external_id: bp.deviceExternalId(gladys, context),
    ...entry,
  }));
}

function transportFor({ error }) {
  if (!error) {
    // No `degraded` flag: publishing a nominal entry also CLEARS a previously
    // published degraded state, so recovering needs no special case.
    return { transport: DEVICE_TRANSPORTS.CLOUD };
  }
  if (error.code === 'quota_exceeded' || error.code === 'rate_limited') {
    // The data is still there, just older than it should be: the values keep
    // their meaning, so the badge stays "cloud" with a degraded marker.
    return {
      transport: DEVICE_TRANSPORTS.CLOUD,
      degraded: true,
      message: {
        en: 'SolarEdge daily request quota reached: values refresh again tomorrow.',
        fr: 'Quota de requêtes SolarEdge atteint : les valeurs repartiront demain.',
      },
    };
  }
  return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
}
