// Scene memory: what is on offer right now, kept exactly as long as the log says the scene lasts.
// The screen reader sees a different part of the scene in every frame (a tooltip covers tiles, the cursor
// enlarges one, the stash slides over the shop). Everything recognised is remembered per screen slot and thrown
// away when the log shows the scene is over:
//   "State changed"            -> everything of the scene (options, offers, skills, hover texts)
//   SelectEncounterCommand     -> the path options
//   RerollCommand              -> the shop offers
//   "Card Purchased"           -> that one offer
//   "Starting new run"         -> everything, including what was learnt about the player's items
// Hover tooltips are read as text and matched to card names from the game data, which settles what a tile is
// when several cards share a picture, gives a monster's level, an event choice's real numbers, and an owned
// item's tier (from "Sells for N") and enchantment (from the name prefix).

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const TYPES = new Set(['Item', 'Skill', 'CombatEncounter', 'EventEncounter', 'PedestalEncounter', 'EncounterStep']);

function lev1(a, b) { // true when the strings differ by at most one edit
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function createScene(data) {
  const byName = new Map();
  for (const c of Object.values(data.cards)) {
    if (!TYPES.has(c.type) || !c.name || /^\[|DEBUG|TEMPLATE/i.test(c.internalName ?? '')) continue;
    const k = norm(c.name);
    if (k.length < 3) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  const names = [...byName.keys()];
  const enchants = new Set(Object.values(data.cards).flatMap((c) => Object.keys(c.enchantments ?? {})));

  const s = { options: new Map(), offers: new Map(), skills: new Map(), hovered: new Map(), facts: new Map() };
  const clearScene = () => { s.options.clear(); s.offers.clear(); s.skills.clear(); s.hovered.clear(); };

  /** Find the card name a tooltip is about: the first of its lines that is (almost) a card name. */
  function identify(text) {
    const lines = text.split('\n').map((l) => l.replace(/[|_~—–<>()[\]{}*]/g, ' ').trim()).filter((l) => l.length >= 3);
    for (let i = 0; i < Math.min(lines.length, 4); i++) {
      const m = /^(.*?)[\s:.-]*(\d{1,2})?\s*$/.exec(lines[i]);
      let words = norm(m[1]).split(' ').filter(Boolean);
      const level = m[2] ? Number(m[2]) : null;
      // OCR leaves a stray token at either end ("pb Wandering Shoal C10"): try the line and its inner parts.
      const tries = [words, words.slice(1), words.slice(0, -1), words.slice(1, -1)].filter((w) => w.length);
      let enchant = null;
      if (words.length > 1) { const e = [...enchants].find((x) => x.toLowerCase() === words[0]); if (e) { enchant = e; tries.unshift(words.slice(1)); } }
      for (const w of tries) {
        const key = w.join(' ');
        let cards = byName.get(key);
        if (!cards && key.length >= 6) { const near = names.find((n) => n[0] === key[0] && lev1(n, key)); if (near) cards = byName.get(near); }
        if (cards) return { cards, level, enchant: enchant && w === tries[0] ? enchant : null, rest: lines.slice(i + 1).join(' ').replace(/\s+/g, ' ').trim() };
      }
    }
    return null;
  }

  return {
    onLine(line) {
      if (/type=RerollCommand/.test(line)) s.offers.clear();
      if (/type=SelectEncounterCommand/.test(line)) { s.options.clear(); s.hovered.clear(); }
    },
    onEvent(e) {
      if (e.type === 'state') clearScene();
      else if (e.type === 'runStart') { clearScene(); s.facts.clear(); }
      else if (e.type === 'purchase') for (const [k, d] of s.offers) if ((d.cardIds ?? []).includes(e.templateId)) { s.offers.delete(k); break; }
    },
    /** Merge one recognised frame into the scene. phase is the log's current state. */
    onFrame(m, phase) {
      const fight = /Combat|Replay/.test(phase ?? '');
      const choosing = phase === 'ChoiceState' || phase === 'LevelUpState';
      for (const d of m.detections ?? []) {
        if (fight) break;
        if (choosing && (d.kind === 'encounters' || d.kind === 'monsters') && d.cy > 0.24 && d.cy < 0.5) {
          const key = Math.round(d.cx * 14);
          const old = s.options.get(key);
          s.options.set(key, old?.pinned && (old.cardIds ?? []).some((id) => (d.cardIds ?? []).includes(id)) ? { ...d, cardIds: old.cardIds, pinned: true } : d);
        } else if (d.kind === 'items' && d.cy > 0.28 && d.cy < 0.55 && phase !== 'ChoiceState') s.offers.set(Math.round(d.cx * 30), d);
        else if (d.kind === 'skills' && d.cy > 0.28 && d.cy < 0.55 && !/_MON_/.test(d.art ?? '')) s.skills.set(Math.round(d.cx * 30), d);
      }
      for (const h of m.hover ?? []) {
        const hit = identify(h.text ?? '');
        if (!hit) continue;
        const c0 = hit.cards[0];
        const sell = /Sells?\s*for\D{0,6}(\d+)/i.exec(h.text);
        // Several cards can share a name ("Pile of Gold" for 4, 6, 8 gold): prefer the one whose numbers appear in the text.
        const nums = new Set((h.text.match(/\d+/g) ?? []).map(Number));
        const ranked = hit.cards.slice().sort((x, y) => { const f = (c) => (c.grants ?? []).filter((g) => g.value != null && nums.has(g.value)).length; return f(y) - f(x); });
        const entry = { name: c0.name, type: c0.type, ids: ranked.map((c) => c.id), text: hit.rest, level: hit.level, at: Date.now() };
        s.hovered.set(c0.name, entry);
        if (c0.type === 'Item') {
          // An owned item's tooltip states its sell price; with its size that fixes the tier.
          const prices = data.gameMode?.sellPrices?.[c0.size] ?? {};
          // Items whose value grows (Lockbox, Cove, ...) do not sell for their tier's price: for those the price read
          // is kept as the item's value, which their effects scale with, and says nothing about the tier.
          const grows = (c0.tooltips ?? []).some((t) => /value/i.test(t.text ?? ''));
          const tier = sell && !grows ? Object.keys(prices).find((t) => prices[t] === Number(sell[1])) : null;
          if (tier || hit.enchant || (sell && grows)) s.facts.set(c0.id, { ...(s.facts.get(c0.id) ?? {}), ...(tier ? { tier } : {}), ...(hit.enchant ? { enchant: hit.enchant } : {}), ...(sell && grows ? { value: Number(sell[1]) } : {}) });
        } else if (choosing && c0.type !== 'Skill' && c0.type !== 'EncounterStep') {
          let ids = hit.cards.map((c) => c.id);
          if (hit.level != null) { const exact = hit.cards.filter((c) => c.combat?.level === hit.level).map((c) => c.id); if (exact.length) ids = exact; }
          let pinned = false;
          for (const [k, d] of s.options) if ((d.cardIds ?? []).some((id) => ids.includes(id))) { s.options.set(k, { ...d, cardIds: (d.cardIds ?? []).filter((id) => ids.includes(id)), pinned: true }); pinned = true; }
          // A tile the picture matcher did not know: the tooltip alone is enough to list it.
          if (!pinned) s.options.set(`h:${c0.name}`, { kind: c0.type === 'CombatEncounter' ? 'monsters' : 'encounters', art: null, cardIds: ids, cx: h.x, cy: 0.3, inliers: 0, pinned: true });
        }
      }
    },
    /** Everything remembered, shaped like screen detections so the view reads it like a frame. */
    detections() {
      const fix = (d, cy) => ({ ...d, cy: d.cy ?? cy });
      return [...[...s.options.values()].map((d) => fix(d, 0.3)), ...[...s.offers.values()].map((d) => fix(d, 0.4)), ...[...s.skills.values()].map((d) => fix(d, 0.4))];
    },
    hovered() { return [...s.hovered.values()]; },
    facts() { return Object.fromEntries(s.facts); },
    _state: s, identify,
  };
}
