import { h } from './ui/components.js';
import { useEffect, useRef, useState } from '../vendor/hooks.module.js';
import { loadMizukiUiMotion, playMizukiUiClip } from './mizukiUiMotion.js';

let routeData;
export function loadMizukiConnectorData() {
  if (!routeData) routeData = loadMizukiUiMotion().then(async motion => {
    const base = '/assets/mizuki/native-ui-motion/';
    const read = async path => { const response = await fetch(base + path); if (!response.ok) throw new Error('Original route connector data unavailable: ' + path); return response.json(); };
    const [view, types, sprites, prefab] = await Promise.all([read(motion.manifest.nodeViewData[0].file), read('node-types.json'), read('route-sprites/manifest.json'), read('fx/prefabs/dungeon_node.json')]);
    const curve = prefab.nodes.find(node => node.name === 'curve_1')?.behaviours?.find(item => item.class === 'RoguelikeCurve')?.fields;
    const settings = prefab.nodes.flatMap(node => node.behaviours || []).find(item => item.class === 'RoguelikeDungeonNodeView')?.fields?._settings;
    if (!curve || !settings || !(curve._segment > 0) || !(curve._width > 0) || !Number.isFinite(curve._degreeX) || !Number.isFinite(curve._degreeY)) throw new Error('Original route curve settings unavailable');
    return { view, types, sprites: sprites.sprites, curve, settings };
  }).catch(error => { routeData = null; throw error; });
  return routeData;
}

export function mizukiConnectorState(edge, { view, types, sprites }) {
  const type = typeof edge.toNode.type === 'number' ? edge.toNode.type : types.values[edge.toNode.type];
  const selectable = view._bottomBarColors.find(row => row.type === type)?.color || view._selectableColors.find(row => row.type === type)?.color;
  const useClipColor = !!(edge.fromNode.current && edge.toNode.available && edge.toNode.revealed !== false && selectable);
  const normal = edge.fromNode.discarded || edge.toNode.discarded ? view._discardedLineColor : view._traceDefaultColor;
  const sprite = sprites[edge.locked ? '_lineLockedImg' : edge.hiddenType === 'APPEAR' ? '_lineHiddenImg' : '_lineImg'];
  return { useClipColor, normal, alternate: useClipColor ? selectable : normal, sprite };
}
function rgba(color) { return 'rgba(' + [color.r * 255, color.g * 255, color.b * 255, color.a].join(',') + ')'; }
export function mizukiConnectorGradient(state, ratio) {
  const threshold = Number(ratio) * 100;
  return 'linear-gradient(to right,' + rgba(state.alternate) + ' ' + threshold + '%,' + rgba(state.normal) + ' ' + threshold + '%)';
}

const boss = (node, types) => node?.type === 'BATTLE_BOSS' || node?.type === 'BOSS' || node?.type === 'boss'
  || typeof node?.type === 'number' && [types?.values?.BATTLE_BOSS, types?.values?.BOSS].includes(node.type);
export const MIZUKI_CONNECTOR_UNLOCK_TIMEOUT_MS = 4000;
const coordinate = value => Number(value.toFixed(5));
/** Original RoguelikeCurve::_GenerateCurve: absolute control offsets and 20 samples. */
export function mizukiConnectorGeometry(edge, { curve, settings, types }) {
  const fromPanel = boss(edge.fromNode, types) ? settings.panelConnectorXBoss : settings.panelConnectorX;
  const toPanel = boss(edge.toNode, types) ? settings.panelConnectorXBoss : settings.panelConnectorX;
  // RectTransform +Y is up; browser/SVG +Y is down. No invented vertical handle.
  const start = { x: edge.fromNode.x + fromPanel + curve._startPosOffset[0], y: edge.fromNode.y - curve._startPosOffset[1] };
  const end = { x: edge.toNode.x - toPanel + curve._endPosOffset[0], y: edge.toNode.y - curve._endPosOffset[1] };
  const control1 = { x: start.x + curve._degreeX, y: start.y - curve._degreeY };
  const control2 = { x: end.x - curve._degreeX, y: end.y + curve._degreeY };
  const point = t => { const u = 1 - t; return { x: coordinate(u*u*u*start.x + 3*u*u*t*control1.x + 3*u*t*t*control2.x + t*t*t*end.x), y: coordinate(u*u*u*start.y + 3*u*u*t*control1.y + 3*u*t*t*control2.y + t*t*t*end.y) }; };
  const segment = Math.trunc(curve._segment), points = Array.from({ length: segment + 1 }, (_, index) => point(index / segment));
  const path = values => values.length ? 'M ' + values.map(value => value.x + ' ' + value.y).join(' L ') : '';
  return { start, end, control1, control2, width: curve._width, segment, points, path: path(points),
    cubic: 'M ' + start.x + ' ' + start.y + ' C ' + control1.x + ' ' + control1.y + ' ' + control2.x + ' ' + control2.y + ' ' + end.x + ' ' + end.y,
    // Native UV progress is the sample parameter, not a replacement CSS easing.
    filledPath(ratio) {
      const progress = Math.max(0, Math.min(1, Number(ratio) || 0));
      if (progress <= 0) return '';
      if (progress >= 1) return path(points);
      const scaled = progress * segment, index = Math.floor(scaled), blend = scaled - index;
      const visible = points.slice(0, index + 1), a = points[index], b = points[index + 1];
      if (blend > 0) visible.push({ x: coordinate(a.x + (b.x-a.x)*blend), y: coordinate(a.y + (b.y-a.y)*blend) });
      return path(visible);
    } };
}

export function NativeMizukiConnector({ edge, index, routeScope = '', onComplete, onProgress }) {
  const ref = useRef(null), foreground = useRef(null), [resource, setResource] = useState({ data: null, error: null });
  const { data, error: resourceError } = resource;
  const callbacks = useRef({ onComplete, onProgress }); callbacks.current = { onComplete, onProgress };
  const completed = useRef(null);
  const state = data ? mizukiConnectorState(edge, data) : null;
  const geometry = data ? mizukiConnectorGeometry(edge, data) : null;
  const edgeKey = String(edge.from) + ':' + String(edge.to);
  const historical = !!(edge.fromNode.completed && (edge.toNode.completed || edge.toNode.current));
  // Keep raw authoritative available here. RoutePhase gates displayAvailable separately.
  const advancing = !!(edge.fromNode.current && edge.fromNode.completed && edge.toNode.available && !edge.locked);
  const routeIdentity = String(routeScope) + ':' + edgeKey;
  const identity = String(routeScope) + ':' + edgeKey + ':' + historical + ':' + advancing + ':' + (geometry?.cubic || (resourceError ? 'unavailable' : 'loading'));
  const permission = useRef({ advancing, routeIdentity }); permission.current = { advancing, routeIdentity };
  const unlocked = useRef(null);
  const complete = () => {
    if (!permission.current.advancing || permission.current.routeIdentity !== routeIdentity || unlocked.current === routeIdentity) return;
    unlocked.current = routeIdentity; callbacks.current.onComplete?.(edgeKey);
  };

  useEffect(() => { let active = true; loadMizukiConnectorData().then(value => { if (active) setResource({ data: value, error: null }); }).catch(error => { if (active) setResource({ data: null, error }); }); return () => { active = false; }; }, []);
  useEffect(() => {
    if (!advancing || unlocked.current === routeIdentity) return;
    // Resource/cache requests may never settle. They cannot revoke a successor
    // already authorized by the server while a presentation clip is loading.
    const timer = setTimeout(complete, MIZUKI_CONNECTOR_UNLOCK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [routeIdentity, advancing]);
  useEffect(() => {
    const root = ref.current, target = foreground.current;
    if (!root || !target || (!geometry && !resourceError)) return;
    let disposed = false, stop;
    const paint = value => {
      const progress = Math.max(0, Math.min(1, Number(value) || 0));
      if (geometry) target.setAttribute('d', geometry.filledPath(progress));
      root.dataset.nativeProgress = String(progress);
      root.dataset.nativeComplete = progress >= 1 ? 'true' : 'false';
      callbacks.current.onProgress?.(progress, edgeKey);
      if (advancing && progress >= 1 && completed.current !== identity) { completed.current = identity; complete(); }
    };
    const skipAnimation = error => {
      root.dataset.nativeConnectorError = error?.message || String(error);
      root.dataset.nativeConnectorFallback = 'skip-animation';
      // Presentation failures must not block a successor the server permits.
      paint(advancing || historical ? 1 : 0);
    };
    delete root.dataset.nativeConnectorError;
    delete root.dataset.nativeConnectorFallback;
    if (resourceError) { skipAnimation(resourceError); return; }
    if (historical) { paint(1); return; }
    if (!advancing) { paint(0); return; }
    if (completed.current === identity) { paint(1); return; }
    // nativeclipratio is non-bubbling: listen on the exact visible path
    // written by playMizukiUiClip, before starting the original animation.
    const onRatio = event => paint(event.detail?.value ?? target.dataset.nativeClipRatio);
    target.addEventListener('mizuki:nativeclipratio', onRatio);
    paint(0);
    loadMizukiUiMotion().then(library => library.clip('anim_curve')).then(clip => {
      if (disposed) return;
      if (!clip || !(clip.duration > 0) || !clip.tracks.some(track => track.path === 'curve_1' && track.property === '_clipRatio')) throw new Error('Original anim_curve unavailable');
      stop = playMizukiUiClip(root, clip, { reduce: !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches });
    }).catch(error => { if (!disposed) skipAnimation(error); });
    return () => { disposed = true; target.removeEventListener('mizuki:nativeclipratio', onRatio); stop?.(); };
  }, [identity]);

  return h('g', { ref, class: 'mz-native-connector', 'data-edge-key': edgeKey, 'data-route-scope': routeScope, 'data-original-line': state?.sprite?.name, 'data-native-curve': geometry?.cubic, 'data-native-segments': geometry?.segment, 'data-native-width': geometry?.width, 'data-native-advancing': advancing ? 'true' : 'false', 'data-native-history': historical ? 'true' : 'false' },
    h('path', { d: geometry?.path || '', class: 'mz-native-connector__base', 'stroke-width': geometry?.width }),
    h('path', { ref: foreground, d: historical ? geometry?.path || '' : '', class: 'mz-native-connector__fill', 'stroke-width': geometry?.width, 'data-native-path': 'curve_1', 'data-connector-index': index }));
}
