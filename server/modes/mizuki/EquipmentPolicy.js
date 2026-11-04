// Mizuki has recruitment tickets instead of Stronghold's operator shop.
// Disable equipment that refreshes that shop or creates/replaces operators;
// progression of existing operators and the mode's own tickets stay available.
const disabledBuffs = new Set([
  'use_equip_reward_random_char_chess_in_shop',
  'use_equip_reward_special_goods_char_chess',
  'use_equip_recruit_new_char_and_give_char_to_player_most_bond',
  'use_equip_reward_char_chess_with_same_bond',
  'use_equip_reward_char_chess',
  'sell_char_count_gain_equip_owner_bond',
  'char_chess_transformation_equip',
  'trap_copy_front_char',
]);

export function mizukiEquipmentAvailable(gd, id) {
  const record = gd?.item?.(id);
  return !!record && !(record.buffs || []).some(buff => disabledBuffs.has(buff?.key));
}

// A consumed beacon can already have left a delayed gift in an old checkpoint.
export function mizukiEquipmentEffectAvailable(ref) {
  return ref?.key !== 'effect:builtin_gift';
}

export function mizukiEquipmentSourceAvailable(gd, source) {
  if (source === 'effect:builtin_gift') return false;
  if (typeof source !== 'string' || !source.startsWith('item:')) return true;
  const id = source.slice(5);
  const record = gd?.item?.(id) || gd?.item?.(id + '_a') || gd?.item?.(id + '_b');
  return !record || mizukiEquipmentAvailable(gd, record.id || id);
}

export function mizukiEquipmentPool(gd) {
  const canGain = id => mizukiEquipmentAvailable(gd, id);
  return { canGain, pick(random, ids, weights) {
    const eligible = ids.filter(canGain);
    if (!eligible.length) return null;
    if (weights) return random.weighted(eligible, id => weights.get(id) || 0) || null;
    return typeof random.pick === 'function' ? random.pick(eligible) : eligible[Math.floor(random() * eligible.length)];
  } };
}

// Keep old inventory valid for recovery, but do not leave an unusable pending
// reward blocking ready. The original choice order and request IDs are retained.
export function mizukiEquipmentOffers(gd, offers = []) {
  return offers.flatMap(offer => {
    if (!mizukiEquipmentSourceAvailable(gd, offer.source)) return [];
    const choices = offer.kind === 'item' ? offer.choices.filter(id => mizukiEquipmentAvailable(gd, id)) : offer.choices;
    return choices.length ? [{ ...offer, choices }] : [];
  });
}
