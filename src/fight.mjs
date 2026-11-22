// Fight estimate against a monster, and a "strength for the day" gauge.
// Added at the owner's explicit request. The publisher's mod policy (as reported by secondary sources) lists
// "calculating or simulating combat results" as not allowed, so using this part is the owner's own risk.
//
// What is simulated (rules from the game's data: tooltips table and game mode):
//   items fire on their cooldown, Multicast times; damage hits shield first; heal is capped at max health;
//   burn ticks twice a second, shrinks 3% per tick and is halved against shield; poison ticks once a second
//   and ignores shield; regen heals once a second; ammo runs out; the sandstorm starts at 30 s and ramps up.
// What is not simulated: haste, slow, freeze, charge, crit, destroy, skills, enchantment abilities, and every
// "when ..." trigger. Those are the uncertainty: each run scales every item's output by a random factor whose
// spread grows with the share of the two boards that the model cannot express, and the win chance is the
// share of runs won. Confidence is that modelled share. The estimate has not been calibrated against real fights.
import { itemStats } from './model.mjs';

const STEP = 0.1;
const MAX_TIME = 90;

function rng(seed) { // mulberry32: repeatable runs
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** Per-use numbers of one item, from the same data the valuation model uses. */
function fighter(card, tier, enchant) {
  const t = card?.tiers?.[tier] ?? card?.tiers?.[card?.startingTier];
  if (!t) return null;
  const a = t.attrs;
  const cd = (a.CooldownMax ?? 0) / 1000;
  const s = itemStats(card, tier, enchant);
  const fired = new Set((card.abilities ?? []).filter((x) => x.trigger === 'TTriggerOnCardFired').map((x) => x.action));
  const has = (x) => fired.has(x);
  const f = {
    name: card.name, cd, multicast: Math.max(1, a.Multicast ?? 1), ammo: a.AmmoMax ?? null,
    damage: has('TActionPlayerDamage') ? a.DamageAmount ?? 0 : 0,
    shield: has('TActionPlayerShieldApply') ? a.ShieldApplyAmount ?? 0 : 0,
    heal: has('TActionPlayerHeal') ? a.HealAmount ?? 0 : 0,
    burn: has('TActionPlayerBurnApply') ? a.BurnApplyAmount ?? 0 : 0,
    poison: has('TActionPlayerPoisonApply') ? a.PoisonApplyAmount ?? 0 : 0,
    regen: has('TActionPlayerRegenApply') ? a.RegenApplyAmount ?? 0 : 0,
    lifesteal: Boolean(a.Lifesteal),
  };
  f.modelled = cd > 0 && f.damage + f.shield + f.heal + f.burn + f.poison + f.regen > 0;
  // An item counts as fully expressed only when it has no other effect the simulation ignores.
  f.partial = f.modelled && Boolean(s.hasteSec || s.chargeSec || s.slowSec || s.freezeSec || s.destroySec || (card.abilities ?? []).some((x) => x.trigger !== 'TTriggerOnCardFired'));
  return f;
}

function side(items, health, data) {
  const fs = items.map((it) => fighter(data.cards[it.templateId], it.tier, it.enchant ?? null)).filter(Boolean);
  return { health, items: fs };
}

/** Share of a side that the simulation expresses: 1 per fully modelled item, 0.5 per partly modelled one. */
function coverage(s, skills = 0) {
  const n = s.items.length + skills;
  if (!n) return 0;
  return s.items.reduce((x, f) => x + (f.modelled ? (f.partial ? 0.5 : 1) : 0), 0) / n;
}

function simulate(A, B, rand, spread, sandstorm) {
  const mk = (s) => ({ hp: s.health, max: s.health, shield: 0, burn: 0, poison: 0, regen: 0,
    items: s.items.filter((f) => f.modelled).map((f) => ({ ...f, t: 0, left: f.ammo, k: Math.exp(gauss(rand) * spread) })) });
  const a = mk(A), b = mk(B);
  const hit = (to, dmg) => { const s = Math.min(to.shield, dmg); to.shield -= s; to.hp -= dmg - s; };
  const act = (me, foe) => {
    for (const f of me.items) {
      f.t += STEP;
      while (f.t >= f.cd && (f.left == null || f.left > 0)) {
        f.t -= f.cd;
        if (f.left != null) f.left -= 1;
        for (let i = 0; i < f.multicast; i++) {
          if (f.damage) { const d = f.damage * f.k; hit(foe, d); if (f.lifesteal) me.hp = Math.min(me.max, me.hp + d); }
          if (f.shield) me.shield += f.shield * f.k;
          if (f.heal) me.hp = Math.min(me.max, me.hp + f.heal * f.k);
          if (f.burn) foe.burn += f.burn * f.k;
          if (f.poison) foe.poison += f.poison * f.k;
          if (f.regen) me.regen += f.regen * f.k;
        }
      }
    }
  };
  let storm = 0, stormDmg = sandstorm.BaseDamage ?? 1;
  for (let t = STEP, i = 1; t <= MAX_TIME; t += STEP, i++) {
    act(a, b); act(b, a);
    if (i % 5 === 0) for (const x of [a, b]) if (x.burn > 0) { // twice a second
      if (x.shield > 0) x.shield = Math.max(0, x.shield - x.burn / 2); else x.hp -= x.burn;
      x.burn *= 0.97;
    }
    if (i % 10 === 0) for (const x of [a, b]) { x.hp -= x.poison; x.hp = Math.min(x.max, x.hp + x.regen); }
    if (t * 1000 >= (sandstorm.CountdownStartTime ?? 20000) + (sandstorm.CountdownDuration ?? 10000)) {
      storm += STEP * 1000;
      if (storm >= (sandstorm.BaseTickRate ?? 250)) { storm = 0; a.hp -= stormDmg; b.hp -= stormDmg; stormDmg += sandstorm.AdditiveScalar ?? 2; }
    }
    if (a.hp <= 0 || b.hp <= 0) return { win: b.hp <= 0 && a.hp > b.hp, time: t };
  }
  return { win: a.hp / a.max > b.hp / b.max, time: MAX_TIME };
}

/**
 * Chance to beat a monster. board: the player's board items; health: the player's max health (from the screen).
 * Returns null when the monster or the health is unknown.
 */
export function winChance(monsterCard, board, health, data, opts = {}) {
  const m = data.monsters?.[monsterCard?.combat?.monsterId];
  if (!m || !health || !board.length) return null;
  const A = side(board, health, data);
  const B = side(m.items ?? [], m.health, data);
  const cov = Math.min(coverage(A, opts.mySkills ?? 0), coverage(B, (m.skills ?? []).length));
  const spread = 0.15 + 0.7 * (1 - cov);
  const rand = rng(opts.seed ?? 7);
  const runs = opts.runs ?? 200;
  let wins = 0, time = 0;
  for (let i = 0; i < runs; i++) { const r = simulate(A, B, rand, spread, data.gameMode?.sandstorm ?? {}); wins += r.win ? 1 : 0; time += r.time; }
  return {
    chance: Math.round((wins / runs) * 100),
    seconds: Math.round(time / runs),
    coverage: Math.round(cov * 100),
    confidence: cov >= 0.75 ? 'yüksek' : cov >= 0.45 ? 'orta' : 'düşük',
    ignored: [...A.items, ...B.items].filter((f) => !f.modelled).map((f) => f.name).slice(0, 6),
  };
}

/**
 * How the board compares with the monsters met on this day: 100 = the median monster whose level equals the day
 * (model strength, sum of the items' points per second). Monster levels come from the data.
 */
export function dayPower(board, day, data, strengthOf) {
  if (!board.length) return null;
  const levels = Object.values(data.cards).filter((c) => c.type === 'CombatEncounter' && data.monsters?.[c.combat?.monsterId]);
  if (!levels.length) return null;
  const want = Math.max(1, day ?? 1);
  const nearest = levels.reduce((best, c) => (Math.abs(c.combat.level - want) < Math.abs(best - want) ? c.combat.level : best), levels[0].combat.level);
  const vals = levels.filter((c) => c.combat.level === nearest).map((c) => strengthOf(data.monsters[c.combat.monsterId].items ?? [])).filter((v) => v > 0).sort((a, b) => a - b);
  if (!vals.length) return null;
  const median = vals[Math.floor(vals.length / 2)];
  const mine = strengthOf(board);
  return { percent: Math.round((mine / median) * 100), mine: Math.round(mine * 10) / 10, median: Math.round(median * 10) / 10, level: nearest, monsters: vals.length };
}
