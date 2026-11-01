import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { createOfficialMizukiStage, resolveOfficialEnemy } from '../server/modes/mizuki/official-stages.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { normalizeEnemy } from '../server/sim/simdata.js';
import { abOf } from '../server/sim/content/enemies.js';
import { attackStand, attackWindup } from '../server/sim/ai.js';

function create() {
  const catalog = createMizukiCatalog(getData());
  const options = createOfficialMizukiStage('ro2_n_1_1', { data: catalog.source });
  const data = Object.create(options.data), id = 'enemy_1059_buster_2';
  data.getEnemy = (key) => {
    if (key !== id) return options.data.getEnemy(key);
    const s = resolveOfficialEnemy({ id, level: 0, useDb: true });
    const bb = (items = []) => ({ bb: Object.fromEntries(items.filter((v) => typeof v.value === 'number')
      .map((v) => [v.key, v.value])) });
    return normalizeEnemy(id, { key: id, name: s.name, spine: s.prefabKey, applyWay: s.applyWay,
      stats: { ...s.attributes, res: s.attributes.magicResistance, rangeRadius: s.rangeRadius,
        motion: s.motion, lpr: s.lifePointReduce }, talents: bb(s.talentBlackboard ?? []),
      skills: (s.skills ?? []).map((v) => ({ ...v, ...bb(v.blackboard ?? []) })) });
  };
  const c = new MizukiCombat({ ...options, data, seed: 7, content: 'full',
    players: [{ playerId: 'p1', units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] }],
    flags: { dpInit: 999, dpMax: 999 } });
  const tiles = c.snapshot().geometry.tiles.filter((v) => c.battle.grid.canStand(v.row, v.col, { ranged: false })
    && !v.obstacle);
  assert.equal(c.command('p1', { type: 'deploy', uid: 101, row: tiles[0].row, col: tiles[0].col, dir: 'RIGHT' }).ok, true);
  const b = c.battle, u = b.getPlayer('p1').units[0];
  const e = b.spawnEnemy(id);
  assert.equal(abOf(b, e).list.length, 2);
  const tile = tiles[1];
  const farm = b.spawnDevice('trap_008_farm', tile.row, tile.col, { hp: 100000, def: 200, blockCnt: 0 });
  farm._mizukiSourceCategory = 1; farm.tags.add('building');
  farm.base.tauntLevel = 0; farm.markDirty();
  e.x = (u.x + farm.x) / 2; e.y = (u.y + farm.y) / 2;
  return { c, b, e, u, farm };
}
const tick = (b, e, left) => { e.atkCd = left; b.emit('tick', { dt: 1 / 30 }); };
const takeHit = (b, e, u) => {
  const hp = u.hp; b.dealDamage(e, u, { amount: e.s.atk, type: 'phys', isAttack: true, canDodge: false });
  return hp - u.hp;
};

test('native buster uses original fixed collider radius and only ON_ATTACK hit time without adding prefab preDelay', () => {
  const { b, e, u, farm } = create();
  assert.equal(e.base.rangeRadius, 2.0999999046325684);
  assert.deepEqual(e.def.attackAnim, { dur: 2.7, hit: 1.433 });
  assert.equal(attackWindup(e), 1.433); assert.equal(attackStand(e).rest, 2.7 - 1.433);
  tick(b, e, 0);
  assert.equal(e.swingTargets[0], farm);
  assert.equal(e.atkCd, 1.433);
  const hp = farm.hp, opHp = u.hp;
  b.time = 1.432; tick(b, e, .001); assert.equal(farm.hp, hp);
  b.time = 1.433; tick(b, e, 0);
  assert.ok(Math.abs(hp - farm.hp - Math.max(e.s.atk * 1.8 - farm.s.def, e.s.atk * 1.8 * .05)) < 1e-8);
  assert.equal(u.hp, opHp); assert.equal(e.stats.attacks, 1);
  assert.equal(b.projectiles.list.length, 0);
  assert.equal(e.findBuff('mizuki:buster:windup'), null);
  const fx = b.drainEvents().filter((v) => v[0] === 'fx' && v[1] === 'mizuki:effect').map((v) => v[4].key);
  assert.ok(fx.includes('demonk_attack_01_start')); assert.ok(fx.includes('demonk_attack_01_hit'));
  assert.equal(b.errorCount, 0);
});

test('native buster respects original DEFAULT category and prioritizes its blocker over other buildings', () => {
  for (const blocked of [false, true]) {
    const { b, e, u, farm } = create();
    if (blocked) e.blockedBy = u; else farm._mizukiSourceCategory = 2;
    tick(b, e, 0); assert.equal(e.swingTargets[0], u);
    assert.equal(b.errorCount, 0);
  }
});

test('native buster building talent scales ATK before DEF and silence disables only that original talent', () => {
  const { b, e, u, farm } = create();
  assert.equal(abOf(b, e).t['atkup.atk_scale'], 1.8);
  const expected = Math.max(e.s.atk * 1.8 - farm.s.def, e.s.atk * 1.8 * .05);
  assert.ok(Math.abs(takeHit(b, e, farm) - expected) < 1e-8);
  b.applyStatus(e, 'silence', { duration: 10 });
  const normal = Math.max(e.s.atk - farm.s.def, e.s.atk * .05);
  assert.ok(Math.abs(takeHit(b, e, farm) - normal) < 1e-8);
  assert.ok(Math.abs(takeHit(b, e, u) - Math.max(e.s.atk - u.s.def, e.s.atk * .05)) < 1e-8);
  tick(b, e, 0); assert.equal(e.swingTargets[0], farm);
  assert.equal(b.errorCount, 0);
});

test('native buster original final taunt comparator can override the building partition', () => {
  const { b, e, u } = create();
  b.addBuff(u, { key: 'test:buster:taunt', mods: { taunt: 2 } });
  assert.equal(u.s.taunt, 2);
  tick(b, e, 0); assert.equal(e.swingTargets[0], u);
  assert.equal(b.errorCount, 0);
});

test('native buster stun cuts its windup and a later deployment of the same card is never struck', () => {
  const { b, e, u, farm } = create();
  e.blockedBy = u; tick(b, e, 0);
  b.applyStatus(e, 'stun', { duration: 10 });
  assert.equal(e.swing, false); assert.equal(e.findBuff('mizuki:buster:windup'), null);
  const hp = u.hp; tick(b, e, 0); assert.equal(u.hp, hp);
  b.removeBuff(e, e.buffs.find((v) => v.status === 'stun').key);
  tick(b, e, 0); u.deploySeq++; tick(b, e, 0);
  assert.equal(u.hp, hp); assert.equal(farm.hp, farm.s.maxHp);
  assert.equal(b.errorCount, 0);
});

test('native buster standalone controller coexists with real thirty-Hz movement and shared attack cooldowns', () => {
  const { c, b, e, u, farm } = create();
  u.x = e.x - 1.8; farm.x = e.x + 1.8;
  b.addBuff(u, { key: 'test:buster:noBlock', flags: { noBlock: true } });
  let start = null, hit = null;
  b.on('tick', () => { if (start == null && e.findBuff('mizuki:buster:windup')) start = b.time; });
  b.on('damaged', (ctx) => { if (ctx.source === e && hit == null) hit = { time: b.time, unit: ctx.target }; });
  for (let i = 0; i < 90 && hit == null; i++) c.step();
  assert.ok(start != null); assert.ok(hit != null);
  assert.equal(hit.unit.id, farm.id, JSON.stringify({ blockedBy: e.blockedBy?.id,
    enemy: [e.x, e.y], op: [u.x, u.y], farm: [farm.x, farm.y] }));
  assert.ok(hit.time - start >= 1.433 - 1e-9);
  assert.ok(hit.time - start <= 1.433 + 1 / 30 + 1e-9);
  assert.equal(e.stats.attacks, 1); assert.equal(b.errorCount, 0);
});

test('native buster keeps a locked out-of-range target but excludes an out-of-range building before starting', () => {
  const { b, e, u, farm } = create();
  farm.x = e.x + 10;
  tick(b, e, 0); assert.equal(e.swingTargets[0], u);
  const hp = u.hp; u.x = e.x - 10;
  tick(b, e, 0); assert.ok(u.hp < hp); assert.equal(e.stats.attacks, 1);
  assert.equal(b.errorCount, 0);
});

test('native buster honors shared palsy interrupt without damage or duplicate attack hooks', () => {
  const { b, e, farm } = create();
  tick(b, e, 0); const hp = farm.hp;
  b.addBuff(e, { key: 'palsy', stacks: 1 });
  tick(b, e, 0);
  assert.equal(farm.hp, hp); assert.equal(e.stats.attacks, 0);
  assert.equal(e.findBuff('palsy'), null); assert.equal(e.atkCd, e.s.interval);
  assert.equal(e.findBuff('mizuki:buster:windup'), null); assert.equal(b.errorCount, 0);
});

test('native buster windup cancels on original disabling states including fear, disarm and unbalance', () => {
  for (const state of ['freeze', 'sleep', 'levitate', 'fear', 'disarm', 'tremble', 'unbalance']) {
    const { b, e, farm } = create();
    if (state === 'tremble') e.blockedBy = farm;
    tick(b, e, 0); const hp = farm.hp;
    if (state === 'unbalance') e.unbalanceUntil = b.time + 10;
    else b.addBuff(e, { key: 'test:buster:' + state, flags: { [state]: true } });
    tick(b, e, 0); assert.equal(farm.hp, hp, state);
    assert.equal(e.findBuff('mizuki:buster:windup'), null, state);
    assert.equal(e.stats.attacks, 0, state); assert.equal(b.errorCount, 0);
  }
});
