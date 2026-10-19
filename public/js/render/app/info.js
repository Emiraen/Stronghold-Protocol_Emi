// 从 A 原正文按职责拆分；保持原有行为。
import { UnitView } from '../units.js';

export const FORCED_EXIT = 'forcedExit';

export const showsDeathFx = (info, consumed = false, reason = null) => !consumed && reason !== FORCED_EXIT && info?.kind !== 'device';

export function renderInfo(u) {
  if (!u || typeof u !== 'object' || (typeof u.id !== 'number' && typeof u.id !== 'string')) return null;
  return {
    id: u.id, uid: u.uid ?? null, kind: u.kind || 'enemy', side: u.side === 'ally' ? 'ally' : 'enemy', ownerId: u.ownerId ?? null,
    defId: u.defId ?? null, name: u.name ?? '', tier: u.tier ?? 1, golden: !!u.golden, spine: u.spine ?? u.defId ?? null,
    skin: u.skin ?? null,
    avatar: u.avatar ?? u.defId ?? null, x: Number(u.x) || 0, y: Number(u.y) || 0, facing: u.facing === -1 ? -1 : 1,
    maxHp: Number(u.maxHp) || 1, boss: !!u.boss, motion: u.motion,
    // deploy direction of allies (UnitInfo.dir, DESIGN §3): the model (Back for UP, mirrored for LEFT) and the
    // ground wedge follow it; absent = unknown (legacy frames) → derived from `facing`, no wedge
    dir: typeof u.dir === 'string' ? u.dir : undefined,
    // the unit's current model form (UnitInfo.form: an enemy's mode, a 傀儡师's 替身): the view starts in it (UnitView reads info.form)
    form: typeof u.form === 'string' ? u.form : undefined,
    // DESIGN §16 loadout of an ally (UnitInfo.skillIndex / moduleId): the Spine actor plays that skill's clip, and a
    // tap hands them to the detail card (a teammate's unit shows its owner's skill / module)
    skillIndex: Number.isInteger(u.skillIndex) ? u.skillIndex : undefined,
    standInFor: typeof u.standInFor === 'string' ? u.standInFor : undefined,
    diy: u.diy && typeof u.diy === 'object' && typeof u.diy.charId === 'string' ? { ...u.diy } : undefined,
    moduleId: typeof u.moduleId === 'string' ? u.moduleId : undefined,
  };
}
