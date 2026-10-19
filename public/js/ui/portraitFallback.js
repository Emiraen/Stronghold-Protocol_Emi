// Extra artwork uses the operator's original low-resolution art until it has been preloaded.
const indexes = new WeakMap();
const pathOf = value => {
  if (typeof value !== 'string' || !value) return null;
  try { return new URL(value, 'http://localhost/').pathname; } catch { return null; }
};

export function personalImageFallback(src, manifest) {
  const path = pathOf(src);
  if (!path || !/^\/assets\/char\/(?:portrait|skin_avatar|avatar)\//.test(path)) return null;
  if (manifest && typeof manifest === 'object') {
    let index = indexes.get(manifest);
    if (!index) {
      index = new Map();
      for (const character of Object.values(manifest.chars || {})) {
        for (const field of ['portrait', 'avatar']) {
          const elitePath = pathOf(character?.[`${field}E2`]);
          const original = character?.[field];
          if (elitePath && typeof original === 'string' && original && elitePath !== pathOf(original)) index.set(elitePath, original);
        }
        for (const skin of Object.values(character?.skins || {})) {
          for (const field of ['portrait', 'avatar']) {
            const skinPath = pathOf(skin?.[field]);
            const original = character?.[field];
            if (skinPath && typeof original === 'string' && original) index.set(skinPath, original);
          }
        }
      }
      indexes.set(manifest, index);
    }
    if (index.has(path)) return index.get(path);
  }
  const elite = path.match(/^\/assets\/char\/(portrait|avatar)\/(char_\d+_[A-Za-z0-9]+)_2\.png$/);
  if (elite) return elite[1] === 'portrait'
    ? `/assets/char/portrait/${elite[2]}_1.png` : `/assets/char/avatar/${elite[2]}.png`;
  // The filenames carry the canonical operator id, including before assets.json is available.
  const match = path.match(/^\/assets\/char\/(portrait\/skin|skin_avatar|avatar\/skin)\/(char_\d+_[A-Za-z0-9]+)_[A-Za-z0-9_.-]+\.png$/);
  if (!match) return null;
  return match[1] === 'portrait/skin'
    ? `/assets/char/portrait/${match[2]}_1.png` : `/assets/char/avatar/${match[2]}.png`;
}
