// -----------------------------------------------------------------------------
// The "Connect" button: the authorization URL Gladys opens, and the callback
// it relays — state checked, code exchanged, tokens stored outside the schema.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_REDIRECT_URI, OAUTH_FIELD, createConnectHandlers } from '../src/connect.js';
import { normalizeConfig } from '../src/config.js';
import { ERROR_CODES, SolarEdgeError } from '../src/solaredge/client.js';

const REDIRECT = 'https://my.gladysassistant.com/redirect/oauth';
const TOKENS = { accessToken: 'a', refreshToken: 'r', expiresAt: 2, obtainedAt: 1 };

function setUp({
  config = { client_id: 'client-1', client_secret: 'secret-1', site_id: '' },
  exchange,
} = {}) {
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
  // SolarEdge only echoes external_id: it carries the same anti-CSRF value.
  assert.equal(url.searchParams.get('external_id'), stateOf(first));
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

// --- "Finish the connection": SolarEdge never hands `state` back -------------

/** What SolarEdge redirects to: the application's Redirect URI + code, site_id, external_id. */
function solarEdgeReturn(authorizeUrl, { code = 'code-1', siteId = '1234567', base } = {}) {
  const externalId = new URL(authorizeUrl).searchParams.get('external_id');
  return `${base ?? FALLBACK_REDIRECT_URI}?code=${code}&site_id=${siteId}&external_id=${externalId}`;
}

test('the pasted address is exchanged with its own redirect URI, and the site is saved', async () => {
  const { handlers, saved, exchanges, connected } = setUp();
  const address = solarEdgeReturn(await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT));
  const message = await handlers.finish(`  ${address}\n`);

  assert.deepEqual(exchanges[0].args, { code: 'code-1', redirectUri: FALLBACK_REDIRECT_URI });
  assert.equal(saved[0].site_id, '1234567');
  assert.equal(saved[0].oauth_refresh_token, 'r');
  assert.equal(connected(), 1);
  assert.match(message.fr, /site 1234567/);
  for (const language of ['en', 'fr', 'de', 'es']) {
    assert.ok(message[language], language);
  }
});

test('the same site id is not written again', async () => {
  const { handlers, saved } = setUp({
    config: { client_id: 'client-1', client_secret: 'secret-1', site_id: '1234567' },
  });
  await handlers.finish(solarEdgeReturn(await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT)));
  assert.equal('site_id' in saved[0], false);
});

test('a code from a flow this instance never started is refused (anti-CSRF)', async () => {
  const { handlers, saved } = setUp();
  await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT);
  await assert.rejects(
    () => handlers.finish(`${FALLBACK_REDIRECT_URI}?code=c&site_id=1&external_id=forged`),
    (err) => err.message.fr.includes('Connecter') && err.message.en.includes('Connect'),
  );
  await assert.rejects(() => handlers.finish(`${FALLBACK_REDIRECT_URI}?code=c&site_id=1`));
  assert.equal(saved.length, 0);
});

test('a flow is used once', async () => {
  const { handlers, saved } = setUp();
  const address = solarEdgeReturn(await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT));
  await handlers.finish(address);
  await assert.rejects(() => handlers.finish(address));
  assert.equal(saved.length, 1);
});

test('the wiped Gladys bounce page, garbage and a denial say what to do', async () => {
  const { handlers } = setUp();
  const url = await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT);
  const failure = async (address) => {
    try {
      await handlers.finish(address);
    } catch (err) {
      return err.message;
    }
    assert.fail(`accepted: ${address}`);
  };
  assert.match((await failure(REDIRECT)).fr, /localhost:8080/);
  assert.match((await failure('not an address')).fr, /adresse complète/);
  assert.match((await failure('javascript:alert(1)')).en, /whole address/);
  assert.match((await failure(`${FALLBACK_REDIRECT_URI}?foo=1`)).fr, /code/);
  assert.match((await failure(`${FALLBACK_REDIRECT_URI}?error=access_denied`)).fr, /access_denied/);
  // None of those spent the flow: the real answer still goes through.
  await handlers.finish(solarEdgeReturn(url));
});

test('a code SolarEdge refuses is a red multilingual failure, nothing stored', async () => {
  const { handlers, saved, connected } = setUp({
    exchange: new SolarEdgeError('SolarEdge refused the authorization (invalid_grant)', {
      code: ERROR_CODES.RECONNECT,
    }),
  });
  const address = solarEdgeReturn(await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT));
  await assert.rejects(
    () => handlers.finish(address),
    (err) => err.message.fr.includes('invalid_grant') && err.message.es.includes('invalid_grant'),
  );
  assert.equal(saved.length, 0);
  assert.equal(connected(), 0);
});

test('only the 20 latest flows are remembered', async () => {
  const { handlers } = setUp();
  const first = await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT);
  for (let i = 0; i < 20; i += 1) {
    await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT);
  }
  await assert.rejects(() => handlers.finish(solarEdgeReturn(first)));
});

test('without the application saved, "Finish" says so and keeps the flow', async () => {
  const config = { client_id: 'client-1', client_secret: 'secret-1', site_id: '' };
  const { handlers } = setUp({ config });
  const address = solarEdgeReturn(await handlers.authorizeUrl(OAUTH_FIELD, REDIRECT));
  delete config.client_secret;
  await assert.rejects(
    () => handlers.finish(address),
    (err) => err.message.fr.includes('Client Secret'),
  );
  config.client_secret = 'secret-1';
  await handlers.finish(address);
});
