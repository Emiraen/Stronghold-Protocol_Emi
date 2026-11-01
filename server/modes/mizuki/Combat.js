// Server-authoritative, manually controlled shared field for one Mizuki duo.
// No timer lives here: the match calls step() at 30 Hz and publishes at 10 Hz.
import { Battle } from '../../sim/Battle.js';
import { ROWS, COLS, TICK } from '../../sim/constants.js';
import { isDir } from '../../sim/dir.js';
import { toDataSource } from '../../sim/simdata.js';
import { mizukiTerrainAllows } from '../../../shared/mizukiPlacement.js';
import { unitStatsEntry } from '../../../shared/protocol.js';
import { unitInfo } from '../../sim/snapshot.js';
import { MODULES } from '../../sim/content/index.js';
import { installExtensions } from '../../sim/content/extensions.js';
import { MizukiCovenants, MizukiAutomaticCovenants } from './covenants.js';
import { installOfficialWaves } from './OfficialWaves.js';
import { installMizukiEnemyBehaviors } from './official-enemies.js';
import { snapshotNativeEnemyEffects } from './native-visibility-enemies.js';
import { snapshotNativeSupplyEffects } from './native-bloodsucker-enemies.js';
import { isNativeDevoured, snapshotNativeSurvivalEffects } from './native-survival-enemies.js';
import { snapshotNativeAirDefenseEffects } from './native-air-defense-enemies.js';
import { snapshotMizukiEventFireEffects } from './native-event-fire-enemies.js';
import { snapshotMizukiTruthEffects } from './native-truth-enemies.js';
import { snapshotMizukiBattleDiceEffects } from './BattleDice.js';
import { mizukiDeployCost, mizukiDeploySlots, mizukiRetreatRefund } from './NativeCombatRules.js';
import { installOfficialUnitRunes } from './OfficialRunes.js';
import { installOfficialStageMechanics } from './OfficialStageMechanics.js';
import { installMizukiDifficulty } from './Difficulty.js';
import { installMizukiCollectibleCombat } from './CollectibleCombat.js';
import { installMizukiNativeMutations } from './NativeMutations.js';
import { installMizukiNativeInfection } from './NativeInfection.js';
import { installMizukiNativeBlessings } from './NativeBlessings.js';
import { installMizukiVariation } from './Variations.js';
import { installMizukiDuckStrategy } from './StrategyAdaptation.js';
import { installMizukiActiveTools } from './ActiveTools.js';
import { uniteLpExempt } from '../../../shared/uniteBilling.js';

const round = (n) => Math.round(n * 1000) / 1000;
const positive = (n, fallback) => Number.isFinite(n) && n > 0 ? n : fallback;
const fail = (error, detail = undefined) => ({ ok: false, error, ...(detail ? { detail } : {}) });

/** All changes to old automatic-battle policies are confined to this subclass. */
class ManualBattle extends Battle {
  _mizukiLossOwner(source) {
    // Rescue keeps the original leaker even when only the helper is present.
    if (source?.sourcePlayerId) return source.sourcePlayerId;
    if (this.opts.automatic && this.kind === 'boss' && this.players.length > 1) {
      const players = [...this.players].sort((a, b) => a.seat - b.seat);
      const cursor = this._mizukiLossCursor ?? 0;
      this._mizukiLossCursor = cursor + 1;
      return players[cursor % players.length].playerId;
    }
    return source?.ownerId ?? (this.players.length === 1 ? this.players[0].playerId : null);
  }

  start() {
    if (this.opts.automatic) return super.start();
    if (this.started || this.finished) return;
    this.started = true;
    this._safe(() => this._spawnStageDevices(), 'stageDevices');
    this.emit('battleStart', {});
  }

  _checkRedeploys() { if (this.opts.automatic) return super._checkRedeploys(); }
  _processSpawns() {
    this._officialWaves?.advance();
    return super._processSpawns();
  }
  _queueSpawn(spec, precount) {
    const first = this._pending.length;
    super._queueSpawn(spec, precount);
    // The shared queue intentionally only copies ordinary SpawnSpec fields.
    // Native rescue can also carry an exact inline RO2 definition.
    if (this.opts?.automatic && spec.def) for (const pending of this._pending.slice(first)) pending.def = spec.def;
  }
  _checkEnd() {
    if (!this.opts.officialLevel && !this.opts.mizukiNativeStage) return super._checkEnd();
    if (this.finished) return;
    if (this.autoFinish && !this._pending.length && !this.enemies.some((e) => e.alive && !e._officialFacility)
        && this.started && !this._hasPendingEnemySchedules()) { this._finish('cleared'); return; }
    // Original maxPlayTime=-1 has no 180 s / old-auto-mode global timeout.
    if (this.time >= this.timeLimit - 1e-9) this._timeout();
  }
  _timeout() {
    const pending = this._pending.slice();
    super._timeout();
    // Keep the original level override for rescue enemies which never spawned.
    // The ordinary result only carries their key; the HUD needs their exact LP.
    for (let index = 0; index < pending.length; index++) {
      const entry = pending[index], saved = this.unspawned?.[index];
      const lpr = entry.lpr ?? entry.def?.lifePointReduce ?? entry.def?.lpr ?? entry.def?.stats?.lpr;
      if (saved && Number.isFinite(lpr)) saved.lpr = lpr;
    }
  }
  redeploy(unit, opts = {}) {
    if (isNativeDevoured(unit)) return false;
    if (this.opts.automatic) return super.redeploy(unit, opts);
    if (unit?.kind === 'token' && unit.uid != null && this._manualDeployUnit !== unit) return false;
    if (this._manualDeployUnit !== unit) return super.redeploy(unit, opts);
    const player = this.getPlayer(unit.ownerId);
    const cost = mizukiDeployCost(unit);
    if (!player || player.dp + 1e-9 < cost) return false;
    // Pay before the original deploy/kit hooks, without changing base.cost.
    // Only a successful player deployment advances the native cost counter;
    // skill teleports/revivals do not silently become extra paid deployments.
    const previousPaid = unit._mizukiPaidCost;
    player.dp = Math.max(0, player.dp - cost);
    unit._mizukiPaidCost = cost;
    let deployed = false;
    try { deployed = super.redeploy(unit, { ...opts, free: true }); }
    finally {
      if (!deployed) {
        player.dp = Math.min(this.flags.dpMax, player.dp + cost);
        unit._mizukiPaidCost = previousPaid;
      }
    }
    if (deployed && unit.kind === 'op') unit._mizukiDeployCount = (unit._mizukiDeployCount ?? 0) + 1;
    return deployed;
  }

  spawnToken(owner, tokenId, row, col, opts = {}) {
    if (this.opts.automatic) return super.spawnToken(owner, tokenId, row, col, opts);
    // Placed talent/skill pieces wait for their player's tile choice. Runtime
    // split clones and temporary skill-created entities retain their real kit.
    if (owner && typeof owner === 'object' && !(opts.duration > 0) && !opts.kit
        && this.allyUnits.some((u) => u.kind === 'token' && u.uid != null
          && u.ownerUnit === owner && u.defId === tokenId)) return null;
    return super.spawnToken(owner, tokenId, row, col, opts);
  }

  _remove(unit, ...args) {
    super._remove(unit, ...args);
    if (!this.opts.automatic && unit.kind === 'token' && unit.uid != null && !unit.alive) {
      unit.removed = false;
      if (!Number.isFinite(unit.mem.readyAt) && !Number.isFinite(unit.mem.respawnAt)) {
        unit.respawnAt = this.time + Math.max(0, unit.base.respawnTime);
      }
    }
  }
  isDown(unit) { return this.opts.automatic ? super.isDown(unit) : false; }

  spawnEnemy(enemyKey, opts = {}) {
    const enemy = super.spawnEnemy(enemyKey, opts);
    if (enemy && this.opts.automatic) {
      const route = structuredClone(opts.route || this._routeFor(opts.routeIndex ?? 0));
      // WAIT_CURRENT_FRAGMENT_TIME is resolved by OfficialWaves at spawn time;
      // retain its real duration instead of the internal sentinel on replay.
      const waits = (enemy.route?.legs || []).filter((leg) => leg.t === 'wait').map((leg) => leg.time);
      let wait = 0;
      for (const cp of route?.checkpoints || []) if (String(cp.type).toUpperCase().includes('WAIT')) cp.time = waits[wait++] ?? cp.time;
      enemy._mizukiReplaySpawn = { route, ...(opts.pos ? { pos: [...opts.pos] } : {}),
        mods: structuredClone(opts.mods || {}), tag: opts.tag ?? null,
        ...(enemy.def.raw ? { def: structuredClone(enemy.def.raw) } : {}),
        countInTotal: enemy.counted, originalSpawnTime: this.time };
    }
    return enemy;
  }

  _recordLeak(enemy, timeout) {
    const lengths = new Map(this.players.map((player) => [player.playerId, this._pp(player.playerId)?.leaked.length || 0]));
    super._recordLeak(enemy, timeout);
    if (this.opts.automatic && this.kind === 'boss' && this.players.length > 1 && (enemy.counted || enemy.isBoss)) {
      const ownerId = this._mizukiLossOwner(enemy), target = this._pp(ownerId);
      for (const player of this.players) {
        const pp = this._pp(player.playerId);
        if (!pp || pp.leaked.length <= lengths.get(player.playerId)) continue;
        const entry = pp.leaked.at(-1);
        entry.sourcePlayerId = ownerId;
        if (target && target !== pp) {
          pp.leaked.pop(); target.leaked.push(entry);
          if (enemy.inTotal) { pp.leakedInTotal--; target.leakedInTotal++; }
          pp.perfect = !pp.leaked.some((leak) => leak.counted !== false);
          target.perfect = false;
        }
        break;
      }
    }
    if (this.opts.automatic && enemy._mizukiReplaySpawn) for (const player of this.players) {
      const leaks = this._pp(player.playerId)?.leaked;
      if (leaks?.length > lengths.get(player.playerId)) leaks.at(-1).nativeSpawn = structuredClone(enemy._mizukiReplaySpawn);
    }
    // Timeout resolution records leaks without firing enemyLeak. Count at this
    // common bookkeeping entry so the match charges personal life exactly once.
    if (enemy.counted || enemy.isBoss) {
      this._mizukiLeakDamage = (this._mizukiLeakDamage ?? 0) + Math.max(0, Number(enemy.lpr) || 0);
    }
  }

  isReservedTile(r, c) {
    if (this.opts.automatic) return super.isReservedTile(r, c);
    if (!this.grid.inRect(r, c)) return true;
    const u = this._occ[r * COLS + c];
    return !!(u && u.alive && u.deployed);
  }

  onOwnBoard(ps, r, c) {
    return !!ps && this.grid.inRect(r, c) && this.grid.canStand(r, c, { ranged: true });
  }

  _setupUnit(unit, kit = null) {
    const previousMode = this.contentMode;
    this.contentMode = this.opts.mizukiContent ?? previousMode;
    let out;
    try { out = super._setupUnit(unit, kit); }
    finally { this.contentMode = previousMode; }
    const skill = unit.skill;
    if (!this.opts.automatic && skill && skill.manual && skill.kind !== 'passive') {
      // Covers strategy casts and kit-authored direct activate() calls alike.
      // AUTO skills, passive skills and natural SP gain keep their existing rules.
      const activate = skill.activate;
      const descriptor = Object.getOwnPropertyDescriptor(skill, 'activate');
      // Some original kits (Ulpianus S3) install a configurable but readonly
      // target-validity wrapper. Preserve that wrapper and its descriptor.
      Object.defineProperty(skill, 'activate', { configurable: true, writable: true,
        ...(descriptor ?? {}), value: (...args) => this._manualSkill === skill ? activate.apply(skill, args) : false });
    }
    return out;
  }
}

export class MizukiCombat {
  constructor(options = {}) {
    if (!Array.isArray(options.players) || options.players.length < 1 || options.players.length > 2) {
      throw new TypeError('MizukiCombat requires one or two players in a duo field');
    }
    this.battleId = options.battleId ?? null;
    this.automatic = options.automatic === true;
    this.nativeStage = options.nativeStage ?? null;
    this.fieldId = options.fieldId ?? 'mizuki';
    this.deployLimit = Math.max(1, Math.floor(positive(options.deployLimit, 6)));
    this.deployLimits = Object.fromEntries(options.players.map(player => [player.playerId,
      Math.min(9, Math.max(1, Math.floor(positive(options.deployLimits?.[player.playerId], this.deployLimit))))]));
    this.teamHpMax = Number.isFinite(options.teamHp) ? positive(options.teamHp, 10) : null;
    this.teamHp = this.teamHpMax;
    this.outcome = null;
    this.commandSeq = 0;
    this.commandLog = [];
    const source = toDataSource(typeof options.data?.getChess === 'function' ? options.data : options.data?.raw ?? options.data);
    let nextUid = Math.max(0, ...options.players.flatMap((p) => (p.units ?? [])
      .map((u) => Number.isSafeInteger(u.uid) ? u.uid : 0))) + 1;
    const seenPlayers = new Set();
    const players = options.players.map((p) => {
      if (typeof p.playerId !== 'string' || !p.playerId || seenPlayers.has(p.playerId)) {
        throw new TypeError('MizukiCombat playerId must be unique and nonempty');
      }
      seenPlayers.add(p.playerId);
      const seenUnits = new Set();
      const activeTools = (p.units ?? []).filter(u => u.toolId);
      const units = (p.units ?? []).filter(u => !u.toolId).map((u) => {
        if (u.uid == null || seenUnits.has(u.uid)) throw new TypeError('MizukiCombat unit uid must be unique per owner');
        seenUnits.add(u.uid);
        if (this.automatic && u.kind === 'token') return { ...u, abs: true };
        if (!source.getChess(u.chessId, { skillIndex: u.skillIndex ?? null, moduleId: u.moduleId ?? null })) {
          throw new TypeError(`Unknown Mizuki operator ${u.chessId}`);
        }
        // Initial coordinates are placeholders only: no undeployed unit reserves a tile.
        return this.automatic ? { ...u, kind: 'op', abs: true }
          : { ...u, kind: 'op', row: options.rect?.r0 ?? 9, col: options.rect?.c0 ?? 2, dir: 'RIGHT', abs: true };
      });
      for (const op of this.automatic ? [] : [...units]) {
        const def = source.getChess(op.chessId, { skillIndex: op.skillIndex ?? null, moduleId: op.moduleId ?? null });
        for (const entry of def.tokens ?? []) {
          const tokenId = typeof entry === 'string' ? entry : entry.tokenId ?? entry.id;
          const td = source.getToken(tokenId, op.chessId, def.loadout);
          if (!td || td.raw?.placeable !== true
              || (Array.isArray(td.sources) && !td.sources.some((s) => s === 'talent' || s === 'skill'))) continue;
          const variant = td.raw?.variants?.[def.tokenOwner] ?? td.raw;
          const capacity = variant?.stats?.deployLimit ?? td.raw?.deployLimit ?? 1;
          // Automatic prep used token.count (one selected piece); a manual
          // summoner needs separate entities up to its real simultaneous cap.
          for (let n = 0; n < Math.max(1, Math.floor(td.count ?? 1), Math.floor(capacity)); n++) units.push({
            uid: nextUid++, kind: 'token', tokenId, chessId: tokenId, ownerUid: op.uid,
            row: op.row, col: op.col, dir: op.dir, abs: true,
          });
        }
      }
      return { ...p, coords: 'field', colOffset: 0, rowOffset: 0, side: 'L', units, activeTools };
    });
    const stage = options.stage ?? (options.stageId ? source.getStage(options.stageId) : null);
    if (!stage) throw new TypeError('MizukiCombat requires an existing stage or inline stage');
    for (const spawn of options.officialLevel ? [] : options.spawns ?? []) {
      if (!source.getEnemy(spawn.enemyKey)) throw new TypeError(`Unknown Mizuki enemy ${spawn.enemyKey}`);
    }
    this.battle = new ManualBattle({
      seed: options.seed, kind: this.automatic ? options.kind || 'normal' : 'mizuki', modeId: 'mode_mizuki', fieldId: this.fieldId,
      stage, stageId: options.stageId, rect: options.rect, players, data: source,
      spawns: options.officialLevel ? [] : options.spawns ?? [], routes: options.routes ?? [],
      enemyOverrides: options.enemyOverrides ?? {},
      timeLimit: options.timeLimit === Infinity ? Infinity : positive(options.timeLimit, 180),
      officialLevel: !!options.officialLevel, mizukiNativeStage: !!options.officialStageLevel, content: 'none', mizukiContent: options.content ?? 'full',
      automatic: this.automatic,
      ...(options.kits ? { kits: options.kits } : {}),
      flags: { layerGainsEnabled: true, ...(!this.automatic ? { dpInit: 35, dpPerSec: 1, dpMax: 99 } : {}), ...(options.flags ?? {}) },
      logger: options.logger ?? console,
    });
    this.battle.battleId = this.battleId;
    this.battle.contentMode = options.content ?? 'full';
    if (this.automatic) this.covenants = new MizukiAutomaticCovenants(this.battle, source.raw);
    if (this.battle.contentMode === 'full') {
      installExtensions(this.battle);
      for (const [name, mod] of MODULES) {
        if ((!this.automatic && ['bonds', 'garrisons', 'bands'].includes(name)) || typeof mod.install !== 'function') continue;
        this.battle._safe(() => mod.install(this.battle), 'content:' + name);
      }
    }
    for (const p of this.battle.players) {
      if (p.units.length !== (p.input.units ?? []).length) throw new Error('Mizuki roster failed to initialize');
      for (const unit of p.units) unit.respawnAt = 0;
      if (p.input.squadMods && typeof p.input.squadMods === 'object') for (const unit of p.units) {
        if (unit.kind === 'op') this.battle.addBuff(unit, { key: 'mizuki:squad',
          mods: { ...p.input.squadMods }, persist: true, allowDead: true, refresh: 'replace' });
      }
    }
    if (options.officialRunes) installOfficialUnitRunes(this.battle, options.officialRunes);
    this.difficultyEffects = installMizukiDifficulty(this.battle, { grade: options.difficultyGrade ?? 0, areaCount: options.difficultyAreaCount ?? 1, collectibles: options.collectibles ?? [] });
    this.collectibles = installMizukiCollectibleCombat(this.battle, { collectibles: options.collectibles ?? [],
      ...(options.collectibleContext || {}) });
    this.mutations = installMizukiNativeMutations(this.battle, { players });
    this.infection = installMizukiNativeInfection(this.battle, { grade: options.difficultyGrade ?? 0, players, collectibles: options.collectibles ?? [] });
    this.blessings = installMizukiNativeBlessings(this.battle, { virtues: options.virtues ?? [] });
    this.variation = installMizukiVariation(this.battle, options.variation ?? null);
    if (!this.automatic) this.covenants = new MizukiCovenants(this.battle, source.raw, { enabled: this.battle.contentMode === 'full' });
    const stageLevel = options.officialLevel || options.officialStageLevel;
    this.stageMechanics = stageLevel ? installOfficialStageMechanics(this.battle, stageLevel) : null;
    this.activeTools = installMizukiActiveTools(this.battle, players, options.battleDice);
    const facilityWaves = this.stageMechanics?.waveOptions ?? {};
    const waveOptions = { ...facilityWaves, ...options.officialWaveOptions, supportedBranchKeys: [
      ...new Set([...(facilityWaves.supportedBranchKeys ?? []), ...(options.officialWaveOptions?.supportedBranchKeys ?? [])]),
    ] };
    this.officialWaves = options.officialLevel
      ? installOfficialWaves(this.battle, options.officialLevel, waveOptions) : null;
    this.battle._officialWaves = this.officialWaves;
    this.strategyWaveChanges = installMizukiDuckStrategy(this.battle, this.officialWaves);
    if (stageLevel || options.nativeEnemyBehaviors) installMizukiEnemyBehaviors(this.battle);
    this.battle.on('enemyLeak', ({ enemy }) => {
      const damage = enemy.counted || enemy.isBoss ? Math.max(0, Number(enemy.lpr) || 0) : 0;
      if (this.teamHp != null) {
        this.teamHp = Math.max(0, this.teamHp - damage);
        if (this.teamHp <= 0) { this.outcome = 'defeat'; this.battle.forceEnd('forced'); }
      }
    });
    // Native civilian deaths and other direct objective-HP effects do not
    // traverse enemyLeak. Preserve them separately through one-helper rescue.
    this.battle.on('lpLoss', ({ amount, source }) => {
      if (!(Number.isFinite(amount) && amount > 0)) return;
      const ownerId = this.battle._mizukiLossOwner(source);
      if (!ownerId) throw new TypeError('Mizuki objective loss has no player attribution');
      const losses = this.battle._mizukiNativeLifeLossByPlayer ??= {};
      losses[ownerId] = (losses[ownerId] ?? 0) + amount;
      this.battle._mizukiNativeLifeLoss = (this.battle._mizukiNativeLifeLoss ?? 0) + amount;
      if (this.teamHp != null) {
        this.teamHp = Math.max(0, this.teamHp - amount);
        if (this.teamHp <= 0) { this.outcome = 'defeat'; this.battle.forceEnd('forced'); }
      }
    });
  }

  get done() { return this.battle.finished; }
  get finished() { return this.battle.finished; }
  get tick() { return this.battle.tickCount; }
  get time() { return this.battle.time; }
  get economicCoins() {
    return Object.fromEntries(this.battle.players.map((player) => [player.playerId,
      Math.max(0, Number(this.battle._pp(player.playerId)?.coins) || 0)]));
  }
  get dt() { return TICK; }
  get nativeLifeLoss() { return this.battle?._mizukiNativeLifeLoss ?? 0; }
  get leakDamage() { return (this.battle?._mizukiLeakDamage ?? 0) + this.nativeLifeLoss; }

  _unit(playerId, uid) {
    const p = this.battle.getPlayer(playerId);
    if (!p) return { error: 'NOT_PLAYER' };
    const unit = p.units.find((u) => u.uid === uid && (u.kind === 'op' || u.kind === 'token'))
      ?? this.stageMechanics?.findCommandUnit(uid);
    if (!unit) {
      const exists = this.battle.allyUnits.some((u) => u.uid === uid && (u.kind === 'op' || u.kind === 'token'));
      return { error: exists ? 'NOT_OWNER' : 'UNKNOWN_UNIT' };
    }
    return { p, unit };
  }

  _skillError(unit) {
    const skill = unit.skill;
    if (!unit.alive || !unit.deployed) return 'NOT_DEPLOYED';
    if (!skill || skill.noSkill || !skill.manual || skill.kind === 'passive') return 'NOT_MANUAL_SKILL';
    if (!unit.canAct || unit.hidden || unit.s.flags.silence) return 'UNIT_DISABLED';
    if (!skill.ready || skill.pending || (skill.active && skill.isTimed)) return 'SKILL_NOT_READY';
    return null;
  }

  command(playerId, input = {}) {
    if (input.type === 'deploy' && this.activeTools.handles(playerId, input.uid)) {
      if (!this.automatic || !this.battle.started || this.done) return fail('WRONG_PHASE');
      const result = this.activeTools.deploy(playerId, input);
      if (result.ok) {
        this.commandSeq++;
        this.commandLog.push({ ...input, seq: this.commandSeq, tick: this.tick, playerId });
      }
      return result;
    }
    if (input?.type === 'deployFacility') {
      if (!this.automatic || this.done) return fail('WRONG_PHASE');
      if (!this.battle.getPlayer(playerId)) return fail('NOT_PLAYER');
      if (!isDir(input.dir)) return fail('BAD_DIRECTION');
      if (input.inCombat && !this.battle.started) this.battle.start();
      if (this.done || this.battle.finished) return fail('BATTLE_ENDED');
      const result = this.stageMechanics?.deployCard?.(input.key, input.row, input.col, input.dir, { playerId }) ?? fail('BAD_TARGET');
      if (result.ok && this.battle.started) {
        this.commandSeq++;
        this.commandLog.push({ ...input, seq: this.commandSeq, tick: this.tick, playerId });
      }
      return result;
    }
    if (this.automatic) return fail('AUTOMATIC_COMBAT');
    if (this.done) return fail('BATTLE_ENDED');
    if (!input || typeof input !== 'object') return fail('BAD_COMMAND');
    const { p, unit, error } = this._unit(playerId, input.uid);
    if (error) return fail(error);
    if (!['deploy', 'retreat', 'skill'].includes(input.type)) return fail('BAD_COMMAND');
    if (unit.kind === 'device' && input.type !== 'skill') return fail('FIXED_FACILITY');
    // The match only calls commands in COMBAT. Starting here also makes the first
    // command valid before the first scheduled tick; construction stays PREP-safe.
    if (!this.battle.started) this.battle.start();
    if (this.done) return fail('BATTLE_ENDED');
    let response;
    if (input.type === 'deploy') response = this._deploy(p, unit, input);
    else if (input.type === 'retreat') response = this._retreat(p, unit);
    else response = this._skill(unit, p);
    if (response.ok) {
      this.commandSeq++;
      this.commandLog.push({ ...input, seq: this.commandSeq, tick: this.tick, playerId });
    }
    return response;
  }

  _deploy(player, unit, input) {
    const b = this.battle;
    if (isNativeDevoured(unit)) return fail('DEVOUR_LOCKED');
    const tokenError = this._tokenError(unit);
    if (tokenError) return fail(tokenError);
    if (unit.removed) return fail('UNIT_REMOVED');
    if (unit.alive || unit.deployed) return fail('ALREADY_DEPLOYED');
    if (unit.deploySeq > 0 && this._readyAt(unit) > b.time + 1e-9) return fail('COOLDOWN');
    if (!Number.isInteger(input.row) || !Number.isInteger(input.col) || !b.grid.inRect(input.row, input.col)) return fail('WRONG_TILE');
    if (!isDir(input.dir)) return fail('BAD_DIRECTION');
    if (!mizukiTerrainAllows(unit.def, b.grid.tile(input.row, input.col), unit.mem.mizukiBuildableAll)) return fail('WRONG_TILE');
    const occupant = b._occ[input.row * COLS + input.col];
    if (occupant && occupant.alive && occupant.deployed) return fail('OCCUPIED');
    if (b.grid.obstacle[input.row * COLS + input.col]) return fail('WRONG_TILE');
    const usedSlots = this._deploySlotsUsed(player.playerId);
    if (usedSlots + mizukiDeploySlots(unit) > this.deployLimitFor(player.playerId)) return fail('DEPLOY_LIMIT');
    const skillPiece = unit.kind === 'token' && Array.isArray(unit.def.sources)
      && unit.def.sources.includes('skill') && !unit.def.sources.includes('talent');
    const summonDeck = this._summonDeck(unit);
    const cost = mizukiDeployCost(unit);
    if (player.dp + 1e-9 < cost) return fail('NO_DP');
    const old = [unit.homeR, unit.homeC, unit.dir];
    unit.homeR = input.row; unit.homeC = input.col; unit.dir = input.dir;
    b._manualDeployUnit = unit;
    let deployed;
    try { deployed = b.redeploy(unit, { tile: [input.row, input.col] }); }
    finally { b._manualDeployUnit = null; }
    if (!deployed) {
      [unit.homeR, unit.homeC, unit.dir] = old;
      return fail('DEPLOY_FAILED');
    }
    if (summonDeck) summonDeck.held--;
    else if (skillPiece) unit.ownerUnit.mem.summonStock[unit.defId]--;
    return { ok: true, unitId: unit.id, cost, dp: round(player.dp) };
  }

  _retreat(player, unit) {
    if (!unit.alive || !unit.deployed) return fail('NOT_DEPLOYED');
    const refund = mizukiRetreatRefund(unit);
    this.battle.retreat(unit);
    if (unit.alive || unit.deployed) return fail('RETREAT_FAILED');
    this.battle.addDp(player.playerId, refund);
    return { ok: true, unitId: unit.id, refund, dp: round(player.dp), redeployRemaining: round(Math.max(0, this._readyAt(unit) - this.time)) };
  }

  _readyAt(unit) {
    if (unit.kind !== 'token') return unit.respawnAt;
    const clocks = [unit.mem.readyAt, unit.mem.respawnAt, unit.mem.deckReadyAt].filter(Number.isFinite);
    return clocks.length ? Math.max(...clocks) : unit.respawnAt;
  }

  deployLimitFor(playerId) {
    return Math.min(9, Math.max(1, (this.deployLimits[playerId] ?? this.deployLimit) + (this.battle._mizukiDeployLimitBonus ?? 0)));
  }

  _deploySlotsUsed(playerId = null) {
    return this.battle.allyUnits.reduce((n, unit) =>
      n + ((playerId == null || unit.ownerId === playerId) && unit.alive && unit.deployed ? mizukiDeploySlots(unit) : 0), 0);
  }

  _summonDeck(unit) {
    if (unit.kind !== 'token') return null;
    const deck = unit.ownerUnit?.mem?.summonDeck;
    return deck?.pieces().includes(unit) ? deck : null;
  }

  _tokenError(unit) {
    if (unit.kind !== 'token') return null;
    const owner = unit.ownerUnit;
    if (!owner?.alive || !owner.deployed) return 'OWNER_NOT_DEPLOYED';
    if (!this.battle.producesToken(owner, unit.defId, unit.def)) return 'TOKEN_UNAVAILABLE';
    const deck = this._summonDeck(unit);
    if (deck) {
      if (unit.alive || unit.deployed) return null;
      if (deck.held < 1) return 'NO_SUMMON_STOCK';
      const used = deck.standing().reduce((n, token) => n + Math.max(1, mizukiDeploySlots(token)), 0);
      if (used + 1 > deck.maxDeployed) return 'SUMMON_LIMIT';
      return null;
    }
    const src = unit.def.sources;
    if (Array.isArray(src) && src.includes('skill') && !src.includes('talent')
        && !(owner.mem.summonStock?.[unit.defId] > 0)) return 'NO_SUMMON_STOCK';
    return null;
  }

  _skill(unit, player) {
    const error = this._skillError(unit);
    if (error) return fail(error);
    const cost = unit.mem.mizukiSkillCost;
    if (cost != null && (!player || player.dp + 1e-9 < cost)) return fail('NO_DP');
    this.battle._manualSkill = unit.skill;
    this.battle._manualPlayerId = player?.playerId ?? null;
    try {
      if (!unit.skill.activate('player')) return fail('SKILL_NOT_READY');
    } finally { this.battle._manualSkill = null; this.battle._manualPlayerId = null; }
    return { ok: true, unitId: unit.id };
  }

  step() {
    if (!this.done) this.battle.step();
    this._updateOutcome();
    return this.done;
  }

  _updateOutcome() {
    if (!this.done || this.outcome) return;
    this.outcome = this.battle.reason === 'cleared' ? 'victory'
      : this.battle.reason === 'timeout' ? 'timeout' : 'aborted';
  }

  forceEnd(reason = 'forced') {
    if (!this.done) this.battle.forceEnd(reason);
    this._updateOutcome();
  }

  _rosters() {
    const out = {};
    for (const player of this.battle.players) {
      const units = [...player.units.filter((u) => u.kind === 'op' || (u.kind === 'token' && u.uid != null)),
        ...(this.stageMechanics?.commandUnits() ?? [])];
      out[player.playerId] = units.map((u) => {
        const skill = u.skill;
        const fixed = u.kind === 'device';
        const deck = this._summonDeck(u);
        const disabledReason = fixed ? 'FIXED_FACILITY' : isNativeDevoured(u) ? 'DEVOUR_LOCKED'
          : this.automatic ? 'AUTOMATIC_COMBAT' : this._tokenError(u);
        return {
          uid: u.uid, id: u.id, chessId: u.defId, name: u.name,
          isToken: u.kind === 'token', tokenId: u.kind === 'token' ? u.defId : null,
          isFacility: fixed,
          ownerUid: u.ownerUnit?.uid ?? null, parentName: u.ownerUnit?.name ?? null,
          deployable: !disabledReason, disabledReason,
          devouredBy: u.mem.mizukiDevouredBy ?? null,
          summonHeld: deck?.held ?? u.ownerUnit?.mem?.summonStock?.[u.defId] ?? null,
          summonCap: deck?.cap ?? null, summonDeployLimit: deck?.maxDeployed ?? null,
          avatar: u.def.avatar ?? u.def.charId ?? u.defId, position: u.mem.mizukiBuildableAll ? 'ALL' : u.def.position,
          cost: u.alive && u.deployed ? u._mizukiPaidCost ?? mizukiDeployCost(u) : mizukiDeployCost(u),
          paidCost: u.alive && u.deployed ? u._mizukiPaidCost ?? 0 : 0, nextCost: mizukiDeployCost(u),
          retreatRefund: u.alive && u.deployed ? mizukiRetreatRefund(u) : 0,
          deploySlots: mizukiDeploySlots(u), deployed: !!(u.alive && u.deployed), removed: !!u.removed,
          redeployRemaining: u.deploySeq > 0 && !u.alive ? round(Math.max(0, this._readyAt(u) - this.time)) : 0,
          dir: u.dir, hp: Math.max(0, round(u.hp)), maxHp: round(u.s.maxHp),
          live: unitStatsEntry(u, u.s),
          canRetreat: !!(!this.automatic && !fixed && u.alive && u.deployed),
          skill: { name: skill?.name ?? '', ready: !this._skillError(u),
            manual: !!(!this.automatic && skill?.manual && skill.kind !== 'passive' && !skill.noSkill),
            active: !!skill?.active, sp: round(skill?.sp ?? 0), spMax: round(skill?.spCost ?? 0),
            charges: skill?.charges ?? 0, maxCharges: skill?.maxCharges ?? 0,
            error: this._skillError(u) },
        };
      });
    }
    for (const [playerId, stock] of Object.entries(this.activeTools.snapshot())) (out[playerId] ||= []).push(...stock);
    return out;
  }

  _geometry() {
    const b = this.battle, tiles = [];
    for (let row = b.rect.r0; row <= b.rect.r1; row++) {
      for (let col = b.rect.c0; col <= b.rect.c1; col++) {
        const t = b.grid.tile(row, col);
        tiles.push({ row, col, height: t.height, build: t.build, pass: t.pass, key: t.key, special: t.special ?? null, obstacle: !!b.grid.obstacle[row * COLS + col] });
      }
    }
    return { rows: ROWS, cols: COLS, rect: { ...b.rect }, tiles };
  }

  objectiveHealth() {
    const b = this.battle;
    const direct = { ...(b._mizukiNativeLifeLossByPlayer || {}) }, loss = { ...direct }, remaining = {}, left = {};
    const add = (map, id, amount) => {
      if (typeof id === 'string' && id && Number.isFinite(amount) && amount > 0) map[id] = (map[id] || 0) + amount;
    };
    const damage = entry => Math.max(0, Number(entry.lpr ?? entry.def?.lifePointReduce ?? entry.def?.lpr ?? entry.def?.stats?.lpr
      ?? b.data.getEnemy(entry.enemyKey || entry.defId)?.lpr ?? 1) || 0);
    for (const [id, player] of Object.entries(b._perPlayer || {})) for (const leak of player.leaked || []) {
      if (leak.counted === false) continue;
      const owner = leak.sourcePlayerId || id;
      add(loss, owner, damage(leak));
      if (!uniteLpExempt(leak)) { add(remaining, owner, damage(leak)); add(left, owner, 1); }
    }
    if (b.kind === 'unite') {
      const entries = b.finished ? b.result()?.unspawned || []
        : [...b._pending, ...b.enemies.filter(enemy => enemy.alive && (enemy.counted || enemy.isBoss))];
      for (const entry of entries) {
        if (entry.counted === false || uniteLpExempt(entry)) continue;
        const owner = entry.sourcePlayerId || entry.ownerId;
        add(remaining, owner, damage(entry)); add(left, owner, 1);
      }
    }
    return { objectiveLossByPlayer: loss, objectiveDirectLossByPlayer: direct,
      objectiveRemainingByPlayer: remaining, objectiveEnemiesLeftByPlayer: left };
  }

  snapshot({ stream = false } = {}) {
    this._updateOutcome();
    const covenants = this.covenants.snapshot();
    const snapshot = this.battle.snapshot();
    const infection = this.infection.snapshot();
    snapshot.dps = Object.fromEntries(this.battle.players.map((p) => [p.playerId, round(p.dp)]));
    return { ...snapshot, ...covenants, ...this.objectiveHealth(), battleId: this.battleId, tick: this.tick, done: this.done, outcome: this.outcome,
      controlMode: this.automatic ? 'automatic' : 'manual',
      mizukiDifficulty: this.difficultyEffects.snapshot(), mizukiMutations: this.mutations.snapshot(), mizukiInfection: infection,
      mizukiVirtues: this.blessings.snapshot(),
      facilityCards: this.stageMechanics?.cardOptions?.() ?? [],
      activeTools: this.activeTools.snapshot(),
      leakedCount: this.battle.leakedCount, leakDamage: this.leakDamage, nativeLifeLoss: this.nativeLifeLoss,
      teamHp: this.teamHp, teamHpMax: this.teamHpMax,
      deployLimit: Math.max(...this.battle.players.map(player => this.deployLimitFor(player.playerId))), deploySlotsUsed: this._deploySlotsUsed(),
      deployLimits: Object.fromEntries(this.battle.players.map(player => [player.playerId, this.deployLimitFor(player.playerId)])),
      deploySlotsUsedByPlayer: Object.fromEntries(this.battle.players.map(player => [player.playerId, this._deploySlotsUsed(player.playerId)])),
      rosters: this._rosters(),
      ...(!stream ? { geometry: this._geometry(), meta: this.fieldMeta(),
        ...(!this.battle.started ? { prepEnemies: this.preparationEnemies() } : {}) } : {}),
      officialEnemyEffects: snapshotNativeEnemyEffects(this.battle).concat(
        snapshotNativeSupplyEffects(this.battle), snapshotNativeSurvivalEffects(this.battle),
        snapshotNativeAirDefenseEffects(this.battle), infection.effects || [], snapshotMizukiEventFireEffects(this.battle), snapshotMizukiTruthEffects(this.battle), snapshotMizukiBattleDiceEffects(this.battle)),
      ...(!stream && this.nativeStage ? { stage: this.nativeStage } : {}),
      ...(this.stageMechanics ? { officialFacilities: this.stageMechanics.snapshot() } : {}),
      ...(this.officialWaves ? { officialWaves: this.officialWaves.snapshot() } : {}) };
  }

  // Ordinary combat sends the map and unit records reliably through m.field;
  // twenty-Hz b.snap frames carry the changing simulation values only.
  streamFieldMeta() {
    const version = this.battle.grid.version;
    if (this._streamGeometryVersion === version) return null;
    this._streamGeometryVersion = version;
    return { ...this.fieldMeta(), geometry: this._geometry(),
      ...(this.nativeStage ? { stage: this.nativeStage } : {}) };
  }

  fieldMeta() { return this.battle.fieldMeta(); }

  /** Static opening models only. Never start/step a PREP engine to build a preview. */
  preparationEnemies() {
    const battle = this.battle;
    if (battle.started || battle.finished) return [];
    const existing = battle.enemies.filter(enemy => enemy.alive && enemy.deployed && !enemy.hidden).map(unitInfo);
    const specs = this.officialWaves?.initialSpawnSpecs()
      ?? battle._pending.filter(spec => spec.time <= 1e-9);
    return existing.concat(specs.flatMap(spec => {
      const def = spec.def || battle.data.getEnemy(spec.enemyKey);
      if (!def) return [];
      const route = spec.route || battle._routeFor(spec.routeIndex ?? 0);
      const start = spec.pos || route?.start;
      if (!Array.isArray(start) || !start.every(Number.isFinite)) return [];
      const rect = battle.rect, row = Math.max(rect.r0 - .5, Math.min(rect.r1 + .5, start[0])),
        col = Math.max(rect.c0 - .5, Math.min(rect.c1 + .5, start[1]));
      return [{ id: 'opening:' + spec.seq, kind: 'enemy', side: 'enemy', defId: def.key || spec.enemyKey,
        name: def.name, spine: def.spine || spec.enemyKey, avatar: def.avatar || spec.enemyKey,
        tier: def.rank === 'BOSS' ? 3 : def.rank === 'ELITE' ? 2 : 1, boss: def.rank === 'BOSS',
        motion: def.motion === 'FLY' ? 'FLY' : undefined, maxHp: def.maxHp,
        x: col, y: row, facing: -1, preview: true }];
    }));
  }
  drainEvents() { return this.battle.drainEvents(); }

  result() {
    if (!this.done) return null;
    this._updateOutcome();
    const result = this.battle.result();
    // Civilian deaths are direct objective damage, never rescuable leaks.
    // Preserve failed protection when choosing a perfect one-helper ally.
    const nativeLifeLossByPlayer = { ...this.battle._mizukiNativeLifeLossByPlayer };
    const perPlayer = Object.fromEntries(Object.entries(result.perPlayer || {}).map(([id, player]) => [id,
      { ...player, leaderLpLoss: nativeLifeLossByPlayer[id] ?? 0,
        perfect: player.perfect !== false && !(nativeLifeLossByPlayer[id] > 0) }]));
    return { ...result, perPlayer, nativeLifeLossByPlayer, ...this.covenants.snapshot(),
      bonds: Object.fromEntries(this.battle.players.map((p) => [p.playerId, p.bonds])),
      battleId: this.battleId, fieldId: this.fieldId,
      mizukiVirtues: this.blessings.snapshot(),
      ...(this.stageMechanics ? { officialFacilities: this.stageMechanics.snapshot() } : {}),
      ...(this.officialWaves ? { officialWaves: this.officialWaves.snapshot() } : {}),
      outcome: this.outcome, leakedCount: this.battle.leakedCount, leakDamage: this.leakDamage, nativeLifeLoss: this.nativeLifeLoss };
  }
}

/** Production Mizuki combat: original Stronghold prep layout and automatic AI.
 * MizukiCombat above remains an isolated legacy fixture for native-rule tests. */
export class MizukiAutoCombat extends MizukiCombat {
  constructor(options = {}) { super({ deployLimit: 8, ...options, automatic: true }); }
}
