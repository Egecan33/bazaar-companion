// Turns the tracked run + the latest screen frame into what the UI shows. Pure function.
import { describeMonster, likelyTier, rateChoices, rateOptions, sellEffect, sellPlays, strengthOf } from './choices.mjs';
import { engineAdvice, engineFight } from './advisor.mjs';
import { bestLayout, describeLinks } from './layout.mjs';
import { HORIZON, SYNERGY_BONUS, WEIGHTS, boardSummary, describeEncounters, rankEnchant, rankOffers, rankSell, rankSkills, rankUpgrades, rerollAdvice } from './model.mjs';

export const OFFER_SPLIT = 0.55; // measured on real frames: offers sit at 0.37-0.50 (the middle one lowest), the own board at 0.60-0.66
export const OFFER_SPLIT_OLD = 0.5; // detections above this fraction of the screen height count as "on offer"
const round = (x) => Math.round(x * 10) / 10;

function pickCard(ids, cards, hero) {
  const cs = ids.map((id) => cards[id]).filter(Boolean);
  return cs.find((c) => hero && c.heroes?.includes(hero)) ?? cs[0] ?? null;
}

/**
 * The log misses items that arrive as rewards and every move between board and stash, so the board
 * row read from the screen wins when there is one: screenBoard = [{ cardIds, cx }] left to right.
 * Tracked instances are matched to it by item (keeping their tier); items only the screen knows get a
 * placeholder instance at their starting tier; tracked board items the screen does not show count as stash.
 */
function reconcile(tracked, screenBoard, cards, hero, screenStash = null) {
  if (!screenBoard?.length && !screenStash) return { owned: tracked, screenOrder: null };
  screenBoard = screenBoard ?? [];
  const pool = tracked.slice();
  const board = [];
  screenBoard.forEach((d, i) => {
    const c = pickCard(d.cardIds ?? [], cards, hero);
    if (!c || c.type !== 'Item') return;
    let j = pool.findIndex((o) => o.templateId === c.id && o.where === 'board');
    if (j < 0) j = pool.findIndex((o) => o.templateId === c.id);
    if (j >= 0) board.push({ ...pool.splice(j, 1)[0], where: 'board' });
    else board.push({ instanceId: `scr_${i}_${c.id.slice(0, 6)}`, templateId: c.id, tier: c.startingTier, where: 'board', socket: null, fromScreen: true });
  });
  if (!screenBoard.length) board.push(...pool.filter((o) => o.where === 'board').map((o) => pool.splice(pool.indexOf(o), 1)[0]));
  // The stash as it was last seen open; later purchases the log put in the stash are added to it.
  let stash = pool.map((o) => ({ ...o, where: 'stash' }));
  if (screenStash) {
    const seen = [];
    screenStash.forEach((d, i) => {
      const c = pickCard(d.cardIds ?? [], cards, hero);
      if (!c || c.type !== 'Item') return;
      const j = pool.findIndex((o) => o.templateId === c.id);
      seen.push(j >= 0 ? { ...pool.splice(j, 1)[0], where: 'stash' } : { instanceId: `stash_${i}_${c.id.slice(0, 6)}`, templateId: c.id, tier: c.startingTier, where: 'stash', socket: null, fromScreen: true });
    });
    stash = [...seen, ...pool.filter((o) => o.where === 'stash').map((o) => ({ ...o }))];
  }
  return { owned: [...board, ...stash], screenOrder: screenBoard.length ? board.map((o) => o.instanceId) : null };
}

const SLOTS = { Small: 1, Medium: 2, Large: 3 };

/** What to move between stash and board: fill free slots first, then swap in anything stronger per slot. */
function stashMoves(owned, data) {
  const board = owned.filter((o) => o.where === 'board');
  const stash = owned.filter((o) => o.where === 'stash');
  if (!stash.length) return [];
  const slotsOf = (o) => SLOTS[data.cards[o.templateId]?.size] ?? 1;
  let free = 10 - board.reduce((n, o) => n + slotsOf(o), 0);
  const inScore = rankOffers(stash.map((o) => ({ templateId: o.templateId, tier: o.tier })), board, data, { free: true });
  const outScore = rankSell(board, data); // weakest first, per slot
  const used = new Set();
  const moves = [];
  for (const cand of inScore) {
    if (cand.modelled === false || !(cand.perSlot > 0)) continue;
    const need = SLOTS[cand.size] ?? 1;
    if (need <= free) { free -= need; moves.push({ in: cand.name, inArt: cand.templateId, out: null, gain: cand.value, reason: `boş yuva var · ${cand.reason}` }); continue; }
    const out = outScore.find((o) => !used.has(o.instanceId) && (SLOTS[o.size] ?? 1) + free >= need && o.perSlot < cand.perSlot);
    if (out) { used.add(out.instanceId); moves.push({ in: cand.name, inArt: cand.templateId, out: out.name, outArt: out.templateId, gain: Math.round((cand.perSlot - out.perSlot) * need * 10) / 10, reason: `yuva başına ${cand.perSlot} > ${out.perSlot} · ${cand.reason}` }); }
  }
  return moves.slice(0, 3);
}

/**
 * Keep or sell each stash item. Keep when it is close to making the board (at least 70% of the weakest board
 * item's points per slot) or when it shares item-type tags with two or more other stash items (the start of
 * a second build to switch to). Otherwise sell it for its gold. Thresholds are assumptions.
 */
function stashDecisions(owned, data, skip) {
  const board = owned.filter((o) => o.where === 'board');
  const stash = owned.filter((o) => o.where === 'stash' && !skip.has(o.instanceId) && !data.cards[o.templateId]?.onSell);
  if (!stash.length) return [];
  const scores = new Map(rankOffers(stash.map((o) => ({ templateId: o.templateId, tier: o.tier })), board, data, { free: true }).map((r) => [r.templateId, r]));
  const weakest = rankSell(board, data)[0]?.perSlot ?? 0;
  return stash.map((o) => {
    const c = data.cards[o.templateId];
    const r = scores.get(o.templateId);
    const mates = stash.filter((x) => x !== o && (data.cards[x.templateId]?.tags ?? []).some((t) => c.tags.includes(t)));
    const shared = [...new Set(mates.flatMap((x) => data.cards[x.templateId].tags.filter((t) => c.tags.includes(t))))];
    const price = data.gameMode.sellPrices?.[c.size]?.[o.tier] ?? null;
    const close = r && weakest > 0 && r.perSlot >= 0.7 * weakest;
    const pivot = mates.length >= 2;
    return {
      instanceId: o.instanceId, templateId: o.templateId, name: c.name, tier: o.tier, price,
      // Selling is only pressed when the stash is nearly full; several creators advise holding otherwise.
      verdict: close || pivot || stash.length < 9 ? 'tut' : 'sat',
      reason: pivot ? `depoda ${mates.length} eşyayla ortak: ${shared.join(', ')} · ikinci build çekirdeği olabilir`
        : close ? `yuva başına ${r.perSlot}, tahtanın en zayıfı ${weakest} · tahtaya girmeye yakın`
        : `yuva başına ${r?.perSlot ?? 0}, tahtanın en zayıfı ${weakest} · depoda eşi yok${price != null ? ` · satınca ${price} altın` : ''}`,
    };
  }).sort((a, b) => (a.verdict === 'sat' ? 0 : 1) - (b.verdict === 'sat' ? 0 : 1)).slice(0, 5);
}

/**
 * The decision policy: everything the advice says to do on this screen, as one ordered list of concrete steps.
 * It only orders what the other parts computed (engine gains, choice ratings, placement); it adds no judgement of
 * its own. Buying comes first while gold lasts, then sales that pay off, then stash swaps, then placement, then
 * the way out. Each step names the thing, the place and the expected gain.
 */
function actionPlan(run, a, gold, freeShop) {
  const steps = [];
  const phase = run.phase;
  const nth = (k) => (k ? `soldan ${k}. ` : '');
  // Every step carries "say": the full instruction in plain words, so nothing has to be worked out from numbers.
  const add = (step) => steps.push(step);
  if (/EndRun/.test(phase ?? '')) return [{ do: 'bekle', what: 'Tur bitti', say: 'Tur bitti. Yeni tur başlattığında plan yenilenir.', why: '' }];
  if (/Combat|Replay/.test(phase ?? '')) return [{ do: 'bekle', what: 'Savaş sürüyor', say: run.current?.pvp ? 'Oyuncu savaşı sürüyor. Rakibin tahtası bilinmediği için bu savaşa tahmin vermiyorum.' : 'Savaş sürüyor, yapılacak bir hamle yok. Bitince sıradaki adımlar burada görünür.', why: '' }];
  if (phase === 'ChoiceState' || phase === 'LevelUpState') {
    const pick = a.options.find((o) => o.verdict === 'seç');
    const sk = a.skillOffers[0];
    if (phase === 'LevelUpState' && sk && (sk.gain ?? 0) > 0 && (!pick || (sk.gain ?? 0) >= (pick.score ?? 0))) add({ do: 'seç', what: sk.name, gain: sk.gain, say: `Seviye ödülü olarak "${sk.name}" yeteneğini seç.`, why: sk.reason });
    else if (pick) add({ do: 'git', what: pick.name, say: `Önündeki seçeneklerden ${nth(a.options.indexOf(pick) + 1)}olanı seç: "${pick.name}" (${pick.kind}).`, why: pick.reason });
    else if (a.options.length) add({ do: 'karar ver', what: a.options.map((o) => o.name).join(' / '), say: `Bu seçenekler sayıyla karşılaştırılamadı: ${a.options.map((o, i) => `${i + 1}. ${o.name}`).join(', ')}. Farenle her birinin üstüne gel; oyun metni okununca daha net söylerim.`, why: a.options.map((o) => `${o.name}: ${o.reason}`).join(' · ') });
    else add({ do: 'göster', what: 'Seçenekler tanınmadı', say: 'Önündeki seçenekleri henüz tanıyamadım. Farenle her birinin üstüne gel, bilgi kutusundan okuyacağım.', why: '' });
  }
  if (phase === 'EncounterState' || phase === 'LevelUpState') {
    const choice = a.choices.find((c) => c.verdict === 'seç');
    if (choice) add({ do: 'seç', what: choice.name, gain: choice.value, say: `"${choice.name}" seçeneğini seç.`, why: choice.reason });
    // Purchases come from the joint plan: each is valued on the board as it will be after the ones before it.
    for (const b of a.buys ?? []) add({ do: 'al', what: b.name, gain: b.gain, hint: [freeShop ? 'bedava' : `${b.price} altın`, b.out ? `${b.out} yerine` : b.where || null].filter(Boolean).join(' · '),
      say: `Dükkânda ${nth(b.pos)}duran "${b.name}" eşyasını al${freeShop ? ' (bedava)' : ` (${b.price} altın)`}. ${b.out ? `Tahtada yer yok: önce "${b.out}" eşyasını depoya çek. ` : ''}${b.where ? `Sonra "${b.name}" eşyasını ${b.where} yerleştir.` : 'Tahtaya yerleştir.'}`,
      why: `tahtana katkısı +${b.gain} puan/sn${b.parts ? `: ${b.parts}` : ''}` });
    if ((a.buys ?? []).length && a.finalOrder) add({ do: 'diz', what: 'Alımlardan sonra diz', hint: a.finalOrder.join(' → '), say: `Alımlar bitince tahtayı soldan sağa şu sıraya getir: ${a.finalOrder.map((n, i) => `${i + 1}. ${n}`).join(', ')}.${a.goldLeft != null ? ` Elinde ${a.goldLeft} altın kalır.` : ''}`, why: 'motor, alınan eşyalarla birlikte en yüksek tahta gücünü bu sırada buluyor' });
    const planned = new Set((a.buys ?? []).map((b) => b.name));
    for (const o of a.offers) if (o.verdict === 'al' && !planned.has(o.name)) {
      if (freeShop) add({ do: 'al', what: o.name, say: `"${o.name}" eşyasını da al, bedava. Tahtana bir şey katmıyor: sat ya da depoda tut.`, why: o.reason });
      else add({ do: 'atla', what: o.name, say: `"${o.name}" eşyasını alma: öncekileri aldıktan sonra altın yetmiyor ya da katkısı kalmıyor.`, why: o.reason });
    }
    for (const o of a.offers) if (o.verdict === 'geç' && a.offers.length <= 4) add({ do: 'atla', what: o.name, say: freeShop ? `"${o.name}" eşyasını seçme: tek seçim hakkın var ve diğeri daha iyi.` : `"${o.name}" eşyasını alma: bu tahtaya bir şey katmıyor.`, why: o.reason });
    if (a.reroll?.verdict === 'çek' && !(a.buys ?? []).length) add({ do: 'yenile', what: 'Dükkânı yenile', say: 'Dükkânı yenile: bu tekliflerden daha iyisinin gelmesi bekleniyor.', why: a.reroll.reason });
    const sk = a.skillOffers[0];
    if (phase === 'EncounterState' && sk && (sk.gain ?? 0) > 0) add({ do: 'seç', what: sk.name, gain: sk.gain, say: `"${sk.name}" yeteneğini al.`, why: sk.reason });
  }
  for (const p of a.sellPlays) {
    const at = p.where === 'stash' ? 'depodaki' : 'tahtadaki';
    if (p.verdict === 'hazırla') add({ do: 'hazırla', what: p.name, say: `${at} "${p.name}" eşyasını satmadan önce hazırlık yap: ${p.reason.split(' · ')[0]}. Sonra sat.`, why: p.reason });
    else if (p.verdict === 'sat' && p.gain > 0) add({ do: 'sat', what: p.name, gain: p.gain, say: `${at[0].toUpperCase()}${at.slice(1)} "${p.name}" eşyasını sat: satınca ${p.reason.split(' · ')[0]}.`, why: p.reason });
  }
  for (const m of a.moves) add({ do: m.out ? 'değiştir' : 'koy', what: m.out ? `${m.in} girsin, ${m.out} çıksın` : `${m.in} tahtaya`, gain: m.gain, hint: m.where || 'depodan',
    say: m.out ? `Tahtadaki "${m.out}" eşyasını depoya çek, depodaki "${m.in}" eşyasını ${m.where || 'onun yerine'} yerleştir.` : `Depodaki "${m.in}" eşyasını tahtaya al ve ${m.where || 'boş yere'} yerleştir.`,
    why: `tahta gücü +${m.gain} puan/sn` });
  if (a.layout.changed && !((a.buys ?? []).length && a.finalOrder)) {
    const moved = new Set(a.layout.moved ?? []);
    add({ do: 'diz', what: 'Tahtayı yeniden diz', gain: a.layout.gain, hint: a.layout.order.map((o) => o.name).join(' → '),
      say: `Tahtayı soldan sağa şu sıraya getir: ${a.layout.order.map((o, i) => `${i + 1}. ${o.name}`).join(', ')}. Yeri değişenler: ${a.layout.order.filter((o) => moved.has(o.instanceId)).map((o) => o.name).join(', ') || 'yok'}.`,
      why: `tahta gücü ${a.layout.currentScore} → ${a.layout.score} puan/sn` });
  }
  for (const s of a.stash) if (s.verdict === 'sat') add({ do: 'sat', what: s.name, say: `Depodaki "${s.name}" eşyasını sat${s.price != null ? ` (+${s.price} altın)` : ''}: depo dolmak üzere ve bu eşya tahtana girmiyor.`, why: s.reason });
  if (phase === 'EncounterState') add({ do: 'çık', what: 'Karşılaşmadan çık', say: steps.length ? 'Yukarıdakiler bitince karşılaşmadan çık.' : 'Burada tahtanı güçlendiren bir hamle yok. Karşılaşmadan çık.', why: '' });
  return steps.slice(0, 9);
}

/**
 * Strategy opinions from YouTube creators (docs/youtube-research-2026-11-23.md), shown as opinions, never as
 * computed advice. Only general principles that several creators repeat are used; item-specific tips from the
 * videos are not, because the items have changed since (the game data is the source for those).
 */
function opinions(run, board, stash, eng, shop, data) {
  const out = [];
  const slots = board.reduce((n, o) => n + (SLOTS[data.cards[o.templateId]?.size] ?? 1), 0);
  if (run.day <= 5 && slots <= 8) out.push({ text: 'İlk 5 günü kazanmaya oyna: tahtayı dolgu eşyayla da olsa doldur, bugünü güçlendiren eşyayı sinerjisi yok diye geçme.', source: 'CurrentlyKevin, Riveh' });
  if (run.day >= 6 && eng.firstUse != null && eng.firstUse >= 5) out.push({ text: `Tahtanın ilk eşyası ${eng.firstUse} saniyede çalışıyor; 6. günden sonra 5-6 saniye geç sayılıyor. Hız (haste, şarj, kısa bekleme süresi) ara.`, source: 'CurrentlyKevin' });
  if (shop && run.day <= 6) { const g = data.gameMode?.tierByDay?.[String(run.day)]?.Gold ?? 0; out.push({ text: `Altın seviye eşya aramak için erken: bugün dükkânda altın seviye payı %${Math.round(g * 100)} (oyun verisi), 8. günde %40. O güne kadar bugünkü tahtayı güçlendir.`, source: 'Game Plan HQ' }); }
  if (stash.length && stash.length < 9) out.push({ text: 'Depoyu dolu tutmak esneklik sağlar: yer ya da altın gerekmedikçe satmak için acele etme.', source: 'Riveh' });
  return out.slice(0, 2);
}

/** Items worth watching for: the hero's items that the model values most next to this board because of links to it. */
function lookout(owned, data, hero) {
  const board = owned.filter((o) => o.where === 'board');
  if (board.length < 2 || !hero) return [];
  const key = hero + '|' + board.map((o) => o.templateId + o.tier).sort().join(',');
  if (data._lookout?.key === key) return data._lookout.list;
  const have = new Set(owned.map((o) => o.templateId));
  const pool = Object.values(data.cards).filter((c) => c.type === 'Item' && c.heroes.includes(hero) && !have.has(c.id) && !/^\[|DEBUG|TEMPLATE/i.test(c.internalName));
  const list = rankOffers(pool.map((c) => ({ templateId: c.id })), board, data, { free: true })
    .filter((r) => /sinerji/.test(r.reason) && r.perSlot > 0).slice(0, 5)
    .map((r) => ({ templateId: r.templateId, name: r.name, tier: r.tier, size: r.size, perSlot: r.perSlot, reason: r.reason }));
  data._lookout = { key, list };
  return list;
}

export function buildView(run, screen, data, opts = {}) {
  const { cards } = data;
  const tracked = Object.entries(run.items).map(([instanceId, it]) => ({ instanceId, ...it }));
  const { owned, screenOrder } = reconcile(tracked, opts.screenBoard, cards, run.hero, opts.screenStash);
  // What a hover tooltip told us about an item (tier from its sell price, enchantment from its name).
  const TIERS = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary'];
  for (const o of owned) {
    const f = opts.facts?.[o.templateId];
    if (f?.tier && cards[o.templateId]?.tiers?.[f.tier] && (o.fromScreen || TIERS.indexOf(f.tier) > TIERS.indexOf(o.tier))) o.tier = f.tier;
    if (f?.enchant && !o.enchant) o.enchant = f.enchant;
    if (f?.value != null) o.attrs = { ...(o.attrs ?? {}), SellPrice: f.value };
  }
  const hov = opts.hovered ?? [];
  const ownedTemplates = new Set(owned.map((o) => o.templateId));
  const stashTemplates = new Set(owned.filter((o) => o.where === 'stash').map((o) => o.templateId));
  const boardX = new Map(); // templateId -> x position on screen, for board items seen in the lower row
  const cur = run.current ? cards[run.current.templateId] : null;
  const shop = cur?.shop ?? null;

  const itemOffers = [];
  const skillOffers = [];
  const seenOwned = new Set();
  const pathOptions = [];
  const monsterSeen = []; // monster portraits recognised on the choice screen
  const fresh = screen && screen.detections && opts.now - screen.ts * 1000 < 6000;
  // During a fight the upper row is the opponent's board, not a shop.
  const inFight = /Combat|Replay/.test(run.phase ?? '');
  if (fresh) {
    for (const d of screen.detections) {
      // Path-choice screen: three portraits in a row below the current encounter's own portrait.
      if ((run.phase === 'ChoiceState' || run.phase === 'LevelUpState') && (d.kind === 'encounters' || d.kind === 'monsters') && d.cy > 0.24 && d.cy < 0.5) { pathOptions.push(d); continue; }
      let c = pickCard(d.cardIds ?? [], cards, run.hero);
      if (!c) continue;
      // One portrait serves the same monster at several levels: take the level closest to the day.
      if (c.type === 'CombatEncounter') c = (d.cardIds ?? []).map((id) => cards[id]).filter((x) => x?.combat).sort((a, b) => Math.abs((a.combat.level ?? 0) - run.day) - Math.abs((b.combat.level ?? 0) - run.day))[0] ?? c;
      if (c.type === 'Item') {
        if (ownedTemplates.has(c.id) && d.cy >= OFFER_SPLIT) { seenOwned.add(c.id); boardX.set(c.id, d.cx); }
        else if (d.cy < OFFER_SPLIT && stashTemplates.has(c.id)) seenOwned.add(c.id); // the open stash covers the upper row
        else if (d.cy < OFFER_SPLIT && !inFight) itemOffers.push({ templateId: c.id, cx: d.cx, tier: likelyTier(data, run.day, c) });
      } else if (c.type === 'CombatEncounter' && !(d.cy > 0.24 && d.cy < 0.46 && run.phase === 'ChoiceState')) {
        if (!inFight && !monsterSeen.some((m) => m.card.id === c.id)) monsterSeen.push({ card: c, cx: d.cx, variants: (d.cardIds ?? []).length });
      } else if (c.type === 'Skill' && !run.skills.includes(c.id) && !/_MON_/.test(d.art ?? '') && !inFight) { // monster skill icons are not offers
        skillOffers.push(c.id);
      }
    }
  }
  itemOffers.sort((a, b) => a.cx - b.cx);

  const gold = opts.gold ?? opts.screenGold ?? (fresh ? screen.gold ?? null : null);
  const income = opts.income ?? (fresh ? screen.income ?? null : null);
  const summary = boardSummary(owned, cards);
  const offers = rankOffers(itemOffers, owned, data, { gold, free: (shop?.free ?? false) || run.phase === 'LevelUpState' }); // level-up rewards cost nothing
  const reroll = itemOffers.length ? rerollAdvice(itemOffers, owned, data, { hero: run.hero, shop, gold }) : null;

  const art = (id) => (data.art?.[id] ? `/art/${data.art[id]}.png` : null);
  // The board engine: every offer, swap and placement is valued by running the whole board with it.
  const boardNow = owned.filter((o) => o.where === 'board');
  const stashNow = owned.filter((o) => o.where === 'stash');
  const skillsNow = (opts.skills ?? []).filter((id) => cards[id]);
  const skillOfferIds = [...new Set(skillOffers)].filter((id) => !skillsNow.includes(id));
  // Board slots open with the hero's level: 4 at level 1, two more per level, ten from level 4 (the game mode's
  // NumCarpetSocketsUnlockPerLevel is 2; the four at level 1 were measured on a day-1 frame). The level is read from
  // the portrait badge; until it is read, the day is used as a floor for it, and the board never counts as smaller
  // than what is already on it.
  const usedSlots = boardNow.reduce((n, o) => n + (SLOTS[cards[o.templateId]?.size] ?? 1), 0);
  const level = opts.level ?? Math.max(1, run.day ?? 1);
  const capacity = Math.max(usedSlots, Math.min(10, 4 + 2 * (level - 1)));
  const freeShopEarly = (shop?.free ?? false) || run.phase === 'LevelUpState';
  // Some free encounters let you take only one of what is shown.
  const onePick = freeShopEarly && (shop?.multiple === false || run.phase === 'LevelUpState'); // a level-up reward is one pick
  const eng = engineAdvice(boardNow, stashNow, skillsNow, itemOffers, run, data, skillOfferIds, { capacity, gold, free: freeShopEarly, maxBuys: onePick ? 1 : 4 });
  const fightOf = (card) => engineFight(card, boardNow, skillsNow, opts.health ?? null, data);
  const freeShop = (shop?.free ?? false) || run.phase === 'LevelUpState';
  const shelf = itemOffers.slice().sort((x, y) => x.cx - y.cx).map((x) => x.templateId);
  for (const o of offers) {
    o.pos = shelf.indexOf(o.templateId) + 1 || null; // place on the shelf, counted from the left
    const e = eng.offers.find((x) => x.templateId === o.templateId);
    if (!e || e.gain == null) continue;
    const slots = SLOTS[o.size] ?? 1;
    const canPay = freeShop || gold == null || o.price == null || o.price <= gold;
    o.value = e.gain; o.perSlot = Math.round((e.gain / slots) * 10) / 10;
    o.verdict = !canPay ? 'para yetmiyor' : e.gain > 0.3 ? 'al' : 'geç';
    o.reason = [`tahtana katkısı ${e.gain > 0 ? '+' : ''}${e.gain} puan/sn${e.parts ? ` (${e.parts})` : ''}`, e.out ? `yer yok: ${e.out} çıkar, ${e.where} koy` : e.where ? `${e.where} koy` : null, o.price != null && !freeShop ? `${o.price} altın` : null].filter(Boolean).join(' · ');
  }
  // Free things are never "skip": taking costs nothing, and what does not help the board can be sold or held.
  if (freeShop && offers.length) {
    const sellOf = (o) => data.gameMode.sellPrices?.[o.size]?.[o.tier] ?? 0;
    if (onePick) {
      const best = offers.slice().sort((x, y) => (y.value ?? 0) - (x.value ?? 0) || sellOf(y) - sellOf(x))[0];
      for (const o of offers) {
        if (o === best) { o.verdict = 'al'; if (!((o.value ?? 0) > 0.3)) o.reason = `bedava, tek seçim hakkı: tahtana katmıyor ama en değerlisi bu (satınca ${sellOf(o)} altın) · ${o.reason}`; }
        else { o.verdict = 'geç'; o.reason = `tek seçim hakkı var, "${best.name}" daha iyi · ${o.reason}`; }
      }
    } else for (const o of offers) if (o.verdict !== 'al') { o.verdict = 'al'; o.freeExtra = true; o.reason = `bedava: tahtana katmıyor, yine de al; sat (+${sellOf(o)} altın) ya da depoda tut · ${o.reason}`; }
  }
  for (const o of offers) {
    o.art = art(o.templateId);
    // Items whose point is being sold: value them by what the sale would do for this board.
    const se = sellEffect(cards[o.templateId], o.tier ?? cards[o.templateId]?.startingTier, owned.filter((x) => x.where === 'board'), data);
    if (se?.scored && se.gain > (o.value ?? 0)) {
      o.value = se.gain; o.perSlot = se.gain;
      o.reason = `satınca: ${se.text}${o.price != null ? ` · ${o.price} altın` : ''}`;
      if (o.verdict === 'sen karar ver' || o.verdict === 'geç') o.verdict = se.gain > 0 && (gold == null || o.price == null || o.price <= gold) ? 'al' : o.verdict;
    }
  }
  offers.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const boardItems = boardNow;
  const currentIds = screenOrder && screenOrder.length > 1 ? screenOrder : null; // left to right, as seen on screen
  const byId = new Map(boardItems.map((o) => [o.instanceId, o]));
  const ordered = eng.order.map((id) => byId.get(id)).filter(Boolean);
  const links = describeLinks(ordered, data);
  const layout = {
    order: ordered.map((o) => ({ instanceId: o.instanceId, templateId: o.templateId, tier: o.tier, name: cards[o.templateId]?.name ?? '?', size: cards[o.templateId]?.size ?? 'Small', art: art(o.templateId) })),
    changed: boardItems.length > 1 ? eng.orderChanged && eng.orderGain > 0 : null, known: Boolean(currentIds),
    currentScore: eng.value, score: Math.round((eng.value + eng.orderGain) * 10) / 10, gain: eng.orderGain,
    positional: links.length || eng.orderChanged ? 1 : 0, links,
  };
  layout.moved = layout.changed ? layout.order.filter((n, i) => n.instanceId !== boardItems[i]?.instanceId).map((n) => n.instanceId) : [];
  layout.fromScreen = Boolean(screenOrder);

  // Event choices: the ones the data lists for this event, or the ones the player has hovered (named by the game).
  let choiceRows = cur ? rateChoices(cur, run, owned, data, { gold }) : [];
  const hoveredSteps = hov.filter((h) => h.type === 'EncounterStep');
  if (hoveredSteps.length) {
    const fromHover = rateChoices({ choices: hoveredSteps.map((h) => h.ids[0]) }, run, owned, data, { gold });
    const have = new Set(choiceRows.map((c) => c.name));
    choiceRows = [...choiceRows.map((c) => fromHover.find((f) => f.name === c.name) ?? c), ...fromHover.filter((f) => !have.has(f.name))];
    for (const c of choiceRows) { const h = hoveredSteps.find((x) => x.name === c.name); if (h?.text) c.reason = `${c.reason} · oyunda: ${h.text.slice(0, 110)}`; if (c.verdict === 'seç') c.verdict = ''; }
    const best = choiceRows.filter((c) => c.verdict === '' && c.value > 0).sort((a, b) => b.value - a.value)[0];
    if (best) best.verdict = 'seç';
    choiceRows.sort((a, b) => (b.value ?? -1e9) - (a.value ?? -1e9));
  }

  const view = {
    model: { horizon: HORIZON, weights: WEIGHTS, synergy: SYNERGY_BONUS },
    run: {
      active: run.active,
      hero: run.hero,
      day: run.day,
      hour: run.hour,
      phase: run.phase,
      encounter: cur && !run.current?.pvp ? { name: cur.name, type: cur.type, shop } : run.current?.pvp ? { name: 'Oyuncu savaşı', type: 'PvP', shop: null } : null,
      pvp: Boolean(run.current?.pvp),
      fights: run.fights,
      lastEvent: run.lastEvent,
    },
    money: {
      gold,
      income,
      goldSource: opts.gold != null ? 'elle' : gold != null ? 'ekran' : null,
      fromSales: run.goldFromSales,
      spentEst: run.goldSpentEst,
    },
    board: {
      slots: summary.slots,
      free: summary.free,
      totals: {
        damage: round(summary.total.damage),
        burn: round(summary.total.burn),
        poison: round(summary.total.poison),
        shield: round(summary.total.shield),
        heal: round(summary.total.heal),
      },
      tags: Object.entries(summary.tagCount).sort((a, b) => b[1] - a[1]).slice(0, 8),
      items: owned.map((o) => ({
        instanceId: o.instanceId,
        name: cards[o.templateId]?.name ?? `? ${o.templateId.slice(0, 8)}`,
        tier: o.tier,
        size: cards[o.templateId]?.size ?? null,
        where: o.where,
        seen: seenOwned.has(o.templateId),
      })),
    },
    skills: skillsNow.map((id) => cards[id]?.name ?? id),
    skillGain: eng.skillGain,
    power: eng.power,
    health: opts.health ?? null,
    advice: {
      layout,
      stash: stashDecisions(owned, data, new Set()).map((d) => ({ ...d, art: art(d.templateId) })),
      sellPlays: sellPlays(owned, data).map((p) => ({ ...p, art: art(p.templateId) })),
      options: rateOptions(pathOptions.sort((a, b) => a.cx - b.cx).map((d) => d.cardIds ?? []), run, owned, data, { gold, health: opts.health ?? null, fightOf }).map((o) => { const h = hov.find((x) => x.name === o.name); return { ...o, reason: h?.text ? `${o.reason} · oyunda: ${h.text.slice(0, 110)}` : o.reason, confirmed: Boolean(h) }; }),
      moves: eng.stash.filter((x) => x.gain > 0.3).sort((a, b) => b.gain - a.gain).slice(0, 3).map((x) => ({ in: cards[x.templateId]?.name, inArt: art(x.templateId), out: x.out, gain: x.gain, where: x.where, reason: [x.parts, x.where ? `${x.where} koy` : null].filter(Boolean).join(' · ') })),
      engine: { value: eng.value, parts: eng.parts, per: eng.per, keep: eng.keep, coverage: eng.coverage, unhandled: eng.unhandled, firstUse: eng.firstUse },
      opinions: opinions(run, boardNow, stashNow, eng, shop, data),
      lookout: lookout(owned, data, run.hero).map((l) => ({ ...l, art: art(l.templateId), onOffer: itemOffers.some((o) => o.templateId === l.templateId) })),
      choices: choiceRows,
      monsters: (monsterSeen.length ? monsterSeen.sort((a, b) => a.cx - b.cx) : cur?.type === 'CombatEncounter' && inFight && !run.current?.pvp ? [{ card: cur, variants: 1 }] : [])
        .map((m) => { const dm = describeMonster(m.card, owned, data, opts.health ?? null, fightOf); if (dm?.fight) dm.uncertain = dm.fight.coverage < 60; return { ...dm, variants: m.variants }; }).filter((m) => m.name),
      offers,
      reroll,
      skillOffers: rankSkills(skillOfferIds, owned, data).map((k) => {
        const e = eng.skillOffers.find((x) => x.templateId === k.templateId);
        const text = (cards[k.templateId]?.tooltips ?? []).map((t) => t.text).join(' ');
        return { ...k, art: art(k.templateId), gain: e?.gain ?? null, reason: e?.gain != null ? `tahtana katkısı ${e.gain > 0 ? '+' : ''}${e.gain} puan/sn${e.handled ? '' : ' (bir etkisi hesaplanamadı)'} · ${text}` : k.reason };
      }).sort((a, b) => (b.gain ?? -1e9) - (a.gain ?? -1e9)),
      sell: rankSell(owned, data).slice(0, 4),
      upgrades: rankUpgrades(owned, data).slice(0, 4),
      enchant: cur?.enchant ? { enchant: cur.enchant, targets: rankEnchant(cur.enchant, owned, data).slice(0, 4) } : null,
      lastEncounters: describeEncounters(run.encounters.slice(-3).map((e) => e.templateId), data),
    },
  };
  view.advice.buys = eng.buys.plan.map((b) => ({ ...b, name: cards[b.templateId]?.name, pos: shelf.indexOf(b.templateId) + 1 || null }));
  view.advice.finalOrder = eng.buys.finalOrder; view.advice.goldLeft = eng.buys.goldLeft;
  view.board.capacity = capacity; view.board.level = opts.level ?? null;
  view.plan = actionPlan(run, view.advice, gold, freeShop);
  return view;
}
