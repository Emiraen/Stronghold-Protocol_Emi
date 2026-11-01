// Original Unity UI AnimationClip curves. This module is owned by Mizuki only.
import { useEffect } from '../vendor/hooks.module.js';
import { evalCurve } from './render/vfx/curves.js';

const ROOT = '/assets/mizuki/native-ui-motion/';
let pending;
export function compileMizukiUiClip(raw, metadata = {}) {
  const tracks = (raw?.m_FloatCurves || []).map(track => ({ path: track.path || '', property: track.attribute,
    keys: (track.curve?.m_Curve || []).map(key => [key.time, key.value,
      Number.isFinite(key.inSlope) ? key.inSlope : null, Number.isFinite(key.outSlope) ? key.outSlope : null,
      key.weightedMode || 0, key.inWeight, key.outWeight]) }));
  return { name: raw.m_Name, duration: Number(metadata.duration ?? raw.m_MuscleClip?.m_StopTime) || 0,
    loop: raw.m_WrapMode === 2 || raw.m_MuscleClip?.m_LoopTime === true,
    pingPong: raw.m_WrapMode === 4, tracks, events: raw.m_Events || [] };
}
export function mizukiUiClipTime(clip, elapsed) {
  if (!(clip.duration > 0)) return 0;
  const t = Math.max(0, elapsed);
  if (clip.pingPong) { const p = t % (clip.duration * 2); return p > clip.duration ? 2 * clip.duration - p : p; }
  return clip.loop ? t % clip.duration : Math.min(t, clip.duration);
}
export function sampleMizukiUiClip(clip, elapsed, sink) {
  const time = mizukiUiClipTime(clip, elapsed);
  for (const track of clip.tracks) sink(track.path, track.property, evalCurve(track.keys, time));
}
export async function loadMizukiUiMotion() {
  if (!pending) pending = fetch(ROOT + 'manifest.json').then(response => {
    if (!response.ok) throw new Error('Original Mizuki UI motion unavailable');
    return response.json();
  }).then(manifest => ({ manifest, clips: new Map(), async clip(name) {
    if (!this.clips.has(name)) {
      const key = manifest.clipsByName?.[name]?.[0], record = manifest.objects?.[key];
      const request = (record ? fetch(ROOT + record.file).then(response => {
        if (!response.ok) throw new Error('Original UI clip unavailable: ' + name);
        return response.json();
      }).then(raw => compileMizukiUiClip(raw, record)) : Promise.resolve(null)).catch(error => {
        if (this.clips.get(name) === request) this.clips.delete(name);
        throw error;
      });
      this.clips.set(name, request);
    }
    return this.clips.get(name);
  } })).catch(error => { pending = null; throw error; });
  return pending;
}

/** One original clip, one play request; wrapMode=Default is never made a loop. */
export function playMizukiUiClip(root, clip, { reduce = false, onEvent } = {}) {
  let frame = 0, cancelled = false, start = null, previous = -1;
  const nodes = new Map([['', root]]), transforms = new Map();
  for (const target of root.querySelectorAll('[data-native-path]')) nodes.set(target.dataset.nativePath, target);
  const touched = new Map();
  const write = (target, key, value) => {
    if (!touched.has(target)) touched.set(target, new Map());
    if (!touched.get(target).has(key)) touched.get(target).set(key, target.style[key]);
    target.style[key] = value;
  };
  const sink = (path, property, value) => {
    const target = nodes.get(path); if (!target) return;
    if (property === 'm_Color.a' || property === 'm_Alpha') write(target, 'opacity', String(value));
    else if (property === 'm_IsActive') write(target, 'visibility', value > 0.5 ? 'visible' : 'hidden');
    else if (property === 'm_BlocksRaycasts') write(target, 'pointerEvents', value > 0.5 ? '' : 'none');
    else if (/^m_AnchoredPosition\.[xy]$/.test(property)) {
      if (!transforms.has(target)) transforms.set(target, { x: 0, y: 0 });
      transforms.get(target)[property.endsWith('.x') ? 'x' : 'y'] = reduce ? 0 : value;
    } else if (property === '_clipRatio') {
      target.dataset.nativeClipRatio = String(value);
      target.dispatchEvent(new CustomEvent('mizuki:nativeclipratio', { detail: { value } }));
    }
  };
  const tick = now => {
    if (cancelled || !root.isConnected) return;
    if (start == null) start = now;
    const elapsed = reduce ? clip.duration : (now - start) / 1000;
    sampleMizukiUiClip(clip, elapsed, sink);
    for (const [target, position] of transforms) write(target, 'transform', 'translate3d(' + position.x + 'px,' + -position.y + 'px,0)');
    for (const event of clip.events) if (event.time > previous && event.time <= elapsed) {
      onEvent?.(event);
      root.dispatchEvent(new CustomEvent('mizuki:nativeuievent', { bubbles: true, detail: { clip: clip.name, ...event } }));
    }
    previous = elapsed;
    root.dataset.nativeClip = clip.name;
    root.dataset.nativeClipTime = String(mizukiUiClipTime(clip, elapsed));
    if (!reduce && (clip.loop || clip.pingPong || elapsed < clip.duration)) frame = requestAnimationFrame(tick);
  };
  tick(performance.now());
  return () => {
    cancelled = true; cancelAnimationFrame(frame);
    for (const [target, properties] of touched) for (const [key, value] of properties) target.style[key] = value;
  };
}
export function useMizukiUiClip(ref, name, identity) {
  useEffect(() => {
    let disposed = false, stop;
    const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (name) loadMizukiUiMotion().then(library => library.clip(name)).then(clip => {
      if (clip && !disposed && ref.current) stop = playMizukiUiClip(ref.current, clip, { reduce: !!media?.matches });
    }).catch(error => { if (ref.current) ref.current.dataset.nativeMotionError = error.message; });
    return () => { disposed = true; stop?.(); };
  }, [ref, name, identity]);
}
