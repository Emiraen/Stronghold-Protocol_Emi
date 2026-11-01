// The asset catalog's legacy sea-born model is the blue 升华 skin, never the original summon.
// The default has no battle Spine in research 07 / fexli; keep its original avatar fallback.
export const SKADI_SEABORN = 'token_10017_skadi2_dedant';
export const SKADI_CHAR = 'char_1012_skadi2';
const ITERATION_ROOT = '/assets/spine/token/token_10017_skadi2_dedant/token_10017_skadi2_dedant_iteration_2';
export const SKADI_ITERATION_ENTRY = {
  skel: ITERATION_ROOT + '.skel', atlas: ITERATION_ROOT + '.atlas', textures: [ITERATION_ROOT + '.png'], pma: false,
  anims: { idle: 'Idle', deploy: 'Start', attack: { begin: null, loop: 'Idle', end: null, via: 'idle' },
    attackDown: null, skill: { begin: null, loop: 'Skill', end: null, index: 0, idle: null }, die: null, move: null, stun: null },
  animations: { Default: 0, Idle: 1.333, Skill: 1.333, Start: 1 }, events: ['OnAttack', 'OnStart'],
  hits: { Skill: [0.333] }, bounds: { x: -224.26, y: -3.388, width: 394.175, height: 379.18 },
};

export function skinSummonUrls(skinId) {
  return skinId === SKADI_CHAR + '@iteration#2'
    ? [SKADI_ITERATION_ENTRY.skel, SKADI_ITERATION_ENTRY.atlas, ...SKADI_ITERATION_ENTRY.textures] : [];
}

const tokenOwners = new WeakMap();
function ownersOf(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  let owners = tokenOwners.get(manifest);
  if (owners) return owners;
  owners = new Map([[SKADI_SEABORN, new Set([SKADI_CHAR])]]);
  const add = (tokenId, charId) => {
    if (!owners.has(tokenId)) owners.set(tokenId, new Set());
    owners.get(tokenId).add(charId);
  };
  for (const [tokenId, token] of Object.entries(manifest.tokens || {})) {
    if (typeof token?.owner === 'string') add(tokenId, token.owner);
  }
  for (const [charId, character] of Object.entries(manifest.chars || {})) {
    for (const skin of Object.values(character?.skins || {})) {
      for (const tokenId of Object.keys(skin?.tokens || {})) add(tokenId, charId);
    }
  }
  tokenOwners.set(manifest, owners);
  return owners;
}

/** Prefer an explicit source unit; legacy snapshots must have one unambiguous player-local appearance. */
export function tokenOwnerSkin(token, units, manifest) {
  if (token?.ownerId == null) return null;
  const owners = ownersOf(manifest)?.get(token.defId)
    || (token.defId === SKADI_SEABORN ? new Set([SKADI_CHAR]) : null);
  if (!owners?.size) return null;
  const exactIds = [token.ownerUnitId, token.sourceUnitId].filter(id => id != null);
  const exactUids = [token.ownerUid, token.sourceUid].filter(id => id != null);
  const precise = exactIds.length || exactUids.length;
  const skins = new Set();
  for (const unit of units || []) {
    if (unit?.kind !== 'op' || unit.side !== (token.side || 'ally') || unit.ownerId !== token.ownerId) continue;
    if (![unit.spine, unit.avatar, unit.diy?.charId].some(id => typeof id === 'string' && owners.has(id.replace(/_(1|2)$/, '')))) continue;
    if (precise && !exactIds.includes(unit.id) && !exactUids.includes(unit.uid)) continue;
    skins.add(unit.skin || null);
  }
  return skins.size === 1 ? [...skins][0] : null;
}

/** Skin token entries are optional: only a complete, already cached model may replace the base model. */
export function tokenSkinEntry(manifest, tokenId, skinId, { isCached } = {}) {
  if (!skinId) return null;
  for (const charId of ownersOf(manifest)?.get(tokenId) || []) {
    const entry = manifest.chars?.[charId]?.skins?.[skinId]?.tokens?.[tokenId];
    if (!entry || typeof entry.skel !== 'string' || !entry.skel.endsWith('.skel')
      || typeof entry.atlas !== 'string' || !entry.anims || !Array.isArray(entry.textures) || !entry.textures.length) continue;
    const urls = [entry.skel, entry.atlas, ...entry.textures];
    if (urls.every(url => typeof url === 'string' && url && isCached?.(url))) return entry;
  }
  return null;
}

/** A battle's legacy UnitInfo has no summoner link. Accept only an unambiguous appearance of this player's Skadi. */
export function seabornOwnerSkin(token, units) {
  return token?.defId === SKADI_SEABORN ? tokenOwnerSkin(token, units) : null;
}

/** Follow the owner's actually available battle skin; an absent optional model never triggers a download. */
export function seabornSkinEntry(character, token, skinId, { isSkinCached, isCached } = {}) {
  const skin = character?.skins?.[skinId];
  if (!skin || !isSkinCached?.(skin)) return null;
  let entry = null;
  if (skinId === SKADI_CHAR + '@boc#4' && token?.spineVariant === SKADI_SEABORN + '_boc_4') entry = token.spine;
  if (skinId === SKADI_CHAR + '@iteration#2') entry = SKADI_ITERATION_ENTRY;
  const urls = entry && [entry.skel, entry.atlas, ...(entry.textures || [])];
  return urls?.length && urls.every(url => isCached?.(url)) ? entry : null;
}
