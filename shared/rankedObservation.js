// 排位旁观统计：只读原版事件及累计伤害，不写单位、HP、技能、随机数或战斗结果。
const observations = new WeakMap();
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e13;
const leakKey = (x) => `${x.enemyKey ?? x.defId}|${x.sourcePlayerId ?? x.ownerId ?? ''}|${x.tag ?? ''}`;
export function validRankedObservation(v) {
  return v && v.version === 1 && v.perPlayer && typeof v.perPlayer === 'object' && !Array.isArray(v.perPlayer)
    && Object.keys(v.perPlayer).length <= 4 && Object.entries(v.perPlayer).every(([id, p]) =>
      /^[A-Za-z0-9_:-]{1,64}$/.test(id) && p && finite(p.rankedDamage) && finite(p.leaderLpLoss))
    && Array.isArray(v.leaks) && v.leaks.length <= 400 && v.leaks.every((l) => l && typeof l.enemyKey === 'string'
      && l.enemyKey.length <= 64 && (l.sourcePlayerId == null || (typeof l.sourcePlayerId === 'string' && l.sourcePlayerId.length <= 64))
      && (l.tag == null || (typeof l.tag === 'string' && l.tag.length <= 16)) && finite(l.ratio) && l.ratio <= 1);
}
export function observeRankedBattle(battle, { leakBudgets = [] } = {}) {
  if (!battle?.on || observations.has(battle)) return observations.get(battle);
  const out = { version: 1, perPlayer: {}, leaks: [] };
  for (const p of battle.players || []) out.perPlayer[p.playerId] = { rankedDamage: 0, leaderLpLoss: 0 };
  const states = new WeakMap();
  const budgets = new Map();
  for (const l of leakBudgets) {
    const key = leakKey(l), queue = budgets.get(key) || [];
    queue.push(l.ratio); budgets.set(key, queue);
  }
  const init = (e) => {
    if (!e || e.side !== 'enemy' || states.has(e)) return states.get(e);
    const ratio = battle.kind === 'unite' ? (budgets.get(leakKey(e))?.shift() ?? 0) : 1;
    const state = { remaining: Math.max(0, Number(e.s?.maxHp) || 0) * ratio, taken: Number(e.stats?.taken) || 0 };
    states.set(e, state); return state;
  };
  const options = { priority: Number.MAX_SAFE_INTEGER, owner: out };
  battle.on('deploy', ({ unit }) => { init(unit); }, options);
  battle.on('enemySpawn', ({ enemy }) => { init(enemy); }, options);
  battle.on('damaged', ({ target, source, credit }) => {
    const st = init(target);
    if (!st) return;
    const taken = Number(target.stats?.taken) || 0;
    const dealt = Math.max(0, taken - st.taken); st.taken = taken;
    const actor = credit || source;
    if (target.bossPool || actor?.side !== 'ally' || actor.ownerId == null || !(dealt > 0)) return;
    const pp = out.perPlayer[actor.ownerId];
    if (!pp) return;
    const n = Math.min(dealt, st.remaining); st.remaining -= n; pp.rankedDamage += n;
  }, options);
  const recordLeak = (enemy) => {
    const st = init(enemy);
    if (!st || (enemy.counted === false && !enemy.isBoss) || out.leaks.length >= 400) return;
    out.leaks.push({ enemyKey: enemy.defId, sourcePlayerId: enemy.sourcePlayerId ?? enemy.ownerId ?? null,
      tag: enemy.tag ?? null, ratio: Math.max(0, Math.min(1, st.remaining / Math.max(1, enemy.s.maxHp))) });
  };
  battle.on('enemyLeak', ({ enemy }) => recordLeak(enemy), options);
  // 原版超时直接 _recordLeak，不派发 enemyLeak；只旁观同一批存活敌人，不重写结果。
  battle.on('battleEnd', ({ result }) => {
    if (result.reason === 'timeout') for (const e of battle.enemies || []) {
      if (e.alive && !e.isBoss && !e.mem?.noLeak) recordLeak(e);
    }
  }, options);
  battle.on('lpLoss', ({ amount, source }) => {
    const owner = source?.sourcePlayerId ?? source?.ownerId;
    const p = out.perPlayer[owner];
    if (p && amount > 0 && Number.isFinite(amount)) p.leaderLpLoss += amount;
  }, options);
  for (const e of battle.enemies || []) init(e);
  observations.set(battle, out);
  return out;
}
export function rankedObservationOf(battle) {
  return observations.get(battle) || null;
}
