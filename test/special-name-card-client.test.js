import test from 'node:test';
import assert from 'node:assert/strict';
import { seatAvatar, seatPortrait, GOOD_BOY_AVATAR, GOOD_BOY_POSTER, GOOD_BOY_ANIMATION,
  TRICKSTER_AVATAR, TRICKSTER_POSTER, TRICKSTER_ANIMATION, isSpecialCardPortrait } from '../public/js/ui/seatArt.js';
import { hFresh } from '../public/js/ui/components.js';
import { CachedImage } from '../public/js/ui/cachedImage.js';
import { resourceCache } from '../public/js/resourceCache.js';
import { SPECIAL_GOOD_BOY_CARD, SPECIAL_TRICKSTER_CARD } from '../shared/nameCards.js';

test('special identity keeps its avatar without operator data, and animation requires cached optional art', () => {
  const old = resourceCache.isCached;
  const ctx = { pool: [], byChar: new Map(), m: null, myId: 'self', myCard: SPECIAL_GOOD_BOY_CARD };
  const own = { playerId: 'self' };
  const other = { playerId: 'other', card: SPECIAL_GOOD_BOY_CARD };
  try {
    resourceCache.isCached = () => false;
    for (const seat of [own, other]) {
      assert.equal(seatAvatar(seat, ctx), GOOD_BOY_AVATAR);
      assert.equal(seatPortrait(seat, ctx), GOOD_BOY_POSTER);
    }
    resourceCache.isCached = url => url === GOOD_BOY_ANIMATION;
    for (const seat of [own, other]) {
      assert.equal(seatAvatar(seat, ctx), GOOD_BOY_AVATAR);
      assert.equal(seatPortrait(seat, ctx), GOOD_BOY_ANIMATION);
    }
    assert.equal(seatAvatar({ playerId: 'other', card: 'char_unknown' }, ctx), null);
  } finally { resourceCache.isCached = old; }
});

test('trickster uses game-hosted avatar and poster until its own Win7 animation is cached', () => {
  const old = resourceCache.isCached;
  const ctx = { pool: [], byChar: new Map(), m: null, myId: 'self', myCard: SPECIAL_TRICKSTER_CARD };
  const own = { playerId: 'self' };
  const other = { playerId: 'other', card: SPECIAL_TRICKSTER_CARD };
  try {
    resourceCache.isCached = () => false;
    for (const seat of [own, other]) {
      assert.equal(seatAvatar(seat, ctx), TRICKSTER_AVATAR);
      assert.equal(seatPortrait(seat, ctx), TRICKSTER_POSTER);
    }
    resourceCache.isCached = url => url === TRICKSTER_ANIMATION;
    for (const seat of [own, other]) {
      assert.equal(seatAvatar(seat, ctx), TRICKSTER_AVATAR);
      assert.equal(seatPortrait(seat, ctx), TRICKSTER_ANIMATION);
    }
    assert.equal(isSpecialCardPortrait(TRICKSTER_POSTER), true);
    assert.equal(isSpecialCardPortrait(TRICKSTER_ANIMATION), true);
    assert.equal(isSpecialCardPortrait(TRICKSTER_AVATAR), false);
  } finally { resourceCache.isCached = old; }
});

test('only the special static avatar and poster bypass the preload image loader', () => {
  assert.equal(hFresh('img', { src: GOOD_BOY_AVATAR }).type, 'img');
  assert.equal(hFresh('img', { src: GOOD_BOY_POSTER }).type, 'img');
  assert.equal(hFresh('img', { src: GOOD_BOY_ANIMATION }).type, CachedImage);
  assert.equal(hFresh('img', { src: TRICKSTER_AVATAR }).type, 'img');
  assert.equal(hFresh('img', { src: TRICKSTER_POSTER }).type, 'img');
  assert.equal(hFresh('img', { src: TRICKSTER_ANIMATION }).type, CachedImage);
  assert.equal(hFresh('img', { src: '/assets/local/playercards/unknown.png' }).type, CachedImage);
});

test('all published name-card previews load from the game server without optional preload', () => {
  const cards = ['duck-burnard', 'duck-flower', 'duck-brioche', 'paintbrush-tactics',
    'soft-and-deadly', 'hatchbudz-quacked', 'commander-bruno'];
  for (const card of cards) {
    for (const file of ['avatar.png', 'poster.png']) {
      const src = `/assets/local/playercards/${card}/${file}`;
      assert.equal(hFresh('img', { src }).type, 'img', `${card}/${file} must not wait for a bulk resource download`);
    }
    const src = `/assets/local/playercards/${card}/card.gif`;
    assert.equal(hFresh('img', { src }).type, CachedImage, `${card} animation remains explicitly downloaded`);
  }
  for (const src of ['/assets/local/playercards/unknown/poster.png',
    '/assets/local/playercards/paintbrush-tactics/other.png',
    'https://example.invalid/assets/local/playercards/paintbrush-tactics/poster.png']) {
    assert.equal(hFresh('img', { src }).type, CachedImage, 'do not bypass resource policy for arbitrary images');
  }
});
