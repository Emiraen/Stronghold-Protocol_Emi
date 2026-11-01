import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { seatEntries } from '../server/matchRestore.js';
import { ENDLESS_VARIANT } from '../shared/constants.js';
import { ANNIHILATION_VARIANT } from '../shared/annihilation-constants.js';
import { MIZUKI_VARIANT } from '../shared/mizuki-constants.js';
import { ZHAJING_VARIANT } from '../shared/zhajing-constants.js';

const human = { seat: 0, playerId: 'p0', name: 'Doctor', connected: true, left: true,
  loadout: { skill: 1 }, standIns: ['unowned'], aid: 'aid0' };
const bot = { seat: 1, playerId: 'bot1', name: 'Bot', isBot: true, connected: false, left: false };
const registry = { byId: (id) => id === 'p0' ? { debugAuthorized: true } : null };
const room = (variant) => ({ variant, seats: [human, bot], seatOf: (id) => [human, bot].find((p) => p.playerId === id) });
const expected = (checkpoint) => [
  { seat: 0, playerId: 'p0', name: 'Doctor', isBot: false, connected: !checkpoint,
    zhajingLoadout: null, zhajingOps: null,
    loadout: human.loadout, ops: null, notOwned: human.standIns, diy: null, skins: null, aid: 'aid0', debugAuthorized: true },
  { seat: 1, playerId: 'bot1', name: 'Bot', isBot: true, connected: !!checkpoint,
    zhajingLoadout: null, zhajingOps: null,
    loadout: null, ops: null, notOwned: null, diy: null, skins: null, aid: null, debugAuthorized: false },
];

test('existing mode seat entries retain their original field structure for fresh starts and restores', () => {
  for (const variant of [null, 'entertainment_multi', 'entertainment_cyclops', ENDLESS_VARIANT, ANNIHILATION_VARIANT]) {
    const current = room(variant);
    assert.deepEqual(seatEntries(current, null, registry), expected(false), String(variant));
    const checkpoint = { players: [human, bot] };
    assert.deepEqual(seatEntries(current, checkpoint, registry), expected(true), String(variant));
    assert.ok(seatEntries(current, checkpoint, registry).every((seat) => !Object.hasOwn(seat, 'left')));
  }
});

test('only Mizuki carries left and restores it from the authoritative room seat', () => {
  const current = room(MIZUKI_VARIANT);
  assert.deepEqual(seatEntries(current, null, registry).map((p) => p.left), [true, false]);
  const checkpoint = { players: [{ ...human, left: false }, { ...bot, left: true }] };
  assert.deepEqual(seatEntries(current, checkpoint, registry).map((p) => p.left), [true, false]);
});

test('entering Mizuki does not overwrite the legacy lobby difficulty preference; Endless keeps its original write', () => {
  const source = readFileSync(new URL('../public/js/screens/lobby.js', import.meta.url), 'utf8');
  const ast = parse(source, { sourceType: 'module', ecmaVersion: 2024 });
  const functions = new Map();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'VariableDeclarator' && ['pickDifficulty', 'pickEntertainment'].includes(value.id?.name)) {
      functions.set(value.id.name, source.slice(value.init.start, value.init.end));
    }
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
  };
  visit(ast);
  assert.equal(functions.size, 2);
  const run = (variant) => {
    const stored = new Map([['lobby.difficulty', 'HARD']]), writes = [], state = {};
    const context = { MIZUKI_VARIANT, ENDLESS_VARIANT, ANNIHILATION_VARIANT, ZHAJING_VARIANT,
      setDifficulty: (value) => { state.difficulty = value; },
      setHall: (value) => { state.hall = value; }, setVariant: (value) => { state.variant = value; },
      setRoomMode: (value) => { state.mode = value; },
      savePref: (key, value) => { stored.set(key, value); writes.push({ key, value }); } };
    context.pickDifficulty = runInNewContext('(' + functions.get('pickDifficulty') + ')', context);
    runInNewContext('(' + functions.get('pickEntertainment') + ')', context)(variant);
    return { preference: stored.get('lobby.difficulty'), writes, state };
  };
  const mizuki = run(MIZUKI_VARIANT);
  assert.equal(mizuki.preference, 'HARD'); assert.deepEqual(mizuki.writes, []);
  assert.deepEqual(mizuki.state, { variant: MIZUKI_VARIANT, mode: 'coop', difficulty: 'NORMAL', hall: 'protocol' });
  const endless = run(ENDLESS_VARIANT);
  assert.equal(endless.preference, 'NORMAL');
  assert.deepEqual(endless.writes, [{ key: 'lobby.difficulty', value: 'NORMAL' }]);
});
