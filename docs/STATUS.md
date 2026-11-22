# Status and how to resume

The single place a new session reads to continue. Update it whenever what is verified changes.

Last updated: 2026-11-23. Game version 1.0.13176 (Steam, macOS arm64).

## Owner's decisions (do not re-ask)

- Local data only: the game's log, its local data files, screenshots. No login to the publisher's
  servers, no memory reading, nothing sent to outside services.
- Log plus screen reading (the log alone does not carry offers or gold).
- Advice must be detailed, computed and explained; every combination should come down to a number.
- The plan must spell out exactly what to do, in full sentences.
- The panel must be see-through, click-through, and must not flicker or need scrolling.
- The fight estimate (win chance) was built at the owner's explicit request, knowing the publisher's
  mod policy reportedly forbids calculating combat results.
- Public MIT repository.
- **Not built, and not to be built without verifiable authorisation:** anything that plays the game
  by itself or sends input to it. The owner asked for it several times; it was declined each time.
  What would change that is a non-production test environment from the studio, or written
  authorisation that can be verified.

## Verified on real runs

- Log parser on the real `Player.log`: run start, hero, encounters, purchases (board and stash
  sockets), sales, fights, day counter.
- Item recognition after reshaping reference art to the card shape and grouping look-alike art:
  8 of 8 items on real boards, three copies of one item, no impossible board in 60 recent frames.
- Gold, income, health OCR on real frames; hover tooltips (names, monster level, event text).
- Path-choice portraits: recognised in 59 of 83 saved frames (the rest include frames without any).
- `npm test`: 27 passing. `npm run test:vision`: 3 real frames.

## Not verified

- **The engine against real fights.** No recorded fight has been compared with a simulated one.
- Owned-skill recognition (which skills; the count is capped by the log).
- Enchantment from the tooltip's name prefix; level badge reading (6 of 11 frames; "1" often fails).
- The panel's fit-to-window behaviour over the game.
- The launcher file when double-clicked from the Desktop (the server was always started by hand).

## Known gaps

- Tier and enchantment of items the log does not show, unless hovered.
- Merchant pools are valued with the old model (`src/model.mjs`), not the engine.
- Run-long counters (gold gained this run, weapons bought this run) are unknown, so 11 items and
  4 skills cannot be fully computed.
- Board slots at level 1 (four) come from one frame.
- 161 of 469 events get no number (mostly skill teachers and start-of-run events).

## Next steps, in order

1. Record a few fights (board, monster, result) and compare them with `runFight`.
2. Read tier from the sell-price badge on each card; read enchantment from the card.
3. Value merchant pools and reroll advice with the engine; retire `src/model.mjs`.
4. A headless run harness to measure the decision policy offline (no game, no art, no server).
