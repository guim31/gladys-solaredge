# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release. The notes of 1.4.0 and earlier are in
the GitHub Releases of the repository.

## [Unreleased]

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
