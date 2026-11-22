export const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Diamond', 'Legendary'];
export const SIZE_SLOTS = { Small: 1, Medium: 2, Large: 3 };
export const BOARD_SLOTS = 10;

export function nextTier(card, tier) {
  const have = TIER_ORDER.filter((t) => card?.tiers?.[t]);
  const i = have.indexOf(tier);
  return i >= 0 && i < have.length - 1 ? have[i + 1] : null;
}

export function tierOf(card, tier) {
  return card?.tiers?.[tier] ?? card?.tiers?.[card?.startingTier] ?? Object.values(card?.tiers ?? {})[0] ?? null;
}
