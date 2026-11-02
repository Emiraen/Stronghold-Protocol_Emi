// Signals for the V79 operators whose areas and triggered effects outlive a skill cast.
import { GEO } from '../../../../shared/constants.js';
import { unitPoint } from './mounts.js';

const OXI = 'char_4247_oxi', TOCKA = 'char_4244_tocka', DMINON = 'char_4246_dminon';
const EFFECTS = Object.freeze({
  [OXI]: ['oxi_buff_01', 'oxi_skill_02_buff_02', 'oxi_skill_02_hit_01', 'oxi_skill_03_trail_01', 'oxi_skill_03_hit_01'],
  [TOCKA]: ['tocka_skill_01_buff_02', 'tocka_skill_01_buff_02_start_01', 'tocka_skill_01_buff_01',
    'tocka_skill_02_buff_02', 'tocka_skill_02_hit_01', 'tocka_skill_03_buff_05', 'tocka_skill_03_buff_06',
    'tocka_skill_03_start_02', 'tocka_skill_03_start_03', 'tocka_attack_02_range_01'],
  [DMINON]: ['dminon_talent_range_01', 'dminon_talent_hit_01', 'dminon_skill_hit_01'],
});
const kindOf = kind => typeof kind !== 'string' ? null : kind.startsWith('oxi') ? OXI : kind.startsWith('tocka_') ? TOCKA : kind.startsWith('dminon_') ? DMINON : null;
const tilePoint = tile => ({ id: 'v79:tile:' + tile, x: tile % GEO.COLS, y: Math.floor(tile / GEO.COLS), z: 0 });
const point = (x, y) => ({ id: 'v79:point', x, y, z: 0 });

export class V79Fx {
  constructor(wiring) {
    this.w = wiring;
    this.held = new Map();
    this.territories = new Map();
    this.enhanced = new Map();
  }
  keys(views) {
    const out = new Set();
    for (const v of views) for (const key of EFFECTS[this.w.unitKeyOf(v)] || []) out.add(key);
    return [...out];
  }
  _stop(slot) {
    const held = this.held.get(slot);
    held?.handle?.stop(); this.held.delete(slot);
  }
  _play(key, v, opts = {}) {
    if (!v || !this.w.ofx.ready(key)) return null;
    return this.w.playOn(key, v, opts);
  }
  _hold(slot, owner, key, view, duration = 0, opts = {}, target = null, surviveOwner = false) {
    this._stop(slot);
    const held = { owner, target, key, view, opts, surviveOwner,
      until: duration > 0 ? this.w.ofx.time + duration : Infinity, handle: null };
    this.held.set(slot, held);
    this._draw(held);
    return !!held.handle;
  }
  _draw(held) {
    held.handle = this._play(held.key, held.view, { loop: true, important: true, follow: true, ...held.opts });
  }
  _shot(key, view, duration = 0, opts = {}) {
    const handle = this._play(key, view, opts);
    if (handle && duration > 0) (this.w.ofx.timers ||= []).push({ at: this.w.ofx.time + duration, fn: () => handle.stop() });
    return !!handle;
  }
  _territory(owner, tiles) {
    const next = new Set(tiles.filter(t => Number.isInteger(t) && t >= 0 && t < GEO.ROWS * GEO.COLS));
    const prev = this.territories.get(owner) || new Set();
    for (const tile of prev) if (!next.has(tile)) this._stop(`kingdom:${owner}:${tile}`);
    for (const tile of next) if (!prev.has(tile)) this._hold(`kingdom:${owner}:${tile}`, owner,
      'dminon_talent_range_01', tilePoint(tile));
    this.territories.set(owner, next);
  }
  simFx(kind, x, y, extra) {
    const cid = kindOf(kind);
    if (!cid || !extra || !this.w.ofx.active) return false;
    const owner = extra.id, source = this.w.view(owner);
    // A projectile and its fields may still exist after their owner has left.
    if (source && this.w.unitKeyOf(source) !== cid) return false;
    const at = point(x, y), duration = Math.max(0, Number(extra.dur) || 0);
    if (kind === 'oxiEnhance') {
      if (extra.on) this.enhanced.set(owner, { actor: null });
      else { this._enhance(source, false); this.enhanced.delete(owner); }
      return true;
    }
    if (kind === 'oxiFireField') {
      const slot = `fire:${owner}:${extra.tile}`;
      if (!extra.on) { this._stop(slot); return true; }
      return this._hold(slot, owner, 'oxi_buff_01', at, duration, {}, null, true);
    }
    if (kind === 'oxiHeatwave') {
      const slot = `wave:${owner}:${extra.wave}:${extra.shot}`;
      if (!extra.on) { this._stop(slot); return true; }
      const t0 = this.w.ofx.time, endX = extra.toX, endY = extra.toY;
      if (!Number.isFinite(endX) || !Number.isFinite(endY)) return false;
      const time = duration || Math.hypot(endX - x, endY - y) / Math.max(.01, Number(extra.speed) || 1);
      const track = fx => {
        const part = Math.min(1, Math.max(0, (this.w.ofx.time - t0) / Math.max(.001, time)));
        const pose = { ...at, x: x + (endX - x) * part, y: y + (endY - y) * part };
        unitPoint(null, null, this.w.pose(pose), fx.anchor);
      };
      return this._hold(slot, owner, 'oxi_skill_03_trail_01', at, time,
        { toward: { x: endX, y: endY }, track }, null, true);
    }
    if (kind === 'oxiHeatwaveHit') return this._shot('oxi_skill_03_hit_01', at);
    if (kind === 'oxiGuard') return this._shot('oxi_skill_02_buff_02', source || at, duration, { follow: true });
    if (kind === 'oxiCounter') return this._shot('oxi_skill_02_hit_01', this.w.view(extra.target) || at);
    if (kind === 'tocka_mark') {
      const target = this.w.view(extra.target) || at;
      const key = extra.skill === 'skchr_tocka_1' ? 'tocka_skill_01_buff_02'
        : extra.skill === 'skchr_tocka_2' ? 'tocka_skill_02_buff_02' : 'tocka_skill_03_buff_05';
      return this._hold(`mark:${owner}:${extra.target}:${extra.skill}`, owner, key, target, 0, {}, extra.target);
    }
    if (kind === 'tocka_trigger') {
      this._stop(`mark:${owner}:${extra.target}:${extra.skill}`);
      const target = this.w.view(extra.target) || at;
      const key = extra.skill === 'skchr_tocka_1' ? 'tocka_skill_01_buff_01'
        : extra.skill === 'skchr_tocka_2' ? 'tocka_skill_02_buff_02' : 'tocka_skill_03_buff_06';
      const shot = extra.skill === 'skchr_tocka_1' ? 'tocka_skill_01_buff_02_start_01'
        : extra.skill === 'skchr_tocka_2' ? 'tocka_skill_02_hit_01' : 'tocka_skill_03_start_02';
      this._shot(shot, target);
      const drew = this._hold(`trigger:${owner}:${extra.target}:${extra.skill}`, owner, key, target,
        duration, {}, extra.target);
      if (extra.skill === 'skchr_tocka_3' && source) this._hold(`spring:${owner}`, owner, key, source, duration);
      return drew;
    }
    if (kind === 'tocka_snow') return this._hold(`snow:${owner}:${extra.target}`, owner,
      'tocka_attack_02_range_01', this.w.view(extra.target) || at, duration, {}, extra.target, true);
    if (kind === 'dminon_kingdom') { this._territory(owner, extra.tiles || []); return true; }
    if (kind === 'dminon_spread') {
      const tiles = extra.tiles || [];
      this._territory(owner, [...(this.territories.get(owner) || []), ...tiles]);
      let drew = false;
      for (const tile of tiles) drew = this._shot('dminon_skill_hit_01', tilePoint(tile)) || drew;
      return drew;
    }
    if (kind === 'dminon_collapse') {
      this._territory(owner, []);
      let drew = false;
      for (const tile of extra.tiles || []) drew = this._shot('dminon_talent_hit_01', tilePoint(tile)) || drew;
      return drew;
    }
    return false;
  }
  _enhance(view, on) {
    if (!view?.actor || view.info?.form) return;
    view.actor.setForm(on ? { attack: { begin: null, loop: 'Skill_2_Attack', end: null } } : null);
  }
  sync() {
    if (!this.w.ofx.active) return;
    for (const [slot, held] of this.held) {
      const owner = this.w.view(held.owner), target = held.target != null ? this.w.view(held.target) : null;
      if (this.w.ofx.time >= held.until || (!held.surviveOwner && (!owner || owner.alive === false || owner.destroyed))
        || (held.target != null && (!target || target.alive === false || target.destroyed))) { this._stop(slot); continue; }
      if (target) held.view = target;
      if (!held.handle?.alive) this._draw(held);
    }
    for (const [id, state] of this.enhanced) {
      const view = this.w.view(id);
      if (!view || view.alive === false || view.destroyed) { this.enhanced.delete(id); continue; }
      if (view.actor && state.actor !== view.actor) { this._enhance(view, true); state.actor = view.actor; }
    }
  }
  release(view) {
    const id = view?.id ?? view?.info?.id;
    this._enhance(view, false); this.enhanced.delete(id);
    for (const [slot, held] of this.held) if ((!held.surviveOwner && held.owner === id) || held.target === id) this._stop(slot);
    this.territories.delete(id);
  }
  clear() {
    for (const id of this.enhanced.keys()) this._enhance(this.w.view(id), false);
    for (const slot of this.held.keys()) this._stop(slot);
    this.territories.clear(); this.enhanced.clear();
  }
}
