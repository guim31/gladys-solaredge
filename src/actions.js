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
 * What the user reads, from a button or a widget, while SolarEdge cannot be
 * reached yet. Resolved rather than thrown: a thrown error reaches Gladys as a
 * single string (`error: e.message`), so only a resolved message can be
 * multilingual.
 */
export const NOT_CONFIGURED_MESSAGE = {
  en: 'The integration is not connected to SolarEdge yet: fill in your developer application settings and press "Connect".',
  fr: "L'intégration n'est pas encore connectée à SolarEdge : renseignez votre application développeur et appuyez sur « Connecter ».",
  de: 'Die Integration ist noch nicht mit SolarEdge verbunden: Trage deine Entwickler-Anwendung ein und klicke auf „Verbinden“.',
  es: 'La integración aún no está conectada a SolarEdge: introduzca los datos de su aplicación de desarrollador y pulse «Conectar».',
};

/**
 * Connection status while nothing usable is configured. Version 1.x users land
 * here with a retired V1 key, which is why it names the retirement first.
 */
export const MISSING_KEY_STATUS = {
  en: 'SolarEdge retired its V1 API on 3 November 2026: create a SolarEdge developer account and a "Site Access" application, fill in its Client ID, Client Secret and your Site ID, then press "Connect" (see the documentation).',
  fr: "SolarEdge a arrêté son API V1 le 3 novembre 2026 : créez un compte développeur SolarEdge et une application « Site Access », renseignez son Client ID, son Client Secret et l'identifiant de votre site, puis appuyez sur « Connecter » (voir la documentation).",
  de: 'SolarEdge hat seine V1-API am 3. November 2026 abgeschaltet: Lege ein SolarEdge-Entwicklerkonto und eine „Site Access“-Anwendung an, trage deren Client ID, Client Secret und deine Standort-ID ein und klicke dann auf „Verbinden“ (siehe Dokumentation).',
  es: 'SolarEdge retiró su API V1 el 3 de noviembre de 2026: cree una cuenta de desarrollador de SolarEdge y una aplicación «Site Access», introduzca su Client ID, su Client Secret y el ID de su sitio, y pulse «Conectar» (consulte la documentación).',
};

/** Connection status once the application is filled in, before "Connect". */
export const CONNECT_STATUS = {
  en: 'Press "Connect" and approve access to your site with your SolarEdge (mySolarEdge) login.',
  fr: "Appuyez sur « Connecter » et autorisez l'accès à votre site avec vos identifiants SolarEdge (mySolarEdge).",
  de: 'Klicke auf „Verbinden“ und erlaube den Zugriff auf deinen Standort mit deinen SolarEdge-Zugangsdaten (mySolarEdge).',
  es: 'Pulse «Conectar» y autorice el acceso a su sitio con sus credenciales de SolarEdge (mySolarEdge).',
};

/**
 * Connection status when the daily budget is too low to detect the
 * installation.
 * @param {{ count: number, limit: number }} usage
 */
export function quotaNearlySpentStatus({ count, limit }) {
  return {
    en: `SolarEdge daily request budget nearly spent (${count}/${limit}). Detection resumes tomorrow (UTC).`,
    fr: `Budget quotidien de requêtes SolarEdge presque épuisé (${count}/${limit}). La détection reprendra demain (UTC).`,
    de: `Tagesbudget an SolarEdge-Anfragen fast aufgebraucht (${count}/${limit}). Die Erkennung wird morgen (UTC) fortgesetzt.`,
    es: `Presupuesto diario de solicitudes de SolarEdge casi agotado (${count}/${limit}). La detección se reanudará mañana (UTC).`,
  };
}

/** Badge message of the devices while the daily quota is spent. */
export const QUOTA_TRANSPORT_MESSAGE = {
  en: 'SolarEdge request budget reached: values refresh again tomorrow.',
  fr: 'Budget de requêtes SolarEdge atteint : les valeurs repartiront demain.',
  de: 'Budget an SolarEdge-Anfragen erreicht: Die Werte werden morgen wieder aktualisiert.',
  es: 'Presupuesto de solicitudes de SolarEdge alcanzado: los valores se actualizarán de nuevo mañana.',
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
   * credentials. It answers the three questions they actually have — is the
   * access valid, which site did we land on, and what will this integration create.
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
   * "List my sites": what to press when a Fleet API key covers several
   * installations and Gladys needs to be told which one to follow (with
   * "Connect", the one authorized site).
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
    const list = sites.map((site) => `${site.siteId} — ${site.name}`).join(' | ');
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
   * "API usage": the Free tier gives 2,000 credits a month, spent at one per
   * call. This button says where today stands against the daily share, and
   * how often the integration actually refreshes to stay within it.
   */
  async api_usage(gladys, { service, config }) {
    const { count, limit, remaining } = service.usage;
    const minutes = Math.round(service.refreshInterval() / 60);
    const perCycle = service.callsPerCycle;
    return {
      en: `${count}/${limit} SolarEdge requests used today (UTC), ${remaining} left: the daily share of ${config.monthly_credits} credits a month. One refresh costs ${perCycle} request(s): the values refresh every ${minutes} min.`,
      fr: `${count}/${limit} requêtes SolarEdge utilisées aujourd'hui (UTC), il en reste ${remaining} : la part quotidienne de ${config.monthly_credits} crédits par mois. Un rafraîchissement coûte ${perCycle} requête(s) : les valeurs sont rafraîchies toutes les ${minutes} min.`,
      de: `${count}/${limit} SolarEdge-Anfragen heute verbraucht (UTC), noch ${remaining} übrig: der Tagesanteil von ${config.monthly_credits} Credits pro Monat. Eine Aktualisierung kostet ${perCycle} ${plural(perCycle, 'Anfrage', 'Anfragen')}: Die Werte werden alle ${minutes} Min. aktualisiert.`,
      es: `${count}/${limit} solicitudes de SolarEdge usadas hoy (UTC), quedan ${remaining}: la parte diaria de ${config.monthly_credits} créditos al mes. Una actualización consume ${perCycle} solicitud(es): los valores se actualizan cada ${minutes} min.`,
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
    case ERROR_CODES.API_RETIRED:
      return {
        en: 'SolarEdge retired its V1 API on 3 Nov 2026: migrate to V2 (developer account, then "Connect": see the documentation).',
        fr: 'SolarEdge a arrêté son API V1 le 3 nov. 2026 : migrez vers la V2 (compte développeur, puis « Connecter » : voir la documentation).',
        de: 'SolarEdge hat seine V1-API am 3. Nov. 2026 abgeschaltet: Wechsle zu V2 (Entwicklerkonto, dann „Verbinden“: siehe Dokumentation).',
        es: 'SolarEdge retiró su API V1 el 3 nov. 2026: migre a la V2 (cuenta de desarrollador y luego «Conectar»: consulte la documentación).',
      };
    case ERROR_CODES.UNAUTHORIZED:
      return {
        en: 'SolarEdge refused access: check the Site ID. V1 API keys stopped working on 3 Nov 2026: use "Connect" (or a V2 Fleet key).',
        fr: "SolarEdge a refusé l'accès : vérifiez l'identifiant du site. Les clés d'API V1 ne marchent plus depuis le 3 nov. 2026 : utilisez « Connecter » (ou une clé Fleet V2).",
        de: 'SolarEdge hat den Zugriff verweigert: Prüfe die Standort-ID. V1-API-Schlüssel gehen seit 3. Nov. 2026 nicht mehr: Nutze „Verbinden“ (oder einen V2-Fleet-Schlüssel).',
        es: 'SolarEdge denegó el acceso: compruebe el ID del sitio. Las claves V1 no funcionan desde el 3 nov. 2026: use «Conectar» (o una clave Fleet V2).',
      };
    case ERROR_CODES.RECONNECT:
      return {
        en: 'SolarEdge access expired or was refused: check the Client Secret, then press "Connect" again.',
        fr: "L'accès à SolarEdge a expiré ou a été refusé : vérifiez le Client Secret, puis appuyez de nouveau sur « Connecter ».",
        de: 'Der SolarEdge-Zugriff ist abgelaufen oder wurde verweigert: Prüfe das Client Secret und klicke erneut auf „Verbinden“.',
        es: 'El acceso a SolarEdge caducó o fue rechazado: compruebe el Client Secret y pulse de nuevo «Conectar».',
      };
    case ERROR_CODES.TIER:
      return {
        en: 'This SolarEdge data needs a paid developer plan.',
        fr: 'Cette donnée SolarEdge demande une offre développeur payante.',
        de: 'Diese SolarEdge-Daten erfordern einen kostenpflichtigen Entwicklertarif.',
        es: 'Estos datos de SolarEdge requieren un plan de desarrollador de pago.',
      };
    case ERROR_CODES.CREDITS_EXHAUSTED:
      return {
        en: 'The monthly SolarEdge credits are spent: values come back at the next billing cycle. Check "Monthly credits".',
        fr: 'Les crédits SolarEdge du mois sont épuisés : les valeurs reviendront au prochain cycle de facturation. Vérifiez « Crédits mensuels ».',
        de: 'Die monatlichen SolarEdge-Credits sind aufgebraucht: Die Werte kommen im nächsten Abrechnungszyklus zurück. Prüfe „Monatliche Credits“.',
        es: 'Los créditos mensuales de SolarEdge se han agotado: los valores volverán en el próximo ciclo de facturación. Revise «Créditos mensuales».',
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
        en: 'SolarEdge request budget reached (daily share of the monthly credits, or calls per minute): retry later.',
        fr: 'Budget de requêtes SolarEdge atteint (part quotidienne des crédits mensuels, ou appels par minute) : réessayez plus tard.',
        de: 'Budget an SolarEdge-Anfragen erreicht (Tagesanteil der monatlichen Credits oder Aufrufe pro Minute): Versuche es später erneut.',
        es: 'Presupuesto de solicitudes de SolarEdge alcanzado (parte diaria de los créditos mensuales o llamadas por minuto): vuelva a intentarlo más tarde.',
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
