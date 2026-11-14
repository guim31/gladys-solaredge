// -----------------------------------------------------------------------------
// The client's job beyond "do a GET": authenticate the V2 way (Fleet key
// header, or OAuth bearer renewed with a rotating refresh token), never spend
// more than the daily share of the monthly credits, and turn HTTP failures —
// the 410 of the retired V1 API included — into errors the rest of the code
// can branch on.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CODES,
  SolarEdgeClient,
  buildAuthorizeUrl,
  dailyBudget,
} from '../src/solaredge/client.js';

/** A fetch stub recording what it was called with. */
function fakeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  impl.calls = calls;
  Object.defineProperty(impl, 'urls', { get: () => calls.map((c) => c.url) });
  return impl;
}

const headers = (map = {}) => ({ get: (name) => map[name.toLowerCase()] ?? null });

const okResponse = (body) => ({
  ok: true,
  status: 200,
  headers: headers(),
  json: async () => body,
});

const errorResponse = (status, body = '', head = {}) => ({
  ok: false,
  status,
  headers: headers(head),
  text: async () => body,
  json: async () => JSON.parse(body),
});

const tokenResponse = (access, refresh) =>
  okResponse({
    access_token: access,
    token_type: 'Bearer',
    expires_in: 7200,
    refresh_token: refresh,
  });

function createClient(fetchImpl, options = {}) {
  return new SolarEdgeClient({
    apiKey: 'FLEETKEY',
    baseUrl: 'https://api.example.test/v2',
    fetchImpl,
    now: () => new Date('2026-11-14T12:00:00Z'),
    ...options,
  });
}

const NOW = new Date('2026-11-14T12:00:00Z').getTime();

function oauthClient(fetchImpl, tokens = {}, extra = {}) {
  return createClient(fetchImpl, {
    apiKey: undefined,
    oauth: {
      clientId: 'client-1',
      clientSecret: 'secret-1',
      tokens: {
        accessToken: 'access-0',
        refreshToken: 'refresh-0',
        expiresAt: NOW + 3_600_000,
        obtainedAt: NOW - 3_600_000,
        ...tokens,
      },
    },
    ...extra,
  });
}

test('a Fleet API key travels in the X-API-Key header, never in the URL', async () => {
  const fetchImpl = fakeFetch(okResponse({}));
  const client = createClient(fetchImpl);
  await client.getOverview('123');
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, 'https://api.example.test/v2/sites/123/overview');
  assert.equal(init.headers['X-API-Key'], 'FLEETKEY');
  assert.ok(!url.includes('api_key'));
});

test('the V2 paths and parameters: plural /sites, from/to, resolution, repeated types', async () => {
  const fetchImpl = fakeFetch(okResponse({}));
  const client = createClient(fetchImpl);
  await client.getPower('123', { from: '2026-11-14T11:15:00Z', to: '2026-11-14T12:00:00Z' });
  await client.getDevices('123', ['METER', 'BATTERY']);
  await client.getMetersLifetimeEnergy('123', { from: 'a', to: 'b', meters: ['PURCHASED'] });

  const power = new URL(fetchImpl.urls[0]);
  assert.equal(power.pathname, '/v2/sites/123/power');
  assert.equal(power.searchParams.get('from'), '2026-11-14T11:15:00Z');
  assert.equal(power.searchParams.get('resolution'), 'QUARTER_HOUR');
  assert.equal(power.searchParams.get('unit'), 'W');
  assert.deepEqual(new URL(fetchImpl.urls[1]).searchParams.getAll('types'), ['METER', 'BATTERY']);
  assert.equal(new URL(fetchImpl.urls[2]).searchParams.get('meters'), 'PURCHASED');
});

test('empty parameters are dropped instead of being sent blank', async () => {
  const fetchImpl = fakeFetch(okResponse({}));
  const client = createClient(fetchImpl);
  await client.request('/sites/1/energy', { from: '', to: undefined, resolution: null });
  assert.equal(new URL(fetchImpl.urls[0]).search, '');
});

test('the daily budget is the monthly allowance spread over 31 days', () => {
  assert.equal(dailyBudget(2000), 64);
  assert.equal(dailyBudget(20_000), 645);
  assert.equal(createClient(fakeFetch(okResponse({}))).usage.limit, 64);
});

test('the daily budget is enforced before the request leaves', async () => {
  const fetchImpl = fakeFetch(okResponse({}));
  const client = createClient(fetchImpl, { monthlyCredits: 62 });
  await client.getOverview('1');
  await client.getOverview('1');
  await assert.rejects(
    () => client.getOverview('1'),
    (err) => err.code === ERROR_CODES.QUOTA_EXCEEDED,
  );
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(client.usage.remaining, 0);
});

test('the budget counter resets on a new UTC day', async () => {
  let now = new Date('2026-11-14T23:59:00Z');
  const client = createClient(fakeFetch(okResponse({})), { monthlyCredits: 31, now: () => now });
  await client.getOverview('1');
  await assert.rejects(() => client.getOverview('1'));
  now = new Date('2026-11-15T00:01:00Z');
  await client.getOverview('1');
  assert.equal(client.usage.count, 1);
});

test('HTTP failures map to actionable error codes', async () => {
  const cases = [
    [401, '', ERROR_CODES.UNAUTHORIZED],
    [403, '{"title":"Forbidden","detail":"no access to this site"}', ERROR_CODES.UNAUTHORIZED],
    [403, '{"type":"tier_insufficient","detail":"Advanced"}', ERROR_CODES.TIER],
    [404, '', ERROR_CODES.NOT_FOUND],
    [503, '', ERROR_CODES.UNAVAILABLE],
    [400, '{"detail":"from must be before to"}', ERROR_CODES.UNEXPECTED],
  ];
  for (const [status, body, code] of cases) {
    const client = createClient(fakeFetch(errorResponse(status, body)));
    await assert.rejects(
      () => client.getOverview('1'),
      (err) => {
        assert.equal(err.code, code, `HTTP ${status} ${body}`);
        assert.equal(err.status, status);
        return true;
      },
    );
  }
});

test('HTTP 410 (the retired V1 API) says "retired", not "unexpected"', async () => {
  const body =
    '{"type":"https://se-api.stoplight.io/docs/monitoring","title":"API Version Deprecated","status":410,"detail":"Monitoring API V1 was retired on November 3, 2026 and no longer accepts requests."}';
  const client = createClient(fakeFetch(errorResponse(410, body)));
  await assert.rejects(
    () => client.getOverview('1'),
    (err) => err.code === ERROR_CODES.API_RETIRED && err.status === 410,
  );
});

test('a 429 tells the minute window from the spent month', async () => {
  const perMinute = createClient(
    fakeFetch(
      errorResponse(429, '{"message":"API rate limit exceeded"}', {
        'x-ratelimit-remaining-minute': '0',
        'retry-after': '12',
      }),
    ),
  );
  await assert.rejects(
    () => perMinute.getOverview('1'),
    (err) => err.code === ERROR_CODES.RATE_LIMITED,
  );
  const monthly = createClient(
    fakeFetch(
      errorResponse(429, '{"detail":"Monthly credit limit reached."}', {
        'x-ratelimit-remaining-minute': '7',
      }),
    ),
  );
  await assert.rejects(
    () => monthly.getOverview('1'),
    (err) => err.code === ERROR_CODES.CREDITS_EXHAUSTED,
  );
});

test('a network failure becomes an "unavailable" error, not a crash', async () => {
  const client = createClient(fakeFetch(new TypeError('socket hang up')));
  await assert.rejects(
    () => client.getOverview('1'),
    (err) => err.code === ERROR_CODES.UNAVAILABLE,
  );
});

test('getSites unwraps the paginated V2 envelope', async () => {
  const fetchImpl = fakeFetch(
    okResponse({ sites: { count: 1, site: [{ siteId: 1, name: 'Maison' }] } }),
  );
  const client = createClient(fetchImpl);
  assert.deepEqual(await client.getSites(), [{ siteId: 1, name: 'Maison' }]);
  assert.equal(new URL(fetchImpl.urls[0]).searchParams.get('sites-in-page'), '100');
});

test('OAuth: a valid access token goes as a Bearer header', async () => {
  const fetchImpl = fakeFetch(okResponse({}));
  const client = oauthClient(fetchImpl);
  await client.getOverview('1');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer access-0');
  assert.equal(fetchImpl.calls[0].init.headers['X-API-Key'], undefined);
  assert.equal(client.mode, 'oauth');
});

test('OAuth: an expiring token is renewed first, and the new pair is saved', async () => {
  const saved = [];
  const fetchImpl = fakeFetch([tokenResponse('access-1', 'refresh-1'), okResponse({})]);
  const client = oauthClient(
    fetchImpl,
    { expiresAt: NOW + 60_000 },
    { onTokens: async (t) => saved.push(t) },
  );
  await client.getOverview('1');

  const [refresh, call] = fetchImpl.calls;
  assert.equal(refresh.url, 'https://api.example.test/v2/oauth2/token');
  assert.equal(refresh.init.method, 'POST');
  assert.deepEqual(JSON.parse(refresh.init.body), {
    grant_type: 'refresh_token',
    refresh_token: 'refresh-0',
    client_id: 'client-1',
    client_secret: 'secret-1',
  });
  assert.equal(call.init.headers.Authorization, 'Bearer access-1');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].refreshToken, 'refresh-1');
  assert.equal(saved[0].expiresAt, NOW + 7_200_000);
  // The token endpoint is no Monitoring API call: one request spent, not two.
  assert.equal(client.usage.count, 1);
});

test('OAuth: concurrent calls share ONE refresh (the refresh token rotates)', async () => {
  const fetchImpl = fakeFetch([tokenResponse('access-1', 'refresh-1'), okResponse({})]);
  const client = oauthClient(fetchImpl, { accessToken: undefined });
  await Promise.all([client.getOverview('1'), client.getPower('1', {}), client.getOverview('1')]);
  const refreshes = fetchImpl.calls.filter((c) => c.url.endsWith('/oauth2/token'));
  assert.equal(refreshes.length, 1);
});

test('OAuth: a 401 renews the token once and replays the call', async () => {
  const fetchImpl = fakeFetch([
    errorResponse(401, '{"message":"Unauthorized"}'),
    tokenResponse('access-1', 'refresh-1'),
    okResponse({ siteId: 1 }),
  ]);
  const client = oauthClient(fetchImpl);
  assert.deepEqual(await client.getOverview('1'), { siteId: 1 });
  assert.equal(fetchImpl.calls[2].init.headers.Authorization, 'Bearer access-1');
});

test('OAuth: a refused refresh asks the user to connect again', async () => {
  const fetchImpl = fakeFetch(
    errorResponse(400, '{"error":"invalid_grant","error_description":"Refresh token expired"}'),
  );
  const client = oauthClient(fetchImpl, { expiresAt: 0 });
  await assert.rejects(
    () => client.getOverview('1'),
    (err) => err.code === ERROR_CODES.RECONNECT && /invalid_grant/.test(err.message),
  );
});

test('OAuth: the authorization code is exchanged with the same redirect URI', async () => {
  const fetchImpl = fakeFetch(tokenResponse('access-1', 'refresh-1'));
  const client = new SolarEdgeClient({
    oauth: { clientId: 'client-1', clientSecret: 'secret-1' },
    baseUrl: 'https://api.example.test/v2',
    fetchImpl,
    now: () => new Date(NOW),
  });
  const tokens = await client.exchangeCode({
    code: 'code-1',
    redirectUri: 'https://my.gladysassistant.com/redirect/oauth',
  });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), {
    grant_type: 'authorization_code',
    code: 'code-1',
    redirect_uri: 'https://my.gladysassistant.com/redirect/oauth',
    client_id: 'client-1',
    client_secret: 'secret-1',
  });
  assert.equal(tokens.refreshToken, 'refresh-1');
  assert.equal(tokens.obtainedAt, NOW);
});

test('OAuth: older tokens from a config echo never replace newer ones', () => {
  const client = oauthClient(fakeFetch(okResponse({})));
  client.adoptTokens({ refreshToken: 'stale', obtainedAt: NOW - 7_200_000 });
  assert.equal(client.tokens.refreshToken, 'refresh-0');
  client.adoptTokens({ refreshToken: 'reconnected', obtainedAt: NOW });
  assert.equal(client.tokens.refreshToken, 'reconnected');
});

test('the authorize URL carries the client id, the redirect URI, both scopes and the state', () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: 'client-1',
      redirectUri: 'https://my.gladysassistant.com/redirect/oauth',
      state: 'abc',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://connect.solaredge.com/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://my.gladysassistant.com/redirect/oauth',
  );
  assert.equal(url.searchParams.get('scope'), 'SITE_DATA DEVICE_DATA');
  assert.equal(url.searchParams.get('state'), 'abc');
});
