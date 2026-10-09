// -----------------------------------------------------------------------------
// When a snapshot reaches Gladys: ticks skip what a device already published,
// and a forced refresh never counts as published.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotPublisher } from '../src/publisher.js';
import { findBlueprintByDevice } from '../src/devices/index.js';
import { normalizeConfig } from '../src/config.js';
import { SolarEdgeService } from '../src/solaredge/service.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createInverterOnlyClient } from './helpers/solaredgeFixtures.js';

async function setUp() {
  const config = normalizeConfig({ api_key: 'K' });
  const service = new SolarEdgeService(config, {
    client: createInverterOnlyClient(),
    now: () => new Date('2026-10-09T13:15:10Z'),
  });
  const capabilities = await service.getCapabilities();
  const context = {
    config,
    siteId: await service.resolveSiteId(),
    site: await service.getSite(),
    capabilities,
  };
  const gladys = createFakeGladys();
  const device = { external_id: gladys.externalIds('solaredge-production', context.siteId).device };
  const blueprint = findBlueprintByDevice(gladys, context, device);
  return { gladys, publisher: new SnapshotPublisher(gladys), context, device, blueprint, service };
}

test('a tick publishes a snapshot once, then skips it until the next reading', async () => {
  const { gladys, publisher, context, device, blueprint, service } = await setUp();
  const snapshot = await service.getSnapshot();

  assert.equal(await publisher.tick(blueprint, context, device, snapshot), true);
  const afterFirst = gladys.published.length;
  assert.ok(afterFirst > 0);

  assert.equal(await publisher.tick(blueprint, context, device, snapshot), false);
  assert.equal(gladys.published.length, afterFirst, 'an unchanged snapshot writes nothing');

  const next = { ...snapshot, fetchedAt: '2026-10-09T13:30:10.000Z' };
  assert.equal(await publisher.tick(blueprint, context, device, next), true);
});

test('"Refresh now" before the devices are added does not swallow the reading', async () => {
  // The first real install: "Refresh now" at 15:15:10 published the states,
  // the user added the devices at 15:15:20 (Gladys had dropped those states),
  // and 1.1.0 then skipped every tick until the next reading, 12 min later.
  const { gladys, publisher, context, device, blueprint, service } = await setUp();
  const snapshot = await service.getSnapshot({ force: true });

  const published = await publisher.publishAll(context, snapshot);
  assert.equal(published, 3, 'power, today and the lifetime index');

  // The next Gladys tick, on the very same snapshot, publishes it again.
  const before = gladys.published.length;
  assert.equal(await publisher.tick(blueprint, context, device, snapshot), true);
  assert.equal(gladys.published.length, before + 3);
});
