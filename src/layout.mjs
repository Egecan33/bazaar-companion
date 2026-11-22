// Board placement: which items should sit next to which.
// Basis: the game's own item data. An item has a positional rule when one of its abilities targets
// Neighbor / LeftCard / RightCard / ...MostCard, or when its tooltip says "adjacent ...", "to the left",
// "to the right". The tag words after "adjacent" (e.g. "adjacent Aquatic item") restrict which neighbour counts.
// Score of an order = number of satisfied links (+0.25 when the neighbour has a cooldown, since most
// positional effects speed up or trigger off an item that fires). Assumption: items are packed side by side.

const BUFFS_COOLDOWN = /Haste|Charge|Reload|Multicast|Crit/;

function tagsIn(phrase, allTags) {
  const words = phrase.toLowerCase().split(/[^a-z]+/);
  return allTags.filter((t) => words.includes(t.toLowerCase()) || words.includes(t.toLowerCase() + 's'));
}

/** Positional rules of one card: [{ side: 'both'|'left'|'right'|'leftmost'|'rightmost', tags: [], text }] */
export function positionalRules(card, allTags) {
  const rules = [];
  for (const t of card.tooltips ?? []) {
    const text = t.text ?? '';
    const low = text.toLowerCase();
    const adj = low.indexOf('adjacent');
    if (adj >= 0) {
      const after = low.slice(adj + 8).split(/\bitems?\b|,|\./)[0].slice(0, 40);
      rules.push({ side: 'both', tags: tagsIn(after, allTags), text });
    } else if (/to the left|left of this/.test(low)) rules.push({ side: 'left', tags: [], text });
    else if (/to the right|right of this/.test(low)) rules.push({ side: 'right', tags: [], text });
    else if (/leftmost/.test(low)) rules.push({ side: 'leftmost', tags: [], text });
    else if (/rightmost/.test(low)) rules.push({ side: 'rightmost', tags: [], text });
  }
  if (!rules.length) {
    const MODE = { Neighbor: 'both', LeftCard: 'left', RightCard: 'right', AllLeftCards: 'left', AllRightCards: 'right', LeftMostCard: 'leftmost', RightMostCard: 'rightmost' };
    for (const a of card.abilities ?? []) {
      const side = MODE[a.targetMode] ?? (a.targetSection === 'SelfNeighbors' ? 'both' : null);
      if (side && !rules.some((r) => r.side === side)) rules.push({ side, tags: [], text: card.tooltips?.[0]?.text ?? '' });
    }
  }
  return rules;
}

function matches(rule, other) {
  if (!other) return 0;
  if (rule.tags.length && !rule.tags.some((t) => other.tags.includes(t))) return 0;
  return 1 + (other.cooldown ? 0.25 : 0);
}

function linksOf(order) {
  const links = [];
  order.forEach((it, i) => {
    for (const rule of it.rules) {
      const targets = rule.side === 'both' ? [order[i - 1], order[i + 1]]
        : rule.side === 'left' ? [order[i - 1]]
        : rule.side === 'right' ? [order[i + 1]]
        : rule.side === 'leftmost' ? [i === 0 ? null : order[0]]
        : [i === order.length - 1 ? null : order[order.length - 1]];
      for (const o of targets) {
        const w = matches(rule, o);
        if (w) links.push({ from: it.name, to: o.name, w, tags: rule.tags, text: rule.text });
      }
    }
  });
  return links;
}

const scoreOf = (order) => linksOf(order).reduce((n, l) => n + l.w, 0);

function* permutations(arr, n = arr.length) {
  if (n <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < n; i++) {
    yield* permutations(arr, n - 1);
    const j = n % 2 ? 0 : i;
    [arr[n - 1], arr[j]] = [arr[j], arr[n - 1]];
  }
}

/** The adjacency links that hold in a given left-to-right order (for explaining a placement). */
export function describeLinks(items, data) {
  const allTags = data.tagNames ?? (data.tagNames = [...new Set(Object.values(data.cards).flatMap((c) => (c.type === 'Item' ? [...(c.tags ?? []), ...(c.hiddenTags ?? [])] : [])))]);
  const nodes = items.map((it) => { const c = data.cards[it.templateId]; return { name: c?.name ?? '?', tags: [...(c?.tags ?? []), ...(c?.hiddenTags ?? [])], cooldown: (c?.tiers?.[it.tier]?.attrs?.CooldownMax ?? 0) > 0, rules: c ? positionalRules(c, allTags) : [] }; });
  return linksOf(nodes).map(({ from, to, tags, text }) => ({ from, to, tags, text }));
}

/**
 * items: board items [{ instanceId, templateId, tier }] ; currentIds: instance ids left to right when the
 * screen showed them all, else null. Returns { order, score, currentScore, links, positional, changed }.
 */
export function bestLayout(items, data, currentIds = null) {
  const allTags = data.tagNames ?? (data.tagNames = [...new Set(Object.values(data.cards).flatMap((c) => (c.type === 'Item' ? [...(c.tags ?? []), ...(c.hiddenTags ?? [])] : [])))]);
  const nodes = items.map((it) => {
    const c = data.cards[it.templateId];
    return {
      instanceId: it.instanceId, templateId: it.templateId, tier: it.tier,
      name: c?.name ?? '?', size: c?.size ?? 'Small',
      tags: [...(c?.tags ?? []), ...(c?.hiddenTags ?? [])],
      cooldown: (c?.tiers?.[it.tier]?.attrs?.CooldownMax ?? 0) > 0,
      rules: c ? positionalRules(c, allTags) : [],
    };
  });
  const byId = new Map(nodes.map((n) => [n.instanceId, n]));
  const current = currentIds && currentIds.length === nodes.length && currentIds.every((id) => byId.has(id)) ? currentIds.map((id) => byId.get(id)) : null;
  const start = current ?? nodes;
  let best = start.slice();
  let bestScore = scoreOf(best);
  const currentScore = current ? bestScore : null;
  if (nodes.some((n) => n.rules.length) && nodes.length > 1) {
    if (nodes.length <= 8) {
      for (const p of permutations(start.slice())) {
        const s = scoreOf(p);
        if (s > bestScore + 1e-9) { best = p.slice(); bestScore = s; }
      }
    } else {
      let improved = true; // too many orders to try them all: swap pairs while it helps
      while (improved) {
        improved = false;
        for (let i = 0; i < best.length; i++) for (let j = i + 1; j < best.length; j++) {
          const p = best.slice(); [p[i], p[j]] = [p[j], p[i]];
          const s = scoreOf(p);
          if (s > bestScore + 1e-9) { best = p; bestScore = s; improved = true; }
        }
      }
    }
  }
  return {
    order: best.map(({ instanceId, templateId, tier, name, size }) => ({ instanceId, templateId, tier, name, size })),
    score: Math.round(bestScore * 100) / 100,
    currentScore: currentScore == null ? null : Math.round(currentScore * 100) / 100,
    changed: current ? best.some((n, i) => n !== current[i]) : null,
    positional: nodes.filter((n) => n.rules.length).length,
    links: linksOf(best).map(({ from, to, tags, text }) => ({ from, to, tags, text })),
  };
}
