// -----------------------------------------------------------------------------
// Device: HOME BATTERY (SolarEdge Energy Bank / LG RESU…).
//
// Only published when the site really has storage — `currentPowerFlow` exposes
// a STORAGE node in that case, and nothing at all otherwise.
//
// Like the grid device, the battery power is SIGNED:
//     > 0  charging (energy going INTO the battery)
//     < 0  discharging (the battery is powering the house)
//
// Two extra features (stored energy, temperature) come from the `storageData`
// endpoint, which costs one more request per cycle: they only exist when the
// user turns the "Detailed battery telemetry" setting on.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { BATTERY_STATES } from '../solaredge/snapshot.js';
import { GLADYS_POLL_FREQUENCY, publishStates } from './helpers.js';

const DEVICE_TYPE = 'solaredge-battery';

const logger = createLogger({ name: 'battery' });

const FEATURE = {
  LEVEL: 'charge-level',
  POWER: 'power',
  STATE: 'state',
  CRITICAL: 'critical',
  ENERGY_STORED: 'energy-stored',
  TEMPERATURE: 'temperature',
};

/** Human-readable, localized label of each battery state. */
const STATE_LABELS = {
  [BATTERY_STATES.CHARGING]: 'En charge',
  [BATTERY_STATES.DISCHARGING]: 'En décharge',
  [BATTERY_STATES.IDLE]: 'Au repos',
  [BATTERY_STATES.DISABLED]: 'Désactivée',
};

export const battery = {
  key: DEVICE_TYPE,

  isAvailable(capabilities) {
    return capabilities.battery === true;
  },

  deviceExternalId(gladys, { siteId }) {
    return gladys.externalIds(DEVICE_TYPE, siteId).device;
  },

  buildDevice(gladys, { siteId, config }) {
    const ids = gladys.externalIds(DEVICE_TYPE, siteId);
    const features = [
      {
        name: 'Niveau de charge',
        external_id: ids.feature(FEATURE.LEVEL),
        category: DEVICE_FEATURE_CATEGORIES.BATTERY,
        type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Puissance batterie (+ charge / − décharge)',
        external_id: ids.feature(FEATURE.POWER),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
        unit: DEVICE_FEATURE_UNITS.WATT,
        min: -20_000,
        max: 20_000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'État de la batterie',
        external_id: ids.feature(FEATURE.STATE),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        // SolarEdge's own "critical" flag: the pack is at its reserve level.
        name: 'Batterie faible',
        external_id: ids.feature(FEATURE.CRITICAL),
        category: DEVICE_FEATURE_CATEGORIES.BATTERY_LOW,
        type: DEVICE_FEATURE_TYPES.BATTERY_LOW.BINARY,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ];

    if (config.storage_details) {
      features.push(
        {
          name: 'Énergie stockée',
          external_id: ids.feature(FEATURE.ENERGY_STORED),
          category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
          type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
          unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
          min: 0,
          max: 100,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
        {
          name: 'Température batterie',
          external_id: ids.feature(FEATURE.TEMPERATURE),
          category: DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR,
          type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
          unit: DEVICE_FEATURE_UNITS.CELSIUS,
          min: -20,
          max: 80,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
      );
    }

    return {
      name: 'SolarEdge — Batterie',
      external_id: ids.device,
      poll_frequency: GLADYS_POLL_FREQUENCY,
      features,
    };
  },

  async onPoll(gladys, context, snapshot) {
    const ids = gladys.externalIds(DEVICE_TYPE, context.siteId);
    const battery = snapshot.flow?.battery;
    if (!battery) {
      logger.debug('No battery in the snapshot, nothing to publish');
      return [];
    }

    // `storageData` gives a finer state of charge than the power flow when the
    // user enabled it; otherwise the flow's `chargeLevel` is the reference.
    const level = snapshot.storage?.level ?? battery.level;

    const numericStates = [
      [ids.feature(FEATURE.LEVEL), level],
      [ids.feature(FEATURE.POWER), battery.power],
      [ids.feature(FEATURE.CRITICAL), battery.critical ? 1 : 0],
    ];
    if (context.config.storage_details) {
      numericStates.push(
        [ids.feature(FEATURE.ENERGY_STORED), snapshot.storage?.energyStored],
        [ids.feature(FEATURE.TEMPERATURE), snapshot.storage?.temperature],
      );
    }

    const states = await publishStates(gladys, numericStates);

    // The text state travels on its own call: `publishStates` carries numbers.
    await gladys.publishState(ids.feature(FEATURE.STATE), {
      text: STATE_LABELS[battery.state] ?? battery.state,
    });

    logger.info(`Battery: ${level ?? '?'}%, ${battery.power ?? '?'} W (${battery.state})`);
    return states;
  },
};
