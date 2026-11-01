import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { installOfficialStageMechanics, resolveOfficialFacility, officialTerrainConfig }
  from '../server/modes/mizuki/OfficialStageMechanics.js';
import { compileOfficialRunes, installOfficialUnitRunes } from '../server/modes/mizuki/OfficialRunes.js';
const instance = (key, row = 9, col = 4, extra = {}) => ({ inst: { characterKey: key, level: 1, phase: 'PHASE_0' },
  alias: key + '#1', position: { row, col }, direction: 'RIGHT', mainSkillLvl: 1, skillIndex: 0, ...extra });
const level = (instances) => ({ predefines: { tokenInsts: instances }, mapData: { map: [], tiles: [] }, branches: {} });
const create = (source) => {
  const c = new MizukiCombat({ seed: 7, stageId: 'act1autochess_m02',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players: [{ playerId: 'p1',
      units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] }],
    spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }], timeLimit: 180 });
  const mechanism = installOfficialStageMechanics(c.battle, source);
  c.stageMechanics = mechanism;
  return { c, b: c.battle, mechanism };
};
const step = (c, seconds) => { for (let n = 0; n < Math.ceil(seconds * 30); n++) c.step(); };

test('original facility stats, selected skill and source range are resolved without defaults', () => {
  const stone = resolveOfficialFacility(instance('trap_027_stone'));
  assert.equal(stone.stats.maxHp, 8000);
  assert.equal(stone.stats.blockCnt, 3);
  const frost = resolveOfficialFacility(instance('trap_010_frosts'));
  assert.equal(frost.skill.spData.spCost, 15);
  assert.equal(frost.bb.freeze, 10);
  assert.equal(frost.grid.length, 13);
  const sensor = resolveOfficialFacility(instance('trap_005_sensor'));
  assert.equal(sensor.skill.duration, 20);
  assert.equal(sensor.grid.length, 25);
});

test('original hidden ally knight spawns only from its activation and preserves added battle-info values', () => {
  const p = instance('trap_079_allydonq', 9, 4, { hidden: true });
  const { b, mechanism } = create(level([p]));
  b.start();
  assert.equal(b.allyUnits.some((u) => u.defId === p.inst.characterKey), false);
  assert.equal(mechanism.waveOptions.activatePredefined(p.alias, p), true);
  assert.equal(b.allyUnits.filter((u) => u.defId === p.inst.characterKey).length, 1);
  assert.equal(mechanism.snapshot().logs.born, 1);
  b.emit('mizuki:extraBattleInfo', { key: 'trap_068_badbox', additionValue: 3 });
  b.emit('mizuki:extraBattleInfo', { key: 'trap_068_badbox', additionValue: 2 });
  assert.equal(mechanism.snapshot().logs.trap_068_badbox, 5);
  mechanism.waveOptions.activatePredefined(p.alias, p);
  assert.equal(mechanism.snapshot().logs.born, 1);
});

test('integrated weapon station restores only native live loops after capture, never the single attack', () => {
  const p = instance('trap_057_wpnsts', 9, 4, { hidden: true });
  const { b, c, mechanism } = create(level([p]));
  const events = [], nativeFx = b.fx.bind(b);
  b.fx = (type, data) => { if (type === 'mizuki:effect') events.push(data); return nativeFx(type, data); };
  b.start();
  assert.equal(mechanism.snapshot().effects.length, 0);
  assert.equal(mechanism.waveOptions.activatePredefined(p.alias, p), true);
  const station = b.allyUnits.find((u) => u.defId === p.inst.characterKey);
  assert.deepEqual(mechanism.snapshot().effects.filter((fx) => fx.active).map((fx) => fx.key).sort(),
    ['trap_latelan_char_01', 'trap_latelan_char_01_start']);
  assert.equal(mechanism.snapshot().tiles[0].originalFacilityHeight, 0.4000000059604645);
  b.dealDamage(null, station, { type: 'true', amount: 1000000, canDodge: false });
  assert.equal(station.side, 'enemy');
  const attack = events.find((fx) => fx.key === 'trap_latelan_enemy_attack_01' && fx.active);
  assert.equal(attack.loop, false);
  assert.equal(mechanism.snapshot().effects.some((fx) => fx.key.endsWith('attack_01')), false);
  assert.deepEqual(mechanism.snapshot().effects.filter((fx) => fx.active).map((fx) => fx.key),
    ['trap_latelan_enemy_charging_01']);
  step(c, 20.1);
  assert.deepEqual(mechanism.snapshot().effects.filter((fx) => fx.active).map((fx) => fx.key).sort(),
    ['trap_latelan_enemy_01', 'trap_latelan_enemy_01_start']);
  assert.equal(mechanism.snapshot().logs.enemy, 1);
  assert.equal(b.errorCount, 0);
});

test('hidden air-support candidates rewrite only the actually activated original tile', () => {
  const first = instance('trap_037_airsup', 9, 4, { hidden: true });
  const second = instance('trap_037_airsup', 9, 6, { hidden: true, alias: 'trap_037_airsup#2' });
  const { b, mechanism } = create(level([first, second]));
  const original = b.grid.tile(9, 4);
  b.start();
  assert.equal(mechanism.snapshot().tiles.length, 0);
  mechanism.waveOptions.activatePredefined(second.alias, second);
  assert.equal(b.grid.tile(9, 4), original);
  assert.equal(b.grid.tile(9, 6).build, 'NONE');
  assert.equal(b.grid.groundPassable(9, 6), false);
  assert.equal(b.grid.flyPassable(9, 6), true);
  assert.deepEqual(mechanism.snapshot().tiles.map((v) => [v.row, v.col, v.passable]), [[9, 6, 'FLY_ONLY']]);
  assert.equal(mechanism.snapshot().tiles[0].originalFacilityHeight, 0.4000000059604645);
});

test('original obstacle-like facility restores the source tile when destroyed', () => {
  const { b, mechanism } = create(level([instance('trap_027_stone', 9, 4, { hidden: true })]));
  const source = b.grid.tile(9, 4);
  const p = instance('trap_027_stone', 9, 4, { hidden: true });
  b.start();
  mechanism.waveOptions.activatePredefined(p.alias, p);
  const stone = b.allyUnits.find((u) => u.defId === 'trap_027_stone');
  assert.equal(b.grid.tile(9, 4).build, 'NONE');
  assert.equal(b.grid.walkable(9, 4), true, 'native obstacle-like move cost remains traversable');
  assert.equal(b.grid.isCrate(9, 4), true);
  b.kill(stone);
  assert.equal(b.grid.tile(9, 4), source);
  assert.equal(b.grid.isCrate(9, 4), false);
  assert.equal(mechanism.snapshot().tiles[0].active, false);
});

test('original stone is placed once on its source tile and receives only this field char rune', () => {
  const l = level([instance('trap_027_stone')]);
  l.runes = [{ key: 'char_attribute_mul', difficultyMask: 'ALL', blackboard: [
    { key: 'char', value: 0, valueStr: 'trap_027_stone' }, { key: 'max_hp', value: 0.01, valueStr: null }] }];
  const { b, mechanism } = create(l);
  installOfficialUnitRunes(b, compileOfficialRunes(l, 'NORMAL'));
  b.start();
  const stone = b.allyUnits.find((u) => u.defId === 'trap_027_stone');
  assert.ok(stone);
  assert.equal(stone.s.maxHp, 80);
  assert.equal(b.grid.obstacle[9 * 21 + 4] > 0, true);
  mechanism.waveOptions.activatePredefined(stone.defId, l.predefines.tokenInsts[0]);
  assert.equal(b.allyUnits.filter((u) => u.defId === stone.defId).length, 1);
  assert.equal(resolveOfficialFacility(l.predefines.tokenInsts[0]).stats.maxHp, 8000);
});

test('original detector remains manual, then reveals only original range for its skill duration', () => {
  const { c, b, mechanism } = create(level([instance('trap_005_sensor')]));
  b.start();
  const detector = mechanism.commandUnits()[0];
  assert.ok(detector.uid < 0);
  const enemy = b.spawnEnemy('enemy_1007_slime', { pos: [9, 5] });
  enemy.pauseUntil = Infinity;
  b.addBuff(enemy, { key: 'test:invisible', flags: { stealth: true }, persist: true });
  detector.skill.gainSp(15);
  step(c, 0.2);
  assert.equal(detector.skill.active, false);
  assert.equal(!!enemy.s.flags.reveal, false);
  assert.equal(detector.skill.activate(), true);
  step(c, 0.1);
  assert.equal(!!enemy.s.flags.reveal, true);
  step(c, 20.2);
  assert.equal(detector.skill.active, false);
  assert.equal(!!enemy.s.flags.reveal, false);
});

test('original ice crystal charges automatically and applies source cold after original cast delay', () => {
  const { c, b } = create(level([instance('trap_010_frosts')]));
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: 9, col: 5, dir: 'RIGHT' }).ok, true);
  const frost = b.allyUnits.find((u) => u.defId === 'trap_010_frosts');
  const op = b.getPlayer('p1').units[0];
  const hp = frost.hp;
  b.dealDamage(null, frost, { type: 'true', amount: 10000, canDodge: false });
  assert.equal(frost.hp, hp);
  frost.skill.gainSp(15);
  step(c, 0.5);
  assert.equal(!!op.s.flags.cold, false);
  step(c, 0.5);
  assert.equal(!!op.s.flags.cold, true);
});

const creepLevel = (active = [[9, 4]], mainSkillLvl = 1) => {
  const l = level([instance('trap_061_creep', 12, 10, { mainSkillLvl })]);
  l.mapData.tiles = [{ tileKey: 'tile_creep', blackboard: [{ key: 'mode', value: 0 }] },
    { tileKey: 'tile_creepf', blackboard: [{ key: 'mode', value: 1 }] }];
  l.mapData.map = Array.from({ length: 19 }, () => Array(21).fill(0));
  for (const [r, c] of active) l.mapData.map[18 - r][c] = 1;
  return l;
};

test('original creep uses bottom-first coordinates and spreads four ways once after protection', () => {
  const { b, c, mechanism } = create(creepLevel());
  b.start();
  const creep = b._mizukiCreep;
  assert.equal(creep.isActive(9, 4), true);
  assert.equal(creep.isActive(8, 4), false);
  assert.equal(creep.activate(-1, 4), false);
  assert.equal(creep.pulse(), 0);
  step(c, 10.1);
  assert.equal(creep.pulse(), 4);
  assert.equal(creep.isActive(10, 4), true);
  assert.equal(creep.isActive(8, 4), true);
  assert.equal(creep.isActive(9, 3), true);
  assert.equal(creep.isActive(9, 5), true);
  assert.equal(creep.isActive(10, 5), false);
  assert.equal(creep.pulse(), 0);
  assert.equal(mechanism.snapshot().creep.tiles.filter((v) => v.active).length, 5);
});

test('original creep stops at an occupied source, but may enter an occupied clean destination', () => {
  const { b, c } = create(creepLevel());
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: 9, col: 5, dir: 'RIGHT' }).ok, true);
  const op = b.getPlayer('p1').units[0];
  b.addBuff(op, { key: 'test:creepImmune', flags: { invulnerable: true }, persist: true });
  step(c, 10.1);
  b._mizukiCreep.pulse();
  assert.equal(b._mizukiCreep.isActive(9, 5), true);
  b._mizukiCreep.deactivate(9, 4);
  b._mizukiCreep.deactivate(10, 4);
  b._mizukiCreep.deactivate(8, 4);
  b._mizukiCreep.deactivate(9, 3);
  step(c, 10.1);
  assert.equal(b._mizukiCreep.pulse(), 0);
  assert.equal(b._mizukiCreep.isActive(9, 6), false);
});

test('original creep skill level and per-instance blackboard drive damage and elemental scaling', () => {
  const l = creepLevel([[9, 5]]);
  const { b, c } = create(l);
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: 9, col: 5, dir: 'RIGHT' }).ok, true);
  const op = b.getPlayer('p1').units[0], hp = op.hp, res = op.s.res;
  step(c, 1);
  assert.ok(Math.abs(op.hp - (hp - 120 * (1 - res / 100))) < 1e-6);
  assert.equal(op.elem.neural, 20);
  assert.ok(op.findBuff('buff_creep[tile]'));
  const enemy = b.spawnEnemy('enemy_1007_slime', { pos: [9, 5] });
  enemy.pauseUntil = Infinity;
  assert.equal(b.dealDamage(null, enemy, { type: 'element', element: 'neural', amount: 30 }), 60);
  b._mizukiCreep.deactivate(9, 5);
  step(c, 0.1);
  assert.equal(op.findBuff('buff_creep[tile]'), null);
  assert.equal(b.dealDamage(null, enemy, { type: 'element', element: 'neural', amount: 30 }), 30);
  const reduced = resolveOfficialFacility(instance('trap_061_creep', 9, 4, { mainSkillLvl: 2 }));
  assert.equal(reduced.bb.damage, 24);
  assert.equal(reduced.bb.element_damage, 0);
});

test('original command terminal costs acting player DP once, upgrades and loses life when destroyed', () => {
  const { b, c, mechanism } = create(level([instance('trap_008_farm')]));
  b.start();
  const terminal = mechanism.commandUnits()[0], ps = b.getPlayer('p1');
  terminal.skill.gainSp(120);
  ps.dp = 19;
  assert.equal(c.command('p1', { type: 'skill', uid: terminal.uid }).error, 'NO_DP');
  assert.equal(terminal.skill.ready, true);
  ps.dp = 25;
  const before = c.snapshot().deployLimit;
  assert.equal(c.command('p1', { type: 'skill', uid: terminal.uid }).ok, true);
  assert.equal(ps.dp, 5);
  assert.equal(terminal.s.def, 300);
  assert.equal(terminal.s.res, 30);
  assert.equal(terminal.s.hpRegen, 10);
  assert.equal(c.snapshot().deployLimit, before + 1);
  terminal.skill.gainSp(120);
  ps.dp = 40;
  assert.equal(c.command('p1', { type: 'skill', uid: terminal.uid }).ok, false);
  assert.equal(ps.dp, 40);
  b.dealDamage(null, terminal, { type: 'true', amount: 5001, canDodge: false });
  assert.equal(c.leakDamage, 1);
  assert.equal(c.snapshot().deployLimit, before);
  assert.equal(b._manualPlayerId, null);
});

test('original altar uses its stage damage override after its source cast delay', () => {
  const l = level([instance('trap_011_ore', 9, 4,
    { overrideSkillBlackboard: [{ key: 'value', value: 300 }] })]);
  const { b, c } = create(l);
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: 9, col: 5, dir: 'RIGHT' }).ok, true);
  const op = b.getPlayer('p1').units[0], hp = op.hp;
  const altar = b.allyUnits.find((u) => u.defId === 'trap_011_ore');
  altar.skill.gainSp(7);
  step(c, 0.5);
  assert.equal(op.hp, hp);
  step(c, 0.2);
  assert.equal(op.hp, hp - 300);
  assert.equal(altar.hp, altar.s.maxHp);
});

test('original emergency station has no idle healing and uses original 25/75 recovery tiers', () => {
  const { b, c } = create(level([instance('trap_038_dsbell')]));
  b.start();
  const bell = b.allyUnits.find((u) => u.defId === 'trap_038_dsbell');
  step(c, 0.4);
  assert.equal(bell.mem.mizukiBellMode, 0);
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: 9, col: 5, dir: 'RIGHT' }).ok, true);
  const op = b.getPlayer('p1').units[0];
  b.dealDamage(null, op, { type: 'element', element: 'neural', amount: 500 });
  step(c, 0.4);
  assert.equal(bell.mem.mizukiBellMode, 1);
  let before = op.elem.neural;
  step(c, 1);
  assert.ok(Math.abs(before - op.elem.neural - 25) < 1e-6);
  const drone = b.spawnDevice('test:originalDroneMarker', 9, 3);
  b.addBuff(drone, { key: 'bell_active[mark]', persist: true });
  step(c, 0.4);
  assert.equal(bell.mem.mizukiBellMode, 2);
  before = op.elem.neural;
  step(c, 1);
  assert.ok(Math.abs(before - op.elem.neural - 75) < 1e-6);
});

test('original ballista uses a physical straight projectile and stops on the first ally', () => {
  const { b, c, mechanism } = create(level([instance('trap_007_ballis')]));
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: 9, col: 6, dir: 'RIGHT' }).ok, true);
  const op = b.getPlayer('p1').units[0], hp = op.hp;
  const ballista = b.allyUnits.find((u) => u.defId === 'trap_007_ballis');
  ballista.skill.gainSp(5);
  step(c, 0.1);
  assert.equal(op.hp, hp);
  step(c, 0.4);
  assert.ok(op.hp < hp);
  assert.equal(mechanism.snapshot().ballistas.length, 0);
  assert.ok(mechanism.snapshot().effects.some((fx) => fx.key === 'bolt_buff_01_start' && fx.active));
  assert.equal(b.errorCount, 0);
});

test('original volcanic tiles wait for cd_min and use original different ally and enemy hit ranges', () => {
  const l = level([]);
  l.mapData = { tiles: [{ tileKey: 'tile_road', blackboard: [] },
    { tileKey: 'tile_volcano', blackboard: [{ key: 'damage', value: 800 },
      { key: 'cd_min', value: 12 }, { key: 'cd_max', value: 15 }] }],
  map: Array.from({ length: 19 }, () => Array(21).fill(0)) };
  l.mapData.map[18 - 9][4] = 1;
  const { b, c, mechanism } = create(l);
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: 9, col: 5, dir: 'RIGHT' }).ok, true);
  const op = b.getPlayer('p1').units[0];
  b.addBuff(op, { key: 'test:noAttack', flags: { disarm: true }, persist: true });
  const inside = b.spawnEnemy('enemy_1007_slime', { pos: [9, 4] });
  const outside = b.spawnEnemy('enemy_1007_slime', { pos: [9, 5] });
  for (const enemy of [inside, outside]) {
    enemy.pauseUntil = Infinity;
    b.addBuff(enemy, { key: 'test:noAttack', flags: { disarm: true }, persist: true });
  }
  const damage = [];
  b.on('damaged', (ctx) => { if (ctx.dmg.tags.includes('mizuki:volcano')) damage.push(ctx.target.id); });
  step(c, 11.9);
  assert.equal(damage.length, 0);
  step(c, 3.3);
  assert.deepEqual(new Set(damage), new Set([op.id, inside.id]));
  assert.equal(mechanism.snapshot().volcano[0].casts, 1);
  assert.equal(b.errorCount, 0);
});

test('original shield guard attacks with native ally AI without occupying a player deployment slot', () => {
  const { b, c } = create(level([instance('trap_024_npcsld')]));
  b.start();
  const guard = b.allyUnits.find((u) => u.defId === 'trap_024_npcsld');
  const enemy = b.spawnEnemy('enemy_1007_slime', { pos: [9, 4.3] });
  enemy.pauseUntil = Infinity;
  const hits = [];
  b.on('damaged', (ctx) => { if (ctx.source === guard) hits.push(ctx.amount); });
  step(c, 4);
  assert.ok(hits.some((v) => v > 0));
  assert.equal(c.snapshot().deploySlotsUsed, 0);
  assert.equal(b.errorCount, 0);
});

test('original boxes are stationary enemy targets, not allied blockers or counted wave units', () => {
  const { c, b, mechanism } = create(level([instance('trap_065_normbox')]));
  b.start();
  const box = b.enemies.find((u) => u.defId === 'trap_065_normbox');
  assert.ok(box && box.side === 'enemy');
  assert.equal(box.counted, false);
  assert.equal(box._officialFacility, true);
  assert.equal(box.s.maxHp, 5000);
  assert.equal(box.s.def, 200);
  step(c, 1);
  assert.deepEqual([box.y, box.x], [9, 4]);
  b.dealDamage(null, box, { type: 'true', amount: 5001, canDodge: false });
  assert.equal(box.alive, false);
  assert.equal(mechanism.snapshot().logs.trap_065_normbox, 1);
});

test('original infection blackboard overrides native defaults without changing its source file', () => {
  const l = JSON.parse(readFileSync(new URL('../data/mizuki/levels/level_rogue2_3-1.json', import.meta.url), 'utf8'));
  const tile = l.mapData.tiles.find((v) => v.tileKey === 'tile_infection');
  if (tile) assert.deepEqual(officialTerrainConfig(l).infection.bb, Object.fromEntries(tile.blackboard.map((v) => [v.key, v.value])));
  const tide = instance('trap_042_tidectrl', 0, 0, { skillIndex: 2 });
  assert.equal(officialTerrainConfig(level([tide])).deepsea.bb['sea_drown[enemy].damage'], 40);
});
import { findOfficialPredefined } from '../server/modes/mizuki/OfficialPredefines.js';
import { inspectOfficialActionDependencies } from '../server/modes/mizuki/official-stages.js';

test('original deep-cognition typo alias resolves through the same badbox native branch ID', () => {
  const source = JSON.parse(readFileSync(new URL('../data/mizuki/levels/level_rogue2_6-2.json', import.meta.url), 'utf8'));
  const box = findOfficialPredefined(source, 'trap_068_badbox#2');
  assert.equal(box.alias, 'trap_068_badbox2#');
  assert.equal(box.inst.characterKey, 'trap_068_badbox');
  assert.equal(findOfficialPredefined(source, 'not-an-alias'), null);
  assert.ok(inspectOfficialActionDependencies(source).supportedBranchKeys.includes('trap_068_badbox#2'));
});

test('native crate cards use original shared quantity cost and real tile obstacle lifecycle', () => {
  const source = level([]);
  source.predefines.tokenCards = [{ initialCnt: 10, hidden: false,
    inst: { characterKey: 'trap_001_crate', phase: 'PHASE_0', level: 1 }, skillIndex: 0, mainSkillLvl: 1 }];
  const { b, mechanism } = create(source), p = b.getPlayer('p1');
  p.dp = 20;
  assert.deepEqual(mechanism.cardOptions(), [{ key: 'trap_001_crate', name: '障碍物',
    count: 10, initialCount: 10, cost: 5, respawnTime: 5,
    cooldown: 0, readyAt: 0, redeployRemaining: 0, deployable: true }]);
  const tile = [9, 4], originalTile = b.grid.tile(...tile);
  assert.equal(mechanism.deployCard('trap_001_crate', ...tile, 'WRONG', { playerId: 'p1' }).error, 'BAD_DIRECTION');
  assert.equal(mechanism.deployCard('trap_001_crate', ...tile, 'RIGHT', { playerId: 'missing' }).error, 'NOT_PLAYER');
  const result = mechanism.deployCard('trap_001_crate', ...tile, 'RIGHT', { playerId: 'p1' });
  assert.equal(result.ok, true); assert.equal(result.count, 9); assert.equal(result.cost, 5); assert.equal(p.dp, 15);
  const unit = b.units.find((u) => u.id === result.unitId);
  assert.equal(unit.s.maxHp, 100); assert.equal(unit.s.blockCnt, 3);
  assert.equal(b.grid.isCrate(...tile), true); assert.equal(b.grid.tile(...tile).build, 'NONE');
  assert.equal(mechanism.snapshot().cards[0].count, 9);
  assert.equal(mechanism.deployCard('trap_001_crate', ...tile, 'RIGHT', { playerId: 'p1' }).error, 'WRONG_TILE');
  p.dp = 4;
  assert.equal(mechanism.deployCard('trap_001_crate', 9, 5, 'RIGHT', { playerId: 'p1' }).error, 'NO_DP');
  assert.equal(mechanism.cardOptions()[0].count, 9);
  b.kill(unit, null); assert.equal(b.grid.isCrate(...tile), false);
  assert.equal(b.grid.tile(...tile), originalTile); assert.equal(mechanism.cardOptions()[0].count, 9);
  assert.equal(b.errorCount, 0);
});
