import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { createOfficialMizukiStage, resolveOfficialEnemy } from '../server/modes/mizuki/official-stages.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { normalizeEnemy } from '../server/sim/simdata.js';
import { abOf } from '../server/sim/content/enemies.js';

function create(id = 'enemy_1271_nhkodo') {
  const catalog = createMizukiCatalog(getData());
  const options = createOfficialMizukiStage('ro2_n_1_1', { data: catalog.source });
  const data = Object.create(options.data);
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
  const tile = c.snapshot().geometry.tiles.find((v) => c.battle.grid.canStand(v.row, v.col, { ranged: false })
    && !v.obstacle);
  const deploy = () => c.command('p1', { type: 'deploy', uid: 101, row: tile.row, col: tile.col, dir: 'RIGHT' });
  assert.equal(deploy().ok, true);
  return { c, b: c.battle, u: c.battle.getPlayer('p1').units[0], deploy };
}

test('native registered devour locks player commands and death-hook revivals and releases its card ready', () => {
  for (const reason of ['killed', 'leak', 'expired']) {
    const { c, b, u, deploy } = create();
    const e = b.spawnEnemy('enemy_1271_nhkodo');
    assert.equal(abOf(b, e).list.length, 1);
    e.x = u.x + .5; e.y = u.y;
    let revival = null;
    b.on('death', ({ unit }) => { if (unit === u) revival = b.redeploy(unit, { free: true }); });
    b.emit('tick', { dt: 1 / 30 });
    assert.ok(c.snapshot().officialEnemyEffects.some((v) => v.key === 'enemy_nhkodo_attack_01_start'));
    b.time = .833; b._runScheduled();
    assert.equal(revival, false); assert.equal(u.alive, false);
    assert.equal(c.snapshot().meta.units.find((unit) => unit.id === e.id).form, 'devoured');
    const locked = c.snapshot().rosters.p1[0];
    assert.equal(locked.disabledReason, 'DEVOUR_LOCKED');
    assert.equal(locked.deployable, false); assert.equal(locked.devouredBy, e.id);
    assert.equal(deploy().error, 'DEVOUR_LOCKED');
    assert.equal(b.redeploy(u, { free: true }), false);
    assert.equal(c.snapshot().officialEnemyEffects.some((v) => v.key === 'enemy_nhkodo_attack_01_start'), false);
    b.time = 10;
    if (reason === 'killed') b.kill(e, null); else b._remove(e, reason);
    const released = c.snapshot().rosters.p1[0];
    assert.equal(released.devouredBy, null); assert.equal(released.deployable, true);
    assert.equal(released.redeployRemaining, 0); assert.equal(u.alive, false);
    assert.equal(deploy().ok, true); assert.equal(b.errorCount, 0);
  }
});

test('native registered rageth variants install one original self-damage ability without shared rager drain', () => {
  for (const id of ['enemy_1063_rageth', 'enemy_1063_rageth_2']) {
    const { b } = create(id), e = b.spawnEnemy(id);
    const hp = e.hp;
    assert.equal(abOf(b, e).list.length, 1);
    b.emit('tick', { dt: 1 });
    assert.equal(hp - e.hp, id.endsWith('_2') ? 350 : 250);
    assert.equal(b.errorCount, 0);
  }
});
