import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tokenOwnerSkin, tokenSkinEntry, seabornOwnerSkin, seabornSkinEntry, skinSummonUrls,
  SKADI_CHAR, SKADI_SEABORN, SKADI_ITERATION_ENTRY } from '../../public/js/tokenSkins.js';
import { spineEntry, isSkinCached } from '../../public/js/assets.js';
import { resourceCache } from '../../public/js/resourceCache.js';
import { renderInfo } from '../../public/js/render/app/info.js';
import { unitInfo } from '../../server/sim/snapshot.js';

const CHAR = 'char_1033_swire2', TOKEN = 'token_10031_swire2_gdtrap', SKIN = CHAR + '@nlc#1';
const entry = name => ({ skel: '/assets/' + name + '.skel', atlas: '/assets/' + name + '.atlas',
  textures: ['/assets/' + name + '.png'], anims: { idle: 'Idle' } });
const model = entry('swire_nlc'), base = entry('swire_base');
const manifest = { chars: { [CHAR]: { skins: { [SKIN]: { tokens: { [TOKEN]: model } } } } },
  tokens: { [TOKEN]: { owner: CHAR, spine: base } } };
const token = { id: 5, kind: 'token', defId: TOKEN, side: 'ally', ownerId: 'alice' };
const operator = (id, patch = {}) => ({ id, uid: 'uid-' + id, kind: 'op', spine: CHAR,
  side: 'ally', ownerId: 'alice', skin: SKIN, ...patch });

test('table-backed token skins follow the same player and side without hardcoded operator IDs', () => {
  assert.equal(tokenOwnerSkin(token, [operator(1)], manifest), SKIN);
  assert.equal(tokenOwnerSkin(token, [operator(1, { ownerId: 'bob' })], manifest), null);
  assert.equal(tokenOwnerSkin(token, [operator(1, { side: 'enemy' })], manifest), null);
  assert.equal(tokenOwnerSkin({ ...token, ownerId: null }, [operator(1)], manifest), null);
  const cid = 'char_999_future', tid = 'token_future', sid = cid + '@future#1';
  const future = { chars: { [cid]: { skins: { [sid]: { tokens: { [tid]: model } } } } } };
  assert.equal(tokenOwnerSkin({ ...token, defId: tid }, [operator(1, { spine: cid, skin: sid })], future), sid);
});

test('duplicates agree only when their appearance agrees, and explicit unit or roster identity resolves them', () => {
  const a = operator(1), b = operator(2, { skin: CHAR + '@ambienceSynesthesia#4' });
  assert.equal(tokenOwnerSkin(token, [a, b], manifest), null);
  assert.equal(tokenOwnerSkin(token, [a, operator(2)], manifest), SKIN);
  assert.equal(tokenOwnerSkin(token, [a, operator(2, { skin: null })], manifest), null);
  assert.equal(tokenOwnerSkin({ ...token, ownerUnitId: 1 }, [a, b], manifest), SKIN);
  assert.equal(tokenOwnerSkin({ ...token, sourceUnitId: 2 }, [a, b], manifest), b.skin);
  assert.equal(tokenOwnerSkin({ ...token, ownerUid: a.uid }, [a, b], manifest), SKIN);
  assert.equal(tokenOwnerSkin({ ...token, sourceUid: b.uid }, [a, b], manifest), b.skin);
  assert.equal(tokenOwnerSkin({ ...token, ownerUnitId: 99 }, [a, b], manifest), null);
  assert.equal(tokenOwnerSkin({ ...token, ownerUnitId: 2 }, [a, { ...b, ownerId: 'bob' }], manifest), null);
});

test('promoted and DIY source identities retain table-backed ownership', () => {
  assert.equal(tokenOwnerSkin(token, [operator(1, { spine: CHAR + '_2' })], manifest), SKIN);
  assert.equal(tokenOwnerSkin(token, [operator(1, { spine: 'diy_slot', diy: { charId: CHAR } })], manifest), SKIN);
  assert.equal(tokenOwnerSkin(token, [operator(1, { spine: 'char_2025_shu' })], manifest), null);
});

test('a complete optional token model is selected using only its own cached resources', () => {
  const urls = [model.skel, model.atlas, ...model.textures], cached = new Set(urls);
  assert.equal(tokenSkinEntry(manifest, TOKEN, SKIN, { isCached: url => cached.has(url) }), model);
  for (const missing of urls) {
    assert.equal(tokenSkinEntry(manifest, TOKEN, SKIN, { isCached: url => url !== missing }), null);
  }
  assert.equal(tokenSkinEntry(manifest, TOKEN, SKIN), null);
  assert.equal(tokenSkinEntry(manifest, TOKEN, null, { isCached: () => true }), null);
  assert.equal(tokenSkinEntry(manifest, 'token_unknown', SKIN, { isCached: () => true }), null);
});

test('asset resolver selects installed metadata model and preserves the base model for partial caches', () => {
  const previous = resourceCache.isCached;
  try {
    resourceCache.isCached = () => true;
    assert.equal(spineEntry(manifest, TOKEN, { skin: SKIN }), model);
    resourceCache.isCached = url => url !== model.atlas;
    assert.equal(spineEntry(manifest, TOKEN, { skin: SKIN }), base);
    assert.equal(spineEntry(manifest, TOKEN), base);
  } finally { resourceCache.isCached = previous; }
});

test('skin installation stays incomplete when its metadata summon model is missing', () => {
  const skin = { spine: { front: base }, tokens: { [TOKEN]: model } };
  const previous = resourceCache.isCached;
  try {
    resourceCache.isCached = () => true;
    assert.equal(isSkinCached(skin), true);
    resourceCache.isCached = url => url !== model.atlas;
    assert.equal(isSkinCached(skin), false);
  } finally { resourceCache.isCached = previous; }
});

test('a skin checked before manifest readiness still requires its portrait after indexing completes', () => {
  const skin = { avatar: '/assets/skin-avatar.png', portrait: '/assets/skin-portrait.png', spine: { front: base } };
  const previous = { isCached: resourceCache.isCached, isManaged: resourceCache.isManaged };
  let indexed = false;
  try {
    resourceCache.isManaged = () => indexed;
    resourceCache.isCached = url => url !== skin.portrait;
    assert.equal(isSkinCached(skin), true);
    indexed = true;
    assert.equal(isSkinCached(skin), false);
    resourceCache.isCached = () => true;
    assert.equal(isSkinCached(skin), true);
  } finally { Object.assign(resourceCache, previous); }
});

test('legacy Skadi owner inference and both historical skin models keep their original cache gates', () => {
  const sea = { ...token, defId: SKADI_SEABORN };
  const owner = operator(1, { spine: SKADI_CHAR, skin: SKADI_CHAR + '@iteration#2' });
  assert.equal(seabornOwnerSkin(sea, [owner]), owner.skin);
  assert.equal(tokenOwnerSkin(sea, [owner], manifest), owner.skin);
  assert.equal(seabornOwnerSkin(token, [owner]), null);
  const character = { skins: { [owner.skin]: {}, [SKADI_CHAR + '@boc#4']: {} } };
  const options = { isSkinCached: () => true, isCached: () => true };
  assert.equal(seabornSkinEntry(character, {}, owner.skin, options), SKADI_ITERATION_ENTRY);
  assert.equal(seabornSkinEntry(character, {}, owner.skin, { ...options, isCached: () => false }), null);
  assert.equal(seabornSkinEntry(character, {}, owner.skin, { ...options, isSkinCached: () => false }), null);
  assert.equal(seabornSkinEntry(character, { spine: base, spineVariant: SKADI_SEABORN + '_boc_4' }, SKADI_CHAR + '@boc#4', options), base);
  assert.equal(seabornSkinEntry(character, { spine: base }, SKADI_CHAR + '@boc#4', options), null);
  assert.deepEqual(skinSummonUrls(owner.skin), [SKADI_ITERATION_ENTRY.skel, SKADI_ITERATION_ENTRY.atlas, ...SKADI_ITERATION_ENTRY.textures]);
  const previous = resourceCache.isCached;
  try {
    resourceCache.isCached = () => true;
    assert.equal(spineEntry({ tokens: { [SKADI_SEABORN]: { spine: base } } }, SKADI_SEABORN), null);
  } finally { resourceCache.isCached = previous; }
});

test('renderer boundary preserves explicit source identity and both battle entrypoints use metadata mapping', () => {
  const info = renderInfo({ ...token, ownerUnitId: 10, sourceUnitId: 11, ownerUid: 'a', sourceUid: 'b' });
  assert.equal(info.ownerUnitId, 10); assert.equal(info.sourceUnitId, 11);
  assert.equal(info.ownerUid, 'a'); assert.equal(info.sourceUid, 'b');
  for (const source of ['../../public/js/render/app.js', '../../public/js/mizukiNativeApp.js']) {
    const text = readFileSync(new URL(source, import.meta.url), 'utf8');
    assert.ok(text.includes('tokenOwnerSkin(info, infos.values(), assets.manifest)'), source);
  }
});

test('only actual summon snapshots carry their precise source unit, and the renderer uses it for duplicates', () => {
  const a = operator(1), b = operator(2, { skin: null });
  const snapshot = unitInfo({ ...token, ownerUnit: { id: a.id }, s: { maxHp: 1 }, def: {} });
  assert.equal(snapshot.ownerUnitId, a.id);
  assert.equal(tokenOwnerSkin(renderInfo(snapshot), [a, b], manifest), SKIN);
  assert.equal(Object.hasOwn(unitInfo({ ...a, s: { maxHp: 1 }, def: {} }), 'ownerUnitId'), false);
  assert.equal(Object.hasOwn(unitInfo({ ...token, s: { maxHp: 1 }, def: {} }), 'ownerUnitId'), false);
});
