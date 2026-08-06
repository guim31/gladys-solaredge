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
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

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
