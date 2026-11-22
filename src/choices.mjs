// Rates the options of an event (encounter steps) and describes monsters, for the current build.
// Basis: the game's own data (what each step's actions give) and the item model in model.mjs.
// Everything is turned into the model's "points per second" so options can be compared:
//  - gold: points an average starting item gives per gold of its price (pointsPerGold, computed from the data)
//  - income: gold per day times the days left in the run
//  - max health: counted like a one-time shield over the assumed fight length (assumption)
//  - "your items gain X": the model's value of your matching items, before and after
//  - items: model value of the candidate items against your board (average when one is picked at random)
// XP, tags, transforms and conditional effects are shown but not scored.
// Monsters are described and compared by model strength; the fight estimate lives in fight.mjs.
import { winChance } from './fight.mjs';
import { HORIZON, WEIGHTS, directValue, itemStats, rankEnchant, rankOffers, rankUpgrades } from './model.mjs';

const round = (x) => Math.round(x * 10) / 10;
const ATTR_TR = {
  DamageAmount: 'hasar', ShieldApplyAmount: 'kalkan', HealAmount: 'iyileşme', BurnApplyAmount: 'yanık', PoisonApplyAmount: 'zehir',
  RegenApplyAmount: 'yenilenme', CritChance: 'kritik şansı %', FlatCooldownReduction: 'bekleme süresi azalması', PercentCooldownReduction: 'bekleme süresi azalması %',
  SellPrice: 'satış fiyatı', Multicast: 'çoklu atış', AmmoMax: 'cephane',
};

/** Median model points per gold over valued starting-tier items: how much one gold is worth in points. */
export function pointsPerGold(data) {
  if (data._ppg) return data._ppg;
  const items = Object.values(data.cards).filter((c) => c.type === 'Item' && !/^\[|DEBUG|TEMPLATE/i.test(c.internalName));
  const v = rankOffers(items.map((c) => ({ templateId: c.id })), [], data).map((r) => r.perGold).filter((x) => x > 0).sort((a, b) => a - b);
  return (data._ppg = v.length ? v[Math.floor(v.length / 2)] : 1);
}

function itemValue(card, tier, enchant) {
  return directValue(itemStats(card, tier, enchant));
}

/** Model gain when the player's matching items get `value` added to (or changed on) one attribute. */
function buffGain(g, owned, data) {
  let gain = 0; let n = 0;
  for (const o of owned) {
    if (o.where !== 'board' && !/Stash/.test(g.section ?? '')) continue;
    const c = data.cards[o.templateId];
    const attrs = c?.tiers?.[o.tier]?.attrs;
    if (!attrs) continue;
    const tagged = g.tags.length ? g.tags.some((t) => c.tags.includes(t) || c.hiddenTags.includes(t)) : true;
    const hasAttr = (attrs[g.attr] ?? 0) > 0 || /CooldownReduction|CritChance/.test(g.attr);
    if (!tagged || (!g.tags.length && !hasAttr)) continue;
    n++;
    if (o.where !== 'board') continue;
    const mod = { ...attrs };
    if (g.attr === 'FlatCooldownReduction') mod.CooldownMax = Math.max(1000, (attrs.CooldownMax ?? 0) - g.value);
    else if (g.attr === 'PercentCooldownReduction') mod.CooldownMax = (attrs.CooldownMax ?? 0) * (1 - g.value / 100);
    else if (g.op === 'Add') mod[g.attr] = (attrs[g.attr] ?? 0) + g.value;
    else if (g.op === 'Subtract') mod[g.attr] = (attrs[g.attr] ?? 0) - g.value;
    else if (g.op === 'Multiply') mod[g.attr] = (attrs[g.attr] ?? 0) * g.value;
    const modCard = { ...c, tiers: { ...c.tiers, [o.tier]: { ...c.tiers[o.tier], attrs: mod } } };
    gain += itemValue(modCard, o.tier, o.enchant) - itemValue(c, o.tier, o.enchant);
  }
  return { gain, n };
}

/** Rate the steps an event offers. Returns [] when the event's data lists no steps. */
export function rateChoices(eventCard, run, owned, data, opts = {}) {
  const steps = (eventCard?.choices ?? []).map((id) => data.cards[id]).filter((c) => c?.type === 'EncounterStep' || (opts.self && c?.id === eventCard.id));
  if (!steps.length) return [];
  const ppg = pointsPerGold(data);
  const daysLeft = Math.max(1, (data.gameMode?.days ?? 10) - (run.day ?? 1));
  const names = new Set(owned.map((o) => data.cards[o.templateId]?.name));
  const out = steps.map((st) => {
    const parts = []; let value = 0; let scored = false; let unscored = false;
    const fill = {};
    for (const g of st.grants ?? []) {
      if (g.value != null) fill[g.idx] = g.value;
      if (g.k === 'player') {
        const sign = g.op === 'Subtract' ? -1 : 1;
        if (g.value == null) { unscored = true; continue; }
        if (g.attr === 'Gold') { value += sign * g.value * ppg; scored = true; parts.push(`${sign > 0 ? '+' : '−'}${g.value} altın`); }
        else if (g.attr === 'Income') { value += sign * g.value * daysLeft * ppg; scored = true; parts.push(`${sign > 0 ? '+' : '−'}${g.value} gelir/gün, kalan ${daysLeft} günde ${g.value * daysLeft} altın`); }
        else if (g.attr === 'HealthMax') { value += (sign * g.value * WEIGHTS.shield) / HORIZON; scored = true; parts.push(`${sign > 0 ? '+' : '−'}${g.value} azami can`); }
        else if (g.attr === 'Experience') parts.push(`+${g.value} XP (puanlanmadı)`);
        else { unscored = true; parts.push(`${g.attr} ${sign > 0 ? '+' : '−'}${g.value} (puanlanmadı)`); }
      } else if (g.k === 'cards') {
        if (g.value == null) { unscored = true; continue; }
        const b = buffGain(g, owned, data);
        value += b.gain; scored = true;
        parts.push(`${b.n} eşyana ${g.op === 'Subtract' ? '−' : '+'}${g.value} ${ATTR_TR[g.attr] ?? g.attr}${g.tags.length ? ` (${g.tags.join('/')})` : ''}${b.n ? '' : ': sende uygun eşya yok'}`);
      } else if (g.k === 'spawn') {
        const cands = g.ids.map((id) => data.cards[id]).filter((c) => c?.type === 'Item');
        if (!cands.length) { unscored = true; continue; }
        const ranked = rankOffers(cands.map((c) => ({ templateId: c.id })), owned, data, { free: true });
        const avg = ranked.reduce((n, r) => n + (r.value ?? 0), 0) / ranked.length;
        const count = g.count ?? 1;
        value += avg * count; scored = true;
        parts.push(`${count} eşya: ${cands.slice(0, 3).map((c) => c.name).join(', ')}${cands.length > 3 ? ` (+${cands.length - 3} aday)` : ''}, ortalama ${round(avg)} puan`);
      } else if (g.k === 'upgrade') {
        const up = rankUpgrades(owned, data)[0];
        if (up?.gain > 0) { value += up.gain; scored = true; parts.push(`yükseltme, en iyi ihtimalle ${up.name} +${round(up.gain)}`); } else { unscored = true; parts.push('yükseltme'); }
      } else if (g.k === 'enchant') {
        const en = g.enchant ? rankEnchant(g.enchant, owned, data)[0] : null;
        if (en?.gain > 0) { value += en.gain; scored = true; parts.push(`${g.enchant} büyüsü, en iyi ${en.name} +${round(en.gain)}`); } else { unscored = true; parts.push(`${g.enchant ?? 'rastgele'} büyü`); }
      } else unscored = true;
    }
    let desc = (st.description ?? '').replace(/\{ability\.(\d+)\}/g, (_, i) => (fill[i] != null ? fill[i] : '?')).replace(/\s+/g, ' ').trim();
    const cost = /\(Cost (\d+) Gold\)/i.exec(desc);
    if (cost) { value -= Number(cost[1]) * ppg; parts.push(`maliyet ${cost[1]} altın`); }
    const need = /^\(if you have (?:an? )?([^)]+?)\)/i.exec(desc);
    const missing = need && ![...names].some((n) => n && need[1].toLowerCase().includes(n.toLowerCase()));
    const cantPay = cost && opts.gold != null && Number(cost[1]) > opts.gold;
    return {
      templateId: st.id, name: st.name, desc, value: scored ? round(value) : null,
      reason: parts.join(' · ') || desc || 'veride etkisi yazmıyor',
      verdict: missing ? 'şart yok' : cantPay ? 'para yetmiyor' : !scored ? 'sen karar ver' : '',
      partial: scored && unscored,
    };
  });
  // The same step can be listed more than once (variants); keep the first of each name.
  const seen = new Set();
  const uniq = out.filter((o) => !seen.has(o.name + o.desc) && seen.add(o.name + o.desc));
  uniq.sort((a, b) => (b.verdict === '' ? b.value : -1e9) - (a.verdict === '' ? a.value : -1e9));
  if (uniq[0]?.verdict === '' && uniq[0].value > 0) uniq[0].verdict = 'seç';
  return uniq;
}

/** Model strength of a set of items: sum of their direct points per second. */
export function strengthOf(items, data) { return strength(items, data).v; }

function strength(items, data) {
  let v = 0; const names = [];
  for (const it of items) {
    const c = data.cards[it.templateId];
    if (!c) continue;
    v += itemValue(c, it.tier ?? c.startingTier, it.enchant ?? null);
    names.push(c.name);
  }
  return { v, names };
}

/** Facts about a monster fight next to the player's board. No outcome is predicted. */
export function describeMonster(card, owned, data, health = null, fightOf = null) {
  const m = data.monsters?.[card.combat?.monsterId];
  if (!m) return null;
  const theirs = strength(m.items ?? [], data);
  // How much of the monster the model can put a number on. Auras, triggers and skills are not counted,
  // so a low share means the monster is stronger than its number says.
  const known = (m.items ?? []).filter((it) => { const c = data.cards[it.templateId]; return c && itemValue(c, it.tier ?? c.startingTier, it.enchant ?? null) > 0; }).length;
  const total = (m.items ?? []).length + (m.skills ?? []).length;
  const share = total ? known / total : 0;
  const mine = strength(owned.filter((o) => o.where === 'board'), data);
  const ratio = mine.v > 0 ? theirs.v / mine.v : null;
  return {
    templateId: card.id, name: card.name, level: card.combat.level, health: m.health,
    fight: fightOf ? fightOf(card) : winChance(card, owned.filter((o) => o.where === 'board'), health, data),
    gold: card.combat.gold, xp: card.combat.xp,
    theirs: round(theirs.v), mine: round(mine.v), ratio: ratio == null ? null : round(ratio),
    known, total, uncertain: share < 0.6,
    items: theirs.names,
    skills: (m.skills ?? []).map((s) => data.cards[s.templateId]?.name).filter(Boolean),
    note: share < 0.6 ? `belirsiz: rakibin ${total} eşya ve yeteneğinden yalnızca ${known} tanesi sayıya dökülebiliyor, gerçek gücü daha yüksek` : ratio == null ? 'tahtan boş' : ratio >= 1.5 ? 'model gücü seninkinin çok üstünde' : ratio >= 1 ? 'model gücü seninkinden yüksek' : ratio >= 0.6 ? 'model gücü seninkine yakın' : 'model gücü seninkinden düşük',
  };
}

const TIERS = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary'];

/** Most likely shop tier on a given day (game mode table), never below the item's own starting tier. */
export function likelyTier(data, day, card) {
  const table = data.gameMode?.tierByDay ?? {};
  const row = table[String(Math.min(Math.max(1, day ?? 1), Math.max(1, ...Object.keys(table).map(Number))))];
  const likely = row ? Object.entries(row).sort((a, b) => b[1] - a[1])[0][0] : card.startingTier;
  return TIERS.indexOf(likely) > TIERS.indexOf(card.startingTier) && card.tiers?.[likely] ? likely : card.startingTier;
}

/** Items a merchant can show this hero, as far as the data states its pool (tags, sizes, explicit ids). */
export function merchantPool(card, hero, data) {
  const ids = (card.choices ?? []).filter((id) => data.cards[id]?.type === 'Item');
  const { tags = [], sizes = [], notTags = [] } = card.sells ?? {};
  if ((card.sells?.types ?? []).length && !card.sells.types.includes('Item')) return []; // a skill teacher, not an item pool
  if (!ids.length && !tags.length && !sizes.length && !notTags.length) return [];
  const ok = (c) => c.type === 'Item' && !/^\[|DEBUG|TEMPLATE/i.test(c.internalName) && (!hero || c.heroes.includes(hero) || c.heroes.includes('Common'));
  const has = (c, t) => c.tags.includes(t) || c.hiddenTags.includes(t);
  const byRule = tags.length || sizes.length || notTags.length
    ? Object.values(data.cards).filter((c) => ok(c) && (!tags.length || tags.some((t) => has(c, t))) && !notTags.some((t) => has(c, t)) && (!sizes.length || sizes.includes(c.size)))
    : [];
  return [...new Map([...ids.map((id) => data.cards[id]).filter(ok), ...byRule].map((c) => [c.id, c])).values()];
}

/**
 * Describe and roughly order the encounters on the path-choice screen. options: [[cardId, ...], ...] left to right
 * (one portrait can stand for several cards). The order is a rough guide: each kind has its own yardstick
 * (merchant: what a good buy from its pool is worth to this board; event: its best choice; monster: its reward).
 */
export function rateOptions(options, run, owned, data, opts = {}) {
  const ppg = pointsPerGold(data);
  const board = owned.filter((o) => o.where === 'board');
  const out = options.map((ids) => {
    let cands = ids.map((id) => data.cards[id]).filter(Boolean);
    if (cands[0]?.type === 'CombatEncounter') cands.sort((x, y) => Math.abs((x.combat?.level ?? 0) - (run.day ?? 1)) - Math.abs((y.combat?.level ?? 0) - (run.day ?? 1)));
    const mine = cands.filter((c) => c.heroes.includes(run.hero) || c.heroes.includes('Common'));
    if (mine.length) cands = mine;
    const c = cands[0];
    if (!c) return null;
    if (c.type === 'CombatEncounter') {
      const m = describeMonster(c, owned, data, opts.health ?? null, opts.fightOf ?? null);
      if (m?.fight) m.uncertain = m.fight.coverage < 60;
      if (!m) return { kind: 'canavar', name: c.name, score: null, reason: 'veride canavar bilgisi yok', verdict: '' };
      return { kind: 'canavar', name: c.name, score: round(m.gold * ppg), fight: m.fight, uncertain: m.uncertain, risky: !m.uncertain && (m.fight ? m.fight.chance < 45 : m.ratio != null && m.ratio >= 1.2),
        reason: `${m.uncertain ? `${m.note} · ` : m.fight ? `kazanma tahmini %${m.fight.chance}, güven ${m.fight.confidence} · ` : ''}${m.health} can · ${m.uncertain ? '' : `eşya gücü ${m.theirs}, seninki ${m.mine} · `}ödül ${m.gold} altın, ${m.xp} XP`, verdict: '' };
    }
    const names = [...new Set(cands.map((x) => x.name))];
    if (names.length > 1) return { kind: 'olay', name: names.length > 3 ? 'Sandık / olay' : names.join(' / '), score: null, reason: `${names.length} olası karşılaşma aynı görseli kullanıyor: ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}`, verdict: '' };
    const pool = merchantPool(c, run.hero, data);
    if (pool.length) {
      const ranked = rankOffers(pool.map((p) => ({ templateId: p.id, tier: (c.sells?.tiers ?? []).find((t) => p.tiers?.[t]) ?? likelyTier(data, run.day, p) })), board, data, { gold: /^Sells/i.test(c.description ?? '') ? opts.gold ?? null : null }).filter((r) => r.perSlot > 0);
      const top = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 3)));
      const mean = top.reduce((n, r) => n + r.perSlot, 0) / (top.length || 1);
      const linked = ranked.filter((r) => /sinerji/.test(r.reason)).length;
      const cheapest = Math.min(...ranked.map((r) => r.price ?? Infinity));
      const broke = opts.gold != null && cheapest > opts.gold;
      return { kind: /^Sells/i.test(c.description ?? '') ? 'tüccar' : 'olay', name: c.name, score: ranked.length && !broke ? round(mean) : null,
        reason: `${c.description ?? 'tüccar'} · havuzda ${pool.length} eşya, ${linked} tanesi tahtana bağlı · en iyiler: ${ranked.slice(0, 3).map((r) => r.name).join(', ') || 'yok'}${broke ? ` · en ucuzu ${cheapest} altın, paran yetmiyor` : ''}`, verdict: broke ? 'para yetmiyor' : '' };
    }
    const steps = rateChoices(c, run, owned, data, opts);
    if (steps.length) {
      const best = steps.find((s) => s.value != null && s.verdict !== 'şart yok' && s.verdict !== 'para yetmiyor');
      return { kind: 'olay', name: c.name, score: best ? best.value : null,
        reason: `${c.description ? c.description + ' · ' : ''}${best ? `en iyi seçenek: ${best.name} (${best.reason})` : `seçenekler: ${steps.slice(0, 3).map((s) => s.name).join(', ')}`}`, verdict: '' };
    }
    // An event that gives something the moment it is entered: rate what it gives, like a single choice.
    if ((c.grants ?? []).some((g) => g.k !== 'other')) {
      const own = rateChoices({ id: c.id, choices: [c.id] }, run, owned, data, { ...opts, self: true })[0];
      if (own) return { kind: 'olay', name: c.name, score: own.value, reason: `${own.desc ? own.desc + ' · ' : ''}${own.reason}`, verdict: own.verdict === 'seç' ? '' : own.verdict };
    }
    return { kind: c.type === 'PedestalEncounter' ? 'kaide' : 'olay', name: c.name, score: null, reason: c.description || 'veride açıklama yok', verdict: '' };
  }).filter(Boolean);
  const best = out.filter((o) => o.score != null && !o.risky && !o.uncertain && !o.verdict).sort((a, b) => b.score - a.score)[0];
  if (best && best.score > 0) best.verdict = 'seç';
  for (const o of out) if (o.risky) o.verdict = 'riskli'; else if (o.uncertain) o.verdict = 'belirsiz';
  return out;
}

/**
 * What selling a "When you sell this, ..." item does for this board. Basis: the item's own sell ability in the data.
 * Effects that hit "your leftmost X item" depend on placement, so the best target and the item that would
 * actually receive it right now (leftmost match in the given left-to-right board) are both reported.
 */
export function sellEffect(card, tier, board, data) {
  if (!card?.onSell?.length) return null;
  const attrs = card.tiers?.[tier]?.attrs ?? {};
  const parts = []; let gain = 0; let scored = false; let prep = null;
  for (const g0 of card.onSell) {
    const value = g0.value ?? (g0.ref ? attrs[g0.ref] : null);
    if (g0.k === 'player' && value != null) {
      if (g0.attr === 'HealthMax') { gain += (value * WEIGHTS.shield) / HORIZON; scored = true; parts.push(`+${value} azami can`); }
      else if (g0.attr === 'Gold') { gain += value * pointsPerGold(data); scored = true; parts.push(`+${value} altın`); }
      else if (g0.attr === 'Experience') parts.push(`+${value} XP`);
      else parts.push(`${g0.attr} +${value}`);
    } else if (g0.k === 'cards' && value != null) {
      const g = { ...g0, value };
      const fits = board.filter((o) => buffGain(g, [o], data).n > 0);
      const label = `${g.op === 'Subtract' ? '−' : '+'}${value} ${ATTR_TR[g.attr] ?? g.attr}`;
      if (!fits.length) { parts.push(`${label}: tahtanda uygun eşya yok`); continue; }
      if (/LeftMost|RightMost/.test(g.mode ?? '')) {
        const scoredFits = fits.map((o) => ({ o, gain: buffGain(g, [o], data).gain })).sort((a, b) => b.gain - a.gain);
        const best = scoredFits[0];
        const now = g.mode === 'RightMostCard' ? fits[fits.length - 1] : fits[0];
        const nm = (o) => data.cards[o.templateId]?.name;
        gain += best.gain; scored = true;
        parts.push(`${label} → ${nm(best.o)}`);
        if (now.instanceId !== best.o.instanceId && best.gain > buffGain(g, [now], data).gain) prep = `şu an ${nm(now)} alır; önce ${nm(best.o)} en ${g.mode === 'RightMostCard' ? 'sağdaki' : 'soldaki'} uygun eşya olsun`;
      } else {
        const total = fits.reduce((n, o) => n + buffGain(g, [o], data).gain, 0);
        gain += total; scored = true;
        parts.push(`${fits.length} eşyana ${label}`);
      }
    } else if (g0.k === 'spawn') {
      const names = g0.ids.map((id) => data.cards[id]?.name).filter(Boolean);
      parts.push(`${g0.count ?? 1} eşya verir: ${[...new Set(names)].slice(0, 3).join(', ')}`);
    } else if (g0.k === 'upgrade') parts.push('bir eşyanı yükseltir');
    else if (g0.k === 'enchant') parts.push(`${g0.enchant ?? 'rastgele'} büyüsü verir`);
    else if (g0.k === 'other') parts.push((card.tooltips ?? []).map((t) => t.text).find((t) => /sell this/i.test(t)) ?? 'satınca etkisi var');
  }
  return { gain: round(gain), scored, text: parts.join(' · '), prep };
}

/** Owned items that do something when sold, with what to do about them now. */
export function sellPlays(owned, data) {
  const board = owned.filter((o) => o.where === 'board');
  return owned.map((o) => {
    const c = data.cards[o.templateId];
    const e = sellEffect(c, o.tier, board.filter((b) => b.instanceId !== o.instanceId), data);
    if (!e) return null;
    return { instanceId: o.instanceId, templateId: o.templateId, name: c.name, tier: o.tier, where: o.where, gain: e.scored ? e.gain : null,
      verdict: e.prep ? 'hazırla' : e.scored && e.gain > 0 ? 'sat' : '', reason: e.prep ? `${e.prep} · ${e.text}` : e.text };
  }).filter(Boolean).sort((a, b) => (b.gain ?? -1) - (a.gain ?? -1)).slice(0, 4);
}
