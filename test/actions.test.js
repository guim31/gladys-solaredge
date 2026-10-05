// -----------------------------------------------------------------------------
// The Configuration screen buttons: what the user reads after pressing them.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GladysApiError } from '@gladysassistant/integration-sdk';
import { ACTIONS, WIDGET_ACTIONS, describeError } from '../src/actions.js';
import { normalizeConfig } from '../src/config.js';
import { ERROR_CODES, SolarEdgeError } from '../src/solaredge/client.js';
import { SolarEdgeService } from '../src/solaredge/service.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeClient } from './helpers/solaredgeFixtures.js';

function createDeps({ overrides = {}, config = {}, refreshAll } = {}) {
  const normalized = normalizeConfig({ api_key: 'K', ...config });
  const service = new SolarEdgeService(normalized, {
    client: createFakeClient(overrides),
    now: () => new Date('2024-05-18T13:42:00Z'),
  });
  return { config: normalized, service, refreshAll: refreshAll ?? (async () => 12) };
}

test('every action answers in both languages', async () => {
  const gladys = createFakeGladys();
  for (const [key, handler] of Object.entries(ACTIONS)) {
    const message = await handler(gladys, createDeps());
    assert.ok(message.en, `action "${key}" has no English message`);
    assert.ok(message.fr, `action "${key}" has no French message`);
  }
});

test('test_connection names the site and what it can report', async () => {
  const message = await ACTIONS.test_connection(createFakeGladys(), createDeps());
  assert.match(message.fr, /Maison/);
  assert.match(message.fr, /1234567/);
  assert.match(message.fr, /6\.4 kWc/);
  assert.match(message.fr, /production solaire, consommation, réseau, batterie/);
});

test('test_connection on a production-only site does not promise a battery', async () => {
  const message = await ACTIONS.test_connection(
    createFakeGladys(),
    createDeps({ overrides: { flow: {}, energy: { unit: 'Wh', meters: [] } } }),
  );
  assert.match(message.fr, /production solaire\./);
  assert.equal(/batterie/.test(message.fr), false);
});

test('test_connection surfaces a rejected API key instead of swallowing it', async () => {
  const deps = createDeps({ overrides: { sites: new Error('SolarEdge refused the API key') } });
  await assert.rejects(
    () => ACTIONS.test_connection(createFakeGladys(), deps),
    /refused the API key/,
  );
});

test('list_sites shows the ids the user has to choose from', async () => {
  const message = await ACTIONS.list_sites(
    createFakeGladys(),
    createDeps({
      overrides: {
        sites: [
          { id: 1, name: 'Maison' },
          { id: 2, name: 'Bureau' },
        ],
      },
    }),
  );
  assert.match(message.fr, /1 — Maison/);
  assert.match(message.fr, /2 — Bureau/);
});

test('list_sites says so when the key covers nothing', async () => {
  const message = await ACTIONS.list_sites(
    createFakeGladys(),
    createDeps({ overrides: { sites: [] } }),
  );
  assert.match(message.fr, /aucun site/);
});

test('refresh_now reports how many states were published', async () => {
  const message = await ACTIONS.refresh_now(createFakeGladys(), createDeps());
  assert.match(message.fr, /12 état/);
});

test('api_usage translates the remaining budget into refresh cycles', async () => {
  const deps = createDeps();
  deps.service.client.usage = { day: '2024-05-18', count: 100, limit: 300, remaining: 200 };

  const message = await ACTIONS.api_usage(createFakeGladys(), deps);
  assert.match(message.fr, /100\/300/);
  // 200 requests left, 2 per cycle without the storage telemetry.
  assert.match(message.fr, /100 cycle/);
});

// --- Widget buttons ----------------------------------------------------------

test('the widget Refresh button answers like the "Refresh now" action', async () => {
  const message = await WIDGET_ACTIONS.refresh(createFakeGladys(), createDeps());
  assert.match(message.fr, /12 état/);
  assert.match(message.en, /12 state/);
});

test('a refresh the budget refuses becomes a toast, not a failed action', async () => {
  const deps = createDeps({
    refreshAll: async () => {
      throw new SolarEdgeError('Daily budget spent', { code: ERROR_CODES.QUOTA_EXCEEDED });
    },
  });
  const message = await WIDGET_ACTIONS.refresh(createFakeGladys(), deps);
  assert.match(message.fr, /Quota de requêtes SolarEdge atteint/);
  assert.match(message.en, /quota reached/);
  for (const text of Object.values(message)) {
    assert.ok(text.length <= 200, 'a toast is 200 characters at most per language');
  }
});

test('describeError blames the right side', () => {
  assert.match(
    describeError(new GladysApiError(422, 'BAD_REQUEST', 'min is required')).fr,
    /Gladys a refusé/,
  );
  assert.match(
    describeError(new SolarEdgeError('x', { code: ERROR_CODES.UNAUTHORIZED })).fr,
    /clé d'API/,
  );
  assert.match(
    describeError(new SolarEdgeError('site 1', { code: ERROR_CODES.NOT_FOUND })).fr,
    /introuvable/,
  );
  assert.match(
    describeError(new SolarEdgeError('x', { code: ERROR_CODES.RATE_LIMITED })).fr,
    /Quota/,
  );
  assert.match(
    describeError(new Error('ECONNRESET')).fr,
    /Impossible de joindre SolarEdge : ECONNRESET/,
  );
  assert.match(describeError(undefined).en, /unknown error/);
});
