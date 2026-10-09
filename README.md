# SolarEdge — Gladys Assistant external integration

External integration bringing a **SolarEdge** photovoltaic installation into
[Gladys Assistant](https://gladysassistant.com): solar production, home
consumption, grid exchanges and battery storage, read from the public
[SolarEdge Monitoring API](https://monitoringapi.solaredge.com).

Built on the official
[JavaScript integration SDK](https://github.com/GladysAssistant/integration-sdk-js)
and the structure of the
[official template](https://github.com/GladysAssistant/integration-template-js).
Requires Gladys **5.1 or newer** (dashboard widgets).

## Devices

Devices are created from what the installation actually reports — a site
without a consumption meter simply gets the production device.

| Device                         | Features                                                                                                                                                         | Created when      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| SolarEdge — Production solaire | PV power (W), production today, lifetime production (kWh), today's revenue                                                                                       | always            |
| SolarEdge — Consommation       | Load power (W), consumption today (kWh), self-consumption today (kWh)                                                                                            | consumption meter |
| SolarEdge — Réseau             | Grid power (W, **signed**: + imported / − exported), imported today (kWh), exported today (kWh), grid import index (kWh, since commissioning)                    | grid metering     |
| SolarEdge — Batterie           | Charge level (%), battery power (W, **signed**: + charging / − discharging), state (text), low flag, and — optionally — stored energy (kWh) and temperature (°C) | battery installed |

Feature types are chosen for what the Gladys core **does** with them, not only
for the label. `energy-sensor/energy` and `energy-sensor/index` are
consumption indexes for the core's energy module (it derives "(consumption)"
and "(cost)" features from them and bills their deltas), and
`energy-sensor/daily-consumption` is one state per day, summed by the weekly
digest. So: lifetime production is `energy-production-sensor/index`, the
"today" energies other than production are `energy-sensor/index-today`, the
battery's stored energy is `battery-storage/battery-energy-remaining`, and the
month and year totals are no features at all (the production widget shows
them). ONE feature is a consumption index on purpose: the grid import index
(`energy-sensor/index`), what the supplier bills, rebuilt from `energyDetails`
(purchased up to yesterday, read once a day, plus today's) because SolarEdge
has no lifetime import counter. `test/discoveryContract.test.js` holds that
rule, `test/gridImportIndex.test.js` the midnight and monotonicity traps.

Capabilities need a **reading**, not a key in the payload: a SolarEdge site
without a meter still answers `GRID: { status: 'Inactive' }` and lists its
meters in `energyDetails` with no value, and a site without a tariff answers a
lifetime revenue of `0.0`. `test/inverterOnly.test.js` replays such a site.

Signed powers are the point: a single feature per flow, so a Gladys scene can
say "when grid power < −1000 W, start the water heater" — i.e. "use the
surplus instead of selling it".

## Dashboard widgets

Three widgets (Gladys ≥ 5.1), declared in the manifest `widgets` field and
built by pure functions in `src/widgets.js`:

| Widget      | Key           | Shows                                                                                                                                                                                 | Settings                                        |
| ----------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Energy flow | `energy_flow` | Live PV / home / grid / battery power tiles, the power chart, today's balance (production, consumption, self-consumption, imported, exported, revenue, battery), a **Refresh** button | Chart period: last 24 hours (default) or a week |
| Production  | `production`  | Today (live) / month / year / lifetime (last reading, no decimals from 1000 kWh) tiles, the PV power area chart, today's revenue and the time of the last reading                     | Chart period: 24 hours, a week or a month       |
| Battery     | `battery`     | Charge gauge, battery power, state, stored energy and temperature (with the detailed telemetry), a red "Battery low" row                                                              | —                                               |

Two rules keep them cheap:

- **A widget never calls SolarEdge.** Every open dashboard pulls the content, so
  the builders read the last snapshot kept in memory
  (`SolarEdgeService.lastSnapshot`) and bind the tiles and charts to the
  published device features (`device_feature` / `device_features`): the core
  keeps them live from its own history. The only request a widget can trigger
  is the **Refresh** button, which goes through the same `refresh_now` logic
  and the same daily budget — a spent budget answers with a toast.
- **Content is validated like the core does.** Every content the tests
  produce goes through the SDK's `validateWidgetContent` and must come back
  clean (8 components at most, 6 tiles, 1 chart, 1 status, 2 texts, 4
  buttons), and every bound feature must be one the discovery payload
  declares.

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
integration uses ~240 requests/day (+1 a day for the grid import index of a
metered site).

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
│  ├─ widgets.js                     # dashboard widget contents (pure builders)
│  ├─ publisher.js                   # which snapshot a Gladys tick publishes
│  ├─ actions.js                     # Configuration + widget buttons, error wording
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
the request budget, the rule that a **missing reading is never published as a
zero**, and the widget contents (validated with the SDK's
`validateWidgetContent`, on full and on production-only sites).

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
`cover_image` URL 404s (it points at `main`, which serves `cover.jpg` once the
code lands there).

`cover.jpg` is the catalog cover: the store contract is **exactly 800×534,
150 KB max**, JPEG or PNG. It is JPEG at quality 95 with 4:4:4 chroma (49 KB) —
the smooth background gradient costs 175 KB even as a 256-colour PNG, and
4:2:0 subsampling would smear the edges of the red logo block.

## License

Apache-2.0
