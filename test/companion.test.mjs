import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseLine, parseLog } from '../src/logparser.mjs';
import { HORIZON, boardSummary, directValue, itemStats, rankEnchant, rankOffers, rankSell, rankUpgrades, rerollAdvice, wants } from '../src/model.mjs';
import { createTracker } from '../src/runstate.mjs';
import { buildView } from '../src/view.mjs';

const data = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url)));
const fixture = readFileSync(new URL('./fixtures/run-constructed.log', import.meta.url), 'utf8');
const byName = (name, type = 'Item') => Object.values(data.cards).find((c) => c.type === type && c.name === name);

// ---------- log parser ----------
test('parses the purchase line exactly as the game formats it (no space after TemplateId/Section)', () => {
  const e = parseLine('Card Purchased: InstanceId: itm_Ab3 - TemplateId00e3a7ff-af5e-47ce-a2c0-2d4ec31ac7d7 - Target:PlayerSocket_2 - SectionHand');
  assert.deepEqual(e, { type: 'purchase', instanceId: 'itm_Ab3', templateId: '00e3a7ff-af5e-47ce-a2c0-2d4ec31ac7d7', target: 'PlayerSocket_2', section: 'Hand', t: null });
});

test('parses sale, upgrade, skill, state and combat lines behind any prefix', () => {
  assert.deepEqual(parseLine('[12:00:01] [Info] Sold Card itm_x for 4 gold.'), { type: 'sold', instanceId: 'itm_x', gold: 4, t: '12:00:01' });
  assert.equal(parseLine('Upgraded Card itm_x Tier from: Silver to: Gold').to, 'Gold');
  assert.deepEqual(parseLine('Selected skill abc to socket 1'), { type: 'skillSelected', skill: 'abc', socket: '1', t: null });
  assert.deepEqual(parseLine('xx State changed from [ChoiceState] to [EncounterState]'), { type: 'state', from: 'ChoiceState', to: 'EncounterState', t: null });
  assert.equal(parseLine('Combat simulation completed: durationMs=6870').durationMs, 6870);
  assert.equal(parseLine('Combat simulation completed in 6.87s').durationMs, 6870); // older builds
  assert.equal(parseLine('Received: type=NetMessageGameSim, id=7').message, 'NetMessageGameSim');
});

test('ignores engine noise', () => {
  assert.equal(parseLine("Mono path[0] = '/x/Managed'"), null);
  assert.equal(parseLine('[SFXPlayer] Event not found for GUID: 0.'), null);
  assert.equal(parseLine(''), null);
});

test('fixture log yields the expected event sequence', () => {
  const ev = parseLog(fixture);
  const count = (t) => ev.filter((e) => e.type === t).length;
  assert.equal(count('purchase'), 6);
  assert.equal(count('sold'), 1);
  assert.equal(count('upgraded'), 1);
  assert.equal(count('skillSelected'), 1);
  assert.equal(count('state'), 12);
  assert.equal(count('combatDone'), 2);
});

// ---------- run state ----------
function runFixture() {
  const tr = createTracker(data);
  for (const e of parseLog(fixture)) tr.apply(e);
  return tr.run;
}

test('rebuilds hero, items, tiers, skills, day and sales from the fixture', () => {
  const run = runFixture();
  assert.equal(run.hero, 'Vanessa');
  const names = Object.values(run.items).map((i) => `${data.cards[i.templateId].name}:${i.tier}:${i.where}`).sort();
  assert.deepEqual(names, ['Anchor:' + byName('Anchor').startingTier + ':stash', 'Narwhal:Silver:board']);
  assert.equal(run.skills.length, 1);
  assert.equal(run.goldFromSales, 1);
  assert.equal(run.day, 2, 'day advances after leaving the PvP fight');
  assert.equal(run.hour, 0);
  assert.deepEqual(run.fights, { pve: 1, pvp: 1 });
  assert.equal(run.phase, 'ChoiceState');
});

test('paid shop purchases add to the spend estimate, free picks do not', () => {
  const run = runFixture();
  const price = (n) => data.gameMode.buyPrices[byName(n).size][byName(n).startingTier];
  assert.equal(run.goldSpentEst, price('Grapeshot') + price('Anchor')); // Narwhal came from the free start encounter
});

test('a second run start resets the tracker', () => {
  const tr = createTracker(data);
  for (const e of parseLog(fixture)) tr.apply(e);
  tr.apply({ type: 'runStart' });
  assert.equal(Object.keys(tr.run.items).length, 0);
  assert.equal(tr.run.day, 1);
});

// ---------- model ----------
test('per-second damage is DamageAmount × Multicast ÷ cooldown from the game data', () => {
  const n = byName('Narwhal');
  const a = n.tiers.Bronze.attrs;
  const s = itemStats(n, 'Bronze');
  assert.ok(Math.abs(s.damage - (a.DamageAmount * a.Multicast) / (a.CooldownMax / 1000)) < 1e-9);
  assert.ok(itemStats(n, 'Silver').damage > s.damage);
});

test('burn follows the game rule (two ticks a second, 3% decay) and poison is n × horizon/2', () => {
  const burner = Object.values(data.cards).find((c) => c.type === 'Item' && c.tiers[c.startingTier]?.attrs.BurnApplyAmount && c.abilities.some((x) => x.action === 'TActionPlayerBurnApply' && x.trigger === 'TTriggerOnCardFired') && c.tiers[c.startingTier].attrs.CooldownMax && !c.tiers[c.startingTier].attrs.AmmoMax);
  const a = burner.tiers[burner.startingTier].attrs;
  const s = itemStats(burner, burner.startingTier);
  const uses = Math.max(1, a.Multicast ?? 1) / (a.CooldownMax / 1000);
  assert.ok(Math.abs(s.burnDamage - a.BurnApplyAmount * ((1 - 0.97 ** HORIZON) / 0.03) * uses) < 1e-9);
  const p = itemStats({ tiers: { Bronze: { attrs: { CooldownMax: 5000, PoisonApplyAmount: 2 } } }, abilities: [{ trigger: 'TTriggerOnCardFired', action: 'TActionPlayerPoisonApply' }] }, 'Bronze');
  assert.equal(p.poisonDamage, (2 / 5) * (HORIZON / 2));
});

test('items without a cooldown are reported as passive, not given an invented number', () => {
  const passive = Object.values(data.cards).find((c) => c.type === 'Item' && !c.tiers[c.startingTier]?.attrs.CooldownMax);
  const s = itemStats(passive, passive.startingTier);
  assert.equal(s.passive, true);
  assert.equal(directValue(s), 0);
});

const owned = (names) => names.map((n, i) => ({ instanceId: `itm_${i}`, templateId: byName(n).id, tier: byName(n).startingTier, where: 'board' }));

test('offers are ranked by value per slot and carry a reason with the numbers', () => {
  const offers = ['Narwhal', 'Anchor', 'Grapeshot'].map((n) => ({ templateId: byName(n).id }));
  const r = rankOffers(offers, owned(['Narwhal']), data);
  assert.equal(r.length, 3);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].perSlot >= r[i].perSlot);
  assert.match(r.find((x) => x.name === 'Narwhal').reason, /hasar\/sn/);
  assert.ok(r.every((x) => typeof x.price === 'number'));
});

test('a card that refers to a tag scores higher when the board has that tag', () => {
  const ref = Object.values(data.cards).find((c) => c.type === 'Item' && wants(c).includes('Weapon') && !c.tags.includes('Weapon') && c.heroes.includes('Vanessa'));
  assert.ok(ref, 'need a Vanessa item that references Weapons');
  const withWeapons = rankOffers([{ templateId: ref.id }], owned(['Narwhal', 'Grapeshot']), data)[0];
  const without = rankOffers([{ templateId: ref.id }], [], data)[0];
  assert.ok(withWeapons.value > without.value);
  assert.match(withWeapons.reason, /sinerji/);
});

test('with gold known, unaffordable offers are flagged and the budget is respected', () => {
  const offers = ['Narwhal', 'Anchor', 'Grapeshot'].map((n) => ({ templateId: byName(n).id }));
  const broke = rankOffers(offers, [], data, { gold: 0 });
  assert.ok(broke.every((o) => o.verdict === 'para yetmiyor'));
  const gold = 3;
  const some = rankOffers(offers, [], data, { gold });
  const spend = some.filter((o) => o.verdict === 'al').reduce((s, o) => s + o.price, 0);
  assert.ok(spend <= gold, `suggested buys cost ${spend} with ${gold} gold`);
  const free = rankOffers(offers, [], data, { gold: 0, free: true });
  assert.ok(free.every((o) => o.price === 0 && o.verdict !== 'para yetmiyor'));
});

test('reroll advice: never when the shop has no reroll, and "çekme" when holding the best item of the pool', () => {
  const offers = ['Narwhal', 'Grapeshot'].map((n) => ({ templateId: byName(n).id }));
  assert.equal(rerollAdvice(offers, [], data, { shop: { rerollCost: null, rerollsAllowed: 0 } }).possible, false);
  const pool = Object.values(data.cards).filter((c) => c.type === 'Item' && c.heroes.includes('Vanessa') && c.size === 'Small' && c.startingTier === 'Bronze' && !/^\[|DEBUG|TEMPLATE/i.test(c.internalName));
  const best = rankOffers(pool.map((c) => ({ templateId: c.id })), [], data)[0];
  const same = pool.filter((c) => c.id !== best.templateId).slice(0, 2);
  const adv = rerollAdvice([{ templateId: best.templateId }, ...same.map((c) => ({ templateId: c.id }))], [], data, { hero: 'Vanessa', shop: { rerollCost: 3, rerollsAllowed: 1 }, gold: 10 });
  assert.equal(adv.possible, true);
  assert.ok(adv.gain <= 0);
  assert.equal(adv.verdict, 'çekme');
  const worst = rankOffers(pool.map((c) => ({ templateId: c.id })), [], data).slice(-3);
  const adv2 = rerollAdvice(worst.map((o) => ({ templateId: o.templateId })), [], data, { hero: 'Vanessa', shop: { rerollCost: 3, rerollsAllowed: 1 }, gold: 2 });
  assert.equal(adv2.verdict, 'para yetmiyor');
  const adv3 = rerollAdvice(worst.map((o) => ({ templateId: o.templateId })), [], data, { hero: 'Vanessa', shop: { rerollCost: 3, rerollsAllowed: 1 }, gold: 50 });
  assert.ok(adv3.gain > 0, 'holding the three worst items of the pool, a reroll is expected to improve');
  assert.ok(adv3.chanceBetter > 50);
});

test('sell list starts with the weakest item; upgrades and enchants report a gain', () => {
  const o = owned(['Narwhal', 'Anchor', 'Grapeshot']);
  const sell = rankSell(o, data);
  for (let i = 1; i < sell.length; i++) assert.ok(sell[i - 1].perSlot <= sell[i].perSlot);
  assert.ok(sell.every((s) => typeof s.sellPrice === 'number'));
  const up = rankUpgrades(o, data);
  assert.ok(up.find((u) => u.name === 'Narwhal').gain > 0);
  const en = rankEnchant('Shiny', o, data);
  assert.ok(en.length > 0);
  assert.equal(boardSummary(o, data.cards).slots, o.reduce((s, x) => s + { Small: 1, Medium: 2, Large: 3 }[data.cards[x.templateId].size], 0));
});

// ---------- view ----------
test('view: upper-half detections become offers, owned items in the lower half do not', () => {
  const run = runFixture();
  const now = Date.now();
  const screen = {
    ts: now / 1000,
    detections: [
      { cardIds: [byName('Grapeshot').id], cx: 0.4, cy: 0.3 },
      { cardIds: [byName('Narwhal').id], cx: 0.5, cy: 0.66 },
    ],
  };
  const v = buildView(run, screen, data, { now });
  assert.deepEqual(v.advice.offers.map((o) => o.name), ['Grapeshot']);
  assert.equal(v.board.items.find((i) => i.name === 'Narwhal').seen, true);
  assert.equal(v.run.hero, 'Vanessa');
  const stale = buildView(run, { ...screen, ts: now / 1000 - 30 }, data, { now });
  assert.equal(stale.advice.offers.length, 0, 'old frames are not shown as current offers');
});

test('event choices: rated for the build, gold via points-per-gold, unmet conditions excluded', async () => {
  const { rateChoices, describeMonster, pointsPerGold } = await import('../src/choices.mjs');
  const item = (n) => Object.values(data.cards).find((c) => c.name === n && c.type === 'Item');
  const board = ['Seaweed', 'Piranha'].map((n, i) => ({ instanceId: 'c' + i, templateId: item(n).id, tier: item(n).startingTier, where: 'board' }));
  const event = (n) => Object.values(data.cards).find((c) => c.name === n && c.type === 'EventEncounter' && c.choices?.length);
  const apo = rateChoices(event('Apothecary'), { day: 2 }, board, data, {});
  assert.equal(apo[0].name, 'Nourishing Glaze', 'the heal buff is the only one that touches this board (Seaweed heals)');
  assert.equal(apo[0].verdict, 'seç');
  assert.ok(apo[0].value > 0);
  assert.equal(apo.find((o) => o.name === 'Fortifying Salve').value, 0);
  const finn = rateChoices(event("Finn's Big Bite"), { day: 2 }, board, data, {});
  const farm = finn.find((o) => o.name === 'Farm Fresh Ingredients');
  assert.equal(farm.verdict, 'şart yok');
  assert.ok(Math.abs(farm.value - Math.round(10 * pointsPerGold(data) * 10) / 10) < 0.11);
  const camper = Object.values(data.cards).find((c) => c.name === 'Happy Camper' && c.type === 'CombatEncounter');
  const m = describeMonster(camper, board, data);
  assert.equal(m.health, 100);
  assert.ok(m.items.length > 0 && m.theirs > 0 && m.mine > 0);
});

test('placement: adjacency rules from the item data decide the order', async () => {
  const { bestLayout, positionalRules } = await import('../src/layout.mjs');
  const item = (n) => Object.values(data.cards).find((c) => c.name === n && c.type === 'Item');
  const tags = [...new Set(Object.values(data.cards).flatMap((c) => (c.type === 'Item' ? c.tags : [])))];
  assert.deepEqual(positionalRules(item('Jellyfish'), tags).map((r) => [r.side, r.tags]), [['both', ['Aquatic']]]);
  // A filler with no placement rule of its own and no Aquatic tag, so only Jellyfish's rule counts.
  const filler = Object.values(data.cards).find((c) => c.type === 'Item' && c.size === 'Small' && !positionalRules(c, tags).length && ![...c.tags, ...c.hiddenTags].includes('Aquatic') && c.tiers[c.startingTier]);
  const cardsOf = [filler, item('Jellyfish'), item('Piranha')];
  const board = cardsOf.map((c, i) => ({ instanceId: 'p' + i, templateId: c.id, tier: c.startingTier }));
  const L = bestLayout(board, data, ['p1', 'p0', 'p2']); // Jellyfish, filler, Piranha: no Aquatic neighbour
  const order = L.order.map((o) => o.name);
  assert.equal(Math.abs(order.indexOf('Jellyfish') - order.indexOf('Piranha')), 1, 'Jellyfish wants an adjacent Aquatic item');
  assert.equal(L.changed, true);
  assert.ok(L.score > L.currentScore);
});

test('view: the board read from the screen wins over the log (rewards and moves are not logged)', () => {
  const piranha = Object.values(data.cards).find((c) => c.name === 'Piranha' && c.type === 'Item');
  const seaweed = Object.values(data.cards).find((c) => c.name === 'Seaweed' && c.type === 'Item');
  const run = { active: true, hero: 'Vanessa', day: 2, hour: 1, phase: 'ChoiceState', items: { a: { templateId: piranha.id, tier: 'Silver', where: 'board' }, b: { templateId: seaweed.id, tier: 'Bronze', where: 'board' } }, skills: [], encounters: [], current: null, fights: { pve: 0, pvp: 0 }, goldFromSales: 0, goldSpentEst: 0 };
  const row = [piranha, piranha, piranha].map((c, i) => ({ cardIds: [c.id], cx: 0.3 + i * 0.1 }));
  const v = buildView(run, null, data, { now: Date.now(), screenBoard: row });
  const board = v.board.items.filter((i) => i.where === 'board');
  assert.deepEqual(board.map((i) => i.name), ['Piranha', 'Piranha', 'Piranha']);
  assert.equal(board[0].tier, 'Silver', 'the logged copy keeps its tier');
  assert.equal(v.board.items.find((i) => i.name === 'Seaweed').where, 'stash', 'not on screen, so not on the board');
  assert.equal(v.advice.layout.order.length, 3);
});

test('path options: merchants rated by their pool, events by their best choice, strong monsters flagged', async () => {
  const { rateOptions, merchantPool, likelyTier } = await import('../src/choices.mjs');
  const by = (n, t) => Object.values(data.cards).filter((c) => c.name === n && (!t || c.type === t));
  const board = ['Seaweed', 'Piranha', 'Flying Fish'].map((n, i) => ({ instanceId: 'o' + i, templateId: by(n, 'Item')[0].id, tier: 'Bronze', where: 'board' }));
  const aila = by('Aila', 'EventEncounter')[0];
  assert.ok(merchantPool(aila, 'Vanessa', data).every((c) => c.type === 'Item'));
  const { describeMonster: dm } = await import('../src/choices.mjs');
  const flame = Object.values(data.cards).filter((c) => c.type === 'CombatEncounter' && data.monsters[c.combat.monsterId]).sort((a, b) => dm(b, board, data).theirs - dm(a, board, data).theirs)[0];
  const out = rateOptions([[aila.id], by('Mountain Pass').map((c) => c.id), [flame.id]], { hero: 'Vanessa', day: 2 }, board, data, { gold: 20 });
  assert.deepEqual(out.map((o) => o.kind), ['tüccar', 'olay', 'canavar']);
  assert.ok(out[0].score > 0 && /Sells Weapons/.test(out[0].reason));
  assert.equal(out[2].verdict, 'riskli', 'the strongest monster in the data against three bronze items');
  assert.equal(out.filter((o) => o.verdict === 'seç').length, 1);
  const piranha = by('Piranha', 'Item')[0];
  assert.equal(likelyTier(data, 1, piranha), 'Bronze');
  assert.equal(likelyTier(data, 6, piranha), 'Silver', 'day 6 shops are 95% Silver in the game mode table');
});

test('fight estimate: needs health, is repeatable, and moves with the monster; day power uses same-level monsters', async () => {
  const { winChance, dayPower } = await import('../src/fight.mjs');
  const { strengthOf, describeMonster } = await import('../src/choices.mjs');
  const item = (n) => Object.values(data.cards).find((c) => c.name === n && c.type === 'Item');
  const board = ['Piranha', 'Piranha', 'Marlon', 'Seaweed'].map((n, i) => ({ instanceId: 'f' + i, templateId: item(n).id, tier: item(n).startingTier, where: 'board' }));
  const mon = (n) => Object.values(data.cards).find((c) => c.name === n && c.type === 'CombatEncounter');
  assert.equal(winChance(mon('Happy Camper'), board, null, data), null, 'no health read, no estimate');
  const easy = winChance(mon('Happy Camper'), board, 600, data);
  assert.deepEqual(easy, winChance(mon('Happy Camper'), board, 600, data), 'same seed, same answer');
  assert.ok(easy.chance >= 0 && easy.chance <= 100 && ['düşük', 'orta', 'yüksek'].includes(easy.confidence));
  const hard = winChance(mon('Flame Juggler'), board, 600, data);
  assert.ok(hard.chance <= easy.chance, 'a 1200 health level 7 monster is not easier than a 100 health level 2 one');
  const p1 = dayPower(board, 1, data, (it) => strengthOf(it, data));
  const p9 = dayPower(board, 9, data, (it) => strengthOf(it, data));
  assert.ok(p1.percent > p9.percent, 'the same board is weaker against later days');
  const m = describeMonster(mon('Bloodreef Raider'), board, data, 600);
  assert.equal(m.uncertain, true, 'most of this monster is auras and triggers the model cannot count');
});

test('engine: triggers, auras and neighbours change what an item does', async () => {
  const { runFight, boardValue, coverageOf } = await import('../src/engine.mjs');
  const item = (n) => Object.values(data.cards).find((c) => c.name === n && c.type === 'Item');
  const mk = (...names) => names.map((n) => ({ templateId: item(n).id, tier: item(n).startingTier }));
  const usesOf = (names, who) => { const r = boardValue(mk(...names), [], data, { seeds: [1], seconds: 30 }); return r.per.filter((p) => p.name === who).reduce((n, p) => n + p.uses, 0); };
  // Piranha: "When you use another Friend or Food, Charge this 1 second". Narwhal is a Friend, Bolas is not.
  assert.ok(usesOf(['Piranha', 'Narwhal'], 'Piranha') > usesOf(['Piranha', 'Bolas'], 'Piranha'));
  // Jellyfish: "When you use an adjacent Aquatic item, Haste this". Adjacent matters.
  const filler = Object.values(data.cards).find((c) => c.type === 'Item' && c.size === 'Small' && !(c.fx ?? []).length && c.tiers[c.startingTier]);
  const adj = boardValue(mk('Jellyfish', 'Piranha'), [], data, { seeds: [1], seconds: 60 }).per[0].uses;
  const apart = boardValue([mk('Jellyfish')[0], { templateId: filler.id, tier: filler.startingTier }, mk('Piranha')[0]], [], data, { seeds: [1], seconds: 60 }).per[0].uses;
  assert.ok(adj > apart, `hasted Jellyfish fires more often (${adj} vs ${apart})`);
  // IllusoRay: "+1 Multicast for each adjacent Friend or Ray": between two Piranhas it slows more than beside one.
  const denied = (names) => boardValue(mk(...names), [], data, { seeds: [1, 2, 3], refDps: 30 }).parts.denied;
  assert.ok(denied(['Piranha', 'IllusoRay', 'Piranha']) > denied(['IllusoRay', 'Piranha', 'Piranha']));
  // Burn rule: 10 burn, no shield, ticks twice a second and shrinks 3% per tick.
  const burner = Object.values(data.cards).find((c) => c.type === 'Item' && (c.fx ?? []).length === 1 && c.fx[0].act === 'PlayerBurnApply' && c.fx[0].trig === 'OnCardFired' && !c.tiers[c.startingTier].attrs.AmmoMax && c.tiers[c.startingTier].attrs.Multicast === 1);
  const a = burner.tiers[burner.startingTier].attrs;
  const r = runFight({ items: [{ templateId: burner.id, tier: burner.startingTier }] }, { items: [] }, data, { seconds: a.CooldownMax / 1000 + 1, dummy: { hit: 0 } });
  const n = a.BurnApplyAmount * (1 + (a.CritChance ?? 0) / 100);
  const ticks = a.CooldownMax % 500 === 0 ? 3 : 2; // the tick on the firing step itself counts when they line up
  const want = Array.from({ length: ticks }, (_, i) => n * 0.97 ** i).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(r.b.taken - want) < 1e-6, `burn ticks twice a second and shrinks 3% each tick (${r.b.taken} vs ${want})`);
  assert.equal(coverageOf(mk('Piranha', 'Jellyfish', 'IllusoRay'), [], data).share, 1);
});

test('view: an offer is valued by what it adds to this board, with where to put it', () => {
  const item = (n) => Object.values(data.cards).find((c) => c.name === n && c.type === 'Item');
  const items = Object.fromEntries(['Piranha', 'Piranha', 'Marlon'].map((n, i) => ['e' + i, { templateId: item(n).id, tier: 'Bronze', where: 'board' }]));
  const run = { active: true, hero: 'Vanessa', day: 2, hour: 1, phase: 'EncounterState', items, skills: [], encounters: [], current: null, fights: { pve: 0, pvp: 0 }, goldFromSales: 0, goldSpentEst: 0 };
  const now = Date.now();
  const v = buildView(run, { ts: now / 1000, detections: [{ kind: 'items', art: 'items/Narwhal', cardIds: [item('Narwhal').id], cx: 0.4, cy: 0.4 }] }, data, { now, gold: 20 });
  const o = v.advice.offers[0];
  assert.equal(o.name, 'Narwhal');
  assert.ok(o.value > 0 && /tahtana katkısı \+/.test(o.reason) && /koy/.test(o.reason));
  assert.equal(o.verdict, 'al');
  assert.ok(v.power.percent > 0 && v.advice.engine.value > 0);
});

test('engine regressions: a cooldown increase lengthens the cooldown; "when this is hasted" needs this item hasted', async () => {
  const { boardValue } = await import('../src/engine.mjs');
  const item = (n) => Object.values(data.cards).find((c) => c.name === n && c.type === 'Item');
  const mk = (...names) => names.map((n) => ({ templateId: item(n).id, tier: item(n).startingTier }));
  // Seashadow: 2 s cooldown, "Increase this item's Cooldown by 4 seconds" each use: uses at 2 s and 8 s, not eight times.
  const sea = boardValue(mk('Seashadow', 'Piranha'), [], data, { seeds: [1] }).per[0];
  assert.ok(sea.uses <= 3, `Seashadow used ${sea.uses} times in 15 s`);
  // Catfish: "When you Haste this, it gains Poison". Zoarcid hastes its neighbours only.
  const cat = (names) => boardValue(mk(...names), [], data, { seeds: [1], seconds: 40 }).per.find((p) => p.name === 'Catfish').damage;
  assert.ok(cat(['Zoarcid', 'Catfish']) > cat(['Zoarcid', 'Seaweed', 'Catfish']), 'only a hasted Catfish ramps');
});

test('scene memory: hover text names the option, and the log ends the scene', async () => {
  const { createScene } = await import('../src/scene.mjs');
  const sc = createScene(data);
  // Real OCR output from captured frames, stray characters included.
  assert.equal(sc.identify('pb Wandering Shoal C10\nREWARDS ¢© a\n| 5 4').cards[0].name, 'Wandering Shoal');
  const ap = sc.identify('Apothecary _il\nOffers a variety of boons to\ndefensive items');
  assert.equal(ap.cards[0].name, 'Apothecary');
  assert.match(ap.rest, /boons/);
  const prim = sc.identify('ee\n\nAwakened Primordiax 12\n\nREWARDS EO');
  assert.equal(prim.cards[0].type, 'CombatEncounter');
  assert.equal(prim.level, 12);
  assert.equal(sc.identify('y XU) Us ~ Nw\nqq zz'), null, 'noise names nothing');

  const chest = Object.values(data.cards).filter((c) => c.name === 'Apothecary' && c.type === 'EventEncounter');
  const many = [...chest.map((c) => c.id), ...Object.values(data.cards).filter((c) => c.type === 'EventEncounter').slice(0, 3).map((c) => c.id)];
  sc.onFrame({ detections: [{ kind: 'encounters', art: 'encounters/x', cardIds: many, cx: 0.36, cy: 0.3 }], hover: [] }, 'ChoiceState');
  sc.onFrame({ detections: [], hover: [{ x: 0.58, y: 0.26, w: 0.26, h: 0.18, text: 'Apothecary _il\nOffers a variety of boons to\ndefensive items' }] }, 'ChoiceState');
  const opt = sc.detections()[0];
  assert.ok(opt.pinned && opt.cardIds.every((id) => data.cards[id].name === 'Apothecary'), 'the tooltip settles which card the picture is');
  assert.equal(sc.detections().length, 1, 'a frame without the tile does not lose it');
  sc.onLine('[00:00:01.000] [NetworkManager] [HttpGameClient] Command completed: type=SelectEncounterCommand, requestId=1');
  assert.equal(sc.detections().length, 0, 'choosing a path ends the options');

  const item = (n) => Object.values(data.cards).find((c) => c.name === n && c.type === 'Item');
  sc.onFrame({ detections: [{ kind: 'items', art: 'items/Piranha', cardIds: [item('Piranha').id], cx: 0.45, cy: 0.4 }, { kind: 'items', art: 'items/Narwhal', cardIds: [item('Narwhal').id], cx: 0.55, cy: 0.4 }] }, 'EncounterState');
  sc.onEvent({ type: 'purchase', templateId: item('Piranha').id });
  assert.deepEqual(sc.detections().map((d) => d.art), ['items/Narwhal'], 'a bought offer leaves the shop');
  sc.onLine('... Command completed: type=RerollCommand, requestId=2');
  assert.equal(sc.detections().length, 0, 'a reroll empties the remembered shop');
  sc.onFrame({ detections: [], hover: [{ x: 0.3, y: 0.2, w: 0.3, h: 0.3, text: 'Piranha\nDeal 40 Damage\nSells for 2' }] }, 'EncounterState');
  assert.equal(sc.facts()[item('Piranha').id].tier, 'Silver', 'a Small item that sells for 2 is Silver');
  sc.onEvent({ type: 'state', from: 'EncounterState', to: 'ChoiceState' });
  assert.equal(sc.hovered().length, 0, 'a state change clears the scene');
  assert.equal(sc.facts()[item('Piranha').id].tier, 'Silver', 'what was learnt about owned items stays for the run');
  sc.onEvent({ type: 'runStart' });
  assert.deepEqual(sc.facts(), {});
});

test('plan: one ordered list of steps per screen, buying within the gold in hand', () => {
  const item = (n) => Object.values(data.cards).find((c) => c.name === n && c.type === 'Item');
  const items = Object.fromEntries(['Piranha', 'Piranha', 'Marlon'].map((n, i) => ['q' + i, { templateId: item(n).id, tier: 'Bronze', where: 'board' }]));
  const base = { active: true, hero: 'Vanessa', day: 2, hour: 1, items, skills: [], encounters: [], current: null, fights: { pve: 0, pvp: 0 }, goldFromSales: 0, goldSpentEst: 0 };
  const now = Date.now();
  const shop = { ts: now / 1000, detections: [{ kind: 'items', art: 'items/Narwhal', cardIds: [item('Narwhal').id], cx: 0.4, cy: 0.4 }, { kind: 'items', art: 'items/Jellyfish', cardIds: [item('Jellyfish').id], cx: 0.6, cy: 0.4 }] };
  const rich = buildView({ ...base, phase: 'EncounterState' }, shop, data, { now, gold: 50 }).plan;
  assert.ok(rich.filter((s) => s.do === 'al').length >= 1);
  assert.equal(rich[rich.length - 1].do, 'çık', 'the plan ends by leaving the encounter');
  const poor = buildView({ ...base, phase: 'EncounterState' }, shop, data, { now, gold: 0 }).plan;
  assert.equal(poor.filter((s) => s.do === 'al').length, 0, 'nothing is bought without gold');
  assert.deepEqual(buildView({ ...base, phase: 'CombatState' }, null, data, { now }).plan.map((s) => s.do), ['bekle']);
});
