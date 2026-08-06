// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates  -> record calls so tests can assert them
//   - publishTransports             -> record calls so tests can assert them
//   - setConnectionStatus           -> record calls so tests can assert them
// This lets us test the wiring (discovery payloads, dispatch, published
// states) without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];
  const texts = [];
  const transports = [];
  const connectionStatuses = [];

  return {
    published,
    texts,
    transports,
    connectionStatuses,

    externalIds(type, platformId) {
      const device = `ext:solaredge:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, value) {
      if (value && typeof value === 'object' && 'text' in value) {
        texts.push({ featureExternalId, text: value.text });
      } else {
        published.push({ featureExternalId, state: value });
      }
    },

    async publishStates(states) {
      for (const s of states) {
        published.push({ featureExternalId: s.device_feature_external_id, state: s.state });
      }
    },

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
}

/** Look up a published state by the suffix of its feature external_id. */
export function stateOf(gladys, suffix) {
  return gladys.published.find((entry) => entry.featureExternalId.endsWith(`:${suffix}`))?.state;
}
