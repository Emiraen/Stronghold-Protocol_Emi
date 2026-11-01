// Mizuki-only adapter. Membership counting and every effect use the original
// game definitions/installers; the automatic modes never enter this adapter.
import { getData } from '../../data.js';
import { canStackBond } from '../../../shared/constants.js';
import { GameData } from '../../match/gamedata.js';
import { computeBonds, thresholdsOf } from '../../match/bondsMeta.js';
import * as bonds from '../../sim/content/bonds.js';
import * as garrisons from '../../sim/content/garrisons/battle.js';
import * as bands from '../../sim/content/bands/battle.js';
import * as S from '../../sim/content/support/index.js';

const PREP_ONLY = new Set(['visiShip', 'miraShip', 'investShip']);
const LIVE_BAND_KEYS = new Set(['act1autochess_band2_buff', 'act1autochess_band17_buff',
  'act2autochess_band12_buff', 'act2autochess_band3_buff']);
const text = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
const field = (u) => u.kind === 'op' && u.alive && u.deployed && !u.removed;

/**
 * A real installer receives an isolated Battle view. Its captured member arrays
 * contain the owned roster, so a later manual deployment needs no reinstall.
 * Its passive writes are retained as descriptors but only attached on field.
 * Dormant scopes retain real PRD/cap/kill counters and cannot execute effects.
 */
class ContentScope {
  constructor(controller, player, { id = null, tier = 0, harmony = false, native = false, garrisonKey = null, strategy = false } = {}) {
    this.controller = controller;
    this.battle = controller.battle;
    this.player = player;
    this.id = id;
    this.tier = tier;
    this.harmony = harmony;
    this.native = native;
    this.garrisonKey = garrisonKey;
    this.strategy = strategy;
    this.enabled = native;
    this.callbacks = new Map();
    this.passives = new Map();
    this.attached = new Map();
    this.costFactors = new Map();
    this.spawned = new Map();
    this.bound = new Map();
    const scope = this;
    const viewPlayer = new Proxy(player, {
      get(target, key) {
        if (key !== 'bonds' || !id) return target[key];
        return { [id]: target.bonds[id], ...(id !== 'maniShip' ? { maniShip: target.bonds.maniShip } : {}) };
      },
    });
    this.view = new Proxy(this.battle, {
      get(target, key) {
        if (key === 'players') return [viewPlayer];
        if (key === 'allyUnits') {
          const owned = target.allyUnits.filter((u) => u.ownerId === player.playerId);
          // Engine spawn helpers append through this view. Retain the owned
          // read boundary while committing new units to the real field.
          Object.defineProperty(owned, 'push', { value: (...units) => target.allyUnits.push(...units) });
          return owned;
        }
        if (key === 'getPlayer') return (pid) => pid === player.playerId ? viewPlayer : null;
        if (key === 'on') return (name, fn, opts = {}) => scope.on(name, fn, opts);
        if (key === 'after' || key === 'every') return (seconds, fn, opts = {}) =>
          target[key](seconds, (...args) => scope.run(fn, ...args), { ...opts, owner: scope });
        if (key === 'addBuff') return (unit, spec) => scope.addBuff(unit, spec);
        if (key === 'spawnToken' && id === 'yanShip') return (...args) => {
          const unit = target.spawnToken.apply(scope.view, args);
          if (unit) scope.spawned.set(unit, { dormant: false, hpRatio: 1 });
          return unit;
        };
        if (key === 'removeBuff') return (unit, buff) => {
          if (typeof buff === 'string') scope.passives.get(unit)?.delete(buff);
          return target.removeBuff(unit, buff);
        };
        if (key === 'redeploy' && id === 'egirShip') return (unit, opts) => {
          // The original installer owns its revival order; retain its battle-wide
          // budget across threshold scope changes instead of refreshing it.
          const used = controller.egirRevived.get(player.playerId) ?? new Set();
          const bb = S.buffParams(S.bondRecord('egirShip'), 'act1autochess_bond_eff_egir') ?? {};
          const max = Math.max(0, Number(bb.max_free_respawn_cnt) || 0);
          if (used.has(unit) || used.size >= max) return false;
          const ok = target.redeploy(unit, opts);
          if (ok) { used.add(unit); controller.egirRevived.set(player.playerId, used); }
          return ok;
        };
        const value = target[key];
        if (typeof value !== 'function') return value;
        if (!scope.bound.has(key)) scope.bound.set(key, value.bind(scope.view));
        return scope.bound.get(key);
      },
    });
    S.battleStore(this.view, 'support:layerCaps', () => controller.layerCaps);
  }

  on(name, fn, opts) {
    const list = this.callbacks.get(name) ?? [];
    list.push(fn);
    this.callbacks.set(name, list);
    return this.battle.on(name, (...args) => this.run(fn, ...args), { ...opts, owner: this });
  }

  run(fn, ...args) {
    if (!this.enabled) return undefined;
    const before = this.id === 'suntShip' ? new Map(this.battle.allyUnits
      .filter((u) => u.skill).map((u) => [u, { mul: u.skill.spCostMul, flag: u.mem['bond:suntShip'] }])) : null;
    try { return fn(...args); }
    finally {
      if (before) for (const [u, old] of before) {
        if (u.skill.spCostMul !== old.mul && !this.costFactors.has(u)) {
          this.costFactors.set(u, { factor: u.skill.spCostMul / old.mul, applied: true, flag: old.flag });
        }
      }
      this.syncCosts();
    }
  }

  replay(name, ctx = {}) {
    for (const fn of this.callbacks.get(name) ?? []) this.run(fn, ctx, this.view);
  }

  addBuff(unit, spec) {
    if (spec.persist) {
      const map = this.passives.get(unit) ?? new Map();
      map.set(spec.key, { ...spec });
      this.passives.set(unit, map);
    }
    if (!this.enabled || (unit.side === 'ally' && unit.kind === 'op' && !field(unit))) return null;
    const actual = this.battle.addBuff(unit, spec);
    if (actual) {
      const set = this.attached.get(unit) ?? new Set();
      set.add(actual);
      this.attached.set(unit, set);
    }
    return actual;
  }

  syncCosts() {
    for (const [unit, it] of this.costFactors) {
      const wanted = this.enabled && field(unit);
      if (it.applied === wanted) continue;
      if (wanted) { unit.skill.spCostMul *= it.factor; unit.mem['bond:suntShip'] = true; }
      else {
        unit.skill.spCostMul /= it.factor;
        if (it.flag === undefined) delete unit.mem['bond:suntShip'];
        else unit.mem['bond:suntShip'] = it.flag;
      }
      it.applied = wanted;
    }
  }

  sync() {
    for (const [unit, state] of this.spawned) {
      if (!this.enabled && unit.alive) {
        state.hpRatio = unit.hpRatio;
        this.battle.retreat(unit, { reason: 'covenantLost', permanent: false });
        unit.removed = false;
        state.dormant = true;
      } else if (this.enabled && state.dormant && !unit.alive) {
        unit.removed = false;
        if (this.battle.redeploy(unit, { free: true })) {
          unit.hp = Math.max(1, unit.s.maxHp * state.hpRatio);
          state.dormant = false;
        }
      }
    }
    for (const [unit, set] of this.attached) {
      for (const buff of set) {
        if (!unit.buffs.includes(buff)) { set.delete(buff); continue; }
        if (!this.enabled || (unit.side === 'ally' && unit.kind === 'op' && !field(unit))) {
          this.battle.removeBuff(unit, buff);
          set.delete(buff);
        }
      }
    }
    if (this.enabled) for (const [unit, specs] of this.passives) {
      if (unit.side === 'ally' && unit.kind === 'op' && !field(unit)) continue;
      for (const spec of specs.values()) this.addBuff(unit, spec);
    }
    this.syncCosts();
  }

  dispose() {
    this.enabled = false;
    this.battle.offOwner(this);
    this.sync();
  }
}

export class MizukiCovenants {
  constructor(battle, raw, { enabled = true } = {}) {
    this.battle = battle;
    this.enabled = enabled;
    const actual = getData();
    this.gd = new GameData({ ...actual, ...(raw ?? {}), bonds: raw?.bonds ?? actual.bonds }, 'mode_mizuki');
    this.scopes = new Map();
    this.layerCaps = new Map();
    this.egirRevived = new Map();
    this.openings = new Set();
    this.desiredGarrisons = new Map();
    this.busy = 0;
    this.signature = '';
    for (const p of battle.players) {
      const source = p.input.bonds;
      p.bonds = Object.fromEntries(this.gd.bondIds.map((id) => [id, {
        layers: canStackBond(id) ? Number(p.input.layers?.[id] ?? p.input.progression?.layers?.[id] ?? (Array.isArray(source)
          ? source.find((b) => (b.id ?? b.bondId) === id)?.layers : source?.[id]?.layers)) || 0 : 0,
      }]));
    }
    this.refresh();
    battle.on('deploy', ({ unit, ...ctx }) => {
      if (unit?.side !== 'ally') return;
      const created = this.refresh();
      // A hook registered during emit is absent from that emission's copied
      // list. Deliver this one deployment only to the newly installed scope.
      for (const scope of created) scope.replay('deploy', { unit, ...ctx });
    }, { owner: this, priority: 10000 });
    battle.on('death', ({ unit }) => { if (unit?.side === 'ally') this.refresh(); }, { owner: this, priority: -10000 });
    battle.on('tick', () => this.refresh(), { owner: this, priority: -10000 });
  }

  desiredTraits(live) {
    const desired = new Map(), sources = [];
    const add = (unit, g, grantedBy = null) => {
      const key = unit.ownerId + '|gar|' + unit.id + '|' + g.garrisonId;
      if (!desired.has(key)) desired.set(key, garrisons.createGarrisonInstance(unit, g, grantedBy));
    };
    for (const unit of live) for (const gid of unit.def.raw?.garrisonIds ?? unit.def.garrisonIds ?? []) {
      const g = S.garrisonRecord(gid);
      if (!g || g.eventType !== 'IN_BATTLE') continue;
      if (g.effectKey === 'ADD_BOND') sources.push(garrisons.createGarrisonInstance(unit, g));
      else add(unit, g);
    }
    const view = new Proxy(this.battle, { get: (target, key) => key === 'allyUnits' ? live : target[key] });
    for (const source of sources) {
      const g = S.garrisonRecord(source.bbStr.give_garrison_id);
      if (!g || g.eventType !== 'IN_BATTLE') continue;
      for (const unit of garrisons.grantTargets(view, source)) add(unit, g, source);
    }
    return desired;
  }

  refresh() {
    if (this.busy) return [];
    const live = this.battle.allyUnits.filter(field);
    const signature = live.map((u) => u.ownerId + ':' + u.id + ':' + u.tileR + ':' + u.tileC + ':' + u.dir).join('|');
    if (signature === this.signature && this.initialized) return [];
    this.signature = signature;
    this.initialized = true;
    for (const player of this.battle.players) {
      const board = new Map(live.filter((u) => u.ownerId === player.playerId)
        .map((u) => [u.uid, { kind: 'chess', id: u.defId, items: u.items ?? [] }]));
      const layers = Object.fromEntries(Object.entries(player.bonds).map(([id, b]) => [id, b.layers ?? 0]));
      player.bonds = computeBonds(this.gd, { board, hand: [], layers, bondCountBonus: {}, effects: [] });
    }
    const created = [];
    this.busy++;
    try {
    if (this.enabled) for (const player of this.battle.players) {
      if (!player.bandId || !live.some((u) => u.ownerId === player.playerId)) continue;
      const definition = S.bandRecord(player.bandId);
      if (!definition) continue;
      const reactive = S.buffsOf(definition).some((b) => LIVE_BAND_KEYS.has(b.bbKey));
      const key = player.playerId + '|band';
      const signature = reactive ? live.filter((u) => u.ownerId === player.playerId)
        .map((u) => u.id + ':' + u.tileR + ':' + u.tileC).join('|') + ':'
        + Object.entries(player.bonds).filter(([, b]) => b.active).map(([id, b]) => id + b.tier).join(',') : 'once';
      const previous = this.scopes.get(key);
      if (previous?.signature === signature) continue;
      previous?.dispose();
      const scope = new ContentScope(this, player, { strategy: true });
      scope.enabled = true;
      scope.signature = signature;
      this.scopes.set(key, scope);
      scope.run(() => bands.install(scope.view));
      scope.replay('battleStart');
      created.push(scope);
    }
    if (this.enabled) for (const player of this.battle.players) {
      const harmony = !!player.bonds.maniShip?.active;
      for (const [id, b] of Object.entries(player.bonds)) {
        if (!b.active || PREP_ONLY.has(id) || id === 'maniShip') continue;
        const key = player.playerId + '|' + id + '|' + b.tier + '|' + harmony;
        if (!this.scopes.has(key)) {
          const scope = new ContentScope(this, player, { id, tier: b.tier, harmony });
          scope.enabled = true;
          this.scopes.set(key, scope);
          scope.run(() => bonds.install(scope.view));
          created.push(scope);
        }
      }
    }
    this.desiredGarrisons = this.desiredTraits(live);
    if (this.enabled) for (const [key, instance] of this.desiredGarrisons) {
      if (this.scopes.has(key)) continue;
      const player = this.battle.getPlayer(instance.unit.ownerId);
      const scope = new ContentScope(this, player, { garrisonKey: key });
      scope.enabled = true;
      scope.instance = instance;
      this.scopes.set(key, scope);
      scope.run(() => garrisons.installGarrisonInstances(scope.view, [instance]));
      created.push(scope);
    }
    for (const scope of this.scopes.values()) {
      const b = scope.player.bonds[scope.id];
      scope.enabled = scope.strategy || (scope.garrisonKey ? this.desiredGarrisons.has(scope.garrisonKey) : !!(b?.active && b.tier === scope.tier
        && !!scope.player.bonds.maniShip?.active === scope.harmony));
      scope.sync();
      if (scope.enabled) scope.replay('layerGain', { playerId: scope.player.playerId, bondId: scope.id });
    }
    // Manual battle opening = first activation of the relevant threshold.
    // Run each original opening hook once, never once per redeployment.
    for (const scope of this.scopes.values()) {
      if (!scope.enabled || !scope.id || !(scope.callbacks.get('battleStart')?.length)) continue;
      const key = scope.player.playerId + '|' + scope.id;
      if (this.openings.has(key)) continue;
      this.openings.add(key);
      scope.replay('battleStart');
    }
    } finally { this.busy--; }
    // Opening devours / revives can alter the live board recursively.
    const after = this.battle.allyUnits.filter(field)
      .map((u) => u.ownerId + ':' + u.id + ':' + u.tileR + ':' + u.tileC + ':' + u.dir).join('|');
    if (after !== this.signature) this.refresh();
    return created;
  }

  snapshot() {
    this.refresh();
    const covenants = {}, traits = {};
    for (const player of this.battle.players) {
      const live = this.battle.allyUnits.filter((u) => u.ownerId === player.playerId && field(u));
      covenants[player.playerId] = this.gd.bondIds.map((id) => {
        const b = player.bonds[id], def = this.gd.bond(id), thresholds = thresholdsOf(def);
        const limitations = PREP_ONLY.has(id) ? ['整备／经济类效果由水月模式整备结算接入。'] : [];
        return { id, name: def.name, count: b.count, active: b.active, tier: b.tier, layers: b.layers,
          thresholds, nextThreshold: thresholds.find((n) => n > b.count) ?? null,
          description: text(def.desc), icon: def.iconId ?? null,
          members: live.filter((u) => S.isMember(this.battle, u, id))
            .map((u) => ({ uid: u.uid, chessId: u.defId, name: u.name })),
          effects: [text(def.desc)].filter(Boolean),
          timing: id === 'yanShip' || id === 'egirShip' ? '首次达到相应档位时执行一次原开场效果；不随重复部署重放。' : null,
          support: PREP_ONLY.has(id) ? 'prep-only' : limitations.length ? 'partial' : 'dynamic', limitations };
      });
      traits[player.playerId] = live.map((u) => {
        const entries = [...this.desiredGarrisons.values()].filter((it) => it.unit === u);
        const own = u.def.raw?.garrisonIds ?? u.def.garrisonIds ?? [];
        return { uid: u.uid, chessId: u.defId, name: u.name,
          ids: [...new Set([...own, ...entries.map((it) => it.gid)])],
          traits: entries.map((it) => ({ id: it.gid, description: text(it.g.desc),
            grantedBy: it.grantedBy?.unit?.uid ?? null, cap: Number.isFinite(it.cap) ? it.cap : null })),
          support: 'dynamic', limitations: [] };
      });
    }
    return { covenants, garrisons: traits, progression: this.progression() };
  }

  // Original Match.settle persists cumulative bond layers. Garrison cnt,
  // wholeUsed and max_add_count_per_battle are explicitly battle-local; reader
  // modifiers are reconstructed from these layers rather than copying buffs.
  progression() {
    return { version: 1, players: Object.fromEntries(this.battle.players.map((player) => [player.playerId, {
      layers: Object.fromEntries(this.gd.bondIds.map((id) => [id,
        canStackBond(id) ? Math.max(0, Math.floor(Number(player.bonds[id]?.layers) || 0)) : 0])),
    }])) };
  }
}

/** Automatic fields keep the prepared board's original covenant membership for
 * the whole battle, including knocked-out operators. Original content modules
 * install directly on Battle; this adapter only exposes their recorded state. */
export class MizukiAutomaticCovenants {
  constructor(battle, raw) {
    this.battle = battle;
    const actual = getData();
    this.gd = new GameData({ ...actual, ...(raw ?? {}), bonds: raw?.bonds ?? actual.bonds }, 'mode_mizuki');
    for (const player of battle.players) {
      const layers = player.input.layers || player.input.progression?.layers || {};
      const board = new Map(player.units.filter((unit) => unit.kind === 'op').map((unit) => [unit.uid, {
        kind: 'chess', id: unit.defId, items: unit.items || [],
      }]));
      player.bonds = player.input.bonds && !Array.isArray(player.input.bonds)
        ? structuredClone(player.input.bonds)
        : computeBonds(this.gd, { board, hand: [], layers });
      if (player.bonds.soloShip) player.bonds.soloShip.layers = 0;
    }
  }

  progression() { return MizukiCovenants.prototype.progression.call(this); }

  snapshot() {
    const covenants = {}, traits = {};
    for (const player of this.battle.players) {
      const units = player.units.filter((unit) => unit.kind === 'op');
      covenants[player.playerId] = this.gd.bondIds.map((id) => {
        const b = player.bonds[id] || {}, def = this.gd.bond(id), thresholds = thresholdsOf(def);
        return { id, name: def.name, count: b.count || 0, active: b.active === true, tier: b.tier || 0, layers: b.layers || 0,
          thresholds, nextThreshold: thresholds.find((value) => value > (b.count || 0)) ?? null,
          description: text(def.desc), icon: def.iconId ?? null, effects: [text(def.desc)].filter(Boolean),
          members: units.filter((unit) => S.isMember(this.battle, unit, id))
            .map((unit) => ({ uid: unit.uid, chessId: unit.defId, name: unit.name })),
          support: PREP_ONLY.has(id) ? 'prep-only' : 'original', limitations: [] };
      });
      traits[player.playerId] = units.map((unit) => ({ uid: unit.uid, chessId: unit.defId, name: unit.name,
        ids: [...(unit.def.raw?.garrisonIds || unit.def.garrisonIds || [])], traits: [], support: 'original', limitations: [] }));
    }
    return { covenants, garrisons: traits, progression: this.progression() };
  }
}
