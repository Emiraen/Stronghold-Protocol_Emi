// Presentation of the mode's two ordinary slots; morph equipment has its own slot.
export function zhajingOrdinaryEquipment(items, getItem) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter(item => {
    const rec = getItem(item.id);
    if (rec?.canGiveBond === true) return false;
    const group = Number(rec?.stackMax) > 0 ? (rec.stackGroup || item.id) : null;
    if (group && seen.has(group)) return false;
    if (group) seen.add(group);
    return true;
  });
}

export function zhajingNeedsEquipmentSlot(incoming, items, getItem) {
  if (incoming?.canGiveBond === true) return false;
  if (Number(incoming?.stackMax) > 0) {
    const group = incoming.stackGroup || incoming.id;
    if ((items || []).some(item => {
      const rec = getItem(item.id);
      return Number(rec?.stackMax) > 0 && (rec.stackGroup || item.id) === group;
    })) return false;
  }
  return zhajingOrdinaryEquipment(items, getItem).length >= 2;
}
