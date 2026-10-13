// -----------------------------------------------------------------------------
// Internal polling timer: the integration publishes its states on its own
// schedule instead of waiting for Gladys to call `onPoll`.
//
// Why: the core only polls an external-integration device created with
// `should_poll: true` AND a valid `poll_frequency` (GladysAssistant/Gladys
// #3198), and both fields are read once, when the user creates the device —
// a later publication never updates a device already created. A device that
// missed them for any reason (created before 1.1.0, re-created by hand, a core
// that changes its rules) would stay on "no recent value" forever. So the
// timer is the source of the states, and `onPoll` stays as a fallback.
//
// Neither path costs an extra SolarEdge request: both read the SHARED snapshot
// (src/solaredge/service.js caches it for 80 % of the refresh interval), and
// both go through the SnapshotPublisher, which publishes a given reading once
// per device whichever path delivers it first.
//
// The timer only serves devices the user actually created (`gladys.devices`,
// kept up to date by the SDK): publishing for a device not added yet would be
// dropped by Gladys and, worse, recorded as published (see src/publisher.js).
// No device created, no SolarEdge request — as before.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { findBlueprintByDevice } from './devices/index.js';

const logger = createLogger({ name: 'poller' });

// Never faster than Gladys's own slowest tick: a bad setting must not turn
// the timer into a busy loop.
export const MIN_INTERVAL_MS = 60_000;

export class SnapshotPoller {
  /**
   * @param {object} gladys the SDK instance (reads `gladys.devices`)
   * @param {import('./publisher.js').SnapshotPublisher} publisher
   * @param {() => ({ context: object|null, service: object|null })} getState
   *   the integration's current context and SolarEdge service
   * @param {object} [hooks]
   * @param {(snapshot: object) => void|Promise<void>} [hooks.onSuccess] after a
   *   cycle that published something (widget nudge, health badge)
   * @param {(err: Error) => void|Promise<void>} [hooks.onError] after a failed cycle
   */
  constructor(gladys, publisher, getState, { onSuccess, onError } = {}) {
    this.gladys = gladys;
    this.publisher = publisher;
    this.getState = getState;
    this.onSuccess = onSuccess;
    this.onError = onError;
    this.timer = null;
    this.intervalMs = 0;
    // Bumped by start/stop: a callback already running when the timer is
    // restarted must not schedule a second chain.
    this.generation = 0;
    // The cycle in progress: cycles run one after the other, so two of them
    // never publish the same reading to the same device.
    this.current = Promise.resolve();
  }

  /** The created devices this installation feeds, with their blueprint. */
  targets(context) {
    return (this.gladys.devices ?? [])
      .map((device) => ({ device, blueprint: findBlueprintByDevice(this.gladys, context, device) }))
      .filter(({ blueprint }) => blueprint?.isAvailable(context.capabilities));
  }

  /**
   * One cycle: read the shared snapshot (a SolarEdge request only when the
   * cached one is stale) and publish it for every created device that has not
   * published it yet.
   * Cycles are serialized: a call made while one runs waits for it.
   * @returns {Promise<number>} the number of devices that published
   */
  runOnce() {
    const run = this.current.then(() => this.#cycle());
    // Keep the chain alive whatever the outcome of this cycle.
    this.current = run.catch(() => {});
    return run;
  }

  async #cycle() {
    const { context, service } = this.getState();
    if (!context || !service) {
      logger.debug('Poll cycle skipped: the integration is not initialized yet');
      return 0;
    }
    const targets = this.targets(context);
    if (targets.length === 0) {
      logger.debug('Poll cycle skipped: no SolarEdge device created in Gladys');
      return 0;
    }

    let snapshot;
    let published = 0;
    try {
      snapshot = await service.getSnapshot();
      for (const { blueprint, device } of targets) {
        if (await this.publisher.tick(blueprint, context, device, snapshot)) {
          published += 1;
        }
      }
    } catch (err) {
      logger.debug(`Poll cycle failed: ${err.message}`);
      await this.onError?.(err);
      return published;
    }
    logger.debug(`Poll cycle: ${published}/${targets.length} device(s) published`);
    if (published > 0) {
      await this.onSuccess?.(snapshot);
    }
    return published;
  }

  /**
   * Start (or restart, for a new interval) the timer. The first cycle runs
   * right away: the snapshot of the bootstrap is still fresh, so it costs no
   * request and the values do not wait a full interval.
   */
  start(intervalMs) {
    this.stop();
    this.intervalMs = Math.max(Number(intervalMs) || 0, MIN_INTERVAL_MS);
    this.#schedule(0, this.generation);
  }

  stop() {
    this.generation += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get running() {
    return this.timer !== null;
  }

  // A chain of timeouts rather than an interval: a slow cycle (SolarEdge
  // answering in 20 s) never overlaps the next one.
  #schedule(delay, generation) {
    this.timer = setTimeout(async () => {
      try {
        await this.runOnce();
      } catch (err) {
        logger.error('Poll cycle crashed', err);
      }
      if (generation === this.generation) {
        this.#schedule(this.intervalMs, generation);
      }
    }, delay);
    // Do not hold the event loop open just for the polling timer.
    this.timer.unref?.();
  }
}
