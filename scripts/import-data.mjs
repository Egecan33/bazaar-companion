// Builds data/cards.json from the game's own local database (GameData.db.zip in the install).
// Nothing is downloaded: every number the companion shows comes from this file.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GAME_APPS = [
  join(homedir(), 'Library/Application Support/Steam/steamapps/common/The Bazaar/TheBazaar.app'),
  join(homedir(), 'Library/Application Support/Tempo Launcher - Beta/The Bazaar game_64/buildarm64/TheBazaar_ARM64.app'),
];
export const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary'];

export function findGameApp() {
  return GAME_APPS.find((p) => existsSync(join(p, 'Contents/Resources/Data/StreamingAssets'))) ?? null;
}

// The game downloads its current item data to this cache at every start; the copy inside the
// install can be months older. Both are local files.
export const GAME_CACHE = join(homedir(), 'Library/Application Support/com.TempoStorm.TheBazaar/prod/cache');

/** ETag of the downloaded game data, used to notice a data update without a new game version. */
export function dataTag() {
  try { return JSON.parse(readFileSync(join(GAME_CACHE, 'manifest.json'), 'utf8')).Entries?.GameData?.ETag ?? null; } catch { return null; }
}

function openGameDb(app) {
  const sa = join(app, 'Contents/Resources/Data/StreamingAssets');
  const cached = join(GAME_CACHE, 'GameData.db.zip');
  if (!existsSync(cached) && existsSync(join(sa, 'GameData.db'))) return { path: join(sa, 'GameData.db'), cleanup: () => {} };
  const zip = existsSync(cached) ? cached : join(sa, 'GameData.db.zip');
  if (!existsSync(zip)) throw new Error(`GameData.db(.zip) not found in ${sa}`);
  const tmp = mkdtempSync(join(tmpdir(), 'bazaar-gamedata-'));
  execFileSync('/usr/bin/unzip', ['-o', '-q', zip, '-d', tmp]);
  return { path: join(tmp, 'GameData.db'), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

// Tiers only list the attributes that change; resolve them into full per-tier attribute sets.
function resolveTiers(card) {
  const out = {};
  let acc = {};
  let ids = { AbilityIds: [], AuraIds: [], TooltipIds: [] };
  for (const t of TIER_ORDER) {
    const tier = card.Tiers?.[t];
    if (!tier) continue;
    acc = { ...acc, ...(tier.Attributes ?? {}) };
    ids = {
      AbilityIds: tier.AbilityIds ?? ids.AbilityIds,
      AuraIds: tier.AuraIds ?? ids.AuraIds,
      TooltipIds: tier.TooltipIds ?? ids.TooltipIds,
    };
    out[t] = { attrs: acc, abilityIds: ids.AbilityIds, auraIds: ids.AuraIds, tooltipIds: ids.TooltipIds };
  }
  return out;
}

// --- Structured effects, for the board engine (src/engine.mjs) ---
function cond(c, out = { tags: [], notTags: [], attrs: [] }) {
  if (!c) return out;
  if (c.$type === 'TCardConditionalTag' || c.$type === 'TCardConditionalHiddenTag') (/None|Not/.test(c.Operator ?? '') ? out.notTags : out.tags).push(...(c.Tags ?? []));
  else if (Array.isArray(c.Conditions)) for (const x of c.Conditions) cond(x, out);
  else if (c.$type === 'TCardConditionalAttribute') out.attrs.push({ a: c.Attribute, op: c.ComparisonOperator ?? 'GreaterThan', v: fixed(c.ComparisonValue) ?? 0 });
  else if (c.$type === 'TCardConditionalSize') out.sizes = c.Sizes ?? [];
  else if (c.$type === 'TCardConditionalHasEnchantment') out.ench = !c.IsNot;
  else out.other = true;
  return out;
}
function tgt(t) {
  if (!t) return null;
  return { type: (t.$type ?? '').replace('TTarget', ''), mode: t.TargetMode ?? null, section: t.TargetSection ?? null, excludeSelf: t.ExcludeSelf ?? false, includeOrigin: t.IncludeOrigin ?? false, ...cond(t.Conditions) };
}
function val(v) {
  if (!v) return null;
  if (v.$type === 'TFixedValue') return { v: v.Value };
  const mul = v.Modifier?.ModifyMode === 'Multiply' ? fixed(v.Modifier.Value) ?? 1 : 1;
  const kind = (v.$type ?? '').replace('TReferenceValue', '');
  if (/^CardAttribute(Unscaled)?$/.test(kind)) return /Self/.test(v.Target?.$type ?? '') ? { ref: v.AttributeType, mul } : { cattr: v.AttributeType, of: tgt(v.Target), mul };
  if (/^CardAttributeAggregate/.test(kind)) return { agg: v.AttributeType, of: tgt(v.Target), mul };
  if (/^PlayerAttribute/.test(kind)) return { pattr: v.AttributeType, who: v.Target?.TargetMode ?? 'Self', mul };
  if (/Count/.test(kind)) return { count: tgt(v.Target), mul };
  return { unk: kind };
}
/** Conditions an ability needs before it runs. "run" ones depend on the current encounter, not on the fight. */
function prereqs(list) {
  if (!list) return undefined;
  return (Array.isArray(list) ? list : [list]).map((p) => {
    const k = (p.$type ?? '').replace('TPrerequisite', '');
    if (k === 'CardCount') return { k: 'count', of: tgt(p.Subject), cmp: p.Comparison ?? 'GreaterThanOrEqual', n: p.Amount ?? 1 };
    if (k === 'Run') return { k: 'run' };
    if (k === 'Player') {
      const c = p.Subject?.Conditions;
      if (c?.$type === 'TPlayerConditionalAttribute') return { k: 'player', who: p.Subject?.TargetMode ?? 'Self', a: c.Attribute, op: c.ComparisonOperator, v: val(c.ComparisonValue) };
    }
    return { k: 'other' };
  });
}

/** One ability or aura as flat effects (an "And" action becomes several; an "Or" trigger keeps its alternatives). */
function effects(a) {
  const tr = a.Trigger;
  const name = (t) => (t?.$type ?? 'Aura').replace('TTrigger', '');
  const base = {
    id: a.Id, trig: name(tr), subj: tgt(tr?.Subject), ttgt: tgt(tr?.Target) ?? undefined, // ttgt: which card the triggering effect must have landed on
    any: Array.isArray(tr?.Triggers) ? tr.Triggers.map((t) => ({ trig: name(t), subj: tgt(t.Subject), ttgt: tgt(t.Target) ?? undefined, pattr: t.AttributeType ?? t.AttributeChanged ?? null, change: t.ChangeType ?? null })) : null,
    pattr: tr?.AttributeType ?? tr?.AttributeChanged ?? null, change: tr?.ChangeType ?? null, pre: prereqs(a.Prerequisites),
  };
  const acts = a.Action?.$type === 'TActionAnd' ? a.Action.Actions ?? [] : [a.Action];
  return acts.filter(Boolean).map((ac) => ({ ...base, act: (ac.$type ?? '').replace(/^TAuraAction|^TAction/, ''), tgt: tgt(ac.Target), attr: ac.AttributeType ?? null, op: ac.Operation ?? null, val: val(ac.Value), n: fixed(ac.TargetCount),
    dur: ac.Duration?.DurationInMs ?? undefined, // only timed effects carry a length; the rest last the fight
    addTags: ac.Tags ?? undefined, src: tgt(ac.Source) ?? undefined,
    ench: ac.Enchantment ? [[ac.Enchantment, 1]] : ac.Enchantments ? ac.Enchantments.map((e) => [e.Enchantment, e.Weight ?? 1]) : undefined,
    into: /Transform/.test(ac.$type ?? '') ? [...new Set(JSON.stringify(ac.SpawnContext ?? {}).match(UUID) ?? [])] : undefined,
    cost: ac.Cost ? { pattr: ac.Cost.PlayerAttributeType, val: val(ac.Cost.Value) } : undefined }));
}

function slimAbility(a) {
  return {
    id: a.Id,
    trigger: a.Trigger?.$type ?? null,
    action: a.Action?.$type ?? null,
    activeIn: a.ActiveIn ?? null,
    targetMode: a.Action?.Target?.TargetMode ?? null,
    targetSection: a.Action?.Target?.TargetSection ?? null,
    attribute: a.Action?.AttributeType ?? null,
    operation: a.Action?.Operation ?? null,
  };
}

function slimEnchant(e) {
  return {
    attrs: e.Attributes ?? {},
    abilities: Object.values(e.Abilities ?? {}).map(slimAbility),
    auras: Object.values(e.Auras ?? {}).map(slimAbility),
    hiddenTags: e.HiddenTags ?? [],
    fx: [...Object.values(e.Abilities ?? {}).flatMap(effects), ...Object.values(e.Auras ?? {}).flatMap(effects)],
    tooltips: (e.Localization?.Tooltips ?? []).map((t) => t.Content?.Text).filter(Boolean),
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const fixed = (v) => (v?.$type === 'TFixedValue' ? v.Value : null);
// For items the amount usually lives in a per-tier attribute of the item itself (Custom_0, ...).
const selfRef = (v) => (v?.$type === 'TReferenceValueCardAttribute' && /Self/.test(v.Target?.$type ?? '') ? v.AttributeType : null);

/** What selecting an encounter step gives, read from its ability actions. */
function grantsOf(action, idx) {
  if (!action) return [];
  const t = action.$type;
  if (t === 'TActionAnd') return (action.Actions ?? []).flatMap((a) => grantsOf(a, idx));
  if (t === 'TActionPlayerModifyAttribute') return [{ k: 'player', idx, attr: action.AttributeType, op: action.Operation, value: fixed(action.Value), ref: selfRef(action.Value) }];
  if (t === 'TActionCardModifyAttribute') {
    const tags = JSON.stringify(action.Target?.Conditions ?? {}).match(/"Tags":\[([^\]]*)\]/);
    return [{ k: 'cards', idx, attr: action.AttributeType, op: action.Operation, value: fixed(action.Value), ref: selfRef(action.Value), tags: tags ? JSON.parse(`[${tags[1]}]`) : [], section: action.Target?.TargetSection ?? null, mode: action.Target?.TargetMode ?? null }];
  }
  if (t === 'TActionGameSpawnCards') return [{ k: 'spawn', idx, ids: [...new Set(JSON.stringify(action.SpawnContext ?? {}).match(UUID) ?? [])], count: fixed(action.SpawnContext?.Limit) }];
  if (t === 'TActionCardUpgrade') return [{ k: 'upgrade', idx, count: fixed(action.TargetCount) }];
  if (t === 'TActionCardEnchant' || t === 'TActionCardEnchantRandom') return [{ k: 'enchant', idx, enchant: action.Enchantment ?? null }];
  if (t === 'TActionGameDealCards') return [];
  return [{ k: 'other', idx, type: t }];
}

function slimCard(c) {
  const base = {
    id: c.Id,
    type: c.Type,
    name: c.Localization?.Title?.Text || c.InternalName,
    internalName: c.InternalName,
    size: c.Size,
    heroes: c.Heroes ?? [],
    tags: c.Tags ?? [],
    hiddenTags: c.HiddenTags ?? [],
    startingTier: c.StartingTier,
    artKey: c.ArtKey ?? null,
    description: c.Localization?.Description?.Text ?? null,
    tooltips: (c.Localization?.Tooltips ?? []).map((t) => ({ text: t.Content?.Text ?? '', type: t.TooltipType })),
  };
  if (c.Type === 'Item' || c.Type === 'Skill') {
    base.tiers = resolveTiers(c);
    base.abilities = Object.values(c.Abilities ?? {}).map(slimAbility);
    base.auras = Object.values(c.Auras ?? {}).map(slimAbility);
    base.fx = [...Object.values(c.Abilities ?? {}).flatMap(effects), ...Object.values(c.Auras ?? {}).flatMap(effects)];
  }
  if (c.Type === 'PlayerEffect') base.fx = [...Object.values(c.Abilities ?? {}).flatMap(effects), ...Object.values(c.Auras ?? {}).flatMap(effects)]; // base rules such as what Enraged does
  if (c.Type === 'Item') {
    const sold = Object.values(c.Abilities ?? {}).filter((a) => /OnCardSold|OnItemSold/.test(a.Trigger?.$type ?? '') && /Self|null/.test(String(a.Trigger?.Subject?.$type ?? 'null')));
    if (sold.length) base.onSell = sold.flatMap((a) => grantsOf(a.Action, Number(a.Id)));
    base.enchantments = Object.fromEntries(
      Object.entries(c.Enchantments ?? {}).map(([k, v]) => [k, slimEnchant(v)]),
    );
  }
  if (c.Type === 'CombatEncounter') {
    base.combat = {
      monsterId: c.CombatantType?.MonsterTemplateId ?? null,
      level: c.CombatantType?.Level ?? null,
      gold: c.RewardCombatGold ?? 0,
      xp: c.RewardCombatXp ?? 0,
    };
  }
  if (c.Type === 'PedestalEncounter') {
    const flat = JSON.stringify(c.SelectionCriteria ?? {});
    const m = flat.match(/"Enchantment":"(\w+)"/);
    base.enchant = m ? m[1] : null;
    base.pedestal = /Upgrade/i.test(JSON.stringify(c.Abilities ?? {})) ? 'upgrade' : m ? 'enchant' : 'other';
  }
  if (c.Type === 'EventEncounter' || c.Type === 'EncounterStep') {
    base.xpOnSelect = c.ExperienceAwardUponSelection ?? 0;
    // Cards this encounter can put in front of the player (steps, items, ...), by id.
    // What a merchant draws from, as far as the data states it by tag / size / explicit ids.
    const spawn = JSON.stringify(c.SelectionContext?.SpawnContext ?? {});
    const lists = (re) => [...new Set([...spawn.matchAll(re)].flatMap((m) => JSON.parse(`[${m[1]}]`)))];
    base.sells = {
      tags: lists(/"\$type":"Constraint(?:Hidden)?Tag","(?:Hidden)?Tags":\[([^\]]*)\],"IsNot":false/g),
      notTags: lists(/"\$type":"Constraint(?:Hidden)?Tag","(?:Hidden)?Tags":\[([^\]]*)\],"IsNot":true/g),
      types: lists(/"\$type":"ConstraintCardType","Types":\[([^\]]*)\],"IsNot":false/g),
      tiers: lists(/"\$type":"(?:ConstraintTier|TSpawnBehaviorTier)","Tiers":\[([^\]]*)\],"IsNot":false/g),
      sizes: lists(/"\$type":"ConstraintSize","Sizes":\[([^\]]*)\],"IsNot":false/g),
    };
    // ...either listed directly, or dealt by the encounter's own abilities when it opens.
    const dealt = Object.values(c.Abilities ?? {}).filter((a) => /DealCards|SpawnCards/.test(a.Action?.$type ?? '')).flatMap((a) => JSON.stringify(a.Action).match(UUID) ?? []);
    base.choices = [...new Set([...(JSON.stringify(c.SelectionContext?.SpawnContext ?? {}).match(UUID) ?? []), ...dealt])].filter((id) => id !== c.Id);
    // Steps give things when chosen; many events give things directly when entered.
    base.grants = Object.entries(c.Abilities ?? {}).flatMap(([i, a]) => grantsOf(a.Action, Number(i)));
    const rules = c.SelectionContext?.Rules;
    base.free = rules?.SelectionIsFree ?? null;
    if (rules) {
      const rr = rules.RerollRules;
      base.shop = {
        offers: c.SelectionContext?.SpawnContext?.Limit?.Value ?? null,
        free: rules.SelectionIsFree ?? false,
        multiple: rules.CanSelectMultiple ?? false,
        rerollCost: rr ? rr.StartingCost : null,
        rerollCostIncrease: rr ? rr.CostIncrease : 0,
        rerollsAllowed: rr ? rr.TotalAllowedRerolls : 0,
      };
    }
  }
  return base;
}

export function buildData(app) {
  const { path, cleanup } = openGameDb(app);
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = (t) => db.prepare(`select Id, Data from ${t}`).all();
    const parse = (r) => JSON.parse(Buffer.from(r.Data).toString('utf8'));
    const cards = {};
    for (const r of rows('cards')) {
      const c = slimCard(parse(r));
      cards[c.id] = c;
    }
    const monsters = {};
    for (const r of rows('monsters')) {
      const m = parse(r);
      monsters[m.Id] = {
        id: m.Id,
        name: m.InternalName,
        health: m.Player?.Attributes?.HealthMax ?? null,
        level: m.Player?.Attributes?.Level ?? null,
        // Left to right as the monster holds them; a few items carry their own attribute values.
        items: (m.Player?.Hand?.Items ?? []).slice().sort((x, y) => Number(String(x.SocketId ?? '').replace(/\D/g, '')) - Number(String(y.SocketId ?? '').replace(/\D/g, '')))
          .map((i) => ({ templateId: i.TemplateId, tier: i.Tier, enchant: i.EnchantmentType, ...(i.Attributes && Object.keys(i.Attributes).length ? { attrs: i.Attributes } : {}) })),
        player: { rageMax: m.Player?.Attributes?.RageMax ?? null, enragedMs: m.Player?.Attributes?.EnragedDurationMax ?? null, regen: m.Player?.Attributes?.HealthRegen ?? 0, tempo: m.Player?.Attributes?.Tempo ?? 0, income: m.Player?.Attributes?.Income ?? 0 },
        skills: (m.Player?.Skills ?? []).map((i) => ({ templateId: i.TemplateId, tier: i.Tier })),
      };
    }
    const gm = rows('game_modes').map(parse)[0] ?? {};
    const levelUps = rows('level_ups').map(parse).map((l) => ({ level: l.Level, health: l.HealthIncrease }));
    db.close();
    let version = null;
    try {
      version = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')])
        .toString()
        .trim();
    } catch {}
    return {
      source: { app, gameVersion: version, dataTag: dataTag(), importedAt: new Date().toISOString() },
      gameMode: {
        hoursInDay: gm.HoursInADay ?? 6,
        days: gm.NumberOfDays ?? null,
        victoriesToWin: gm.VictoriesToWin ?? 10,
        prestige: gm.Prestige?.PrestigeInitial ?? 20,
        tierByDay: gm.ItemSkillSpawnTierPercantagesByDay ?? {}, // chance of each tier in shops, per day
        sandstorm: gm.Sandstorm ?? {},
        burnDecayPct: gm.BurnDecrementByAsPercentage ?? null,
        xpPerLevel: gm.ExperiencePerLevel ?? null,
        buyPrices: gm.StandardPrices?.ItemBuyPrices ?? {},
        sellPrices: gm.StandardPrices?.ItemSellPrices ?? {},
      },
      levelUps,
      monsters,
      cards,
    };
  } finally {
    cleanup();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = process.argv[2] ?? findGameApp();
  if (!app) {
    console.error('The Bazaar install not found. Pass the path to TheBazaar.app as an argument.');
    process.exit(1);
  }
  const data = buildData(app);
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'cards.json'), JSON.stringify(data));
  const by = {};
  for (const c of Object.values(data.cards)) by[c.type] = (by[c.type] ?? 0) + 1;
  console.log(`data/cards.json written from ${data.source.gameVersion}:`, by, `monsters: ${Object.keys(data.monsters).length}`);
}

export function loadData() {
  const p = join(ROOT, 'data', 'cards.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}
