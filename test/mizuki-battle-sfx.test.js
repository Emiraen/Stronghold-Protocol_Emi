import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioManager } from '../public/js/audio.js';
import { createMizukiBattleSfx, mizukiBattleSfxScope } from '../public/js/mizukiBattleSfx.js';
import { UF } from '../shared/constants.js';

const operator = (id = 1) => ({ id, kind: 'op', side: 'ally', defId: 'custom-operator-slot', spine: 'char_fixture', skillIndex: 0 });
const enemy = { id: 20, kind: 'enemy', side: 'enemy', defId: 'enemy_fixture', spine: 'enemy_fixture' };
const field = (extra = {}) => ({ fieldId: 'field-a', battleId: 'battle-a', meta: { units: [operator(), enemy] }, units: [], ...extra });
function fixture({ unlocked = true } = {}) {
  const played = [];
  const audio = new AudioManager({ getManifest: () => ({ audio: { sfx: { units: {
    char_fixture: { attack: '/fixture/attack.wav', hit: '/fixture/hit.wav', skill: '/fixture/skill.wav', born: '/fixture/born.wav' },
  } } } }) });
  if (unlocked) audio.ctx = {};
  audio._play = url => { if (url) played.push(url); };
  audio.voice = () => false;
  const sfx = createMizukiBattleSfx(audio);
  return { audio, sfx, played };
}

test('Mizuki forwards real attack, impact, skill and deploy events using UnitInfo.spine', () => {
  const { audio, sfx, played } = fixture();
  sfx.setField(field());
  assert.equal(audio.units.get(1).def, 'char_fixture');
  assert.deepEqual(played, [], 'snapshot metadata does not replay historical sounds');
  assert.equal(sfx.pushEvents({ fieldId: 'field-a', battleId: 'battle-a', events: [
    ['deploy', 1, { initial: true }], ['atk', 1, 20, 'phys'], ['dmg', 20, 1, 'phys'], ['skill', 1, true],
  ] }), true);
  assert.deepEqual(played, ['/fixture/born.wav', '/fixture/attack.wav', '/fixture/hit.wav', '/fixture/skill.wav']);
  sfx.dispose();
});

test('Mizuki filters other battles, consumes one packet once, and clears the old field on switching', () => {
  const { audio, sfx, played } = fixture();
  sfx.setField(field());
  const token = mizukiBattleSfxScope(audio);
  const packet = { fieldId: 'field-a', battleId: 'battle-a', ev: [['atk', 1, 20, 'phys']] };
  assert.equal(sfx.pushEvents({ ...packet, fieldId: 'field-b' }), false);
  assert.equal(sfx.pushEvents({ ...packet, battleId: 'older-battle' }), false);
  assert.equal(sfx.pushEvents(packet), true);
  assert.equal(sfx.pushEvents(packet), false);
  assert.equal(played.length, 1);
  sfx.setField(field({ fieldId: 'field-b', battleId: 'battle-b', meta: { units: [operator(2), enemy] } }));
  assert.notEqual(mizukiBattleSfxScope(audio), token);
  assert.equal(audio.units.has(1), false);
  assert.equal(sfx.pushEvents(packet), false);
  assert.equal(sfx.pushEvents({ fieldId: 'field-b', battleId: 'battle-b', ev: [['atk', 2, 20, 'phys']] }), true);
  assert.equal(played.length, 2);
  sfx.dispose();
});

test('Mizuki metadata additions retain an active skill and a real spawn can precede public metadata', () => {
  const { audio, sfx, played } = fixture();
  sfx.setField(field());
  sfx.pushEvents({ fieldId: 'field-a', events: [['skill', 1, true]] });
  sfx.setField(field({ meta: { units: [operator(), operator(2), enemy] } }));
  assert.equal(audio.units.get(1).skillActive, true);
  assert.equal(audio.units.has(2), true);
  assert.deepEqual(played, ['/fixture/skill.wav']);
  sfx.pushEvents({ fieldId: 'field-a', events: [['spawn', operator(3)], ['atk', 3, 20, 'phys']] });
  assert.equal(audio.units.get(3).def, 'char_fixture');
  assert.deepEqual(played, ['/fixture/skill.wav', '/fixture/attack.wav']);
  sfx.dispose();
});

test('Mizuki seeds units spawned while audio was locked and resumes the snapshot skill state on unlock', () => {
  const { audio, sfx, played } = fixture({ unlocked: false });
  sfx.setField(field());
  sfx.pushEvents({ fieldId: 'field-a', events: [['spawn', operator(3)]] });
  assert.equal(audio.units.has(3), false, 'the shared manager intentionally ignores events before browser audio unlock');
  sfx.setField(field({ units: [[1, 0, 0, 1, 1, 0, 1, UF.SKILL, 0]] }));
  audio.ctx = {};
  sfx.pushEvents({ fieldId: 'field-a', events: [['atk', 3, 20, 'phys']] });
  assert.equal(audio.units.has(3), true);
  assert.equal(audio.units.get(1).skillActive, true);
  assert.deepEqual(played, ['/fixture/attack.wav']);
  sfx.dispose();
});

test('Mizuki stops accepting combat events during terminal presentation, prep and unmount', () => {
  const { audio, sfx, played } = fixture();
  const selected = field();
  const packet = () => ({ fieldId: selected.fieldId, battleId: selected.battleId, events: [['atk', 1, 20, 'phys']] });
  sfx.setField(selected);
  sfx.setField(selected, { phase: 'COMBAT', finishing: true });
  assert.equal(mizukiBattleSfxScope(audio), null);
  assert.equal(audio.units.size, 0);
  assert.equal(sfx.pushEvents(packet()), false);
  sfx.setField(selected, { phase: 'PREP' });
  assert.equal(sfx.pushEvents(packet()), false);
  sfx.setField(selected);
  sfx.dispose();
  assert.equal(sfx.pushEvents(packet()), false);
  assert.deepEqual(played, []);
});
