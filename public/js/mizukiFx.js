// Original client descriptors, rendered by the existing OfficialFx implementation.
// This adapter belongs to one Mizuki view. It never changes the shared FX list.
import { FxLibrary } from './render/vfx/library.js';
import { resolveOfficialFx } from './render/vfx/tier.js';
import { sha256Hex } from '../../shared/sha256.js';
import { cachedFetch } from './resourceCache.js';

const list = value => Array.isArray(value) ? value : [];
const finite = value => Number.isFinite(Number(value));
export function mergeMizukiFxLists(shared, mode) {
  const groups = {};
  for (const name of new Set([...Object.keys(shared?.groups || {}), ...Object.keys(mode?.groups || {})])) groups[name] = { ...shared?.groups?.[name], ...mode?.groups?.[name] };
  return { version: 1, groups };
}
export function mizukiEffectEvent(tuple) {
  if (!Array.isArray(tuple) || tuple[0] !== 'fx') return null;
  const extra = tuple[4] && typeof tuple[4] === 'object' ? tuple[4] : {};
  if (tuple[1] === 'mizuki:effect' && typeof extra.key === 'string') return { ...extra, x: tuple[2], y: tuple[3] };
  if (tuple[1] === 'phase' && typeof extra.kind === 'string') return { ...extra, key: extra.kind, unitId: extra.unitId ?? extra.id, x: tuple[2], y: tuple[3] };
  return null;
}

/** Explicit mode files may be decoded without changing the global preload list. */
export function createMizukiFxFetch(manifest, { fetchFn = cachedFetch, fallback } = {}) {
  const entries = new Map();
  for (const group of Object.values(manifest.groups || {})) for (const record of Object.values(group)) {
    if (typeof record.path === 'string' && record.path.startsWith('/assets/mizuki/')) entries.set(record.path, record);
    if (typeof record.fullres?.path === 'string' && record.fullres.path.startsWith('/assets/mizuki/')) entries.set(record.fullres.path, record.fullres);
    if (typeof record.half === 'string' && record.half.startsWith('/assets/mizuki/')) entries.set(record.half, { path: record.half, sha256: record.halfSha256, bytes: record.halfBytes });
  }
  return async (url, options) => {
    const path = String(url), record = entries.get(path);
    if (!record) {
      if (path.startsWith('/assets/mizuki/')) throw new Error('Unlisted Mizuki FX resource: ' + path);
      if (fallback) return fallback(url, options);
      throw new Error('Resource outside this UI FX library: ' + path);
    }
    const response = await fetchFn(path, options);
    if (!response.ok || !record.sha256) return response;
    // Follow the shared cache's completed-record contract, including a PNG's
    // registered lossless WebP transport. Rehashing its served bytes here would
    // both reject that transport and repeat work on the render thread. Explicit
    // non-cache fetchers keep descriptor-source validation below.
    if (fetchFn === cachedFetch) return response;
    const bytes = await response.arrayBuffer();
    // Plain HTTP LAN origins lack SubtleCrypto. Keep the same integrity check
    // with the project's browser-safe SHA-256 instead of losing the whole map.
    const subtle = globalThis.crypto?.subtle;
    const hash = subtle
      ? [...new Uint8Array(await subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
      : sha256Hex(bytes);
    if (hash !== record.sha256 || record.bytes != null && bytes.byteLength !== record.bytes) throw new Error('Mizuki FX integrity mismatch: ' + path);
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export async function attachMizukiFx(raw, { settings = {}, fetchFn = cachedFetch } = {}) {
  const ofx = raw.debug?.ofx, wiring = raw.debug?.wiring;
  if (!ofx || !wiring) return { available: false, reason: 'Native OfficialFx instance unavailable' };
  let manifest;
  try { const response = await fetchFn('/assets/mizuki/fx/manifest.json'); manifest = response.ok ? await response.json() : null; } catch { manifest = null; }
  if (!manifest?.groups?.['fx/prefabs']) return { available: false, reason: 'Mizuki original FX descriptors unavailable' };
  const oldLibrary = ofx.lib;
  await oldLibrary.init();
  const sharedIndex = await oldLibrary.index().catch(() => null);
  const lib = new FxLibrary({ assets: ofx.ctx.assets, list: mergeMizukiFxLists({ groups: oldLibrary.groups }, manifest),
    fetch: createMizukiFxFetch(manifest, { fetchFn, fallback: oldLibrary.fetch }) });
  await lib.init();
  const modeIndex = await lib.index();
  const index = { ...sharedIndex, ...modeIndex };
  for (const key of ['units', 'skills', 'skins', 'projectiles', 'prefabs']) index[key] = { ...sharedIndex?.[key], ...modeIndex?.[key] };
  index.generic = { ...sharedIndex?.generic, ...modeIndex?.generic };
  lib._index = Promise.resolve(index);
  wiring.clear(); wiring.idx = index;
  ofx.clear(); ofx.glr?.destroy(); ofx.glr = null; ofx.pool.clear(); ofx.lib = lib;
  oldLibrary.destroy();
  const keys = Object.keys(manifest.groups['fx/prefabs']);
  let choice = settings.officialFx || 'auto', disposed = false, clock = 0, snapshot = null;
  const loops = new Map(), missing = new Set(), requested = new Set();
  const counts = { received: 0, spawned: 0, stopped: 0, phase: 0, projectiles: 0 };
  const tier = () => raw.debug.board3d ? resolveOfficialFx(choice, lib.available) : 'off';
  // Like ordinary Stronghold, decode only effects actually requested by this
  // battle. Initializing a mode must not download/compile the entire FX library.
  const point = item => {
    const unit = item.unitId != null ? raw.debug.views.get(item.unitId) : null;
    const x = finite(item.x) ? Number(item.x) : unit?.x;
    const y = finite(item.y) ? Number(item.y) : unit?.y;
    if (!finite(x) || !finite(y)) return null;
    const z = raw.debug.tiles.heightAt(Math.round(y), Math.round(x)) || 0;
    return { x, y, pos: [x - 10, y - 9, -z], groundZ: -z, mirror: item.dir === 'LEFT' };
  };
  const idFor = item => String(item.id ?? [item.unitId ?? '', item.key, item.x, item.y].join(':'));
  const stop = id => { const entry = loops.get(id); if (entry) { entry.handle?.stop(); loops.delete(id); counts.stopped++; } };
  function play(item, persistent = false) {
    if (!item || typeof item.key !== 'string') return null;
    const key = item.key.toLowerCase();
    if (!manifest.groups['fx/prefabs'][key]) { missing.add(key); return null; }
    requested.delete(key); requested.add(key);
    if (requested.size > 12) requested.delete(requested.values().next().value);
    const id = idFor(item);
    if (item.phase === 'stop' || item.active === false) { stop(id); return null; }
    const position = point(item);
    if (!position) return null;
    const previous = loops.get(id);
    if (previous?.handle?.alive) { previous.handle.place(position); return previous.handle; }
    // A persistent gameplay window can own a finite original effect. FinishMe at
    // its end does not mean replaying that original one-shot every snapshot.
    if (previous && persistent && (item.loop === false || lib.def(key)?.isLoop === false)) return previous.handle;
    if (previous) loops.delete(id);
    ofx.setTier(tier());
    const projectile = item.to && finite(item.to.x) && finite(item.to.y) && Number(item.speed) > 0;
    const life = Number(item.duration);
    const loop = typeof item.loop === 'boolean' ? item.loop : persistent || item.phase === 'start';
    let ended = false, previousTime = 0, cursor = { x: position.x, y: position.y };
    const track = projectile || finite(item.duration) || item.unitId != null ? effect => {
      if (projectile) {
        const target = item.toUnitId != null ? raw.debug.views.get(item.toUnitId) : null;
        const destination = target && finite(target.x) && finite(target.y) ? target : item.to;
        const time = Math.max(0, effect.ctime);
        const next = advanceMizukiProjectile(cursor, destination, Number(item.speed), time - previousTime);
        previousTime = time; cursor = next;
        const z = raw.debug.tiles.heightAt(Math.round(next.y), Math.round(next.x)) || 0;
        effect.place({ pos: [next.x - 10, next.y - 9, -z], groundZ: -z });
        if (!ended && next.reached) { ended = true; effect.stop({ hit: true }); }
      } else if (item.unitId != null) {
        const view = raw.debug.views.get(item.unitId);
        if (view && finite(view.x) && finite(view.y)) {
          const z = raw.debug.tiles.heightAt(Math.round(view.y), Math.round(view.x)) || 0;
          effect.place({ pos: [view.x - 10, view.y - 9, -z], groundZ: -z });
        }
      }
      if (!ended && Number.isFinite(life) && life >= 0 && effect.ctime >= life) { ended = true; effect.stop({ hit: !!projectile }); }
    } : null;
    const handle = ofx.spawn(key, position, { loop, owner: item.unitId ?? null, track, skip: persistent && finite(item.since) ? Math.min(1, Math.max(0, clock - Number(item.since))) : 0 });
    if (handle) { counts.spawned++; if (projectile) counts.projectiles++; if (loop) loops.set(id, { key, handle }); }
    return handle;
  }
  const sync = current => {
    snapshot = current;
    const time = typeof current?.t === 'number' ? current.t : current?.time;
    if (finite(time)) clock = Number(time);
    const active = new Set();
    for (const item of [...list(current?.officialFacilities?.effects), ...list(current?.officialEnemyEffects)]) { const id = idFor(item); if (item.active !== false) active.add(id); play(item, true); }
    for (const id of loops.keys()) if (!active.has(id)) stop(id);
  };
  const clear = () => { for (const entry of loops.values()) entry.handle?.kill(); loops.clear(); snapshot = null; };
  const originalEnter = raw.enterBattle.bind(raw), originalSnapshot = raw.pushSnapshot.bind(raw), originalEvents = raw.pushEvents.bind(raw), originalSettings = raw.setSettings.bind(raw), originalDestroy = raw.destroy.bind(raw);
  raw.enterBattle = (...args) => { clear(); return originalEnter(...args); };
  raw.pushSnapshot = current => { const result = originalSnapshot(current); if (!disposed) sync(current); return result; };
  raw.pushEvents = packet => {
    const events = Array.isArray(packet) ? packet : list(packet?.ev || packet?.events);
    const forwarded = [];
    for (const tuple of events) {
      const effect = mizukiEffectEvent(tuple);
      if (effect && (tuple[1] === 'mizuki:effect' || manifest.groups['fx/prefabs'][effect.key])) {
        counts.received++; if (tuple[1] === 'phase') { counts.phase++; const view = raw.debug.views.get(effect.unitId); if (view) { effect.x = view.x; effect.y = view.y; } }
        play(effect);
      } else forwarded.push(tuple);
    }
    return originalEvents(Array.isArray(packet) ? forwarded : { ...packet, t: typeof packet?.t === 'number' ? packet.t : clock, ev: forwarded });
  };
  raw.setSettings = value => { const result = originalSettings(value); if (value?.officialFx) { choice = value.officialFx; ofx.setTier(tier()); if (tier() !== 'off' && requested.size) void lib.preload([...requested], { half: ofx.lite }).then(() => { if (snapshot && !disposed) sync(snapshot); }).catch(() => {}); } return result; };
  raw.destroy = (...args) => { disposed = true; clear(); return originalDestroy(...args); };
  const state = { available: true, keys, lib, counters: counts, missing, loops, sync, play, stats: () => ({ ...counts, originalKeys: keys.length, decodedKeys: keys.filter(key => !!lib.def(key)).length, loops: loops.size, missing: [...missing], tier: ofx.tier, renderer: ofx.stats() }) };
  raw.debug.mizukiFx = state;
  return state;
}

// Match the authoritative projectile speed while following the current target.
export function advanceMizukiProjectile(position, target, speed, elapsed) {
  const dx = Number(target.x) - position.x, dy = Number(target.y) - position.y;
  const distance = Math.hypot(dx, dy), travel = Math.max(0, elapsed) * Math.max(0, speed);
  const ratio = distance > 0 ? Math.min(1, travel / distance) : 1;
  return { x: position.x + dx * ratio, y: position.y + dy * ratio, reached: ratio === 1 };
}
