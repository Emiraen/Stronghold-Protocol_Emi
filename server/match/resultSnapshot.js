import { bondList } from './bondsMeta.js';
import { boardOrder } from './board.js';

/** Display-only snapshot, detached before elimination returns pieces to the pool. */
export function resultSnapshot(ps) {
  const gd = ps.gd;
  const lineup = boardOrder(ps.board).filter((x) => x.piece.kind === 'chess').map(({ r, c, piece }) => {
      const e = { id: piece.id, golden: gd.isGolden(piece.id), tier: gd.tierOf(piece.id), row: r, col: c, items: (piece.items || []).map((i) => i.id) };
      // 0.2.0 自选编队: a DIY slot's pick — the result screen names and draws the operator (shared/diy.js diyRecord)
      const pick = typeof ps.diyPickOf === 'function' ? ps.diyPickOf(piece.id) : null;
      if (pick) e.diy = { charId: pick.charId, skillIndex: pick.skillIndex, uniEquipId: pick.uniEquipId };
      // 0.2.0 补位: a chess this player fielded as its stand-in — the result screen draws the stand-in (the owner's recall
      // of the official mode, 2026-10-06); `standInFor` = the replaced operator's charId, like the sim's UnitInfo
      const si = typeof ps.fieldsStandIn === 'function' && ps.fieldsStandIn(piece.id) ? gd.standIn(piece.id) : null;
      if (si && si.standInFor) e.standInFor = si.standInFor;
      const skin = typeof ps.skinFor === 'function' ? ps.skinFor(piece.id) : null;
      if (skin) e.skin = skin;
      return e;
    });
  return { lineup, bonds: bondList(gd, ps.bonds).filter((b) => b.active || b.layers > 0).map(b => ({ ...b })) };
}
