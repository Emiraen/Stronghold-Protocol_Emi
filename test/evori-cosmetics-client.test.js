import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NEW_RANK_CARD_IDS, nextNameCardNotice, updateNameCardNotice } from '../public/js/ui/nameCardNotices.js';
import { seatAvatar, seatPortrait, isSpecialCardPortrait } from '../public/js/ui/seatArt.js';
import { hFresh } from '../public/js/ui/components.js';
import { CachedImage } from '../public/js/ui/cachedImage.js';
import { resourceCache } from '../public/js/resourceCache.js';

test('new reward notice ignores historical initial grants but includes this update rewards', () => {
  const old = ['special_good_boy', 'special_trickster'];
  assert.deepEqual(nextNameCardNotice(null, old).unread, []);
  const introduced = nextNameCardNotice(null, [...old, ...NEW_RANK_CARD_IDS]);
  assert.deepEqual(introduced.unread, NEW_RANK_CARD_IDS);
  assert.deepEqual(nextNameCardNotice(introduced, introduced.observed).unread, NEW_RANK_CARD_IDS);
  const read = nextNameCardNotice(introduced, introduced.observed, true);
  assert.deepEqual(read.unread, []);
  assert.deepEqual(nextNameCardNotice(read, introduced.observed).unread, []);
});

test('unobtained catalog cards never count and subsequent grants prompt only once', () => {
  const before = nextNameCardNotice(null, ['special_good_boy', 'char_not_a_card']);
  assert.deepEqual(before.observed, ['special_good_boy']);
  const after = nextNameCardNotice(before, [...before.observed, 'special_paintbrush_tactics']);
  assert.deepEqual(after.unread, ['special_paintbrush_tactics']);
  assert.deepEqual(nextNameCardNotice(after, before.observed).unread, []);
  assert.doesNotThrow(() => nextNameCardNotice({ v: 1, unread: {}, observed: {} }, NEW_RANK_CARD_IDS));
});

test('notices use canonical account isolation and persist reading across module reloads', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value),
  } });
  try {
    const a = 'a'.repeat(32), b = 'b'.repeat(32);
    const aRank = { profileId: a, unlockedNameCards: [NEW_RANK_CARD_IDS[0]] };
    assert.equal(updateNameCardNotice(b, aRank), null, 'stale rank payload from another account is ignored');
    assert.equal(updateNameCardNotice(null, aRank), null);
    assert.equal(updateNameCardNotice(a, null), null);
    assert.deepEqual(updateNameCardNotice(a, aRank).unread, [NEW_RANK_CARD_IDS[0]]);
    assert.deepEqual(updateNameCardNotice(b, { profileId: b, unlockedNameCards: [] }).unread, []);
    assert.deepEqual(updateNameCardNotice(a, aRank, true).unread, []);
    const reloaded = await import('../public/js/ui/nameCardNotices.js?refresh-test');
    assert.deepEqual(reloaded.updateNameCardNotice(a, aRank).unread, [], 'refresh does not recreate a read badge');
    const promoted = { profileId: a, unlockedNameCards: NEW_RANK_CARD_IDS.slice(0, 2) };
    assert.deepEqual(reloaded.updateNameCardNotice(a, promoted).unread, [NEW_RANK_CARD_IDS[1]]);
    assert.equal(saved.has(`sp.pref.nameCards.notice.${a}`), true);
    assert.equal(saved.has(`sp.pref.nameCards.notice.${b}`), true);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('all five rank cards serve static previews directly and use only their own downloaded GIF', () => {
  const original = resourceCache.isCached;
  try {
    for (const key of ['solari', 'lunari', 'amari', 'terrari', 'evori']) {
      const root = `/assets/local/playercards/evori-${key}`;
      const ctx = { pool: [], byChar: new Map(), m: null, myId: 'self', myCard: `special_evori_${key}` };
      const seats = [{ playerId: 'self' }, { playerId: 'other', card: `special_evori_${key}` }];
      resourceCache.isCached = () => false;
      for (const seat of seats) {
        assert.equal(seatAvatar(seat, ctx), `${root}/avatar.png`);
        assert.equal(seatPortrait(seat, ctx), `${root}/card.png`);
      }
      assert.equal(hFresh('img', { src: `${root}/avatar.png` }).type, 'img');
      assert.equal(hFresh('img', { src: `${root}/card.png` }).type, 'img');
      assert.equal(hFresh('img', { src: `${root}/card.gif` }).type, CachedImage);
      assert.equal(isSpecialCardPortrait(`${root}/card.png`), true);
      resourceCache.isCached = url => url === `${root}/card.gif`;
      for (const seat of seats) assert.equal(seatPortrait(seat, ctx), `${root}/card.gif`);
    }
    assert.equal(hFresh('img', { src: '/assets/local/playercards/evori-unknown/card.png' }).type, CachedImage);
  } finally { resourceCache.isCached = original; }
});

test('lobby badge is always visible when unread, picker marks viewed, and threshold uses authority reply', () => {
  const lobby = fs.readFileSync(new URL('../public/js/screens/lobby.js', import.meta.url), 'utf8');
  const picker = fs.readFileSync(new URL('../public/js/ui/seatArt.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/css/components.css', import.meta.url), 'utf8');
  assert.equal(lobby.includes('unreadNameCards ? html`<span class="me-chip__unread"'), true);
  assert.equal(lobby.includes('setRadiantThreshold(reply.radiantThreshold || null)'), true);
  assert.equal(lobby.includes('当前源能战魂最低阈值：神话三 {points} 分'), true);
  assert.equal(lobby.includes('points: radiantThreshold.mythicPoints'), true);
  assert.equal(picker.includes('useNameCardNotice(ready ? profileId : null, rank, ready && !loading && !q && !star)'), true);
  assert.match(css, /.me-chip__unread {[^}]*background: #ff555a/);
  assert.doesNotMatch(css, /:hover[^{}]*me-chip__unread/);
});
