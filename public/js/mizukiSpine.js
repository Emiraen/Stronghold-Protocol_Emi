// Extracted models retain native parser ownership while sharing Stronghold's resource IO.
import { createAssets } from './assets.js';
import { cachedFetch } from './resourceCache.js';

const PREFIXES = ['/assets/mizuki/library/spines/', '/assets/mizuki/native-facilities/spines/'];
const privatePath = value => typeof value === 'string' && PREFIXES.some(prefix => value.startsWith(prefix));
const owned = new WeakMap();

export function isMizukiSpine(entry) {
  return !!entry && privatePath(entry.skel)
    && privatePath(entry.atlas)
    && Array.isArray(entry.textures) && entry.textures.length > 0
    && entry.textures.every(privatePath);
}

function dispose(resources) {
  if (!resources || resources.disposed) return;
  resources.disposed = true;
  try { resources.atlas?.dispose?.(); } finally {
    for (const texture of resources.textures) texture.destroy?.(!texture.baseTexture?.destroyed);
  }
}

async function nativeTexture(buffer, PIXI) {
  const header = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 12));
  const webp = header.length === 12 && String.fromCharCode(...header.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...header.subarray(8, 12)) === 'WEBP';
  const url = URL.createObjectURL(new Blob([buffer], { type: webp ? 'image/webp' : 'image/png' }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve; image.onerror = () => reject(new Error('Mizuki model texture failed')); image.src = url;
    });
    return new PIXI.Texture(new PIXI.BaseTexture(image));
  } finally { URL.revokeObjectURL(url); }
}

function nativeParser(PIXI, url) {
  const parser = PIXI.Assets?.loader?.parsers?.find(item => {
    try { return typeof item.parse === 'function' && item.test?.(url) === true; } catch { return false; }
  });
  if (!parser) throw new Error('Native Spine parser unavailable: ' + url);
  return parser;
}

/** Native atlas/skeleton parsers, local source files, separate ref-counted ownership. */
export async function loadMizukiSpine(entry, options = {}) {
  // A private Mizuki asset store may also load the original Stronghold
  // operators from this installation. Never install or replace shared PIXI IO.
  const sameOriginAsset = value => {
    if (typeof value !== 'string') return false;
    try {
      const origin = globalThis.location?.origin || 'http://localhost';
      const parsed = new URL(value, origin);
      return parsed.origin === origin && parsed.pathname.startsWith('/assets/');
    } catch { return false; }
  };
  const localEntry = options.allowLocal === true && entry && [entry.skel, entry.atlas, ...(entry.textures || [])].every(sameOriginAsset)
    && Array.isArray(entry.textures) && entry.textures.length > 0;
  if (!isMizukiSpine(entry) && !localEntry) throw new Error('Not a Mizuki extracted model');
  const PIXI = options.PIXI || globalThis.PIXI;
  if (!PIXI?.spine || !PIXI.Assets?.loader) throw new Error('PIXI / pixi-spine not loaded');
  const request = options.fetch || cachedFetch;
  const makeTexture = options.makeTexture || nativeTexture;
  const read = async url => {
    const response = await request(url, { credentials: 'same-origin' });
    if (!response?.ok) throw new Error('Mizuki model file unavailable: ' + url);
    const buffer = await response.arrayBuffer();
    const name = url.slice(url.lastIndexOf('/') + 1);
    const expected = entry.files?.find(file => file.name === name);
    const sharedRecord = request === cachedFetch;
    if (!sharedRecord && expected && buffer.byteLength !== expected.bytes) throw new Error('Mizuki model file size mismatch: ' + name);
    if (!sharedRecord && expected?.sha256 && globalThis.crypto?.subtle) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
      const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== expected.sha256) throw new Error('Mizuki model file hash mismatch: ' + name);
    }
    return buffer;
  };
  const resources = { atlas: null, textures: [], disposed: false };
  try {
    const [skeleton, atlasBytes, ...pages] = await Promise.all([entry.skel, entry.atlas, ...entry.textures].map(read));
    const images = {};
    // Sequential ownership makes partial failures release every texture already created.
    for (let index = 0; index < pages.length; index++) {
      const texture = await makeTexture(pages[index], PIXI);
      resources.textures.push(texture);
      images[entry.textures[index].slice(entry.textures[index].lastIndexOf('/') + 1)] = texture;
    }
    // Follow the native asynchronous page-loader contract. The parser's synchronous
    // `images` shortcut can resolve before its atlas variable has been assigned.
    const loader = { load: async asset => {
      const url = typeof asset === 'string' ? asset : asset.src;
      const texture = images[url.slice(url.lastIndexOf('/') + 1)];
      if (!texture) throw new Error('Unlisted Mizuki atlas page: ' + url);
      return texture;
    } };
    resources.atlas = await nativeParser(PIXI, entry.atlas).parse(new TextDecoder().decode(atlasBytes),
      { src: entry.atlas, data: {} }, loader);
    if (!Array.isArray(resources.atlas?.pages)) throw new Error('Native Mizuki atlas parser returned no atlas');
    const parsed = await nativeParser(PIXI, entry.skel).parse(skeleton,
      { src: entry.skel, data: { spineAtlas: resources.atlas } }, loader);
    const data = parsed?.spineData || parsed;
    if (!data || !Array.isArray(data.animations)) throw new Error('Bad Mizuki Spine data: ' + entry.skel);
    owned.set(data, resources);
    return data;
  } catch (error) { dispose(resources); throw error; }
}

export function unloadMizukiSpine(_entry, data) {
  const resources = owned.get(data);
  dispose(resources); owned.delete(data);
}

/** Native operators keep the existing cache. Only extracted entries use this cache. */
export function createMizukiSpineCache(base, options = {}) {
  const extracted = createAssets({ manifest: { version: 1 },
    loadSpine: entry => loadMizukiSpine(entry, options), unloadSpine: unloadMizukiSpine }).spine;
  const cache = entry => isMizukiSpine(entry) ? extracted : base;
  return {
    acquire: (entry, opts) => cache(entry).acquire(entry, opts),
    restart: entry => cache(entry).restart(entry),
    release: entry => cache(entry).release(entry),
    peek: entry => cache(entry).peek(entry),
    hold: () => { const a = base.hold(); const b = extracted.hold(); return () => { a(); b(); }; },
    clear: () => extracted.clear(),
    stats: () => {
      const shared = base.stats(); const local = extracted.stats();
      const combined = {};
      for (const key of Object.keys(shared)) combined[key] = typeof shared[key] === 'number' ? shared[key] + (local[key] || 0) : shared[key];
      return { ...combined, extracted: local };
    },
    cache: extracted.cache,
  };
}

const NHKODO = 'enemy_1271_nhkodo';
export function mizukiSpineEntry(id, entry) {
  if (id === 'enemy_2037_sygirl' && entry) return { ...entry, anims: { ...entry.anims,
    idle: 'C1_Idle', deploy: 'C1_Idle', die: 'C1_Die',
    move: { begin: null, loop: 'C1_Move', end: null }, attack: { begin: null, loop: 'C1_Attack', end: null } } };
  if (id !== NHKODO || !entry) return entry;
  return { ...entry, anims: { ...entry.anims, idle: 'Idle_A', deploy: 'Idle_A', die: 'Die_A',
    move: { begin: null, loop: 'Move_A', end: null }, attack: { begin: null, loop: 'Attack_A2', end: null },
    skill: { begin: null, loop: 'Attack_A', end: null }, skills: { 0: { begin: null, loop: 'Attack_A', end: null } } } };
}
export function adaptMizukiUnitView(view) {
  if (!view || view.info?.defId !== NHKODO || view.__mizukiForms) return view;
  view.__mizukiForms = true;
  const normalSpec = view._formSpec.bind(view), normalSet = view.setForm.bind(view);
  const devoured = { roles: { idle: 'Idle_B', deploy: 'Idle_B', die: 'Die_B',
    move: { begin: null, loop: 'Move_B', end: null }, attack: { begin: null, loop: 'Attack_B', end: null } } };
  view._formSpec = () => view.form === 'devoured' ? devoured : normalSpec();
  view.setForm = (kind, fx) => {
    if (kind !== 'devoured' && view.form !== 'devoured') return normalSet(kind, fx);
    if (kind !== null && kind !== 'devoured') return normalSet(kind, fx);
    if (view.form === kind) return;
    view.form = kind; view.info.form = kind; view.actor?.setForm(kind ? devoured.roles : null);
  };
  return view;
}
