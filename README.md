# Mikey Bot

A Discord bot that turns [Warcraft Logs](https://www.warcraftlogs.com/) reports into readable raid feedback — pull-by-pull breakdowns, a whole-night summary, and personal reports posted straight to each raider's own channel.

## What it tracks

- **Deaths** — who died, to what, how many others were already down, and whether a defensive/self-heal was up. Deaths where 5+ people die to the same ability within 5 seconds are recognized as a called wipe and excluded from tallies instead of being blamed as individual mistakes.
- **Defensives & self-heals** — tracked per class/spec (see `src/lib/classes/`), including abilities that double as externals (Blessing of Protection, Lay on Hands, etc.).
- **Consumables** — health potions/stones, DPS potions, mana potions, split out by category.
- **Interrupts** — including pet interrupts (Warlock Felhunter kicks, etc.) correctly attributed to the owner.
- **Externals given** — support actions like Blessing of Sacrifice or Pain Suppression cast on someone else.
- **Missing prep** — gear enchants (checked at first/last attended pull), and flask/food/weapon oil (checked every pull).
- **Raid buff uptime** — class buffs like Arcane Intellect, Battle Shout, Power Word: Fortitude, Skyfury, Mark of the Wild, Devotion Aura, and Blessing of the Bronze, attributed to whichever provider class was actually present. Only checked on pulls 2+ minutes long.
- **Multi-report nights** — if a night got logged across more than one WCL report, pass comma-separated codes/URLs and they're merged chronologically with duplicate pulls (the same attempt logged twice) collapsed automatically.
- Mythic+ dungeon pulls are excluded everywhere — this is a raid analysis tool.

## Commands

| Command | Description |
| --- | --- |
| `/analyze <report>` | Pull-by-pull breakdown of a report: deaths, top/bottom parses, interrupts, defensives. |
| `/summary <report>` | Whole-night leaderboard: most deaths, most wipe triggers, highest/lowest parse, most interrupts, missing prep, raid buff lapses, and more. |
| `/feedback <report> <player>` | Personal report for one player. `player` accepts comma-separated character names to cover a main + alts. Run in that player's own channel. |
| `/give-personal-feedback-to-all <report>` | Runs `/feedback` for the whole roster (`data/roster.json`), each posted to their own configured channel. |
| `/list-defensives <spec>` | Look up the defensives/self-heals tracked for a class/spec. Autocomplete disambiguates same-named specs across classes (e.g. Holy Paladin vs. Holy Priest). |
| `/request-defensives [player]` | Posts a defensives audit prompt to roster channels — no report needed, reads class/spec straight from the roster. Leave `player` blank to send to everyone. |
| `/start-tracking-live` | Starts polling for new reports from the guild every 5 minutes and posting them to the channel it was run in. |
| `/stop-tracking-live` | Stops the polling started by `/start-tracking-live`. |

`report` arguments accept either a bare report code or a full `warcraftlogs.com/reports/...` URL.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `WCL_CLIENT_ID` / `WCL_CLIENT_SECRET` — a [Warcraft Logs API client](https://www.warcraftlogs.com/api/clients/) (client credentials flow, v2 API)
   - `WCL_GUILD_ID` — your guild's numeric WCL guild ID (used by live tracking)
   - `DISCORD_BOT_TOKEN` / `DISCORD_CLIENT_ID` — from the [Discord Developer Portal](https://discord.com/developers/applications)
   - `DISCORD_GUILD_ID` — your Discord server's ID (guild-scoped command registration updates instantly; omit for global commands, which can take up to an hour to propagate)
   - `ALLOWED_USER_IDS` — comma-separated Discord user IDs allowed to run any command
3. `npm run register-commands` — registers all slash commands with Discord
4. `npm start` — runs the bot

The bot only does anything when a command is run — nothing polls automatically until `/start-tracking-live` is used, and that stops on `/stop-tracking-live` or a restart.

## Roster (`data/roster.json`)

Each entry maps a person to their Discord channel and their character(s):

```json
{
  "names": ["Mikey", "Rambomikey"],
  "channelName": "mikey",
  "characters": [
    { "name": "Mikey", "class": "Paladin", "spec": "Retribution" },
    { "name": "Rambomikey", "class": "Hunter", "spec": "BeastMastery" }
  ]
}
```

- `names` — every character name that should count as this person for `/feedback` and `/summary` (main + alts).
- `channelName` — the Discord channel `/give-personal-feedback-to-all` and `/request-defensives` post to.
- `characters` — one entry per character with its own class/spec, used by `/request-defensives`. Supports a main and alts on completely different classes.

Edit the file directly — no code changes needed. It's read fresh on every command, so edits take effect immediately.

## Class/spec defensive data (`src/lib/classes/`)

One file per class, one named export per spec, e.g. `paladin.js` exports `Holy`, `Protection`, `Retribution`. This is best-effort and tuned against real log data and raider feedback rather than assumed from standard WoW class design — this server runs custom/non-standard content in places (e.g. a Demon Hunter "Devourer" spec that doesn't exist in retail WoW), so some specs and abilities won't match what you'd expect from live WoW. Correct entries directly in these files, or use `/list-defensives` to review what's currently tracked.
