# SolarEdge — Gladys Assistant external integration

External integration bringing a **SolarEdge** photovoltaic installation into
[Gladys Assistant](https://gladysassistant.com): solar production, home
consumption, grid exchanges and battery storage, read from the
[SolarEdge Monitoring API V2](https://api-docs.solaredge.com/docs/developer-platform).

SolarEdge retired the V1 API (the `?api_key=` one) on 2026-11-03: every V1
call now answers HTTP 410. Version 2.x of this integration talks to V2, with
the homeowner's own developer application authorized through OAuth 2.0 (the
Gladys "Connect" button), or an installer's Fleet API key. It was migrated
from the official documentation, **without a real V2 account: feedback
welcome**.

Built on the official
[JavaScript integration SDK](https://github.com/GladysAssistant/integration-sdk-js)
and the structure of the
[official template](https://github.com/GladysAssistant/integration-template-js).
Requires Gladys **5.2 or newer** (the `oauth2` configuration field).

## Devices

Devices are created from what the installation actually reports — a site
without a consumption meter simply gets the production device.

| Device                         | Features                                                                                                                                                         | Created when      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| SolarEdge — Production solaire | PV power (W), production today, lifetime production (kWh)                                                                                                        | always            |
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
(`energy-sensor/index`), what the supplier bills: the meter's onboard import
counter (`meters/lifetime-energy`), read once a day, plus today's import.
`test/discoveryContract.test.js` holds that rule, `test/service.test.js` the
daily bases and the monotonicity.

Capabilities need a **reading**, not an entry in the inventory: a meter whose
telemetry answers nothing creates no device. `test/inverterOnly.test.js`
replays a lone inverter.

Signed powers are the point: a single feature per flow, so a Gladys scene can
say "when grid power < −1000 W, start the water heater" — i.e. "use the
surplus instead of selling it".

## Dashboard widgets

Three widgets (Gladys ≥ 5.1), declared in the manifest `widgets` field and
built by pure functions in `src/widgets.js`:

| Widget      | Key           | Shows                                                                                                                                                                        | Settings                                        |
| ----------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Energy flow | `energy_flow` | Live PV / home / grid / battery power tiles, the power chart, today's balance (production, consumption, self-consumption, imported, exported, battery), a **Refresh** button | Chart period: last 24 hours (default) or a week |
| Production  | `production`  | Today (live) / month / year / lifetime (last reading, no decimals from 1000 kWh) tiles, the PV power area chart and the time of the last reading                             | Chart period: 24 hours, a week or a month       |
| Battery     | `battery`     | Charge gauge, battery power, state, stored energy and temperature (with the detailed telemetry), a red "Battery low" row                                                     | —                                               |

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

## The constraint that shapes the design: 2,000 credits a month

The V2 Free plan gives the developer account **2,000 credits a month** (one
per successful call, 10 calls a minute), then answers 429 until the next
billing cycle. Three decisions follow from it:

1. **One shared snapshot per cycle.** The integration refreshes on its own
   timer (`src/poller.js`), and Gladys may also poll each device (`onPoll`,
   kept as a fallback). One refresh serves every device and every other read
   gets the cached result (`src/solaredge/service.js`, with in-flight
   de-duplication). A cycle costs 2 requests on a lone inverter, up to 5 with
   a meter, a battery and its temperature.
2. **Expensive totals once a day.** Month, year, lifetime production and the
   grid import index are read once per site day and stored as a base
   (`value − today`): `base + today's overview` follows the day for free.
3. **A budget and a paced interval.** `SolarEdgeClient` refuses to spend more
   than 1/31 of the monthly credits a day, and `refreshInterval()` stretches
   the user's interval until a day of cycles fits (about 50 min on a lone
   inverter with the Free plan). The "API usage" button reports both.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no SolarEdge logic)
├─ src/
│  ├─ solaredge/
│  │  ├─ client.js                   #   V2 HTTP client, OAuth tokens, daily budget guard, typed errors
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
│  ├─ poller.js                      # internal polling timer (states without Gladys's onPoll)
│  ├─ publisher.js                   # which snapshot a tick publishes
│  ├─ actions.js                     # Configuration + widget buttons, error wording
│  ├─ connect.js                     # the "Connect" button (OAuth 2.0 relayed by Gladys)
│  └─ config.js                      # config defaults + normalization
├─ docs/{en,fr}.md                   # user documentation, re-hosted by Gladys
├─ gladys-assistant-integration.json # manifest (name, config schema, actions, image)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ .github/workflows/                # CI, multi-arch build, UI-driven release
```

## SolarEdge endpoints used (V2)

| Endpoint                                  | Cadence                    | What it feeds                                                                     |
| ----------------------------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| `/v2/sites/{id}/overview`                 | every cycle                | today: production, consumption, self-consumption, grid                            |
| `/v2/sites/{id}/power`                    | every cycle (no PV meter)  | live PV power (latest 15-minute average)                                          |
| `/v2/sites/{id}/meters/telemetry`         | every cycle (metered site) | live home, import and export power                                                |
| `/v2/sites/{id}/storage/telemetry`        | every cycle (battery)      | battery power, state of charge, stored energy                                     |
| `/v2/sites/{id}/storage/status`           | every cycle, opt-in        | battery temperature                                                               |
| `/v2/sites/{id}/energy?resolution=MONTH`  | once a day                 | production this month and this year                                               |
| `/v2/sites/{id}/lifetime-energy`          | once a day                 | lifetime production (onboard counter)                                             |
| `/v2/sites/{id}/meters/lifetime-energy`   | once a day (grid import)   | grid import index (meter counter)                                                 |
| `/v2/sites/{id}`, `/devices`, `/v2/sites` | once                       | site name, timezone, peak power, meters and batteries, auto-detection (Fleet key) |
| `/v2/oauth2/token`                        | every ~2 hours             | access token (OAuth); free, not a Monitoring API call                             |

Not used: the live power flow (`/power-flow`) and the per-destination
breakdowns belong to the Advanced Monitoring API (Business Pro and Enterprise
plans), and V2 reports no revenue.

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

The tests use fixtures shaped after the V2 OpenAPI specification
(`test/helpers/solaredgeFixtures.js`, not recordings) and cover what is easy
to get wrong: units announced in upper case, signed grid and battery powers,
buckets without data, site-local dates, the OAuth token rotation, the 429 and
410 answers, the request budget and the paced interval, the rule that a
**missing reading is never published as a zero**, and the widget contents
(validated with the SDK's `validateWidgetContent`).

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
