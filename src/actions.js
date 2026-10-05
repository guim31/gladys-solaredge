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

const logger = createLogger({ name: 'actions' });

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
    const peak = Number(site?.peakPower) > 0 ? `${site.peakPower} kWc` : 'puissance inconnue';
    const devices = describeCapabilities(capabilities);

    return {
      en: `Connected to "${name}" (id ${siteId}, ${peak}). Devices available: ${devices.en}.`,
      fr: `Connecté à « ${name} » (id ${siteId}, ${peak}). Appareils disponibles : ${devices.fr}.`,
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
      };
    }
    const list = sites.map((site) => `${site.id} — ${site.name}`).join(' | ');
    return {
      en: `${sites.length} site(s): ${list}. Copy the id into the "Site ID" setting.`,
      fr: `${sites.length} site(s) : ${list}. Copiez l'identifiant dans le réglage « Identifiant du site ».`,
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
    };
  },
};

function describeCapabilities(capabilities) {
  const en = ['solar production'];
  const fr = ['production solaire'];
  if (capabilities.consumption) {
    en.push('consumption');
    fr.push('consommation');
  }
  if (capabilities.grid) {
    en.push('grid');
    fr.push('réseau');
  }
  if (capabilities.battery) {
    en.push('battery');
    fr.push('batterie');
  }
  return { en: en.join(', '), fr: fr.join(', ') };
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
    };
  }

  switch (err?.code) {
    case ERROR_CODES.UNAUTHORIZED:
      return {
        en: 'SolarEdge refused the API key: check it in the monitoring portal (Admin > Site Access).',
        fr: "SolarEdge a refusé la clé d'API : vérifiez-la dans le portail de supervision (Admin > Accès au site).",
      };
    case ERROR_CODES.NOT_FOUND:
      return {
        en: `SolarEdge could not resolve the site: ${err.message}`,
        fr: `Site SolarEdge introuvable : ${err.message}`,
      };
    case ERROR_CODES.QUOTA_EXCEEDED:
    case ERROR_CODES.RATE_LIMITED:
      return {
        en: 'SolarEdge daily request quota reached: increase the refresh interval, retry tomorrow.',
        fr: "Quota de requêtes SolarEdge atteint : augmentez l'intervalle de rafraîchissement et réessayez demain.",
      };
    default:
      return {
        en: `Could not reach SolarEdge: ${err?.message ?? 'unknown error'}`,
        fr: `Impossible de joindre SolarEdge : ${err?.message ?? 'erreur inconnue'}`,
      };
  }
}
