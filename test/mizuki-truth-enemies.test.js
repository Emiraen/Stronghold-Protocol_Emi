import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat, MizukiAutoCombat } from '../server/modes/mizuki/Combat.js';
import { createOfficialMizukiStage, resolveOfficialEnemy } from '../server/modes/mizuki/official-stages.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { normalizeEnemy } from '../server/sim/simdata.js';
import { abOf, attach } from '../server/sim/content/enemies.js';
import { acquireTargets, updateEnemy } from '../server/sim/ai.js';
import { MIZUKI_TRUTH_KITS, snapshotMizukiTruthEffects } from '../server/modes/mizuki/native-truth-enemies.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';

const create = () => {
  const catalog = createMizukiCatalog(getData());
  const options = createOfficialMizukiStage('ro2_n_1_1', { data: catalog.source });
  const data = Object.create(options.data);
  data.getEnemy = (id) => {
    if (!MIZUKI_TRUTH_KITS[id]) return options.data.getEnemy(id);
    const s = resolveOfficialEnemy({ id, level: 0, useDb: true });
    const bb = (entries = []) => ({ bb: Object.fromEntries(entries.map((v) => [v.key, v.value])) });
    return normalizeEnemy(id, { key: id, name: s.name, spine: s.prefabKey, applyWay: s.applyWay,
      officialData: s, stats: { ...s.attributes, res: s.attributes.magicResistance, rangeRadius: s.rangeRadius,
        motion: s.motion, lpr: s.lifePointReduce }, talents: bb(s.talentBlackboard ?? []),
      skills: (s.skills ?? []).map((v) => ({ ...v, ...bb(v.blackboard ?? []) })) });
  };
  return new MizukiCombat({ ...options, data, seed: 7, content: 'full',
    players: [{ playerId: 'p1', units: [{ uid: 101, chessId: 'chess_char_1_02_a' }, { uid: 102, chessId: 'chess_char_1_02_a' }] }],
    flags: { dpInit: 999, dpMax: 999 } });
};
const native = (b, id) => {
  const e = b.spawnEnemy(id, { ownerId: 'p1' }), ab = abOf(b, e);
  ab.list = []; attach(b, e, MIZUKI_TRUTH_KITS[id](ab, e, b)); return e;
};
const allies = (c) => {
  const tiles = c.snapshot().geometry.tiles.filter((v) => c.battle.grid.canStand(v.row, v.col, { ranged: false }) && !v.obstacle);
  for (const [i, uid] of [101, 102].entries()) {
    const tile = tiles[i];
    assert.equal(c.command('p1', { type: 'deploy', uid, row: tile.row, col: tile.col, dir: 'RIGHT' }).ok, true);
  }
  const list = c.battle.getPlayer('p1').units;
  for (const u of list) {
    c.battle.addBuff(u, { key: 'test:hp', mods: { hpFlat: 1000000 } }); u.hp = u.s.maxHp;
  }
  return list;
};
const scheduled = (b, time) => { b.time = time; b._runScheduled(); };

test('native knight weakens global highest ATK at the original skill frame, excluding an existing weaken', () => {
  const c = create(), b = c.battle, [high, low] = allies(c), e = native(b, 'enemy_1104_lfkght_2');
  b.addBuff(high, { key: 'test:atk', mods: { atkFlat: 10000 } });
  e.x = high.x + 10; e.y = high.y; // The native skill is global.
  const original = high.s.atk;
  b.emit('tick', { dt: 14.99 }); assert.equal(e.mem.mizukiTruthKnight.cast, undefined);
  b.emit('tick', { dt: .01 }); assert.ok(e.mem.mizukiTruthKnight.cast);
  scheduled(b, .399); assert.equal(high.findBuff('lfkght_s[weaken]'), null);
  scheduled(b, .4);
  assert.equal(high.findBuff('lfkght_s[weaken]').duration, 25);
  assert.equal(high.findBuff('lfkght_s[weaken]').mods.atkPct, -.5);
  assert.equal(high.s.atk, original * .5);
  assert.equal(low.findBuff('lfkght_s[weaken]'), null);
  scheduled(b, 1.5); b.emit('tick', { dt: 15 }); scheduled(b, 1.9);
  assert.ok(low.findBuff('lfkght_s[weaken]'));
  assert.equal(high.findBuff('lfkght_s[weaken]').timeLeft, 25); // no refresh
  b._tickBuffs(25);
  assert.equal(high.findBuff('lfkght_s[weaken]'), null);
  assert.equal(high.s.atk, original); assert.equal(b.errorCount, 0);
});

test('native knight normal attack uses original arts damage without a generic projectile', () => {
  const c = create(), b = c.battle, [u] = allies(c), e = native(b, 'enemy_1104_lfkght_2');
  assert.deepEqual(e.def.attackAnim, { dur: 2 / 1.4, hit: .967 / 1.4 });
  assert.equal(e.profile.canTarget({ isFlying: true }), false);
  const hp = u.hp;
  b.emit('attack', { attacker: e, targets: [u] });
  assert.equal(b.projectiles.list.length, 0);
  assert.ok(Math.abs(hp - u.hp - e.s.atk * (1 - u.s.res / 100)) < 1e-8);
  assert.equal(b.errorCount, 0);
});

test('native knight resurrects once after five seconds at twenty percent HP, including a lethal hit during its cast', () => {
  const c = create(), b = c.battle; allies(c); const e = native(b, 'enemy_1104_lfkght_2');
  b.emit('tick', { dt: 15 }); assert.equal(e.profile.noAttack, true);
  const killed = b.killed;
  b.kill(e); assert.equal(e.alive, true); assert.equal(b.killed, killed);
  assert.equal(e.findBuff('mizuki:lfkght:reborn').duration, 5);
  assert.equal(e.s.flags.untargetable, true); assert.equal(e.s.flags.noMove, true);
  scheduled(b, .4); assert.equal(b.allyUnits.some((u) => u.findBuff('lfkght_s[weaken]')), false);
  b._tickBuffs(4.999); assert.equal(e.hp, 1);
  b._tickBuffs(.001); assert.equal(e.hp, e.s.maxHp * .2);
  assert.equal(e.profile.noAttack, false); assert.equal(!!e.s.flags.untargetable, false);
  b.kill(e); assert.equal(e.alive, false); assert.equal(b.killed, killed + 1);
  assert.equal(b.errorCount, 0);
});

test('native citizen remains unblockable and rejects operator selection, damage and HP loss while enemy damage still works', () => {
  const c = create(), b = c.battle, [u] = allies(c), e = native(b, 'enemy_3001_upeopl');
  e.x = u.x; e.y = u.y;
  assert.equal(e.s.flags.unblockable, true); assert.ok(e.findBuff('mark_neutral[effect]'));
  b._buildEnemyIndex(); assert.equal(acquireTargets(b, u, u.profile).includes(e), false);
  b._checkBlock(e); assert.equal(e.blockedBy, null);
  const hp = e.hp;
  assert.equal(b.dealDamage(u, e, { amount: 100000, type: 'true', ignoreSelect: true }), 0);
  assert.equal(b.loseHp(e, 100000, { source: u }), 0); assert.equal(e.hp, hp);
  const officer = native(b, 'enemy_1107_uoffcr_2');
  b.dealDamage(officer, e, { amount: 400, type: 'phys', canDodge: false });
  assert.equal(hp - e.hp, 350); assert.equal(b.errorCount, 0);
});

test('native citizen death costs exactly one LP while a safe arrival preserves perfect combat and leak totals', () => {
  const c = create(), b = c.battle, losses = [];
  b.on('lpLoss', (v) => losses.push(v.amount));
  const safe = native(b, 'enemy_3001_upeopl'); safe.inTotal = true;
  const resolved = b.resolved, leaks = b.leakedCount, pp = b._pp('p1');
  const entries = pp.leaked.length, perfect = pp.perfect;
  b.leak(safe);
  assert.deepEqual(losses, []); assert.equal(b.leakedCount, leaks);
  assert.equal(pp.leaked.length, entries); assert.equal(pp.perfect, perfect);
  assert.equal(b.leakedInTotal, 1); assert.ok(b.resolved >= resolved);
  const dead = native(b, 'enemy_3001_upeopl');
  b.kill(dead); b.kill(dead); assert.deepEqual(losses, [1]);
  b.forceEnd('forced'); assert.equal(b.result().lpLoss, 1); assert.equal(b.errorCount, 0);
});

test('native officer selects a civilian for the original delayed tracking projectile, surviving its source death', () => {
  const c = create(), b = c.battle, [u] = allies(c), e = native(b, 'enemy_1107_uoffcr_2');
  const citizen = native(b, 'enemy_3001_upeopl');
  e.x = u.x; e.y = u.y; citizen.x = e.x + 1.2; citizen.y = e.y;
  const hp = citizen.hp, allyHp = u.hp;
  b.emit('tick', { dt: .03 }); assert.ok(e.mem.mizukiTruthOfficer.cast);
  scheduled(b, .499); assert.equal(b.projectiles.list.length, 0);
  scheduled(b, .5); assert.equal(b.projectiles.list.length, 1);
  const p = b.projectiles.list[0]; assert.equal(p.target, citizen); assert.equal(p.speed, 10); assert.equal(p.maxAge, 5);
  assert.equal(citizen.hp, hp); b.kill(e); b.projectiles.update(.121);
  assert.equal(hp - citizen.hp, 350); assert.equal(u.hp, allyHp); assert.equal(b.errorCount, 0);
});

test('native officer does not use its civilian ranged attack against operators, and fights its blocker in melee', () => {
  const c = create(), b = c.battle, [u] = allies(c), e = native(b, 'enemy_1107_uoffcr_2');
  e.x = u.x - 1; e.y = u.y;
  b.emit('tick', { dt: 1 }); assert.equal(e.mem.mizukiTruthOfficer.cast, undefined);
  const hp = u.hp;
  e.blockedBy = u; u.blocking.push(e);
  updateEnemy(b, e, .03); updateEnemy(b, e, .5);
  assert.ok(u.hp < hp); assert.equal(b.projectiles.list.length, 0); assert.equal(b.errorCount, 0);
});

test('native officer stun cancels its ranged attack before the source hit frame', () => {
  const b = create().battle, e = native(b, 'enemy_1107_uoffcr_2'), citizen = native(b, 'enemy_3001_upeopl');
  citizen.x = e.x + 1; citizen.y = e.y;
  b.emit('tick', { dt: .03 }); b.applyStatus(e, 'stun', { duration: 2 }); b.emit('tick', { dt: 0 });
  scheduled(b, .5); assert.equal(b.projectiles.list.length, 0);
  assert.equal(e.profile.noAttack, false); assert.equal(b.errorCount, 0);
});

test('native officer attack hooks cannot fire a shot after killing its source, and palsy consumes the ranged attack', () => {
  for (const mode of ['death', 'palsy']) {
    const b = create().battle, e = native(b, 'enemy_1107_uoffcr_2'), citizen = native(b, 'enemy_3001_upeopl');
    citizen.x = e.x + 1; citizen.y = e.y;
    if (mode === 'death') b.on('beforeAttack', (c) => { if (c.attacker === e) b.kill(e); });
    else b.applyStatus(e, 'palsy', { value: 1 });
    b.emit('tick', { dt: .03 }); scheduled(b, .5);
    assert.equal(b.projectiles.list.length, 0);
    if (mode === 'palsy') { assert.equal(e.findBuff('palsy'), null); assert.equal(e.atkCd, 2); }
    assert.equal(b.errorCount, 0);
  }
});

test('native officer spends its ranged cooldown after the locked civilian dies during windup', () => {
  const b = create().battle, e = native(b, 'enemy_1107_uoffcr_2'), citizen = native(b, 'enemy_3001_upeopl');
  citizen.x = e.x + 1; citizen.y = e.y;
  b.emit('tick', { dt: .03 }); b.kill(citizen); scheduled(b, .5);
  assert.equal(e.atkCd, 2); assert.equal(e.stats.attacks, 1); assert.equal(b.projectiles.list.length, 0);
  assert.equal(b.errorCount, 0);
});

test('native Truth snapshots retain live citizen and weaken loops with stable IDs and remove expired effects', () => {
  const c = create(), b = c.battle, [u] = allies(c), e = native(b, 'enemy_1104_lfkght_2'), citizen = native(b, 'enemy_3001_upeopl');
  b.emit('tick', { dt: 15 }); scheduled(b, .4);
  const effects = snapshotMizukiTruthEffects(b);
  const citizenFx = effects.find((v) => v.key === 'enemy_upeopl_buff');
  assert.equal(citizenFx.id, 'upeople:neutral:' + citizen.id); assert.equal(citizenFx.loop, true);
  const target = b.allyUnits.find((v) => v.findBuff('lfkght_s[weaken]'));
  assert.ok(target); const weak = effects.find((v) => v.key === 'wind_buff_01');
  assert.equal(weak.id, 'lfkght:weaken:' + target.id); assert.equal(weak.duration, 25);
  assert.equal(effects.some((v) => /skill_01|skill_02|attack_01/.test(v.key)), false);
  b._tickBuffs(2); const aged = snapshotMizukiTruthEffects(b).find((v) => v.id === weak.id);
  assert.equal(aged.duration, 23);
  b.leak(citizen); b.removeBuff(target, 'lfkght_s[weaken]');
  assert.deepEqual(snapshotMizukiTruthEffects(b), []);
  assert.equal(u.alive, true); assert.equal(e.alive, true); assert.equal(b.errorCount, 0);
});

const production = () => {
  const options = createOfficialMizukiStage('ro2_ev_1', { data: createMizukiCatalog(getData()).source });
  return new MizukiAutoCombat({ ...options, seed: 17, teamHp: 10, content: 'full',
    players: [{ playerId: 'p1', units: [] }] });
};

test('real Truth AutoCombat installs all three original kits, stage skill overrides, and normal knight resurrection', () => {
  const c = production(), b = c.battle; c.step();
  const knight = b.enemies.find((e) => e.defId === 'enemy_1104_lfkght_2');
  const citizen = b.enemies.find((e) => e.defId === 'enemy_3001_upeopl');
  assert.ok(knight.mem._mizukiOfficialKit); assert.ok(citizen.mem.mizukiNeutralCitizen);
  assert.equal(citizen.counted, false); assert.equal(citizen.inTotal, false);
  assert.equal(knight.s.maxHp, 24000); assert.equal(knight.s.atk, 700);
  const skill = knight.mem.ab.list.find((a) => a.sk === knight.mem.ab.sk.AtkDesWeaken);
  assert.equal(skill.cd, 40); assert.equal(skill.sk.icd, 5); assert.equal(skill.sk.bb.duration, 40);
  b.kill(knight); assert.equal(knight.alive, true); assert.equal(knight.hp, 1);
  for (let i = 0; i < 149; i++) c.step(); assert.equal(knight.hp, 1);
  c.step(); assert.equal(knight.hp, 4800); assert.equal(knight.profile.noAttack, false);
  for (let guard = 0; guard < 450 && !b.enemies.some((e) => e.defId === 'enemy_1107_uoffcr_2'); guard++) c.step();
  const officer = b.enemies.find((e) => e.defId === 'enemy_1107_uoffcr_2');
  assert.ok(officer.mem._mizukiOfficialKit); assert.ok(officer.mem.mizukiTruthOfficer);
  assert.ok(c.snapshot().officialEnemyEffects.some((v) => v.id === 'upeople:neutral:' + citizen.id));
  b.kill(citizen);
  assert.equal(c.nativeLifeLoss, 1); assert.equal(c.leakDamage, 1); assert.equal(c.teamHp, 9);
  c.forceEnd(); const result = c.result();
  assert.equal(result.nativeLifeLoss, 1); assert.equal(result.lpLoss, 1); assert.equal(result.leakDamage, 1);
  assert.equal(result.perPlayer.p1.perfect, false);
  assert.deepEqual(result.perPlayer.p1.leaked, []); assert.equal(b.errorCount, 0);
});

test('real Truth scheduled wave clears after a civilian safe exit without objective, replay, or light penalties', (t) => {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [];
  const match = new MizukiMatch({ scheduler, data: getData(), roomCode: 'TRTH', seed: 512,
    dungeon: { zones: [{ id: 'zone_1', nodes: [
      { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_ev_1', next: [] },
    ] }] },
    seats: [{ playerId: 'p1', seat: 0 }],
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) }, send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); }); match.start();
  const command = (message) => assert.equal(match.handle('p1', message).ok, true);
  command({ t: 'g.mizuki.squad', squadId: 'rogue_2_band_3' });
  command({ t: 'g.mizuki.strategy', bandId: match.strategyOptions[0].bandId });
  command({ t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
  command({ t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' }); skipMizukiRecruit(match);
  assert.equal(match.phase, PHASE.ROUTE);
  const route = match.route.find((v) => v.stageId === 'ro2_ev_1'); assert.ok(route);
  command({ t: 'g.mizuki.route', nodeId: route.id }); command({ t: 'g.mizuki.routeStart' });
  command({ t: 'g.mizuki.ready', on: true }); assert.equal(match.phase, PHASE.COMBAT);
  const engine = [...match.fields.values()][0].engine, b = engine.battle;
  assert.ok(engine instanceof MizukiAutoCombat);
  const before = { life: match.players.get('p1').life, shield: match.players.get('p1').shield, light: match.light };
  const seen = new Set(); let citizen;
  for (let guard = 0; guard < 6000 && !engine.finished; guard++) {
    engine.step();
    for (const e of b.enemies) {
      seen.add(e.defId);
      if (e.defId === 'enemy_3001_upeopl') { citizen = e; continue; }
      if (e.alive && !e._officialFacility) b.kill(e);
    }
  }
  assert.ok(citizen); assert.equal(citizen.removeReason, 'leak');
  for (const id of Object.keys(MIZUKI_TRUTH_KITS)) assert.equal(seen.has(id), true, id);
  assert.equal(engine.finished, true); assert.equal(engine.result().reason, 'cleared');
  assert.equal(engine.officialWaves.done, true); assert.equal(b.resolved, b.total);
  assert.equal(engine.nativeLifeLoss, 0); assert.equal(engine.leakDamage, 0); assert.equal(b.leakedCount, 0);
  assert.equal(engine.result().perPlayer.p1.perfect, true); assert.deepEqual(engine.result().perPlayer.p1.leaked, []);
  scheduler.advance(1000 / 30 * 2);
  assert.equal(match.phase, PHASE.REWARD); assert.deepEqual({ life: match.players.get('p1').life, shield: match.players.get('p1').shield, light: match.light }, before);
  assert.equal(b.errorCount, 0); assert.deepEqual(errors, []);
});
