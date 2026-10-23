import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec, flatStage } from '../helpers/battleHarness.js';
import { install as installChoices } from '../../server/sim/content/choices.js';
import { install as installBands } from '../../server/sim/content/bands/battle.js';
import { install as installCyclops } from '../../server/sim/content/cyclops.js';
import { gameData, setGameData } from '../../server/sim/content/support/index.js';
import { MAX_HOOK_DEPTH } from '../../server/sim/constants.js';

const ref = (id) => ({ id: `choice:${id}#1`, key: `choice:${id}`, data: { effectId: id }, params: {} });
const buff = (key, bb = {}, bbStr = {}) => ({ key, bb, bbStr });
const has = (u, key) => u.buffs.some(b => b.key === key);
const recorded = (b, message) => assert.ok(b.errors.some(e => e.message === message), message);
function fixture({ stage, players = ['p1', 'p2'], perPlayer = 2 } = {}) {
  return makeBattle({ content: 'none', stage, defs: { chess: { more_op_a: chessRec({ id: 'more_op_a', bonds: ['yanShip', 'sargonShip'], skill: null }) }, enemies: { more_enemy: enemyRec({ key: 'more_enemy' }) } },
    players: players.map((playerId, seat) => ({ playerId, seat, side: 'L', colOffset: 0, bonds: { yanShip: { active: true, tier: 1, layers: 5 }, sargonShip: { active: true, tier: 1, layers: 5 } },
      units: Array.from({ length: perPlayer }, (_, i) => ({ chessId: 'more_op_a', uid: seat * 10 + i + 1, row: 10 + seat, col: 3 + i })) })),
  });
}
function withEffects(effects, run) {
  const before = gameData(); setGameData({ ...before, effects: { ...before.effects, ...effects } });
  try { run(); } finally { setGameData(before); }
}

test('content fanout: failed choice plan or prep gate never publishes partial cards or blocks later players', () => {
  const broken = {}; Object.defineProperty(broken, 'buffs', { get() { throw Error('choice plan failure'); } });
  withEffects({ more_bad: broken, more_gate: { buffs: [buff('global_special_choice_prep_finish_bench_at_least', { count: 1 }), buff('env_gbuff_new', { atk: 0.2 })] }, more_good: { buffs: [buff('env_gbuff_new', { atk: 0.1 })] } }, () => {
    const h = fixture(), gated = ref('more_gate');
    Object.defineProperty(gated.params, 'prepOk', { get() { throw Error('choice gate failure'); } });
    h.b.players[0].playerEffects = [ref('more_bad'), gated, ref('more_good')];
    h.b.players[1].playerEffects = [ref('more_good')];
    installChoices(h.b); h.b.start();
    for (const u of h.b.allyUnits) { assert.equal(has(u, 'choice:more_good#1'), true); assert.equal(has(u, 'choice:more_gate#1'), false); }
    recorded(h.b, 'choice plan failure'); recorded(h.b, 'choice gate failure');
  });
});

test('content fanout: choice passive failure preserves other cards and recipients at the last hook frame', () => {
  withEffects({ more_first: { buffs: [buff('env_gbuff_new', { atk: 0.1 })] }, more_second: { buffs: [buff('env_gbuff_new', { def: 0.1 })] } }, () => {
    const h = fixture(), first = h.b.allyUnits[0], add = h.b.addBuff; let attempted = 0;
    for (const p of h.b.players) p.playerEffects = [ref('more_first'), ref('more_second')];
    h.b.addBuff = function(u, b) { if (u === first && b.key === 'choice:more_first#1') { attempted++; throw Error('choice passive failure'); } return add.call(this, u, b); };
    installChoices(h.b); h.b.start();
    assert.equal(attempted, 1, 'failed application is not replayed');
    assert.equal(has(first, 'choice:more_first#1'), false);
    assert.equal(h.b.allyUnits.slice(1).every(u => has(u, 'choice:more_first#1')), true);
    assert.equal(h.b.allyUnits.every(u => has(u, 'choice:more_second#1')), true);
    h.b._emitDepth = MAX_HOOK_DEPTH - 1; h.b.emit('battleStart', {});
    assert.equal(h.b._emitDepth, MAX_HOOK_DEPTH - 1); h.b._emitDepth = 0;
    assert.equal(h.b.errors.some(e => e.label.startsWith('hookDepth:')), false); recorded(h.b, 'choice passive failure');
  });
});

test('content fanout: choice heal and flawless faults do not block other buffs or units', () => {
  withEffects({ more_f1: { buffs: [buff('env_gbuff_new_with_verify', { atk: 0.1 }, { key: 'act1autochess_debuff_9' })] }, more_f2: { buffs: [buff('env_gbuff_new_with_verify', { def: 0.1 }, { key: 'act1autochess_debuff_9' })] }, more_heal: { buffs: [buff('env_gbuff_new_with_verify', { value: 2 }, { key: 'act1autochess_debuff_3' })] } }, () => {
    const h = fixture(), first = h.b.allyUnits[0], add = h.b.addBuff;
    for (const p of h.b.players) p.playerEffects = [ref('more_f1'), ref('more_f2'), ref('more_heal')];
    h.b.addBuff = function(u, b) { if (u === first && b.key === 'choice:more_f1#1') throw Error('choice flawless failure'); return add.call(this, u, b); };
    installChoices(h.b); h.b.start();
    assert.equal(h.b.allyUnits.every(u => has(u, 'choice:more_f2#1')), true);
    assert.equal(h.b.allyUnits.slice(1).every(u => has(u, 'choice:more_f1#1')), true);
    h.b.removeBuff(first, 'choice:more_f2#1');
    h.b.heal = () => { throw Error('choice heal failure'); };
    h.b.emit('damaged', { target: first, amount: 1, type: 'physical', dmg: {} });
    assert.equal(has(first, 'choice:more_f2#1'), true);
    h.b.emit('tick', {}); recorded(h.b, 'choice heal failure'); recorded(h.b, 'choice flawless failure');
  });
});

test('content fanout: failed enemy card buff cannot block later independent enemy debuffs', () => {
  withEffects({ more_e1: { buffs: [buff('enemy_attribute_add', { atk: 1 })] }, more_e2: { buffs: [buff('enemy_attribute_add', { def: 1 })] } }, () => {
    const h = fixture(), add = h.b.addBuff; h.b.players[0].playerEffects = [ref('more_e1'), ref('more_e2')];
    h.b.addBuff = function(u, b) { if (b.key === 'choice:more_e1#1') throw Error('enemy choice failure'); return add.call(this, u, b); };
    installChoices(h.b); const e = h.spawn('more_enemy', { ownerPlayerId: 'p1' });
    e.ownerId = 'p1'; h.b.emit('enemySpawn', { enemy: e });
    assert.equal(has(e, 'choice:more_e2#1'), true); recorded(h.b, 'enemy choice failure');
  });
});

test('content fanout: invalid band record and failed passive recipient cannot block later players', () => {
  const before = gameData(), bands = { ...before.bands };
  bands.more_good = { buffs: [buff('more_good', { value_1: 0, atk_1: 0.2 }, { key: 'act1autochess_band2_buff' })] };
  Object.defineProperty(bands, 'more_broken', { get() { throw Error('band record failure'); } });
  setGameData({ ...before, bands });
  try {
    const h = fixture(), add = h.b.addBuff, p2 = h.b.allyUnits.filter(u => u.ownerId === 'p2');
    h.b.players[0].bandId = 'more_broken'; h.b.players[1].bandId = 'more_good';
    h.b.addBuff = function(u, b) { if (u === p2[0] && b.key === 'band:more_good') throw Error('band passive failure'); return add.call(this, u, b); };
    h.b._emitDepth = MAX_HOOK_DEPTH - 1; installBands(h.b);
    assert.equal(has(p2[1], 'band:more_good'), true);
    assert.equal(h.b._emitDepth, MAX_HOOK_DEPTH - 1); h.b._emitDepth = 0;
    recorded(h.b, 'band record failure'); recorded(h.b, 'band passive failure');
  } finally { setGameData(before); }
});

test('content fanout: band death grant failure cannot block later recipients or replay prior grants', () => {
  const h = fixture({ players: ['p1'], perPlayer: 3 }), add = h.b.addBuff, [dead, bad, good] = h.b.allyUnits; let attempts = 0;
  h.b.players[0].bandId = 'band_qalaisa';
  h.b.addBuff = function(u, b) { if (u === bad && b.key === 'band:band_qalaisa') { attempts++; throw Error('band death failure'); } return add.call(this, u, b); };
  installBands(h.b); h.b.start(); h.b.emit('death', { unit: dead, reason: 'killed' });
  assert.equal(attempts, 1); assert.equal(has(good, 'band:band_qalaisa'), true); recorded(h.b, 'band death failure');
});

test('content fanout: failed Touch map spawn cannot block the next player', () => {
  const stage = { ...flatStage(), mapChars: [{ key: 'char_605_cmedic', pos: [10, 2] }, { key: 'char_605_cmedic', pos: [11, 2] }] };
  const h = fixture({ stage, perPlayer: 1 }), spawn = h.b.spawnToken; let p1Calls = 0, p2Calls = 0;
  for (const p of h.b.players) { p.bandId = 'band_amedic'; p.input.contentInfo = { matchBands: ['band_amedic'] }; }
  h.b.spawnToken = function(pid, ...args) { if (pid === 'p1') { p1Calls++; throw Error('map spawn failure'); } p2Calls++; return spawn.call(this, pid, ...args); };
  installBands(h.b); h.b.start();
  assert.equal(p1Calls, 1); assert.equal(p2Calls, 1);
  assert.equal(h.b.allyUnits.some(u => u.kind === 'token' && u.ownerId === 'p2'), true); recorded(h.b, 'map spawn failure');
});

test('content fanout: failed cyclops player or gift construction cannot block later gifts and players', () => {
  const h = fixture(), [p1, p2] = h.b.players, add = h.b.addBuff;
  for (const p of h.b.players) p.input.cyclops = true;
  const broken = { data: { tacticKind: 'cyclops' } }; Object.defineProperty(broken.data, 'family', { get() { throw Error('gift construction failure'); } });
  const gift = id => ({ id, data: { tacticKind: 'cyclops', family: 'yan', quality: 'silver' }, params: {} });
  p1.playerEffects = [broken, gift('more_yan')]; p2.playerEffects = [gift('more_yan')];
  const first = h.b.allyUnits[0];
  h.b.addBuff = function(u, b) { if (u === first && b.key === 'hex:more_yan') throw Error('gift recipient failure'); return add.call(this, u, b); };
  h.b._emitDepth = MAX_HOOK_DEPTH - 1; installCyclops(h.b);
  assert.equal(h.b.allyUnits.slice(1).every(u => has(u, 'hex:more_yan')), true);
  assert.equal(h.b._emitDepth, MAX_HOOK_DEPTH - 1); h.b._emitDepth = 0;
  recorded(h.b, 'gift construction failure'); recorded(h.b, 'gift recipient failure');
  const h2 = fixture(); for (const p of h2.b.players) p.input.cyclops = true;
  Object.defineProperty(h2.b.players[0], 'playerEffects', { get() { throw Error('gift player failure'); } });
  h2.b.players[1].playerEffects = [gift('more_yan')]; installCyclops(h2.b);
  assert.equal(h2.b.allyUnits.filter(u => u.ownerId === 'p2').every(u => has(u, 'hex:more_yan')), true); recorded(h2.b, 'gift player failure');
});

test('content fanout: failed gift data is not reread by later installed Siracusa critical calculations', () => {
  const h = fixture({ players: ['p1'], perPlayer: 1 }), p = h.b.players[0], u = h.b.allyUnits[0];
  p.input.cyclops = true; p.bonds.siracusaShip = { active: true, tier: 1, layers: 5 };
  u.def = { ...u.def, bonds: ['siracusaShip'] };
  const bad = { data: { tacticKind: 'cyclops' } }; let badReads = 0;
  Object.defineProperty(bad.data, 'family', { get() { badReads++; throw Error('bad gift family'); } });
  p.playerEffects = [bad, { id: 'more_siracusa', data: { tacticKind: 'cyclops', family: 'siracusa', quality: 'silver' }, params: {} }];
  h.b.rng = () => 0; installCyclops(h.b);
  const dmg = { type: 'physical', isAttack: true, isSkill: false, mul: 1, tags: [] };
  h.b.emit('hit', { source: u, target: { side: 'enemy', s: { flags: {} } }, dmg });
  assert.equal(dmg.cyclopsCrit, true); assert.ok(dmg.mul > 1); assert.equal(badReads, 1);
  recorded(h.b, 'bad gift family');
});

test('content fanout: failed cyclops SP recipient does not block the next member or replay the team pulse', () => {
  const h = fixture({ players: ['p1'], perPlayer: 2 }), p = h.b.players[0]; h.b.start();
  p.input.cyclops = true; p.playerEffects = [{ id: 'more_sargon', data: { tacticKind: 'cyclops', family: 'sargon', quality: 'prismatic' }, params: {} }];
  let bad = 0, good = 0;
  h.b.allyUnits[0].skill = { spCost: 10, spCostMul: 1, gainSp() { bad++; throw Error('team SP failure'); } };
  h.b.allyUnits[1].skill = { spCost: 10, spCostMul: 1, gainSp() { good++; } };
  installCyclops(h.b);
  const ev = { killer: h.b.allyUnits[0], victim: { side: 'enemy' } };
  h.b.emit('kill', ev); h.b.emit('kill', ev);
  assert.equal(bad, 1); assert.equal(good, 1); recorded(h.b, 'team SP failure');
});
