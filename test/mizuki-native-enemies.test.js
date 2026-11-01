import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { createOfficialMizukiStage, resolveOfficialEnemy } from '../server/modes/mizuki/official-stages.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { normalizeEnemy } from '../server/sim/simdata.js';
import { MIZUKI_ORDINARY_KITS } from '../server/modes/mizuki/ordinary-enemies.js';
import { KITS } from '../server/sim/content/enemies.js';
import { summonNativeEnemies } from '../server/modes/mizuki/NativeEnemySpawn.js';
import { installOfficialCreep } from '../server/modes/mizuki/OfficialCreep.js';
import { ALLY_COLLIDER_RADIUS } from '../server/sim/constants.js';
import { attackStand, attackWindup } from '../server/sim/ai.js';
import { canTargetAlly, enemyStealthed, areaSelectable } from '../server/sim/targeting.js';

const original = JSON.parse(readFileSync(new URL('../data/mizuki/enemy-database.json', import.meta.url), 'utf8')).enemies;
const bb = (items = []) => ({ bb: Object.fromEntries(items.filter((v) => typeof v.value === 'number').map((v) => [v.key, v.value])),
  bbStr: Object.fromEntries(items.filter((v) => v.valueStr != null).map((v) => [v.key, v.valueStr])) });
const stageIndex = JSON.parse(readFileSync(new URL('../data/mizuki/levels/index.json', import.meta.url), 'utf8'));
const levelRef = (stageId, id) => JSON.parse(readFileSync(new URL('../data/mizuki/levels/'
  + stageIndex.stagesById[stageId].file, import.meta.url), 'utf8')).enemyDbRefs.find((r) => r.id === id);
const create = (refs = {}, extra = {}) => {
  const catalog = createMizukiCatalog(getData());
  const options = createOfficialMizukiStage('ro2_n_1_1', { data: catalog.source });
  const data = Object.create(options.data);
  data.getEnemy = (id) => {
    if (!original[id] && !refs[id]) return options.data.getEnemy(id);
    const s = resolveOfficialEnemy(refs[id] ?? { id, level: 0, useDb: true });
    return normalizeEnemy(id, { key: id, name: s.name, spine: s.prefabKey, applyWay: s.applyWay,
      stats: { ...s.attributes, res: s.attributes.magicResistance, rangeRadius: s.rangeRadius,
        motion: s.motion, lpr: s.lifePointReduce }, talents: bb(s.talentBlackboard ?? []),
      skills: (s.skills ?? []).map((x) => ({ ...x, ...bb(x.blackboard ?? []) })) });
  };
  return new MizukiCombat({ ...options, data, seed: 7, content: 'full',
    players: [{ playerId: 'p1', units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] }],
    flags: { dpInit: 999, dpMax: 999 }, ...extra });
};
const deployed = (c, uid = 101) => {
  const t = c.snapshot().geometry.tiles.find((v) => c.battle.grid.canStand(v.row, v.col, { ranged: false })
    && !v.obstacle && !c.battle.allyUnits.some((u) => u.alive && u.deployed && u.tileR === v.row && u.tileC === v.col));
  assert.equal(c.command('p1', { type: 'deploy', uid, row: t.row, col: t.col, dir: 'RIGHT' }).ok, true);
  return c.battle.getPlayer('p1').units.find((u) => u.uid === uid);
};
const hit = (b, e, u, amount = 1) => b.dealDamage(e, u, { amount, type: 'phys', isAttack: true, canDodge: false });

test('native elite supply buffs marked bloodsuckers globally with five additive ATK stacks and DARK damage', () => {
  const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy('enemy_1220_dzoms');
  const other = b.spawnEnemy('enemy_1222_dpvt'); e.x = u.x + 8; e.y = u.y;
  const carts = Array.from({ length: 6 }, () => b.spawnEnemy('enemy_1224_dsuply_2'));
  assert.equal(e.s.atk, e.base.atk * 1.5); assert.equal(other.s.atk, other.base.atk);
  assert.equal(e.findBuff('enemy_dsuply_2_t[attr_buff]').data.stack, 5);
  b.addBuff(u, { key: 'test:supply:hp', mods: { hpFlat: 100000 } }); u.hp = u.s.maxHp;
  hit(b, e, u, 1); assert.ok(Math.abs(u.elem.apoptosis - e.s.atk * .5) < 1e-8);
  b.applyStatus(carts[0], 'silence', { duration: 10 }); assert.equal(e.s.atk, e.base.atk * 1.5);
  b.applyStatus(carts[1], 'silence', { duration: 10 }); assert.equal(e.s.atk, e.base.atk * 1.4);
  b.kill(carts[2], null); assert.equal(e.s.atk, e.base.atk * 1.3);
  for (const cart of carts.slice(3)) b._remove(cart, 'leak');
  assert.equal(e.s.atk, e.base.atk); assert.equal(e.findBuff('enemy_dsuply_2_t[attr_buff]'), null);
  assert.equal(c.snapshot().officialEnemyEffects.length, 0); assert.equal(b.errorCount, 0);
});

test('native elite supply fires physical projectile at original fixed range2 speed10 and five-second lifetime', () => {
  const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy('enemy_1224_dsuply_2');
  assert.equal(e.base.rangeRadius, 2); assert.equal(e.profile.deferHit, true);
  assert.equal(attackWindup(e), .433); assert.equal(attackStand(e).rest, 1.2 - .433);
  e.x = u.x - 2; e.y = u.y;
  b.addBuff(u, { key: 'test:supply:hp', mods: { hpFlat: 100000 } }); u.hp = u.s.maxHp;
  const hp = u.hp;
  b.emit('attack', { attacker: e, targets: [u], targetDeployments: new Map([[u, u.deploySeq]]), isSkill: false });
  assert.equal(b.projectiles.list.length, 1); assert.equal(b.projectiles.list[0].speed, 10);
  assert.equal(b.projectiles.list[0].maxAge, 5); assert.equal(u.hp, hp);
  b.projectiles.update(.19); assert.equal(u.hp, hp);
  b.kill(e, null); b.projectiles.update(.011); assert.ok(u.hp < hp);
  assert.equal(b.errorCount, 0);
});

test('native bloodsuckers reduce only physical and arts damage after mitigation and wait original birth', () => {
  for (const id of ['enemy_1220_dzoms', 'enemy_1221_dzomg', 'enemy_1221_dzomg_2']) {
    const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy(id);
    assert.equal(e.mem._mizukiOfficialKit, true); assert.equal(e.profile.noAttack, true);
    assert.equal(e.findBuff('mizuki:bloodsucker:born').duration, 1);
    b.applyStatus(e, 'silence', { duration: 10 });
    for (const type of ['phys', 'arts', 'true']) {
      const amount = type === 'phys' ? (1000 - e.s.def) * .1
        : type === 'arts' ? 1000 * (1 - e.s.res / 100) * .1 : 1000;
      const hp = e.hp; b.dealDamage(u, e, { amount: 1000, type, canDodge: false });
      assert.ok(Math.abs(hp - e.hp - amount) < 1e-7, id + ':' + type);
    }
    b.time = 1; b._runScheduled(); assert.equal(!!e.profile.noAttack, false);
    assert.equal(b.errorCount, 0);
  }
});

test('native bloodsuckers grant blocker one capacity each capped at six and remove immediately', () => {
  const c = create(), b = c.battle, u = deployed(c), base = u.s.blockCnt;
  const enemies = Array.from({ length: 7 }, (_, i) => b.spawnEnemy(i % 2 ? 'enemy_1220_dzoms' : 'enemy_1221_dzomg'));
  for (const e of enemies) { e.blockedBy = u; u.blocking.push(e); }
  assert.equal(u.s.blockCnt, base + 6);
  b.applyStatus(enemies[0], 'silence', { duration: 10 }); assert.equal(u.s.blockCnt, base + 6);
  b._unblock(enemies[0]); assert.equal(u.s.blockCnt, base + 6);
  b._unblock(enemies[1]); assert.equal(u.s.blockCnt, base + 5);
  b.kill(enemies[2], null); assert.equal(u.s.blockCnt, base + 4);
  b.releaseBlocked(u); assert.equal(u.s.blockCnt, base);
  assert.equal(u.findBuff('enemy_bloodsucker_block_cnt'), null); assert.equal(b.errorCount, 0);
});

test('native vampire infantry summons original bloodsucker after one second only on real killed', () => {
  const c = create(), b = c.battle, e = b.spawnEnemy('enemy_1222_dpvt');
  b.applyStatus(e, 'silence', { duration: 10 });
  b.kill(e, null);
  assert.equal(b._officialSummonHolds.size, 1);
  b.time = .99; b._runScheduled(); assert.equal(b.enemies.filter((u) => u.defId === 'enemy_1220_dzoms').length, 0);
  b.time = 1; b._runScheduled();
  const children = b.enemies.filter((u) => u.defId === 'enemy_1220_dzoms');
  assert.equal(children.length, 1); assert.equal(b._officialSummonHolds.size, 0);
  assert.ok(Math.abs(children[0].x - e.x) <= .1 && Math.abs(children[0].y - e.y) <= .1);
  for (const reason of ['leak', 'retreat', 'expired', 'falldown']) b._remove(b.spawnEnemy('enemy_1222_dpvt'), reason);
  assert.equal(b._officialSummonHolds.size, 0); assert.equal(b.errorCount, 0);
});

test('native observer range particle starts once, follows snapshot and stops on departure', () => {
  const c = create(), b = c.battle, e = b.spawnEnemy('enemy_1020_obsv');
  e.x += .5; e.y += .25;
  const effect = c.snapshot().officialEnemyEffects.find((v) => v.unitId === e.id);
  assert.equal(effect.key, 'obsv_buff_01_range'); assert.equal(effect.loop, true);
  assert.equal(effect.x, e.x); assert.equal(effect.y, e.y);
  b._remove(e, 'leak'); assert.deepEqual(c.snapshot().officialEnemyEffects, []);
  assert.equal(b.errorCount, 0);
});

test('native badbox waits original birth time, uses physical melee and resists exactly stun freeze silence', () => {
  const c = create(), b = c.battle, e = b.spawnEnemy('enemy_2035_sybox');
  assert.equal(e.mem._mizukiOfficialKit, true); assert.equal(e.mem.ab.atkType, 'phys');
  assert.equal(e.profile.melee, true); assert.equal(e.profile.noAttack, true);
  assert.equal(e.findBuff('mizuki:sybox:born').duration, 1.27);
  for (const status of ['stun', 'freeze', 'silence']) {
    b.applyStatus(e, status, { duration: 5 });
    assert.equal(!!e.s.flags[status], false, status);
  }
  assert.equal(e.mem.ab.immune.has('sleep'), false);
  b.time = 1.26; b._runScheduled(); assert.equal(e.profile.noAttack, true);
  b.time = 1.27; b._runScheduled();
  assert.equal(!!e.profile.noAttack, false); assert.equal(!!e.s.flags.noMove, false);
  assert.equal(b.errorCount, 0);
});

test('native badbox logs original reward key once only on a real kill', () => {
  const c = create(), b = c.battle, seen = [];
  b.on('mizuki:extraBattleInfo', (v) => seen.push(v));
  const e = b.spawnEnemy('enemy_2035_sybox');
  b.kill(e, null); b.kill(e, null);
  assert.equal(seen.length, 1); assert.equal(seen[0].key, 'trap_068_badbox');
  assert.equal(seen[0].additionValue, 1); assert.equal(seen[0].source, e);
  for (const reason of ['leak', 'retreat', 'expired']) {
    const other = b.spawnEnemy('enemy_2035_sybox');
    b._remove(other, reason);
  }
  assert.equal(seen.length, 1); assert.equal(b.errorCount, 0);
});

test('native ice slug uses original one-second projectile, radius1.65, physical200percent and cold10', () => {
  const c = create(), b = c.battle, u = deployed(c), seen = [];
  b.addBuff(u, { key: 'test:ice:hp', mods: { hpFlat: 100000 } }); u.hp = u.s.maxHp;
  b.on('hit', (v) => { if (v.dmg.tags?.includes('mizuki:snslime:boom')) seen.push(v.dmg); });
  for (let i = 0; i < 2; i++) {
    const e = b.spawnEnemy('enemy_1067_snslime_2');
    e.x = u.x - (1.65 + ALLY_COLLIDER_RADIUS - .01); e.y = u.y;
    b.kill(e, null); assert.equal(seen.length, i);
    b.time = i + .99; b._runScheduled(); assert.equal(seen.length, i);
    b.time = i + 1; b._runScheduled(); assert.equal(seen.length, i + 1);
    assert.equal(seen[i].amount, e.s.atk * 2); assert.equal(seen[i].type, 'phys');
  }
  assert.equal(u.s.flags.freeze, true); assert.equal(u.findBuff('freeze').duration, 10);
  assert.equal(b.errorCount, 0);
});

test('native ice slug explosion respects silence, real death, range and original ground selection', () => {
  for (const reason of ['silence', 'leak', 'retreat', 'range', 'air', 'stealth']) {
    const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy('enemy_1067_snslime_2');
    e.x = u.x; e.y = u.y;
    if (reason === 'silence') b.applyStatus(e, 'silence', { duration: 10 });
    if (reason === 'range') e.x = u.x + 1.65 + ALLY_COLLIDER_RADIUS + .01;
    if (reason === 'air') u.motion = 'FLY';
    if (reason === 'stealth') b.applyStatus(u, 'stealth', { duration: 10 });
    let hits = 0; b.on('hit', (v) => { if (v.dmg.tags?.includes('mizuki:snslime:boom')) hits++; });
    if (reason === 'leak' || reason === 'retreat') b._remove(e, reason);
    else b.kill(e, null);
    b.time = 1; b._runScheduled(); assert.equal(hits, 0, reason); assert.equal(b.errorCount, 0, reason);
  }
});

test('native sotiwz has only five-second arts pulses and original ore mode expands radius1.5 to2.5', () => {
  const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy('enemy_1085_sotiwz_2'), seen = [];
  b.addBuff(u, { key: 'test:sotiwz:hp', mods: { hpFlat: 100000 } }); u.hp = u.s.maxHp;
  e.x = u.x - (1.5 + ALLY_COLLIDER_RADIUS - .01); e.y = u.y;
  assert.equal(e.profile.noAttack, true); assert.ok(e.findBuff('ore_immune')); assert.ok(e.findBuff('ore_listener'));
  b.applyStatus(e, 'silence', { duration: 30 }); assert.equal(!!e.s.flags.silence, false);
  b.on('hit', (v) => { if (v.dmg.tags?.includes('mizuki:sotiwz:pulse')) seen.push(v.dmg); });
  b.emit('tick', { dt: .05 }); assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'arts'); assert.equal(seen[0].amount, e.s.atk);
  b.emit('tick', { dt: 4.9 }); assert.equal(seen.length, 1);
  e.x = u.x - 2.3; b.emit('tick', { dt: .1 }); assert.equal(seen.length, 1);
  b.emit('mizuki:orePulse', { unit: u, mode: 1 }); assert.notEqual(e.form, 'rage');
  b.emit('mizuki:orePulse', { unit: e, mode: 1 }); assert.equal(e.form, 'rage');
  b.emit('tick', { dt: .05 }); assert.equal(seen.length, 2);
  e.x = u.x - (2.5 + ALLY_COLLIDER_RADIUS + .01);
  b.emit('tick', { dt: 5 }); assert.equal(seen.length, 2); assert.equal(b.errorCount, 0);
});

test('native sotiwz pulses stop during sleep and never hit flying allies', () => {
  const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy('enemy_1085_sotiwz_2');
  e.x = u.x; e.y = u.y; let hits = 0;
  b.on('hit', (v) => { if (v.dmg.tags?.includes('mizuki:sotiwz:pulse')) hits++; });
  b.applyStatus(e, 'sleep', { duration: 10 }); b.emit('tick', { dt: 5 }); assert.equal(hits, 0);
  b.removeBuff(e, 'sleep'); u.motion = 'FLY';
  b.emit('tick', { dt: .05 }); assert.equal(hits, 0); assert.equal(b.errorCount, 0);
});

test('native scout survives its triggering lethal hit, waits original0.1 then buffs only enemies currently present', () => {
  for (const [id, scale] of [['enemy_1073_dscout', .3], ['enemy_1073_dscout_2', .5]]) {
    const c = create(), b = c.battle, u = deployed(c), soldier = b.spawnEnemy('enemy_1007_slime');
    const atk = soldier.s.atk, def = soldier.s.def, e = b.spawnEnemy(id);
    for (const status of ['stun', 'freeze', 'sleep', 'silence']) {
      b.applyStatus(e, status, { duration: 5 }); assert.equal(!!e.s.flags[status], false, status);
    }
    b.dealDamage(u, e, { amount: e.s.maxHp * 5, type: 'true' });
    assert.equal(e.alive, true); assert.equal(e.hp, 1); assert.ok(e.findBuff('dscout_t'));
    b.emit('tick', { dt: .05 }); assert.equal(soldier.s.atk, atk);
    b.emit('tick', { dt: .05 }); assert.equal(soldier.s.atk, atk);
    b.emit('tick', { dt: .05 }); assert.equal(soldier.s.atk, atk * (1 + scale));
    assert.equal(soldier.s.def, def * (1 + scale)); assert.equal(!!e.findBuff('dscout_t'), false);
    b.emit('tick', { dt: 10 }); assert.equal(soldier.s.atk, atk * (1 + scale));
    const late = b.spawnEnemy('enemy_1007_slime'); assert.equal(late.s.atk, atk);
    b.kill(e, u); assert.equal(soldier.s.atk, atk * (1 + scale)); assert.equal(b.errorCount, 0);
  }
});

test('native scouts use strict original0.999 HP threshold and different source alarms add together', () => {
  const c = create(), b = c.battle, u = deployed(c), soldier = b.spawnEnemy('enemy_1007_slime');
  const atk = soldier.s.atk, e = b.spawnEnemy('enemy_1073_dscout');
  b.dealDamage(u, e, { amount: e.s.maxHp * .001, type: 'true' });
  b.emit('tick', { dt: 1 }); assert.ok(e.findBuff('dscout_t')); assert.equal(soldier.s.atk, atk);
  b.dealDamage(u, e, { amount: 1, type: 'true' });
  b.emit('tick', { dt: .05 }); b.emit('tick', { dt: .1 }); assert.equal(soldier.s.atk, atk * 1.3);
  const elite = b.spawnEnemy('enemy_1073_dscout_2');
  b.dealDamage(u, elite, { amount: 100, type: 'true' });
  b.emit('tick', { dt: .05 }); b.emit('tick', { dt: .1 });
  assert.equal(soldier.s.atk, atk * 1.8); assert.equal(b.errorCount, 0);
});

test('native grudgebearer keeps attacks dormant after movement timer ends and awakens below original HP threshold', () => {
  const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy('enemy_1074_dbskar');
  assert.equal(e.findBuff('dbskar_t[sleep]').duration, 150); assert.ok(e.findBuff('enemy_slumber'));
  assert.equal(e.profile.noAttack, true); assert.equal(e.s.flags.noMove, true);
  b.removeBuff(e, 'dbskar_t[sleep]'); b.emit('tick', { dt: .05 });
  assert.equal(!!e.s.flags.noMove, false); assert.equal(e.profile.noAttack, true);
  b.dealDamage(u, e, { amount: e.s.maxHp * .001, type: 'true' });
  b.emit('tick', { dt: .05 }); assert.ok(e.findBuff('enemy_slumber'));
  b.dealDamage(u, e, { amount: 1, type: 'true' }); b.emit('tick', { dt: .05 });
  assert.equal(!!e.findBuff('enemy_slumber'), false); assert.equal(!!e.profile.noAttack, false);
  assert.equal(e.mem.ab.atkType, 'arts'); assert.equal(e.profile.maxTargets, 2);
  assert.equal(e.profile.canTarget({ isFlying: true }), false); assert.equal(e.base.rangeRadius, 2);
  assert.deepEqual(e.def.attackAnim, { dur: 1.6, hit: .833 });
  assert.equal(attackWindup(e), .833);
  assert.deepEqual(attackStand(e), { wind: .833, rest: 1.6 - .833 });
  assert.equal(e.s.moveSpeed, e.base.moveSpeed * 3); assert.equal(e.form, 'awakened'); assert.equal(b.errorCount, 0);
});

test('native private grudgebearer aliases preserve original70/110/160 waits and scouts wake only current units', () => {
  for (const [id, duration] of [['enemy_1074_dbskar_0', 70], ['enemy_1074_dbskar_1', 110],
    ['enemy_1074_dbskar_15', 160], ['enemy_1074_dbskar_2_0', 70],
    ['enemy_1074_dbskar_2_1', 110], ['enemy_1074_dbskar_2_2', 160]]) {
    const c = create({ [id]: levelRef('ro2_ev_3', id) }), b = c.battle, u = deployed(c);
    const e = b.spawnEnemy(id), scout = b.spawnEnemy('enemy_1073_dscout');
    assert.equal(e.mem._mizukiOfficialKit, true, id);
    assert.equal(e.findBuff('dbskar_t[sleep]').duration, duration, id);
    const hp = e.hp; b.dealDamage(u, scout, { amount: 100, type: 'true' });
    b.emit('tick', { dt: .05 }); b.emit('tick', { dt: .1 });
    assert.equal(e.hp, hp, id); assert.equal(!!e.profile.noAttack, false, id);
    assert.equal(!!e.s.flags.noMove, false, id); assert.equal(!!e.findBuff('enemy_slumber'), false, id);
    assert.equal(e.s.moveSpeed, e.base.moveSpeed * 3, id);
    const late = b.spawnEnemy(id); assert.equal(late.profile.noAttack, true, id);
    assert.ok(late.findBuff('enemy_slumber'), id); assert.equal(b.errorCount, 0, id);
  }
});

test('native observer keeps original self stealth through silence and reveals only within fixed circle', () => {
  const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy('enemy_1020_obsv');
  assert.equal(e.mem._mizukiOfficialKit, true); assert.equal(e.mem.ab.atkType, 'phys');
  assert.equal(e.findBuff('talent_invisible').data.stealthRestore, 3);
  b.applyStatus(e, 'silence', { duration: 10 }); assert.equal(enemyStealthed(e), true);
  b.applyStatus(u, 'stealth', { duration: 100 });
  e.x = u.x + 2 + ALLY_COLLIDER_RADIUS + .01; e.y = u.y;
  b.emit('tick', { dt: .05 }); assert.equal(u.s.flags.stealth, true);
  e.x = u.x + 2 + ALLY_COLLIDER_RADIUS - .01; b.emit('tick', { dt: .05 });
  assert.equal(u.s.flags.stealth, false); assert.equal(canTargetAlly(e, u, true), true);
  assert.equal(areaSelectable(e, u), true); assert.equal(u.findBuff('stealth').flags.stealth, true);
  e.x = u.x + 3; b.emit('tick', { dt: .05 });
  assert.equal(u.s.flags.stealth, true); assert.equal(canTargetAlly(e, u, true), false);
  assert.equal(b.errorCount, 0);
});

test('native observer immunity suppresses new stealth without removing camouflage or target-free', () => {
  const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy('enemy_1020_obsv');
  e.x = u.x; e.y = u.y; b.emit('tick', { dt: .05 });
  b.applyStatus(u, 'stealth', { duration: 10 }); assert.equal(u.s.flags.stealth, false);
  b.applyStatus(u, 'camou', { duration: 10 });
  assert.equal(u.s.flags.camou, true); assert.equal(canTargetAlly(e, u, true), false);
  b.removeBuff(u, 'camou'); b.addBuff(u, { key: 'test:untargetable', flags: { untargetable: true } });
  b.emit('tick', { dt: .05 }); assert.equal(u.s.flags.stealth, false);
  assert.equal(u.s.flags.untargetable, true); assert.equal(canTargetAlly(e, u, true), false);
  assert.equal(b.errorCount, 0);
});

test('native observer overlapping sources clean up independently on every exit reason', () => {
  for (const reason of ['killed', 'leak', 'retreat', 'expired']) {
    const c = create(), b = c.battle, u = deployed(c);
    b.applyStatus(u, 'stealth', { duration: 100 });
    const one = b.spawnEnemy('enemy_1020_obsv'), two = b.spawnEnemy('enemy_1020_obsv');
    for (const e of [one, two]) { e.x = u.x; e.y = u.y; }
    b.emit('tick', { dt: .05 }); assert.equal(u.s.flags.stealth, false, reason);
    b._remove(one, reason); assert.equal(u.s.flags.stealth, false, reason);
    b._remove(two, reason); assert.equal(u.s.flags.stealth, true, reason);
    assert.ok(u.findBuff('stealth'), reason); assert.equal(b.errorCount, 0, reason);
  }
});

test('native hirman gains exact blocked RES50 and silence removes it immediately', () => {
  const c=create(), b=c.battle, u=deployed(c), e=b.spawnEnemy('enemy_1048_hirman_2'), base=e.s.res;
  assert.equal(e.mem.ab.atkType,'phys'); e.blockedBy=u; b.emit('blocked',{enemy:e,blocker:u});
  assert.equal(e.s.res,base+50); b.applyStatus(e,'silence',{duration:10});
  assert.equal(e.s.res,base); b.removeBuff(e,'silence'); b.emit('tick',{dt:.05});
  assert.equal(e.s.res,base+50); e.blockedBy=null; b.emit('tick',{dt:.05});
  assert.equal(e.s.res,base); assert.equal(b.errorCount,0);
});

test('native plkght keeps original DEF3000 RES95 armor for thirty seconds through silence', () => {
  const c=create(), b=c.battle, e=b.spawnEnemy('enemy_1101_plkght');
  const armor=e.findBuff('mizuki:plkght:armor');
  assert.equal(armor.duration,30); assert.equal(armor.mods.defFlat,3000); assert.equal(armor.mods.resFlat,95);
  const def=e.s.def,res=e.s.res; b.applyStatus(e,'silence',{duration:40});
  assert.equal(e.s.def,def); assert.equal(e.s.res,res); assert.equal(e.mem.ab.atkType,'phys');
  assert.equal(e.profile.canTarget({isFlying:true}),false);
  b.removeBuff(e,'mizuki:plkght:armor'); assert.equal(e.s.def,def-3000); assert.equal(e.s.res,res-95);
  assert.equal(b.errorCount,0);
});

const startLasso = () => {
  const c=create(), b=c.battle, u=deployed(c), e=b.spawnEnemy('enemy_1022_dmage');
  b.addBuff(u,{key:'test:lasso:hp',mods:{hpFlat:100000}});u.hp=u.s.maxHp;
  e.x=u.x+2;e.y=u.y; b.emit('tick',{dt:.05});
  const a=e.mem.ab.list.find((v)=>v.sk===e.mem.ab.sk.lasso);
  assert.equal(a.active,true);assert.equal(e.profile.noAttack,true);assert.equal(e.s.flags.noMove,true);
  return {c,b,u,e,a};
};

test('native lasso is once-only and inflicts original arts35percent every second throughout twenty seconds', () => {
  const {b,u,e,a}=startLasso(), seen=[];
  b.on('hit',(v)=>{if(v.source===e && v.dmg.tags?.includes('mizuki:dmage:lasso'))seen.push(v.dmg);});
  assert.equal(!!u.s.flags.stun,false); b.projectiles.update(.2);
  assert.equal(u.s.flags.stun,true);assert.equal(a.attached,true);assert.equal(seen.length,1);
  assert.equal(u.findBuff('mizuki:dmage:lasso:'+e.id).duration,Infinity);
  for(let i=0;i<19;i++) b.emit('tick',{dt:1});
  assert.equal(seen.length,20);assert.equal(a.active,true);
  for(const d of seen){assert.equal(d.type,'arts');assert.equal(d.amount,e.s.atk*.35);assert.equal(d.isAttack,false);}
  b.emit('tick',{dt:1});assert.equal(a.active,false);assert.equal(!!u.s.flags.stun,false);
  b.time=.667;b._runScheduled();assert.equal(!!e.profile.noAttack,false);
  b.emit('tick',{dt:1});assert.equal(a.casts,1);assert.equal(seen.length,20);assert.equal(b.errorCount,0);
});

test('native lasso clears its own stun on caster controls death or target withdrawal without erasing another stun', () => {
  for(const reason of ['silence','stun','freeze','death','withdraw','flight']){
    const {b,u,e,a}=startLasso();
    if(reason!=='flight')b.projectiles.update(.2);
    if(reason==='silence')b.applyStatus(e,'silence',{duration:5});
    else if(reason==='stun'||reason==='freeze')b.applyStatus(e,reason,{duration:5});
    else if(reason==='death')b.dealDamage(u,e,{amount:e.s.maxHp*2,type:'true'});
    else if(reason==='withdraw')b.retreat(u);
    else b.applyStatus(e,'silence',{duration:5});
    assert.equal(a.active,false,reason);assert.equal(!!u.findBuff('mizuki:dmage:lasso:'+e.id),false,reason);
    b.projectiles.update(1);assert.equal(!!u.findBuff('mizuki:dmage:lasso:'+e.id),false,reason);
    assert.equal(b.errorCount,0,reason);
  }
  const {b,u,e}=startLasso();b.projectiles.update(.2);b.applyStatus(u,'stun',{duration:5});
  b.applyStatus(e,'silence',{duration:5});assert.equal(u.s.flags.stun,true);assert.ok(u.findBuff('stun'));
});

test('native lasso original NOT_STUNNED_HATRED_DES picks an unstunned ally before the later deployed stunned one', () => {
  const c=create({}, {players:[{playerId:'p1',units:[{uid:101,chessId:'chess_char_1_02_a'},{uid:102,chessId:'chess_char_1_02_a'}]}]});
  const b=c.battle,u=deployed(c),v=deployed(c,102),e=b.spawnEnemy('enemy_1022_dmage');
  e.x=u.x+1;e.y=u.y;v.x=u.x+.5;v.y=u.y;
  b.applyStatus(v,'stun',{duration:30});b.emit('tick',{dt:.05});
  const a=e.mem.ab.list.find((x)=>x.sk===e.mem.ab.sk.lasso);
  assert.equal(a.target,u);assert.equal(b.errorCount,0);
});

test('native refraction is exact RES70 at spawn and is removed immediately by silence then restored', () => {
  for(const id of ['enemy_1167_dubow_2','enemy_1171_durokt','enemy_1171_durokt_2']){
    const c=create(),b=c.battle,e=b.spawnEnemy(id);
    assert.equal(e.findBuff('ab:refraction').mods.resFlat,70,id);
    const res=e.s.res;b.applyStatus(e,'silence',{duration:3});assert.equal(e.s.res,res-70,id);
    b.removeBuff(e,'silence');b.emit('tick',{dt:.05});assert.equal(e.s.res,res,id);assert.equal(b.errorCount,0);
  }
});

test('native hover follows WALK route and permanently lands on original controls with original half-second stun', () => {
  for(const status of ['stun','freeze','sleep','levitate','groundbind']){
    const c=create(),b=c.battle,e=b.spawnEnemy('enemy_1171_durokt');
    assert.equal(e.motion,'WALK');assert.equal(e.isFlying,true);assert.equal(e.profile.melee,false);
    b.applyStatus(e,status,{duration:1});assert.equal(!!e.s.flags.float,false,status);assert.equal(e.profile.melee,true,status);
    assert.equal(e.isFlying,status==='levitate',status);assert.ok(e.findBuff('stun'));
    if(status!=='stun')assert.equal(e.findBuff('stun').duration,.5,status);
    b.removeBuff(e,status);b.removeBuff(e,'stun');b.emit('tick',{dt:1});
    assert.equal(e.isFlying,false,status);assert.equal(!!e.s.flags.unblockable,false,status);assert.equal(e.form,'ground');
    assert.equal(b.errorCount,0,status);
  }
  const c=create(),b=c.battle,e=b.spawnEnemy('enemy_1171_durokt_2');
  b.applyStatus(e,'silence',{duration:3});assert.equal(e.isFlying,true);assert.equal(e.profile.melee,false);
});

test('ordinary native families preserve actual attack types, target counts, ghost and three-block flags', () => {
  const c = create(), b = c.battle;
  for (const id of Object.keys(MIZUKI_ORDINARY_KITS)) {
    const e = b.spawnEnemy(id);
    assert.ok(e, id); assert.equal(e.mem._mizukiOfficialKit, true, id);
    assert.equal(Object.hasOwn(KITS, id), false, id);
  }
  const find = (id) => b.enemies.find((e) => e.defId === id);
  assert.equal(find('enemy_1031_mrogue').mem.ab.atkType, 'arts');
  assert.equal(find('enemy_1038_lunmag_2').profile.maxTargets, 2);
  assert.equal(find('enemy_1008_ghost').s.flags.unblockable, true);
  assert.equal(find('enemy_1058_traink').blockWeight, 3);
  assert.equal(find('enemy_1058_traink_2').blockWeight, 3);
  assert.ok(find('enemy_1187_krghd').findBuff('resist'));
  assert.equal(b.errorCount, 0);
});

test('syzeni receives exact DEF300 and noMove20 after only its first attack even when silenced', () => {
  const c = create(), b = c.battle, e = b.spawnEnemy('enemy_2022_syzeni');
  const def = e.s.def;
  b.applyStatus(e, 'silence', { duration: 30 });
  b.emit('attack', { attacker: e, targets: [] });
  assert.equal(e.s.def, def + 300); assert.equal(e.s.flags.noMove, true);
  assert.equal(e.findBuff('mizuki:syzeni:stationary').duration, 20);
  b.removeBuff(e, 'mizuki:syzeni:stationary');
  b.emit('attack', { attacker: e, targets: [] });
  assert.equal(e.s.def, def); assert.equal(!!e.s.flags.noMove, false);
  assert.equal(b.errorCount, 0);
});

test('sypult original impact deals damage and summons actual stationary synut at its ground target', () => {
  const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy('enemy_2023_sypult');
  assert.equal(e.profile.canTarget(u), true);
  const oldTotal = b.total, hp = u.hp; hit(b, e, u, 400);
  assert.ok(u.hp < hp);
  const child = b.enemies.find((v) => v.defId === 'enemy_2024_synut');
  assert.ok(child); assert.equal(child.x, u.x); assert.equal(child.y, u.y);
  assert.equal(child.s.moveSpeed, 0); assert.equal(child.s.maxHp, 2400);
  assert.equal(b.total, oldTotal); assert.equal(child.tag, 'mizuki:sypult');
  assert.equal(e.profile.canTarget({ ...u, isFlying: true }), false);
  assert.equal(b.errorCount, 0);
});

test('synut has erosion60 percent and loses exact unmodified no-source damage100 each second', () => {
  const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy('enemy_2024_synut');
  hit(b, e, u); assert.equal(u.elem.erosion, e.s.atk * .6);
  b.addBuff(e, { key: 'test:vulnerable', mods: { dmgTakenMul: 3 } });
  b.applyStatus(e, 'silence', { duration: 10 });
  const hp = e.hp; b.emit('tick', { dt: .99 }); assert.equal(e.hp, hp);
  const seen=[]; b.on('damaged', (evt) => { if(evt.target===e) seen.push(evt); });
  b.emit('tick', { dt: .01 }); assert.equal(e.hp, hp - 100);
  assert.equal(seen.length, 1); assert.equal(seen[0].source, null);
  assert.equal(seen[0].dmg.noSp, true); assert.equal(seen[0].dmg.tags.includes('hpLoss'), false);
  for(let i=0;i<23;i++)b.emit('tick',{dt:1});
  assert.equal(e.alive, false); assert.equal(b.errorCount, 0);
});

test('corrosive variant reads its own -15 blackboard and snow variants use original frozen multipliers', () => {
  const c = create(), b = c.battle, u = deployed(c), e = b.spawnEnemy('enemy_1095_ccripr_2');
  const def = u.s.def; hit(b, e, u); assert.equal(u.s.def, def - 15);
  b.applyStatus(u, 'freeze', { duration: 20 });
  for(const id of ['enemy_1064_snsbr','enemy_1066_snbow_2']) {
    const snow=b.spawnEnemy(id), info=b.makeDamage({amount:100,type:'phys',isAttack:true});
    b.emit('hit',{source:snow,target:u,dmg:info});assert.equal(info.amount,150,id);
  }
  assert.equal(b.errorCount,0);
});

test('native cold mage uses original SP2 or SP1 cadence and ten-second cold even while silenced', () => {
  for(const [id,n] of [['enemy_1068_snmage',3],['enemy_1068_snmage_2',2]]) {
    const refs=id.endsWith('_2')?{[id]:levelRef('ro2_b_9',id)}:{};
    const c=create(refs), b=c.battle, u=deployed(c), e=b.spawnEnemy(id);
    assert.equal(e.mem.ab.sk.coldattack.sp,n-1);
    b.applyStatus(e,'silence',{duration:20});
    assert.equal(e.mem.ab.atkType,'arts');
    for(let i=1;i<n;i++)b.emit('attack',{attacker:e,targets:[u]});
    assert.equal(u.findBuff('cold'),null);
    b.emit('attack',{attacker:e,targets:[u]});
    assert.ok(u.findBuff('cold'));assert.equal(u.findBuff('cold').duration,10);
    assert.equal(b.errorCount,0);
  }
});

test('eagent applies exact block minus1 for five seconds and blocked sword gains DEF180 until unblocked or silenced', () => {
  const c=create(),b=c.battle,u=deployed(c),e=b.spawnEnemy('enemy_1049_eagent');
  const block=u.s.blockCnt;hit(b,e,u);assert.equal(u.s.blockCnt,Math.max(0,block-1));
  assert.equal(u.findBuff('mizuki:eagent:blockdown').duration,5);
  const sword=b.spawnEnemy('enemy_1093_ccsbr_2'),def=sword.s.def;
  sword.blockedBy=u;b.emit('blocked',{enemy:sword,blocker:u});assert.equal(sword.s.def,def+180);
  b.applyStatus(sword,'silence',{duration:10});b.emit('tick',{dt:1/30});assert.equal(sword.s.def,def);
  b.removeBuff(sword,'silence');sword.blockedBy=null;b.emit('tick',{dt:1/30});assert.equal(sword.s.def,def);
  assert.equal(b.errorCount,0);
});

test('original commander aura does not stack; native soldiers gain their own exact strength and remove it on loss', () => {
  const c=create(),b=c.battle,soldier=b.spawnEnemy('enemy_1083_sotiab'),scout=b.spawnEnemy('enemy_1078_sotisc');
  const atk=soldier.s.atk,def=soldier.s.def,speed=scout.s.moveSpeed;
  const first=b.spawnEnemy('enemy_1080_sotidp'),second=b.spawnEnemy('enemy_1080_sotidp');
  b.emit('tick',{dt:.25});
  assert.equal(soldier.s.atk,atk*1.6);assert.equal(soldier.s.def,def+100);
  assert.equal(scout.s.moveSpeed,speed*1.3);
  b.applyStatus(first,'silence',{duration:5});b.emit('tick',{dt:.25});
  assert.equal(soldier.s.atk,atk*1.6);
  b.kill(first);b.emit('tick',{dt:.25});assert.equal(soldier.s.def,def+100);
  b.kill(second);b.emit('tick',{dt:.25});
  assert.equal(soldier.s.atk,atk);assert.equal(soldier.s.def,def);assert.equal(scout.s.moveSpeed,speed);
  assert.equal(b.errorCount,0);
});

test('native blood knight watches real enemy deaths and caps original ATK10percent ASPD5 at ten stacks', () => {
  const c=create(),b=c.battle,e=b.spawnEnemy('enemy_1103_wdkght_2'),atk=e.s.atk,aspd=e.s.aspd;
  for(let i=0;i<12;i++)b.kill(b.spawnEnemy('enemy_1007_slime'));
  assert.equal(e.s.atk,atk*2);assert.equal(e.s.aspd,aspd+50);assert.equal(e.form,'rage');
  assert.equal(e.findBuff('mizuki:wdkght:enhance').mods.atkPct,1);
  assert.equal(b.errorCount,0);
});

test('native champion applies final DEF30percent to both duelists and rejects other sources until silenced', () => {
  const c=create(),b=c.battle,u=deployed(c),e=b.spawnEnemy('enemy_1098_cchmpn_2');
  b.addBuff(u,{key:'test:defense',mods:{defPct:.6}});
  const before=u.s.def,self=e.s.def; e.blockedBy=u;b.emit('blocked',{enemy:e,blocker:u});
  assert.ok(Math.abs(u.s.def-before*.3)<1e-8);assert.ok(Math.abs(e.s.def-self*.3)<1e-8);
  const hp=e.hp;assert.equal(b.dealDamage(null,e,{amount:500,type:'true'}),0);assert.equal(e.hp,hp);
  assert.ok(b.dealDamage(u,e,{amount:100,type:'true'})>0);
  b.applyStatus(e,'silence',{duration:10});b.emit('tick',{dt:1/30});
  assert.equal(u.s.def,before);assert.equal(e.s.def,self);
  assert.ok(b.dealDamage(null,e,{amount:100,type:'true'})>0);
  assert.equal(b.errorCount,0);
});

test('imperial elite uses native reversible HP50percent ATK buff and retains ranged attacks', () => {
  const c=create(),b=c.battle,e=b.spawnEnemy('enemy_1113_empace'),atk=e.s.atk;
  assert.equal(e.profile.melee,false);e.hp=e.s.maxHp*.5;b.emit('tick',{dt:1/30});
  assert.equal(e.s.atk,atk*2);e.hp=e.s.maxHp*.6;b.emit('tick',{dt:1/30});
  assert.equal(e.s.atk,atk);assert.equal(b.errorCount,0);
});

test('original special selectors choose lowest HP ratio or DEF before taunt and keep blocker priority', () => {
  const c=create({}, {players:[{playerId:'p1',units:[
    {uid:101,chessId:'chess_char_1_02_a'},{uid:102,chessId:'chess_char_1_02_a'}]}]});
  const b=c.battle,u=deployed(c),v=deployed(c,102);
  v.x=u.x+1;v.y=u.y;v.hp=v.s.maxHp*.2;
  b.addBuff(u,{key:'test:taunt',mods:{taunt:100}});
  const needle=b.spawnEnemy('enemy_1153_dsexcu_2');needle.x=u.x;needle.y=u.y;
  assert.equal(needle.profile.canTarget(u),false);assert.equal(needle.profile.canTarget(v),true);
  needle.blockedBy=u;assert.equal(needle.profile.canTarget(u),true);assert.equal(needle.profile.canTarget(v),false);
  b.addBuff(v,{key:'test:lowdef',mods:{defFlat:-50}});
  const hunter=b.spawnEnemy('enemy_1190_krgbow');hunter.x=u.x;hunter.y=u.y;
  assert.equal(hunter.profile.canTarget(u),false);assert.equal(hunter.profile.canTarget(v),true);
  b.addBuff(v,{key:'test:stealth',flags:{stealth:true}});
  assert.equal(hunter.profile.canTarget(u),true);assert.equal(hunter.profile.canTarget(v),false);
  assert.equal(b.errorCount,0);
});

test('native urchin retaliates only after HP15percent loss using original arts and neural values and radius2', () => {
  const c=create(),b=c.battle,u=deployed(c),e=b.spawnEnemy('enemy_1152_dsurch');
  e.x=u.x;e.y=u.y;assert.equal(e.profile.noAttack,true);
  const initial=u.hp;
  b.dealDamage(u,e,{amount:e.s.maxHp*.14,type:'true'});assert.equal(u.hp,initial);
  b.dealDamage(u,e,{amount:e.s.maxHp*.011,type:'true'});assert.ok(u.hp<initial);
  assert.equal(u.elem.neural,e.s.atk*e.mem.ab.sk.Stab.bb.ep_damage_ratio);
  const hp=u.hp,neural=u.elem.neural;
  b.applyStatus(e,'stun',{duration:10});b.dealDamage(u,e,{amount:e.s.maxHp*.16,type:'true'});
  assert.equal(u.hp,hp);assert.equal(u.elem.neural,neural);
  b.removeBuff(e,'stun');e.x=u.x+2.4;
  b.dealDamage(u,e,{amount:e.s.maxHp*.16,type:'true'});assert.equal(u.hp,hp);
  assert.equal(b.errorCount,0);
});

test('native reaper starts waiting, wakes on injury, gains original speed and drains HP4percent plus neural each second', () => {
  const c=create(),b=c.battle,u=deployed(c),e=b.spawnEnemy('enemy_1151_dslntc_2');
  e.x=u.x;e.y=u.y;assert.equal(e.profile.noAttack,true);
  assert.equal(e.findBuff('mizuki:dslntc:waiting').duration,30);
  b.dealDamage(u,e,{amount:e.s.maxHp*.001,type:'true'});assert.equal(e.profile.noAttack,false);
  assert.equal(e.s.moveSpeed,e.base.moveSpeed*6);
  assert.equal(e.findBuff('mizuki:dslntc:waiting'),null);
  const hp=e.hp;b.emit('tick',{dt:1});
  assert.equal(e.hp,hp-e.s.maxHp*.04);assert.equal(u.elem.neural,e.s.atk*.2);
  hit(b,e,u);assert.equal(u.elem.neural,e.s.atk*.3);
  assert.equal(b.errorCount,0);
});

test('graytail has all three native magical shields, DEF1250 while shielded and exactly double speed afterwards', () => {
  const c=create(),b=c.battle,u=deployed(c),e=b.spawnEnemy('enemy_1060_emouse');
  assert.equal(e.s.def,e.base.def+1250);const hp=e.hp;
  const shield=e.mem.ab.list.find((a)=>a.refresh&&a.left>0),one=e.mem.ab.t['shield.dynamic'];
  assert.equal(shield.left,one*3);
  for(let i=0;i<3;i++)b.dealDamage(u,e,{amount:one/(1-e.s.res/100),type:'arts',canDodge:false});
  assert.equal(e.hp,hp);assert.equal(shield.left,0);assert.equal(e.s.def,e.base.def);
  assert.equal(e.s.moveSpeed,e.base.moveSpeed*2);assert.equal(b.errorCount,0);
});

test('blast hammer native x-5 splash hits four-neighbor tiles but excludes diagonals', () => {
  const c=create({}, {players:[{playerId:'p1',units:[
    {uid:101,chessId:'chess_char_1_02_a'},{uid:102,chessId:'chess_char_1_02_a'},
    {uid:103,chessId:'chess_char_1_02_a'}]}]});
  const b=c.battle,u=deployed(c),v=deployed(c,102),w=deployed(c,103);
  v.x=u.x+1;v.y=u.y;w.x=u.x+1;w.y=u.y+1;
  const e=b.spawnEnemy('enemy_1076_bsthmr'),vhp=v.hp,whp=w.hp;
  hit(b,e,u,1);assert.ok(v.hp<vhp);assert.equal(w.hp,whp);
  assert.equal(b.errorCount,0);
});

test('native Tiacauh caster retains ranged arts and switches to physical times4 with DEF200 only while blocked', () => {
  const c=create(),b=c.battle,u=deployed(c),e=b.spawnEnemy('enemy_1096_ccwitch');
  assert.equal(e.profile.melee,false);assert.equal(e.profile.dmgType,'arts');
  b.emit('beforeAttack',{attacker:e,targets:[u]});assert.equal(e.profile.atkScale,1);
  e.blockedBy=u;b.emit('blocked',{enemy:e,blocker:u});
  assert.equal(e.s.def,e.base.def+200);
  b.emit('beforeAttack',{attacker:e,targets:[u]});assert.equal(e.profile.atkScale,4);
  const melee=b.makeDamage({amount:100,type:'arts',isAttack:true});
  b.emit('hit',{source:e,target:u,dmg:melee});assert.equal(melee.type,'phys');
  const projectile=b.makeDamage({amount:100,type:'phys',isAttack:true,isProjectile:true});
  b.emit('hit',{source:e,target:u,dmg:projectile});assert.equal(projectile.type,'arts');
  e.blockedBy=null;b.emit('tick',{dt:1/30});assert.equal(e.s.def,e.base.def);
  assert.equal(e.profile.dmgType,'arts');assert.equal(b.errorCount,0);
});

test('both native sea drifters fly and add their own original neural ratio after a physical hit', () => {
  const c=create(),b=c.battle,u=deployed(c);
  for(const id of ['enemy_1150_dsjely','enemy_1150_dsjely_2']){
    const e=b.spawnEnemy(id),old=u.elem.neural||0;
    assert.equal(e.isFlying,true);hit(b,e,u);
    assert.ok(Math.abs(u.elem.neural-old-e.s.atk*e.mem.ab.t['epdamage.attack@ep_damage_ratio'])<1e-8);
  }
  assert.equal(b.errorCount,0);
});

test('native infection death spawns use real plasm, native simultaneous delay and silence suppression', () => {
  for(const [id,n] of [['enemy_1132_sarchn',3],['enemy_1130_infstr',2]]) {
    const c=create(),b=c.battle,u=deployed(c),e=b.spawnEnemy(id,{pos:[u.y,u.x]});
    b.kill(e);assert.equal(b.enemies.filter((v)=>v.defId==='enemy_1137_plasm').length,0);
    assert.equal(b._officialSummonHolds.size,n);
    b.time+=.19;b._runScheduled();assert.equal(b.enemies.filter((v)=>v.defId==='enemy_1137_plasm').length,0);
    b.time+=.01;b._runScheduled();
    const children=b.enemies.filter((v)=>v.defId==='enemy_1137_plasm');
    assert.equal(children.length,n);assert.equal(b._officialSummonHolds.size,0);
    const originalHp=resolveOfficialEnemy({id:'enemy_1137_plasm',level:0,useDb:true}).attributes.maxHp;
    assert.ok(children.every((v)=>v.mem._mizukiOfficialKit&&v.s.maxHp===originalHp&&Math.abs(v.x-e.x)<=.2&&Math.abs(v.y-e.y)<=.2));
    const silent=b.spawnEnemy(id);b.applyStatus(silent,'silence',{duration:10});b.kill(silent);
    b.time+=1;b._runScheduled();assert.equal(b.enemies.filter((v)=>v.defId==='enemy_1137_plasm').length,n);
    assert.equal(b.errorCount,0);
  }
});

test('native summon helper keeps ground children outside impassable terrain and cancels only host-dependent summons', () => {
  const c=create(),b=c.battle,e=b.spawnEnemy('enemy_1137_plasm');
  const t=c.snapshot().geometry.tiles.find((v)=>!b.grid.groundPassable(v.row,v.col));
  assert.ok(t);e.y=t.row;e.x=t.col;
  const out=summonNativeEnemies(b,e,e.defId,{count:2,delay:.5,offsetBound:.2,tryOutside:true});
  assert.equal(out.spawned.length,0);assert.equal(out.scheduled.length,2);
  b.time+=.5;b._runScheduled();assert.equal(out.spawned.length,2);
  assert.ok(out.spawned.every((v)=>b.grid.groundPassable(v.tileR,v.tileC)));
  const cancelled=summonNativeEnemies(b,e,e.defId,{delay:.2,stopHostDead:true});
  b.kill(e);b.time+=.2;b._runScheduled();assert.equal(cancelled.spawned.length,0);
  assert.equal(b.errorCount,0);
});

test('native mortar has original 3x3 normal-attack splash and commander enhances cannon ASPD50 without stacking', () => {
  const c=create({}, {players:[{playerId:'p1',units:[
    {uid:101,chessId:'chess_char_1_02_a'},{uid:102,chessId:'chess_char_1_02_a'},
    {uid:103,chessId:'chess_char_1_02_a'}]}]});
  const b=c.battle,u=deployed(c),v=deployed(c,102),w=deployed(c,103);
  v.homeR=v.tileR=u.tileR+1;v.homeC=v.tileC=u.tileC+1;v.x=u.x+1;v.y=u.y+1;
  w.homeR=w.tileR=u.tileR+2;w.homeC=w.tileC=u.tileC+2;w.x=u.x+2;w.y=u.y+2;
  const e=b.spawnEnemy('enemy_1082_soticn'),aspd=e.s.aspd,vhp=v.hp,whp=w.hp;
  hit(b,e,u,400);assert.ok(v.hp<vhp);assert.equal(w.hp,whp);
  b.spawnEnemy('enemy_1080_sotidp');b.emit('tick',{dt:.25});assert.equal(e.s.aspd,aspd+50);
  b.emit('tick',{dt:.25});assert.equal(e.s.aspd,aspd+50);assert.equal(b.errorCount,0);
});

const creepField = (b) => installOfficialCreep(b, { mapData: {
  map:Array.from({length:19},()=>Array(22).fill(0)),
  tiles:[{tileKey:'tile_creep',blackboard:[{key:'mode',value:0}]}],
} });
test('native runner has physical and magical evade80 unless originally excluded statuses, with creep exit0.3second block-free', () => {
  const c=create(),b=c.battle,u=deployed(c),creep=creepField(b),e=b.spawnEnemy('enemy_1231_dsrunr',{pos:[u.y,u.x]});
  assert.equal(e.s.dodgePhys,.8);assert.equal(e.s.dodgeArts,.8);
  creep.activate(e.tileR,e.tileC);b.emit('tick',{dt:.2});assert.equal(e.s.flags.unblockable,true);
  creep.deactivate(e.tileR,e.tileC);b.emit('tick',{dt:.2});
  assert.equal(e.findBuff('mizuki:dsrunr:blockfree:out').duration,.3);assert.equal(e.s.flags.unblockable,true);
  for(const status of ['stun','freeze','silence','levitate']){
    b.applyStatus(e,status,{duration:1});
    const info=b.makeDamage({amount:1,type:'phys'});b.emit('hit',{source:u,target:e,dmg:info});
    assert.equal(e.s.dodgePhys,0,status);b.removeBuff(e,status);
  }
  b.emit('tick',{dt:.2});assert.equal(e.s.dodgePhys,.8);
  const old=u.elem.neural||0;hit(b,e,u);assert.equal(u.elem.neural-old,e.s.atk*.1);
  assert.equal(b.errorCount,0);
});
test('native sailor low HP creates real current-root creep and gains reversible DEF300percent and block-volume plus1', () => {
  const c=create(),b=c.battle,u=deployed(c),creep=creepField(b),e=b.spawnEnemy('enemy_1232_dssalr_2',{pos:[u.y,u.x]});
  assert.equal(creep.isActive(e.tileR,e.tileC),false);assert.equal(e.blockWeight,1);
  b.dealDamage(u,e,{type:'true',amount:e.s.maxHp*.51});
  assert.equal(creep.isActive(e.tileR,e.tileC),true);assert.equal(e.s.def,e.base.def*4);assert.equal(e.blockWeight,2);
  e.hp=e.s.maxHp;b.emit('tick',{dt:.1});assert.equal(e.s.def,e.base.def);assert.equal(e.blockWeight,1);
  assert.equal(b.errorCount,0);
});
test('native creep shooter unions ordinary range and actual global creep targets at three native targets', () => {
  const c=create(),b=c.battle,u=deployed(c),creep=creepField(b),e=b.spawnEnemy('enemy_1233_dsshtr_2');
  e.x=u.x+10;e.y=u.y;
  assert.equal(e.profile.maxTargets,3);assert.equal(e.profile.canTarget(u),false);
  creep.activate(u.tileR,u.tileC);assert.equal(e.profile.canTarget(u),true);
  assert.equal(e.profile.canTarget({...u,isFlying:true}),false);
  creep.deactivate(u.tileR,u.tileC);e.x=u.x+1;
  assert.equal(e.profile.canTarget(u),true);assert.equal(e.profile.canTarget({...u,isFlying:true}),true);
  assert.ok(e.base.rangeRadius>10);const old=u.elem.neural||0;hit(b,e,u);
  assert.equal(u.elem.neural-old,e.s.atk*.02);assert.equal(b.errorCount,0);
});

test('native creep shooter reserves all three original target slots for creep before higher normal taunt', () => {
  const c=create({}, {players:[{playerId:'p1',units:[101,102,103,104].map((uid)=>({uid,chessId:'chess_char_1_02_a'}))}]});
  const b=c.battle,us=[101,102,103,104].map((uid)=>deployed(c,uid)),creep=creepField(b),e=b.spawnEnemy('enemy_1233_dsshtr_2');
  const x=us[0].x,y=us[0].y;
  us.forEach((u,i)=>{u.x=x+i;u.y=y;u.tileC=x+i;u.tileR=y;});
  e.x=us[3].x-.2;e.y=y;
  for(const u of us.slice(0,3))creep.activate(u.tileR,u.tileC);
  b.addBuff(us[3],{key:'test:taunt',mods:{taunt:99}});
  for(const u of us.slice(0,3))assert.equal(e.profile.canTarget(u),true);
  assert.equal(e.profile.canTarget(us[3]),false);creep.deactivate(us[0].tileR,us[0].tileC);
  assert.equal(e.profile.canTarget(us[3]),true);assert.equal(b.errorCount,0);
});
