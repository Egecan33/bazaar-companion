# Bazaar Companion

A local live companion for The Bazaar on macOS. It follows the current run and tells you, step by
step, what to do next and why. It only reads and advises: it never clicks, types or sends anything
to the game. Nothing leaves this machine: no login, no server calls, no telemetry.

## Start

Double-click `Bazaar Companion.command` (the Desktop icon points to it), or:

```bash
npm start
```

It starts the game if it is not open, the local server, the screen reader and an always-on-top
panel over the game (http://localhost:4747 shows the same view in a browser). The panel passes
clicks through to the game; only its top strip takes the mouse.

macOS asks for **Screen Recording** permission for the app that launched it (Terminal, or `node`).
Without it the log part still works, but nothing on screen can be read.

## Where the data comes from

| What | Source |
|---|---|
| Phase, encounters picked, purchases, sales, upgrades, skill picks (count only) | `~/Library/Logs/Tempo Storm/The Bazaar/Player.log`, tailed every 0.3 s |
| Own board (with duplicates and order), shop offers, path options, level-up rewards, owned skills | Screenshots of the game window, matched against the game's own art (`vision/matcher.py`) |
| Gold, income, health, hero level | OCR of fixed spots on the screen (`vision/watch.py`) |
| What a hovered thing is, a monster's level, an event choice's real text, an item's sell price | OCR of the hover tooltip, matched to card names (`src/scene.mjs`) |
| Items, skills, effects, tiers, prices, merchants, events, monsters, game rules | The game's own local data: its cache `~/Library/Application Support/com.TempoStorm.TheBazaar/prod/cache/GameData.db.zip`, else the copy in the install. Imported to `data/cards.json` |

`npm start` re-imports when the game version or the cached data changes.

## How the advice is computed

- **Board engine** (`src/engine.mjs`): runs a board step by step under the game's rules, with every
  effect read from the data: triggers, auras, neighbours, prerequisites, haste, charge, slow, freeze,
  crit, ammo, burn, poison, rage, tempo, enchantments, transforms. An item is worth what the whole
  board gains with it (`src/advisor.mjs`). It runs every fight effect of 1402 of 1413 items, 569 of
  573 skills and 173 of 178 monsters; what it cannot run is named in the panel.
- **Plan** (`actionPlan` in `src/view.mjs`): orders the results into numbered instructions: what to
  buy within the gold in hand, where to put it, what to move or sell, which path to take.
- **Events and merchants** (`src/choices.mjs`): what each choice gives, from the data. Merchant pools
  are still valued with the older simple model in `src/model.mjs`, not the engine.
- **Scene memory** (`src/scene.mjs`): what is on offer is remembered until the log ends the scene.
- **Opinions**: a few general principles from YouTube creators are shown, labelled as opinions with
  the creator named (`docs/youtube-research-2026-11-23.md`). They change no number.

### Fight estimate

`engineFight` gives a win chance against a monster. It was added at the owner's explicit request.
The publisher's mod policy reportedly forbids tools that calculate combat results, so using it is
the owner's own risk. It has not been calibrated against real fights.

## Limits you should know

- The engine has not been checked against real fight results. Two bugs were found on the first live
  board; more may exist.
- Items the log does not show (rewards) count at their starting tier unless you hover them: the
  tooltip's "Sells for N" then fixes the tier. Enchantments are only known if the item's name carries
  the enchantment as a prefix, which has not been confirmed on a real frame.
- Owned skills are read from the icons beside the hero and capped at the number of skill picks in the
  log; which skills they are is unconfirmed.
- Board slots by level: two per level is from the data, four at level 1 was measured on one frame.
  A level of 1 is often not readable; the day is then used as a floor.
- OCR boxes were measured on a 3024x1964 full-screen frame of version 1.0.13176;
  `data/calibration.json` can override them.
- Amounts keyed to run-long counters (gold gained this run, weapons bought this run) cannot be known.
- `test/fixtures/run-constructed.log` is constructed from the game's format strings, not recorded.

## Commands

```bash
npm test             # parser, run state, engine, plan, scene memory (node:test)
npm run test:vision  # recognition and counters on real captured frames in test/fixtures/frames
npm run setup:vision # venv + art extraction + feature index (one time, a few minutes)
node scripts/replay.mjs test/fixtures/run-constructed.log /tmp/live.log 300   # with BAZAAR_LOG=/tmp/live.log npm start
```
