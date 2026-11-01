// Official level actions stay separate from the old automatic-wave templates.
// The raw level is authoritative; unsupported interactive mechanisms are exposed,
// never replaced with invented enemies or all alternatives spawned together.
import { createRng } from '../../sim/rng.js';
import { normalizeRoute } from '../../sim/simdata.js';
import { findOfficialPredefined } from './OfficialPredefines.js';

const EPS = 1e-9;
const DORMANT = Number.MAX_SAFE_INTEGER;
const number = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const delay = (v) => Math.max(0, number(v));
const count = (a) => Math.max(0, Math.min(4096, Math.floor(number(a.count, 1))));
const type = (a) => String(a.actionType ?? a.type ?? 'SPAWN').toUpperCase();
const list = (v) => Array.isArray(v) ? v : [];

export function installOfficialWaves(battle, level, options = {}) {
  return new OfficialWaves(battle, level, options);
}

export class OfficialWaves {
  constructor(battle, level, options = {}) {
    this.battle = battle;
    this.level = level ?? {};
    this.options = options;
    this.seed = Number(options.waveSeed ?? level?.waveSeed ?? battle.seed) >>> 0;
    this.rng = createRng(this.seed);
    this.enabled = new Set(options.enabledHiddenGroups ?? level?.enabledHiddenGroups ?? []);
    this.unsupported = [];
    this._unsupportedKeys = new Set();
    this.selections = [];
    this.activatedPredefines = [];
    this.previews = [];
    this.previewSequence = 0;
    this.skippedHidden = 0;
    this.waveIndex = -1;
    this.fragmentIndex = -1;
    this.phase = 'ready';
    this.done = false;
    this.started = false;
    this.meta = new Map();
    this._tagSequence = 0;
    this.branchCalls = [];
    this.branchSelections = new Map();
    this.forcedWaves = new Set();
    this.waveReleases = [];
    this.extraRoutes = options.extraRoutes ?? level?.extraRoutes ?? [];
    this.routes = options.routes ?? level?.routes ?? battle.routes;
    this.waves = list(level?.waves).map((wave, wi) => ({ raw: wave,
      fragments: list(wave.fragments).map((fragment, fi) => ({ raw: fragment,
        actions: this._select(list(fragment.actions), wi, fi)
          .map((action, ai) => this._prepare(action, wi, fi, ai)) })) }));
    this.hold = battle.after(Infinity, () => {}, { holdsBattle: true });
    const branchKeys = Object.keys(level?.branches ?? {});
    const supported = new Set([...(options.supportedBranchKeys ?? []), ...(options.dormantBranchKeys ?? [])]);
    for (const key of branchKeys) if (!supported.has(key)) this._limit('BRANCH_TRIGGERS_UNSUPPORTED', key,
      '原版分支需要已绑定的关卡设施或敌人事件触发；未自动展开。');
    for (const group of ['characterInsts', 'tokenInsts']) for (const p of list(level?.predefines?.[group])) {
      if (!p.hidden && !options.activatePredefined) this._limit('PREDEFINED_MECHANISM_UNSUPPORTED',
        p.alias ?? p.inst?.characterKey ?? group, '原版预设角色或设施尚无对应的模拟器机制。');
    }
    battle.on('battleStart', () => this.advance(), { priority: 10000 });
    battle.on('enemySpawn', ({ enemy }) => this.onSpawn(enemy), { priority: 10000 });
    battle._pending.sort((a, b) => a.time - b.time || a.seq - b.seq);
  }

  _limit(code, key, description) {
    const id = code + ':' + key;
    if (this._unsupportedKeys.has(id)) return;
    this._unsupportedKeys.add(id);
    this.unsupported.push({ code, key, description });
  }

  _select(actions, wi, fi) {
    const eligible = actions.filter((a) => {
      if (a.hiddenGroup && !this.enabled.has(a.hiddenGroup)) { this.skippedHidden++; return false; }
      if (a.managedByScheduler === false) {
        this._limit('UNMANAGED_ACTION_UNSUPPORTED', a.key ?? '', '未交给官方波次调度器管理的动作未自动执行。');
        return false;
      }
      for (const field of ['randomType', 'refreshType']) if (a[field] && a[field] !== 'ALWAYS') {
        this._limit('ACTION_MODE_UNSUPPORTED', field + ':' + a[field], '此动作模式尚未实现，未以 ALWAYS 替代。');
        return false;
      }
      return true;
    });
    const groups = new Map();
    for (const a of eligible) if (a.randomSpawnGroupKey) {
      const group = groups.get(a.randomSpawnGroupKey) ?? [];
      group.push(a); groups.set(a.randomSpawnGroupKey, group);
    }
    const chosen = new Set(eligible.filter((a) => !a.randomSpawnGroupKey));
    for (const [key, group] of groups) {
      if (group.some((a) => a.randomSpawnGroupPackKey)) {
        this._limit('RANDOM_PACK_UNSUPPORTED', wi + ':' + fi + ':' + key,
          '此随机包的权重语义尚未核实，未展开所有候选。');
        continue;
      }
      const selected = this.rng.weighted(group, (a) => delay(a.weight));
      if (selected) chosen.add(selected);
      this.selections.push({ wave: wi, fragment: fi, group: key,
        key: selected?.key ?? null, actionType: selected ? type(selected) : null,
        routeIndex: selected?.routeIndex ?? null });
    }
    return eligible.filter((a) => chosen.has(a));
  }

  _prepare(action, wi, fi, ai) {
    const tag = 'mizuki:official:' + wi + ':' + fi + ':' + ai + ':' + (++this._tagSequence);
    const entry = { action, tag, pending: [], times: [], dispatched: 0, scheduled: false, wi, fi };
    this.meta.set(tag, entry);
    if (type(action) === 'SPAWN' && action.key && count(action) > 0) {
      if (!this.battle.data.getEnemy(action.key)) {
        this._limit('ENEMY_DEFINITION_MISSING', action.key, '缺少原版敌人数据，未使用未知敌人占位。');
        return entry;
      }
      const begin = this.battle._pending.length;
      this.battle._queueSpawn({ time: DORMANT, enemyKey: action.key,
        count: count(action), interval: 0, routeIndex: action.routeIndex ?? 0,
        tag, countInTotal: action.isUnharmfulAndAlwaysCountAsKilled ? false : undefined }, true);
      entry.pending = this.battle._pending.slice(begin);
    } else if (!['SPAWN', 'ACTIVATE_PREDEFINED', 'PREVIEW', 'DISPLAY_ENEMY_INFO', 'PREVIEW_ROUTE', 'PREVIEW_CURSOR'].includes(type(action))) {
      this._limit('ACTION_TYPE_UNSUPPORTED', type(action), '此官方动作尚未实现。');
    }
    if (type(action) === 'ACTIVATE_PREDEFINED' && action.key && !this.options.activatePredefined) {
      this._limit('PREDEFINED_MECHANISM_UNSUPPORTED', action.key,
        '原版漂流箱或预设设施尚无对应机制；未伪造其奖励或分支。');
    }
    return entry;
  }

  _route(entry) {
    const source = (entry.branchKey ? this.extraRoutes : this.routes)?.[entry.action.routeIndex ?? 0];
    if (!source) {
      this._limit('ROUTE_MISSING', String(entry.action.routeIndex ?? 0), '缺少动作引用的原版路线。');
      return null;
    }
    entry.waits = new Map();
    const cps = list(source.checkpoints ?? source.cp).map((cp, i) => {
      if (String(cp?.originalType ?? cp?.rawType ?? cp?.type).toUpperCase() !== 'WAIT_CURRENT_FRAGMENT_TIME') return cp;
      const sentinel = 100000000 + i;
      entry.waits.set(sentinel, entry.fragmentStart + delay(cp.time));
      return { ...cp, type: 'WAIT', time: sentinel };
    });
    return normalizeRoute({ ...source, checkpoints: cps });
  }

  // Called only by the original facility/enemy event that owns this branch.
  // A phase is one alternative, not a fragment to flatten with its siblings.
  triggerBranch(key, { phaseIndex = 0, random = false, notRepeatInOneLoop = false, blockGameFinish = false } = {}) {
    if (this.battle.finished) return { ok: false, error: 'BATTLE_ENDED' };
    const phases = list(this.level.branches?.[key]?.phases);
    if (!phases.length) return { ok: false, error: 'BRANCH_MISSING', key };
    if (random) {
      let candidates = this.branchSelections.get(key);
      if (!notRepeatInOneLoop || !candidates?.length) candidates = phases.map((_p, i) => i);
      phaseIndex = this.rng.pick(candidates);
      if (notRepeatInOneLoop) this.branchSelections.set(key, candidates.filter((i) => i !== phaseIndex));
    }
    if (!Number.isInteger(phaseIndex) || !phases[phaseIndex]) return { ok: false, error: 'BRANCH_PHASE_MISSING', key, phaseIndex };
    const phase = phases[phaseIndex];
    const actions = this._select(list(phase.actions), this.waveIndex, 'branch:' + key + ':' + phaseIndex);
    for (const a of actions) if (type(a) === 'SPAWN' && a.key && count(a) > 0) {
      if (!this.battle.data.getEnemy(a.key)) return { ok: false, error: 'ENEMY_DEFINITION_MISSING', key: a.key };
      if (!this.extraRoutes[a.routeIndex ?? 0]) return { ok: false, error: 'BRANCH_ROUTE_MISSING', key, routeIndex: a.routeIndex ?? 0 };
    }
    const start = this.battle.time + delay(phase.preDelay);
    let scheduledCount = 0;
    for (const action of actions) {
      const tag = 'mizuki:branch:' + key + ':' + phaseIndex + ':' + (++this._tagSequence);
      const entry = { action, tag, branchKey: key, wi: this.waveIndex, fi: this.fragmentIndex, fragmentStart: start };
      this.meta.set(tag, entry);
      const route = type(action) === 'SPAWN' && action.key ? this._route(entry) : null;
      for (let i = 0; i < count(action); i++) {
        const at = start + delay(action.preDelay) + i * delay(action.interval);
        if (type(action) === 'SPAWN' && action.key) scheduledCount++;
        this.battle.after(Math.max(0, at - this.battle.time), () => {
          if (type(action) === 'SPAWN' && action.key) {
            this.battle._queueSpawn({ time: this.battle.time, enemyKey: action.key, route, tag, count: 1,
              countInTotal: action.isUnharmfulAndAlwaysCountAsKilled ? false : undefined }, true);
            this.battle._pending.sort((a, b) => a.time - b.time || a.seq - b.seq);
          } else this._activate(entry, at);
        }, { holdsBattle: !!blockGameFinish });
      }
    }
    const record = { key, phaseIndex, time: this.battle.time, scheduledCount, blockGameFinish: !!blockGameFinish };
    this.branchCalls.push(record);
    return { ok: true, ...record };
  }

  // FinishCurrentWave(_finishAndSkip:false): release its living-enemy wait.
  // Scheduled actions remain intact and no existing enemy is killed or leaked.
  finishCurrentWave({ source } = {}) {
    if (this.waveIndex < 0 || this.done || this.battle.finished) return { ok: false, error: 'NO_CURRENT_WAVE' };
    this.forcedWaves.add(this.waveIndex);
    this.waveReleases.push({ wave: this.waveIndex, time: this.battle.time, sourceId: source?.id ?? null });
    return { ok: true, wave: this.waveIndex };
  }

  _startWave(wi, base) {
    this.waveIndex = wi;
    this.fragmentIndex = -1;
    this.waveStart = base + delay(this.waves[wi].raw.preDelay);
    this.nextAt = this.waveStart;
    this.phase = 'wave-pre';
  }

  _startFragment(fi, base) {
    const fragment = this.waves[this.waveIndex].fragments[fi];
    this.fragmentIndex = fi;
    this.fragmentStart = base + delay(fragment.raw.preDelay);
    this.fragmentEnd = this.fragmentStart;
    for (const entry of fragment.actions) {
      entry.fragmentStart = this.fragmentStart;
      const a = entry.action;
      entry.times = Array.from({ length: count(a) }, (_, i) => this.fragmentStart + delay(a.preDelay) + i * delay(a.interval));
      this.fragmentEnd = Math.max(this.fragmentEnd, ...entry.times);
      const route = entry.pending.length ? this._route(entry) : null;
      entry.pending.forEach((p, i) => { p.time = entry.times[i]; p.route = route; });
      entry.scheduled = true;
    }
    this.fragmentEnd += delay(fragment.raw.postDelay);
    this.battle._pending.sort((a, b) => a.time - b.time || a.seq - b.seq);
    this.phase = 'fragment';
  }

  _activate(entry, at) {
    const actionType = type(entry.action);
    if (['PREVIEW', 'DISPLAY_ENEMY_INFO', 'PREVIEW_ROUTE', 'PREVIEW_CURSOR'].includes(actionType)) {
      const source = (entry.branchKey ? this.extraRoutes : this.routes)?.[entry.action.routeIndex ?? 0];
      const route = source ? normalizeRoute(source) : null;
      this.previews.push({ id: ++this.previewSequence, actionType, key: entry.action.key,
        time: at, start: route?.start ?? null,
        points: route ? [route.start, ...route.checkpoints.filter(cp => ['MOVE', 'APPEAR'].includes(cp.type)).map(cp => cp.pos), route.end].filter(Boolean) : [] });
      if (this.previews.length > 64) this.previews.shift();
      return;
    }
    if (type(entry.action) !== 'ACTIVATE_PREDEFINED' || !entry.action.key) return;
    const key = entry.action.key;
    const target = findOfficialPredefined(this.level, key);
    if (!target) this._limit('PREDEFINED_MISSING', key, '找不到动作引用的原版预设实体。');
    const activated = !!(target && this.options.activatePredefined?.(key, target,
      { battle: this.battle, time: at, wave: entry.wi, fragment: entry.fi }));
    this.activatedPredefines.push({ key, time: at, activated });
    if (!activated) this._limit('PREDEFINED_MECHANISM_UNSUPPORTED', key,
      '原版漂流箱或预设设施尚未执行；其奖励与分支不会凭空结算。');
  }

  advance() {
    if (this.done || !this.battle.started || this.battle.finished) return;
    if (!this.started) {
      this.started = true;
      if (!this.waves.length) { this._finish(); return; }
      this._startWave(0, this.battle.time);
    }
    const now = this.battle.time;
    for (let guard = 0; guard < 8192 && !this.done; guard++) {
      const wave = this.waves[this.waveIndex];
      if (this.phase === 'wave-pre') {
        if (now + EPS < this.nextAt) break;
        if (wave.fragments.length) this._startFragment(0, this.waveStart);
        else { this.fragmentEnd = this.waveStart; this.phase = 'wave-clear'; }
      }
      if (this.phase === 'fragment') {
        const fragment = wave.fragments[this.fragmentIndex];
        for (const entry of fragment.actions) while (entry.dispatched < entry.times.length
          && entry.times[entry.dispatched] <= now + EPS) {
          this._activate(entry, entry.times[entry.dispatched++]);
        }
        if (now + EPS < this.fragmentEnd) break;
        const blocking = fragment.actions.filter((entry) => entry.action.blockFragment);
        if (blocking.some((entry) => entry.pending.some((p) => this.battle._pending.includes(p))
          || this.battle.enemies.some((e) => e.alive && e.tag === entry.tag))) break;
        if (this.fragmentIndex + 1 < wave.fragments.length) {
          this._startFragment(this.fragmentIndex + 1, Math.max(this.fragmentEnd, blocking.length ? now : this.fragmentEnd));
          continue;
        }
        this.phase = 'wave-clear';
      }
      if (this.phase === 'wave-clear') {
        const post = delay(wave.raw.postDelay);
        const last = this.waveIndex + 1 >= this.waves.length;
        if (last) {
          if (now + EPS < this.fragmentEnd + post) break;
          this._finish(); break;
        }
          const pending = this.battle._pending.some((p) => this.meta.get(p.tag)?.wi <= this.waveIndex && p.time < DORMANT)
            || [...(this.battle._officialSummonHolds ?? [])].some((s) => !s.cancelled);
        const living = this.battle.enemies.some((e) => e.alive && !e._officialDontBlockWave);
        const maxWait = number(wave.raw.maxTimeWaitingForNextWave, -1);
        const expired = maxWait >= 0 && now + EPS >= this.fragmentEnd + maxWait;
        if (pending || (living && !expired && !this.forcedWaves.has(this.waveIndex))) break;
        this._startWave(this.waveIndex + 1, Math.max(this.fragmentEnd, now) + post);
      }
    }
  }

  onSpawn(enemy) {
    const entry = this.meta.get(enemy?.tag);
    if (!entry) return;
    enemy._officialWaveIndex = entry.wi;
    enemy._officialDontBlockWave = !!entry.action.dontBlockWave;
    for (const leg of enemy.route?.legs ?? []) if (leg.t === 'wait' && entry.waits?.has(leg.time)) {
      const until = entry.waits.get(leg.time);
      Object.defineProperty(leg, 'time', { enumerable: true, configurable: true,
        get: () => Math.max(0, until - this.battle.time) });
    }
  }

  /** Read the opening scheduler state without starting the battle or consuming its queue. */
  initialSpawnSpecs() {
    if (this.battle.started || this.battle.finished) return [];
    const out = [];
    // Only zero-time fragments are reachable before the first simulation tick.
    // A scheduled enemy (even a delayed one) holds its wave; a blocking action
    // holds its fragment exactly as advance() does before _processSpawns().
    for (const wave of this.waves) {
      if (delay(wave.raw.preDelay) > EPS) break;
      let scheduled = false, blocked = false;
      for (const fragment of wave.fragments) {
        if (delay(fragment.raw.preDelay) > EPS) { blocked = true; break; }
        let end = delay(fragment.raw.postDelay);
        for (const entry of fragment.actions) {
          const action = entry.action, n = count(action);
          if (n) end = Math.max(end, delay(action.preDelay) + (n - 1) * delay(action.interval));
          if (entry.pending.length) {
            scheduled = true;
            const route = this.routes?.[action.routeIndex ?? 0];
            for (let i = 0; i < entry.pending.length; i++) {
              if (delay(action.preDelay) + i * delay(action.interval) > EPS) break;
              out.push({ ...entry.pending[i], route });
            }
          }
        }
        if (end > EPS || fragment.actions.some(entry => entry.action.blockFragment && entry.pending.length)) { blocked = true; break; }
      }
      if (blocked || scheduled || delay(wave.raw.postDelay) > EPS) break;
    }
    return out;
  }

  _finish() { this.done = true; this.phase = 'done'; this.hold.cancel(); }

  snapshot() {
    return { source: 'official_level', seed: this.seed, wave: this.waveIndex,
      waveCount: this.waves.length, fragment: this.fragmentIndex, phase: this.phase,
      done: this.done, scheduledEnemyCount: this.waves.reduce((n, w) => n + w.fragments
        .reduce((m, f) => m + f.actions.reduce((k, a) => k + a.pending.length, 0), 0), 0),
      enabledHiddenGroups: [...this.enabled], skippedHidden: this.skippedHidden,
      selections: this.selections.map((s) => ({ ...s })),
      activatedPredefines: this.activatedPredefines.map((p) => ({ ...p })),
      previews: this.previews.map(p => ({ ...p, start: p.start?.slice() ?? null, points: p.points.map(point => point.slice()) })),
      branchCalls: this.branchCalls.map((p) => ({ ...p })),
      waveReleases: this.waveReleases.map((p) => ({ ...p })),
      unsupported: this.unsupported.map((u) => ({ ...u })),
      limitations: this.unsupported.map((u) => u.description + ' (' + u.key + ')') };
  }
}
