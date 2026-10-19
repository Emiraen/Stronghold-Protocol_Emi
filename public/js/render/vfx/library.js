// render/vfx/library.js — the official effects' files (DESIGN §33.1): the file list, index.json, textures.json, the
// prefab descriptors (compiled once, render/vfx/effect.js), meshes and textures, loaded on demand and cached.
//
//   const lib = new FxLibrary({ assets })        assets: the asset store (public/js/assets.js) — its local-art manifest
//                                                is the fallback file list of a Phase 1a extraction
//   await lib.init()  → lib.available            the file list: GET /data/local-fx.json (the served view: hashed URLs,
//                                                `{ groups: {} }` without effects), else the `fx*` groups of
//                                                data/local-assets.json; URLs always come from the list
//   await lib.index()                            index.json (units, projectiles, skills, skins, generic keys)
//   lib.def(key) / await lib.load(key)           a compiled prefab (null until loaded / when absent)
//   await lib.preload(keys, { half })            descriptors + their meshes and textures (a battle's set)
//   lib.mesh(key), lib.texture(key, half)        loaded data or null (and a load is started)
//
// Keys are lower case (§33.1). Built-in Unity meshes ('builtin:Quad', 'builtin:Plane', 'builtin:Cube',
// 'builtin:Sphere') are generated here.

import { cachedFetch, resourceCache } from '../../resourceCache.js';
import { loadImageElement } from '../../assets.js';
import { compileEffect } from './effect.js';
import { FX_LIST_URL, loadFxList } from './available.js';
import { setIndexVersion } from './mounts.js';
const MAX_PARALLEL = 8;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Unity's built-in meshes as fx-mesh records. */
export function builtinMesh(name) {
  if (name === 'Quad') {
    return { positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], normals: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1],
      uv0: [0, 0, 1, 0, 0, 1, 1, 1], submeshes: [[0, 3, 1, 3, 0, 2]] };
  }
  if (name === 'Plane') {
    // 10 × 10 units in XZ, facing +Y, 11 × 11 vertices
    const P = [], N = [], U = [], I = [];
    for (let j = 0; j <= 10; j++) for (let i = 0; i <= 10; i++) { P.push(5 - i, 0, 5 - j); N.push(0, 1, 0); U.push(i / 10, j / 10); }
    for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) { const a = j * 11 + i; I.push(a, a + 11, a + 1, a + 1, a + 11, a + 12); }
    return { positions: P, normals: N, uv0: U, submeshes: [I] };
  }
  if (name === 'Cube') {
    const P = [], N = [], U = [], I = [];
    const faces = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
    for (const n of faces) {
      const u = Math.abs(n[1]) === 1 ? [1, 0, 0] : [0, 1, 0];
      const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
      const b = P.length / 3;
      for (const [a, c] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        P.push((n[0] + u[0] * a + v[0] * c) / 2, (n[1] + u[1] * a + v[1] * c) / 2, (n[2] + u[2] * a + v[2] * c) / 2);
        N.push(...n); U.push((a + 1) / 2, (c + 1) / 2);
      }
      I.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
    return { positions: P, normals: N, uv0: U, submeshes: [I] };
  }
  if (name === 'Sphere') {
    const P = [], N = [], U = [], I = [], R = 12, S = 24;
    for (let j = 0; j <= R; j++) for (let i = 0; i <= S; i++) {
      const th = (j / R) * Math.PI, ph = (i / S) * Math.PI * 2;
      const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
      P.push(x / 2, y / 2, z / 2); N.push(x, y, z); U.push(i / S, 1 - j / R);
    }
    for (let j = 0; j < R; j++) for (let i = 0; i < S; i++) { const a = j * (S + 1) + i; I.push(a, a + 1, a + S + 1, a + 1, a + S + 2, a + S + 1); }
    return { positions: P, normals: N, uv0: U, submeshes: [I] };
  }
  return null;
}

/**
 * A loaded mesh made ready for the runtime: vertex colours as 0…1 floats (the extracted files write them as bytes,
 * 0…255 — DESIGN §33.9 says 0…1; both are accepted).
 */
export function normalizeMesh(m) {
  if (!m || !Array.isArray(m.positions)) return null;
  const c = m.colors;
  if (Array.isArray(c) && c.length) {
    let max = 0;
    for (let i = 0; i < c.length; i++) if (c[i] > max) max = c[i];
    if (max > 1.0001) m.colors = c.map((x) => x / 255);
  }
  return m;
}

export class FxLibrary {
  /**
   * @param {{ assets?: any, fetch?: typeof fetch, listUrl?: string, list?: any, decode?: (blob: Blob) => Promise<any> }} [opts]
   */
  constructor(opts = {}) {
    this.disposed = false;
    this._imageGeneration = 0;
    this.assets = opts.assets || null;
    this._defaultFetch = typeof fetch === 'function' ? cachedFetch : null;
    this.fetch = opts.fetch || this._defaultFetch;
    this.listUrl = opts.listUrl || FX_LIST_URL;
    this.list = isObj(opts.list) ? opts.list : null;
    this.groups = null;
    this._init = null;
    this._index = null;
    this._texInfo = null;
    this.descs = new Map();     // key → Promise<descriptor|null>
    this.defs = new Map();      // key → compiled EffectDef | null
    this.meshes = new Map();    // key → data | null (loaded)
    this.meshLoads = new Map(); // key → Promise
    this.images = new Map();    // `${key}|${half}` → { image, flipped, info } | null
    this.imageLoads = new Map();
    this.onGpu = new Set();     // the same ids once FxGL holds them (their images were let go: not decoded again)
    this.queue = [];
    this.active = 0;
    this.failed = new Set();
    this.listeners = new Set();
    this._ready = [new Map(), new Map()]; // completed dependency closures, separately for full / lite
    this._requests = new Map();
    this._requestAt = new Map();
    this._retryAt = new Map();
  }

  /** Load the file list (once). Resolves to `available`. */
  init() {
    if (this.disposed) return Promise.resolve(false);
    if (this._init) return this._init;
    this._init = (async () => {
      let list = this.list;
      if (!list && this.listUrl === FX_LIST_URL && this.fetch === this._defaultFetch) list = await loadFxList();
      else if (!list && this.fetch) {
        try {
          const res = await this.fetch(this.listUrl);
          if (res && res.ok) list = await res.json();
        } catch { /* no effects */ }
      }
      let groups = isObj(list?.groups) ? list.groups : null;
      if (!groups || !isObj(groups['fx/prefabs']) || !Object.keys(groups['fx/prefabs']).length) {
        // a Phase 1a extraction listed the effects in data/local-assets.json
        let local;
        try { local = this.assets?.local ? await this.assets.local() : null; } catch { local = null; }
        const g = isObj(local?.groups) ? local.groups : null;
        if (g && isObj(g['fx/prefabs']) && Object.keys(g['fx/prefabs']).length) groups = { fx: g.fx || {}, 'fx/prefabs': g['fx/prefabs'], 'fx/tex': g['fx/tex'] || {}, 'fx/mesh': g['fx/mesh'] || {} };
      }
      if (this.disposed) return false;
      this.groups = groups && isObj(groups['fx/prefabs']) ? groups : null;
      // computed once: the full set lists ~4,000 prefabs and `available` is read for every event
      this._available = false;
      if (this.groups) for (const _k in this.groups['fx/prefabs']) { this._available = true; break; }
      return this._available;
    })();
    return this._init;
  }

  /** Effects were extracted (the file list names prefabs). */
  get available() { return !this.disposed && !!this._available; }

  /** URL of a file-list entry. */
  url(group, key) {
    const e = this.groups?.[group]?.[key];
    return isObj(e) && typeof e.path === 'string' ? e.path : null;
  }

  has(key) { return !!this.url('fx/prefabs', String(key || '').toLowerCase()); }

  /** Only decoded / GPU-resident effects may replace the procedural effect of the current event. */
  ready(key, half = false) { return !!(this._readiness(key, half) & 2); }

  /** An intentionally empty, fully loaded prefab may accompany a drawable part without blocking it. */
  complete(key, half = false) { return !!(this._readiness(key, half) & 1); }

  _readiness(key, half) {
    if (this.disposed) return 0;
    const k = String(key || '').toLowerCase();
    if (!k || !this.has(k)) return 0;
    const status = this._status(k, !!half, new Set());
    if (status) this._ready[half ? 1 : 0].set(k, status);
    if (!status) this.request(k, half);
    return status;
  }

  // bit 1: every declared dependency loaded; bit 2: this prefab or a chained prefab can draw.
  _status(k, half, visiting) {
    const cache = this._ready[half ? 1 : 0];
    if (cache.has(k)) return cache.get(k);
    if (visiting.has(k)) return 1;
    const def = this.def(k);
    if (!def) return 0;
    for (const mesh of def.meshes) if (!this.meshes.get(mesh)) return 0;
    for (const texture of def.textures) {
      const id = `${texture}|${half ? 1 : 0}`;
      if (!this.images.get(id)?.image && !this.onGpu.has(id)) return 0;
    }
    const visible = (r, i) => r?.enabled && (!half || !def.lod?.disable.has(i))
      && r.mats.some(m => m != null && def.material(m, half));
    const meshReady = r => !!r.mesh && !!this.mesh(r.mesh);
    let drawable = def.psr.some((r, i) => visible(r, i) && def.ps[i] && r.mode !== 'none' && (r.mode !== 'mesh' || meshReady(r)))
      || [def.mesh, def.skinned].some(rows => rows.some((r, i) => visible(r, i) && meshReady(r)))
      || [def.trail, def.line].some(rows => rows.some((r, i) => visible(r, i)));
    visiting.add(k);
    for (const ref of def.refs) {
      const status = this._status(String(ref).toLowerCase(), half, visiting);
      if (!status) { visiting.delete(k); return 0; }
      drawable ||= !!(status & 2);
    }
    visiting.delete(k);
    const status = drawable ? 3 : 1;
    return status;
  }

  /** Decode already-installed files for later events; never replay the event that requested them. */
  request(key, half = false) {
    if (this.disposed) return;
    const k = String(key || '').toLowerCase(), id = `${k}|${half ? 1 : 0}`;
    const now = Date.now();
    if (!k || this._requests.has(id) || now < (this._requestAt.get(id) || 0)) return;
    this._requestAt.set(id, now + 250);
    const job = this.preload([k], { half: !!half }).catch(() => 0).finally(() => this._requests.delete(id));
    this._requests.set(id, job);
  }

  _canRead(url) {
    return !!url && Date.now() >= (this._retryAt.get(url) || 0)
      && (this.fetch !== this._defaultFetch || resourceCache.isCached(url));
  }

  async _json(url) {
    if (this.disposed || !url || !this.fetch) return null;
    const res = await this.fetch(url);
    if (this.disposed) return null;
    if (!res || !res.ok) throw new Error(`fx ${res ? res.status : 'no response'} ${url}`);
    return res.json();
  }

  /** index.json (null without one); its version tells mounts.js whether skins still need skinShift. */
  index() {
    if (this.disposed) return Promise.resolve(null);
    if (this._index) return this._index;
    this._index = this.init().then(() => {
      const url = this.url('fx', 'index');
      return this._canRead(url) ? this._json(url) : null;
    }).then((j) => { if (this.disposed) return null; setIndexVersion(j?.version); return j; }).catch(() => null)
      .then(j => { if (!j) this._index = null; return j; });
    return this._index;
  }

  /** textures.json entries (wrap / filter / mips by texture key), null until installed and loaded. */
  texInfo() {
    if (this.disposed) return Promise.resolve(null);
    if (this._texInfo) return this._texInfo;
    this._texInfo = this.init().then(() => {
      const url = this.url('fx', 'textures');
      return this._canRead(url) ? this._json(url) : null;
    }).catch(() => null).then(j => {
      if (this.disposed || !isObj(j?.textures)) { this._texInfo = null; return null; }
      return j.textures;
    });
    return this._texInfo;
  }

  /** Run fn under the parallel-load limit. */
  _limit(fn) {
    if (this.disposed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const run = () => {
        if (this.disposed) { resolve(null); return; }
        this.active++;
        Promise.resolve().then(() => this.disposed ? null : fn()).then(resolve, reject).finally(() => { this.active--; this.queue.shift()?.run(); });
      };
      if (this.active < MAX_PARALLEL) run(); else this.queue.push({ run, cancel: () => resolve(null) });
    });
  }

  /** The descriptor of a prefab key (null when absent / failed). */
  descriptor(key) {
    if (this.disposed) return Promise.resolve(null);
    const k = String(key || '').toLowerCase();
    let p = this.descs.get(k);
    if (!p) {
      p = this.init().then(() => {
        const url = this.url('fx/prefabs', k);
        return this._canRead(url) ? this._limit(() => this._json(url)) : null;
      }).catch((err) => { if (!this.disposed) {
        this.failed.add(k); this._retryAt.set(this.url('fx/prefabs', k), Date.now() + 5000);
        console.warn('[fx] prefab failed', k, err?.message || err);
      } return null; }).then(d => { if (!d) this.descs.delete(k); return d; });
      this.descs.set(k, p);
    }
    return p;
  }

  /** A compiled prefab if already loaded (else null; see load). */
  def(key) { return this.defs.get(String(key || '').toLowerCase()) || null; }

  /** Load and compile a prefab (with its meshes; textures load on first draw or through preload). */
  async load(key) {
    if (this.disposed) return null;
    const k = String(key || '').toLowerCase();
    if (this.defs.has(k)) return this.defs.get(k);
    const desc = await this.descriptor(k);
    if (this.disposed) return null;
    if (this.defs.has(k)) return this.defs.get(k);
    if (!desc) return null;
    const meshes = await Promise.all((desc.meshes || []).map((m) => this.loadMesh(m)));
    if (this.disposed) return null;
    if (meshes.some(m => !m)) return null;
    const def = compileEffect(desc, this);
    this.defs.set(k, def);
    return def;
  }

  /** Mesh data (sync; null while loading — the load is started). */
  mesh(key) {
    if (this.disposed || !key) return null;
    if (this.meshes.has(key)) return this.meshes.get(key);
    if (key.startsWith('builtin:')) { const m = builtinMesh(key.slice(8)); this.meshes.set(key, m); return m; }
    this.loadMesh(key);
    return null;
  }

  loadMesh(key) {
    if (this.disposed || !key) return Promise.resolve(null);
    if (this.meshes.has(key)) return Promise.resolve(this.meshes.get(key));
    if (key.startsWith('builtin:')) return Promise.resolve(this.mesh(key));
    let p = this.meshLoads.get(key);
    if (!p) {
      p = this.init().then(() => {
        const url = this.url('fx/mesh', key);
        return this._canRead(url) ? this._limit(() => this._json(url)) : null;
      }).catch(() => {
        this._retryAt.set(this.url('fx/mesh', key), Date.now() + 5000); return null;
      }).then((m) => {
        if (this.disposed) return null;
        const d = normalizeMesh(m);
        if (d) this.meshes.set(key, d); else this.meshLoads.delete(key);
        return d;
      });
      this.meshLoads.set(key, p);
    }
    return p;
  }

  /** A texture's image (sync; null while it loads — the load is started). */
  texture(key, half) {
    if (this.disposed) return null;
    const id = `${key}|${half ? 1 : 0}`;
    const r = this.images.get(id);
    if (r !== undefined) return r;
    this.loadTexture(key, half);
    return null;
  }

  loadTexture(key, half) {
    if (this.disposed) return Promise.resolve(null);
    const id = `${key}|${half ? 1 : 0}`;
    if (this.images.has(id)) return Promise.resolve(this.images.get(id));
    if (this.onGpu.has(id)) return Promise.resolve(null);
    let p = this.imageLoads.get(id);
    if (!p) {
      const generation = this._imageGeneration;
      const current = () => !this.disposed && generation === this._imageGeneration;
      p = Promise.all([this.init(), this.texInfo()]).then(async ([, infos]) => {
        if (!current() || !infos) return null;
        const e = this.groups?.['fx/tex']?.[key];
        const url = isObj(e) ? (half && typeof e.half === 'string' ? e.half : e.path) : null;
        if (!this._canRead(url)) return null;
        const img = await this._limit(() => current() ? this._image(url) : null);
        return img ? { image: img.image, flipped: img.flipped, info: infos[key] || {} } : null;
      }).then((r) => {
        if (!current()) { r?.image?.close?.(); return null; }
        if (r) { this.images.set(id, r); this._notify(); } else this.imageLoads.delete(id);
        return r;
      }, (err) => {
        if (!current()) return null;
        console.warn('[fx] texture failed', key, err?.message || err);
        const e = this.groups?.['fx/tex']?.[key];
        this._retryAt.set(half && e?.half ? e.half : e?.path, Date.now() + 5000);
        this.imageLoads.delete(id);
        return null;
      });
      this.imageLoads.set(id, p);
    }
    return p;
  }

  /** Decode an image: an ImageBitmap flipped for GL (v = 0 at the bottom row), else an HTMLImageElement. */
  async _image(url) {
    if (typeof createImageBitmap === 'function' && this.fetch) {
      const res = await this.fetch(url);
      if (!res.ok) throw new Error(`fx ${res.status} ${url}`);
      const blob = await res.blob();
      const image = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      return { image, flipped: true };
    }
    if (typeof Image === 'undefined') return null;
    const image = await loadImageElement(url);
    return { image, flipped: false };
  }

  /** Load prefabs (and the effects they chain), their meshes and textures. */
  async preload(keys, o = {}) {
    if (this.disposed) return 0;
    const seen = new Set();
    const loadKey = async (k) => {
      const key = String(k || '').toLowerCase();
      if (this.disposed || !key || seen.has(key)) return;
      seen.add(key);
      const def = await this.load(key);
      if (this.disposed || !def) return;
      const jobs = def.textures.map((t) => this.loadTexture(t, !!o.half));
      if (o.refs !== false) for (const r of def.refs) jobs.push(loadKey(r));
      await Promise.all(jobs);
    };
    await Promise.all([...new Set(keys)].map(loadKey));
    return seen.size;
  }

  /** Let a decoded image go once it is on the GPU (see FxGL.texture). */
  release(key, half) {
    const id = `${key}|${half ? 1 : 0}`;
    const r = this.images.get(id);
    if (r && r.image && typeof r.image.close === 'function') r.image.close();
    this.images.delete(id);
    this.imageLoads.delete(id);
    if (!this.disposed) this.onGpu.add(id);
  }

  /** The GPU let its textures go (FxGL destroyed): they load again when drawn. */
  forgetGpu() { this.onGpu.clear(); for (const cache of this._ready) cache.clear(); }

  onLoad(fn) { if (this.disposed) return () => {}; this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _notify() { if (!this.disposed) for (const fn of this.listeners) { try { fn(); } catch { /* ignore */ } } }

  /** Release decoded images (a context loss, the end of a session). */
  dropImages() {
    this._imageGeneration++;
    for (const r of this.images.values()) if (r && r.image && typeof r.image.close === 'function') r.image.close();
    this.images.clear();
    this.imageLoads.clear();
    this.onGpu.clear();
    for (const cache of this._ready) cache.clear();
  }

  /** End an owned library's session; in-flight decodes close themselves when they arrive. */
  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.dropImages();
    this.listeners.clear();
    for (const job of this.queue.splice(0)) job.cancel();
    this.descs.clear(); this.defs.clear(); this.meshes.clear(); this.meshLoads.clear();
    this.failed.clear();
    this._requests.clear(); this._requestAt.clear(); this._retryAt.clear();
    this.groups = null;
    this.list = null;
    this._init = this._index = this._texInfo = null;
  }
}
