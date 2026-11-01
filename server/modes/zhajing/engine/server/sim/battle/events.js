// server/sim/battle/events.js — Battle methods: client events (DESIGN §8.2 tuples, bounded buffer), the snapshot, field
// meta, fx and the sim log.
// Installed on Battle.prototype by server/sim/Battle.js (a method container: never instantiated; `this` is the battle).

import { EVENT_BUFFER_CAP } from '../constants.js';
import { elementView } from '../damage.js';
import { unitInfo, snapshotUnits, ammoView, wolfView, negView, coinView, mysticView, layerView, chargeView } from '../snapshot.js';

export class BattleEvents {
  fx(kind, params = {}) {
    const { x = 0, y = 0, ...extra } = params || {};
    this._ev(['fx', kind, Math.round(x * 100) / 100, Math.round(y * 100) / 100, extra]);
  }

  log(msg) {
    const k = 'log:' + msg;
    if (this._errKeys.has(k)) return;
    this._errKeys.add(k);
    if (this.opts.verbose) this.logger.warn?.(`[sim] ${msg}`);
  }

  _ev(tuple) {
    if (!this.recordEvents) return;
    this._evq.push(tuple);
    if (this._evq.length > EVENT_BUFFER_CAP) this._evq.splice(0, this._evq.length - EVENT_BUFFER_CAP / 2);
  }

  /** Client-facing events since the last drain (DESIGN §8.2 tuples). */
  drainEvents() {
    const ev = this._evq;
    this._evq = [];
    return ev;
  }

  /**
   * Compact full snapshot of this field (DESIGN §8.2 b.snap), plus (only when non-empty):
   *   down: [[id, respawnAt, respawnTime, state, row, col]] — operators that left the field waiting to redeploy (isDown): the
   *         game time their respawn timer ends, its length (s), constants.js DOWN_STATE and the tile they lie on (and
   *         come back on: _layBody — where they fell, or their home);
   *   elem: [[id, element, fill, cooldownEnd, cooldown]] — the element gauge each unit shows (damage.js elementView).
   *   dmg:  [[charId, dmg, ownerId]] — DPS 面板(本场战斗每名我方干员的输出,battle.dmgByOp;前端按 owner
   *         过滤 + 按干员合并 + 排序 + 总伤).
   */
  snapshot() {
    const snap = {
      fieldId: this.fieldId,
      t: Math.round(this.time * 1000) / 1000,
      units: snapshotUnits(this.units, this.time),
      dp: this.players.length ? Math.floor(this.players[0].dp) : 0,
      killed: this.killed,
      total: this.total,
    };
    if (this.players.length > 1) {
      snap.dps = {};
      for (const p of this.players) snap.dps[p.playerId] = Math.floor(p.dp);
    }
    // DPS 面板: [[干员 id, 累计伤害, ownerId]] —— 本场战斗每名我方干员的输出。前端按 owner 过滤(观战他人时
    // 只看被观战人的)、按干员合并成一行、再按伤害降序排,最上面显示总伤。
    // 注意字段名是 `dmg` 不是 `dps`: `snap.dps` 已经是【出击费用(DP)】,见上面那几行。
    if (this.dmgByOp.size) {
      const rows = [];
      for (const v of this.dmgByOp.values()) rows.push([v.id, Math.round(v.dmg), v.ownerId]);
      snap.dmg = rows;
    }
    if (this.sharedBoss) snap.boss = { hp: Math.max(0, Math.round(this.sharedBoss.hp)), max: Math.round(this.sharedBoss.maxHp) };
    const r2 = (v) => Math.round(v * 100) / 100;
    let down = null;
    for (const u of this.allyUnits) {
      if (!this.isDown(u)) continue;
      (down || (down = [])).push([u.id, r2(u.respawnAt), r2(Math.max(0, u.respawnAt - u.deathAt)), this._downState(u), ...this.restTile(u)]);
    }
    if (down) snap.down = down;
    let elem = null, ammo = null, wolves = null, neg = null, energy = null, layers = null, charges = null, scale = null;
    for (const u of this.units) {
      if (!u.alive || !u.deployed || u.hidden) continue;
      const v = elementView(u, this.time);
      if (v) (elem || (elem = [])).push([u.id, v[0], v[1], v[2], v[3]]);
      const am = ammoView(u);
      if (am) (ammo || (ammo = [])).push([u.id, am[0], am[1]]);
      const wv = wolfView(u);
      if (wv) (wolves || (wolves = [])).push([u.id, wv[0], wv[1]]);
      const ng = negView(u);
      if (ng) (neg || (neg = [])).push([u.id, ng]);
      const purse = coinView(u);
      if (purse) (snap.coins || (snap.coins = [])).push([u.id, ...purse]);
      const en = mysticView(u);
      if (en) (energy || (energy = [])).push([u.id, en[0], en[1]]);
      const ly = layerView(u);
      if (ly) (layers || (layers = [])).push([u.id, ly]);
      const ch = chargeView(u);
      if (ch) (charges || (charges = [])).push([u.id, ch[0], ch[1]]);
      // ★ 2026-10-26（owner）：纯视觉缩放（心之钢等）——只在非 1 时下发
      const vs = Number(u.visualScale);
      if (Number.isFinite(vs) && vs > 0 && vs !== 1) (scale || (scale = [])).push([u.id, r2(vs)]);
    }
    if (elem) snap.elem = elem;
    if (ammo) snap.ammo = ammo;
    if (wolves) snap.wolves = wolves;
    if (neg) snap.neg = neg;
    if (energy) snap.energy = energy;
    if (layers) snap.layers = layers;
    if (charges) snap.charges = charges;
    if (scale) snap.scale = scale;
    return snap;
  }

  /**
   * Field meta for m.field: { fieldId, kind, rect, stageId, units: UnitInfo[] } — the units on the field, knocked-out
   * operators waiting to redeploy included (a client joining mid-battle shows them down).
   */
  fieldMeta() {
    return {
      fieldId: this.fieldId, kind: this.kind, rect: { ...this.rect }, stageId: this.stageId,
      units: this.units.filter((u) => (u.alive && u.deployed && !u.hidden) || this.isDown(u)).map(unitInfo),
    };
  }
}
