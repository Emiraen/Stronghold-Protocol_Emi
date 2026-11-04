// Official skin effect replacements are scoped to the player using that skin.
// The catalog is small metadata; optional payload is read only after installation.
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const catalogs = new WeakMap();

export function mergeSkinFxCatalog(index, catalog) {
  if (!object(index) || !object(catalog)) return index;
  return { ...index,
    units: object(catalog.units) ? { ...index.units, ...catalog.units } : index.units,
    skills: object(catalog.skills) ? { ...index.skills, ...catalog.skills } : index.skills,
    prefabs: { ...index.prefabs, ...(catalog.prefabs || {}) },
    projectiles: { ...index.projectiles, ...(catalog.projectiles || {}) },
    skins: { ...index.skins, ...(catalog.skins || {}) },
    skinOverrides: { ...index.skinOverrides, ...(catalog.skinOverrides || {}) },
  };
}

function mapped(value, replacements, seen) {
  if (typeof value === 'string') return replacements[lower(value)] || value;
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const out = Array.isArray(value) ? [] : {};
  seen.set(value, out);
  for (const [key, child] of Object.entries(value)) out[key] = mapped(child, replacements, seen);
  return out;
}

function tableView(table, replacements, seen, decorate = value => value) {
  const source = object(table) ? table : {};
  const cache = new Map();
  return new Proxy(source, { get(target, key) {
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(target, key)) return Reflect.get(target, key);
    if (!cache.has(key)) cache.set(key, decorate(mapped(target[key], replacements, seen), key));
    return cache.get(key);
  } });
}

function scopeFor(index, skinId, override) {
  const replacements = {};
  for (const [from, to] of Object.entries(override.replacements || {})) if (from && typeof to === 'string' && to) replacements[lower(from)] = lower(to);
  const seen = new WeakMap();
  const tokenIds = new Set((override.tokenIds || []).filter(id => typeof id === 'string'));
  const projectiles = { ...(index.projectiles || {}) };
  for (const record of override.fakeProjectiles || []) {
    const origin = lower(record.originProjectileKey), graphic = lower(record.graphicProjectileKey);
    if (!origin || !graphic || !object(projectiles[graphic])) continue;
    const visual = { ...projectiles[graphic] };
    if (Number.isInteger(record._fakeMuzzlePoint)) visual.skinMuzzle = record._fakeMuzzlePoint;
    projectiles[origin] = visual;
  }
  return { ...index,
    units: tableView(index.units, replacements, seen, (unit, key) => tokenIds.has(key) ? { ...unit, skin: skinId + '::' + key } : key === override.charId || unit?.skin === override.charId ? { ...unit, skin: skinId } : unit),
    skills: tableView(index.skills, replacements, seen),
    projectiles: tableView(projectiles, replacements, seen),
    skinId, skinReplacements: replacements,
  };
}

export function skinFxIndex(index, skinId, isCached, now = Date.now()) {
  if (!object(index) || typeof skinId !== 'string' || !skinId) return index;
  const override = index.skinOverrides?.[skinId];
  if (!object(override) || !Array.isArray(override.resources) || !override.resources.length || typeof isCached !== 'function') return index;
  let entries = catalogs.get(index);
  if (!entries) catalogs.set(index, entries = new Map());
  let entry = entries.get(skinId);
  if (!entry) entries.set(skinId, entry = { next: 0, installed: false, scope: null });
  if (now >= entry.next) {
    entry.installed = override.resources.every(url => typeof url === 'string' && !!url && isCached(url));
    entry.next = now + 500;
  }
  if (!entry.installed) return index;
  if (!entry.scope) entry.scope = scopeFor(index, skinId, override);
  return entry.scope;
}

export function skinEffectKey(index, key) {
  const k = lower(key);
  return k ? index?.skinReplacements?.[k] || k : null;
}
