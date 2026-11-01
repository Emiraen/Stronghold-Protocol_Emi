import { useEffect, useRef } from '../vendor/hooks.module.js';
import { createMizukiUiFx } from './mizukiUiFx.js';
import { loadMizukiUiMotion } from './mizukiUiMotion.js';

let typesPromise;
export function mizukiRouteParticleKey(type, manifest, nodeTypes) {
  const value = typeof type === 'number' ? type : nodeTypes?.values?.[type];
  return manifest?.nodeViewData?.[0]?.particles?.find(record => record.type === value)?.key || null;
}
function originalNodeTypes() {
  if (!typesPromise) typesPromise = fetch('/assets/mizuki/native-ui-motion/node-types.json').then(response => {
    if (!response.ok) throw new Error('Original Mizuki node types unavailable');
    return response.json();
  }).catch(error => { typesPromise = null; throw error; });
  return typesPromise;
}

/** The original selectable clip owns its 0.2 s particle event and node-state window. */
export function useMizukiRouteFx(ref, nodes, enabled) {
  const current = useRef(nodes), owner = useRef(null);
  current.current = nodes;
  useEffect(() => {
    const host = ref.current; if (!enabled || !host) return;
    let disposed = false, fx;
    const requests = new Map();
    owner.current = { requests, stop: id => fx?.stop(id) };
    const anchor = id => () => {
      const node = current.current.find(item => String(item.id) === id);
      return node ? { x: node.x, y: node.y } : null;
    };
    const play = async (id, request) => {
      if (!fx || disposed || requests.get(id) !== request) return;
      const node = current.current.find(item => String(item.id) === id);
      if (!node?.available) return;
      const key = mizukiRouteParticleKey(node.type, request.manifest, request.types);
      if (!key) return;
      try { await fx.play(key, { id, anchor: anchor(id), skip: (performance.now() - request.time) / 1000 }); }
      catch (error) { if (!disposed) host.dataset.nativeFxError = error.message; }
    };
    let metadata;
    const onEvent = event => {
      if (event.detail?.functionName !== 'AnimationEventOnPlayParticle') return;
      const button = event.target.closest?.('[data-route-id]');
      if (!button || !host.contains(button)) return;
      const id = button.dataset.routeId;
      const node = current.current.find(item => String(item.id) === id);
      if (!node?.available || requests.has(id)) return;
      const request = { time: performance.now(), ...metadata }; requests.set(id, request);
      void play(id, request);
    };
    host.addEventListener('mizuki:nativeuievent', onEvent);
    Promise.all([loadMizukiUiMotion(), originalNodeTypes(), createMizukiUiFx(host)]).then(([motion, types, api]) => {
      fx = api;
      if (disposed) { fx.destroy(); return; }
      metadata = { manifest: motion.manifest, types };
      for (const [id, request] of requests) { Object.assign(request, metadata); void play(id, request); }
    }).catch(error => { if (!disposed) host.dataset.nativeFxError = error.message; });
    return () => {
      disposed = true; host.removeEventListener('mizuki:nativeuievent', onEvent);
      requests.clear(); fx?.destroy(); if (owner.current?.requests === requests) owner.current = null;
    };
  }, [ref, enabled]);
  useEffect(() => {
    const state = owner.current; if (!state) return;
    for (const id of state.requests.keys()) if (!nodes.some(node => String(node.id) === id && node.available)) {
      state.requests.delete(id); state.stop(id);
    }
  }, [nodes]);
}
