// -----------------------------------------------------------------------------
// Small helpers shared by the device modules.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

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
 * Category and type of every "energy since midnight" total that is not the
 * production (consumption, self-consumption, imported, exported today).
 *
 * The type decides what the CORE does with the values, not just the label:
 *
 *   - `energy-sensor/energy` and `energy-sensor/index` are cumulative
 *     CONSUMPTION indexes for Gladys (energy-monitoring ENERGY_INDEX_FEATURE_
 *     TYPES): the core adds "(consumption)" and "(cost)" features to each and
 *     bills their deltas as house consumption. Exported energy billed as
 *     consumption, and every midnight reset read as a counter reset — that is
 *     what the first real test showed (Gladys 5.1.4, 2026-10-09).
 *   - `energy-sensor/daily-consumption` is ONE value per day for the core
 *     (Enedis writes one state per day): the weekly digest SUMS its states of
 *     a day (energy-sensor.getConsumptionByDates, SUM(value)). A running total
 *     published every refresh would count ~50 times over.
 *   - `energy-sensor/index-today` is a running total since midnight — what
 *     Tasmota's "Energy Today" publishes — and no core pipeline reads it.
 *
 * It is the only type that says what these values are and that the core
 * leaves alone. Production today keeps `energy-production-sensor/
 * daily-production`, which no pipeline reads either.
 */
export const DAILY_ENERGY = {
  category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
  type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.INDEX_TODAY,
};

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

/**
 * External ids of every feature a device module can declare, keyed by the
 * module's own FEATURE names (`{ POWER: 'ext:...:power', ... }`).
 *
 * Built for the dashboard widgets, which bind their live tiles and charts to
 * published features by external_id. Whether a given feature is actually
 * declared still depends on the capabilities (revenue) and the configuration
 * (storage telemetry): a widget must only bind to the always-declared ones.
 *
 * @param {Record<string, string>} FEATURE the module's feature keys
 * @param {{ feature: (key: string) => string }} ids `gladys.externalIds(...)`
 */
export function mapFeatureIds(FEATURE, ids) {
  return Object.fromEntries(Object.entries(FEATURE).map(([name, key]) => [name, ids.feature(key)]));
}
