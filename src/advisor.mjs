// Advice computed with the board engine: what an item adds to THIS board (all modelled interactions included),
// where it should sit, what to swap from the stash, how the board compares with the day's monsters, and the
// chance against a monster. Results are cached per board, because a board evaluation takes a few milliseconds
// and the view is rebuilt on every screen frame.
import { boardValue, coverageOf, runFight } from './engine.mjs';

const SLOTS = { Small: 1, Medium: 2, Large: 3 };
const round = (x) => Math.round(x * 10) / 10;
const cache = new Map();
function memo(key, fn) {
  if (cache.has(key)) return cache.get(key);
  if (cache.size > 400) cache.clear();
  const v = fn();
  cache.set(key, v);
  return v;
}
const sig = (items) => items.map((o) => `${o.templateId}:${o.tier}:${o.enchant ?? ''}`).join(',');
const slotsOf = (o, data) => SLOTS[data.cards[o.templateId]?.size] ?? 1;
const entry = (o) => ({ templateId: o.templateId, tier: o.tier, enchant: o.enchant ?? null, ...(o.attrs ? { attrs: o.attrs } : {}) });

function value(items, skills, data, refDps, seeds) {
  return memo(`v|${refDps}|${seeds.join('')}|${skills.join(',')}|${sig(items)}`, () => boardValue(items.map(entry), skills, data, { refDps, seeds }));
}

/** Engine strength of the day's typical monster: median over monsters whose level equals the day. */
export function dayReference(day, data) {
  return memo(`ref|${day}`, () => {
    const mons = Object.values(data.cards).filter((c) => c.type === 'CombatEncounter' && data.monsters?.[c.combat?.monsterId]);
    if (!mons.length) return { median: 15, level: day, count: 0 };
    const want = Math.max(1, day ?? 1);
    const level = mons.reduce((best, c) => (Math.abs(c.combat.level - want) < Math.abs(best - want) ? c.combat.level : best), mons[0].combat.level);
    const vals = mons.filter((c) => c.combat.level === level).map((c) => {
      const m = data.monsters[c.combat.monsterId];
      return boardValue((m.items ?? []).map(entry), m.skills ?? [], data, { refDps: 15, seeds: [1], player: m.player }).value;
    }).filter((v) => v > 0).sort((a, b) => a - b);
    return { median: vals.length ? vals[Math.floor(vals.length / 2)] : 15, level, count: vals.length };
  });
}

function partsText(now, base) {
  const d = (k) => now.parts[k] - (base?.parts[k] ?? 0);
  const out = [];
  for (const [k, label] of [['damage', 'hasar'], ['shield', 'kalkan'], ['heal', 'iyileşme'], ['denied', 'rakibi engelleme']]) if (Math.abs(d(k)) >= 0.05) out.push(`${label} ${d(k) > 0 ? '+' : '−'}${round(Math.abs(d(k)))}`);
  return out.join(', ');
}

/** Best order found by swapping pairs while the engine value improves, starting from the order given. */
function bestOrder(board, skills, data, refDps) {
  return memo(`order|${refDps}|${skills.join(',')}|${sig(board)}`, () => {
    let best = board.slice();
    let bestV = value(best, skills, data, refDps, [1]).value;
    const startV = bestV;
    let improved = board.length > 1, passes = 0;
    while (improved && passes++ < 4) {
      improved = false;
      for (let i = 0; i < best.length; i++) for (let j = i + 1; j < best.length; j++) {
        if (best[i].templateId === best[j].templateId && best[i].tier === best[j].tier) continue;
        const p = best.slice(); [p[i], p[j]] = [p[j], p[i]];
        const v = value(p, skills, data, refDps, [1]).value;
        if (v > bestV * 1.01 + 0.05) { best = p; bestV = v; improved = true; }
      }
    }
    return { order: best, value: bestV, startValue: startV };
  });
}

/** What adding one item is worth: best insert position, or the best item to take out when there is no room. */
function addValue(board, skills, cand, data, refDps, capacity = 10) {
  return memo(`add|${capacity}|${refDps}|${skills.join(',')}|${sig(board)}|+${sig([cand])}`, () => {
    const base = value(board, skills, data, refDps, [1]);
    const free = capacity - board.reduce((n, o) => n + slotsOf(o, data), 0);
    const need = slotsOf(cand, data);
    let best = null;
    const consider = (items, pos, out) => {
      const v = value(items, skills, data, refDps, [1]);
      if (!best || v.value > best.v.value) best = { v, pos, out, items };
    };
    if (need <= free) for (let i = 0; i <= board.length; i++) consider([...board.slice(0, i), cand, ...board.slice(i)], i, null);
    else for (let j = 0; j < board.length; j++) {
      if (slotsOf(board[j], data) + free < need) continue;
      const rest = board.filter((_, k) => k !== j);
      for (const i of new Set([j, 0, rest.length])) consider([...rest.slice(0, i), cand, ...rest.slice(i)], i, board[j]);
    }
    if (!best) return { gain: null, fits: false, text: 'yer yok: çıkarılabilecek uygun eşya yok' };
    const gain = best.v.value - base.value;
    const nm = (o) => data.cards[o.templateId]?.name;
    const left = best.items[best.pos - 1], right = best.items[best.pos + 1];
    const where = left && right ? `${nm(left)} ile ${nm(right)} arasına` : left ? `en sağa, ${nm(left)} yanına` : right ? `en sola, ${nm(right)} yanına` : '';
    return { gain: round(gain), fits: need <= free, out: best.out ? nm(best.out) : null, outId: best.out?.instanceId ?? null, where, parts: partsText(best.v, base) };
  });
}

/** Everything the panel needs from the engine for one state. board is left to right. */
/**
 * Buy in the order that helps most, re-valuing what is left after each purchase (an item's worth changes once
 * another has joined the board). Stops when gold runs out or nothing adds value. free: the shop charges nothing.
 */
function buyPlan(board, skills, offers, gold, free, data, refDps, capacity, maxBuys = 4) {
  let cur = board.slice(); let left = gold; const rest = offers.slice(); const plan = [];
  const priceOf = (o) => (free ? 0 : data.gameMode.buyPrices?.[data.cards[o.templateId]?.size]?.[o.tier] ?? 0);
  for (let step = 0; step < maxBuys && rest.length; step++) {
    let best = null;
    for (const o of rest) {
      const price = priceOf(o);
      if (left != null && price > left) continue;
      const r = addValue(cur, skills, { templateId: o.templateId, tier: o.tier, instanceId: `buy${step}` }, data, refDps, capacity);
      if (r.gain != null && r.gain > 0.3 && (!best || r.gain > best.r.gain)) best = { o, r, price };
    }
    if (!best) break;
    plan.push({ templateId: best.o.templateId, gain: best.r.gain, price: best.price, out: best.r.out, where: best.r.where, parts: best.r.parts });
    rest.splice(rest.indexOf(best.o), 1);
    if (left != null) left -= best.price;
    const bought = { templateId: best.o.templateId, tier: best.o.tier, instanceId: `bought${step}` };
    cur = best.r.outId ? cur.filter((x) => x.instanceId !== best.r.outId) : cur;
    cur = [...cur, bought]; // its exact seat is settled by the placement step that follows
  }
  // Where everything should sit once the purchases are in: the best order of the resulting board.
  const finalOrder = plan.length ? bestOrder(cur, skills, data, refDps).order.map((o) => data.cards[o.templateId]?.name) : null;
  return { plan, goldLeft: left, finalOrder };
}

export function engineAdvice(board, stash, skills, offers, run, data, skillOffers = [], opts = {}) {
  const ref = dayReference(run.day ?? 1, data);
  const refDps = Math.round(ref.median);
  const capacity = opts.capacity ?? 10;
  const base = value(board, skills, data, refDps, [1, 2, 3]);
  const ord = bestOrder(board, skills, data, refDps);
  const cov = coverageOf(board.map(entry), skills, data);
  const out = {
    value: round(base.value), parts: Object.fromEntries(Object.entries(base.parts).map(([k, v]) => [k, round(v)])),
    per: base.per.map((p) => ({ name: p.name, damage: round(p.damage), shield: round(p.shield), heal: round(p.heal), uses: round(p.uses) })),
    coverage: Math.round(cov.share * 100), unhandled: cov.missed.slice(0, 5), firstUse: board.length ? base.firstUse : null,
    power: board.length ? { percent: Math.round((base.value / ref.median) * 100), mine: round(base.value), median: round(ref.median), level: ref.level, monsters: ref.count } : null,
    order: ord.order.map((o) => o.instanceId), orderGain: round(ord.value - ord.startValue), orderChanged: ord.order.some((o, i) => o.instanceId !== board[i]?.instanceId),
    offers: offers.map((of) => ({ templateId: of.templateId, ...addValue(board, skills, { templateId: of.templateId, tier: of.tier, instanceId: 'offer' }, data, refDps, capacity) })),
    stash: stash.map((s) => ({ instanceId: s.instanceId, templateId: s.templateId, ...addValue(board, skills, s, data, refDps, capacity) })),
    buys: buyPlan(board, skills, offers, opts.gold ?? null, opts.free ?? false, data, refDps, capacity, opts.maxBuys ?? 4),
    capacity,
  };
  // What the owned skills add, and what each offered skill would add, on this exact board.
  out.skillGain = skills.length ? round(base.value - value(board, [], data, refDps, [1, 2, 3]).value) : 0;
  out.skillOffers = skillOffers.map((id) => ({ templateId: id, gain: board.length ? round(value(board, [...skills, id], data, refDps, [1, 2, 3]).value - base.value) : null, handled: coverageOf([], [id], data).share === 1 }));
  // What each board item is worth here: the value the board loses without it.
  out.keep = board.map((o, i) => ({ instanceId: o.instanceId, name: data.cards[o.templateId]?.name, loss: round(base.value - value(board.filter((_, k) => k !== i), skills, data, refDps, [1, 2, 3]).value) }));
  return out;
}

/** Chance against a monster: share of engine fights won over many seeds, with how much of both sides is handled. */
// How far the engine's item outputs are allowed to be off, per item and per run (log-normal sigma). The engine
// has been compared with one real fight so far (it got the length right and the winner wrong, by 87 health of 400),
// so this is an assumption, not a calibration. data/fights.jsonl collects the cases to calibrate it with.
export const MODEL_NOISE = 0.15;

export function engineFight(monsterCard, board, skills, health, data, runs = 60) {
  const m = data.monsters?.[monsterCard?.combat?.monsterId];
  if (!m || !health || !board.length) return null;
  return memo(`fight|${monsterCard.id}|${health}|${skills.join(',')}|${sig(board)}`, () => {
    const a = { items: board.map(entry), skills, health };
    const b = { items: (m.items ?? []).map(entry), skills: m.skills ?? [], health: m.health, player: m.player, level: m.level };
    let wins = 0, secs = 0, margin = 0;
    for (let s = 1; s <= runs; s++) { const r = runFight(a, b, data, { seed: s, noise: MODEL_NOISE }); wins += r.win ? 1 : 0; secs += r.seconds; margin += r.margin; }
    const ca = coverageOf(a.items, skills, data), cb = coverageOf(b.items, b.skills, data);
    const share = Math.min(ca.share, cb.share);
    const chance = Math.round((wins / runs) * 100);
    return { chance, seconds: Math.round(secs / runs), coverage: Math.round(share * 100), margin: Math.round((margin / runs) * 100),
      // Never "you will win": three bands, and the middle one is wide on purpose. A fight that ends with less
      // than a quarter of a health bar between the two sides is close whatever the win share says.
      band: chance >= 75 && margin / runs >= 0.25 ? 'avantajlı' : chance <= 25 && margin / runs <= -0.25 ? 'zor' : 'yakın',
      confidence: share >= 0.85 ? 'orta (kalibre edilmedi)' : 'düşük', ignored: [...new Set([...ca.missed, ...cb.missed])].slice(0, 6) };
  });
}
