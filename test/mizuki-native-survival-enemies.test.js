import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { createOfficialMizukiStage, resolveOfficialEnemy } from '../server/modes/mizuki/official-stages.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { normalizeEnemy } from '../server/sim/simdata.js';
import { abOf, attach } from '../server/sim/content/enemies.js';
import { attackStand, attackWindup, updateEnemy } from '../server/sim/ai.js';
import { MIZUKI_SURVIVAL_KITS, isNativeDevoured, snapshotNativeSurvivalEffects }
  from '../server/modes/mizuki/native-survival-enemies.js';

const create = () => {
  const catalog = createMizukiCatalog(getData());
  const options = createOfficialMizukiStage('ro2_n_1_1', { data: catalog.source });
  const data = Object.create(options.data);
  data.getEnemy = (id) => {
    if (!MIZUKI_SURVIVAL_KITS[id]) return options.data.getEnemy(id);
    const s = resolveOfficialEnemy({ id, level: 0, useDb: true });
    const bb = (items = []) => ({ bb: Object.fromEntries(items.filter((v) => typeof v.value === 'number')
      .map((v) => [v.key, v.value])) });
    return normalizeEnemy(id, { key: id, name: s.name, spine: s.prefabKey, applyWay: s.applyWay,
      stats: { ...s.attributes, res: s.attributes.magicResistance, rangeRadius: s.rangeRadius,
        motion: s.motion, lpr: s.lifePointReduce }, talents: bb(s.talentBlackboard ?? []),
      skills: (s.skills ?? []).map((v) => ({ ...v, ...bb(v.blackboard ?? []) })) });
  };
  return new MizukiCombat({ ...options, data, seed: 7, content: 'full',
    players: [{ playerId: 'p1', units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] }],
    flags: { dpInit: 999, dpMax: 999 } });
};
const spawnNative = (b, id) => {
  const e = b.spawnEnemy(id), ab = abOf(b, e);
  // This module can be verified before registry integration, and replaces the
  // old shared rager alias when testing the elite variant.
  ab.list = [];
  attach(b, e, MIZUKI_SURVIVAL_KITS[id](ab, e, b));
  return e;
};
const deployed = (c) => {
  const tile = c.snapshot().geometry.tiles.find((v) => c.battle.grid.canStand(v.row, v.col, { ranged: false })
    && !v.obstacle);
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: tile.row, col: tile.col, dir: 'RIGHT' }).ok, true);
  return c.battle.getPlayer('p1').units[0];
};

test('native rageth waits one second then takes exact no-source unmodified periodic damage while controlled', () => {
  for (const id of ['enemy_1063_rageth', 'enemy_1063_rageth_2']) {
    const c = create(), b = c.battle, e = spawnNative(b, id);
    const value = abOf(b, e).t['periodic_damage.damage'];
    assert.equal(value, id.endsWith('_2') ? 350 : 250);
    const damage = [];
    b.on('damaged', (v) => { if (v.target === e) damage.push(v); });
    b.addBuff(e, { key: 'test:survival:damage', mods: { dmgTakenMul: 2 } });
    b.addBuff(e, { key: 'test:survival:shield', shield: 10000 });
    b.applyStatus(e, 'stun', { duration: 10 });
    b.applyStatus(e, 'silence', { duration: 10 });
    const hp = e.hp;
    b.emit('tick', { dt: .99 }); assert.equal(e.hp, hp);
    b.emit('tick', { dt: .01 }); assert.equal(e.hp, hp - value);
    b.emit('tick', { dt: 1 }); assert.equal(e.hp, hp - value * 2);
    assert.equal(damage.length, 2); assert.equal(damage[0].source, null);
    assert.equal(damage[0].dmg.noSp, true); assert.equal(damage[0].dmg.type, 'true');
    assert.equal(damage[0].dmg.tags.includes('hpLoss'), false);
    assert.equal(e.findBuff('test:survival:shield').shield, 10000); assert.equal(b.errorCount, 0);
  }
});

test('native rageth keeps fixed native range and exact original attack timestamps', () => {
  const c = create(), b = c.battle, e = spawnNative(b, 'enemy_1063_rageth');
  assert.equal(e.base.rangeRadius, 2); assert.equal(e.profile.melee, false);
  assert.equal(e.profile.deferHit, true); assert.equal(e.profile.canTarget({ isFlying: true }), false);
  assert.deepEqual(e.def.attackAnim, { dur: 2.5, hit: 1.467 });
  // The established combat engine compresses an overlong animation to BAT.
  assert.ok(Math.abs(attackWindup(e) - 1.467 * .8) < 1e-9);
  assert.ok(Math.abs(attackStand(e).rest - (2.5 - 1.467) * .8) < 1e-9);
  assert.equal(b.errorCount, 0);
});

test('native rageth projectile travels at 18 with current ATK and survives source death', () => {
  const c = create(), b = c.battle, u = deployed(c), e = spawnNative(b, 'enemy_1063_rageth');
  b.addBuff(u, { key: 'test:survival:hp', mods: { hpFlat: 100000 } }); u.hp = u.s.maxHp;
  e.x = u.x - 1.8; e.y = u.y;
  const hp = u.hp;
  b.emit('attack', { attacker: e, targets: [u], targetDeployments: new Map([[u, u.deploySeq]]), isSkill: false });
  assert.equal(b.projectiles.list.length, 1);
  const p = b.projectiles.list[0]; assert.equal(p.speed, 18); assert.equal(p.maxAge, 10);
  b.projectiles.update(.09); assert.equal(u.hp, hp);
  b.addBuff(e, { key: 'test:survival:atk', mods: { atkFlat: 300 } });
  const expected = Math.max(e.s.atk - u.s.def, e.s.atk * .05);
  b.kill(e, null); b.projectiles.update(.011);
  assert.ok(Math.abs(hp - u.hp - expected) < 1e-8);
  const events = b.drainEvents().filter((v) => v[0] === 'fx' && v[1] === 'mizuki:effect');
  assert.ok(events.some((v) => v[4].key === 'rageth_attack_01_trail'));
  assert.ok(events.some((v) => v[4].key === 'rageth_attack_01_hit'));
  assert.equal(b.errorCount, 0);
});

test('native nhkodo consumes at original skill hit, locks its card and gains original S1 attributes once', () => {
  const c = create(), b = c.battle, u = deployed(c), e = spawnNative(b, 'enemy_1271_nhkodo');
  e.x = u.x + .5; e.y = u.y;
  b.addBuff(u, { key: 'test:devour:targetFree', flags: { stealth: true, untargetable: true, invulnerable: true } });
  b.emit('tick', { dt: 1 / 30 });
  assert.equal(e.profile.noAttack, true); assert.equal(u.alive, true);
  assert.equal(snapshotNativeSurvivalEffects(b).length, 1);
  assert.equal(snapshotNativeSurvivalEffects(b)[0].key, 'enemy_nhkodo_attack_01_start');
  b.time = .832; b._runScheduled(); assert.equal(u.alive, true);
  b.time = .833; b._runScheduled();
  assert.equal(u.alive, false); assert.equal(isNativeDevoured(u), true);
  assert.equal(u.mem.mizukiDevouredBy, e.id); assert.equal(u.respawnAt, -1);
  assert.equal(e.form, 'devoured'); assert.equal(e.s.def, e.base.def + 700);
  assert.ok(Math.abs(e.s.moveSpeed - e.base.moveSpeed * .7) < 1e-9);
  assert.equal(e.profile.noAttack, false); assert.equal(snapshotNativeSurvivalEffects(b).length, 0);
  assert.deepEqual(e.def.attackAnim, { dur: 1.5, hit: .833 });
  assert.equal(abOf(b, e).list[0].done, true); assert.equal(b.errorCount, 0);
});

test('native nhkodo returns swallowed operator ready on death or reaching exit without reviving it on field', () => {
  for (const reason of ['killed', 'leak', 'expired']) {
    const c = create(), b = c.battle, u = deployed(c), e = spawnNative(b, 'enemy_1271_nhkodo');
    e.x = u.x + .5; e.y = u.y;
    b.emit('tick', { dt: 1 / 30 }); b.time = .833; b._runScheduled();
    assert.equal(isNativeDevoured(u), true);
    b.time = 10;
    if (reason === 'killed') b.kill(e, null); else b._remove(e, reason);
    assert.equal(isNativeDevoured(u), false); assert.equal(u.respawnAt, 10);
    assert.equal(u.alive, false); assert.equal(u.deployed, false);
    assert.equal(b.errorCount, 0);
  }
});

test('native nhkodo S1 starts its effect at the real swing and hits only at the attack frame', () => {
  const c = create(), b = c.battle, u = deployed(c), e = spawnNative(b, 'enemy_1271_nhkodo');
  // Other cases verify the transition itself. Start this attack case in S1.
  abOf(b, e).list[0].done = true; e.form = 'devoured';
  e.x = u.x + .5; e.y = u.y; e.blockedBy = u; e.atkCd = 0;
  b.addBuff(u, { key: 'test:devour:attack-hp', mods: { hpFlat: 100000 } }); u.hp = u.s.maxHp;
  b.drainEvents();
  const effects = () => b.drainEvents().filter((v) => v[0] === 'fx' && v[1] === 'mizuki:effect')
    .map((v) => v[4].key);
  const hp = u.hp;
  updateEnemy(b, e, b.dt); b.emit('tick', { dt: b.dt });
  assert.equal(e.swing, true); assert.equal(u.hp, hp);
  assert.deepEqual(effects(), ['enemy_nhkodo_attack_02_start']);
  b.emit('tick', { dt: b.dt }); assert.deepEqual(effects(), []);
  updateEnemy(b, e, attackWindup(e)); b.emit('tick', { dt: b.dt });
  assert.ok(u.hp < hp); assert.equal(e.swing, false);
  assert.deepEqual(effects(), ['enemy_nhkodo_attack_02_hit']);
  e.atkCd = 0; updateEnemy(b, e, b.dt); b.emit('tick', { dt: b.dt });
  assert.deepEqual(effects(), ['enemy_nhkodo_attack_02_start']);
  assert.equal(b.errorCount, 0);
});

test('native nhkodo devour interrupted by control does not kill the target and can retry', () => {
  const c = create(), b = c.battle, u = deployed(c), e = spawnNative(b, 'enemy_1271_nhkodo');
  e.x = u.x + .5; e.y = u.y;
  b.emit('tick', { dt: 1 / 30 }); b.time = .4;
  b.applyStatus(e, 'stun', { duration: 10 });
  assert.equal(e.profile.noAttack, false); assert.equal(snapshotNativeSurvivalEffects(b).length, 0);
  b.time = .833; b._runScheduled(); assert.equal(u.alive, true);
  assert.equal(isNativeDevoured(u), false); assert.equal(e.form, null);
  const a = abOf(b, e).list[0]; assert.equal(!!a.done, false);
  b.removeBuff(e, e.buffs.find((v) => v.status === 'stun').key);
  b.emit('tick', { dt: 1 / 30 });
  assert.equal(snapshotNativeSurvivalEffects(b).length, 1);
  b.time += .833; b._runScheduled(); assert.equal(isNativeDevoured(u), true);
  assert.equal(b.errorCount, 0);
});

test('native nhkodo excludes DEVOUR_IMMU and never consumes a different deployment of its selected card', () => {
  const c = create(), b = c.battle, u = deployed(c), e = spawnNative(b, 'enemy_1271_nhkodo');
  e.x = u.x + .5; e.y = u.y;
  u.filterTags = new Set(['DEVOUR_IMMU']); b.emit('tick', { dt: 1 / 30 });
  assert.equal(snapshotNativeSurvivalEffects(b).length, 0);
  u.filterTags.clear(); b.emit('tick', { dt: 1 / 30 });
  assert.equal(snapshotNativeSurvivalEffects(b).length, 1);
  u.deploySeq++;
  b.time = .833; b._runScheduled();
  assert.equal(u.alive, true); assert.equal(isNativeDevoured(u), false);
  assert.equal(snapshotNativeSurvivalEffects(b).length, 0); assert.equal(b.errorCount, 0);
});
