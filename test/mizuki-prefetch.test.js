import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssets, collectMatchResourceUrls } from '../public/js/assets.js';
import { collectMizukiResourceUrls, mizukiResourceKey } from '../public/js/mizukiPrefetch.js';

const model = name => ({ skel: '/assets/' + name + '.skel', atlas: '/assets/' + name + '.atlas',
  textures: ['/assets/' + name + '.png'], anims: { idle: 'Idle' } });
const operator = { chessId: 'op', charId: 'char_test', assets: { avatar: 'char_test', spine: 'char_test' } };
const manifest = { version: 1, chars: { char_test: { avatar: '/assets/avatar.png', portrait: '/assets/portrait.png',
  spine: { front: model('front'), back: model('back') } } }, enemies: { enemy: { icon: '/assets/enemy-icon.png' } },
  audio: { sfx: { ui: { ready: '/assets/ready.wav' }, battle: { deploy: '/assets/deploy.wav' },
    units: { char_test: { attack: '/assets/attack.wav' }, enemy: { attack: '/assets/enemy.wav' } } } } };
const source = { get: () => ({}), lookup: (_name, id) => id === 'enemy' ? { enemyKey: 'enemy' } : null };
const runtime = { chess: { op: operator }, tokens: {}, assetsLibrary: { spines: { enemy: model('enemy') } } };
const match = { private: { mizuki: { fieldId: 'own', roster: [{ uid: 1, chessId: 'op' }], nextEnemies: [{ enemyKey: 'enemy' }] } },
  public: { mizuki: { fields: [{ fieldId: 'own', battleId: 'b', stage: { id: 'ro2_1' }, meta: { units: [] } }] } } };

test('Mizuki prefetch reuses ordinary resource resolution for current models, cards and sounds', () => {
  const assets = createAssets({ manifest, localManifest: { groups: { 'map/autochess': { unrelated: { path: '/assets/unrelated-map.json' } } } } });
  const before = JSON.stringify(manifest);
  const urls = collectMizukiResourceUrls(assets, source, match, runtime);
  for (const url of ['/assets/avatar.png', '/assets/portrait.png', '/assets/front.skel', '/assets/back.skel',
    '/assets/enemy.skel', '/assets/enemy.atlas', '/assets/enemy.png', '/assets/attack.wav', '/assets/enemy.wav', '/assets/deploy.wav']) {
    assert.ok(urls.includes(url), url);
  }
  assert.equal(urls.length, new Set(urls).size);
  assert.ok(!urls.includes('/assets/unrelated-map.json'), 'mode prefetch does not download the ordinary map');
  assert.equal(JSON.stringify(manifest), before);
  const ordinary = collectMatchResourceUrls(assets, source, { private: {} });
  assert.ok(ordinary.includes('/assets/unrelated-map.json'), 'ordinary defaults keep their existing board prefetch');
});

test('resource identity ignores combat HP/SP and reacts to new roster, waves, skins or maps', () => {
  const key = mizukiResourceKey(match), next = structuredClone(match);
  next.public.mizuki.fields[0].t = 500; next.public.mizuki.fields[0].rosters = { p: [{ hp: 1, skill: { sp: 40 } }] };
  next.private.mizuki.hope = 8;
  assert.equal(mizukiResourceKey(next), key);
  for (const mutate of [value => value.private.mizuki.roster.push({ chessId: 'new' }),
    value => value.private.mizuki.roster[0].skin = 'skin', value => value.private.mizuki.nextEnemies.push({ enemyKey: 'boss' }),
    value => value.public.mizuki.fields[0].battleId = 'next-battle']) {
    const value = structuredClone(match); mutate(value); assert.notEqual(mizukiResourceKey(value), key);
  }
});
