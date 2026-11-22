# AGENTS.md

Guidance for coding agents (and people) working in this repository. Read `docs/STATUS.md` next: it
says what is verified, what is not, and what the owner has decided.

## What this is

Bazaar Companion is a local, single-user, read-only advisor for The Bazaar on macOS. One Node process
on 127.0.0.1, one Python screen reader, one small native panel window. No AI or LLM calls at runtime:
every output is computed from the game's local data, its log and screenshots. The interface text is
Turkish; code, comments and docs are English.

## Layout

| Path | Contents | Rule |
|---|---|---|
| `src/engine.mjs` | Runs a board or a fight step by step | Pure: no IO. Rules come from data or carry a comment saying where they come from. |
| `src/advisor.mjs` | Values items, swaps, orders, skills by running the board | Cached per board; an evaluation costs milliseconds and the view rebuilds every frame. |
| `src/choices.mjs`, `src/scene.mjs` | Events, merchants, paths; scene memory | Scene memory is cleared by log events only. |
| `src/view.mjs` | The state the panel shows; `actionPlan` | The plan orders results; it adds no judgement of its own. |
| `src/logparser.mjs`, `src/runstate.mjs` | Log lines into a run | Patterns are unanchored; the log's prefix changes between builds. |
| `src/model.mjs`, `src/fight.mjs`, `src/layout.mjs` | The older tag-based model | Still used for merchant pools, reroll advice and link texts. Do not extend; move callers to the engine. |
| `src/server.mjs` | HTTP + SSE, log tail, screen reader child | Binds 127.0.0.1 only. |
| `scripts/import-data.mjs` | Game data into `data/cards.json` | The only place that knows the game's JSON shapes. |
| `vision/` | Art extraction, matcher, screen reader | Boxes are fractions of the frame, measured on real frames. |
| `overlay/overlay.m` | Panel window | Build with `clang`; the Swift toolchain on the dev machine cannot import WebKit. |
| `public/index.html` | The panel | One file, no build step, no network. |
| `test/` | `node:test` suites, a constructed log, three real frames | |
| `data/` | Imported game data, extracted art, captures, run history | Gitignored. Never commit. |

## Hard rules

1. **Read only.** Never send input to the game, read its memory, modify its files or contact its
   servers. No auto-play, no click automation, no "assist" that presses anything. This is the
   publisher's line and the project's.
2. **Never state a game fact from memory.** Cooldowns, prices, effects, odds: take them from
   `data/cards.json` or the game mode constants. If the data is silent, say so in the UI.
3. **No number without its source.** Every value shown names what it is made of. Assumptions
   (weights, thresholds, the 15 s horizon) are marked as assumptions in the code and the README.
4. **Say when you cannot compute.** If an effect is not handled, `coverageOf` reports it and the
   panel names the item. Do not guess a value.
5. **The log is the clock.** The screen is noisy; anything read from it is cross-checked against log
   events (board changes, scene boundaries, skill counts).
6. **Stale information is a bug.** Whatever is remembered must have a log event that clears it.
7. **Nothing leaves the machine.** No telemetry, no remote calls at runtime. No personal information
   in any file that is committed.
8. **No game data or extracted art in git.**
9. **Keep it light.** The screen reader runs beside a game: one thread, low priority, skip unchanged
   frames, pause in fights.

## Commands

```bash
npm run setup        # import data, venv, extract art, build the feature index
npm start            # sync data if the game changed, then server + reader (the .command launcher adds the game and the panel)
npm test             # node:test
npm run test:vision  # real frames; needs data/art
node scripts/replay.mjs <log> <target> [ms]   # replay a log into a file; run with BAZAAR_LOG=<target>
```

`POST /api/screen` accepts a recognised frame by hand (same shape as `vision/watch.py` output); with
`BAZAAR_LOG` and `PORT` that gives a full demo without the game.

A task is finished when `npm test` passes and, if `vision/` changed, `npm run test:vision` too.

## Working on the engine

- Add an effect kind in three places: `effects()` in the importer, `classify()` and `apply()` in the
  engine. Then check `coverageOf` moved and add a test that names a real item.
- When a result looks wrong, run the board with `boardValue` and print `per` (uses and output per
  item). Both bugs found so far were visible there in one line.
- A new rule needs its source in a comment: a data field, a tooltip, or the creator who showed it.

## Commits

- One change per commit. Conventional prefixes help: `feat`, `fix`, `docs`, `test`, `refactor`.
- If a change alters `data/cards.json`'s shape, say so: the server must be restarted and the data
  re-imported.

## Legal

A fan project, not affiliated with or endorsed by Tempo. Keep the disclaimer in `README.md` intact.
