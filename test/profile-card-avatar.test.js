import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSkinForPresentation } from '../server/profileService.js';
import { seatAvatar } from '../public/js/ui/seatArt.js';
import { resourceCache } from '../public/js/resourceCache.js';

const data = {
  chess: { base: { charId: 'char_test', baseId: 'base', isGolden: false, isDiy: false } },
  assets: { chars: { char_test: {
    avatar: '/normal.png', avatarE2: '/e2.png',
    skins: { skin_test: { avatar: '/skin.png', portrait: '/skin-portrait.png', spine: { front: {} } } },
  } } },
};

test('leaderboard card skin follows the selected name-card illustration', () => {
  assert.equal(cardSkinForPresentation('char_test', { portraits: { base: 'original' } }, data), 'original');
  assert.equal(cardSkinForPresentation('char_test', { portraits: { base: 'e2' } }, data), 'e2');
  assert.equal(cardSkinForPresentation('char_test', { portraits: { base: 'skin_test' } }, data), 'skin_test');
});

test('seat avatar uses the selected art and falls back to ordinary art when skin assets are unavailable', () => {
  const record = { charId: 'char_test', isGolden: true, assets: { avatar: 'char_test_2' } };
  const context = { pool: [record], byChar: new Map([['char_test', record]]), m: data.assets, myId: null, myCard: null };
  const isManaged = resourceCache.isManaged;
  const isCached = resourceCache.isCached;
  try {
    resourceCache.isManaged = () => true;
    resourceCache.isCached = (url) => url === '/skin.png' || url === '/e2.png';
    assert.equal(seatAvatar({ playerId: '1', card: 'char_test', cardSkin: 'original' }, context), '/normal.png');
    assert.equal(seatAvatar({ playerId: '1', card: 'char_test', cardSkin: 'e2' }, context), '/e2.png');
    assert.equal(seatAvatar({ playerId: '1', card: 'char_test', cardSkin: 'skin_test' }, context), '/skin.png');
    resourceCache.isCached = () => false;
    assert.equal(seatAvatar({ playerId: '1', card: 'char_test', cardSkin: 'e2' }, context), '/normal.png');
    assert.equal(seatAvatar({ playerId: '1', card: 'char_test', cardSkin: 'skin_test' }, context), '/normal.png');
  } finally {
    resourceCache.isManaged = isManaged;
    resourceCache.isCached = isCached;
  }
});
