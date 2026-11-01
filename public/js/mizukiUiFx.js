// UI uses an orthographic screen plane; particle systems, materials and curves
// remain the original descriptors compiled by the existing battle FX engine.
import { FxLibrary } from './render/vfx/library.js';
import { FxGL } from './render/vfx/gl.js';
import { Effect } from './render/vfx/effect.js';
import { FrameData } from './render/vfx/geom.js';
import { createMizukiFxFetch } from './mizukiFx.js';

export async function createMizukiUiFx(host, { fetchFn = fetch } = {}) {
  const response = await fetchFn('/assets/mizuki/native-ui-motion/fx/manifest.json');
  if (!response.ok) throw new Error('Original Mizuki UI particles unavailable');
  const manifest = await response.json();
  const canvas = document.createElement('canvas');
  canvas.className = 'mz-original-ui-fx__canvas'; canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: true });
  if (!gl) return { available: false, destroy() {}, play() {}, stop() {}, stats: () => ({ available: false }) };
  const lib = new FxLibrary({ list: manifest, fetch: createMizukiFxFetch(manifest, { fetchFn }) });
  await lib.init();
  const renderer = new FxGL(gl, lib), fd = new FrameData(), effects = new Map(), pending = new Map();
  const vp = new Float32Array(16); vp[15] = 1;
  let disposed = false, frame = 0, previous = null, frameNo = 0, clock = 0;
  let width = 1, height = 1;
  const resize = () => {
    width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight);
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
    vp[0] = 2 / width; vp[5] = 2 / height; vp[10] = 1 / 10000;
  };
  const observer = new ResizeObserver(resize); observer.observe(host);
  host.appendChild(canvas); resize();
  const tick = now => {
    if (disposed) return;
    const dt = previous == null || document.hidden ? 0 : Math.min(.1, (now - previous) / 1000);
    previous = now; clock += dt; frameNo++;
    const basis = { right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, 1], pos: [0, 0, -10000], h: height, tanHalf: height / 20000 };
    fd.reset(); const items = [];
    for (const [id, entry] of effects) {
      const fx = entry.effect;
      const anchor = entry.anchor?.();
      if (anchor) fx.place({ pos: [anchor.x - width / 2, height / 2 - anchor.y, 0] });
      fx.update(dt);
      if (fx.done) { effects.delete(id); continue; }
      fx.gather(basis, item => items.push(item));
    }
    items.sort((a, b) => (a.layer - b.layer) || (a.order - b.order) || (a.queue - b.queue) || (b.dist - a.dist));
    const draw = [];
    for (const item of items) {
      const range = item.effect.build(item, basis, fd, frameNo);
      if (range?.count) draw.push(Object.assign(item, range));
    }
    gl.colorMask(true, true, true, true); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (draw.length) { renderer.upload(fd); renderer.draw(draw, { vp, cam: basis.pos, time: clock, half: false, pass: frameNo }); }
    host.dataset.nativeFxParticles = String([...effects.values()].reduce((sum, entry) => sum + entry.effect.sys.reduce((count, system) => count + (system?.count || 0), 0), 0));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  const api = {
    available: true, manifest, lib,
    async play(key, { id = key, anchor, skip = 0 } = {}) {
      if (disposed || !manifest.groups['fx/prefabs'][key]) return null;
      const current = effects.get(id);
      if (current?.effect.state === 'play') { current.anchor = anchor; return current.effect; }
      if (pending.has(id)) return pending.get(id).promise;
      const request = { active: true };
      pending.set(id, request);
      request.promise = (async () => {
        try {
          await lib.preload([key]);
          if (disposed || !request.active) return null;
          const definition = lib.def(key); if (!definition) return null;
          if (current) { current.effect.kill(); effects.delete(id); }
          const effect = new Effect(definition, { lib });
          const point = anchor?.();
          if (point) effect.place({ pos: [point.x - width / 2, height / 2 - point.y, 0] });
          // Late resource loading advances the original system clock; no new TTL.
          let elapsed = Math.max(0, Number(skip) || 0);
          while (elapsed > 0 && !effect.done) { const dt = Math.min(.05, elapsed); effect.update(dt); elapsed -= dt; }
          effects.set(id, { effect, anchor }); host.dataset.nativeFxKey = key;
          return effect;
        } finally { if (pending.get(id) === request) pending.delete(id); }
      })();
      return request.promise;
    },
    stop(id) { const request = pending.get(id); if (request) { request.active = false; pending.delete(id); } effects.get(id)?.effect.stop(); },
    stats: () => ({ available: true, effects: effects.size, draws: renderer.stats.draws, particles: [...effects.values()].reduce((sum, entry) => sum + entry.effect.sys.reduce((count, system) => count + (system?.count || 0), 0), 0), keys: [...effects.values()].map(entry => entry.effect.def.key), renderer: { ...renderer.stats } }),
    destroy() {
      if (disposed) return; disposed = true; cancelAnimationFrame(frame); observer.disconnect();
      for (const request of pending.values()) request.active = false; pending.clear();
      for (const entry of effects.values()) entry.effect.kill(); effects.clear();
      renderer.destroy(); lib.destroy(); canvas.remove();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
  host.__mizukiUiFx = api;
  return api;
}
