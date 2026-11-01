import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getData } from '../server/data.js';
import { normalizeEnemy } from '../server/sim/simdata.js';
import { abOf, attach } from '../server/sim/content/enemies.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { createOfficialMizukiStage, resolveOfficialEnemy } from '../server/modes/mizuki/official-stages.js';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { MIZUKI_BOSS_KITS, MIZUKI_BOSS_NATIVE_RULES } from '../server/modes/mizuki/boss-enemies.js';
import { UF } from '../shared/constants.js';

const source = createMizukiCatalog(getData()).source;
const izumikLevel = JSON.parse(readFileSync(new URL('../data/mizuki/levels/level_rogue2_b-7.json', import.meta.url), 'utf8'));
const nativeRefs = new Map(izumikLevel.enemyDbRefs.map((ref) => [ref.id, ref]));
const blackboard = (entries) => ({
  bb: Object.fromEntries((entries || []).map((entry) => [entry.key, entry.value])),
  bbStr: Object.fromEntries((entries || []).filter((entry) => entry.valueStr !== null).map((entry) => [entry.key, entry.valueStr])),
});
function fixture(t, stageId = 'ro2_n_1_1') {
  const stage = createOfficialMizukiStage(stageId, { data: source, seed: 5 });
  const combat = new MizukiCombat({ ...stage, seed: 5, players: [{ playerId: 'p1', units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] }],
    flags: { ...stage.flags, dpInit: 999, dpMax: 999 } });
  t.after(() => combat.forceEnd());
  const battle = combat.battle;
  const base = battle.data; const data = Object.create(base); const enemies = new Map();
  for (const id of new Set([...Object.keys(MIZUKI_BOSS_KITS), ...nativeRefs.keys()])) {
    const raw = resolveOfficialEnemy(nativeRefs.get(id) || { id, level: 0 });
    enemies.set(id, normalizeEnemy(id, { key: id, name: raw.name, rank: raw.levelType, applyWay: raw.applyWay,
      stats: { ...raw.attributes, res: raw.attributes.magicResistance, rangeRadius: raw.rangeRadius, motion: raw.motion },
      talents: blackboard(raw.talentBlackboard), officialData: raw,
      skills: (raw.skills || []).map((skill) => ({ ...skill, ...blackboard(skill.blackboard) })) }));
  }
  data.getEnemy = (id) => enemies.get(id) || base.getEnemy(id); battle.data = data;
  battle.on('enemySpawn', ({ enemy }) => {
    if (MIZUKI_BOSS_KITS[enemy.defId]) battle.addBuff(enemy, { key: 'test:hold', persist: true, flags: { noMove: true, disarm: true } });
    if (!MIZUKI_BOSS_KITS[enemy.defId] || enemy.mem._mizukiOfficialKit || enemy.mem._mizukiBossTestKit) return;
    enemy.mem._mizukiBossTestKit = true;
    attach(battle, enemy, MIZUKI_BOSS_KITS[enemy.defId](abOf(battle, enemy), enemy, battle));
  }, { priority: 80 });
  const tile = combat.snapshot().geometry.tiles.find((entry) => battle.grid.canStand(entry.row, entry.col, { ranged: false }) && !entry.obstacle);
  assert.equal(combat.command('p1', { type: 'deploy', uid: 101, row: tile.row, col: tile.col, dir: 'RIGHT' }).ok, true);
  const operator = battle.getPlayer('p1').units[0];
  battle.addBuff(operator, { key: 'test:hold', persist: true, flags: { invulnerable: true, disarm: true } });
  const spawn = (id, pos = [tile.row, tile.col]) => {
    const enemy = battle.spawnEnemy(id, { pos });
    battle.addBuff(enemy, { key: 'test:hold', persist: true, flags: { noMove: true, disarm: true } });
    return enemy;
  };
  const hit = (enemy, amount) => battle.dealDamage(operator, enemy, { amount, type: 'true', canDodge: false, isAttack: true });
  const advance = (seconds) => { for (let index = 0; index < Math.ceil(seconds / battle.dt); index++) battle.step(); };
  return { combat, battle, operator, spawn, hit, advance };
}

test('paired original sea bosses fake death heal and revive until both parts are defeated together', (t) => {
  const { battle, spawn, hit, advance } = fixture(t);
  const priest = spawn('enemy_2028_syevil'); const body = spawn('enemy_2029_symon');
  hit(priest, priest.s.maxHp * 2);
  assert.equal(priest.alive, true); assert.equal(priest.mem.mizukiFakeDeath.fake, true);
  assert.equal(priest.s.flags.untargetable, true);
  const hp = priest.hp; advance(1.1); assert.ok(priest.hp > hp);
  advance(20); assert.equal(priest.mem.mizukiFakeDeath.fake, false);
  assert.equal(priest.hp, priest.s.maxHp);
  hit(priest, priest.s.maxHp * 2); assert.equal(priest.alive, true);
  hit(body, body.s.maxHp * 2);
  assert.equal(body.alive, false); assert.equal(priest.alive, false);
  assert.equal(battle.errorCount, 0);
});

test('paranoid bubble keeps 3 then 5 targets, 20 second rebirth and 95 percent HP while staying grounded in form two', (t) => {
  const { battle, spawn, hit, advance } = fixture(t);
  const enemy = spawn('enemy_2037_sygirl');
  assert.equal(enemy.profile.maxTargets, 3); assert.equal(enemy.s.flags.float, true);
  battle.applyStatus(enemy, 'stun', { duration: 1 });
  assert.equal(!!enemy.s.flags.float, false); assert.equal(enemy.mem.mizukiGirl.fallen, true);
  hit(enemy, enemy.s.maxHp * 2);
  assert.equal(enemy.alive, true); assert.equal(enemy.mem.mizukiGirlReborn, true);
  advance(20.1);
  assert.equal(enemy.mem.mizukiGirlReborn, false);
  assert.equal(enemy.profile.maxTargets, 5); assert.equal(!!enemy.s.flags.float, false);
  assert.equal(enemy.hp, enemy.s.maxHp * MIZUKI_BOSS_NATIVE_RULES.girl.recoveryHpRatio);
  battle.applyStatus(enemy, 'groundbind', { duration: 1 }); assert.equal(!!enemy.s.flags.float, false);
  hit(enemy, enemy.s.maxHp * 2); assert.equal(enemy.alive, false);
  assert.equal(battle.errorCount, 0);
});

test('paranoid bubble direct first-form defeat stays grounded throughout recovery and form two in simulation and snapshots', t => {
  const { combat, battle, spawn, hit, advance } = fixture(t);
  const enemy = spawn('enemy_2037_sygirl');
  const snapshotFlying = () => !!(combat.snapshot().units.find(unit => unit[0] === enemy.id)?.[7] & UF.FLYING);
  assert.equal(enemy.s.flags.float, true);
  assert.equal(snapshotFlying(), true);
  hit(enemy, enemy.s.maxHp * 2);
  assert.equal(enemy.mem.mizukiGirlReborn, true);
  assert.equal(!!enemy.s.flags.float, false);
  assert.equal(snapshotFlying(), false);
  advance(20.1);
  assert.equal(enemy.mem.mizukiGirlReborn, false);
  assert.equal(!!enemy.s.flags.float, false);
  assert.equal(enemy.isFlying, false);
  assert.equal(!!enemy.s.flags.unblockable, false);
  assert.equal(snapshotFlying(), false);
  assert.equal(enemy.mem.mizukiGirl.fallen, true);
  battle.applyStatus(enemy, 'stun', { duration: 1 });
  advance(5);
  assert.equal(enemy.isFlying, false);
  assert.equal(snapshotFlying(), false);
  assert.equal(battle.errorCount, 0);
});

test('last knight reflects original cold durations and uses damageable recovery before unblockable slow walking', (t) => {
  const { battle, spawn, hit, advance, operator } = fixture(t);
  const enemy = spawn('enemy_2038_sydonq');
  hit(enemy, 1); assert.equal(operator.buffs.find((buff) => buff.status === 'cold').duration, 2);
  battle.removeBuff(operator, 'status:cold');
  hit(enemy, enemy.s.maxHp * 0.6);
  assert.ok(operator.buffs.some((buff) => (buff.status === 'cold' || buff.status === 'freeze') && buff.duration === 4));
  hit(enemy, enemy.s.maxHp * 2);
  assert.equal(enemy.alive, true); assert.equal(enemy.hp, enemy.s.maxHp);
  assert.equal(enemy.s.flags.invulnerable, true);
  advance(2.1); assert.equal(!!enemy.s.flags.invulnerable, false);
  hit(enemy, enemy.s.maxHp * 0.76);
  assert.equal(enemy.s.flags.unblockable, true); assert.equal(enemy.profile.noAttack, true);
  assert.equal(enemy.s.moveSpeed, enemy.base.moveSpeed * 0.5);
  assert.equal(battle.errorCount, 0);
});

test('pathmaker native attack and nonfatal damage counters create real route-following fragments with inherited HP', (t) => {
  const { battle, spawn, hit, advance, operator } = fixture(t);
  const enemy = spawn('enemy_2031_syboy');
  const attack = () => battle.emit('attack', { attacker: enemy, targets: [operator], targetDeployments: new Map([[operator, operator.deploySeq]]) });
  attack(); attack(); assert.equal(battle.enemies.filter((unit) => unit.defId === 'enemy_2033_syboys').length, 0);
  hit(enemy, enemy.s.maxHp * 0.2);
  attack(); advance(0.6);
  const first = battle.enemies.find((unit) => unit.defId === 'enemy_2033_syboys');
  assert.ok(first?.alive); assert.equal(first.mem.mizukiSummonHostId, enemy.id);
  assert.ok(Math.abs(first.hpRatio - enemy.hpRatio) < 1e-9);
  const threshold = enemy.mem.ab.t['SummonMark.damage_counter'];
  for (let index = 0; index < threshold - 1; index++) hit(enemy, 1);
  advance(0.6);
  assert.equal(battle.enemies.filter((unit) => unit.alive && unit.defId === 'enemy_2033_syboys').length, 2,
    JSON.stringify({ talents: enemy.mem.ab.t, strings: enemy.mem.ab.tS, skills: enemy.mem.ab.sk,
      counters: enemy.mem.ab.list.map((ability) => ({ attacks: ability.attacks, received: ability.received })),
      units: battle.enemies.map((unit) => ({ id: unit.defId, alive: unit.alive, hp: unit.hp })), errors: battle.errorCount }));
  hit(enemy, enemy.s.maxHp * 2);
  assert.ok(battle.enemies.filter((unit) => unit.defId === 'enemy_2033_syboys').every((unit) => !unit.alive));
  assert.equal(battle.errorCount, 0);
});

test('pathmaker native global fragment caps and fatal damage do not create extra fragments', (t) => {
  const { battle, spawn, hit, advance, operator } = fixture(t);
  const enemy = spawn('enemy_2031_syboy');
  const attack = (unit) => battle.emit('attack', { attacker: unit, targets: [operator], targetDeployments: new Map([[operator, operator.deploySeq]]) });
  const fragments = () => battle.enemies.filter((unit) => unit.alive && unit.defId === 'enemy_2033_syboys');
  const cap = enemy.mem.ab.sk.Summon.bb.limit_amount;
  for (let index = 0; index < cap + 2; index++) { attack(enemy); attack(enemy); attack(enemy); advance(0.1); }
  assert.equal(fragments().length, cap);
  const child = fragments()[0];
  const childCap = child.mem.ab.sk.Summon.bb.limit_amount;
  for (let index = cap; index < childCap + 2; index++) { attack(child); attack(child); attack(child); advance(0.1); }
  assert.equal(fragments().length, childCap, JSON.stringify({
    units: battle.enemies.map((unit) => ({ id: unit.defId, alive: unit.alive, hp: unit.hp, reason: unit.deadReason, born: unit.bornAt })),
    time: battle.time, finished: battle.finished, errors: battle.errorCount,
  }));
  const second = spawn('enemy_2032_syboy2');
  const threshold = second.mem.ab.t['SummonMark.damage_counter'];
  for (let index = 0; index < threshold - 1; index++) hit(second, 1);
  let createdAfterFatal = 0;
  battle.on('enemySpawn', ({ enemy: unit }) => { if (unit.defId === 'enemy_2033_syboys') createdAfterFatal++; });
  hit(second, second.s.maxHp * 2); advance(0.1);
  assert.equal(createdAfterFatal, 0);
  assert.ok(fragments().length === 0);
  assert.equal(battle.errorCount, 0);
});

test('native pathmaker fragment lifetime expires at source duration', (t) => {
  const { battle, spawn, advance } = fixture(t);
  // Keep the run alive while checking the native 90-second fragment lifetime.
  spawn('enemy_2031_syboy');
  const child = spawn('enemy_2033_syboys');
  const lifetime = child.mem.ab.t['Suicide.duration'];
  advance(lifetime - 0.2); assert.equal(child.alive, true);
  advance(0.3); assert.equal(child.alive, false);
  assert.equal(battle.errorCount, 0);
});

test('original tears block SP on occupation and deal the contact target own ATK as true damage', (t) => {
  const { battle, spawn, advance, operator } = fixture(t);
  const boss = spawn('enemy_2039_syskad', [operator.y + 2, operator.x + 2]);
  const free = spawn('enemy_2040_syrott', [operator.y + 1, operator.x + 1]);
  const occupied = spawn('enemy_2040_syrott');
  free.mem.mizukiSummonHostId = boss.id; occupied.mem.mizukiSummonHostId = boss.id;
  battle.removeBuff(operator, 'test:hold');
  battle.addBuff(operator, { key: 'test:disarm', persist: true, flags: { disarm: true } });
  const hits = []; battle.on('damaged', (c) => { if (c.source === occupied && c.target === operator) hits.push(c); });
  advance(3.2);
  assert.ok(boss.mem.mizukiIsha.sp.value >= 28 && boss.mem.mizukiIsha.sp.value < 29);
  assert.equal(hits.length, 1); assert.equal(hits[0].dmg.type, 'true');
  assert.equal(hits[0].amount, operator.s.atk * occupied.mem.ab.t['Damage.atk_scale']);
  assert.equal(battle.errorCount, 0);
});

test('Isha heals three original enemies and transforms through tears while preserving human HP across unlimited rebirth', (t) => {
  const { battle, spawn, hit, advance, operator } = fixture(t);
  const boss = spawn('enemy_2039_syskad', [operator.y + 2, operator.x + 2]);
  const victims = Array.from({ length: 4 }, () => spawn('enemy_2021_syfish', [operator.y + 2, operator.x + 2]));
  for (const victim of victims) hit(victim, victim.s.maxHp * 0.5);
  battle.removeBuff(boss, 'test:hold'); battle.addBuff(boss, { key: 'test:walkHold', persist: true, flags: { noMove: true } });
  const before = victims.map((unit) => unit.hp); advance(0.1);
  assert.equal(victims.filter((unit, index) => unit.hp > before[index]).length, 3);
  battle.addBuff(boss, { key: 'test:hold', persist: true, flags: { noMove: true, disarm: true } });
  hit(boss, boss.s.maxHp * 0.2); const savedHp = boss.hp;
  for (let index = 0; index < 5; index++) {
    const tear = spawn('enemy_2040_syrott', [operator.y + 1, operator.x + 1]); tear.mem.mizukiSummonHostId = boss.id;
  }
  advance(3.2);
  assert.equal(boss.mem.mizukiIsha.phase, 'monster'); assert.equal(boss.profile.dmgType, 'true');
  assert.equal(boss.base.rangeRadius, MIZUKI_BOSS_NATIVE_RULES.isha.monsterRadius); assert.equal(boss.profile.maxTargets, 3);
  assert.equal(boss.s.maxHp, boss.def.maxHp * 1.5);
  assert.ok(battle.enemies.filter((unit) => unit.defId === 'enemy_2040_syrott').every((unit) => !unit.alive));
  hit(boss, boss.s.maxHp * 2); assert.equal(boss.mem.mizukiIsha.phase, 'reborn'); assert.equal(boss.alive, true);
  advance(5.2); assert.equal(boss.mem.mizukiIsha.phase, 'human'); assert.equal(boss.hp, savedHp);
  assert.equal(boss.mem.mizukiIsha.sp.value < 1, true);
  for (let index = 0; index < 5; index++) {
    const tear = spawn('enemy_2040_syrott', [operator.y + 1, operator.x + 1]); tear.mem.mizukiSummonHostId = boss.id;
  }
  advance(3.2); assert.equal(boss.mem.mizukiIsha.phase, 'monster');
  hit(boss, boss.s.maxHp * 2); advance(5.2);
  assert.equal(boss.mem.mizukiIsha.phase, 'human'); assert.equal(boss.hp, savedHp);
  hit(boss, boss.s.maxHp * 2); assert.equal(boss.alive, false);
  assert.equal(battle.errorCount, 0);
});

test('native jelly birth delays blocking then transforms once into the level-defined enemy', (t) => {
  const { battle, spawn, advance } = fixture(t);
  const child = spawn('enemy_2041_syjely'); const spawned = [];
  battle.on('enemySpawn', ({ enemy }) => { if (enemy.defId === child.mem.ab.tS['Combat.enemy_key']) spawned.push(enemy); });
  advance(0.8); assert.equal(child.alive, true); assert.equal(spawned.length, 0);
  advance(0.5); assert.equal(child.alive, false); assert.equal(spawned.length, 1);
  assert.equal(spawned[0]._officialDontBlockWave, true);
  assert.equal(battle.errorCount, 0);
});

function izumikFixture(t) {
  const f = fixture(t, 'ro2_b_7');
  f.advance(0.1);
  const boss = f.battle.enemies.find((unit) => unit.defId === 'enemy_2042_syboss');
  assert.ok(boss?.mem.mizukiIzumik, 'actual original wave must spawn the boss');
  return { ...f, boss, waves: f.battle._officialWaves };
}

test('original Izumik feeding form follows its real route rather than a permanent no-move substitute', (t) => {
  const { boss, battle, advance } = izumikFixture(t);
  const start = { x: boss.x, y: boss.y };
  battle.removeBuff(boss, 'test:hold');
  assert.equal(!!boss.s.flags.noMove, false);
  advance(20); assert.ok(boss.x !== start.x || boss.y !== start.y);
  assert.equal(boss.mem.mizukiIzumik.phase, 'feeding');
  assert.equal(battle.errorCount, 0);
});

test('original Izumik starts at 60 percent HP and 117 SP, summons one real extra branch at 3 seconds and locks SP for the source animation', (t) => {
  const { boss, battle, waves, advance, hit } = izumikFixture(t);
  const a = boss.mem.mizukiIzumik;
  assert.equal(boss.hpRatio, 0.6); assert.equal(boss.s.flags.invulnerable, true);
  assert.ok(a.sp.value >= 117 && a.sp.value < 118);
  hit(boss, boss.s.maxHp); assert.equal(boss.hpRatio, 0.6);
  advance(2.8); assert.equal(waves.branchCalls.length, 0);
  advance(0.2);
  const first = waves.branchCalls[0];
  assert.equal(first.key, 'syboss_extra'); assert.ok(Math.abs(first.time - 3) < battle.dt + 1e-9);
  assert.equal(first.blockGameFinish, false);
  assert.equal(first.scheduledCount, izumikLevel.branches.syboss_extra.phases[first.phaseIndex].actions
    .filter((x) => x.actionType === 'SPAWN').reduce((n, x) => n + x.count, 0));
  assert.ok(a.extraUntil > battle.time); assert.ok(a.sp.value < 1e-8);
  advance(1.8); assert.ok(a.sp.value < 1e-8); assert.equal(a.extraCasts, 0);
  advance(0.5); assert.equal(a.extraCasts, 1); assert.ok(a.sp.value > 0);
  assert.equal(battle.errorCount, 0);
});

test('Izumik devours original jelly variants in groups of five then releases the source wave and recovers for fifteen seconds', (t) => {
  const { boss, battle, waves, spawn, advance } = izumikFixture(t);
  const a = boss.mem.mizukiIzumik, baseAtk = boss.s.atk;
  const children = [];
  for (let index = 0; index < 15; index++) children.push(spawn(index % 2 ? 'enemy_2041_syjely_e' : 'enemy_2041_syjely_f', [boss.y, boss.x]));
  advance(1.2);
  assert.ok(children.every((unit) => !unit.alive)); assert.equal(a.stacks, 3);
  assert.ok(Math.abs(boss.s.atk - baseAtk * 2.2) < 1e-7); assert.equal(boss.hp, boss.s.maxHp);
  assert.equal(a.phase, 'recovering'); assert.equal(waves.waveReleases.length, 1);
  assert.equal(waves.waveReleases[0].sourceId, boss.id); assert.equal(a.extraUntil, undefined);
  assert.equal(boss.s.flags.invulnerable, true);
  const sp = a.sp.value; advance(14.7); assert.equal(a.phase, 'recovering'); assert.equal(a.sp.value, sp);
  advance(0.5); assert.equal(a.phase, 'fighting'); assert.equal(!!boss.s.flags.invulnerable, false);
  assert.equal(boss.profile.noAttack, false); assert.equal(boss.base.rangeRadius, MIZUKI_BOSS_NATIVE_RULES.izumik.attackRadius);
  assert.equal(battle.errorCount, 0);
});

test('Izumik original periodic branch stages start at native boundaries and choose one unused phase per loop', (t) => {
  const { boss, battle, waves, advance } = izumikFixture(t);
  const a = boss.mem.mizukiIzumik;
  advance(279); assert.equal(a.phase, 'feeding');
  const periodic = waves.branchCalls.filter((x) => x.key !== 'syboss_extra');
  const first = (key) => periodic.find((x) => x.key === key);
  for (const [key, at] of [['syboss_jely1', 20], ['syboss_jely2', 86], ['syboss_jely3', 169], ['syboss_jely4', 278]]) {
    assert.ok(first(key), key); assert.ok(Math.abs(first(key).time - at) <= battle.dt + 1e-9, JSON.stringify(first(key)));
  }
  for (const key of ['syboss_jely1', 'syboss_jely2', 'syboss_jely3', 'syboss_jely4']) {
    const selected = periodic.filter((x) => x.key === key), count = izumikLevel.branches[key].phases.length;
    assert.equal(new Set(selected.slice(0, count).map((x) => x.phaseIndex)).size, Math.min(count, selected.length));
    assert.ok(selected.every((x) => !x.blockGameFinish));
  }
  assert.equal(battle.errorCount, 0);
});

test('Izumik fourth completed source summon changes form without ten second fallback or stale casting state', (t) => {
  const { boss, battle, waves, advance } = izumikFixture(t);
  const a = boss.mem.mizukiIzumik;
  // Keep the original feeding route isolated from the child attacks. Source
  // branches, skill SP and the animation clock continue through real schedules.
  battle.on('enemySpawn', ({ enemy }) => { if (enemy !== boss) battle.kill(enemy, null); });
  advance(370); assert.equal(a.phase, 'feeding'); assert.equal(a.extraCasts, 3);
  advance(3); assert.equal(a.phase, 'recovering'); assert.equal(a.extraCasts, 4);
  assert.equal(waves.branchCalls.filter((x) => x.key === 'syboss_extra').length, 4);
  assert.equal(a.extraUntil, undefined);
  advance(15.2); assert.equal(a.phase, 'fighting'); assert.ok(a.sp.value > 0);
  assert.equal(battle.errorCount, 0);
});

test('Izumik second form keeps source physical plus arts attacks, three one-time HP rages, and one-second stun damage', (t) => {
  const { boss, operator, battle, hit, advance } = izumikFixture(t);
  const a = boss.mem.mizukiIzumik;
  battle.heal(boss, boss, boss.s.maxHp, { self: true }); advance(15.2);
  assert.equal(a.phase, 'fighting');
  const casts = [];
  const ev = battle._ev.bind(battle);
  battle._ev = (x) => { if (x[0] === 'cast' && x[1] === boss.id) casts.push(x); ev(x); };
  battle.removeBuff(operator, 'test:hold');
  battle.addBuff(operator, { key: 'test:healthy', persist: true, mods: { hpPct: 100 }, flags: { disarm: true } });
  operator.hp = operator.s.maxHp;
  const hits = []; battle.on('damaged', (c) => { if (c.source === boss && c.target === operator) hits.push(c); });
  a.sp.value = 0; hit(boss, boss.s.maxHp * 0.26);
  assert.equal(a.rage.size, 1); assert.equal(operator.s.flags.stun, true);
  advance(0.8); assert.equal(hits.length, 0);
  advance(0.4); assert.equal(hits.length, 1);
  assert.equal(hits[0].dmg.type, 'arts'); assert.equal(hits[0].dmg.amount, boss.s.atk * boss.mem.ab.sk.StunAOE.bb.atk_scale);
  assert.equal(a.sp.value, 0);
  advance(2.2); assert.ok(a.sp.value > 0);
  hit(boss, boss.s.maxHp * 0.25); hit(boss, boss.s.maxHp * 0.25);
  assert.equal(a.rage.size, 3); hit(boss, 1); assert.equal(a.rage.size, 3);
  assert.equal(casts.filter((x) => x[2] === boss.mem.ab.sk.StunAOE.slot).length, 3);
  advance(8.2); const before = hits.length;
  battle.dealDamage(boss, operator, { amount: boss.s.atk, type: 'phys', canDodge: false, isAttack: true });
  assert.equal(hits.length, before + 2); assert.deepEqual(hits.slice(-2).map((x) => x.dmg.type).sort(), ['arts', 'phys']);
  assert.equal(battle.errorCount, 0);
});
