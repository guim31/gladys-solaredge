// -----------------------------------------------------------------------------
// The "Connect" button: the authorization URL Gladys opens, and the callback
// it relays — state checked, code exchanged, tokens stored outside the schema.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAUTH_FIELD, createConnectHandlers } from '../src/connect.js';
import { normalizeConfig } from '../src/config.js';
import { ERROR_CODES, SolarEdgeError } from '../src/solaredge/client.js';

const REDIRECT = 'https://my.gladysassistant.com/redirect/oauth';
const TOKENS = { accessToken: 'a', refreshToken: 'r', expiresAt: 2, obtainedAt: 1 };

function setUp({ config = { client_id: 'client-1', client_secret: 'secret-1' }, exchange } = {}) {
  const saved = [];
  const exchanges = [];
  let connected = 0;
  const handlers = createConnectHandlers({
    gladys: { setConfig: async (values) => saved.push(values) },
    getConfig: () => normalizeConfig(config),
    onConnected: async () => {
      connected += 1;
    },
    createClient: (options) => ({
      exchangeCode: async (args) => {
        exchanges.push({ options, args });
        if (exchange instanceof Error) {
          throw exchange;
        }
        return TOKENS;
      },
    }),
  });
  return { handlers, saved, exchanges, connected: () => connected };
}

const stateOf = (url) => new URL(url).searchParams.get('state');

test('the authorization URL carries the client id, the redirect URI and a fresh state', async () => {
  const { handlers } = setUp();
  const first = await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT);
  const second = await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT);
  const url = new URL(first);
  assert.equal(url.host, 'connect.solaredge.com');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.ok(stateOf(first));
  assert.notEqual(stateOf(first), stateOf(second));
});

test('no URL before the application is saved', async () => {
  const { handlers } = setUp({ config: { client_id: 'client-1' } });
  await assert.rejects(() => handlers.authorizeUrl(OAUTH_FIELD, REDIRECT), /Client Secret/);
});

test('the callback exchanges the code, stores the tokens and reconnects', async () => {
  const { handlers, saved, exchanges, connected } = setUp();
  const state = stateOf(await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT));
  await handlers.callback(OAUTH_FIELD, { code: 'code-1', state, redirectUri: REDIRECT });

  assert.deepEqual(exchanges[0].options.oauth, { clientId: 'client-1', clientSecret: 'secret-1' });
  assert.deepEqual(exchanges[0].args, { code: 'code-1', redirectUri: REDIRECT });
  assert.deepEqual(saved, [
    {
      oauth_access_token: 'a',
      oauth_refresh_token: 'r',
      oauth_expires_at: 2,
      oauth_obtained_at: 1,
    },
  ]);
  assert.equal(connected(), 1);
});

test('a state never issued, or already used, is refused', async () => {
  const { handlers, saved } = setUp();
  await assert.rejects(
    () => handlers.callback(OAUTH_FIELD, { code: 'c', state: 'forged', redirectUri: REDIRECT }),
    /state mismatch/,
  );
  const state = stateOf(await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT));
  await handlers.callback(OAUTH_FIELD, { code: 'c', state, redirectUri: REDIRECT });
  await assert.rejects(
    () => handlers.callback(OAUTH_FIELD, { code: 'c', state, redirectUri: REDIRECT }),
    /state mismatch/,
  );
  assert.equal(saved.length, 1);
});

test('a refused code stores nothing and says why', async () => {
  const { handlers, saved, connected } = setUp({
    exchange: new SolarEdgeError('SolarEdge refused the authorization (invalid_client)', {
      code: ERROR_CODES.RECONNECT,
    }),
  });
  const state = stateOf(await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT));
  await assert.rejects(
    () => handlers.callback(OAUTH_FIELD, { code: 'c', state, redirectUri: REDIRECT }),
    /invalid_client/,
  );
  assert.equal(saved.length, 0);
  assert.equal(connected(), 0);
});
