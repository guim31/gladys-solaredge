// -----------------------------------------------------------------------------
// When to publish a snapshot to Gladys — the bookkeeping index.js relies on,
// kept here so it can be tested without a running SDK.
//
// Gladys ticks every device every minute (the slowest poll_frequency its enum
// allows), but SolarEdge is only read every "Refresh interval" seconds. Most
// ticks therefore hand back the very same snapshot: re-publishing it would
// write 1440 identical points per feature per day into the history for
// nothing — and the host API rate-limits states at 300/minute. So a tick only
// publishes a snapshot that device has not published yet.
//
// A FORCED refresh ("Refresh now", the widget button) publishes every device
// but records nothing. It can run before the user has added the devices in
// the Discovery tab, and Gladys then drops the states without a word: on the
// first real install, "Refresh now" at 15:15:10 and the devices added at
// 15:15:20 meant no value at all until the next SolarEdge reading, 12 minutes
// later, because the ticks in between saw the snapshot as already published.
// Publishing a reading twice costs one duplicate point; skipping it costs a
// quarter of an hour of empty tiles.
// -----------------------------------------------------------------------------

import { availableBlueprints } from './devices/index.js';

export class SnapshotPublisher {
  /** @param {object} gladys the SDK instance */
  constructor(gladys) {
    this.gladys = gladys;
    // device external_id -> `fetchedAt` of the last snapshot a tick published
    this.lastPublished = new Map();
  }

  /**
   * A Gladys tick for one device: publish the snapshot unless this device
   * already published it on an earlier tick.
   * @returns {Promise<boolean>} whether anything was published
   */
  async tick(blueprint, context, device, snapshot) {
    if (this.lastPublished.get(device.external_id) === snapshot.fetchedAt) {
      return false;
    }
    await blueprint.onPoll(this.gladys, context, snapshot);
    this.lastPublished.set(device.external_id, snapshot.fetchedAt);
    return true;
  }

  /**
   * A forced refresh: every available device, and deliberately NOT recorded
   * (see the header), so the next tick publishes the same snapshot again.
   * @returns {Promise<number>} the number of states published
   */
  async publishAll(context, snapshot) {
    let published = 0;
    for (const blueprint of availableBlueprints(context.capabilities)) {
      const states = await blueprint.onPoll(this.gladys, context, snapshot);
      published += states?.length ?? 0;
    }
    return published;
  }
}
