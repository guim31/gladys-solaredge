# SolarEdge — Gladys Assistant external integration

External integration bringing a **SolarEdge** photovoltaic installation into
[Gladys Assistant](https://gladysassistant.com): solar production, home
consumption, grid exchanges and battery storage, read from the public
[SolarEdge Monitoring API](https://monitoringapi.solaredge.com).

Built on the official
[JavaScript integration SDK](https://github.com/GladysAssistant/integration-sdk-js)
and the structure of the
[official template](https://github.com/GladysAssistant/integration-template-js).

## Devices

Devices are created from what the installation actually reports — a site
without a consumption meter simply gets the production device.

| Device                         | Features                                                                                                                                                         | Created when      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| SolarEdge — Production solaire | PV power (W), production today / month / year / lifetime (kWh), today's revenue                                                                                  | always            |
| SolarEdge — Consommation       | Load power (W), consumption today (kWh), self-consumption today (kWh)                                                                                            | consumption meter |
| SolarEdge — Réseau             | Grid power (W, **signed**: + imported / − exported), imported today (kWh), exported today (kWh)                                                                  | grid metering     |
| SolarEdge — Batterie           | Charge level (%), battery power (W, **signed**: + charging / − discharging), state (text), low flag, and — optionally — stored energy (kWh) and temperature (°C) | battery installed |

Signed powers are the point: a single feature per flow, so a Gladys scene can
say "when grid power < −1000 W, start the water heater" — i.e. "use the
surplus instead of selling it".

## The constraint that shapes the design: 300 requests/day

SolarEdge allows **300 API requests per day and per site**, then answers 429
until the next day. Two decisions follow from it:

1. **One shared snapshot per cycle.** Gladys polls each device independently.
   Instead of letting four devices fire four sets of calls, the first device
   of a cycle triggers one refresh and the others read the cached result
   (`src/solaredge/service.js`, with in-flight de-duplication). A cycle costs
   **2 requests whatever the number of devices**.
2. **A client-side budget.** `SolarEdgeClient` counts its own requests and
   refuses to go past the configured budget (300/day by default), so a
   too-aggressive polling interval degrades the refresh rate instead of
   getting the API key throttled. The "API usage" button reports where the
   day stands.

With the defaults (live values every 15 min, daily breakdown every 30 min) the
integration uses ~240 requests/day.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no SolarEdge logic)
├─ src/
│  ├─ solaredge/
│  │  ├─ client.js                   #   HTTP client, daily budget guard, typed errors
│  │  ├─ snapshot.js                 #   pure payload -> Gladys values (units, signs, timezones)
│  │  └─ service.js                  #   site resolution, capabilities, shared cached snapshot
│  ├─ devices/                       # ← one file per device type
│  │  ├─ index.js                    #   registry + transport badges
│  │  ├─ production.js
│  │  ├─ consumption.js
│  │  ├─ grid.js
│  │  ├─ battery.js
│  │  └─ helpers.js                  #   state batches that skip missing readings
│  ├─ actions.js                     # Configuration screen buttons
│  └─ config.js                      # config defaults + normalization
├─ docs/{en,fr}.md                   # user documentation, re-hosted by Gladys
├─ gladys-assistant-integration.json # manifest (name, config schema, actions, image)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ .github/workflows/                # CI, multi-arch build, UI-driven release
```

## SolarEdge endpoints used

| Endpoint                            | Cadence                         | What it feeds                                     |
| ----------------------------------- | ------------------------------- | ------------------------------------------------- |
| `/site/{id}/currentPowerFlow`       | every cycle                     | live PV / load / grid / battery power and SoC     |
| `/site/{id}/overview`               | every cycle                     | production counters and revenue                   |
| `/site/{id}/energyDetails`          | daily-breakdown cadence         | consumption, self-consumption, imported, exported |
| `/site/{id}/storageData`            | daily-breakdown cadence, opt-in | stored energy, battery temperature                |
| `/site/{id}/details`, `/sites/list` | once                            | site name, timezone, peak power, auto-detection   |

Periods are expressed in the **site's** timezone (read from the site details):
using UTC would shift "today" by the site's offset and report the wrong daily
totals for part of the day.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="solaredge" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container. The SDK reads them
automatically.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # unit tests, via the built-in `node --test` runner
```

The tests use fixtures shaped like real SolarEdge payloads
(`test/helpers/solaredgeFixtures.js`) and cover what is easy to get wrong: the
unit announced by `currentPowerFlow` (W or kW depending on the site), the
power signs derived from the `connections` array, site-local day boundaries,
the request budget, and the rule that a **missing reading is never published
as a zero**.

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

Runs the same checks as the store indexer (manifest schema, Docker image,
cover image, docs) and reports every problem at once.

## Publish

1. Add the GitHub topic `gladys-assistant-integration` to the repository.
2. **Actions → Release → Run workflow**, pick `patch`, `minor` or `major`. The
   workflow bumps the version in `package.json` and the manifest, pushes the
   `vX.Y.Z` tag and builds the `linux/amd64` + `linux/arm64` image to
   `ghcr.io`.
3. The decentralized indexer picks up the new manifest version and Gladys
   offers a one-click install.

Until the first release the validator reports two expected failures: the
`docker_image` does not exist yet (the Release workflow builds it) and the
`cover_image` URL 404s (it points at `main`, which serves `cover.png` once the
code lands there).

## License

Apache-2.0
