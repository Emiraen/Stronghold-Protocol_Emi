// Synchronous layer grants only. Read only this player's target bond, never a full player/match snapshot.
// Never replay a handler, a purchase, a merge, or an ambiguous/partially committed grant.
export const REWARD_FAILURE_TEXT = '发生错误！请复制诊断信息并联系服主';

// Failure is local to this action: never let diagnostics or final failure abort later actions.
export function isolateRewardStep(m, label, action) {
  try { return action(); } catch (error) {
    try { m.reportError?.(label, error); } catch { /* Reporting must not become a second chain failure. */ }
    return undefined;
  }
}

function notifyFailure(m, ps, diagnostic) {
  const key = JSON.stringify([m.round, ps.playerId, diagnostic.source, diagnostic.hook, diagnostic.bondId]);
  const notices = m._rewardFailureNotices ??= new Set();
  if (notices.has(key)) return;
  if (notices.size >= 128) notices.clear();
  notices.add(key);
  try {
    m.sendTo(ps.playerId, { t: 'm.toast', kind: 'error', text: REWARD_FAILURE_TEXT, diagnostic });
  } catch (error) {
    try { m.reportError?.('reward diagnostic', error); } catch { /* A failed diagnostic must not block later rewards. */ }
  }
}

export function grantLayersVerified(m, ps, bondId, n, opts, { source, hook }) {
  const report = (attempt, error) => {
    try { m.dispatcher._report(source, `${hook}[layers:${bondId}:attempt${attempt}]`, error); }
    catch { /* Reporting is best-effort; the current target must still yield to the next action. */ }
  };
  const readTarget = () => {
    const count = ps.layers[bondId] ?? 0;
    if (!Number.isFinite(count) || count < 0) throw new Error(`Invalid actual layer count: ${bondId}`);
    return count;
  };
  let before;
  try { before = readTarget(); }
  catch (error) {
    report(0, error);
    notifyFailure(m, ps, { code: 'LAYER_GRANT_FAILED', round: m.round, source, hook, bondId,
      attempt: 0, receipt: 'unverified' });
    return 0;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const receipt = { stage: 'unverified' };
    let error;
    try { ps.addLayers(bondId, n, { ...opts, receipt }); }
    catch (cause) { error = cause; report(attempt, cause); }
    let after;
    // One targeted authority read per attempt, including silent failures and post-write exceptions.
    try { after = readTarget(); }
    catch (error) {
      report(attempt, error);
      notifyFailure(m, ps, { code: 'LAYER_GRANT_FAILED', round: m.round, source, hook, bondId,
        attempt, receipt: 'unverified', before });
      return 0;
    }
    // The actual delta wins over return values and receipts. Even a partial grant must not be replayed.
    if (after > before) return after - before;
    // Invalid/inactive/capped/fractional no-ops are normal rules, not failed eligible rewards.
    if (!error && after === before && receipt.noop) return 0;
    // Cyclops preparation can consume fractional remainders; an ambiguous side effect is not safe to repeat.
    const notReceived = after === before && (receipt.stage === 'preflight'
      || (receipt.stage === 'unverified' && !m.isCyclops));
    if (!error) {
      error = new Error(`Layer grant did not increase actual target: ${bondId}`);
      report(attempt, error);
    }
    if (attempt === 1 && notReceived) continue;
    notifyFailure(m, ps, { code: 'LAYER_GRANT_FAILED', round: m.round, source, hook, bondId, attempt,
      receipt: notReceived ? 'not-received' : 'unverified', before, after });
    return 0;
  }
}
