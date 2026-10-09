// -----------------------------------------------------------------------------
// The first real site: an SE3000H inverter alone, no meter, no battery, no
// tariff (answers of 2026-10-09, anonymized in the fixtures).
//
// Version 1.1.0 created a "Grid" device stuck at 0 W and a "Revenue today"
// feature that never held a value on this site, because it tested whether
// GRID and `revenue` were PRESENT in the answers, not whether they carried a
// reading. These tests run the real service, devices and widget builders on
// those answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from '../src/config.js';
import { SolarEdgeService } from '../src/solaredge/service.js';
import { availableBlueprints, buildDiscoveredDevices } from '../src/devices/index.js';
import {
  buildBatteryContent,
  buildEnergyFlowContent,
  buildProductionContent,
  widgetFeatures,
} from '../src/widgets.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  INVERTER_ONLY_INVENTORY,
  INVERTER_ONLY_SITE_DETAILS,
  createInverterOnlyClient,
} from './helpers/solaredgeFixtures.js';

/** The integration as index.js wires it, on the inverter-only answers. */
async function bootInverterOnlySite() {
  const config = normalizeConfig({ api_key: 'K' });
  const client = createInverterOnlyClient();
  const service = new SolarEdgeService(config, {
    client,
    // 19:10 in Paris, a few minutes after the overview's lastUpdateTime.
    now: () => new Date('2026-10-09T17:10:00Z'),
  });
  const capabilities = await service.getCapabilities();
  const siteId = await service.resolveSiteId();
  const site = await service.getSite();
  const context = { config, siteId, site, capabilities };
  const gladys = createFakeGladys();
  return { service, client, context, gladys };
}

test('inverter alone: only the production device, no grid, no revenue', async () => {
  const { context, gladys } = await bootInverterOnlySite();

  assert.deepEqual(context.capabilities, {
    production: true,
    consumption: false,
    grid: false,
    battery: false,
    gridImport: false,
    revenue: false,
  });

  const devices = buildDiscoveredDevices(gladys, context);
  assert.deepEqual(
    devices.map((d) => d.name),
    ['SolarEdge — Production solaire'],
  );
  assert.deepEqual(
    devices[0].features.map((f) => [f.name, f.category, f.type]),
    [
      ['Puissance produite', 'energy-sensor', 'power'],
      ['Production du jour', 'energy-production-sensor', 'daily-production'],
      ['Production totale', 'energy-production-sensor', 'index'],
    ],
  );
});

test('inverter alone: the detection agrees with the inventory, without calling it', async () => {
  const { context, client } = await bootInverterOnlySite();
  // The inventory says no meter and no battery: the answers we already pay
  // for (flow, overview, energyDetails) are enough to reach the same verdict.
  assert.equal(INVERTER_ONLY_INVENTORY.meters.length, 0);
  assert.equal(INVERTER_ONLY_INVENTORY.batteries.length, 0);
  assert.equal(context.capabilities.grid || context.capabilities.consumption, false);
  assert.equal(context.capabilities.battery, false);
  assert.deepEqual(client.calls.sort(), ['details', 'energy', 'flow', 'overview', 'sites']);
});

test('inverter alone: the GRID and LOAD slots without a reading are null, not 0 W', async () => {
  const { service } = await bootInverterOnlySite();
  const { flow, energy } = await service.getSnapshot();

  assert.equal(flow.pv, 0, 'an idle inverter at night does read 0 W');
  assert.equal(flow.load, null);
  assert.equal(flow.grid, null);
  assert.deepEqual(energy, {
    production: 9.84,
    consumption: null,
    selfConsumption: null,
    feedIn: null,
    purchased: null,
  });
});

test('inverter alone: a poll publishes power, today and the lifetime index — nothing else', async () => {
  const { service, context, gladys } = await bootInverterOnlySite();
  const snapshot = await service.getSnapshot();
  for (const blueprint of availableBlueprints(context.capabilities)) {
    await blueprint.onPoll(gladys, context, snapshot);
  }

  const ids = `ext:solaredge:solaredge-production:${INVERTER_ONLY_SITE_DETAILS.id}`;
  assert.deepEqual(gladys.published, [
    { featureExternalId: `${ids}:power`, state: 0 },
    { featureExternalId: `${ids}:energy-today`, state: 9.84 },
    { featureExternalId: `${ids}:energy-total`, state: 26618.84 },
  ]);
});

test('inverter alone: the three widgets are valid and show what the site has', async () => {
  const { service, context, gladys } = await bootInverterOnlySite();
  const view = {
    features: widgetFeatures(gladys, context),
    snapshot: service.lastSnapshot,
    currency: context.config.currency,
    timeZone: context.site.location.timeZone,
  };
  const declared = new Set(
    buildDiscoveredDevices(gladys, context).flatMap((d) => d.features.map((f) => f.external_id)),
  );
  const assertValid = (content) => {
    assert.deepEqual(validateWidgetContent(content), []);
    for (const c of content.components) {
      for (const id of [c.device_feature, ...(c.device_features ?? [])].filter(Boolean)) {
        assert.ok(declared.has(id), `bound to an undeclared feature: ${id}`);
      }
    }
  };

  const flow = buildEnergyFlowContent(view, {});
  assertValid(flow);
  assert.deepEqual(
    flow.components.filter((c) => c.type === 'value').map((c) => c.label.fr),
    ['Production'],
    'no grid tile on a site without a meter',
  );
  const balance = flow.components.find((c) => c.type === 'status');
  assert.deepEqual(
    balance.items.map((i) => [i.label.fr, i.value.fr]),
    [['Production du jour', '9,84 kWh']],
    'no consumption, exchange or revenue row: SolarEdge gave none',
  );

  const production = buildProductionContent(view, {});
  assertValid(production);
  assert.deepEqual(
    production.components
      .filter((c) => c.type === 'value' && c.value)
      .map((c) => [c.label.fr, `${c.value.fr} ${c.unit}`]),
    [
      ['Ce mois', '59,76 kWh'],
      ['Cette année', '3053 kWh'],
      ['Total', '26619 kWh'],
    ],
  );
  assert.deepEqual(
    production.components.find((c) => c.type === 'status').items.map((i) => i.label.fr),
    ['Actualisé à'],
  );
  assert.equal(
    production.components.find((c) => c.type === 'status').items[0].value,
    '19:10',
    'the site time, Europe/Paris',
  );

  const battery = buildBatteryContent(view);
  assertValid(battery);
  assert.match(battery.components[0].text.fr, /Aucune batterie/);
});
