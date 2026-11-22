// Rebuilds the current run from log events. Everything here is derived from the log only;
// fields the log cannot give are left null rather than guessed.
import { TIER_ORDER } from './tiers.mjs';

export function newRun() {
  return {
    active: false,
    startedAt: null,
    hero: null, // from the hero's "Start Run" encounter or the hero-only items bought
    day: 1, // inferred: +1 each time the run leaves a PvP fight
    hour: 0, // inferred: top-level encounters picked since the day started
    phase: null, // last game state name from the log
    items: {}, // instanceId -> { templateId, tier, where: 'board'|'stash', socket }
    skills: [], // template ids (or raw ids when the template is unknown)
    encounters: [], // history of picked encounters
    current: null, // encounter the player is inside right now
    goldFromSales: 0, // exact: the log prints the gold for every sale
    goldSpentEst: 0, // estimate: standard price of each item bought in a paid shop (discounts unknown)
    fights: { pve: 0, pvp: 0 },
    lastEvent: null,
    unknownTemplates: 0,
  };
}

const isStash = (target, section) => /stor|stash/i.test(`${target} ${section}`);
const socketOf = (target) => {
  const m = String(target).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
};

export function createTracker(data) {
  const cards = data?.cards ?? {};
  let run = newRun();
  let inPvp = false;

  function apply(e) {
    if (!e) return run;
    run.lastEvent = e.t ?? run.lastEvent;
    switch (e.type) {
      case 'runStart': {
        // "Starting new run..." and the server's init message both appear for one run.
        const fresh = !run.active || Object.keys(run.items).length > 0 || run.encounters.length > 0;
        if (fresh) {
          run = newRun();
          inPvp = false;
        }
        run.active = true;
        run.startedAt = run.startedAt ?? e.t;
        break;
      }
      case 'state': {
        run.active = true;
        const to = e.to;
        if (/PVPCombat/i.test(to)) {
          inPvp = true;
          run.fights.pvp += 1;
        } else if (/Combat/i.test(to) && !/Replay/i.test(to)) {
          run.fights.pve += 1;
        }
        if (inPvp && /^(Choice|LevelUp)State$/.test(to)) {
          run.day += 1;
          run.hour = 0;
          inPvp = false;
        }
        if (/^(Choice|LevelUp)State$/.test(to)) run.current = null;
        if (/MainMenu|Login|EndOfRun|RunSummary/i.test(to)) run.active = false;
        run.phase = to;
        break;
      }
      case 'purchase': {
        run.active = true;
        const card = cards[e.templateId];
        if (!card) run.unknownTemplates += 1;
        const type = card?.type ?? (e.instanceId.startsWith('itm_') ? 'Item' : e.instanceId.startsWith('skl_') ? 'Skill' : 'Unknown');
        if (type === 'Item' || type === 'Unknown') {
          run.items[e.instanceId] = {
            templateId: e.templateId,
            tier: card?.startingTier ?? 'Bronze',
            where: isStash(e.target, e.section) ? 'stash' : 'board',
            socket: socketOf(e.target),
          };
          const shop = cards[run.current?.templateId]?.shop;
          if (card && shop && !shop.free) {
            run.goldSpentEst += data?.gameMode?.buyPrices?.[card.size]?.[card.startingTier] ?? 0;
          }
        } else if (type === 'Skill') {
          if (!run.skills.includes(e.templateId)) run.skills.push(e.templateId);
        } else {
          const top = type !== 'EncounterStep';
          if (top) run.hour += 1;
          run.encounters.push({ templateId: e.templateId, type, day: run.day, hour: run.hour });
          // In a player fight the log names a placeholder card (always the same monster), not the real opponent.
          run.current = { templateId: e.templateId, type, instanceId: e.instanceId, pvp: /^pvp_/.test(e.instanceId ?? '') };
          if (!run.hero && /Start Run/i.test(card?.internalName ?? '') && card.heroes?.length === 1) {
            run.hero = card.heroes[0];
          }
        }
        if (!run.hero) run.hero = guessHero(run, cards);
        break;
      }
      case 'sold': {
        delete run.items[e.instanceId];
        run.goldFromSales += e.gold;
        break;
      }
      case 'upgraded': {
        const it = run.items[e.instanceId];
        if (it && TIER_ORDER.includes(e.to)) it.tier = e.to;
        break;
      }
      case 'skillSelected': {
        const id = cards[e.skill] ? e.skill : e.skill;
        if (!run.skills.includes(id)) run.skills.push(id);
        break;
      }
      default:
        break;
    }
    return run;
  }

  return {
    apply,
    get run() {
      return run;
    },
    reset() {
      run = newRun();
      inPvp = false;
    },
  };
}

function guessHero(run, cards) {
  const votes = {};
  for (const it of Object.values(run.items)) {
    const h = cards[it.templateId]?.heroes ?? [];
    if (h.length === 1 && h[0] !== 'Common') votes[h[0]] = (votes[h[0]] ?? 0) + 1;
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null;
}
