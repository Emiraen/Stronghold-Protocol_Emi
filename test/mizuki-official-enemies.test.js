import test from 'node:test';
import assert from 'node:assert/strict';
import { getData } from '../server/data.js';
import { Battle } from '../server/sim/Battle.js';
import { MAX_BATTLE_TIME } from '../server/sim/constants.js';
import { KITS } from '../server/sim/content/enemies.js';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { createOfficialMizukiStage } from '../server/modes/mizuki/official-stages.js';
import { MIZUKI_ENEMY_IDS } from '../server/modes/mizuki/official-enemies.js';

const create = (stageId, options = {}) => {
  const catalog = createMizukiCatalog(getData());
  const stage = createOfficialMizukiStage(stageId, { data: catalog.source, seed: 42 });
  return new MizukiCombat({ ...stage, content: 'full', seed: 42,
    players: [{ playerId: 'p1', units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] }],
    flags: { ...stage.flags, dpInit: 999, dpMax: 999 }, ...options });
};
const deploy = (c) => {
  const tile = c.snapshot().geometry.tiles.find((t) => c.battle.grid.canStand(t.row, t.col, { ranged: false }) && !t.obstacle);
  const result = c.command('p1', { type: 'deploy', uid: 101, row: tile.row, col: tile.col, dir: 'RIGHT' });
  assert.equal(result.ok, true, JSON.stringify(result));
  return c.battle.getPlayer('p1').units[0];
};

test('official corrosive slug reads real -10 per hit and clears the reduction when its target retreats', () => {
  const c = create('ro2_n_1_2'); const b = c.battle; const u = deploy(c);
  const e = b.spawnEnemy('enemy_1004_mslime');
  assert.equal(e.def.applyWay, 'RANGED');
  const before = u.s.def;
  b.dealDamage(e, u, { amount: 1, type: 'true', isAttack: true, canDodge: false });
  b.dealDamage(e, u, { amount: 1, type: 'true', isAttack: true, canDodge: false });
  assert.equal(u.s.def, before - 20);
  b.applyStatus(e, 'silence', { duration: 10 });
  b.dealDamage(e, u, { amount: 1, type: 'true', isAttack: true, canDodge: false });
  assert.equal(u.s.def, before - 20);
  assert.equal(c.command('p1', { type: 'retreat', uid: 101 }).ok, true);
  assert.equal(u.findBuff('mizuki:official:mslime:defdown'), null);
  assert.equal(b.errorCount, 0);
});

test('official stun sniper uses original nthAttackStatus and its real SP2 / stun5 blackboard', () => {
  const c = create('ro2_n_1_3'); const b = c.battle; const u = deploy(c);
  const e = b.spawnEnemy('enemy_1047_sagent');
  const skill = e.mem.ab.sk.stunattack;
  assert.equal(skill.sp, 2); assert.equal(skill.bb.stun, 5);
  const attack = () => b.emit('attack', { attacker: e, targets: [u],
    targetDeployments: new Map([[u, u.deploySeq]]) });
  attack(); attack(); assert.equal(!!u.s.flags.stun, false);
  attack(); assert.equal(u.s.flags.stun, true);
  assert.equal(u.buffs.find((x) => x.status === 'stun').duration, 5);
  assert.equal(b.errorCount, 0);
});

test('official unblocked physical evasion reads Evade.prob and switches off immediately on block or silence', () => {
  const c = create('ro2_n_1_1'); const b = c.battle; const u = deploy(c);
  const e = b.spawnEnemy('enemy_1159_swfmob');
  assert.equal(e.mem.ab.t['Evade.prob'], 0.4);
  const previous = b.rng; b.rng = () => 0;
  const hit = (type = 'phys') => b.dealDamage(u, e,
    { amount: 200, type, isAttack: true, canDodge: true });
  assert.equal(hit(), 0);
  assert.equal(e.s.dodgePhys, 0.4);
  e.blockedBy = u; assert.ok(hit() > 0); assert.equal(e.s.dodgePhys, 0);
  e.blockedBy = null; assert.ok(hit('arts') > 0);
  b.applyStatus(e, 'silence', { duration: 10 }); assert.ok(hit() > 0);
  assert.equal(e.s.dodgePhys, 0);
  b.rng = previous;
  assert.equal(b.errorCount, 0);
});

test('official enemy extensions do not mutate the original global registry or old Battle behavior', () => {
  const c = create('ro2_n_1_1');
  for (const id of MIZUKI_ENEMY_IDS) assert.equal(Object.hasOwn(KITS, id), false);
  const old = new Battle({ stage: c.battle.stage, rect: c.battle.rect,
    data: c.battle.data, players: [], content: 'full' });
  const e = old.spawnEnemy('enemy_1159_swfmob');
  assert.equal(e.mem._mizukiOfficialKit, undefined);
  assert.equal(e.mem.ab?.t?.['Evade.prob'], undefined);
});

test('original unlimited official level is not cut at 180 seconds or the old automatic mode global limit', () => {
  const c = create('ro2_n_1_1'); c.battle.start();
  assert.equal(c.battle.timeLimit, Infinity);
  c.battle.time = MAX_BATTLE_TIME + 1;
  c.battle._checkEnd();
  assert.equal(c.done, false);
  const limited = create('ro2_n_1_1', { timeLimit: 3 }); limited.battle.start();
  limited.battle.time = 3; limited.battle._checkEnd();
  assert.equal(limited.done, true); assert.equal(limited.battle.reason, 'timeout');
});

test('first three official maps simulate original waves and expose the existing renderer metadata', () => {
  for (const id of ['ro2_n_1_1', 'ro2_n_1_2', 'ro2_n_1_3']) {
    const c = create(id); const operator = deploy(c);
    for (let i = 0; i < 600 && !c.done; i++) c.step();
    const s = c.snapshot(); const meta = c.fieldMeta();
    assert.equal(c.battle.errorCount, 0, id + ': ' + JSON.stringify(c.battle.errors));
    assert.equal(meta.stageId, id);
    assert.deepEqual(s.meta, meta);
    assert.ok(meta.units.some((u) => u.uid === operator.uid && u.ownerId === 'p1'));
    assert.ok(s.geometry.tiles.length > 0);
    assert.equal(s.stage.id, id);
    assert.deepEqual(s.stage.originalSize, [c.battle.rect.r1 + 1, c.battle.rect.c1 + 1]);
    assert.ok(c.battle.total > 0);
    assert.equal(s.officialWaves.unsupported.some((u) => u.code === 'ENEMY_DEFINITION_MISSING'), false);
    for (const enemy of c.battle.enemies) assert.ok(enemy.def.raw.officialData, enemy.defId);
    assert.ok(s.meta.units.every((u) => typeof u.id === 'number' && typeof u.spine === 'string'));
  }
});

test('real Blemishine deployment layers survive retreat and the next official level, while per-battle caps reset', () => {
  const units = ['chess_char_2_12_a', 'chess_char_6_17_a', 'chess_char_3_12_a']
    .map((chessId, i) => ({ uid: 101 + i, chessId }));
  const player = (progression) => ({ playerId: 'p1', units, ...(progression ? { progression } : {}) });
  const place = (c, uid) => {
    const t = c.snapshot().geometry.tiles.find((t) => !t.obstacle
      && c.battle.grid.canStand(t.row, t.col, { ranged: false })
      && !c.battle.isReservedTile(t.row, t.col));
    const result = c.command('p1', { type: 'deploy', uid, row: t.row, col: t.col, dir: 'RIGHT' });
    assert.equal(result.ok, true, JSON.stringify(result));
    c.battle._runScheduled(); // original readers defer layerGain recomputation to the next scheduler phase
  };
  const layers = (c) => c.snapshot().progression.players.p1.layers.kazimierzShip;
  const first = create('ro2_n_1_1', { players: [player()] });
  for (const u of units) place(first, u.uid);
  const blemishine = first.battle.getPlayer('p1').units.find((u) => u.uid === 103);
  const near = first.battle.getPlayer('p1').units.find((u) => u.uid === 102);
  assert.equal(layers(first), 4, 'real on-deploy garrison earns four layers');
  for (let i = 0; i < 3; i++) {
    assert.equal(first.command('p1', { type: 'retreat', uid: 103 }).ok, true);
    const retained = layers(first);
    assert.ok(retained >= 4, 'deactivation and retreat never erase accumulated layers');
    first.battle.time = blemishine.respawnAt;
    first.battle.addDp('p1', 999);
    place(first, 103);
  }
  assert.equal(layers(first), 12, 'native max_add_count_per_battle=12 still applies');
  assert.ok(near.findBuff('gar:garrison_144_a').mods.redeployMul < 1,
    'the real layer reader reconstructs redeployment-time reduction');
  // This is a transient buff used only to assert the persistence boundary;
  // progression below contains genuine garrison-earned layers, never buffs.
  first.battle.addBuff(blemishine, { key: 'skill:test:temporary', duration: 20, mods: { atkPct: 1 } });
  first.forceEnd();
  const result = first.result();
  assert.equal(result.progression.players.p1.layers.kazimierzShip, 12);
  const second = create('ro2_n_1_2', { players: [player(result.progression.players.p1)] });
  assert.equal(layers(second), 12, 'the next engine restores layers before any deployment');
  assert.equal(second.battle.getPlayer('p1').units[2].findBuff('skill:test:temporary'), null);
  for (const u of units) place(second, u.uid);
  assert.equal(layers(second), 16, 'a new battle restores the native per-battle earn budget');
  const nextNear = second.battle.getPlayer('p1').units.find((u) => u.uid === 102);
  const reader = nextNear.findBuff('gar:garrison_144_a');
  assert.ok(reader?.mods.redeployMul < 1);
  assert.equal(second.battle.errorCount, 0);
});
