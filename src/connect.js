// -----------------------------------------------------------------------------
// The "Connect" button (manifest field `solaredge_account`, type `oauth2`,
// Gladys 5.2+).
//
// Gladys relays the whole OAuth 2.0 flow and knows no provider: it asks the
// integration for the authorization URL, opens it, and hands back the code
// SolarEdge redirected to. The integration checks its anti-CSRF state,
// exchanges the code with its client secret and stores the tokens as config
// keys OUTSIDE the schema: they never reach the front.
//
// SolarEdge also appends the `site_id` the owner picked to its redirect, but
// Gladys only relays `code` and `state`: the user types the site id.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { SolarEdgeClient, buildAuthorizeUrl } from './solaredge/client.js';
import { tokensToConfig } from './config.js';

const logger = createLogger({ name: 'connect' });

/** The `oauth2` key of the manifest. */
export const OAUTH_FIELD = 'solaredge_account';

/**
 * @param {object} deps
 * @param {object} deps.gladys the SDK instance (`setConfig`)
 * @param {() => object} deps.getConfig the current normalized configuration
 * @param {() => Promise<void>} deps.onConnected called once the tokens are saved
 * @param {(options: object) => SolarEdgeClient} [deps.createClient] for tests
 */
export function createConnectHandlers({
  gladys,
  getConfig,
  onConnected,
  createClient = (options) => new SolarEdgeClient(options),
}) {
  // Anti-CSRF states of the flows in progress: one per click on "Connect".
  const pendingStates = new Set();

  async function authorizeUrl(key, redirectUri) {
    if (key !== OAUTH_FIELD) {
      throw new Error(`Unknown OAuth field: ${key}`);
    }
    const config = getConfig();
    if (!config.client_id || !config.client_secret) {
      // Thrown, so a single string: the core shows it next to the button.
      throw new Error('Fill in and save the Client ID and the Client Secret first.');
    }
    const state = randomUUID();
    pendingStates.add(state);
    logger.info('Connect: opening the SolarEdge authorization page');
    return buildAuthorizeUrl({ clientId: config.client_id, redirectUri, state });
  }

  async function callback(key, { code, state, redirectUri }) {
    if (key !== OAUTH_FIELD || !pendingStates.delete(state)) {
      throw new Error('Unexpected authorization answer (state mismatch): press "Connect" again.');
    }
    const config = getConfig();
    const client = createClient({
      oauth: { clientId: config.client_id, clientSecret: config.client_secret },
    });
    let tokens;
    try {
      tokens = await client.exchangeCode({ code, redirectUri });
    } catch (err) {
      logger.error(`Connect: SolarEdge refused the authorization code: ${err.message}`);
      throw new Error(`SolarEdge refused the authorization: ${err.message}`, { cause: err });
    }
    await gladys.setConfig(tokensToConfig(tokens));
    logger.info('Connect: SolarEdge authorization granted');
    await onConnected();
  }

  return { authorizeUrl, callback };
}
