// A golden display record alone is not a recipe: some equipment deliberately never merges.
// Keep server consumption and the client's replacement decision on the same eligibility rules.
export function itemMergeRecipe(itemId, getItem, defaultCount = 2) {
  const rec = getItem?.(itemId);
  if (!rec || rec.isGolden || rec.itemType !== 'EQUIP' || !rec.mergeable) return null;
  const count = Number.isInteger(rec.upgradeNum) ? rec.upgradeNum : defaultCount;
  if (!(count > 1 && count < 100)) return null;
  const upgradeId = rec.upgradeChessId || rec.goldenId;
  if (!upgradeId || upgradeId === itemId || getItem(upgradeId)?.itemType !== 'EQUIP') return null;
  return { count, upgradeId };
}
