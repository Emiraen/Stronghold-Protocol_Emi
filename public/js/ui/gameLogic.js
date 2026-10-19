// A 模块入口；保留原有公开导出。
import { isObj } from './gameLogic/shared.js';
import { t } from '../../../shared/i18n.js';
export { UF } from '../../../shared/constants.js';

export { clamp, tileKey, sortedPlayers, itemAttaches } from './gameLogic/shared.js';

export { phaseMode, isCombatPhase, showDeadPill, isBossPhase, phaseBanner, prepCapsuleLabel, countdownState, phaseTotalSeconds } from './gameLogic/phases.js';

export { prepCamera, prepCameraFor, foldCamera, deployFieldOf, fieldTile, boardTileOf } from './gameLogic/camera.js';

export { STATUS_META, snapHud, bossFrac, bossPctText, hasFlag, attackInterval, fmtNum, rangeGridBox } from './gameLogic/format.js';

export { ownFieldId, homeFieldId, cycleField, watchTarget, switcherLabel, fieldLabel, activeBubbles } from './gameLogic/watch.js';

export { sortBonds, bondTier, nextThreshold, grantedBonds, pieceBondIds, morphPairings, HARMONY_BOND, harmonyMembers, bondMembers, memberHeadCount, bannedPerBond, disabledBondSets, briefingBondTip, modeOffBonds, bandOffBonds, bandOffLine } from './gameLogic/bonds.js';

export { priceTone, mergeProgress, mergeTarget, handFull, completesMerge, offerHeader, shopBlockReason, readyFundsPrompt } from './gameLogic/shop.js';

export { deploySets, stageOverrides, deployMap, effectiveStage, indexPieces, placementContext, piecePosition, tileAllows, summonRange, canPlace, equipMerges, boardTargets, dropIntent, dropFailureReason } from './gameLogic/placement.js';

export { normalizeDraft, normalizeSp, normalizePersonalChoice, draftForPlayer, draftIntent } from './gameLogic/draft.js';

export { groupEnemies, PEN, penZoneTiles, penPlacement, previewEnemyKey, factionTypes } from './gameLogic/enemies.js';

export { shortcutFor, closesOnFieldPress, shortcutBlocked } from './gameLogic/shortcuts.js';

export { DEFAULT_SETTINGS, sanitizeSettings } from './gameLogic/settings.js';

export { normalizeResult } from './gameLogic/result.js';

export { chessLoadout, unitLoadout, unitCultivation } from './gameLogic/loadout.js';

export { panelSide, panelSlots, PANEL_RIGHT_GAP, PANEL_RIGHT_BOTTOM, PANEL_RIGHT_BOTTOM_SHOP, BPOP, bondPopupPlace } from './gameLogic/panel.js';

export * from './gameLogic/standIn.js';
export * from './gameLogic/diy.js';
export { HOTKEY_ACTIONS, DEFAULT_HOTKEYS, hotkeyLabel, rebindHotkey, isDefaultHotkeys, captureHotkey, sanitizeHotkeys } from './gameLogic/shortcuts.js';

export { actionForKey, hotkeyOf, isBindableCode, facingSwallows, facingEnter } from './gameLogic/shortcuts.js';

const DEVICE_ROLES = ['crate', 'turret', 'platform', 'blower'];
const DEVICE_UNITS = ['crate', 'turret'];
const deviceParam = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const deviceDrawn = (d) => typeof d.active === 'boolean' ? d.active : !d.hidden;
const devicePct = (v) => `${v > 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}%`;

// 装置说明只读取当前关卡数据，不带入特殊地形功能或修改战斗规则。
function deviceCard(stage, d, row, col) {
  const p = deviceParam, s = isObj(d.stats) ? d.stats : {};
  const bb = isObj(d.skill?.bb) ? d.skill.bb : isObj(stage.special?.blower?.bb) ? stage.special.blower.bb : {};
  let lines = [], stats = null, fact = '不可部署';
  if (d.role === 'crate') lines = [
    t('挡在地面上的工事：地面敌人会绕开它走；只有无路可走时才会撞上来，把它摧毁后继续前进'),
    t('生命 {hp} 点，被摧毁后从场上消失', { hp: p(s.maxHp, 100) }),
  ];
  else if (d.role === 'turret') {
    const dur = /持续(\d+(?:\.\d+)?)秒/.exec(String(d.skill?.desc ?? ''));
    const aspdMax = p(bb.max_attack_speed, Infinity), fragMax = p(bb.max_damage_scale, Infinity);
    lines = [
      t('自动攻击射程内的一名敌人，造成法术伤害，命中的敌人附加脆弱'),
      t('按当前层数最高的盟约计算：每 1 层，攻击速度 +{aspd}（至多 +{aspdMax}），附加的脆弱 +{frag}%（至多 +{fragMax}%）', {
        aspd: p(bb.attack_speed_per_stack, 1), aspdMax: Number.isFinite(aspdMax) ? aspdMax : '∞',
        frag: Math.round(p(bb.damage_scale_per_stack, 0.001) * 1000) / 10,
        fragMax: Number.isFinite(fragMax) ? Math.round((fragMax - 1) * 1000) / 10 : '∞',
      }),
      ...(dur ? [t('脆弱持续 {sec} 秒', { sec: Number(dur[1]) })] : []),
    ];
    stats = [{ k: t('生命上限'), v: p(s.maxHp, 100) }];
    if (p(s.atk, 0)) stats.push({ k: t('攻击'), v: p(s.atk, 0) });
    if (p(s.def, 0)) stats.push({ k: t('防御'), v: p(s.def, 0) });
    if (p(s.bat, 0) > 0) stats.push({ k: t('攻击间隔'), v: `${Math.round(s.bat * 1000 / (p(s.aspd, 100) > 0 ? s.aspd || 100 : 100)) / 10}s` });
  } else if (d.role === 'platform') {
    lines = [t('高台位装置：地面敌人不能走上这一格'), t('远程位干员可以部署在其上；站上去的干员在高位，不阻挡敌人')];
    fact = '仅远程位可部署';
  } else if (d.role === 'blower') {
    const dir = { UP: '上', DOWN: '下', LEFT: '左', RIGHT: '右' }[String(d.dir || 'UP').toUpperCase()] || '上';
    lines = [t('向前方 {n} 格吹出气流（这一台朝{dir}）', { n: Array.isArray(d.rangeTiles) && d.rangeTiles.length > 1 ? d.rangeTiles.length - 1 : 3, dir: t(dir) })];
    const mods = [], em = [];
    const eq = p(bb['blower_s_character[equal].atk'], 0), op = p(bb['blower_s_character[opposite].atk'], 0);
    if (eq) mods.push(t('朝向与风向相同的攻击力 {v}', { v: devicePct(eq) }));
    if (op) mods.push(t('相反的 {v}', { v: devicePct(op) }));
    if (mods.length) lines.push(t('部署在气流里的干员：{mods}', { mods }));
    const eqM = p(bb['blower_s_enemy[equal].move_speed'], 0), opM = p(bb['blower_s_enemy[opposite].move_speed'], 0);
    if (eqM) em.push(t('顺风移动速度 ×{v}', { v: Math.round((1 + eqM) * 100) / 100 }));
    if (opM) em.push(t('逆风 ×{v}', { v: Math.round((1 + opM) * 100) / 100 }));
    if (em.length) lines.push(t('在气流里移动的敌人：{mods}', { mods: em }));
  }
  return { key: d.role, name: d.name || String(d.role), tag: t('场地装置'), row, col, lines, facts: [t(fact)], ...(stats ? { stats } : {}) };
}

export function deviceInfo(stage, row, col, { roles = DEVICE_ROLES } = {}) {
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  const d = (Array.isArray(stage?.devices) ? stage.devices : []).find((x) => isObj(x) && Array.isArray(x.pos)
    && x.pos[0] === row && x.pos[1] === col && roles.includes(x.role) && DEVICE_ROLES.includes(x.role) && deviceDrawn(x));
  return d ? deviceCard(stage, d, row, col) : null;
}

export function deviceTipAt(stage, row, col, { units = null, snap = null } = {}) {
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  const u = (Array.isArray(units) ? units : []).find((x) => isObj(x) && x.kind === 'device' && Math.round(Number(x.x)) === col && Math.round(Number(x.y)) === row);
  if (!u) return deviceInfo(stage, row, col, { roles: DEVICE_ROLES.filter((r) => !DEVICE_UNITS.includes(r)) });
  if (snap?.size > 0 && !(snap.get(u.id)?.[3] > 0)) return null;
  const same = (Array.isArray(stage?.devices) ? stage.devices : []).filter((d) => isObj(d) && d.key === u.defId && DEVICE_UNITS.includes(d.role));
  const d = same.find((x) => Array.isArray(x.pos) && x.pos[0] === row && x.pos[1] === col) || same[0];
  return d ? { ...deviceCard(stage, d, row, col), unitId: u.id } : null;
}

export function noteDeviceUnits(map, { units = null, events = null } = {}) {
  for (const u of Array.isArray(units) ? units : []) if (isObj(u) && u.kind === 'device' && u.id != null) map.set(u.id, u);
  for (const e of Array.isArray(events) ? events : []) if (Array.isArray(e) && e[0] === 'spawn' && isObj(e[1]) && e[1].kind === 'device' && e[1].id != null) map.set(e[1].id, e[1]);
  return map;
}

export function deviceUnitsForEntry(previous, noted, sameField) {
  if (!(noted instanceof Map) || noted.size > 0 || !sameField) return noted instanceof Map ? noted : new Map();
  return previous instanceof Map && previous.size > 0 ? previous : noted;
}
