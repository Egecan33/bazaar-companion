// Explicit valuation model. Every number comes from the game's own card data (data/cards.json):
// per-tier attributes (CooldownMax, DamageAmount, Multicast, ...), tags and hidden tags.
// There is no tier list in here and no fight simulation: this is tooltip arithmetic.
//
// Unit: "effective points per second" (pps) over a fight of HORIZON seconds.
//   damage  1 point = 1 damage dealt
//   shield  0.85    = shield absorbs damage 1:1 but not poison
//   heal    0.7     = wasted when at full health
//   burn    the game's own rule (tooltips table + game mode BurnDecrementByAsPercentage = 3): burn damages
//           twice per second and shrinks by 3% each time it does. A point of burn applied at a uniformly
//           random moment has HORIZON/2 seconds = HORIZON ticks left, so it deals (1 - 0.97^HORIZON) / 0.03
//           damage (about 12.2 at 15 s). Not counted: shield halving burn damage, heals cleansing 5%.
//   poison  1 stack = 1 damage per second for the rest of the fight; applied at a uniformly random
//           moment it ticks for HORIZON/2 seconds on average. Ignores shield.
//   regen   same shape as poison, valued as healing.
//   haste / slow / freeze / charge are worth "seconds of an average item" (see utility()).
import { BOARD_SLOTS, SIZE_SLOTS, TIER_ORDER, nextTier, tierOf } from './tiers.mjs';

export const HORIZON = 15; // seconds a typical fight is assumed to last (assumption, not from data)
export const WEIGHTS = { damage: 1, shield: 0.85, heal: 0.7 };
export const BURN_DECAY = 0.03; // per tick, two ticks per second (game data)
export const BURN_PER_POINT = (1 - (1 - BURN_DECAY) ** HORIZON) / BURN_DECAY;
const TYPE_TAGS = ['Weapon', 'Tool', 'Tech', 'Relic', 'Friend', 'Food', 'Apparel', 'Property', 'Aquatic', 'Vehicle', 'Toy', 'Loot', 'Potion', 'Drone', 'Reagent', 'Core', 'Trap', 'Dinosaur', 'Ray', 'Dragon'];
const MECHANICS = ['Damage', 'Shield', 'Burn', 'Haste', 'Charge', 'Ammo', 'Slow', 'Flying', 'Crit', 'Regen', 'Poison', 'Heal', 'Freeze', 'Rage', 'Economy'];

const round = (x) => Math.round(x * 10) / 10;

/** Raw per-second output of one item at a tier, optionally with an enchantment's attributes. */
export function itemStats(card, tier, enchant = null) {
  const t = tierOf(card, tier);
  if (!t) return emptyStats();
  const ench = enchant ? card.enchantments?.[enchant] : null;
  const a = { ...t.attrs };
  for (const [k, v] of Object.entries(ench?.attrs ?? {})) a[k] = (a[k] ?? 0) + v;
  const cd = (a.CooldownMax ?? 0) / 1000;
  const s = emptyStats();
  s.cooldown = cd || null;
  if (!cd) {
    s.passive = true;
    return s;
  }
  const multicast = Math.max(1, a.Multicast ?? 1);
  let usesPerSec = multicast / cd;
  if (a.AmmoMax) usesPerSec = Math.min(usesPerSec, (a.AmmoMax * multicast) / HORIZON); // no reload assumed
  const actions = new Set([...(card.abilities ?? []), ...(ench?.abilities ?? [])].filter((x) => x.trigger === 'TTriggerOnCardFired').map((x) => x.action));
  const crit = 1 + (a.CritChance ?? 0) / 100;
  if (actions.has('TActionPlayerDamage')) s.damage = (a.DamageAmount ?? 0) * crit * usesPerSec;
  if (actions.has('TActionPlayerShieldApply')) s.shield = (a.ShieldApplyAmount ?? 0) * crit * usesPerSec;
  if (actions.has('TActionPlayerHeal')) s.heal = (a.HealAmount ?? 0) * crit * usesPerSec;
  if (a.Lifesteal && s.damage) s.heal += s.damage;
  if (actions.has('TActionPlayerBurnApply')) {
    const n = a.BurnApplyAmount ?? 0;
    s.burn = n * usesPerSec;
    s.burnDamage = n * BURN_PER_POINT * usesPerSec;
  }
  if (actions.has('TActionPlayerPoisonApply')) {
    s.poison = (a.PoisonApplyAmount ?? 0) * usesPerSec;
    s.poisonDamage = s.poison * (HORIZON / 2);
  }
  if (actions.has('TActionPlayerRegenApply')) {
    s.regen = (a.RegenApplyAmount ?? 0) * usesPerSec;
    s.heal += s.regen * (HORIZON / 2);
  }
  // Time effects: seconds of item time gained (haste, charge) or denied (slow, freeze) per second.
  const sec = (amount, targets) => ((amount ?? 0) / 1000) * Math.max(1, targets ?? 1) * usesPerSec;
  if (actions.has('TActionCardHaste')) s.hasteSec = sec(a.HasteAmount, a.HasteTargets);
  if (actions.has('TActionCardCharge')) s.chargeSec = sec(a.ChargeAmount, a.ChargeTargets);
  if (actions.has('TActionCardSlow')) s.slowSec = sec(a.SlowAmount, a.SlowTargets);
  if (actions.has('TActionCardFreeze')) s.freezeSec = sec(a.FreezeAmount, a.FreezeTargets);
  // Destroying an enemy item removes it for the rest of the fight: HORIZON/2 seconds on average.
  if (actions.has('TActionCardDisable') || actions.has('TActionCardDestroy')) {
    s.destroySec = Math.max(1, a.DisableTargets ?? a.DestroyTargets ?? 1) * usesPerSec * (HORIZON / 2);
  }
  s.unmodelled = directValue(s) === 0 && !(s.hasteSec || s.chargeSec || s.slowSec || s.freezeSec || s.destroySec);
  return s;
}

function emptyStats() {
  return { cooldown: null, passive: false, damage: 0, shield: 0, heal: 0, burn: 0, burnDamage: 0, poison: 0, poisonDamage: 0, regen: 0, hasteSec: 0, chargeSec: 0, slowSec: 0, freezeSec: 0, destroySec: 0, unmodelled: false };
}

/** Points per second from direct output only. */
export function directValue(s) {
  return (s.damage + s.burnDamage + s.poisonDamage) * WEIGHTS.damage + s.shield * WEIGHTS.shield + s.heal * WEIGHTS.heal;
}

/**
 * Time effects in points per second. One second of haste doubles one item's output for that
 * second, so it is worth that item's pps; charge skips cooldown the same way. Slow halves and
 * freeze stops an enemy item; without enemy data the enemy's average item is assumed to equal
 * ours (stated assumption). avgItemPps is the board's mean direct value per active item.
 */
export function utilityValue(s, avgItemPps) {
  return (s.hasteSec + s.chargeSec) * avgItemPps + s.slowSec * 0.5 * avgItemPps + (s.freezeSec + s.destroySec) * avgItemPps;
}

/** Tags a card refers to in its text or hidden "XReference" tags: what it wants on the board. */
export function wants(card) {
  const out = new Set();
  for (const h of card.hiddenTags ?? []) {
    const m = h.match(/^(\w+)Reference$/);
    if (m) out.add(m[1]);
  }
  const text = (card.tooltips ?? []).map((t) => t.text).join(' ');
  for (const tag of TYPE_TAGS) {
    if (new RegExp(`\\b${tag}s?\\b`).test(text)) out.add(tag);
  }
  return [...out];
}

/** Tags a card provides: its type tags and the mechanics it performs. */
export function provides(card) {
  return [...(card.tags ?? []), ...(card.hiddenTags ?? []).filter((h) => MECHANICS.includes(h))];
}

export function boardSummary(owned, cards) {
  const board = owned.filter((o) => o.where !== 'stash');
  const tagCount = {};
  const total = emptyStats();
  let active = 0;
  let slots = 0;
  const rows = [];
  for (const o of board) {
    const c = cards[o.templateId];
    if (!c) continue;
    slots += SIZE_SLOTS[c.size] ?? 1;
    for (const t of provides(c)) tagCount[t] = (tagCount[t] ?? 0) + 1;
    const s = itemStats(c, o.tier, o.enchant);
    for (const k of Object.keys(total)) if (typeof s[k] === 'number' && k !== 'cooldown') total[k] += s[k];
    if (!s.passive) active += 1;
    rows.push({ o, c, s, direct: directValue(s) });
  }
  const directSum = rows.reduce((x, r) => x + r.direct, 0);
  const avgItemPps = active ? directSum / active : 0;
  return { rows, tagCount, total, slots, free: BOARD_SLOTS - slots, avgItemPps, directSum };
}

function synergy(card, summary, cards, selfId = null) {
  const w = wants(card);
  const p = provides(card);
  let links = 0;
  const why = [];
  for (const tag of w) {
    const n = (summary.tagCount[tag] ?? 0) - (selfId && p.includes(tag) ? 1 : 0);
    if (n > 0) {
      links += n;
      why.push(`${n}× ${tag}`);
    }
  }
  let wanted = 0;
  for (const r of summary.rows) {
    if (selfId && r.o.instanceId === selfId) continue;
    if (wants(r.c).some((t) => p.includes(t))) wanted += 1;
  }
  if (wanted) why.push(`${wanted} eşyan bunu istiyor`);
  return { links: links + wanted, why };
}

function statLine(s) {
  const parts = [];
  if (s.damage) parts.push(`${round(s.damage)} hasar/sn`);
  if (s.burn) parts.push(`${round(s.burn)} yanık/sn`);
  if (s.poison) parts.push(`${round(s.poison)} zehir/sn`);
  if (s.shield) parts.push(`${round(s.shield)} kalkan/sn`);
  if (s.heal) parts.push(`${round(s.heal)} iyileşme/sn`);
  if (s.hasteSec) parts.push(`${round(s.hasteSec)} sn hız/sn`);
  if (s.chargeSec) parts.push(`${round(s.chargeSec)} sn şarj/sn`);
  if (s.slowSec) parts.push(`${round(s.slowSec)} sn yavaşlatma/sn`);
  if (s.freezeSec) parts.push(`${round(s.freezeSec)} sn dondurma/sn`);
  if (s.destroySec) parts.push(`rakip eşya yok eder (${round(s.destroySec)} sn eşya süresi/sn)`);
  if (s.passive) parts.push('pasif, sayıya dökülemiyor');
  return parts.join(', ') || 'etkisi sayıya dökülemiyor';
}

export const SYNERGY_BONUS = 0.2; // each link adds 20% of the board's average item value (assumption)

function score(card, tier, summary, cards, opts = {}) {
  const s = itemStats(card, tier, opts.enchant);
  const direct = directValue(s);
  const util = utilityValue(s, summary.avgItemPps);
  const syn = synergy(card, summary, cards, opts.selfId);
  const base = summary.avgItemPps || 5;
  const value = direct + util + syn.links * SYNERGY_BONUS * base;
  return { s, direct, util, syn, value };
}

/**
 * Rank items offered to the player (e.g. a shop). offers: [{ templateId, tier? }]
 * opts.gold: gold in hand when known (null = unknown). opts.free: the encounter gives items for free.
 * With gold known, the best affordable set is marked (exhaustive search over the few offers).
 */
export function rankOffers(offers, owned, data, opts = {}) {
  const ranked = rankOffersRaw(offers, owned, data);
  const gold = opts.gold ?? null;
  for (const r of ranked) {
    if (opts.free) r.price = 0;
    r.perGold = r.price ? round(r.value / r.price) : null;
    r.affordable = gold == null || r.price == null ? null : r.price <= gold;
    if (r.affordable === false) {
      r.verdict = 'para yetmiyor';
      r.reason += ` · ${r.price - gold} altın eksik`;
    } else if (r.perGold != null && !opts.free) {
      r.reason += ` (${r.perGold} puan/altın)`;
    }
  }
  if (gold != null && !opts.free) {
    const buyable = ranked.filter((r) => r.verdict === 'al' && r.price != null);
    let best = { value: 0, set: [] };
    for (let mask = 1; mask < 1 << Math.min(buyable.length, 10); mask++) {
      let cost = 0;
      let value = 0;
      const set = [];
      buyable.forEach((r, i) => {
        if (mask & (1 << i)) {
          cost += r.price;
          value += r.value;
          set.push(r);
        }
      });
      if (cost <= gold && value > best.value) best = { value, set };
    }
    for (const r of buyable) {
      if (r.affordable && !best.set.includes(r)) {
        r.verdict = 'bütçe dışı';
        r.reason += ' · bu altınla daha iyi kombinasyon var';
      }
    }
  }
  return ranked;
}

/**
 * Should the player pay to reroll the shop? Explicit expected-value estimate:
 *  - pool: the game data does not list a merchant's pool, so it is inferred from what is on offer
 *    now: items the hero can get, restricted to the tag and size all current offers share (if any)
 *    and to the tiers currently offered. This is an assumption and is shown as such.
 *  - gain: E[best of N random pool items] - best current offer, in points per slot.
 *  - price of a point: median price/points over the pool, so the gain can be compared with gold.
 */
export function rerollAdvice(offers, owned, data, opts = {}) {
  const { cards } = data;
  const shop = opts.shop ?? null;
  const cost = shop?.rerollCost ?? null;
  if (shop && (cost == null || !shop.rerollsAllowed)) return { possible: false, reason: 'Bu karşılaşmada yeniden çekme yok.' };
  const cur = rankOffersRaw(offers, owned, data);
  if (!cur.length) return null;
  const offered = cur.map((r) => cards[r.templateId]);
  const sharedTag = (offered[0].tags ?? []).find((t) => offered.every((c) => c.tags.includes(t))) ?? null;
  const sharedSize = offered.every((c) => c.size === offered[0].size) ? offered[0].size : null;
  const tiers = new Set(cur.map((r) => r.tier));
  const hero = opts.hero ?? null;
  const pool = Object.values(cards).filter(
    (c) =>
      c.type === 'Item' &&
      !/^\[|DEBUG|TEMPLATE/i.test(c.internalName) &&
      (!hero ? true : c.heroes.includes(hero) || c.heroes.includes('Common')) &&
      (!sharedTag || c.tags.includes(sharedTag)) &&
      (!sharedSize || c.size === sharedSize) &&
      tiers.has(c.startingTier),
  );
  if (pool.length < 5) return null;
  const vals = rankOffersRaw(pool.map((c) => ({ templateId: c.id })), owned, data);
  const left = opts.gold != null && cost != null ? opts.gold - cost : null;
  // An item we could not pay for after the reroll is worth nothing to this decision.
  const sorted = vals.map((v) => (left != null && v.price != null && v.price > left ? 0 : v.perSlot)).sort((a, b) => a - b);
  const n = cur.length;
  // E[max of n draws] from the empirical distribution: sum over ranks of v_i * P(max is rank i)
  const N = sorted.length;
  let expBest = 0;
  for (let i = 0; i < N; i++) expBest += sorted[i] * (((i + 1) / N) ** n - (i / N) ** n);
  const gold0 = opts.gold ?? null;
  const affordableNow = gold0 == null ? cur : cur.filter((r) => r.price == null || r.price <= gold0);
  const best = affordableNow.length ? affordableNow[0].perSlot : 0;
  const gain = expBest - best;
  const ppg = vals.filter((v) => v.price && v.value > 0).map((v) => v.price / v.value).sort((a, b) => a - b);
  const goldPerPoint = ppg.length ? ppg[Math.floor(ppg.length / 2)] : null;
  const gainGold = goldPerPoint != null ? gain * goldPerPoint : null;
  const beats = sorted.filter((v) => v > best).length / N;
  const gold = opts.gold ?? null;
  let verdict;
  if (gold != null && cost != null && gold < cost) verdict = 'para yetmiyor';
  else if (gain <= 0) verdict = 'çekme';
  else if (cost == null) verdict = 'maliyet bilinmiyor';
  else if (gainGold != null && gainGold > cost) verdict = 'çek';
  else verdict = 'çekme';
  const poolDesc = [hero ?? 'tüm kahramanlar', sharedTag, sharedSize, [...tiers].join('/')].filter(Boolean).join(', ');
  return {
    possible: true,
    verdict,
    cost,
    best: round(best),
    expectedBest: round(expBest),
    gain: round(gain),
    gainGold: gainGold == null ? null : round(gainGold),
    chanceBetter: Math.round((1 - (1 - beats) ** n) * 100),
    poolSize: N,
    reason: `${gold0 != null ? 'alabildiğin' : 'şimdiki'} en iyi ${round(best)}, yeni ${n} karttan beklenen en iyi ${round(expBest)} puan/yuva · daha iyisi gelme ihtimali %${Math.round((1 - (1 - beats) ** n) * 100)}${cost != null ? ` · maliyet ${cost} altın` : ''}${gainGold != null && gain > 0 ? ` · kazanç ≈ ${round(gainGold)} altın değerinde` : ''} · havuz varsayımı: ${poolDesc} (${N} eşya)`,
  };
}

function rankOffersRaw(offers, owned, data) {
  const { cards, gameMode } = data;
  const summary = boardSummary(owned, cards);
  const worst = weakest(summary, cards);
  return offers
    .map((of) => {
      const c = cards[of.templateId];
      if (!c || c.type !== 'Item') return null;
      const tier = of.tier ?? c.startingTier;
      const sc = score(c, tier, summary, cards);
      const slots = SIZE_SLOTS[c.size] ?? 1;
      const price = gameMode.buyPrices?.[c.size]?.[tier] ?? null;
      const fits = slots <= summary.free;
      const reason = [statLine(sc.s)];
      if (sc.s.passive || sc.s.unmodelled) reason.push(`oyun metni: ${(c.tooltips ?? []).map((t) => t.text.replace(/\{[^}]+\}/g, 'X')).join(' / ')}`);
      if (sc.syn.why.length) reason.push(`sinerji: ${sc.syn.why.join(', ')}`);
      if (price != null) reason.push(`${price} altın`);
      if (!fits) reason.push(worst ? `yer yok, ${worst.name} yerine` : 'tahtada yer yok');
      return {
        templateId: c.id,
        name: c.name,
        tier,
        size: c.size,
        tags: c.tags,
        price,
        value: round(sc.value),
        perSlot: round(sc.value / slots),
        fits,
        modelled: !(sc.s.passive || sc.s.unmodelled),
        verdict: !fits && worst && sc.value / slots <= worst.perSlot ? 'geç' : sc.s.passive || sc.s.unmodelled ? 'sen karar ver' : sc.value > 0 ? 'al' : 'geç',
        reason: reason.join(' · '),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.perSlot - a.perSlot);
}

function weakest(summary, cards) {
  const rows = ownedScores(summary, cards);
  return rows.length ? rows[0] : null;
}

function ownedScores(summary, cards) {
  return summary.rows
    .map((r) => {
      const sc = score(r.c, r.o.tier, summary, cards, { selfId: r.o.instanceId, enchant: r.o.enchant });
      const slots = SIZE_SLOTS[r.c.size] ?? 1;
      return { r, sc, slots, name: r.c.name, perSlot: sc.value / slots };
    })
    .sort((a, b) => a.perSlot - b.perSlot);
}

/** Owned items from weakest to strongest per slot, with the standard sell price. */
export function rankSell(owned, data) {
  const { cards, gameMode } = data;
  const summary = boardSummary(owned, cards);
  return ownedScores(summary, cards).map(({ r, sc, perSlot }) => ({
    instanceId: r.o.instanceId,
    templateId: r.o.templateId,
    name: r.c.name,
    tier: r.o.tier,
    size: r.c.size,
    sellPrice: gameMode.sellPrices?.[r.c.size]?.[r.o.tier] ?? null,
    perSlot: round(perSlot),
    passive: sc.s.passive,
    reason: `${statLine(sc.s)}${sc.syn.why.length ? ` · sinerji: ${sc.syn.why.join(', ')}` : ' · sinerjisi yok'}`,
  }));
}

/** Gain from raising each owned item one tier. */
export function rankUpgrades(owned, data) {
  const { cards } = data;
  const summary = boardSummary(owned, cards);
  return summary.rows
    .map((r) => {
      const nt = nextTier(r.c, r.o.tier);
      if (!nt) return null;
      const now = score(r.c, r.o.tier, summary, cards, { selfId: r.o.instanceId, enchant: r.o.enchant });
      const then = score(r.c, nt, summary, cards, { selfId: r.o.instanceId, enchant: r.o.enchant });
      const gain = then.direct + then.util - (now.direct + now.util);
      return {
        instanceId: r.o.instanceId,
        name: r.c.name,
        from: r.o.tier,
        to: nt,
        gain: round(gain),
        reason: gain > 0 ? `${statLine(now.s)} → ${statLine(then.s)}` : 'sayısal kazanç modelde görünmüyor (pasif veya özel etki)',
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.gain - a.gain);
}

/** Gain from putting one enchantment on each owned item. */
export function rankEnchant(enchant, owned, data) {
  const { cards } = data;
  const summary = boardSummary(owned, cards);
  return summary.rows
    .map((r) => {
      const e = r.c.enchantments?.[enchant];
      if (!e || r.o.enchant) return null;
      const now = score(r.c, r.o.tier, summary, cards, { selfId: r.o.instanceId });
      const then = score(r.c, r.o.tier, summary, cards, { selfId: r.o.instanceId, enchant });
      const gain = then.direct + then.util - (now.direct + now.util);
      return {
        instanceId: r.o.instanceId,
        name: r.c.name,
        gain: round(gain),
        reason: e.tooltips[0] ? `${e.tooltips[0]}${gain > 0 ? ` · +${round(gain)} puan/sn` : ''}` : statLine(then.s),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.gain - a.gain);
}

/** Skills are passive: rank by how many board items their text or hidden tags touch. */
export function rankSkills(skillIds, owned, data) {
  const { cards } = data;
  const summary = boardSummary(owned, cards);
  return skillIds
    .map((id) => {
      const c = cards[id];
      if (!c) return null;
      const w = wants(c);
      const mech = (c.hiddenTags ?? []).filter((h) => MECHANICS.includes(h));
      const touched = [...new Set([...w, ...mech])].map((t) => [t, summary.tagCount[t] ?? 0]).filter(([, n]) => n > 0);
      const n = touched.reduce((x, [, k]) => x + k, 0);
      const text = (c.tooltips ?? []).map((t) => t.text).join(' ');
      return {
        templateId: id,
        name: c.name,
        touches: n,
        reason: `${touched.length ? `tahtanda ${touched.map(([t, k]) => `${k}× ${t}`).join(', ')}` : 'tahtanla eşleşen etiket yok'} · ${text}`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.touches - a.touches);
}

/** Facts for encounter choices. Fights are ordered by reward per monster health; no outcome is predicted. */
export function describeEncounters(ids, data) {
  const { cards, monsters } = data;
  return ids
    .map((id) => {
      const c = cards[id];
      if (!c) return null;
      if (c.type === 'CombatEncounter') {
        const m = monsters[c.combat.monsterId];
        const hp = m?.health ?? null;
        const reward = (c.combat.gold ?? 0) + (c.combat.xp ?? 0);
        return {
          templateId: id,
          name: c.name,
          kind: 'savaş',
          order: hp ? reward / hp : 0,
          reason: `${hp ?? '?'} can, seviye ${c.combat.level ?? '?'}, ${m?.items.length ?? '?'} eşya · ödül ${c.combat.gold} altın + ${c.combat.xp} XP`,
        };
      }
      const text = c.description || (c.tooltips ?? []).map((t) => t.text).join(' ') || '';
      return { templateId: id, name: c.name, kind: c.type === 'PedestalEncounter' ? 'kaide' : 'olay', order: 0, reason: text || 'veride açıklama yok' };
    })
    .filter(Boolean)
    .sort((a, b) => b.order - a.order);
}

export { TIER_ORDER };
