import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiAutoCombat } from '../server/modes/mizuki/Combat.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { canTargetEnemy } from '../server/sim/targeting.js';
import { UF } from '../shared/constants.js';

const source = createMizukiCatalog(getData()).source;
function create(t, layers = 300) {
  const c = new MizukiAutoCombat({ seed: 7, data: source,
    stage: { id: 'mizuki_redeploy_hover', rows: Array(19).fill('r'.repeat(21)) },
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, timeLimit: 180,
    spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }],
    flags: { dpInit: 0, dpPerSec: 0, dpMax: 99 },
    players: [{ playerId: 'p1', layers: { indomShip: layers }, units: [
      { uid: 101, chessId: 'chess_char_1_05_a', row: 9, col: 4 },
      { uid: 102, chessId: 'chess_char_1_20_a', row: 9, col: 6 },
    ] }],
  });
  t.after(() => c.forceEnd()); c.step();
  return { c, b: c.battle, ps: c.battle.getPlayer('p1'), u: c.battle.getPlayer('p1').units[0] };
}
const flying = (c, u) => !!(c.snapshot().units.find((s) => s[0] === u.id)?.[7] & UF.FLYING);

test('production Mizuki 不屈 deploys at zero DP after every guaranteed lethal hit', (t) => {
  const { b, ps, u } = create(t); b.rng = () => .999999;
  assert.ok(u.base.cost > ps.dp);
  for (let i = 0; i < 3; i++) {
    const seq = u.deploySeq; b.kill(u);
    assert.ok(u.alive && u.deployed && u.hp === u.s.maxHp);
    assert.ok(u.deploySeq > seq); assert.equal(ps.dp, 0);
    assert.equal(u.mem.indomFreeDeploy, false);
    assert.equal(b.unitAt(u.tileR, u.tileC), u);
  }
  assert.equal(b.errorCount, 0);
});

test('production Mizuki 不屈 retains a free retry while its landing tile is occupied', (t) => {
  const { b, ps, u } = create(t); b.rng = () => .999999;
  const blocker = ps.units[1], key = u.tileR * 21 + u.tileC;
  // Inject a transient occupation during death callbacks, before the immediate revival attempts the tile.
  b.on('death', ({ unit }) => { if (unit === u) b._occ[key] = blocker; }, { priority: 20 });
  b.kill(u);
  assert.equal(u.alive, false); assert.equal(u.mem.indomFreeDeploy, true);
  b._checkRedeploys();
  assert.equal(u.alive, false); assert.equal(ps.dp, 0);
  assert.equal(u.mem.indomFreeDeploy, true);
  b._occ[key] = null; b._checkRedeploys();
  assert.ok(u.alive && u.deployed); assert.equal(ps.dp, 0);
  assert.equal(u.mem.indomFreeDeploy, false); assert.equal(b.unitAt(u.tileR, u.tileC), u);
  assert.equal(b.errorCount, 0);
});

test('production Mizuki ordinary redeployment still waits for and charges its DP cost', (t) => {
  const { b, ps, u } = create(t, 0); b.rng = () => .999999; b.kill(u);
  assert.equal(u.alive, false); assert.equal(!!u.mem.indomFreeDeploy, false);
  u.respawnAt = b.time;
  ps.dp = Math.max(0, u.base.cost - 1); b._checkRedeploys();
  assert.equal(u.alive, false); assert.equal(ps.dp, u.base.cost - 1);
  ps.dp = u.base.cost; b._checkRedeploys();
  assert.ok(u.alive && u.deployed); assert.equal(ps.dp, 0); assert.equal(b.errorCount, 0);
});

test('production Mizuki 掠海漂移体 publishes flight then permanent ground state after stun', (t) => {
  const { c, b, u } = create(t), e = b.spawnEnemy('enemy_2025_syufo');
  assert.equal(e.motion, 'WALK'); assert.equal(e.isFlying, true); assert.equal(flying(c, e), true);
  assert.equal(canTargetEnemy(u, e, { groundOnly: true }), false);
  b.applyStatus(e, 'stun', { duration: 3 });
  assert.equal(e.isFlying, false); assert.equal(flying(c, e), false);
  assert.equal(e.form, 'crawl'); assert.equal(e.profile.melee, true);
  assert.equal(!!e.s.flags.unblockable, false);
  assert.equal(canTargetEnemy(u, e, { groundOnly: true }), true);
  b.removeBuff(e, 'stun'); b.emit('tick', { dt: .05 });
  assert.equal(e.isFlying, false); assert.equal(flying(c, e), false);
  assert.equal(b.errorCount, 0);
});

test('production Mizuki snapshot follows dynamic groundbind on static FLY enemies', (t) => {
  const { c, b } = create(t);
  const e = b.spawnEnemy('test:dynamic_fly', { pos: [9, 5], countInTotal: false,
    def: { key: 'test:dynamic_fly', name: 'flyer', motion: 'FLY', stats: {
      maxHp: 10000, atk: 0, def: 0, res: 0, rangeRadius: 0, moveSpeed: 0, baseAttackTime: 99,
    } }, route: { motion: 'FLY', start: [9, 5], end: [9, 5], checkpoints: [] } });
  assert.equal(e.motion, 'FLY'); assert.equal(flying(c, e), true);
  b.applyStatus(e, 'groundbind', { duration: 3 });
  assert.equal(e.isFlying, false); assert.equal(flying(c, e), false);
  b.removeBuff(e, 'groundbind');
  assert.equal(e.isFlying, true); assert.equal(flying(c, e), true);
  assert.equal(b.errorCount, 0);
});
