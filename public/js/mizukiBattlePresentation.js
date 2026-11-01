const same = (left, right) => left != null && right != null && String(left) === String(right);
const list = value => Array.isArray(value) ? value : [];
const ignoreAction = async () => false;

// This owns presentation only. The server and autoplay continue to advance normally.
export function createMizukiBattlePresentation() {
  let state = { props: null, ending: null, waiting: false };
  let source = null, environment = null, waitingPrivate = null, waitingTimer = null;
  const listeners = new Set(), completed = new Set();
  const publish = next => {
    const previous = state; state = next;
    for (const listener of [...listeners]) listener(state, previous);
  };
  const clearWaiting = () => { clearTimeout(waitingTimer); waitingTimer = null; waitingPrivate = null; };
  const runChanged = env => {
    const previous = state.props;
    return previous && (!env.match?.public || !same(previous.myId, env.me?.playerId)
      || previous.pub?.matchId != null && env.match.public.matchId != null && !same(previous.pub.matchId, env.match.public.matchId));
  };
  const matches = (props, outcome) => props?.phase === 'COMBAT' && !props.spectator && (!props.readOnly || props.finishing) && outcome?.id
    && (list(props.model?.fields).some(field => same(field.battleId, outcome.battleId))
      || same(props.model?.currentNode?.id, outcome.nodeId));
  const terminalProps = (props, outcome) => {
    const finalFields = list(environment?.match?.public?.mizuki?.fields);
    const fields = list(props.model?.fields).map(field => {
      const final = finalFields.find(value => same(value.battleId, field.battleId) && same(value.fieldId, field.fieldId));
      return final && Number(final.t) >= Number(field.t) ? { ...field, ...final } : field;
    });
    const latest = environment?.match?.private?.mizuki || {};
    const health = props.finishing && same(props.priv?.battleOutcome?.id, outcome?.id) ? {}
      : Object.fromEntries(['life', 'maxLife', 'shield'].filter(key => Number.isFinite(latest[key])).map(key => [key, latest[key]]));
    return { ...props, phase: 'COMBAT', finishing: true, readOnly: true, online: false, busy: 'battleOutcome', act: ignoreAction,
      model: { ...props.model, fields }, priv: { ...props.priv, ...health, ...(outcome ? { battleOutcome: outcome } : {}) } };
  };
  const release = id => {
    if (id != null && !same(state.ending?.id, id)) return;
    if (state.ending?.id) completed.add(state.ending.id);
    clearWaiting();
    publish({ props: source?.props || null, ending: null, waiting: false });
  };
  const begin = outcome => {
    if (!outcome?.id || completed.has(outcome.id) || environment?.spectator || !matches(state.props, outcome)) return false;
    if (state.ending) return same(state.ending.id, outcome.id);
    clearWaiting();
    publish({ props: terminalProps(state.props, outcome), ending: outcome, waiting: false });
    return true;
  };
  return {
    get: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    present(token, props) {
      // A reload or an explicit watch can contain an old receipt: it has no animation to resume.
      if (!state.props && props.priv?.battleOutcome?.id) completed.add(props.priv.battleOutcome.id);
      // Public and private frames arrive separately; keep the field until its matching frame arrives.
      if (props.phase === 'COMBAT' && state.props?.phase === 'COMBAT'
        && same(props.model?.currentNode?.id, state.props.model?.currentNode?.id)) {
        const incoming = list(props.model?.fields);
        const previous = list(state.props.model?.fields).filter(field => same(field.fieldId, props.ownFieldId)
          && !incoming.some(value => same(value.fieldId, field.fieldId)));
        if (previous.length) props = { ...props, model: { ...props.model, fields: [...incoming, ...previous] } };
      }
      source = { token, props };
      if (!state.ending && !state.waiting) publish({ props, ending: null, waiting: false });
    },
    depart(token, env) {
      if (source?.token !== token) return;
      environment = env; const previous = source.props; source = null;
      if (runChanged(env) || env.spectator) { release(); return; }
      if (state.ending) return;
      if (previous.phase !== 'COMBAT' || previous.readOnly) { release(); return; }
      if (begin(env.match?.private?.mizuki?.battleOutcome)) return;
      if (!state.props) return;
      // RESULT may arrive one socket frame before the final private receipt.
      waitingPrivate = env.match?.private;
      publish({ props: terminalProps(previous), ending: null, waiting: true });
      waitingTimer = setTimeout(() => { if (state.waiting) release(); }, 8000);
    },
    sync(env) {
      environment = env;
      if (runChanged(env)) { this.reset(); return; }
      if (env.spectator) { if (state.ending || state.waiting) release(); return; }
      if (state.ending) {
        publish({ ...state, props: terminalProps(state.props, state.ending) });
        return;
      }
      if (begin(env.match?.private?.mizuki?.battleOutcome)) return;
      if (state.waiting && env.match?.private !== waitingPrivate) release();
    },
    begin,
    release,
    reset() { source = null; clearWaiting(); completed.clear(); publish({ props: null, ending: null, waiting: false }); },
  };
}

export const mizukiBattlePresentation = createMizukiBattlePresentation();

// Apply the terminal snapshot, render it once, and retain this exact canvas under the result dialog.
export function freezeMizukiBattleView(view) {
  const raw = view?.raw || view, ticker = raw?.debug?.app?.ticker, interp = raw?.debug?.interp;
  if (!ticker || !interp) return () => {};
  const previous = { rate: interp.rate, delay: interp.delay, maxExtrapolate: interp.maxExtrapolate };
  interp.snapToNewest(); interp.rate = 0; interp.delay = 0; interp.maxExtrapolate = 0;
  ticker.stop(); ticker.update(performance.now());
  return () => {
    Object.assign(interp, previous);
    try { if (raw.debug?.app?.ticker === ticker) ticker.start(); } catch { /* The released scene may already be destroyed. */ }
  };
}
