import { recordError } from '../diag.js';

/** Isolate frame stages and individual views; a broken model must not stop later views or FX ageing. */
export function createFrameGuard(context, { report = recordError, warn = (...args) => console.error(...args) } = {}) {
  const stages = new Map(), views = new WeakMap();
  let warned = false;
  return (stage, view, run) => {
    try { run(); return true; }
    catch (error) {
      const owner = view && typeof view === 'object' ? view : null;
      let errors = owner ? views.get(owner) : stages;
      if (!errors) { errors = new Map(); views.set(owner, errors); }
      const signature = String(error?.message || error);
      if (errors.get(stage) !== signature) {
        errors.set(stage, signature);
        // Diagnostics must also be unable to interrupt the remaining frame.
        try { report('render', error, JSON.stringify({ step: stage, id: view?.id, unit: view?.info?.defId, skin: view?.info?.skin, ...context() })); } catch { /* preserve the frame */ }
      }
      if (!warned) { warned = true; try { warn('[render] frame failed', error); } catch { /* preserve the frame */ } }
      return false;
    }
  };
}
