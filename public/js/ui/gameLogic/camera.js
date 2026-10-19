// 从 A 原正文按职责拆分；保持原有行为。
import { GEO } from '../../../../shared/constants.js';
import { BOSS_ROW_SHIFT, MAX_COL } from '../../render/prepfield.js';
import { isObj, int } from './shared.js';

export function prepCamera(pub, myId) {
  const normal = { kind: 'prep', opts: { rect: { ...GEO.NORMAL_RECT }, side: 'L' } };
  const r = pub?.round;
  if (!Number.isInteger(r) || r <= 0 || !(r === pub.bossRound || r === pub.hiddenRound)) return normal;
  const alive = (Array.isArray(pub.players) ? pub.players : []).filter((p) => isObj(p) && p.alive !== false)
    .sort((a, b) => int(a.seat, 99) - int(b.seat, 99));
  const idx = alive.findIndex((p) => p.playerId === myId);
  if (idx < 0) return normal; // eliminated / unknown: no board of its own on the boss field
  return { kind: 'bossPrep', opts: { side: idx % 2 === 1 ? 'R' : 'L' } };
}

export function prepCameraFor(pub, myId, folded = false) {
  const c = prepCamera(pub, myId);
  return { kind: c.kind, opts: { ...c.opts, shop: !folded } };
}

export function foldCamera(s) {
  if (!s || !s.ownPrep || s.pen || s.busy) return null;
  const want = prepCameraFor(s.pub, s.myId, !!s.folded);
  const cur = s.current;
  if (cur && cur.kind === want.kind && (cur.opts?.shop !== false) === want.opts.shop) return null;
  return want;
}

export function deployFieldOf(pub, myId) {
  const cam = prepCamera(pub, myId);
  return cam.kind === 'bossPrep' ? (cam.opts.side === 'R' ? 'bossR' : 'bossL') : 'normal';
}

export function fieldTile(field, r, c) {
  if (field !== 'bossL' && field !== 'bossR') return [r, c];
  return [r + BOSS_ROW_SHIFT, field === 'bossR' ? MAX_COL - c : c];
}

export function boardTileOf(field, r, c) {
  if (field !== 'bossL' && field !== 'bossR') return [r, c];
  return [r - BOSS_ROW_SHIFT, field === 'bossR' ? MAX_COL - c : c];
}
