import { remainingRoute, spawnChildren } from '../../sim/content/enemies.js';
import { COLS } from '../../sim/constants.js';

// Native Nodes.SummonEnemiesFollowMyRoute::Execute (0x181086ac0) reads
// enemy_key/cnt/offset_bound/delay from the ability BB. Delay is shared by all
// children; an additional random delay is used only when its explicit flag is on.
export function summonNativeEnemies(battle, host, enemyKey, options = {}) {
  if (!battle.data.getEnemy(enemyKey)) throw new RangeError('Missing original summoned enemy: ' + enemyKey);
  const spawned = [], scheduled = [];
  const route = options.route ?? remainingRoute(host);
  const point = options.pos ?? [host.y, host.x];
  let [row, col] = point;
  const flying = route.motion === 'FLY';
  const passable = (r, c) => flying ? battle.grid.flyPassable(r, c) : battle.grid.groundPassable(r, c);
  if (options.tryOutside && !passable(Math.round(row), Math.round(col))) {
    // Native LitePhysicsUtil.FindNearestPassableTile scans map rows then columns
    // and keeps the first minimum. Native top-first rows are reversed in this sim.
    let distance = Infinity, nearest = null;
    for (let r = battle.rect.r1; r >= battle.rect.r0; r--) for (let c = battle.rect.c0; c <= battle.rect.c1; c++) {
      if (!passable(r, c)) continue;
      const d = (r - row) ** 2 + (c - col) ** 2;
      if (d < distance) { distance = d; nearest = [r, c]; }
    }
    if (!nearest) throw new RangeError('No native passable summon position: ' + enemyKey);
    [row, col] = nearest;
  }
  const next = route.steps?.find((p) => p.t === 'move')?.p ?? route.end;
  const reachable = (r, c) => {
    const rr = Math.round(r), cc = Math.round(c);
    if (!passable(rr, cc)) return false;
    if (flying || !next) return true;
    const f = battle.grid.flowField(Math.round(next[0]), Math.round(next[1]));
    return f.dist[rr * COLS + cc] >= 0;
  };
  const release = () => {
    if (options.stopHostDead && !host.alive) return;
    const bound = Math.max(0, Number(options.offsetBound) || 0);
    // Scheduler coroutine d__129 (0x1808f48f0) samples both independent axes,
    // and commits the offset only when Route.CheckReachable succeeds.
    const x = col + (battle.rng() * 2 - 1) * bound;
    const y = row + (battle.rng() * 2 - 1) * bound;
    const pos = reachable(y, x) ? [y, x] : [row, col];
    const child = spawnChildren(battle, host, enemyKey, 1, { route, pos,
      ...(options.countInTotal != null ? { countInTotal: options.countInTotal } : {}), tag: options.tag })[0];
    if (!child) throw new Error('Original enemy summon failed: ' + enemyKey);
    child._officialDontBlockWave = !!options.dontBlockWave;
    spawned.push(child);
    options.onSpawn?.(child);
  };
  const count = Math.max(0, Math.floor(Number(options.count ?? 1)));
  for (let i = 0; i < count; i++) {
    const delay = Math.max(0, Number(options.delay) || 0)
      + (options.useRandomDelay ? battle.rng() * Math.max(0, Number(options.randomDelayRange) || 0) : 0);
    if (delay <= 0) { release(); continue; }
    const timer = battle.after(delay, () => {
      battle._officialSummonHolds?.delete(timer); release();
    }, { holdsBattle: !options.dontBlockWave });
    if (!options.dontBlockWave) (battle._officialSummonHolds ??= new Set()).add(timer);
    scheduled.push(timer);
  }
  return { spawned, scheduled };
}
