# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release. The notes of 1.4.0 and earlier are in
the GitHub Releases of the repository.

## [Unreleased]

### Changed

- **SolarEdge Monitoring API V2.** SolarEdge retired the V1 API on
  3 November 2026: every request of versions 1.x now fails (HTTP 410, "API
  Version Deprecated"), and the old API keys no longer work. The integration
  now reads V2. **Action needed**: create a free SolarEdge developer account
  and a "Site Access" application, fill in its Client ID, Client Secret and
  your site ID, then press **Connect** (step by step in the documentation).
  Installers can paste a V2 Fleet API key instead. Devices, features and their
  history are kept.
- Requires **Gladys 5.2** or later (the "Connect" button).
- The refresh interval now adapts to the monthly SolarEdge credits (2,000 on
  the Free plan, new **Monthly credits** setting): about every 50 minutes for a
  lone inverter on the Free plan, as often as every 15 minutes on a paid plan.
  **API usage** shows the interval actually used.
- **Battery low** now means a charge level of 10 % or below: V2 no longer
  reports SolarEdge's "critical" flag.

### Removed

- **Revenue today** and the **Revenue currency** setting: V2 reports no
  revenue. On a site with a tariff, **Update** in the Discovery tab removes
  the feature.
- The **Daily breakdown interval** and **Daily request budget** settings,
  replaced by the paced interval and **Monthly credits**.

### Fixed

- A retired-API answer (HTTP 410) now says to migrate to V2, instead of
  "unexpected error".

### Security

- Rebuilt on Node.js 24.22.1, the October 2026 security release (remote code
  execution in the Brotli decoder, CVE-2026-111497; TLS hostname and DNS
  fixes).

### Fixed

- The values now refresh on the integration's own timer, at the "Refresh
  interval" of the configuration, instead of waiting for Gladys to poll each
  device: a device Gladys does not poll no longer stays without values. Gladys's
  polling is kept as a fallback and costs no extra SolarEdge request.
- A device just created or updated from the Discovery tab gets the current
  values at once, without waiting for the next refresh.

### Changed

- Quieter logs: the readings of each refresh are written at the `debug` level
  only, and a failure that repeats (SolarEdge unreachable, an endpoint in error,
  an initialization retry) is logged once, then once again when it recovers.
  `LOG_LEVEL=debug` still shows every detail.
- Integration SDK 0.15 and up-to-date development dependencies.
