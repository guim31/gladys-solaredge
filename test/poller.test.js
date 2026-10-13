// -----------------------------------------------------------------------------
// The internal polling timer (src/poller.js): the states reach Gladys without
// a single `onPoll` from the core (GladysAssistant/Gladys#3198), without an
// extra SolarEdge request, and without a line at `info` on a normal cycle.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { SolarEdgeService } from '../src/solaredge/service.js';
import { SnapshotPublisher } from '../src/publisher.js';
import { SnapshotPoller } from '../src/poller.js';
import { buildDiscoveredDevices, findBlueprintByDevice } from '../src/devices/index.js';
import { createFakeGladys, stateOf } from './helpers/fakeGladys.js';
import { createFakeClient } from './helpers/solaredgeFixtures.js';

const INTERVAL_MS = 900_000;

async function setUp() {
  const config = normalizeConfig({ api_key: 'K' });
  const clock = { now: new Date('2024-05-18T13:42:00Z') };
  const client = createFakeClient();
  const service = new SolarEdgeService(config, { client, now: () => clock.now });
  const capabilities = await service.getCapabilities();
  const context = {
    config,
    siteId: await service.resolveSiteId(),
    site: await service.getSite(),
    capabilities,
  };
  const gladys = createFakeGladys();
  // What the SDK keeps in `gladys.devices`: the devices the user created.
  const devices = buildDiscoveredDevices(gladys, context);
  gladys.devices = devices;
  const publisher = new SnapshotPublisher(gladys);
  const health = [];
  const poller = new SnapshotPoller(gladys, publisher, () => ({ context, service }), {
    onSuccess: (snapshot) => health.push({ ok: snapshot.fetchedAt }),
    onError: (err) => health.push({ error: err.message }),
  });
  return { config, clock, client, service, context, gladys, devices, publisher, poller, health };
}

/** Let the async work of a timer callback settle (setImmediate is not mocked). */
async function settle() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const liveReads = (client) => client.calls.filter((name) => name === 'flow').length;

test('the timer publishes every created device without any onPoll from Gladys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, gladys, devices, poller, health } = await setUp();
  // Nothing in this test registers or calls an onPoll handler: the timer
  // alone must deliver the states.
  const readsAtBootstrap = liveReads(client);

  poller.start(INTERVAL_MS);
  t.mock.timers.tick(0);
  await settle();

  assert.equal(devices.length, 4, 'production, consumption, grid, battery');
  assert.equal(stateOf(gladys, 'power'), 4200, 'production power, 4.2 kW in the fixture');
  assert.ok(gladys.published.some((s) => s.featureExternalId.includes('solaredge-battery')));
  assert.ok(gladys.published.some((s) => s.featureExternalId.includes('solaredge-grid')));
  assert.ok(gladys.published.some((s) => s.featureExternalId.includes('solaredge-consumption')));
  assert.equal(liveReads(client), readsAtBootstrap, 'the bootstrap snapshot is still fresh');
  assert.equal(health.length, 1);
  assert.ok(poller.running);

  poller.stop();
  assert.equal(poller.running, false);
});

test('the next cycle reads SolarEdge once for all devices, and onPoll then adds nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { clock, client, service, context, gladys, devices, publisher, poller } = await setUp();
  poller.start(INTERVAL_MS);
  t.mock.timers.tick(0);
  await settle();
  const readsBefore = liveReads(client);
  const publishedBefore = gladys.published.length;

  clock.now = new Date(clock.now.getTime() + INTERVAL_MS);
  t.mock.timers.tick(INTERVAL_MS);
  await settle();

  assert.equal(liveReads(client), readsBefore + 1, 'one refresh shared by the four devices');
  assert.ok(gladys.published.length > publishedBefore, 'the new reading is published');

  // The core's onPoll, when it does run (devices created with should_poll),
  // reads the same cached snapshot and finds it already published.
  const afterTimer = gladys.published.length;
  for (const device of devices) {
    const blueprint = findBlueprintByDevice(gladys, context, device);
    const snapshot = await service.getSnapshot();
    assert.equal(await publisher.tick(blueprint, context, device, snapshot), false);
  }
  assert.equal(liveReads(client), readsBefore + 1, 'no extra SolarEdge request');
  assert.equal(gladys.published.length, afterTimer, 'no duplicate state');
  poller.stop();
});

test('no device created in Gladys: the timer costs no SolarEdge request', async () => {
  const { client, gladys, clock, poller } = await setUp();
  gladys.devices = [];
  clock.now = new Date(clock.now.getTime() + INTERVAL_MS);
  const calls = client.calls.length;

  assert.equal(await poller.runOnce(), 0);
  assert.equal(client.calls.length, calls);
  assert.equal(gladys.published.length, 0);
});

test('a device created later gets the current reading at once', async () => {
  const { client, gladys, devices, poller } = await setUp();
  gladys.devices = [devices[0]];
  assert.equal(await poller.runOnce(), 1);
  const calls = client.calls.length;

  // onDeviceCreated in index.js: a cycle on the cached snapshot.
  gladys.devices = devices;
  assert.equal(await poller.runOnce(), 3, 'the three new devices, not the first one again');
  assert.equal(client.calls.length, calls, 'from the cache');
});

test('an updated device gets the same reading again once forgotten', async () => {
  const { client, gladys, devices, publisher, poller } = await setUp();
  assert.equal(await poller.runOnce(), 4);
  assert.equal(await poller.runOnce(), 0, 'already published');
  const calls = client.calls.length;

  // onDeviceUpdated in index.js ("Update" may have added features).
  publisher.forget(devices[0].external_id);
  const before = gladys.published.length;
  assert.equal(await poller.runOnce(), 1, 'only the updated device');
  assert.ok(gladys.published.length > before);
  assert.equal(client.calls.length, calls, 'from the cache');
});

test('overlapping cycles never publish the same reading twice', async () => {
  const { gladys, poller } = await setUp();
  const results = await Promise.all([poller.runOnce(), poller.runOnce(), poller.runOnce()]);
  assert.deepEqual(results, [4, 0, 0]);
  const ids = gladys.published.map((s) => s.featureExternalId);
  assert.equal(new Set(ids).size, ids.length, 'no feature published twice');
});

test('restarting the timer during a slow cycle keeps a single chain', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { poller } = await setUp();
  let cycles = 0;
  let release;
  poller.runOnce = () => {
    cycles += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  };

  poller.start(INTERVAL_MS);
  t.mock.timers.tick(0); // cycle 1 starts and hangs
  poller.start(INTERVAL_MS); // a bootstrap restarts the timer meanwhile
  t.mock.timers.tick(0); // cycle 2, from the new chain
  release();
  await settle(); // cycle 1 ends: its stale chain must not reschedule
  assert.equal(cycles, 2);

  release();
  await settle();
  t.mock.timers.tick(INTERVAL_MS);
  await settle();
  assert.equal(cycles, 3, 'one cycle per interval, not two');
  poller.stop();
});

test('the interval has a floor: a bad setting cannot make a busy loop', async () => {
  const { poller } = await setUp();
  poller.start(0);
  assert.equal(poller.intervalMs, 60_000);
  poller.stop();
});

test('a failed cycle reports the error and keeps the timer alive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { clock, client, poller, health } = await setUp();
  client.getCurrentPowerFlow = () => Promise.reject(new Error('down'));
  client.getOverview = () => Promise.reject(new Error('down'));
  clock.now = new Date(clock.now.getTime() + INTERVAL_MS);

  poller.start(INTERVAL_MS);
  t.mock.timers.tick(0);
  await settle();
  assert.deepEqual(health, [{ error: 'down' }]);
  assert.ok(poller.running, 'the next cycle is scheduled');
  poller.stop();
});

test('a normal cycle writes nothing at info level', async (t) => {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  t.after(() => {
    if (previousLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = previousLevel;
    }
  });
  const { clock, poller } = await setUp();

  const out = t.mock.method(console, 'log', () => {});
  const err = t.mock.method(console, 'error', () => {});
  // Two cycles: one that refreshes SolarEdge, one served from the cache.
  clock.now = new Date(clock.now.getTime() + INTERVAL_MS);
  assert.equal(await poller.runOnce(), 4);
  clock.now = new Date(clock.now.getTime() + 60_000);
  assert.equal(await poller.runOnce(), 0);

  assert.deepEqual(
    out.mock.calls.map((c) => c.arguments.join(' ')),
    [],
  );
  assert.deepEqual(
    err.mock.calls.map((c) => c.arguments.join(' ')),
    [],
  );
});

test('a failing SolarEdge endpoint is logged once, and its recovery once', async (t) => {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  t.after(() => {
    if (previousLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = previousLevel;
    }
  });
  const { clock, client, poller } = await setUp();
  const realOverview = client.getOverview;
  client.getOverview = () => Promise.reject(new Error('HTTP 500'));

  const out = t.mock.method(console, 'log', () => {});
  const err = t.mock.method(console, 'error', () => {});
  for (let i = 0; i < 3; i += 1) {
    clock.now = new Date(clock.now.getTime() + INTERVAL_MS);
    await poller.runOnce();
  }
  const warnings = err.mock.calls.map((c) => c.arguments.join(' '));
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /overview failed: HTTP 500/);

  client.getOverview = realOverview;
  clock.now = new Date(clock.now.getTime() + INTERVAL_MS);
  await poller.runOnce();
  const infos = out.mock.calls.map((c) => c.arguments.join(' '));
  assert.equal(infos.length, 1, infos.join('\n'));
  assert.match(infos[0], /overview answers again/);
});
