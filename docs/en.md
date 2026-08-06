# SolarEdge

This integration connects your **SolarEdge** photovoltaic installation to
Gladys Assistant. It reads the SolarEdge Monitoring API — the same service the
mobile app uses — and creates up to four devices in Gladys: solar production,
home consumption, grid exchanges and home battery.

No extra hardware is needed: everything goes through the SolarEdge cloud, read
only. The integration never sends a command to your inverter.

## What you get

Which devices are created depends on what your installation can report: only
sites fitted with a consumption meter (a SolarEdge Modbus meter) expose
consumption and grid, and only sites with a battery expose the battery device.
The integration detects all of this on its own at startup.

### SolarEdge — Solar production

Always created.

| Reading               | Unit  | Description                                    |
| --------------------- | ----- | ---------------------------------------------- |
| Produced power        | W     | Instantaneous output of the panels             |
| Production today      | kWh   | Energy produced since midnight                 |
| Production this month | kWh   | Energy produced since the start of the month   |
| Production this year  | kWh   | Energy produced since the start of the year    |
| Total production      | kWh   | Lifetime counter since commissioning           |
| Revenue today         | € / $ | Revenue computed by SolarEdge from your tariff |

### SolarEdge — Consumption

Created when your installation has a consumption meter.

| Reading                | Unit | Description                                 |
| ---------------------- | ---- | ------------------------------------------- |
| Consumed power         | W    | Instantaneous consumption of the house      |
| Consumption today      | kWh  | Energy consumed since midnight              |
| Self-consumption today | kWh  | Share covered by the panels and the battery |

### SolarEdge — Grid

Created when your installation measures the grid exchanges.

| Reading        | Unit | Description                                              |
| -------------- | ---- | -------------------------------------------------------- |
| Grid power     | W    | **Positive** when importing, **negative** when exporting |
| Imported today | kWh  | Energy bought from the grid since midnight               |
| Exported today | kWh  | Surplus sold since midnight                              |

The sign of the grid power is what makes scenes interesting: "when grid power
drops below −1000 W, start the water heater" means exactly "use the surplus
instead of selling it".

### SolarEdge — Battery

Created when your site has storage (SolarEdge Energy Bank, LG RESU…).

| Reading               | Unit | Description                                               |
| --------------------- | ---- | --------------------------------------------------------- |
| Charge level          | %    | Battery state of charge                                   |
| Battery power         | W    | **Positive** when charging, **negative** when discharging |
| Battery state         | text | Charging / discharging / idle / disabled                  |
| Battery low           | 0-1  | The "critical" flag reported by SolarEdge                 |
| Stored energy\*       | kWh  | Energy actually available in the battery                  |
| Battery temperature\* | °C   | Internal temperature of the pack                          |

\* Only when the **Detailed battery telemetry** setting is enabled.

## Setup

### 1. Get a SolarEdge API key

The key is generated from the SolarEdge monitoring portal, with an account
holding admin rights on the site:

1. Sign in at <https://monitoring.solaredge.com/>.
2. Open **Admin** → **Site Access** → **API Access**.
3. Accept the terms of service, then click **Generate a new key** and **Save**.
4. Copy the key (32 uppercase characters) and the **site id** shown on the
   same page.

If the "API Access" menu is not there, your account does not have the admin
role on the installation: ask your installer for it.

### 2. Fill in the integration

1. Open the **Configuration** tab of the integration in Gladys.
2. Paste your **API key**.
3. Leave **Site ID** empty when your key covers a single site: it is detected
   automatically. Otherwise, press **List my sites** to find the id to enter.
4. Save, then press **Test the connection**. The message shown under the
   button confirms the site name and the list of available devices.
5. The devices appear in the **Discovery** tab, ready to be added.

### 3. Choose the refresh rate

SolarEdge limits each API key to **300 requests per day and per site**. Once
the quota is spent, the API refuses everything until the next day — so the
integration stops on its own before reaching it.

The budget reads as follows:

- each refresh cycle costs **2 requests**, whatever the number of devices
  created (they all share the same reading);
- the **daily breakdown** (consumption, self-consumption, imported, exported)
  costs **1 request** on its own, slower cadence;
- the **detailed battery telemetry**, if you enable it, costs **1 more
  request** at the daily-breakdown cadence.

With the default settings (15 min for live values, 30 min for the breakdown),
the integration uses about **240 requests per day**: it stays inside the
budget with room to spare.

Lowering the interval to 5 minutes costs roughly 620 requests per day: the
quota is reached around midday and the values freeze until tomorrow. The
**API usage** button tells you where you stand at any moment.

## Available actions

- **Test the connection** — checks the key, resolves the site and lists the
  devices your installation can feed.
- **List my sites** — shows every site the key gives access to, with its id,
  ready to copy into the matching setting.
- **Refresh now** — reads SolarEdge immediately, without waiting for the next
  cycle.
- **API usage** — how many requests were used today and how many refreshes
  are left.

## Troubleshooting

**"SolarEdge refused the API key"** — the key is invalid, has been
regenerated, or does not grant access to this site. Generate a new one from
the portal and paste it again (trailing spaces are stripped automatically).

**"Site not found", or several sites** — your key covers more than one
installation: press **List my sites** and copy the id you want into the
**Site ID** setting.

**The Consumption and Grid devices do not show up** — your installation has no
consumption meter. This is a hardware option (a Modbus meter) fitted by the
installer; without it, SolarEdge only knows about production.

**Values stop moving in the afternoon** — the daily quota is probably spent.
Check with **API usage** and raise the refresh interval. An orange dot then
appears on the devices to signal that the values are no longer refreshed.

**An "unreachable" badge on the devices** — the SolarEdge cloud is not
answering. The integration retries automatically; the integration logs
(`LOG_LEVEL=debug` for the full detail) show the exact cause.

## Privacy

The integration only talks to `monitoringapi.solaredge.com`, read only. Your
API key is stored by Gladys as a secret and is never sent back to the
frontend. No data is sent anywhere else.
