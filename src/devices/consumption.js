// -----------------------------------------------------------------------------
// Device: HOME CONSUMPTION.
//
// Only published when the installation has a consumption meter (SolarEdge
// Modbus meter): without it, `currentPowerFlow` has no LOAD node and
// `energyDetails` reports no Consumption meter, so the device would stay empty
// forever — better not to create it at all.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { publishStates } from './helpers.js';

const DEVICE_TYPE = 'solaredge-consumption';

const logger = createLogger({ name: 'consumption' });

const FEATURE = {
  POWER: 'power',
  ENERGY_TODAY: 'energy-today',
  SELF_CONSUMPTION_TODAY: 'self-consumption-today',
};

export const consumption = {
  key: DEVICE_TYPE,

  isAvailable(capabilities) {
    return capabilities.consumption === true;
  },

  deviceExternalId(gladys, { siteId }) {
    return gladys.externalIds(DEVICE_TYPE, siteId).device;
  },

  buildDevice(gladys, { siteId, config }) {
    const ids = gladys.externalIds(DEVICE_TYPE, siteId);
    return {
      name: 'SolarEdge — Consommation',
      external_id: ids.device,
      poll_frequency: config.poll_frequency,
      features: [
        {
          name: 'Puissance consommée',
          external_id: ids.feature(FEATURE.POWER),
          category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
          type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
          unit: DEVICE_FEATURE_UNITS.WATT,
          min: 0,
          max: 30_000,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
        {
          name: 'Consommation du jour',
          external_id: ids.feature(FEATURE.ENERGY_TODAY),
          category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
          type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.DAILY_CONSUMPTION,
          unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
          min: 0,
          max: 1000,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
        {
          // Share of today's consumption covered by the panels (and the
          // battery) instead of the grid — the number that tells whether the
          // installation is actually paying for itself.
          name: 'Autoconsommation du jour',
          external_id: ids.feature(FEATURE.SELF_CONSUMPTION_TODAY),
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
      [ids.feature(FEATURE.POWER), flow?.load],
      [ids.feature(FEATURE.ENERGY_TODAY), energy?.consumption],
      [ids.feature(FEATURE.SELF_CONSUMPTION_TODAY), energy?.selfConsumption],
    ]);

    logger.info(`Consumption: ${flow?.load ?? '?'} W, ${energy?.consumption ?? '?'} kWh today`);
    return states;
  },
};
