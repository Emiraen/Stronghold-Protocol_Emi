import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { createOfficialMizukiStage, resolveOfficialEnemy } from '../server/modes/mizuki/official-stages.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { resolveOfficialFacility } from '../server/modes/mizuki/OfficialStageMechanics.js';
import { spawnOfficialWeaponStation } from '../server/modes/mizuki/OfficialWeaponStation.js';
import { normalizeEnemy } from '../server/sim/simdata.js';
import { abOf, attach } from '../server/sim/content/enemies.js';
import { MIZUKI_EVENT_KITS } from '../server/modes/mizuki/native-event-enemies.js';
import { MIZUKI_LEGACY_BOSS_KITS } from '../server/modes/mizuki/native-legacy-boss-enemies.js';
import { MIZUKI_LATERANO_KITS } from '../server/modes/mizuki/native-laterano-enemies.js';
import { MIZUKI_FROST_BOSS_KITS } from '../server/modes/mizuki/native-frost-boss.js';
import { MIZUKI_LEITHANIEN_KITS } from '../server/modes/mizuki/native-leithanien-enemies.js';
import { MIZUKI_GUN_KITS } from '../server/modes/mizuki/native-gun-enemies.js';
const ALL_NATIVE_KITS = { ...MIZUKI_EVENT_KITS, ...MIZUKI_LEGACY_BOSS_KITS, ...MIZUKI_LATERANO_KITS, ...MIZUKI_FROST_BOSS_KITS, ...MIZUKI_LEITHANIEN_KITS, ...MIZUKI_GUN_KITS };

const create = () => {
  const catalog = createMizukiCatalog(getData());
  const options = createOfficialMizukiStage('ro2_n_1_1', { data: catalog.source });
  const data = Object.create(options.data);
  data.getEnemy = (id) => {
    if (!ALL_NATIVE_KITS[id]) return options.data.getEnemy(id);
    const s = resolveOfficialEnemy({ id, level: 0, useDb: true });
    const bb = (entries = []) => ({ bb: Object.fromEntries(entries.map((v) => [v.key, v.value])) });
    return normalizeEnemy(id, { key: id, name: s.name, spine: s.prefabKey, applyWay: s.applyWay,
      officialData: s, stats: { ...s.attributes, res: s.attributes.magicResistance, rangeRadius: s.rangeRadius,
        motion: s.motion, lpr: s.lifePointReduce }, talents: bb(s.talentBlackboard ?? []),
      skills: (s.skills ?? []).map((v) => ({ ...v, ...bb(v.blackboard ?? []) })) });
  };
  return new MizukiCombat({ ...options, data, seed: 7, content: 'full',
    players: [{ playerId: 'p1', units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] }],
    flags: { dpInit: 999, dpMax: 999 } });
};
const native = (b, id) => {
  const e = b.spawnEnemy(id), ab = abOf(b, e);
  ab.list = []; attach(b, e, ALL_NATIVE_KITS[id](ab, e, b)); return e;
};

test('original lifeguard gains physical-only evade once at inclusive half HP for the exact native duration', () => {
  for (const id of ['enemy_1259_durwar', 'enemy_1259_durwar_2']) {
    const b = create().battle, e = native(b, id);
    e.hp = e.s.maxHp * .50001; b.emit('tick', { dt: .03 });
    assert.equal(e.findBuff('enemy_durwar_t'), null);
    e.hp = e.s.maxHp * .5; b.emit('tick', { dt: .03 });
    const buff = e.findBuff('enemy_durwar_t');
    assert.equal(buff.mods.dodgePhys, 1); assert.equal(buff.duration, id.endsWith('_2') ? 20 : 10);
    b.applyStatus(e, 'silence', { duration: 2 });
    assert.equal(e.s.dodgePhys, 1);
    const hp = e.hp;
    b.dealDamage(null, e, { amount: 1000, type: 'phys', canDodge: true }); assert.equal(e.hp, hp);
    b.dealDamage(null, e, { amount: 100, type: 'true' }); assert.equal(e.hp, hp - 100);
    b.removeBuff(e, 'enemy_durwar_t'); b.emit('tick', { dt: 20 });
    assert.equal(e.findBuff('enemy_durwar_t'), null); assert.equal(b.errorCount, 0);
  }
});

test('lifeguard threshold waits during silence then grants the non-silenceable native buff', () => {
  const b = create().battle, e = native(b, 'enemy_1259_durwar');
  b.applyStatus(e, 'silence', { duration: 2 }); e.hp = e.s.maxHp * .4;
  b.emit('tick', { dt: .1 }); assert.equal(e.findBuff('enemy_durwar_t'), null);
  b.removeBuff(e, 'status:silence');
  // Use the actual status API expiry, whose key is internal to the engine.
  for (const buff of [...e.buffs]) if (buff.flags.silence) b.removeBuff(e, buff.key);
  b.emit('tick', { dt: .1 }); assert.equal(e.findBuff('enemy_durwar_t').mods.dodgePhys, 1);
});

test('surf coach halves post-mitigation physical and arts damage only while unblocked and unsilenced', () => {
  const b = create().battle, e = native(b, 'enemy_1262_durplc');
  for (const type of ['phys', 'arts', 'true']) {
    const hp = e.hp, base = type === 'phys' ? Math.max(1000 - e.s.def, 50)
      : type === 'arts' ? 1000 * (1 - e.s.res / 100) : 1000;
    b.dealDamage(null, e, { amount: 1000, type, canDodge: false });
    assert.ok(Math.abs(hp - e.hp - base * (type === 'true' ? 1 : .5)) < 1e-8, type);
  }
  e.blockedBy = { id: 1 }; let hp = e.hp;
  b.dealDamage(null, e, { amount: 1000, type: 'phys', canDodge: false });
  assert.equal(hp - e.hp, Math.max(1000 - e.s.def, 50));
  e.blockedBy = null; b.applyStatus(e, 'silence', { duration: 10 }); hp = e.hp;
  b.dealDamage(null, e, { amount: 1000, type: 'arts', canDodge: false });
  assert.equal(hp - e.hp, 1000 * (1 - e.s.res / 100)); assert.equal(b.errorCount, 0);
});

test('original merchant keeps invincibility and chooses two global hatred-priority enemies for 12s undying offense', () => {
  const c = create(), b = c.battle, e = b.spawnEnemy('enemy_2036_syshop');
  assert.equal(e.s.flags.invulnerable, true); assert.equal(e.s.flags.unblockable, true);
  const targets = Array.from({ length: 3 }, () => b.spawnEnemy('enemy_1007_slime'));
  b.rng.int = () => 1; b.emit('tick', { dt: 22.99 });
  assert.equal(targets.filter((u) => u.findBuff('syshop_s[atk]')).length, 0);
  b.emit('tick', { dt: .01 });
  assert.equal(targets.filter((u) => u.findBuff('syshop_s[atk]')).length, 2);
  const boosted = targets.find((u) => u.findBuff('syshop_s[atk]'));
  assert.equal(boosted.findBuff('syshop_s[atk]').duration, 12);
  assert.equal(boosted.s.atk, boosted.base.atk * 2);
  assert.equal(boosted.s.aspd, boosted.base.aspd + 100);
  b.dealDamage(null, boosted, { type: 'true', amount: 1000000, canDodge: false });
  assert.equal(boosted.hp, 1); assert.equal(boosted.alive, true);
  b.removeBuff(boosted, 'syshop_s[atk]');
  b.dealDamage(null, boosted, { type: 'true', amount: 1 }); assert.equal(boosted.alive, false);
  assert.equal(e.mem.mizukiMerchant.sp.value, 0); assert.equal(b.errorCount, 0);
});

test('original merchant sleep alternative targets every other enemy and rejects native sleep immunity', () => {
  const c = create(), b = c.battle, e = b.spawnEnemy('enemy_2036_syshop');
  const targets = Array.from({ length: 3 }, () => b.spawnEnemy('enemy_1007_slime'));
  b.rng.int = () => 0; b.emit('tick', { dt: 23 });
  assert.equal(targets.every((u) => u.s.flags.sleep), true);
  assert.equal(e.s.flags.sleep, undefined);
  const u = targets[0], buff = u.findBuff('syshop_s[sleep]');
  assert.equal(buff.duration, 10); assert.equal(buff.interval, 1);
  u.hp = u.s.maxHp * .1; const hp = u.hp; buff.onTick({ battle: b, unit: u });
  assert.ok(Math.abs(u.hp - hp - u.s.maxHp * .04) < 1e-8);
  assert.equal(b.errorCount, 0);
});

const deployedTarget = (c) => {
  const tile = c.snapshot().geometry.tiles.find((v) => c.battle.grid.canStand(v.row, v.col, { ranged: false }) && !v.obstacle);
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: tile.row, col: tile.col, dir: 'RIGHT' }).ok, true);
  const u = c.battle.getPlayer('p1').units[0];
  c.battle.addBuff(u, { key: 'test:target:hp', mods: { hpFlat: 1000000 } }); u.hp = u.s.maxHp; return u;
};

test('native rusthammer retains source sixty-second invulnerability and normal physical tracking projectile', () => {
  const c = create(), b = c.battle, u = deployedTarget(c), e = native(b, 'enemy_2006_flsnip');
  assert.equal(e.findBuff('faust_t_invi').duration, 60);
  assert.deepEqual(e.def.attackAnim, { dur: 3, hit: 1.333 }); assert.equal(e.base.rangeRadius, 20);
  e.x = u.x - 2; e.y = u.y; const hp = u.hp;
  b.emit('attack', { attacker: e, targets: [u] });
  assert.equal(b.projectiles.list.length, 1);
  assert.equal(b.projectiles.list[0].speed, 10); assert.equal(b.projectiles.list[0].maxAge, 5);
  assert.equal(u.hp, hp); b.projectiles.update(.19); assert.equal(u.hp, hp);
  b.kill(e, null); b.projectiles.update(.011);
  assert.equal(hp - u.hp, Math.max(e.s.atk - u.s.def, e.s.atk * .05)); assert.equal(b.errorCount, 0);
});

test('native rusthammer special waits original cast event and deals 300% arts rather than physical damage', () => {
  const c = create(), b = c.battle, u = deployedTarget(c), e = native(b, 'enemy_2006_flsnip');
  e.x = u.x - 2; e.y = u.y; const hp = u.hp;
  b.emit('tick', { dt: 17.99 }); assert.equal(!!e.profile.noAttack, false);
  b.emit('tick', { dt: .01 }); assert.equal(e.profile.noAttack, true);
  b.time = 1.332; b._runScheduled(); assert.equal(b.projectiles.list.length, 0);
  b.time = 1.333; b._runScheduled(); assert.equal(b.projectiles.list.length, 1);
  b.projectiles.update(.2);
  assert.ok(Math.abs(hp - u.hp - e.s.atk * 3 * (1 - u.s.res / 100)) < 1e-8);
  b.time = 3; b._runScheduled(); assert.equal(e.profile.noAttack, false); assert.equal(b.errorCount, 0);
});

test('native waiting knight wakes from the original root MELEE mask and never gains sleeping invulnerability', () => {
  const c = create(), b = c.battle, e = native(b, 'enemy_1181_napkgt_2');
  const tile = c.snapshot().geometry.tiles.find((v) => b.grid.canStand(v.row, v.col, { ranged: false }) && !v.obstacle);
  e.x = tile.col; e.y = tile.row; b.emit('tick', { dt: .03 });
  assert.equal(e.profile.noAttack, false); assert.equal(e.findBuff('napkgt_wait_awake'), null);
  assert.equal(e.form, 'normal'); assert.equal(!!e.s.flags.sleep, false);
  assert.deepEqual(e.def.attackAnim, { dur: 2, hit: 1 }); assert.equal(b.errorCount, 0);
});

test('native waiting knight on a nonbuildable source tile waits exact fifty seconds and remains damageable', () => {
  const c = create(), b = c.battle;
  const road = c.snapshot().geometry.tiles.find((v) => b.grid.tile(v.row, v.col).build === 'NONE');
  const e = b.spawnEnemy('enemy_1181_napkgt_2', { pos: [road.row, road.col] });
  assert.equal(e.profile.noAttack, true); const wait = e.findBuff('napkgt_wait_awake');
  assert.equal(wait.duration, 50); assert.equal(e.s.flags.noMove, true);
  const hp = e.hp; b.dealDamage(null, e, { amount: 100, type: 'true' }); assert.equal(e.hp, hp - 100);
  wait.onExpire({ battle: b, unit: e }); assert.equal(e.profile.noAttack, false); assert.equal(e.form, 'normal');
  assert.equal(b.errorCount, 0);
});

test('native saxophonist keeps original charge and four speed9 first-hit-only projectiles after source death', () => {
  for (const id of ['enemy_1243_ltswar', 'enemy_1243_ltswar_2']) {
    const c = create(), b = c.battle, u = deployedTarget(c), e = b.spawnEnemy(id);
    e.x = u.x - 2; e.y = u.y; const hp = u.hp;
    assert.deepEqual(e.def.attackAnim, { dur: 2.5, hit: .8 });
    b.emit('tick', { dt: 9.99 }); assert.equal(!!e.profile.noAttack, false);
    b.emit('tick', { dt: .01 }); assert.equal(e.profile.noAttack, true);
    b.time = 3.599; b._runScheduled(); assert.equal(b.projectiles.list.length, 0);
    b.time = 3.6; b._runScheduled(); assert.equal(b.projectiles.list.length, 4);
    assert.equal(b.projectiles.list.every((p) => p.speed === 9 && p.maxAge === 60), true);
    b.kill(e, null); b.projectiles.update(.25); b.emit('tick', { dt: 0 });
    assert.equal(hp - u.hp, Math.max(e.s.atk * 1.5 - u.s.def, e.s.atk * 1.5 * .05));
    assert.equal(b.projectiles.list.length, 3);
    b.projectiles.update(.25); b.emit('tick', { dt: 0 }); assert.equal(b.projectiles.list.length, 3);
    assert.equal(b.errorCount, 0);
  }
});

test('native saxophonist charge is interrupted by stun before any directional projectile is emitted', () => {
  const b = create().battle, e = b.spawnEnemy('enemy_1243_ltswar');
  b.emit('tick', { dt: 10 }); assert.equal(e.profile.noAttack, true);
  b.applyStatus(e, 'stun', { duration: 2 }); b.emit('tick', { dt: 0 });
  assert.equal(e.profile.noAttack, false); b.time = 4; b._runScheduled();
  assert.equal(b.projectiles.list.length, 0); assert.equal(b.errorCount, 0);
});

test('native saint variants consume original three/one rounds, fire delayed double physical shots and enter sword on final hit', () => {
  for (const [id, max] of [['enemy_2026_syudg', 3], ['enemy_2027_syudg2', 1]]) {
    const c = create(), b = c.battle, u = deployedTarget(c), e = b.spawnEnemy(id);
    e.x = u.x - 1; e.y = u.y; const a = e.mem.mizukiSaint;
    assert.equal(a.sp.value, max); assert.equal(a.sp.max, max);
    const hp = u.hp;
    for (let i = 0; i < max; i++) {
      b.time = i * 4; b._runScheduled(); b.emit('tick', { dt: i ? 4 : 0 });
      assert.equal(a.sp.value, max - i - 1);
      b.time += .866; b._runScheduled(); assert.equal(b.projectiles.list.length, 0);
      b.time += .001; b._runScheduled(); assert.equal(b.projectiles.list.length, 1);
      b.projectiles.update(.1);
    }
    assert.equal(a.mode, 'sword'); assert.equal(e.profile.melee, true); assert.equal(e.profile.noAttack, false);
    assert.equal(hp - u.hp, max * Math.max(e.s.atk * 2 - u.s.def, e.s.atk * 2 * .05));
    b.emit('tick', { dt: 35 - (max - 1) * 4 });
    assert.equal(a.mode, 'reload'); assert.equal(a.sp.value, 0);
    b.emit('tick', { dt: 1.99 }); assert.equal(a.sp.value, 0);
    b.emit('tick', { dt: .01 }); assert.equal(a.sp.value, 1);
    if (max === 1) assert.equal(a.mode, 'gun');
    else { b.emit('tick', { dt: 4 }); assert.equal(a.mode, 'gun'); assert.equal(a.sp.value, max); }
    assert.equal(b.errorCount, 0);
  }
});

test('interrupting native saint reload chooses gun or sword from remaining ammo and stuns only the saint for ten seconds', () => {
  for (const partial of [false, true]) {
    const c = create(), b = c.battle, u = deployedTarget(c), e = b.spawnEnemy('enemy_2026_syudg');
    const a = e.mem.mizukiSaint; a.sp.value = 0;
    b.emit('tick', { dt: 35 }); assert.equal(a.mode, 'reload');
    if (partial) b.emit('tick', { dt: 2 });
    b.applyStatus(e, 'stun', { duration: 1 });
    assert.equal(a.mode, partial ? 'gun' : 'sword'); assert.equal(e.s.flags.stun, true);
    assert.equal(Math.max(...e.buffs.filter((buff) => buff.flags.stun).map((buff) => buff.duration)), 10);
    assert.equal(!!u.s.flags.stun, false); assert.equal(e.findBuff('mizuki:saint:reload'), null);
    assert.equal(b.errorCount, 0);
  }
});

test('native FrostNova keeps eighty-second invulnerability, source cold and delayed doubled frozen ice-ring damage', () => {
  const c = create(), b = c.battle, u = deployedTarget(c), e = b.spawnEnemy('enemy_2007_flwitch');
  e.x = u.x - 1; e.y = u.y;
  assert.equal(e.findBuff('flwitch_t_invincible').duration, 80);
  b.emit('attack', { attacker: e, targets: [u] }); b.projectiles.update(.1);
  assert.equal(u.s.flags.cold, true);
  b.applyStatus(u, 'freeze', { duration: 30, source: e }); const hp = u.hp;
  b.emit('tick', { dt: 12 }); assert.equal(e.profile.noAttack, true);
  b.time = .666; b._runScheduled(); assert.equal(u.hp, hp);
  b.time = .667; b._runScheduled();
  assert.ok(Math.abs(hp - u.hp - e.s.atk * 1.3 * 2 * (1 - u.s.res / 100)) < 1e-8);
  assert.equal(b.errorCount, 0);
});

test('native FrostNova rebirth applies original 6.6s transition and source second-form attribute modifiers', () => {
  const b = create().battle, e = b.spawnEnemy('enemy_2007_flwitch');
  b.removeBuff(e, 'flwitch_t_invincible'); b.kill(e, null);
  assert.equal(e.alive, true); assert.equal(e.mem.mizukiFrost.phase, 'reborn');
  const buff = e.findBuff('mizuki:flwitch:reborn'); assert.equal(buff.duration, 6.6);
  buff.onExpire({ battle: b });
  assert.equal(e.mem.mizukiFrost.phase, 'form2'); assert.equal(e.s.atk, e.base.atk * 1.9);
  assert.equal(e.s.maxHp, e.base.maxHp * 1.5); assert.equal(e.hp, e.s.maxHp);
  assert.equal(e.findBuff('mizuki:flwitch:reborn:inv').duration, 30); assert.equal(b.errorCount, 0);
});

test('native FrostNova frozen voluntary exit doubles only this deployment timer and not the next exit', () => {
  const c = create(), b = c.battle, u = deployedTarget(c); b.spawnEnemy('enemy_2007_flwitch');
  b.applyStatus(u, 'freeze', { duration: 10 }); const base = u.base.respawnTime * u.persist.redeployMul * u.s.redeployMul;
  b.retreat(u); assert.equal(u.respawnAt - b.time, base * 2);
  assert.equal(u.persist.redeployMul, 1); assert.equal(b.errorCount, 0);
});

test('native FrostNova SummonFrosts consumes the original non-looping branch phases one at a time in order', () => {
  const options = createOfficialMizukiStage('ro2_b_9');
  const c = new MizukiCombat({ ...options, seed: 7, content: 'full', players: [{ playerId: 'p1', units: [] }] });
  const b = c.battle, e = b.spawnEnemy('enemy_2007_flwitch'), ab = abOf(b, e);
  const summons = ab.list.find((a) => a.sk === ab.sk.SummonFrosts);
  const actual = [], trigger = b._officialWaves.triggerBranch.bind(b._officialWaves);
  b._officialWaves.triggerBranch = (key, args) => { const r = trigger(key, args); actual.push(r); return r; };
  for (let i = 0; i < 4; i++) {
    b.time = i * 75; b._runScheduled(); assert.equal(summons.cond(b, e), true);
    summons.fire(b, e); b.time += .432; b._runScheduled(); assert.equal(actual.length, i);
    b.time += .001; b._runScheduled(); assert.equal(actual.length, i + 1);
  }
  b.time += 2; b._runScheduled(); assert.equal(summons.cond(b, e), false);
  assert.deepEqual(actual.map((v) => v.phaseIndex), [0, 1, 2, 3]);
  assert.equal(actual.every((v) => v.ok), true); assert.equal(b.errorCount, 0);
});

test('native b5 source has no circuit or gramophone and drunk adds original 40 percent arts without extra SP', () => {
  const options = createOfficialMizukiStage('ro2_b_5'), p = options.officialLevel.predefines;
  assert.deepEqual([...p.characterInsts, ...p.tokenInsts].map((v) => v.inst.characterKey), Array(3).fill('trap_027_stone'));
  assert.equal(options.officialLevel.mapData.tiles.some((v) => /magic|circuit|tower/.test(v.tileKey)), false);
  const c = create(), b = c.battle, u = deployedTarget(c), e = b.spawnEnemy('enemy_1238_ltmob_2');
  const hits = []; b.on('hit', (event) => { if (event.source === e) hits.push(event.dmg); });
  const hp = u.hp; b.emit('attack', { attacker: e, targets: [u] });
  assert.ok(Math.abs(hp - u.hp - e.s.atk * .4 * (1 - u.s.res / 100)) < 1e-8);
  assert.equal(hits[0].noSp, true); assert.equal(hits[0].isAttack, true); assert.equal(b.errorCount, 0);
});

test('native b5 violinist and chanter retain original arts projectile lifetimes and never fabricate linked targets', () => {
  for (const [id, life] of [['enemy_1242_ltsmag_2', 5], ['enemy_1088_ltsmer_2', 10]]) {
    const c = create(), b = c.battle, u = deployedTarget(c), e = b.spawnEnemy(id);
    e.x = u.x - 2; e.y = u.y; const hp = u.hp;
    b.emit('attack', { attacker: e, targets: [u] });
    assert.equal(b.projectiles.list.length, 1); assert.equal(b.projectiles.list[0].maxAge, life);
    b.projectiles.update(.2); assert.ok(Math.abs(hp - u.hp - e.s.atk * (1 - u.s.res / 100)) < 1e-8);
    b.emit('tick', { dt: 100 }); assert.equal(b.projectiles.list.length, 0); assert.equal(b.errorCount, 0);
  }
});

const gunTarget = (b, x, y) => {
  const u = b.spawnToken(null, 'test:native-gun-target', Math.round(y), Math.round(x), {
  def: { name: 'target', stats: { maxHp: 100000, atk: 0, def: 0, magicResistance: 0, blockCnt: 0 },
    profession: 'GUARD', position: 'MELEE', rangeGrid: [], attackKind: 'none' },
  kit: { trait: { attack: 'none', noAttack: true },
    skill: { kind: 'instant', spType: 'attack', spCost: 100, initSp: 0 } },
  });
  if (u) { u.x = x; u.y = y; }
  return u;
};
const gunStation = (b, x, y, side = 'ally') => {
  const p = { inst: { characterKey: 'trap_057_wpnsts', level: 1, phase: 'PHASE_0' },
    alias: 'gun-station', position: { row: y, col: x }, direction: 'RIGHT',
    skillIndex: side === 'enemy' ? 1 : 0, mainSkillLvl: 1 };
  return spawnOfficialWeaponStation(b, p, resolveOfficialFacility(p));
};

test('native pathfinder prioritizes the real weapon station and emits original delayed-impact physical plus trap arts damage', () => {
  const b = create().battle, e = native(b, 'enemy_1215_ptrarc'), u = gunTarget(b, 5, 2), s = gunStation(b, 5, 3);
  e.x = 4; e.y = 2;
  assert.equal(e.profile.canTarget(u), false); assert.equal(e.profile.canTarget(s), true);
  assert.deepEqual(e.def.attackAnim, { dur: 1, hit: .533 });
  const hp = s.hp; b.emit('attack', { attacker: e, targets: [s] });
  assert.equal(s.hp, hp); b.projectiles.update(.2);
  const expected = Math.max(e.s.atk - s.s.def, e.s.atk * .05) + 1000 * (1 - s.s.res / 100);
  assert.ok(Math.abs(hp - s.hp - expected) < 1e-8);
  b.dealDamage(e, s, { type: 'true', amount: 1000000 });
  assert.equal(s.side, 'enemy'); assert.equal(e.profile.canTarget(u), true); assert.equal(b.errorCount, 0);
});

test('native cansld uses two slow original square shells, hits the square corner and returns to melee without infinite ammunition', () => {
  const b = create().battle, e = native(b, 'enemy_1216_cansld');
  const center = gunTarget(b, 6, 3), corner = gunTarget(b, 7.4, 4.4), outside = gunTarget(b, 7.8, 3);
  e.x = 4; e.y = 3;
  assert.equal(e.mem.mizukiCanSoldier.sp.value, 2);
  assert.deepEqual(e.def.attackAnim, { dur: 2.5, hit: 1.333 });
  b.emit('attack', { attacker: e, targets: [center] });
  assert.equal(b.projectiles.list[0].speed, 4); assert.equal(b.projectiles.list[0].maxAge, 10);
  const hp = [center.hp, corner.hp, outside.hp];
  b.projectiles.update(.5);
  assert.equal(hp[0] - center.hp, e.s.atk); assert.equal(hp[1] - corner.hp, e.s.atk); assert.equal(outside.hp, hp[2]);
  b.emit('attack', { attacker: e, targets: [center] });
  assert.equal(e.mem.mizukiCanSoldier.sp.value, 0); assert.equal(e.profile.melee, true); assert.equal(e.profile.deferHit, false);
  assert.deepEqual(e.def.attackAnim, { dur: 1.5, hit: .833 });
  b.kill(e, null); const after = center.hp; b.projectiles.update(.5);
  assert.equal(after - center.hp, e.s.atk); assert.equal(b.errorCount, 0);
});

test('native cansld weapon station restores its actual ammunition and shell trap damage captures a real station', () => {
  const b = create().battle, e = native(b, 'enemy_1216_cansld'), s = gunStation(b, 5, 3, 'enemy');
  e.x = 6; e.y = 3; e.tileC = 6; e.tileR = 3;
  e.mem.mizukiCanSoldier.sp.value = 0; e.mem.mizukiCanSoldier.sync();
  b.emit('tick', { dt: 1.99 }); assert.equal(e.mem.mizukiCanSoldier.sp.value, 0);
  b.emit('tick', { dt: .01 }); assert.equal(e.mem.mizukiCanSoldier.sp.value, 1);
  assert.equal(e.profile.melee, false); assert.equal(e.profile.deferHit, true);
  e.mem.mizukiGainSp(99); assert.equal(e.mem.mizukiCanSoldier.sp.value, 2);
  b.dealDamage(null, s, { type: 'true', amount: 1000000 });
  b.time = s.mem.mizukiWeaponStation.rebornUntil + .001; b._runScheduled(); b.emit('tick', { dt: .01 });
  assert.equal(s.side, 'ally'); assert.equal(s.mem.mizukiWeaponStation.reborn, false);
  s.hp = 3000; b.emit('attack', { attacker: e, targets: [s] }); b.projectiles.update(.25);
  assert.equal(s.side, 'enemy'); assert.equal(s.mem.mizukiWeaponStation.captures, 2); assert.equal(b.errorCount, 0);
});

test('native priest spends exactly one source round per landed debuff, stacks permanent DEF loss, and accepts station SP', () => {
  const b = create().battle, e = native(b, 'enemy_1284_sgprst'), u = gunTarget(b, 5, 3);
  e.x = 4; e.y = 3;
  for (let n = 1; n <= 11; n++) {
    b.emit('attack', { attacker: e, targets: [u] });
    const before = e.mem.mizukiPriest.sp.value; b.projectiles.update(.1);
    assert.equal(e.mem.mizukiPriest.sp.value, Math.max(0, 10 - n));
    assert.equal(u.findBuff('enemy_sgprst_reduce_def').mods.defFlat, -300 * Math.min(n, 10));
    assert.equal(before - e.mem.mizukiPriest.sp.value, n <= 10 ? 1 : 0);
  }
  assert.equal(u.findBuff('enemy_sgprst_reduce_def').duration, Infinity);
  const s = gunStation(b, 4, 2, 'enemy'); e.tileC = 4; e.tileR = 3;
  b.emit('tick', { dt: 2 }); assert.equal(e.mem.mizukiPriest.sp.value, 1);
  b.emit('attack', { attacker: e, targets: [u] }); b.projectiles.update(.1);
  assert.equal(u.findBuff('enemy_sgprst_reduce_def').mods.defFlat, -3300);
  assert.equal(s.side, 'enemy'); assert.equal(b.errorCount, 0);
});

test('native unconcerned fire uses strict lost-HP thresholds, one trigger after a skipped interval and source-independent permanent true damage', () => {
  const b = create().battle, e = native(b, 'enemy_1285_sgwlf'), u = gunTarget(b, 5, 3);
  e.x = 5; e.y = 3;
  b.dealDamage(null, e, { amount: e.s.maxHp * .3, type: 'true' });
  assert.equal(e.mem.mizukiFireBottle.count, 1);
  b.dealDamage(null, e, { amount: 1, type: 'true' });
  assert.equal(e.mem.mizukiFireBottle.count, 2);
  b.time = .199; b._runScheduled(); assert.equal(e.mem.mizukiFireBottle.zones.length, 0);
  const hp = u.hp; b.addBuff(u, { key: 'test:camouflage', flags: { camou: true } });
  b.time = .2; b._runScheduled(); assert.equal(u.hp, hp - 100);
  assert.equal(e.mem.mizukiFireBottle.zones.length, 1);
  b.dealDamage(null, e, { amount: e.s.maxHp * .5, type: 'true' });
  assert.equal(e.mem.mizukiFireBottle.count, 3);
  b.time = .4; b._runScheduled(); assert.equal(e.mem.mizukiFireBottle.zones.length, 2);
  b.kill(e, null); const before = u.hp; b.emit('tick', { dt: 10 });
  assert.equal(before - u.hp, 2000);
  b.addBuff(u, { key: 'test:stealth', flags: { stealth: true } });
  const hiddenHp = u.hp; b.emit('tick', { dt: 1 }); assert.equal(u.hp, hiddenHp);
  assert.equal(b.errorCount, 0);
});


test('native fire trigger consumes a disabled threshold and a new forced cast interrupts the unreleased previous bottle', () => {
  const b = create().battle, e = native(b, 'enemy_1285_sgwlf');
  b.applyStatus(e, 'silence', { duration: 10 });
  b.dealDamage(null, e, { amount: e.s.maxHp * .31, type: 'true' });
  assert.equal(e.mem.mizukiFireBottle.count, 2);
  for (const buff of [...e.buffs]) if (buff.flags.silence) b.removeBuff(e, buff);
  b.dealDamage(null, e, { amount: 1, type: 'true' });
  b.time = 1; b._runScheduled(); assert.equal(e.mem.mizukiFireBottle.zones.length, 0);
  b.dealDamage(null, e, { amount: e.s.maxHp * .3, type: 'true' });
  b.time = 1.1; b.dealDamage(null, e, { amount: e.s.maxHp * .3, type: 'true' });
  assert.equal(e.mem.mizukiFireBottle.count, 4);
  b.time = 1.2; b._runScheduled(); assert.equal(e.mem.mizukiFireBottle.zones.length, 0);
  b.time = 1.3; b._runScheduled(); assert.equal(e.mem.mizukiFireBottle.zones.length, 1);
  assert.equal(b.errorCount, 0);
});
