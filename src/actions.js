// -----------------------------------------------------------------------------
// Manifest actions: the buttons of the Configuration screen.
//
// Each key matches an entry of the `actions` field of
// `gladys-assistant-integration.json` (a unit test keeps both in sync). The
// resolved message — a multi-language object — is displayed under the button;
// a thrown error is displayed the same way, so the handlers let SolarEdge
// errors bubble up with their own wording.
//
// Handlers receive the integration runtime (`deps`) rather than closing over
// module state: index.js owns the lifecycle, this file owns the wording.
//
// The same file holds the dashboard widget buttons (WIDGET_ACTIONS) and the
// wording of the failures shown to the user (describeError): one place to read
// to know what the user sees.
// -----------------------------------------------------------------------------

import { createLogger, GladysApiError } from '@gladysassistant/integration-sdk';
import { ERROR_CODES } from './solaredge/client.js';
import { WIDGET_ACTION } from './widgets.js';
import { localize } from './i18n.js';

const logger = createLogger({ name: 'actions' });

/**
 * What the user reads, from a button or a widget, while no API key is set.
 * Resolved rather than thrown: a thrown error reaches Gladys as a single
 * string (`error: e.message`), so only a resolved message can be multilingual.
 */
export const NOT_CONFIGURED_MESSAGE = {
  en: 'The integration is not configured yet: paste your SolarEdge API key in the settings.',
  fr: "L'intégration n'est pas configurée : renseignez votre clé d'API SolarEdge dans les réglages.",
  de: 'Die Integration ist noch nicht konfiguriert: Füge deinen SolarEdge-API-Schlüssel in den Einstellungen ein.',
  es: 'La integración aún no está configurada: introduzca su clave de API de SolarEdge en la configuración.',
};

/** Connection status shown while no API key is set. */
export const MISSING_KEY_STATUS = {
  en: 'Paste your SolarEdge Monitoring API key in the settings above.',
  fr: "Renseignez votre clé d'API SolarEdge Monitoring dans les réglages ci-dessus.",
  de: 'Füge deinen SolarEdge-Monitoring-API-Schlüssel oben in den Einstellungen ein.',
  es: 'Introduzca su clave de API de SolarEdge Monitoring en la configuración de arriba.',
};

/**
 * Connection status shown when the daily budget is too low to detect the
 * installation.
 * @param {{ count: number, limit: number }} usage
 */
export function quotaNearlySpentStatus({ count, limit }) {
  return {
    en: `SolarEdge daily quota nearly spent (${count}/${limit}). Detection resumes tomorrow, or raise the refresh interval.`,
    fr: `Quota SolarEdge presque épuisé (${count}/${limit}). La détection reprendra demain ; augmentez l'intervalle de rafraîchissement.`,
    de: `SolarEdge-Tageskontingent fast aufgebraucht (${count}/${limit}). Die Erkennung wird morgen fortgesetzt; erhöhe das Aktualisierungsintervall.`,
    es: `Cuota diaria de SolarEdge casi agotada (${count}/${limit}). La detección se reanudará mañana; aumente el intervalo de actualización.`,
  };
}

/** Badge message of the devices while the daily quota is spent. */
export const QUOTA_TRANSPORT_MESSAGE = {
  en: 'SolarEdge daily request quota reached: values refresh again tomorrow.',
  fr: 'Quota de requêtes SolarEdge atteint : les valeurs repartiront demain.',
  de: 'Tageskontingent an SolarEdge-Anfragen erreicht: Die Werte werden morgen wieder aktualisiert.',
  es: 'Cuota diaria de solicitudes de SolarEdge alcanzada: los valores se actualizarán de nuevo mañana.',
};

/** The rated power of a site, or what to say without it. */
const PEAK_UNIT = { en: 'kWp', fr: 'kWc', de: 'kWp', es: 'kWp' };
const UNKNOWN_PEAK = {
  en: 'unknown power',
  fr: 'puissance inconnue',
  de: 'Leistung unbekannt',
  es: 'potencia desconocida',
};

/** "1 Zustand" / "2 Zustände": German has no "(s)" shortcut. */
function plural(count, one, many) {
  return count === 1 ? one : many;
}

export const ACTIONS = {
  /**
   * "Test the connection": the button a user presses right after pasting an
   * API key. It answers the three questions they actually have — is the key
   * valid, which site did we land on, and what will this integration create.
   */
  async test_connection(gladys, { service }) {
    logger.info('Action test_connection');
    const siteId = await service.resolveSiteId();
    const site = await service.getSite();
    const capabilities = await service.getCapabilities({ force: true });

    const name = site?.name ?? `site ${siteId}`;
    const peak = localize((language) =>
      Number(site?.peakPower) > 0
        ? `${site.peakPower} ${PEAK_UNIT[language]}`
        : UNKNOWN_PEAK[language],
    );
    const devices = describeCapabilities(capabilities);

    return {
      en: `Connected to "${name}" (id ${siteId}, ${peak.en}). Devices available: ${devices.en}.`,
      fr: `Connecté à « ${name} » (id ${siteId}, ${peak.fr}). Appareils disponibles : ${devices.fr}.`,
      de: `Verbunden mit „${name}“ (ID ${siteId}, ${peak.de}). Verfügbare Geräte: ${devices.de}.`,
      es: `Conectado a «${name}» (ID ${siteId}, ${peak.es}). Dispositivos disponibles: ${devices.es}.`,
    };
  },

  /**
   * "List my sites": what to press when the API key covers several
   * installations and Gladys needs to be told which one to follow.
   */
  async list_sites(gladys, { service }) {
    logger.info('Action list_sites');
    const sites = await service.listSites();
    if (sites.length === 0) {
      return {
        en: 'This API key gives access to no site.',
        fr: "Cette clé d'API ne donne accès à aucun site.",
        de: 'Dieser API-Schlüssel gibt Zugriff auf keinen Standort.',
        es: 'Esta clave de API no da acceso a ningún sitio.',
      };
    }
    const list = sites.map((site) => `${site.id} — ${site.name}`).join(' | ');
    return {
      en: `${sites.length} site(s): ${list}. Copy the id into the "Site ID" setting.`,
      fr: `${sites.length} site(s) : ${list}. Copiez l'identifiant dans le réglage « Identifiant du site ».`,
      de: `${sites.length} ${plural(sites.length, 'Standort', 'Standorte')}: ${list}. Kopiere die ID in die Einstellung „Standort-ID“.`,
      es: `${sites.length} sitio(s): ${list}. Copie el ID en el ajuste «ID del sitio».`,
    };
  },

  /**
   * "Refresh now": bypass the polling interval, for the user who just changed
   * something on the roof and does not want to wait fifteen minutes.
   */
  async refresh_now(gladys, { refreshAll }) {
    logger.info('Action refresh_now');
    const count = await refreshAll();
    return {
      en: `Refreshed: ${count} state(s) published.`,
      fr: `Rafraîchi : ${count} état(s) publié(s).`,
      de: `Aktualisiert: ${count} ${plural(count, 'Zustand', 'Zustände')} veröffentlicht.`,
      es: `Actualizado: ${count} estado(s) publicado(s).`,
    };
  },

  /**
   * "API usage": SolarEdge allows 300 requests per day and answers 429 past
   * that. This button says where we stand — the first thing to look at when
   * the values stop moving in the afternoon.
   */
  async api_usage(gladys, { service, config }) {
    const { count, limit, remaining } = service.usage;
    const perCycle = config.storage_details ? 3 : 2;
    const cyclesLeft = Math.floor(remaining / perCycle);
    return {
      en: `${count}/${limit} SolarEdge requests used today (UTC). ${remaining} left, about ${cyclesLeft} refresh cycle(s).`,
      fr: `${count}/${limit} requêtes SolarEdge utilisées aujourd'hui (UTC). Il en reste ${remaining}, soit environ ${cyclesLeft} cycle(s) de rafraîchissement.`,
      de: `${count}/${limit} SolarEdge-Anfragen heute verbraucht (UTC). Noch ${remaining} übrig, also etwa ${cyclesLeft} ${plural(cyclesLeft, 'Aktualisierungszyklus', 'Aktualisierungszyklen')}.`,
      es: `${count}/${limit} solicitudes de SolarEdge usadas hoy (UTC). Quedan ${remaining}, es decir, unos ${cyclesLeft} ciclo(s) de actualización.`,
    };
  },
};

/** What test_connection lists, per capability (production is always there). */
const CAPABILITY_NAMES = {
  production: {
    en: 'solar production',
    fr: 'production solaire',
    de: 'Solarproduktion',
    es: 'producción solar',
  },
  consumption: { en: 'consumption', fr: 'consommation', de: 'Verbrauch', es: 'consumo' },
  grid: { en: 'grid', fr: 'réseau', de: 'Netz', es: 'red' },
  battery: { en: 'battery', fr: 'batterie', de: 'Batterie', es: 'batería' },
};

function describeCapabilities(capabilities) {
  const names = [CAPABILITY_NAMES.production];
  for (const key of ['consumption', 'grid', 'battery']) {
    if (capabilities[key]) {
      names.push(CAPABILITY_NAMES[key]);
    }
  }
  return localize((language) => names.map((name) => name[language]).join(', '));
}

/**
 * Buttons of the dashboard widgets (`action.key` of a `button` component),
 * resolved to the toast the core shows. Unlike a manifest action, a widget
 * action that throws shows the user a bare failure: these handlers catch what
 * SolarEdge refuses and answer with the same wording as the status screen.
 */
export const WIDGET_ACTIONS = {
  /**
   * "Refresh" on the energy_flow widget: the "Refresh now" action, from the
   * dashboard. It goes through the same client-side budget: once the daily
   * quota is spent, the toast says so instead of a failed request.
   */
  async [WIDGET_ACTION.REFRESH](gladys, deps) {
    logger.info('Widget action refresh');
    try {
      return await ACTIONS.refresh_now(gladys, deps);
    } catch (err) {
      logger.warn(`Widget refresh refused: ${err.message}`);
      return describeError(err);
    }
  },
};

/** Turn a failure into something the user can act on. */
export function describeError(err) {
  // A GladysApiError means the HOST refused us — a rejected discovery payload,
  // an expired integration token — not SolarEdge. Blaming SolarEdge here would
  // send the user hunting through the monitoring portal for nothing.
  if (err instanceof GladysApiError) {
    return {
      en: `Gladys refused the request (${err.code} / HTTP ${err.status}): ${err.message}`,
      fr: `Gladys a refusé la requête (${err.code} / HTTP ${err.status}) : ${err.message}`,
      de: `Gladys hat die Anfrage abgelehnt (${err.code} / HTTP ${err.status}): ${err.message}`,
      es: `Gladys rechazó la solicitud (${err.code} / HTTP ${err.status}): ${err.message}`,
    };
  }

  switch (err?.code) {
    case ERROR_CODES.UNAUTHORIZED:
      return {
        en: 'SolarEdge refused the API key: check it in the monitoring portal (Admin > Site Access).',
        fr: "SolarEdge a refusé la clé d'API : vérifiez-la dans le portail de supervision (Admin > Accès au site).",
        de: 'SolarEdge hat den API-Schlüssel abgelehnt: Prüfe ihn im Monitoring-Portal (Admin > Site Access).',
        es: 'SolarEdge rechazó la clave de API: compruébela en el portal de monitorización (Admin > Site Access).',
      };
    case ERROR_CODES.NOT_FOUND:
      return {
        en: `SolarEdge could not resolve the site: ${err.message}`,
        fr: `Site SolarEdge introuvable : ${err.message}`,
        de: `SolarEdge-Standort nicht gefunden: ${err.message}`,
        es: `No se encontró el sitio de SolarEdge: ${err.message}`,
      };
    case ERROR_CODES.QUOTA_EXCEEDED:
    case ERROR_CODES.RATE_LIMITED:
      return {
        en: 'SolarEdge daily request quota reached: increase the refresh interval, retry tomorrow.',
        fr: "Quota de requêtes SolarEdge atteint : augmentez l'intervalle de rafraîchissement et réessayez demain.",
        de: 'Tageskontingent an SolarEdge-Anfragen erreicht: Erhöhe das Aktualisierungsintervall und versuche es morgen erneut.',
        es: 'Cuota diaria de solicitudes de SolarEdge alcanzada: aumente el intervalo de actualización y vuelva a intentarlo mañana.',
      };
    case ERROR_CODES.NOT_READY:
      return {
        en: 'The integration has not reached SolarEdge yet: check the connection status above.',
        fr: "L'intégration n'a pas encore pu joindre SolarEdge : vérifiez l'état de la connexion ci-dessus.",
        de: 'Die Integration konnte SolarEdge noch nicht erreichen: Prüfe den Verbindungsstatus oben.',
        es: 'La integración aún no ha podido conectar con SolarEdge: revise el estado de la conexión más arriba.',
      };
    default:
      return {
        en: `Could not reach SolarEdge: ${err?.message ?? 'unknown error'}`,
        fr: `Impossible de joindre SolarEdge : ${err?.message ?? 'erreur inconnue'}`,
        de: `SolarEdge nicht erreichbar: ${err?.message ?? 'unbekannter Fehler'}`,
        es: `No se puede conectar con SolarEdge: ${err?.message ?? 'error desconocido'}`,
      };
  }
}
