// -----------------------------------------------------------------------------
// Device: GRID EXCHANGES.
//
// What the house takes from — and gives back to — the public grid. The power
// is SIGNED so a single feature (and a single chart) tells the whole story:
//
//     > 0  the house is importing (soutirage)
//     < 0  the house is exporting its surplus (injection)
//       0  nothing crosses the meter
//
// This is the feature to use in a Gladys scene: "when grid power < -1000 W,
// start the water heater" is exactly "use the surplus instead of selling it".
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { GLADYS_POLL_FREQUENCY, publishStates } from './helpers.js';

const DEVICE_TYPE = 'solaredge-grid';

const logger = createLogger({ name: 'grid' });

const FEATURE = {
  POWER: 'power',
  IMPORTED_TODAY: 'imported-today',
  EXPORTED_TODAY: 'exported-today',
};

export const grid = {
  key: DEVICE_TYPE,

  isAvailable(capabilities) {
    return capabilities.grid === true;
  },

  deviceExternalId(gladys, { siteId }) {
    return gladys.externalIds(DEVICE_TYPE, siteId).device;
  },

  buildDevice(gladys, { siteId }) {
    const ids = gladys.externalIds(DEVICE_TYPE, siteId);
    return {
      name: 'SolarEdge — Réseau',
      external_id: ids.device,
      should_poll: true,
      poll_frequency: GLADYS_POLL_FREQUENCY,
      features: [
        {
          name: 'Puissance réseau (+ soutirée / − injectée)',
          external_id: ids.feature(FEATURE.POWER),
          category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
          type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
          unit: DEVICE_FEATURE_UNITS.WATT,
          // Negative minimum: the export side of the same measurement.
          min: -30_000,
          max: 30_000,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
        {
          name: 'Énergie soutirée du jour',
          external_id: ids.feature(FEATURE.IMPORTED_TODAY),
          category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
          type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
          unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
          min: 0,
          max: 1000,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
        {
          name: 'Énergie injectée du jour',
          external_id: ids.feature(FEATURE.EXPORTED_TODAY),
          category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
          type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
          unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
          min: 0,
          max: 1000,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
      ],
    };
  },

  async onPoll(gladys, context, snapshot) {
    const ids = gladys.externalIds(DEVICE_TYPE, context.siteId);
    const { flow, energy } = snapshot;

    const states = await publishStates(gladys, [
      [ids.feature(FEATURE.POWER), flow?.grid],
      [ids.feature(FEATURE.IMPORTED_TODAY), energy?.purchased],
      [ids.feature(FEATURE.EXPORTED_TODAY), energy?.feedIn],
    ]);

    logger.info(
      `Grid: ${flow?.grid ?? '?'} W, +${energy?.purchased ?? '?'} / -${energy?.feedIn ?? '?'} kWh today`,
    );
    return states;
  },
};
