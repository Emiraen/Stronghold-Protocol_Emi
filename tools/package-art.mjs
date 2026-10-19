import { splitHashedPath } from '../shared/assetPaths.js';
export function plainRel(url) {
  if (typeof url !== 'string' || /[?#\\]/.test(url) || url.includes('\0')) return null;
  const split = splitHashedPath(url);
  if (!split.hash) return null;
  let path;
  try { path = decodeURIComponent(split.path); } catch { return null; }
  if (path.includes('\0') || path.includes('\\')) return null;
  if (!path.startsWith('/assets/') && !path.startsWith('/fonts/')) return null;
  const segs = path.slice(1).split('/');
  if (segs.some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return { rel: segs.join('/'), hash: split.hash, url };
}

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSpine(value) {
  return isObj(value) && typeof value.skel === 'string' && value.skel.startsWith('/') && /\.skel$/.test(value.skel);
}

/** Skeleton, atlas, then pages. No pages listed → the default `<skel>.png` under the same hash, as the server does. */
function spineMemberUrls(obj) {
  const out = [obj.skel];
  if (typeof obj.atlas === 'string' && obj.atlas) out.push(obj.atlas);
  const pages = Array.isArray(obj.textures) ? obj.textures.filter((url) => typeof url === 'string' && url) : [];
  out.push(...(pages.length ? pages : [obj.skel.replace(/\.skel$/, '.png')]));
  return out;
}

/**
 * The import plan of the served manifests (already hashed). Unhashed URLs are left out: they cannot be checked.
 * `files` is the standalone map. `groups` are Spine models in server member order. `rels` is every rel either names.
 * @param {object | null} assets served /data/assets.json
 * @param {object | null} local served /data/local-assets.json
 */
export function planFromManifests(assets, local) {
  return planFrom(assets, local);
}

/**
 * The local groups of /data/local-assets.json and /data/local-fx.json (the official battle effects, DESIGN §33) as one
 * `{ groups }` manifest: their group names never overlap (fx groups are `fx…`); null when the host has neither.
 * @param {object | null} local
 * @param {object | null} fx
 */
export function mergeLocalManifests(local, fx) {
  if (!local && !fx) return null;
  return { groups: { ...((local && local.groups) || {}), ...((fx && fx.groups) || {}) } };
}

function planFrom(assets, local) {
  /** @type {Map<string, { hash: string, url: string, alts: { hash: string, url: string }[] }>} */
  const files = new Map();
  /** @type {{ hash: string, members: { rel: string, url: string }[] }[]} */
  const groups = [];

  const addStandalone = (url) => {
    const info = plainRel(url);
    if (!info) return;
    const cur = files.get(info.rel);
    if (!cur) {
      files.set(info.rel, { hash: info.hash, url: info.url, alts: [] });
      return;
    }
    if (cur.hash === info.hash || cur.alts.some((alt) => alt.hash === info.hash && alt.url === info.url)) return;
    cur.alts.push({ hash: info.hash, url: info.url });
  };

  const considerSpine = (urls) => {
    const members = [];
    let hash = null;
    for (const url of urls) {
      const info = plainRel(url);
      if (!info) return;
      if (hash == null) hash = info.hash;
      else if (hash !== info.hash) return;
      members.push({ rel: info.rel, url: info.url });
    }
    if (members.length) groups.push({ hash, members });
  };

  const walkPlain = (value) => {
    if (typeof value === 'string') { addStandalone(value); return; }
    if (Array.isArray(value)) { value.forEach(walkPlain); return; }
    if (!isObj(value)) return;
    for (const child of Object.values(value)) walkPlain(child);
  };

  const walkAssets = (value) => {
    if (typeof value === 'string') { addStandalone(value); return; }
    if (Array.isArray(value)) { value.forEach(walkAssets); return; }
    if (!isObj(value)) return;
    if (isSpine(value)) {
      considerSpine(spineMemberUrls(value));
      for (const [key, child] of Object.entries(value)) {
        if (key === 'skel' || key === 'atlas' || key === 'textures') continue;
        walkAssets(child);
      }
      return;
    }
    for (const child of Object.values(value)) walkAssets(child);
  };

  if (isObj(assets)) walkAssets(assets);
  if (isObj(local)) {
    const groupsDoc = local.groups;
    const rest = { ...local };
    delete rest.groups;
    walkPlain(rest);
    if (isObj(groupsDoc)) {
      for (const [name, entries] of Object.entries(groupsDoc)) {
        if (name.startsWith('spine/') && isObj(entries)) {
          const names = Object.keys(entries)
            .filter((key) => isObj(entries[key]) && typeof entries[key].path === 'string')
            .sort();
          if (names.length) considerSpine(names.map((key) => entries[key].path));
          for (const [key, entry] of Object.entries(entries)) {
            if (names.includes(key)) {
              for (const [field, child] of Object.entries(entry)) if (field !== 'path') walkPlain(child);
            } else walkPlain(entry);
          }
        } else walkPlain(entries);
      }
    }
  }

  const rels = new Set(files.keys());
  for (const group of groups) for (const member of group.members) rels.add(member.rel);
  return { files, groups, rels };
}

/**
 * One served manifest: null for a 404 of an optional one, else its JSON; any other answer throws `{ code: 'manifest' }`
 * (an HTML page instead of JSON included — a proxy's error page must never read as an empty manifest).
 */
