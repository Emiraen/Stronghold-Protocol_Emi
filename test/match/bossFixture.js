// Focused boss integration fixture: real match setup and prep, without thirteen unrelated normal battles.
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { DATA, give, legalTileFor } from './harness.js';

export function prepareBossRound(h, { hidden = false, layers = 300 } = {}) {
  const m = h.m;
  h.toPrep(1);
  m.startRound(hidden ? m.gd.hiddenRound : m.gd.bossRound);
  h.run(() => m.phase === PHASE.PREP);
  assert.equal(m.phase, PHASE.PREP);
  const candidates = Object.values(DATA.chess).filter((c) => c.visible && c.isGolden && c.tier >= 5
    && !m.bannedChess.includes(c.chessId) && m.pool.has(m.gd.baseIdOf(c.chessId)));
  for (const ps of m.alivePlayers()) {
    ps._botWorker?.cancel();
    ps._botWorker = null;
    ps.autoplay = false;
    ps.ready = false;
    for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) {
      if (p.kind === 'chess') ps.returnCopies(p);
    }
    ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); ps.offers.length = 0;
    ps.lp = 1000;
    ps.shop.level = 6;
    ps.recompute();
    for (const rec of candidates) {
      if (ps.board.size >= ps.deployCap) break;
      const base = m.gd.baseIdOf(rec.chessId);
      if ((m.pool.entries.get(base)?.left || 0) < m.gd.goldenCopies) continue;
      const at = legalTileFor(m, ps, rec.chessId);
      if (at) give(m, ps, rec.chessId, 'board', at);
    }
    assert.ok(ps.board.size >= 4, 'a legal late-game lineup for the real boss simulation');
    for (const [id, bond] of Object.entries(ps.bonds)) if (bond.active) ps.layers[id] = layers;
    ps.recompute();
  }
  if (hidden) m.hiddenReached = true;
  h.drive(() => m.phase === (hidden ? PHASE.HIDDEN_CORE : PHASE.FINAL_ASSAULT));
  assert.equal(m.phase, hidden ? PHASE.HIDDEN_CORE : PHASE.FINAL_ASSAULT);
  return h;
}
