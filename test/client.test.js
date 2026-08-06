// -----------------------------------------------------------------------------
// The client's job beyond "do a GET": never spend more than the daily SolarEdge
// budget, and turn HTTP failures into errors the rest of the code can branch on.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, SolarEdgeClient, SolarEdgeError } from '../src/solaredge/client.js';

/** A fetch stub recording the URLs it was called with. */
function fakeFetch(responses) {
  const urls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url) => {
    urls.push(url);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  impl.urls = urls;
  return impl;
}

const okResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const errorResponse = (status, body = '') => ({
  ok: false,
  status,
  text: async () => body,
});

function createClient(fetchImpl, options = {}) {
  return new SolarEdgeClient({
    apiKey: 'TESTKEY',
    fetchImpl,
    now: () => new Date('2024-05-18T10:00:00Z'),
    ...options,
  });
}

test('request appends the API key and the query parameters', async () => {
  const fetchImpl = fakeFetch(okResponse({ overview: { currentPower: { power: 42 } } }));
  const client = createClient(fetchImpl);

  const overview = await client.getOverview('1234567');

  assert.deepEqual(overview, { currentPower: { power: 42 } });
  const url = new URL(fetchImpl.urls[0]);
  assert.equal(url.pathname, '/site/1234567/overview');
  assert.equal(url.searchParams.get('api_key'), 'TESTKEY');
});

test('empty parameters are dropped instead of being sent blank', async () => {
  const fetchImpl = fakeFetch(okResponse({ energyDetails: {} }));
  const client = createClient(fetchImpl);

  await client.getEnergyDetails('1', { startTime: '2024-05-18 00:00:00', endTime: '', meters: [] });

  const url = new URL(fetchImpl.urls[0]);
  assert.equal(url.searchParams.get('startTime'), '2024-05-18 00:00:00');
  assert.equal(url.searchParams.has('endTime'), false);
  assert.equal(url.searchParams.has('meters'), false);
});

test('the daily budget is enforced before the request leaves', async () => {
  const fetchImpl = fakeFetch(okResponse({ overview: {} }));
  const client = createClient(fetchImpl, { dailyRequestLimit: 2 });

  await client.getOverview('1');
  await client.getOverview('1');
  await assert.rejects(
    () => client.getOverview('1'),
    (err) => {
      assert.ok(err instanceof SolarEdgeError);
      assert.equal(err.code, ERROR_CODES.QUOTA_EXCEEDED);
      return true;
    },
  );

  assert.equal(fetchImpl.urls.length, 2, 'the refused call never reached SolarEdge');
  assert.deepEqual(client.usage, { day: '2024-05-18', count: 2, limit: 2, remaining: 0 });
});

test('the budget counter resets on a new UTC day', async () => {
  let now = new Date('2024-05-18T23:59:00Z');
  const client = createClient(fakeFetch(okResponse({ overview: {} })), {
    dailyRequestLimit: 1,
    now: () => now,
  });

  await client.getOverview('1');
  await assert.rejects(() => client.getOverview('1'));

  now = new Date('2024-05-19T00:01:00Z');
  await assert.doesNotReject(() => client.getOverview('1'));
  assert.equal(client.usage.day, '2024-05-19');
  assert.equal(client.usage.count, 1);
});

test('a failed request still counts against the budget', async () => {
  // SolarEdge counts every request it receives, successful or not: counting
  // only the successes would let a broken site blow through the real quota.
  const client = createClient(fakeFetch(errorResponse(500)), { dailyRequestLimit: 5 });
  await assert.rejects(() => client.getOverview('1'));
  assert.equal(client.usage.count, 1);
});

test('HTTP failures map to actionable error codes', async () => {
  const cases = [
    [403, ERROR_CODES.UNAUTHORIZED],
    [401, ERROR_CODES.UNAUTHORIZED],
    [404, ERROR_CODES.NOT_FOUND],
    [429, ERROR_CODES.RATE_LIMITED],
    [503, ERROR_CODES.UNAVAILABLE],
    [400, ERROR_CODES.UNEXPECTED],
  ];
  for (const [status, code] of cases) {
    const client = createClient(fakeFetch(errorResponse(status, 'boom')));
    await assert.rejects(
      () => client.getOverview('1'),
      (err) => {
        assert.equal(err.code, code, `HTTP ${status}`);
        assert.equal(err.status, status);
        return true;
      },
    );
  }
});

test('a network failure becomes an "unavailable" error, not a crash', async () => {
  const client = createClient(fakeFetch(new TypeError('socket hang up')));
  await assert.rejects(
    () => client.getOverview('1'),
    (err) => {
      assert.equal(err.code, ERROR_CODES.UNAVAILABLE);
      return true;
    },
  );
});

test('getSites unwraps the nested SolarEdge envelope', async () => {
  const client = createClient(
    fakeFetch(okResponse({ sites: { count: 1, site: [{ id: 1, name: 'Maison' }] } })),
  );
  assert.deepEqual(await client.getSites(), [{ id: 1, name: 'Maison' }]);
});

test('an unsupported endpoint returning an empty body yields null, not a throw', async () => {
  const client = createClient(fakeFetch(okResponse({})));
  assert.equal(await client.getCurrentPowerFlow('1'), null);
});
