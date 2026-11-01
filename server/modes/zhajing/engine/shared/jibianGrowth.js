// 永久惊变增益保存在对应 EffectRef.params 中，战报只传本场新增值。
export const GROWTH_CARDS = ['jibian_chouminglu', 'jibian_xinzhigang'];

export function mergeGrowth(...values) {
  const out = { kills: 0, hp: {} };
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    if (Number.isFinite(value.kills) && value.kills > 0) out.kills += Math.floor(value.kills);
    for (const [uid, hp] of Object.entries(value.hp || {})) {
      if (/^\d+$/.test(uid) && Number.isFinite(hp) && hp > 0) out.hp[uid] = (out.hp[uid] || 0) + hp;
    }
  }
  return out;
}

export function carryGrowth(refs, byCard) {
  return (refs || []).map(ref => {
    const id = String(ref?.key || '').slice('jibian:'.length);
    if (!GROWTH_CARDS.includes(id) || !byCard?.[id]) return ref;
    return { ...ref, params: { ...ref.params, growth: mergeGrowth(ref.params?.growth, byCard[id]) } };
  });
}
