// -----------------------------------------------------------------------------
// Device: SOLAR PRODUCTION.
//
// The inverter side of the installation, always present on a SolarEdge site:
// instantaneous PV power plus the production counters (day, month, year,
// lifetime) and the revenue SolarEdge computes from the site's tariff.
//
// All values come from the SHARED snapshot (src/solaredge/service.js): this
// module never calls the API itself, so adding a device never adds a request.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { CURRENCY_UNITS } from '../config.js';
import { GLADYS_POLL_FREQUENCY, publishStates } from './helpers.js';

const DEVICE_TYPE = 'solaredge-production';

const logger = createLogger({ name: 'production' });

const FEATURE = {
  POWER: 'power',
  ENERGY_TODAY: 'energy-today',
  ENERGY_MONTH: 'energy-month',
  ENERGY_YEAR: 'energy-year',
  ENERGY_TOTAL: 'energy-total',
  REVENUE_TODAY: 'revenue-today',
};

export const production = {
  key: DEVICE_TYPE,

  // Always available: a SolarEdge site without production does not exist.
  isAvailable() {
    return true;
  },

  deviceExternalId(gladys, { siteId }) {
    return gladys.externalIds(DEVICE_TYPE, siteId).device;
  },

  buildDevice(gladys, { siteId, config, site, capabilities }) {
    const ids = gladys.externalIds(DEVICE_TYPE, siteId);
    // `peakPower` is in kW in the site details: it is the natural ceiling of
    // the power feature, and it makes the Gladys charts scale correctly.
    const peakPowerWatts = Number(site?.peakPower) > 0 ? Math.round(site.peakPower * 1000) : 20_000;

    const features = [
      {
        name: 'Puissance produite',
        external_id: ids.feature(FEATURE.POWER),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
        unit: DEVICE_FEATURE_UNITS.WATT,
        min: 0,
        max: peakPowerWatts,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Production du jour',
        external_id: ids.feature(FEATURE.ENERGY_TODAY),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: 1000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Production du mois',
        external_id: ids.feature(FEATURE.ENERGY_MONTH),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: 100_000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: "Production de l'année",
        external_id: ids.feature(FEATURE.ENERGY_YEAR),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: 1_000_000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        // Lifetime counter: an INDEX in the Gladys sense (monotonic total).
        name: 'Production totale',
        external_id: ids.feature(FEATURE.ENERGY_TOTAL),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.INDEX,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: 100_000_000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ];

    // Only when SolarEdge actually computes a revenue for this site, i.e. when
    // a feed-in tariff has been entered in the monitoring portal. Otherwise the
    // API reports none and the feature would sit on "no recent value" forever,
    // which reads as a broken sensor rather than as an unconfigured option.
    if (capabilities?.revenue) {
      features.push({
        name: 'Revenu du jour',
        external_id: ids.feature(FEATURE.REVENUE_TODAY),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION_REVENUE,
        unit: CURRENCY_UNITS[config.currency],
        min: 0,
        max: 100_000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      });
    }

    return {
      name: 'SolarEdge — Production solaire',
      external_id: ids.device,
      should_poll: true,
      poll_frequency: GLADYS_POLL_FREQUENCY,
      features,
    };
  },

  async onPoll(gladys, context, snapshot) {
    const ids = gladys.externalIds(DEVICE_TYPE, context.siteId);
    const { flow, overview } = snapshot;

    // `currentPowerFlow` is the freshest source for the instantaneous power;
    // `overview` is the fallback for sites whose flow endpoint stays empty.
    const power = flow?.pv ?? overview?.currentPower ?? null;

    const entries = [
      [ids.feature(FEATURE.POWER), power],
      [ids.feature(FEATURE.ENERGY_TODAY), overview?.energyToday],
      [ids.feature(FEATURE.ENERGY_MONTH), overview?.energyMonth],
      [ids.feature(FEATURE.ENERGY_YEAR), overview?.energyYear],
      [ids.feature(FEATURE.ENERGY_TOTAL), overview?.energyLifetime],
    ];
    // Guarded by the capability, not just by the value: publishing a state for
    // a feature that was never declared would be refused by the host API.
    if (context.capabilities?.revenue) {
      entries.push([ids.feature(FEATURE.REVENUE_TODAY), overview?.revenueToday]);
    }

    const states = await publishStates(gladys, entries);

    logger.info(`Production: ${power ?? '?'} W, ${overview?.energyToday ?? '?'} kWh today`);
    return states;
  },
};
