import { PHASE } from '../../../shared/constants.js';

// Use LP from the public snapshot: its phase and player LP arrive together. A private
// snapshot can arrive before or after SETTLE and must not become a false baseline.
export function rememberRoundLife(previous, { phase, round, lp }) {
  if (phase !== PHASE.COMBAT && phase !== PHASE.UNITE) return previous;
  const same = previous?.round === round;
  if (!same && !Number.isFinite(lp)) return null;
  return { round, lp: same ? previous.lp : lp, unite: phase === PHASE.UNITE || (same && previous.unite) };
}

export function settledRoundOutcome(baseline, pub, playerId) {
  if (pub?.phase !== PHASE.SETTLE) return null;
  const losses = pub.uniteResult?.losses;
  const reported = losses && Object.hasOwn(losses, playerId) ? losses[playerId] : null;
  const lp = pub.players?.find((p) => p.playerId === playerId)?.lp;
  const loss = Number.isFinite(reported) ? Math.max(0, reported)
    : baseline?.round === pub.round && Number.isFinite(baseline.lp) && Number.isFinite(lp)
      ? Math.max(0, baseline.lp - lp) : null;
  // On a reload directly into SETTLE there is no pre-battle LP: show no guessed result.
  if (loss == null) return null;
  const teamPerfect = loss === 0 && pub.uniteResult?.through === 0;
  return {
    tone: loss > 0 ? 'red' : pub.uniteResult && !teamPerfect ? 'orange' : 'mint',
    sub: loss > 0 ? `生命值减少 −${loss}` : teamPerfect ? '全员无伤！' : '本回合未损失生命值',
    sound: loss > 0 ? 'battleOverReduce' : baseline?.unite || pub.uniteResult ? 'battleOverNoReduce' : 'battleOverNormal',
  };
}
