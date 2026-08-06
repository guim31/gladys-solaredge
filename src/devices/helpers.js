// -----------------------------------------------------------------------------
// Small helpers shared by the device modules.
// -----------------------------------------------------------------------------

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
