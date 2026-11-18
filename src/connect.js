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
//
// SolarEdge does NOT hand `state` back (checked in the code of
// connect.solaredge.com, 17/11/2026): its sign-in page only reads `client_id`,
// `external_id` and `redirect_label`, and redirects to the Redirect URI saved
// on the application with `code`, `site_id` and `external_id`. The
// `redirect_uri` and `state` of our URL are ignored. Gladys's HTTPS bounce
// page (my.gladysassistant.com/redirect/oauth) needs that `state` to find the
// way home, and wipes the address bar when it cannot: the "Connect" round trip
// can never complete on its own. Hence "Finish the connection": the
// application's Redirect URI points nowhere (FALLBACK_REDIRECT_URI), the user
// copies the address the browser fails to load and pastes it here. The
// anti-CSRF value travels in `external_id`, which SolarEdge does echo, and is
// checked like a state. The `state` stays in the URL: the Gladys front refuses
// an authorization URL without one.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { SolarEdgeClient, buildAuthorizeUrl } from './solaredge/client.js';
import { tokensToConfig } from './config.js';

const logger = createLogger({ name: 'connect' });

/** The `oauth2` key of the manifest. */
export const OAUTH_FIELD = 'solaredge_account';

/** The manifest action where the user pastes the address SolarEdge came back to. */
export const FINISH_CONNECT_ACTION = 'finish_connect';

/**
 * The Redirect URI the documentation asks to save on the SolarEdge
 * application: the one of SolarEdge's own self-access guide. Nothing answers
 * there, so the browser stops on an error page and keeps the address (with
 * `code`, `site_id` and `external_id`) for the user to copy.
 */
export const FALLBACK_REDIRECT_URI = 'http://localhost:8080/oauth/callback';

/** Flows in progress kept at once: one per click on "Connect". */
const MAX_PENDING_STATES = 20;

/**
 * A failed action: Gladys shows a thrown error in red, and the SDK sends
 * `err.message` as is, so a multilingual object reaches the front.
 */
export class ActionFailure extends Error {
  constructor(text) {
    super(text.en);
    this.message = text;
  }
}

const FINISH_TEXTS = {
  notAnAddress: {
    en: 'Paste the whole address shown in the address bar after approving at SolarEdge (it starts with http).',
    fr: "Collez l'adresse complète affichée dans la barre d'adresse après l'autorisation chez SolarEdge (elle commence par http).",
    de: 'Füge die vollständige Adresse aus der Adressleiste nach der Freigabe bei SolarEdge ein (sie beginnt mit http).',
    es: 'Pegue la dirección completa que aparece en la barra de direcciones tras autorizar en SolarEdge (empieza por http).',
  },
  bouncePage: {
    en: `This address holds no authorization code: the Gladys redirect page cannot be used with SolarEdge. In your SolarEdge application, set the Redirect URI to ${FALLBACK_REDIRECT_URI}, press "Connect" again and paste the new address.`,
    fr: `Cette adresse ne contient pas de code d'autorisation : la page de redirection de Gladys ne fonctionne pas avec SolarEdge. Dans votre application SolarEdge, mettez l'adresse de redirection ${FALLBACK_REDIRECT_URI}, appuyez de nouveau sur « Connecter » et collez la nouvelle adresse.`,
    de: `Diese Adresse enthält keinen Autorisierungscode: Die Weiterleitungsseite von Gladys funktioniert nicht mit SolarEdge. Trage in deiner SolarEdge-Anwendung die Weiterleitungsadresse ${FALLBACK_REDIRECT_URI} ein, klicke erneut auf „Verbinden“ und füge die neue Adresse ein.`,
    es: `Esta dirección no contiene código de autorización: la página de redirección de Gladys no funciona con SolarEdge. En su aplicación SolarEdge, ponga la dirección de redirección ${FALLBACK_REDIRECT_URI}, pulse de nuevo «Conectar» y pegue la nueva dirección.`,
  },
  noCode: {
    en: 'This address holds no authorization code: press "Connect", approve at SolarEdge, then paste the address of the page you land on.',
    fr: "Cette adresse ne contient pas de code d'autorisation : appuyez sur « Connecter », autorisez chez SolarEdge, puis collez l'adresse de la page où vous arrivez.",
    de: 'Diese Adresse enthält keinen Autorisierungscode: Klicke auf „Verbinden“, bestätige bei SolarEdge und füge dann die Adresse der Seite ein, auf der du landest.',
    es: 'Esta dirección no contiene código de autorización: pulse «Conectar», autorice en SolarEdge y pegue la dirección de la página a la que llega.',
  },
  unknownFlow: {
    en: 'This address does not match a "Connect" started from this Gladys (or the integration restarted since): press "Connect" again and paste the new address.',
    fr: "Cette adresse ne correspond à aucune connexion lancée depuis ce Gladys (ou l'intégration a redémarré depuis) : appuyez de nouveau sur « Connecter » et collez la nouvelle adresse.",
    de: 'Diese Adresse passt zu keiner von diesem Gladys aus gestarteten Verbindung (oder die Integration wurde seitdem neu gestartet): Klicke erneut auf „Verbinden“ und füge die neue Adresse ein.',
    es: 'Esta dirección no corresponde a ninguna conexión iniciada desde este Gladys (o la integración se ha reiniciado desde entonces): pulse de nuevo «Conectar» y pegue la nueva dirección.',
  },
  noApplication: {
    en: 'Fill in and save the Client ID and the Client Secret first, then press "Connect".',
    fr: "Renseignez et enregistrez d'abord le Client ID et le Client Secret, puis appuyez sur « Connecter ».",
    de: 'Trage zuerst Client ID und Client Secret ein und speichere, dann klicke auf „Verbinden“.',
    es: 'Introduzca y guarde primero el Client ID y el Client Secret, y pulse «Conectar».',
  },
  providerError: (error) => ({
    en: `SolarEdge did not grant access (${error}): press "Connect" again and approve.`,
    fr: `SolarEdge n'a pas accordé l'accès (${error}) : appuyez de nouveau sur « Connecter » et autorisez.`,
    de: `SolarEdge hat den Zugriff nicht gewährt (${error}): Klicke erneut auf „Verbinden“ und bestätige.`,
    es: `SolarEdge no concedió el acceso (${error}): pulse de nuevo «Conectar» y autorice.`,
  }),
  refused: (reason) => ({
    en: `SolarEdge refused the authorization code (${reason}). A code works once and only for a few minutes: press "Connect" again and paste the new address right away.`,
    fr: `SolarEdge a refusé le code d'autorisation (${reason}). Un code ne sert qu'une fois et quelques minutes : appuyez de nouveau sur « Connecter » et collez aussitôt la nouvelle adresse.`,
    de: `SolarEdge hat den Autorisierungscode abgelehnt (${reason}). Ein Code gilt nur einmal und wenige Minuten: Klicke erneut auf „Verbinden“ und füge die neue Adresse sofort ein.`,
    es: `SolarEdge rechazó el código de autorización (${reason}). Un código solo sirve una vez y unos minutos: pulse de nuevo «Conectar» y pegue enseguida la nueva dirección.`,
  }),
  connected: (siteId) => ({
    en: `Connected to SolarEdge${siteId ? ` (site ${siteId})` : ''}. Reload this page before changing the form (the site ID was filled in), then add the devices from the Discovery tab.`,
    fr: `Connecté à SolarEdge${siteId ? ` (site ${siteId})` : ''}. Rechargez cette page avant de modifier le formulaire (l'identifiant du site a été rempli), puis ajoutez les appareils depuis l'onglet Découverte.`,
    de: `Mit SolarEdge verbunden${siteId ? ` (Standort ${siteId})` : ''}. Lade diese Seite neu, bevor du das Formular änderst (die Standort-ID wurde eingetragen), und füge dann die Geräte im Tab Erkennung hinzu.`,
    es: `Conectado a SolarEdge${siteId ? ` (sitio ${siteId})` : ''}. Recargue esta página antes de modificar el formulario (se ha rellenado el ID del sitio) y añada luego los dispositivos desde la pestaña Descubrimiento.`,
  }),
};

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
    // A Set keeps insertion order: forget the oldest flows first.
    for (const old of pendingStates) {
      if (pendingStates.size <= MAX_PENDING_STATES) {
        break;
      }
      pendingStates.delete(old);
    }
    logger.info('Connect: opening the SolarEdge authorization page');
    // `external_id` is the only value SolarEdge hands back: it carries the
    // anti-CSRF state for "Finish the connection".
    return buildAuthorizeUrl({
      clientId: config.client_id,
      redirectUri,
      state,
      externalId: state,
    });
  }

  /**
   * Exchange a code SolarEdge issued, save the tokens (and the approved site),
   * then reconnect. `refused(err)` builds what to throw when SolarEdge turns
   * the code down.
   */
  async function complete({ code, redirectUri, siteId, refused }) {
    const config = getConfig();
    const client = createClient({
      oauth: { clientId: config.client_id, clientSecret: config.client_secret },
    });
    let tokens;
    try {
      tokens = await client.exchangeCode({ code, redirectUri });
    } catch (err) {
      logger.error(`Connect: SolarEdge refused the authorization code: ${err.message}`);
      throw refused(err);
    }
    const values = tokensToConfig(tokens);
    if (siteId && siteId !== config.site_id) {
      // The site the owner just approved: the tokens only open that one.
      values.site_id = siteId;
    }
    await gladys.setConfig(values);
    logger.info('Connect: SolarEdge authorization granted');
    await onConnected();
  }

  /**
   * "Finish the connection": the address the browser landed on after the
   * approval, pasted by the user (see the header of this file).
   * @param {string} address
   */
  async function finish(address) {
    let url;
    try {
      url = new URL(String(address ?? '').trim());
    } catch {
      throw new ActionFailure(FINISH_TEXTS.notAnAddress);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ActionFailure(FINISH_TEXTS.notAnAddress);
    }
    const params = url.searchParams;
    const error = params.get('error');
    if (error) {
      throw new ActionFailure(FINISH_TEXTS.providerError(error));
    }
    const code = params.get('code');
    if (!code) {
      throw new ActionFailure(
        url.hostname === 'my.gladysassistant.com' ? FINISH_TEXTS.bouncePage : FINISH_TEXTS.noCode,
      );
    }
    const config = getConfig();
    if (!config.client_id || !config.client_secret) {
      throw new ActionFailure(FINISH_TEXTS.noApplication);
    }
    // The anti-CSRF check of the redirect flow, on the value SolarEdge echoes:
    // a code pasted from a flow this instance never started is refused.
    if (!pendingStates.delete(params.get('external_id'))) {
      throw new ActionFailure(FINISH_TEXTS.unknownFlow);
    }
    const siteId = /^\d+$/.test(params.get('site_id') ?? '') ? params.get('site_id') : null;
    // SolarEdge redirected to the Redirect URI saved on the application: the
    // address without its query string, which the token exchange repeats.
    await complete({
      code,
      redirectUri: `${url.origin}${url.pathname}`,
      siteId,
      refused: (err) => new ActionFailure(FINISH_TEXTS.refused(err.message)),
    });
    return FINISH_TEXTS.connected(siteId ?? config.site_id);
  }

  async function callback(key, { code, state, redirectUri }) {
    if (key !== OAUTH_FIELD || !pendingStates.delete(state)) {
      throw new Error('Unexpected authorization answer (state mismatch): press "Connect" again.');
    }
    await complete({
      code,
      redirectUri,
      refused: (err) =>
        new Error(`SolarEdge refused the authorization: ${err.message}`, { cause: err }),
    });
  }

  return { authorizeUrl, callback, finish };
}
