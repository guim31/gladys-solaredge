// -----------------------------------------------------------------------------
// Small helpers shared by the device modules.
// -----------------------------------------------------------------------------

/**
 * How often Gladys wakes us up for a device, in MILLISECONDS.
 *
 * `poll_frequency` is not a free number: the core validates it against the
 * closed DEVICE_POLL_FREQUENCIES enum (1 s, 2 s, 10 s, 15 s, 30 s, 60 s) and
 * rejects the whole discovery payload otherwise — with, from experience,
 * `devices[0].poll_frequency: invalid poll frequency`. 60 s is the slowest
 * value it accepts.
 *
 * That is NOT the SolarEdge refresh rate. One minute against a budget of 300
 * requests/day would be 1440 calls. Gladys's poll is only a TICK: the shared
 * snapshot (src/solaredge/service.js) decides whether the tick actually costs
 * a SolarEdge request, and the user's "Refresh interval" setting — in seconds
 * — is what drives that. The tick is free; the refresh is not.
 *
 * It must be published TOGETHER with `should_poll: true`. The core schedules a
 * device only when both are set:
 *
 *     // server/lib/device/device.add.js
 *     if (device.should_poll === true && device.poll_frequency) { ... }
 *
 * A device carrying `poll_frequency` alone is accepted by the discovery
 * endpoint, created without complaint, and then simply never polled — every
 * feature stays on "no recent value" forever, with nothing in the logs.
 */
export const GLADYS_POLL_FREQUENCY = 60_000;

/**
 * Build a `publishStates` batch, dropping the features with no value.
 *
 * A missing reading is NOT a zero: a site without a consumption meter, an
 * `energyDetails` refresh that failed, a battery that reports no temperature —
 * publishing 0 for those would draw a flat line in the history and lie to the
 * user. Skipping the entry keeps the last known state instead.
 *
 * @param {Array<[string, number|null|undefined]>} entries `[external_id, value]`
 */
export function buildStates(entries) {
  return entries
    .filter(([, value]) => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(([device_feature_external_id, value]) => ({
      device_feature_external_id,
      state: Number(value),
    }));
}

/**
 * Publish a batch built by `buildStates`, doing nothing when it is empty
 * (an empty POST would be refused by the host API).
 */
export async function publishStates(gladys, entries) {
  const states = buildStates(entries);
  if (states.length > 0) {
    await gladys.publishStates(states);
  }
  return states;
}
