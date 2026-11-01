import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat, MizukiAutoCombat } from '../server/modes/mizuki/Combat.js';
import { Battle } from '../server/sim/Battle.js';
import { getDefaultSource, spawnsFromTemplate } from '../server/sim/simdata.js';
import { getData } from '../server/data.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';

// These tests exercise the real runtime map, operators, kits and enemy data.
const players = () => [
  { playerId: 'p1', seat: 0, units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] },
  { playerId: 'p2', seat: 1, units: [{ uid: 201, chessId: 'chess_char_1_03_a' }] },
];
const create = (opts = {}) => new MizukiCombat({
  battleId: 'test.mz.A', fieldId: 'mizuki_a', seed: 42, stageId: 'act1autochess_m02',
  rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players: players(),
  spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }], timeLimit: 180, ...opts,
});
const deploy = (c, pid = 'p1', uid = 101, row = 9, col = 5) =>
  c.command(pid, { type: 'deploy', uid, row, col, dir: 'RIGHT' });
const bond = (c, pid, id) => c.snapshot().covenants[pid].find((b) => b.id === id);
const rosterCombat = (ids, extra = {}) => create({ players: [{ playerId: 'p1',
  units: ids.map((chessId, i) => ({ uid: 101 + i, chessId })) }], flags: { dpInit: 999, dpMax: 999 }, ...extra });

for (const Combat of [MizukiCombat, MizukiAutoCombat]) test(Combat.name + ': 独行 never restores or gains layers', () => {
  const c = new Combat({ battleId: 'solo-test', seed: 42, stageId: 'act1autochess_m02',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 },
    players: [{ playerId: 'p1', seat: 0, layers: { soloShip: 77 },
      progression: { layers: { soloShip: 88 } },
      bonds: { soloShip: { count: 1, active: true, tier: 1, layers: 99 } },
      units: [{ uid: 101, chessId: 'chess_char_1_08_a', row: 9, col: 5 }] }],
    spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }], timeLimit: 180 });
  assert.equal(c.battle.getPlayer('p1').bonds.soloShip.layers, 0);
  assert.equal(c.battle.addLayers('p1', 'soloShip', 50), 0);
  assert.equal(c.covenants.progression().players.p1.layers.soloShip, 0);
  assert.equal(bond(c, 'p1', 'soloShip').layers, 0);
  assert.equal(c.battle.errorCount, 0);
});

test('Mizuki PREP snapshot is empty, reconnect metadata includes geometry and both independent DP pools', () => {
  const c = create();
  const s = c.snapshot();
  assert.equal(c.battle.started, false);
  assert.deepEqual(s.units, []);
  assert.deepEqual(s.dps, { p1: 35, p2: 35 });
  assert.equal(s.geometry.tiles.length, 4 * 9);
  assert.equal(s.deployLimit, 6);
  assert.equal(s.rosters.p1[0].deployed, false);
  assert.equal(s.rosters.p2[0].uid, 201);
  assert.equal(c.result(), null);
  assert.equal(c.dt, 1 / 30);
  c.step();
  assert.equal(c.tick, 1);
  assert.equal(c.battle.allyUnits.filter((u) => u.kind === 'op' && u.deployed).length, 0);
});

test('Mizuki validates actor ownership, terrain, direction, cost, occupied tile and independent player caps', () => {
  const c = create();
  assert.equal(deploy(c, 'p1', 201).error, 'NOT_OWNER');
  assert.equal(deploy(c, 'intruder').error, 'NOT_PLAYER');
  assert.equal(deploy(c, 'p1', 999).error, 'UNKNOWN_UNIT');
  assert.equal(deploy(c, 'p1', 101, 9, 2).error, 'WRONG_TILE');
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: 9, col: 5, dir: 'FORWARD' }).error, 'BAD_DIRECTION');
  const cost = c.snapshot().rosters.p1[0].cost;
  const ok = deploy(c);
  assert.equal(ok.ok, true);
  assert.equal(c.snapshot().dps.p1, 35 - cost);
  assert.equal(c.snapshot().dps.p2, 35);
  assert.equal(deploy(c, 'p2', 201, 9, 5).error, 'OCCUPIED');
  assert.equal(deploy(c, 'p1', 101, 9, 6).error, 'ALREADY_DEPLOYED');
  assert.equal(c.fieldMeta().units.find((u) => u.uid === 101).ownerId, 'p1');
  assert.equal(c.fieldMeta().units.find((u) => u.uid === 101).dir, 'RIGHT');
  assert.equal(deploy(create({ flags: { dpInit: 0 } })).error, 'NO_DP');
  const limited = create({ deployLimit: 1, players: [
    { playerId: 'p1', seat: 0, units: [{ uid: 101, chessId: 'chess_char_1_02_a' }, { uid: 102, chessId: 'chess_char_1_02_a' }] },
    players()[1],
  ] });
  assert.equal(deploy(limited).ok, true);
  assert.equal(deploy(limited, 'p2', 201, 9, 6).ok, true);
  assert.equal(deploy(limited, 'p1', 102, 10, 5).error, 'DEPLOY_LIMIT');
});

test('Mizuki explicit retreat frees tile, refunds once, waits cooldown and never redeploys automatically', () => {
  const c = create();
  assert.equal(deploy(c).ok, true);
  const before = c.snapshot().dps.p1;
  const cost = c.snapshot().rosters.p1[0].cost;
  const ret = c.command('p1', { type: 'retreat', uid: 101 });
  assert.equal(ret.ok, true);
  assert.equal(ret.refund, Math.floor(cost / 2));
  assert.equal(c.snapshot().dps.p1, before + ret.refund);
  assert.equal(c.command('p1', { type: 'retreat', uid: 101 }).error, 'NOT_DEPLOYED');
  assert.equal(deploy(c).error, 'COOLDOWN');
  assert.equal(deploy(c, 'p2', 201, 9, 5).ok, true);
  for (let i = 0; i < Math.ceil(ret.redeployRemaining * 30) + 3; i++) c.step();
  assert.equal(c.snapshot().rosters.p1[0].deployed, false);
  assert.equal(c.snapshot().rosters.p1[0].redeployRemaining, 0);
  assert.equal(deploy(c, 'p1', 101, 9, 6).ok, true);
  assert.equal(c.snapshot().meta.units.find((u) => u.uid === 101).x, 6);
});

test('Mizuki native devour locks manual deployment and all direct redeploy revival paths until release', () => {
  const c = create({ flags: { dpInit: 999, dpMax: 999 } }), b = c.battle, u = b.getPlayer('p1').units[0];
  assert.equal(deploy(c).ok, true);
  const dp = b.getPlayer('p1').dp;
  let revivedDuringDeath = null;
  b.on('death', (ctx) => { if (ctx.unit === u) revivedDuringDeath = b.redeploy(u, { free: true }); });
  u.mem.mizukiDevouredBy = 'native-devourer';
  b.kill(u, u);
  u.respawnAt = -1;
  assert.equal(revivedDuringDeath, false);
  assert.equal(u.alive, false);
  assert.equal(b.redeploy(u, { free: true }), false);
  assert.equal(b.getPlayer('p1').dp, dp);
  assert.equal(deploy(c).error, 'DEVOUR_LOCKED');
  const locked = c.snapshot().rosters.p1[0];
  assert.equal(locked.deployable, false);
  assert.equal(locked.disabledReason, 'DEVOUR_LOCKED');
  assert.equal(locked.devouredBy, 'native-devourer');
  assert.equal(locked.redeployRemaining, 0);
  delete u.mem.mizukiDevouredBy;
  u.respawnAt = b.time;
  assert.equal(c.snapshot().rosters.p1[0].deployable, true);
  assert.equal(c.snapshot().rosters.p1[0].devouredBy, null);
  assert.equal(deploy(c).ok, true);
  assert.equal(b.errorCount, 0);
});

test('Mizuki manual skills gain SP but strategy and direct kit casts cannot activate them', () => {
  const c = create();
  assert.equal(deploy(c).ok, true);
  assert.equal(c.command('p2', { type: 'skill', uid: 101 }).error, 'NOT_OWNER');
  assert.equal(c.command('p1', { type: 'skill', uid: 101 }).error, 'SKILL_NOT_READY');
  const u = c.battle.getPlayer('p1').units[0];
  assert.equal(u.skill.manual, true);
  const initialSp = u.skill.sp;
  for (let i = 0; i < 60; i++) c.step();
  assert.ok(u.skill.sp > initialSp);
  u.skill.gainSp(1000, 'test');
  assert.equal(u.skill.ready, true);
  assert.equal(u.skill.activate('DEFAULT'), false);
  for (let i = 0; i < 120; i++) c.step();
  assert.equal(u.skill.activations, 0);
  assert.equal(c.snapshot().rosters.p1[0].skill.ready, true);
  c.battle.addBuff(u, { key: 'test:silenced', flags: { silence: true } });
  assert.equal(c.command('p1', { type: 'skill', uid: 101 }).error, 'UNIT_DISABLED');
  c.battle.removeBuff(u, 'test:silenced');
  assert.equal(c.command('p1', { type: 'skill', uid: 101 }).ok, true);
  assert.equal(u.skill.activations, 1);
  assert.equal(c.command('p1', { type: 'skill', uid: 101 }).error, 'SKILL_NOT_READY');
});

test('Mizuki real wave naturally completes and reports exact cumulative leak damage', () => {
  const wave = spawnsFromTemplate(getDefaultSource().rawWave('act1autochess_01'));
  const c = create({ stageId: 'act1autochess_m01', ...wave, enemyOverrides: wave.overrides, timeLimit: 180 });
  for (let i = 0; i < 5401 && !c.done; i++) c.step();
  assert.equal(c.done, true);
  assert.equal(c.result().outcome, 'victory');
  assert.equal(c.result().reason, 'cleared');
  assert.equal(c.result().total, 6);
  assert.equal(c.result().resolved, 6);
  assert.ok(c.result().leakDamage > 0);
  assert.equal(c.result().errors, 0);
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: 9, col: 4, dir: 'RIGHT' }).error, 'BATTLE_ENDED');
  assert.ok(c.drainEvents().some((ev) => ev[0] === 'leak'));
  assert.deepEqual(c.drainEvents(), []);
  assert.doesNotThrow(() => JSON.stringify(c.snapshot()));
});

test('Mizuki optional local HP loses on a lethal leak; original Battle still auto-deploys', () => {
  const c = create({ teamHp: 1, spawns: [{ time: 0, enemyKey: 'enemy_1007_slime', count: 1 }] });
  for (let i = 0; i < 5401 && !c.done; i++) c.step();
  assert.equal(c.result().outcome, 'defeat');
  assert.equal(c.snapshot().teamHp, 0);
  // Supply valid board coordinates as the ordinary engine expects.
  const original = new Battle({ stageId: 'act1autochess_m02',
    players: [{ playerId: 'p1', units: [{ uid: 101, chessId: 'chess_char_1_02_a', row: 9, col: 5 }] }], content: 'none' });
  original.start();
  assert.equal(original.getPlayer('p1').units[0].deployed, true);
});

test('Mizuki timeout charges spawned surviving enemies once and excludes unspawned enemies', () => {
  const c = create({ timeLimit: 1, spawns: [
    { time: 0, enemyKey: 'enemy_1007_slime', count: 2 },
    { time: 5, enemyKey: 'enemy_1007_slime', count: 1 },
  ] });
  for (let i = 0; i < 31 && !c.done; i++) c.step();
  assert.equal(c.result().outcome, 'timeout');
  assert.equal(c.result().leakedCount, 2);
  assert.equal(c.result().leakDamage, 2);
  assert.equal(c.result().unspawned.length, 1);
  assert.equal(c.snapshot().leakDamage, 2);
  c.step();
  assert.equal(c.snapshot().leakDamage, 2);
});

test('Mizuki deployed-only covenants activate and revoke real solo buffs without reserve counts or stacking', () => {
  const c = rosterCombat(['chess_char_1_08_a', 'chess_char_2_17_a']);
  const [texas, fold] = c.battle.getPlayer('p1').units;
  assert.equal(bond(c, 'p1', 'soloShip').count, 0);
  assert.equal(deploy(c).ok, true);
  assert.equal(bond(c, 'p1', 'soloShip').count, 1);
  assert.equal(texas.s.atk, texas.base.atk * 1.6);
  assert.equal(fold.findBuff('bond:soloShip'), null);
  assert.equal(deploy(c, 'p1', 102, 9, 6).ok, true);
  assert.equal(bond(c, 'p1', 'soloShip').active, false);
  assert.equal(texas.s.atk, texas.base.atk);
  assert.equal(c.command('p1', { type: 'retreat', uid: 102 }).ok, true);
  assert.equal(texas.s.atk, texas.base.atk * 1.6);
  fold.respawnAt = c.time;
  assert.equal(deploy(c, 'p1', 102, 9, 6).ok, true);
  c.battle.kill(fold);
  assert.equal(bond(c, 'p1', 'soloShip').count, 1);
  assert.equal(texas.buffs.filter((b) => b.key === 'bond:soloShip').length, 1);
  assert.equal(c.battle.errorCount, 0);
});

test('Mizuki covenants retain the existing distinct-name and owner isolation rules', () => {
  const c = create({ flags: { dpInit: 99 }, players: [
    { playerId: 'p1', units: [{ uid: 101, chessId: 'chess_char_1_09_a' }, { uid: 102, chessId: 'chess_char_1_09_a' }] },
    { playerId: 'p2', units: [{ uid: 201, chessId: 'chess_char_1_17_a' }] },
  ] });
  assert.equal(deploy(c).ok, true);
  assert.equal(deploy(c, 'p1', 102, 9, 6).ok, true);
  assert.equal(deploy(c, 'p2', 201, 10, 5).ok, true);
  assert.equal(bond(c, 'p1', 'preciShip').count, 1);
  assert.equal(bond(c, 'p2', 'preciShip').count, 1);
  assert.equal(bond(c, 'p1', 'preciShip').active, false);
  assert.equal(bond(c, 'p2', 'preciShip').active, false);
});

test('Mizuki swift uses the real non-stat skillEnd proc and stops immediately below threshold', () => {
  const c = rosterCombat(['chess_char_1_01_a', 'chess_char_1_19_a']);
  assert.equal(deploy(c).ok, true);
  assert.equal(deploy(c, 'p1', 102, 9, 6).ok, true);
  const [unit, second] = c.battle.getPlayer('p1').units;
  c.battle.rng = Object.assign(() => 0, c.battle.rng);
  unit.skill.setSpTotal(0);
  c.battle.emit('skillEnd', { unit, skill: unit.skill, reason: 'duration' });
  assert.ok(unit.skill.sp > 0, 'real swift hook grants SP');
  assert.equal(c.command('p1', { type: 'retreat', uid: second.uid }).ok, true);
  unit.skill.setSpTotal(0);
  c.battle.emit('skillEnd', { unit, skill: unit.skill, reason: 'duration' });
  assert.equal(unit.skill.sp, 0);
  assert.equal(c.battle.errorCount, 0);
});

test('Mizuki native garrisons grant actual layers once and keep per-battle caps across redeployment', () => {
  const c = rosterCombat(['chess_char_2_06_a', 'chess_char_1_12_a', 'chess_char_2_08_a']);
  for (let i = 0; i < 3; i++) assert.equal(deploy(c, 'p1', 101 + i, 9, 4 + i).ok, true);
  const unit = c.battle.getPlayer('p1').units[0];
  assert.equal(bond(c, 'p1', 'sargonShip').active, true);
  c.battle.emit('skillStart', { unit, skill: unit.skill });
  assert.equal(bond(c, 'p1', 'sargonShip').layers, 5);
  assert.equal(c.command('p1', { type: 'retreat', uid: unit.uid }).ok, true);
  unit.respawnAt = c.time;
  assert.equal(deploy(c, 'p1', unit.uid, 9, 4).ok, true);
  c.battle.emit('skillStart', { unit, skill: unit.skill });
  assert.equal(bond(c, 'p1', 'sargonShip').layers, 5);
  assert.equal(c.battle.errorCount, 0);
});

test('Mizuki ADD_BOND grants use real positional helpers, revoke on departure and preserve granted caps', () => {
  const c = rosterCombat(['chess_char_4_26_a', 'chess_char_1_09_a', 'chess_char_1_17_a']);
  assert.equal(deploy(c, 'p1', 101, 9, 5).ok, true);
  assert.equal(deploy(c, 'p1', 102, 9, 6).ok, true);
  assert.equal(deploy(c, 'p1', 103, 10, 5).ok, true);
  const [grantor, target] = c.battle.getPlayer('p1').units;
  const granted = () => c.snapshot().garrisons.p1.find((u) => u.uid === target.uid).traits
    .find((t) => t.id === 'garrison_95_a');
  assert.equal(granted().grantedBy, grantor.uid);
  assert.equal(granted().cap, 12, 'preserves original GRANTED_CAP_OVERRIDE');
  c.battle.emit('skillStart', { unit: target, skill: target.skill });
  assert.equal(bond(c, 'p1', 'preciShip').layers, 1);
  c.command('p1', { type: 'retreat', uid: grantor.uid });
  c.battle.emit('skillStart', { unit: target, skill: target.skill });
  assert.equal(bond(c, 'p1', 'preciShip').layers, 1);
  grantor.respawnAt = c.time;
  assert.equal(deploy(c, 'p1', grantor.uid, 9, 5).ok, true);
  for (let i = 0; i < 20; i++) c.battle.emit('skillStart', { unit: target, skill: target.skill });
  assert.equal(bond(c, 'p1', 'preciShip').layers, 12);
  c.command('p1', { type: 'retreat', uid: grantor.uid });
  grantor.respawnAt = c.time;
  deploy(c, 'p1', grantor.uid, 9, 5);
  c.battle.emit('skillStart', { unit: target, skill: target.skill });
  assert.equal(bond(c, 'p1', 'preciShip').layers, 12);
  assert.equal(c.battle.errorCount, 0);
});

test('Mizuki original Emperor strategy keeps real deployment stacks while squad buffs are applied once', () => {
  const c = rosterCombat(['chess_char_1_02_a'], { players: [{ playerId: 'p1', bandId: 'band_emperor',
    squadMods: { atkPct: 0.15, hpPct: 0.15 }, units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] }] });
  const unit = c.battle.getPlayer('p1').units[0];
  assert.equal(deploy(c).ok, true);
  const first = unit.s.redeployMul;
  assert.ok(first < 1);
  c.command('p1', { type: 'retreat', uid: unit.uid });
  unit.respawnAt = c.time;
  deploy(c, 'p1', unit.uid, 9, 5);
  assert.ok(unit.s.redeployMul < first);
  assert.equal(unit.buffs.filter((b) => b.key === 'mizuki:squad').length, 1);
  assert.equal(unit.s.atk, unit.base.atk * 1.15);
  assert.equal(c.battle.errorCount, 0);
});

test('Mizuki full catalog aliases expose real Mon3tr manual deployment, ownership, owner binding and cooldown', () => {
  const catalog = createMizukiCatalog(getData());
  const c = rosterCombat(['mizuki_char_003_kalts'], { data: catalog.source });
  const initial = c.snapshot().rosters.p1;
  const token = initial.find((u) => u.isToken);
  assert.ok(token);
  assert.ok(Number.isSafeInteger(token.uid) && token.uid > 0);
  assert.equal(token.tokenId, 'token_10002_kalts_mon3tr');
  assert.equal(token.disabledReason, 'OWNER_NOT_DEPLOYED');
  assert.equal(deploy(c, 'p1', token.uid, 9, 6).error, 'OWNER_NOT_DEPLOYED');
  assert.equal(deploy(c).ok, true);
  assert.equal(deploy(c, 'p1', token.uid, 9, 6).ok, true);
  const actual = c.battle.getPlayer('p1').units.find((u) => u.uid === token.uid);
  assert.equal(actual.s.blockCnt, 3);
  assert.equal(actual.ownerUnit.uid, 101);
  assert.equal(bond(c, 'p1', 'maniShip').count, 0, 'summons never count as operators');
  c.command('p1', { type: 'retreat', uid: token.uid });
  assert.equal(deploy(c, 'p1', token.uid, 9, 6).error, 'COOLDOWN');
  actual.mem.readyAt = c.time;
  actual.mem.respawnAt = c.time;
  assert.equal(deploy(c, 'p1', token.uid, 9, 6).ok, true);
  c.command('p1', { type: 'retreat', uid: 101 });
  assert.equal(actual.alive, false, 'original Kaltsit kit withdraws Mon3tr with its owner');
  assert.equal(c.snapshot().rosters.p1.find((u) => u.uid === token.uid).disabledReason, 'OWNER_NOT_DEPLOYED');
  assert.equal(c.battle.errorCount, 0);
});

test('Mizuki Yan opening creates one real Yanyou, revokes it below threshold and never duplicates or heals it on toggles', () => {
  const ids = ['chess_char_1_03_a', 'chess_char_2_04_a', 'chess_char_3_03_a',
    'chess_char_3_04_a', 'chess_char_4_15_a', 'chess_char_4_17_a'];
  const c = rosterCombat(ids);
  const tiles = [[9, 3], [9, 4], [9, 5], [9, 6], [10, 3], [10, 4]];
  for (let i = 0; i < ids.length; i++) assert.equal(deploy(c, 'p1', 101 + i, ...tiles[i]).ok, true);
  const tokens = c.battle.allyUnits.filter((u) => u.mem.bondYan);
  assert.equal(tokens.length, 1);
  const yanyou = tokens[0];
  assert.equal(yanyou.alive, true);
  yanyou.hp = yanyou.s.maxHp / 2;
  c.command('p1', { type: 'retreat', uid: 106 });
  assert.equal(yanyou.alive, false);
  c.battle.getPlayer('p1').units.find((u) => u.uid === 106).respawnAt = c.time;
  assert.equal(deploy(c, 'p1', 106, ...tiles[5]).ok, true);
  assert.equal(yanyou.alive, true);
  assert.equal(yanyou.hpRatio, 0.5);
  assert.equal(c.battle.allyUnits.filter((u) => u.mem.bondYan).length, 1);
  assert.equal(c.battle.errorCount, 0);
});

test('Mizuki Egir opening uses real devour once, recomputes actual casualties and cannot farm opening layers', () => {
  const c = rosterCombat(['chess_char_1_04_a', 'chess_char_2_07_a', 'chess_char_3_05_a']);
  for (let i = 0; i < 3; i++) assert.equal(deploy(c, 'p1', 101 + i, 9, 3 + i).ok, true);
  const units = c.battle.getPlayer('p1').units.filter((u) => u.kind === 'op');
  const first = bond(c, 'p1', 'egirShip');
  assert.ok(first.layers > 0, 'real opening devour awards the victims original tiers');
  assert.equal(first.count, units.filter((u) => u.alive && u.deployed).length);
  assert.ok(first.count < 3, 'real 5000 physical HP loss knocks out marked victims');
  for (const unit of units) if (!unit.alive) { unit.respawnAt = c.time; deploy(c, 'p1', unit.uid, 9, 3 + units.indexOf(unit)); }
  assert.equal(bond(c, 'p1', 'egirShip').layers, first.layers);
  assert.equal(bond(c, 'p1', 'egirShip').count, 3);
  assert.equal(c.battle.errorCount, 0);
});

test('Mizuki every catalog entry and its placed summons initialize and deploy with the original real kits', () => {
  const catalog = createMizukiCatalog(getData()), failures = [];
  for (const operator of catalog.operators) {
    const c = rosterCombat([operator.operatorId], { data: catalog.source, logger: { error() {}, warn() {}, log() {} } });
    const deployed = deploy(c);
    if (!deployed.ok) failures.push([operator.operatorId, deployed]);
    for (let i = 0; i < 3; i++) c.step();
    const unit = c.battle.getPlayer('p1').units.find((u) => u.uid === 101);
    if (unit.alive && unit.skill.manual && !unit.skill.noSkill) {
      unit.skill.setSpTotal(unit.skill.spCost * unit.skill.maxCharges);
      c.command('p1', { type: 'skill', uid: unit.uid });
    }
    for (const token of c.snapshot().rosters.p1.filter((u) => u.isToken)) {
      assert.ok(Number.isSafeInteger(token.uid) && token.uid > 0);
      assert.equal(token.ownerUid, unit.uid);
      if (token.deployable && !token.deployed) deploy(c, 'p1', token.uid, 9, 6);
    }
    for (let i = 0; i < 3; i++) c.step();
    if (c.battle.errorCount || c.battle.contentFault) failures.push([operator.operatorId, c.battle.errors]);
  }
  assert.deepEqual(failures, []);
});
