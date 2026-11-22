// Board engine: runs boards step by step under the game's own rules, so an item's worth includes what it
// does to and with the other items. Everything comes from data/cards.json: each card's structured effects
// ("fx": trigger, subject, prerequisites, action, target, amount, cost) and per-tier attributes, enchantment
// effects, the game's base player rules (PlayerEffect cards, e.g. what Enraged does), monster layouts.
// Rules are the game's own (tooltips table, game mode): burn ticks twice a second, shrinks 3% per tick and is
// halved by shield; poison ticks once a second and ignores shield; regen heals once a second; heal cleanses 5%
// burn and poison; haste doubles and slow halves charging; flying halves slow and freeze; crit doubles (rolled
// per use); ammo runs out; 100 rage (or the monster's own maximum) enrages for the enrage duration; 1 tempo per
// second; the sandstorm starts at 30 s and ramps up.
//
// Assumptions where the data does not say: rage is not gained while enraged; auras are re-evaluated once per
// 100 ms step; a transform picks uniformly among its listed results; an in-fight enchant picks by listed weight.
// Not computable from a fight alone (reported by coverageOf): amounts keyed to run-long counters the log does
// not carry (gold gained this run, weapons bought this run, ...), and five prerequisites of unusual shape.
// Effects that only exist outside fights (on sell, buy, upgrade, day start, level up, encounter packages) are
// not part of a fight and are not counted as missing.
//
// The fight part exists at the owner's explicit request; the publisher's mod policy reportedly forbids tools
// that calculate combat results, so using it is the owner's own risk.

const DT = 100; // ms
const PER = { PlayerDamage: 'DamageAmount', PlayerShieldApply: 'ShieldApplyAmount', PlayerHeal: 'HealAmount', PlayerBurnApply: 'BurnApplyAmount', PlayerPoisonApply: 'PoisonApplyAmount', PlayerRegenApply: 'RegenApplyAmount' };
const TIMED = { CardHaste: 'Haste', CardSlow: 'Slow', CardFreeze: 'Freeze', CardCharge: 'Charge' };
const PERFORMED = { CardHaste: 'OnCardPerformedHaste', CardSlow: 'OnCardPerformedSlow', CardFreeze: 'OnCardPerformedFreeze', PlayerDamage: 'OnCardPerformedDamage', PlayerBurnApply: 'OnCardPerformedBurn', PlayerPoisonApply: 'OnCardPerformedPoison', PlayerShieldApply: 'OnCardPerformedShield', PlayerHeal: 'OnCardPerformedHeal', PlayerRegenApply: 'OnCardPerformedRegen', CardReload: 'OnCardPerformedReload', CardDisable: 'OnCardPerformedDestruction', CardDestroy: 'OnCardPerformedDestruction' };
const HANDLED_TRIG = new Set(['OnCardFired', 'OnItemUsed', 'OnBeforeItemUsed', 'OnFightStarted', 'OnCardStartedFlying', 'OnCardStoppedFlying', 'OnCardCritted', 'OnPlayerAttributeChanged', 'OnCardAttributeChanged',
  'OnPlayerEnraged', 'OnPlayerEnrageEnded', 'OnBeforeCardDestroyed', 'OnCardDisabled', 'OnCardRepaired', 'OnPlayerDied', 'OnPlayerDamaged', 'OnSandstorm', 'OnCardCharged', 'OnCardPerformedOverHeal',
  'OnCardEnchanted', 'OnCardTransformed', 'OnCardAfterTransform', 'Aura', 'Or', ...Object.values(PERFORMED)]);
const HANDLED_ACT = new Set([...Object.keys(PER), ...Object.keys(TIMED), 'CardModifyAttribute', 'CardFlyingStart', 'CardFlyingStop', 'CardFlyingToggle', 'CardReload', 'CardDisable', 'CardDestroy', 'CardForceUse',
  'PlayerModifyAttribute', 'PlayerBurnRemove', 'PlayerPoisonRemove', 'PlayerRageApply', 'PlayerTempoApply', 'CardAddTagsList', 'CardAddTagsBySource', 'CardEnchant', 'CardEnchantRandom', 'CardTransform',
  'CardTransformDestroyed', 'CardRepair', 'PlayerReviveHeal', 'CardBeginSandstorm']);
const OUTSIDE_TRIG = new Set(['OnCardSold', 'OnDayStarted', 'OnFightEnded', 'OnCardPurchased', 'OnCardUpgraded', 'OnEncounterSelected', 'OnCardSelected', 'OnHourStarted', 'OnEncounterCardsDealt', 'OnCardQuestCompleted',
  'OnEncounterEntered', 'OnEncounterExited', 'OnRunStarted', 'OnCardPerformedSale']);
const OUTSIDE_ACT = new Set(['GameSpawnCards', 'CardUpgrade', 'PlayerPortraitNext', 'PlayerPortraitReset', 'CardAddTagsRandom', 'GameDealCards', 'GameReroll']);
const OUTSIDE_PATTR = new Set(['Gold', 'Level', 'Income', 'Prestige', 'Experience']); // as trigger attributes: they do not change in a fight
const P = { HealthMax: 'max', Health: 'hp', Shield: 'shield', Burn: 'burn', Poison: 'poison', HealthRegen: 'regen', Gold: 'gold', Income: 'income', Rage: 'rage', RageMax: 'rageMax', EnragedDurationMax: 'enragedMs',
  Tempo: 'tempo', Level: 'level', CritChance: 'crit', PercentDamageReduction: 'dr' };
const STATUS = { Slow: 'slow', Freeze: 'freeze', Haste: 'haste' };
const CMP = { Equal: (a, b) => a === b, NotEqual: (a, b) => a !== b, GreaterThan: (a, b) => a > b, GreaterThanOrEqual: (a, b) => a >= b, LessThan: (a, b) => a < b, LessThanOrEqual: (a, b) => a <= b };
const playerAttrKnown = (a) => a === 'Enraged' || Boolean(P[a]);
const valueKnown = (v) => !v || !(v.unk && v.unk !== 'AttributeChange') && !(v.pattr && !playerAttrKnown(v.pattr));

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 'yes' the engine runs it, 'outside' it is not a fight effect, 'no' it cannot be computed from the fight. */
export function classify(fx) {
  if ((fx.pre ?? []).some((p) => p.k === 'run') || OUTSIDE_ACT.has(fx.act) || fx.attr === 'RerollCostModifier') return 'outside';
  const subs = (fx.any ?? [fx]).filter((t) => !(OUTSIDE_TRIG.has(t.trig) || (t.trig === 'OnPlayerAttributeChanged' && OUTSIDE_PATTR.has(t.pattr))));
  if (!subs.length) return 'outside';
  if (subs.some((t) => !HANDLED_TRIG.has(t.trig) || (t.trig === 'OnPlayerAttributeChanged' && !playerAttrKnown(t.pattr)))) return 'no';
  if (!HANDLED_ACT.has(fx.act)) return 'no';
  if (!valueKnown(fx.val) || (fx.cost && (!playerAttrKnown(fx.cost.pattr) || !valueKnown(fx.cost.val)))) return 'no';
  if (fx.act === 'PlayerModifyAttribute' && !playerAttrKnown(fx.attr)) return 'no';
  for (const p of fx.pre ?? []) if (p.k === 'other' || (p.k === 'player' && (!playerAttrKnown(p.a) || !valueKnown(p.v)))) return 'no';
  return 'yes';
}

/** Share of fight effects the engine can run for these cards, and which cards have something it cannot. */
export function coverageOf(entries, skills, data) {
  let ok = 0, all = 0; const missed = [];
  const cards = [...entries.map((e) => [data.cards[e.templateId], e.enchant]), ...(skills ?? []).map((s) => [data.cards[s.templateId ?? s], null])];
  for (const [c, ench] of cards) {
    for (const fx of [...(c?.fx ?? []), ...(ench ? c?.enchantments?.[ench]?.fx ?? [] : [])]) {
      const k = classify(fx);
      if (k === 'outside') continue;
      all++;
      if (k === 'yes') ok++; else if (!missed.includes(c.name)) missed.push(c.name);
    }
  }
  return { share: all ? ok / all : 1, missed };
}

function modifyAttrs(attrs, attr, op, v) {
  const sign = op === 'Subtract' ? -1 : 1; // subtracting a reduction makes the cooldown longer
  if (attr === 'FlatCooldownReduction') { if ((attrs.CooldownMax ?? 0) > 0) attrs.CooldownMax = Math.max(1000, attrs.CooldownMax - sign * v); return; }
  if (attr === 'PercentCooldownReduction') { if ((attrs.CooldownMax ?? 0) > 0) attrs.CooldownMax = Math.max(1000, attrs.CooldownMax * (1 - (sign * v) / 100)); return; }
  const cur = attrs[attr] ?? 0;
  attrs[attr] = op === 'Subtract' ? cur - v : op === 'Multiply' ? cur * v : op === 'Set' ? v : cur + v;
  if (attr === 'CooldownMax' && attrs.CooldownMax > 0) attrs.CooldownMax = Math.max(1000, attrs.CooldownMax);
}

function buildSide(spec, data, sideId, rules) {
  const fill = (it, c, tier, enchant, over) => {
    const t = c.tiers?.[tier] ?? c.tiers?.[c.startingTier] ?? { attrs: {} };
    const ench = enchant ? c.enchantments?.[enchant] : null;
    const base = { ...t.attrs, ...(over ?? {}) };
    for (const [k, v] of Object.entries(ench?.attrs ?? {})) base[k] = (base[k] ?? 0) + v;
    if (c.internalName === 'Base Rage Effect' && !base.Custom_0) base.Custom_0 = 10; // the Rage tooltip: cooldowns reduced by 10% while Enraged
    Object.assign(it, { card: c, name: c.name, tier, enchant: enchant ?? null, size: c.size, base, attrs: { ...base },
      baseTags: [...(c.tags ?? []), ...(c.hiddenTags ?? []), ...(ench?.hiddenTags ?? [])],
      fx: [...(c.fx ?? []), ...(ench?.fx ?? [])].filter((f) => classify(f) === 'yes'), ammo: base.AmmoMax ?? null });
    it.tags = it.baseTags.slice();
    return it;
  };
  const blank = (pos) => ({ side: sideId, pos, progress: 0, haste: 0, slow: 0, freeze: 0, flying: false, dead: false, uses: 0, critNow: 1, out: { damage: 0, shield: 0, heal: 0, burn: 0, poison: 0, regen: 0 } });
  const items = (spec.items ?? []).map((e, i) => (data.cards[e.templateId] ? fill(blank(i), data.cards[e.templateId], e.tier, e.enchant, e.attrs) : null)).filter(Boolean);
  const skills = (spec.skills ?? []).map((s, i) => {
    const id = s.templateId ?? s; const c = data.cards[id];
    return c ? Object.assign(fill(blank(-1 - i), c, s.tier ?? c.startingTier, null, null), { skill: true }) : null;
  }).filter(Boolean);
  const ruleCards = rules.map((c, i) => Object.assign(fill(blank(-100 - i), c, c.startingTier, null, null), { skill: true, rule: true })).filter((r) => r.fx.length);
  const health = spec.health ?? 1e9;
  const p = spec.player ?? {};
  const side = { id: sideId, items, skills: [...skills, ...ruleCards], hp: health, max: health, shield: 0, burn: 0, poison: 0, regen: p.regen ?? 0, gold: spec.gold ?? 0, income: spec.income ?? p.income ?? 0,
    rage: 0, enraged: 0, tempo: p.tempo ?? 0, level: spec.level ?? 1, revives: 0, taken: 0, burnBy: new Map(), poisonBy: new Map(),
    basePlayer: { rageMax: p.rageMax ?? 100, enragedMs: p.enragedMs ?? 5000, crit: 0, dr: 0 } };
  Object.assign(side, side.basePlayer);
  return { side, fill };
}

/**
 * Run a fight. a, b: { items: [{templateId,tier,enchant,attrs?}], skills: [id | {templateId,tier}], health, gold?,
 * income?, level?, player?: {rageMax,enragedMs,regen,tempo} }. opts: { seconds, seed, dummy: when set, b is a punching
 * bag whose items only hit for dummy.hit each use, so the run measures a's output and how much of a reference
 * enemy's output a's slows, freezes and destroys deny }.
 */
export function runFight(a, b, data, opts = {}) {
  const rand = rng(opts.seed ?? 1);
  const rules = data._rules ?? (data._rules = Object.values(data.cards).filter((c) => c.type === 'PlayerEffect' && (c.fx ?? []).some((f) => classify(f) === 'yes')));
  const { side: A, fill } = buildSide(a, data, 'a', rules);
  const { side: B } = buildSide(b, data, 'b', rules);
  const sides = [A, B];
  const other = (s) => (s === A ? B : A);
  const sideOf = (it) => (it.side === 'a' ? A : B);
  const dummy = opts.dummy ?? null;
  const timers = [];
  let depth = 0, dirty = true, now = 0, listeners = null, stormAt = null, stormOn = false;

  const holders = (s) => [...s.items, ...s.skills];
  function index() {
    listeners = new Map();
    for (const side of sides) for (const L of holders(side)) for (const fx of L.fx) {
      if (fx.trig === 'Aura' || fx.trig === 'OnCardFired') continue;
      for (const t of fx.any ?? [fx]) { if (!listeners.has(t.trig)) listeners.set(t.trig, []); listeners.get(t.trig).push({ L, side, fx, t }); }
    }
  }
  const getP = (side, attr) => (attr === 'Enraged' ? (side.enraged > 0 ? 1 : 0) : side[P[attr]] ?? 0);

  function matches(it, c) {
    if (!c) return true;
    if (c.tags?.length && !c.tags.some((t) => it.tags.includes(t))) return false;
    if (c.notTags?.length && c.notTags.some((t) => it.tags.includes(t))) return false;
    if (c.sizes?.length && !c.sizes.includes(it.size)) return false;
    if (c.ench != null && Boolean(it.enchant) !== c.ench) return false;
    for (const q of c.attrs ?? []) {
      const have = q.a === 'Flying' ? (it.flying ? 1 : 0) : STATUS[q.a] ? (it[STATUS[q.a]] > 0 ? 1 : 0) : it.attrs[q.a] ?? 0;
      if (!(CMP[q.op] ?? CMP.GreaterThan)(have, q.v ?? 0)) return false;
    }
    return true;
  }
  function neighbours(self, side, mode) {
    if (self.skill) return [];
    const live = side.items.filter((x) => !x.dead);
    const i = live.indexOf(self);
    if (i < 0) return [];
    if (mode === 'Neighbor') return [live[i - 1], live[i + 1]].filter(Boolean);
    if (mode === 'LeftCard') return [live[i - 1]].filter(Boolean);
    if (mode === 'RightCard') return [live[i + 1]].filter(Boolean);
    if (mode === 'AllLeftCards') return live.slice(0, i);
    if (mode === 'AllRightCards') return live.slice(i + 1);
    return [];
  }
  function resolveCards(t, self, me, foe, ctx, count, includeDead = false) {
    if (!t) return [];
    let pool;
    const alive = (s) => s.items.filter((x) => includeDead ? x.dead : !x.dead);
    if (t.type === 'CardSelf') pool = [self];
    else if (t.type === 'CardTriggerSource') pool = ctx?.source ? [ctx.source] : [];
    else if (t.type === 'CardTriggerTarget') pool = ctx?.target ? [ctx.target] : [];
    else if (t.type === 'CardPositional') pool = neighbours(self, me, t.mode);
    else if (t.section === 'SelfNeighbors') pool = neighbours(self, me, 'Neighbor');
    else if (/^Opponent/.test(t.section ?? '')) pool = alive(foe);
    else if (/^All/.test(t.section ?? '')) pool = [...alive(me), ...alive(foe)];
    else if (t.section === 'SelfSkills') pool = me.skills.filter((x) => !x.rule);
    else pool = alive(me);
    pool = pool.filter((x) => (t.section === 'SelfSkills' || !x.skill) && matches(x, t) && !(t.excludeSelf && x === self));
    if (t.type === 'CardXMost') pool = pool.length ? [t.mode === 'RightMostCard' ? pool[pool.length - 1] : pool[0]] : [];
    else if (t.type === 'CardRandom' || (count != null && count < pool.length)) {
      const n = Math.max(1, count ?? 1);
      pool = pool.map((x) => [rand(), x]).sort((p, q) => p[0] - q[0]).slice(0, n).map((x) => x[1]);
    }
    return pool;
  }
  const whole = (t) => ({ ...t, type: t?.type === 'CardRandom' ? 'CardSection' : t?.type });
  function amount(v, self, me, foe, ctx) {
    if (!v) return null;
    if (v.v != null) return v.v;
    const mul = v.mul ?? 1;
    if (v.ref) return (self.attrs[v.ref] ?? 0) * mul;
    if (v.count) return resolveCards(whole(v.count), self, me, foe, ctx, null).length * mul;
    if (v.cattr) { const x = resolveCards(v.of, self, me, foe, ctx, null)[0]; return x ? (x.attrs[v.cattr] ?? 0) * mul : 0; }
    if (v.agg) return resolveCards(whole(v.of), self, me, foe, ctx, null).reduce((n, x) => n + (x.attrs[v.agg] ?? 0), 0) * mul;
    if (v.pattr) return getP(v.who === 'Opponent' ? foe : me, v.pattr) * mul;
    if (v.unk === 'AttributeChange') return Math.abs(ctx?.delta ?? 0);
    return null;
  }
  function prereqsHold(fx, self, me, foe, ctx) {
    for (const p of fx.pre ?? []) {
      if (p.k === 'count') { if (!(CMP[p.cmp] ?? CMP.GreaterThanOrEqual)(resolveCards(whole(p.of), self, me, foe, ctx, null).length, p.n)) return false; }
      else if (p.k === 'player') { const s = p.who === 'Opponent' ? foe : me; if (!(CMP[p.op] ?? CMP.GreaterThan)(getP(s, p.a), amount(p.v, self, s, other(s), ctx) ?? 0)) return false; }
    }
    return true;
  }

  // Auras are standing modifiers: rebuilt from each card's own values whenever something they depend on changed.
  function refreshAuras() {
    dirty = false;
    for (const s of sides) { Object.assign(s, s.basePlayer); for (const it of holders(s)) { it.attrs = { ...it.base }; it.tags = [...it.baseTags, ...(it.addedTags ?? [])]; } }
    for (const s of sides) for (const L of holders(s)) {
      if (L.dead) continue;
      const foe = other(s);
      for (const fx of L.fx) {
        if (fx.trig !== 'Aura' || (fx.pre && !prereqsHold(fx, L, s, foe, null))) continue;
        const v = amount(fx.val, L, s, foe, null);
        if (fx.act === 'CardModifyAttribute' && v != null && fx.attr) { for (const x of resolveCards(whole(fx.tgt), L, s, foe, null, fx.n)) modifyAttrs(x.attrs, fx.attr, fx.op, v); }
        else if (fx.act === 'PlayerModifyAttribute' && v != null && P[fx.attr]) { const who = fx.tgt?.mode === 'Opponent' ? foe : s; const k = P[fx.attr]; if (k in who.basePlayer) who[k] += fx.op === 'Subtract' ? -v : v; }
        else if (fx.act === 'CardAddTagsList') for (const x of resolveCards(whole(fx.tgt), L, s, foe, null, fx.n)) for (const t of fx.addTags ?? []) if (!x.tags.includes(t)) x.tags.push(t);
      }
    }
    for (const s of sides) for (const it of s.items) if (it.ammo != null && it.attrs.AmmoMax != null && it.ammoMaxSeen !== it.attrs.AmmoMax) { it.ammo += it.attrs.AmmoMax - (it.ammoMaxSeen ?? it.base.AmmoMax ?? it.attrs.AmmoMax); it.ammoMaxSeen = it.attrs.AmmoMax; }
  }

  function playerChanged(side, attr, change, delta) { if (listeners.has('OnPlayerAttributeChanged')) emit('OnPlayerAttributeChanged', null, null, { side, attr, change, delta }); }
  function hitPlayer(to, dmg, by) {
    if (!(dmg > 0)) return;
    if (to.dr > 0) dmg *= Math.max(0, 1 - to.dr / 100);
    const s = Math.min(to.shield, dmg); to.shield -= s; to.hp -= dmg - s; to.taken += dmg;
    if (by) by.out.damage += dmg;
    if (s > 0) playerChanged(to, 'Shield', 'Loss', s);
    if (dmg - s > 0) { playerChanged(to, 'Health', 'Loss', dmg - s); if (listeners.has('OnPlayerDamaged')) emit('OnPlayerDamaged', by, null, { side: to, delta: dmg - s }); }
  }
  function addRage(side, v) {
    if (!(v > 0) || side.enraged > 0) return;
    side.rage += v; playerChanged(side, 'Rage', 'Gain', v);
    if (side.rage >= side.rageMax) { side.rage = 0; side.enraged = side.enragedMs; dirty = true; emit('OnPlayerEnraged', null, null, { side }); }
  }

  function trigMatches(t, L, side, source, info, target) {
    if (t.trig === 'OnPlayerAttributeChanged') { if (t.pattr !== info.attr || (t.change && t.change !== info.change)) return false; }
    if (t.trig === 'OnCardAttributeChanged' && (t.pattr !== info.attr || (t.change && t.change !== info.change))) return false;
    if (info?.side && !source) { // a player event: whose player is it, relative to the listener
      const mine = info.side === side;
      return t.subj?.mode === 'Opponent' ? !mine : t.subj?.mode === 'Both' || /^All/.test(t.subj?.section ?? '') ? true : mine;
    }
    if (t.ttgt) { // "when this is hasted / slowed / ...": the effect must have landed on the right card
      if (!target) return false;
      if (t.ttgt.type === 'CardSelf' ? target !== L : !matches(target, t.ttgt)) return false;
    }
    const subj = t.subj;
    if (!subj) return !source || source.side === L.side;
    if (!source) return true;
    const same = source.side === L.side;
    let ok;
    if (subj.type === 'CardSelf') ok = source === L;
    else if (subj.type === 'CardPositional') ok = same && neighbours(L, side, subj.mode).includes(source);
    else if (/^Opponent/.test(subj.section ?? '') || subj.mode === 'Opponent') ok = !same;
    else if (/^All/.test(subj.section ?? '') || subj.mode === 'Both') ok = true;
    else ok = same;
    return ok && !(subj.excludeSelf && source === L) && matches(source, subj);
  }
  function emit(trig, source, target, info) {
    const ls = listeners.get(trig);
    if (!ls || depth > 5) return;
    depth++;
    for (const { L, side, fx, t } of ls.slice()) {
      if (L.dead && trig !== 'OnBeforeCardDestroyed' && trig !== 'OnCardDisabled') continue;
      if (trigMatches(t, L, side, source, info, target)) apply(fx, L, { source, target, delta: info?.delta });
    }
    depth--;
  }

  function fire(it, side) {
    if (listeners.has('OnBeforeItemUsed')) emit('OnBeforeItemUsed', it, null);
    it.uses++;
    if (it.firstAt == null) it.firstAt = now;
    const casts = Math.max(1, Math.round(it.attrs.Multicast ?? 1));
    for (let k = 0; k < casts; k++) {
      if (dummy && side === B) { hitPlayer(A, dummy.hit, it); continue; }
      const c = Math.min(100, Math.max(0, (it.attrs.CritChance ?? 0) + side.crit)) / 100;
      const crit = c > 0 && rand() < c;
      it.critNow = crit ? 2 : 1;
      for (const fx of it.fx) if (fx.trig === 'OnCardFired') apply(fx, it, { source: it });
      it.critNow = 1;
      if (crit) emit('OnCardCritted', it, null);
      emit('OnItemUsed', it, null); // every cast of a multicast item is its own "item used" (three casts charge a Dam three times)
    }
  }

  function status(x, kind, ms) {
    if (kind === 'Slow') ms *= Math.max(0, 1 - (x.attrs.PercentSlowReduction ?? 0) / 100);
    if (kind === 'Freeze') ms *= Math.max(0, 1 - (x.attrs.PercentFreezeReduction ?? 0) / 100);
    if ((kind === 'Slow' || kind === 'Freeze') && x.flying) ms /= 2;
    if (!(ms > 0)) return false;
    if (kind === 'Charge') { x.progress += ms; if (listeners.has('OnCardCharged')) emit('OnCardCharged', x, x); }
    else { x[STATUS[kind]] += ms; cardChanged(x, kind, 'Gain', ms); }
    return true;
  }
  function cardChanged(x, attr, change, delta) { if (listeners.has('OnCardAttributeChanged')) emit('OnCardAttributeChanged', x, x, { attr, change, delta }); }
  function setFlying(x, on) { if (x.flying === on) return; x.flying = on; dirty = true; emit(on ? 'OnCardStartedFlying' : 'OnCardStoppedFlying', x, x); cardChanged(x, 'Flying', on ? 'Gain' : 'Loss', 1); }
  function modify(x, attr, op, v) {
    if (STATUS[attr]) { const k = STATUS[attr]; x[k] = Math.max(0, op === 'Multiply' ? x[k] * v : op === 'Subtract' ? x[k] - v : op === 'Set' ? v : x[k] + v); return; }
    if (attr === 'Flying') { setFlying(x, (op === 'Subtract' ? 0 : v) > 0); return; }
    const before = x.base[attr] ?? 0;
    modifyAttrs(x.base, attr, op, v); modifyAttrs(x.attrs, attr, op, v);
    dirty = true;
    const d = (x.base[attr] ?? 0) - before;
    if (d) cardChanged(x, attr, d > 0 ? 'Gain' : 'Loss', Math.abs(d));
  }
  function destroy(x, by) {
    if (x.dead || (x.attrs.DestroyImmunity ?? 0) > 0) return false;
    emit('OnBeforeCardDestroyed', x, x);
    x.dead = true; dirty = true;
    emit('OnCardDisabled', x, x);
    return true;
  }
  function transform(x, ids) {
    const pool = (ids ?? []).map((id) => data.cards[id]).filter((c) => c?.type === 'Item');
    if (!pool.length || x.tier === 'Legendary') return;
    const c = pool[Math.floor(rand() * pool.length)];
    fill(x, c, c.tiers?.[x.tier] ? x.tier : c.startingTier, x.enchant && c.enchantments?.[x.enchant] ? x.enchant : null, null);
    x.addedTags = []; index(); dirty = true;
    emit('OnCardTransformed', x, x); emit('OnCardAfterTransform', x, x);
  }
  function enchant(x, list) {
    const can = (list ?? []).filter(([e]) => x.card.enchantments?.[e]);
    if (x.enchant || !can.length) return;
    let r = rand() * can.reduce((n, [, w]) => n + w, 0), pick = can[0][0];
    for (const [e, w] of can) { r -= w; if (r <= 0) { pick = e; break; } }
    const en = x.card.enchantments[pick];
    x.enchant = pick;
    for (const [k, v] of Object.entries(en.attrs ?? {})) x.base[k] = (x.base[k] ?? 0) + v;
    x.baseTags.push(...(en.hiddenTags ?? []));
    x.fx = [...x.fx, ...(en.fx ?? []).filter((f) => classify(f) === 'yes')];
    index(); dirty = true;
    emit('OnCardEnchanted', x, x);
  }

  function apply(fx, self, ctx) {
    const me = sideOf(self), foe = other(me);
    if (fx.pre && !prereqsHold(fx, self, me, foe, ctx)) return;
    if (fx.cost) { // e.g. spend Tempo
      const k = P[fx.cost.pattr]; const c = amount(fx.cost.val, self, me, foe, ctx) ?? 0;
      if (!k || me[k] < c) return;
      me[k] -= c; if (c) playerChanged(me, fx.cost.pattr, 'Loss', c);
    }
    const attr = PER[fx.act];
    if (attr) {
      const base = fx.val ? amount(fx.val, self, me, foe, ctx) : self.attrs[attr];
      if (!(base > 0)) return;
      const v = base * (self.critNow ?? 1);
      const mode = fx.tgt?.mode;
      const offensive = fx.act === 'PlayerDamage' || fx.act === 'PlayerBurnApply' || fx.act === 'PlayerPoisonApply';
      const whos = mode === 'Both' ? [me, foe] : [offensive ? (mode === 'Self' || fx.tgt?.type === 'PlayerAbsolute' ? me : foe) : (mode === 'Opponent' ? foe : me)];
      for (const who of whos) {
        if (fx.act === 'PlayerDamage') { hitPlayer(who, v, self); if (self.attrs.Lifesteal && who !== me) { me.hp = Math.min(me.max, me.hp + v); self.out.heal += v; } }
        else if (fx.act === 'PlayerShieldApply') { who.shield += v; self.out.shield += v; playerChanged(who, 'Shield', 'Gain', v); }
        else if (fx.act === 'PlayerHeal') {
          const room = who.max - who.hp;
          who.hp = Math.min(who.max, who.hp + v); who.burn *= 0.95; who.poison *= 0.95; self.out.heal += v; playerChanged(who, 'Health', 'Gain', Math.min(v, room));
          if (v > room && listeners.has('OnCardPerformedOverHeal')) emit('OnCardPerformedOverHeal', self, null, { delta: v - room });
        }
        else if (fx.act === 'PlayerBurnApply') { who.burn += v; who.burnBy.set(self, (who.burnBy.get(self) ?? 0) + v); self.out.burn += v; playerChanged(who, 'Burn', 'Gain', v); }
        else if (fx.act === 'PlayerPoisonApply') { who.poison += v; who.poisonBy.set(self, (who.poisonBy.get(self) ?? 0) + v); self.out.poison += v; playerChanged(who, 'Poison', 'Gain', v); }
        else if (fx.act === 'PlayerRegenApply') { who.regen += v; self.out.regen += v; }
      }
      emit(PERFORMED[fx.act], self, null, { delta: v });
      return;
    }
    const kind = TIMED[fx.act];
    if (kind) {
      const ms = (fx.val ? amount(fx.val, self, me, foe, ctx) : null) ?? self.attrs[`${kind}Amount`] ?? 0;
      if (!(ms > 0)) return;
      const all = ['CardPositional', 'CardSection', 'CardSelf', 'CardTriggerSource', 'CardTriggerTarget', 'CardXMost'].includes(fx.tgt?.type);
      const count = all ? null : fx.n ?? self.attrs[`${kind}Targets`] ?? 1;
      const targets = resolveCards(fx.tgt, self, me, foe, ctx, count).filter((x) => (x.attrs.CooldownMax ?? 0) > 0);
      for (const x of targets) if (status(x, kind, ms) && PERFORMED[fx.act]) emit(PERFORMED[fx.act], self, x, { delta: ms });
      return;
    }
    switch (fx.act) {
      case 'CardModifyAttribute': { const v = amount(fx.val, self, me, foe, ctx); if (v != null && fx.attr) for (const x of resolveCards(fx.tgt, self, me, foe, ctx, fx.n)) modify(x, fx.attr, fx.op, v); return; }
      case 'PlayerModifyAttribute': {
        const v = amount(fx.val, self, me, foe, ctx); const key = P[fx.attr];
        if (v == null || !key) return;
        const who = fx.tgt?.mode === 'Opponent' ? foe : me;
        const d = fx.op === 'Subtract' ? -v : fx.op === 'Multiply' ? who[key] * (v - 1) : v;
        if (key === 'rage') { addRage(who, d); return; }
        if (key in who.basePlayer) { who.basePlayer[key] += d; who[key] += d; if (fx.dur) timers.push({ at: now + fx.dur, fn: () => { who.basePlayer[key] -= d; dirty = true; } }); }
        else who[key] += d;
        if (key === 'max') who.hp = Math.min(who.max, who.hp + Math.max(0, d));
        playerChanged(who, fx.attr, d >= 0 ? 'Gain' : 'Loss', Math.abs(d));
        return;
      }
      case 'PlayerRageApply': addRage(fx.tgt?.mode === 'Opponent' ? foe : me, (fx.val ? amount(fx.val, self, me, foe, ctx) : null) ?? self.attrs.RageApplyAmount ?? 0); return;
      case 'PlayerTempoApply': { const who = fx.tgt?.mode === 'Opponent' ? foe : me; const v = (fx.val ? amount(fx.val, self, me, foe, ctx) : null) ?? self.attrs.TempoApplyAmount ?? 0; if (v) { who.tempo += v; playerChanged(who, 'Tempo', 'Gain', v); } return; }
      case 'PlayerBurnRemove': case 'PlayerPoisonRemove': {
        const who = fx.tgt?.mode === 'Opponent' ? foe : me; const key = fx.act === 'PlayerBurnRemove' ? 'burn' : 'poison';
        const v = (fx.val ? amount(fx.val, self, me, foe, ctx) : null) ?? self.attrs[key === 'burn' ? 'BurnRemoveAmount' : 'PoisonRemoveAmount'];
        who[key] = v == null ? 0 : Math.max(0, who[key] - v); return;
      }
      case 'PlayerReviveHeal': { const who = fx.tgt?.mode === 'Opponent' ? foe : me; const v = (fx.val ? amount(fx.val, self, me, foe, ctx) : null) || self.attrs.HealAmount || who.max; who.hp = Math.min(who.max, Math.max(who.hp, 0) + v); who.burn = 0; who.poison = 0; return; }
      case 'CardFlyingStart': case 'CardFlyingStop': case 'CardFlyingToggle':
        for (const x of resolveCards(fx.tgt, self, me, foe, ctx, fx.n ?? (fx.tgt?.type === 'CardRandom' ? self.attrs.FlyingTargets ?? 1 : null))) setFlying(x, fx.act === 'CardFlyingToggle' ? !x.flying : fx.act === 'CardFlyingStart');
        return;
      case 'CardReload': {
        for (const x of resolveCards(fx.tgt, self, me, foe, ctx, fx.n ?? (fx.tgt?.type === 'CardRandom' ? self.attrs.ReloadTargets ?? 1 : null)).filter((y) => y.ammo != null)) {
          x.ammo = Math.min(x.attrs.AmmoMax ?? x.ammo, x.ammo + (self.attrs.ReloadAmount ?? x.attrs.AmmoMax ?? 1)); emit(PERFORMED.CardReload, self, x);
        }
        return;
      }
      case 'CardDisable': case 'CardDestroy':
        for (const x of resolveCards(fx.tgt, self, me, foe, ctx, fx.n ?? self.attrs.DisableTargets ?? self.attrs.DestroyTargets ?? 1)) if (destroy(x, self)) emit(PERFORMED.CardDestroy, self, x);
        return;
      case 'CardRepair':
        for (const x of resolveCards(fx.tgt, self, me, foe, ctx, fx.n ?? 1, true)) { x.dead = false; dirty = true; emit('OnCardRepaired', x, x); }
        return;
      case 'CardForceUse':
        if (depth < 4) for (const x of resolveCards(fx.tgt, self, me, foe, ctx, fx.n ?? self.attrs.ForceUseTargets ?? null)) if ((x.attrs.CooldownMax ?? 0) > 0 && (x.ammo == null || x.ammo > 0)) { if (x.ammo != null) x.ammo -= 1; fire(x, sideOf(x)); }
        return;
      case 'CardAddTagsList': for (const x of resolveCards(fx.tgt, self, me, foe, ctx, fx.n)) { x.addedTags = [...(x.addedTags ?? []), ...(fx.addTags ?? [])]; dirty = true; } return;
      case 'CardAddTagsBySource': {
        const from = fx.src ? resolveCards(fx.src, self, me, foe, ctx, null) : ctx?.source ? [ctx.source] : [];
        for (const x of resolveCards(fx.tgt, self, me, foe, ctx, fx.n)) { x.addedTags = [...new Set([...(x.addedTags ?? []), ...from.flatMap((s) => s.card.tags ?? [])])]; dirty = true; }
        return;
      }
      case 'CardEnchant': case 'CardEnchantRandom': for (const x of resolveCards(fx.tgt, self, me, foe, ctx, fx.n ?? self.attrs.EnchantTargets ?? null)) enchant(x, fx.ench); return;
      case 'CardTransform': for (const x of resolveCards(fx.tgt, self, me, foe, ctx, fx.n ?? self.attrs.TransformTargets ?? 1)) transform(x, fx.into); return;
      case 'CardTransformDestroyed': for (const x of resolveCards(fx.tgt ?? { type: 'CardSelf' }, self, me, foe, ctx, fx.n ?? 1, true)) { transform(x, fx.into); x.dead = false; } return;
      case 'CardBeginSandstorm': if (stormAt == null || stormAt > now) stormAt = now; return;
      default:
    }
  }

  index();
  refreshAuras();
  emit('OnFightStarted', null, null);
  const storm = opts.sandstorm ?? data.gameMode?.sandstorm ?? {};
  if (!dummy) stormAt = (storm.CountdownStartTime ?? 20000) + (storm.CountdownDuration ?? 10000);
  const limit = (opts.seconds ?? 90) * 1000;
  let stormAcc = 0, stormDmg = storm.BaseDamage ?? 1, end = null;
  for (now = DT; now <= limit; now += DT) {
    if (dirty) refreshAuras();
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i].at <= now) { timers[i].fn(); timers.splice(i, 1); }
    for (const side of sides) {
      if (side.enraged > 0) { side.enraged -= DT; if (side.enraged <= 0) { dirty = true; emit('OnPlayerEnrageEnded', null, null, { side }); } }
      for (const it of side.items) {
        if (it.dead) continue;
        const cd = it.attrs.CooldownMax ?? 0;
        if (!(cd > 0)) continue;
        if (it.freeze > 0) { it.freeze -= DT; continue; }
        let rate = 1;
        if (it.haste > 0) { rate *= 2; it.haste -= DT; }
        if (it.slow > 0) { rate *= 0.5; it.slow -= DT; }
        it.progress += DT * rate;
        let guard = 0;
        while (!it.dead && it.progress >= (it.attrs.CooldownMax ?? cd) && guard++ < 4) {
          if (it.ammo != null && it.ammo <= 0) { it.progress = it.attrs.CooldownMax ?? cd; break; }
          it.progress -= it.attrs.CooldownMax ?? cd;
          if (it.ammo != null) it.ammo -= 1;
          fire(it, side);
        }
      }
    }
    if ((now / DT) % 5 === 0) for (const s of sides) if (s.burn > 0.01) {
      const d = s.shield > 0 ? s.burn / 2 : s.burn;
      const total = [...s.burnBy.values()].reduce((x, y) => x + y, 0) || 1;
      for (const [it, share] of s.burnBy) it.out.damage += (d * share) / total;
      hitPlayer(s, d, null);
      s.burn *= 0.97;
    }
    if ((now / DT) % 10 === 0) for (const s of sides) {
      if (s.poison > 0.01) { const total = [...s.poisonBy.values()].reduce((x, y) => x + y, 0) || 1; for (const [it, share] of s.poisonBy) it.out.damage += (s.poison * share) / total; s.hp -= s.poison; s.taken += s.poison; playerChanged(s, 'Health', 'Loss', s.poison); }
      if (s.regen > 0) s.hp = Math.min(s.max, s.hp + s.regen);
      s.tempo += 1;
      if (listeners.has('OnPlayerAttributeChanged')) playerChanged(s, 'Tempo', 'Gain', 1);
    }
    if (stormAt != null && now >= stormAt) {
      if (!stormOn) { stormOn = true; emit('OnSandstorm', null, null); }
      stormAcc += DT;
      if (stormAcc >= (storm.BaseTickRate ?? 250)) { stormAcc = 0; hitPlayer(A, stormDmg, null); if (!dummy) hitPlayer(B, stormDmg, null); stormDmg += storm.AdditiveScalar ?? 2; }
    }
    if (!dummy) {
      for (const s of sides) if (s.hp <= 0 && s.revives < 3) { s.revives++; emit('OnPlayerDied', null, null, { side: s }); }
      if (A.hp <= 0 || B.hp <= 0) { end = now; break; }
    }
  }
  const secs = (end ?? limit) / 1000;
  const sum = (side) => side.items.reduce((o, it) => { for (const k of Object.keys(o)) o[k] += it.out[k]; return o; }, { damage: 0, shield: 0, heal: 0, burn: 0, poison: 0, regen: 0 });
  return {
    seconds: secs, win: end != null ? B.hp <= 0 && A.hp > B.hp : A.hp / A.max >= B.hp / B.max,
    a: { hp: A.hp, taken: A.taken, out: sum(A), firstUse: Math.min(...A.items.map((it) => it.firstAt ?? Infinity)) / 1000, items: A.items.map((it) => ({ name: it.name, uses: it.uses, out: it.out })) },
    b: { hp: B.hp, taken: B.taken, out: sum(B), uses: B.items.reduce((n, it) => n + it.uses, 0), items: B.items.map((it) => ({ name: it.name, uses: it.uses, out: it.out })) },
  };
}

const VALUE = { damage: 1, shield: 0.85, heal: 0.7, denied: 0.85 };
export const ENGINE_HORIZON = 15;

/**
 * Points per second of a board against a reference enemy: damage dealt (burn and poison as they tick)
 * + defence, where defence = 0.85 x shield + 0.7 x heal + 0.85 x enemy output denied by slow/freeze/destroy,
 * counted only up to the reference enemy's output (defence beyond the damage coming in stops nothing).
 * The reference enemy is six items on a 5 s cooldown whose total output is refDps; callers pass the engine
 * strength of the day's typical monster. Averaged over three seeds because some targets and crits are random.
 */
export function boardValue(items, skills, data, opts = {}) {
  if (!items.length) return { value: 0, per: [], parts: { damage: 0, shield: 0, heal: 0, denied: 0 } };
  const refDps = opts.refDps ?? 15;
  const seconds = opts.seconds ?? ENGINE_HORIZON;
  const dummyItems = Array.from({ length: 6 }, () => ({ templateId: '__dummy', tier: 'Bronze' }));
  if (!data.cards.__dummy) Object.defineProperty(data.cards, '__dummy', { enumerable: false, value: { name: 'ref', type: 'Item', tags: [], hiddenTags: [], size: 'Small', startingTier: 'Bronze', fx: [], tiers: { Bronze: { attrs: { CooldownMax: 5000 } } } } });
  const hit = (refDps * 5) / 6;
  const full = 6 * Math.floor(seconds / 5);
  const acc = { damage: 0, shield: 0, heal: 0, denied: 0 };
  let first = 0;
  const per = items.map(() => ({ damage: 0, shield: 0, heal: 0, uses: 0 }));
  const seeds = opts.seeds ?? [1, 2, 3];
  for (const seed of seeds) {
    const r = runFight({ items, skills, health: opts.health ?? 1e9, gold: opts.gold, income: opts.income, level: opts.level, player: opts.player }, { items: dummyItems, skills: [], health: 1e9 }, data, { seconds, seed, dummy: { hit } });
    acc.damage += r.a.out.damage; acc.shield += r.a.out.shield; acc.heal += r.a.out.heal + r.a.out.regen * (seconds / 2);
    acc.denied += Math.max(0, full - r.b.uses) * hit;
    first += Number.isFinite(r.a.firstUse) ? r.a.firstUse : seconds;
    r.a.items.forEach((it, i) => { if (!per[i]) return; per[i].damage += it.out.damage; per[i].shield += it.out.shield; per[i].heal += it.out.heal; per[i].uses += it.uses; });
  }
  const k = seeds.length * seconds;
  const parts = { damage: acc.damage / k, shield: acc.shield / k, heal: acc.heal / k, denied: acc.denied / k };
  return {
    value: parts.damage * VALUE.damage + Math.min(parts.shield * VALUE.shield + parts.heal * VALUE.heal + parts.denied * VALUE.denied, refDps),
    parts,
    firstUse: Math.round((first / seeds.length) * 10) / 10, // seconds until the board's first item fires
    per: per.map((p, i) => ({ name: data.cards[items[i].templateId]?.name, damage: p.damage / k, shield: p.shield / k, heal: p.heal / k, uses: p.uses / seeds.length })),
  };
}
