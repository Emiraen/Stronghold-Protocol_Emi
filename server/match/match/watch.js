

import { PHASE, ERR, GEO } from "../../../shared/constants.js";

import { boardOrder, pieceDir } from "../board.js";

import { snapFrame } from "../fields.js";

import { OK, fail } from "./common.js";
export class MatchWatch {
  _prepScoutSig(ps) {
    const parts = [];
    for (const { r, c, piece } of boardOrder(ps.board)) {
      const items = piece.kind === 'chess' && Array.isArray(piece.items) ? piece.items.map((it) => `${it.uid}:${it.id}`).join(',') : '';
      parts.push(`${piece.uid}:${piece.id}@${r},${c}:${pieceDir(piece)}:${items}`);
    }
    return parts.join(';');
  }

  _notifyPrepScouts(ps, { to = null } = {}) {
    if (!ps || !ps.alive || this.fields.length) return;
    const fid = `n:${ps.playerId}`;
    const watchers = this.watchersOf(fid);
    if (!watchers.length) return;
    for (const pid of watchers) if (!this.observers.has(pid)) this._sendObserverBench(pid, ps, fid, pid === to);
    const sig = this._prepScoutSig(ps);
    const changed = sig !== ps._prepScoutSig;
    ps._prepScoutSig = sig;
    const dest = changed ? watchers : (to ? [to] : []);
    if (!dest.length) return;
    const meta = this.prepFieldMeta(ps);
    for (const pid of dest) this.sendTo(pid, meta);
  }

  _sendField(playerId, fieldId) {
    const f = this.fields.find((x) => x.fieldId === fieldId);
    if (f) {
      let meta;
      try { meta = f.battle.fieldMeta(); } catch (e) { this.reportError('fieldMeta', e); return; }
      this.sendTo(playerId, { t: 'm.field', ...meta, fieldId: f.fieldId, kind: f.kind, live: !!f.live });
      try { this.sendTo(playerId, snapFrame(f.fieldId, f.battle.snapshot())); } catch (e) { this.reportError('snapshot', e); }
      return;
    }
    if (typeof fieldId === 'string' && fieldId.startsWith('n:')) {
      const target = this.players.get(fieldId.slice(2));
      if (target && target.alive) this.sendTo(playerId, this.prepFieldMeta(target));
    }
  }

  addObserver(playerId) {
    if (this.players.has(playerId) || this.disposed) return fail(ERR.BAD_TARGET);
    if (!this.observers.has(playerId)) this.observers.set(playerId, { target: null, key: null });
    this.sendTo(playerId, this.publicView());
    this.refreshObserver(playerId, true);
    return OK;
  }

  removeObserver(playerId) {
    this.observers.delete(playerId);
    this.watchers.delete(playerId);
  }

  watchObserver(playerId, fieldId, targetId) {
    const observer = this.observers.get(playerId);
    if (!observer) return fail(ERR.NOT_IN_ROOM);
    const field = this.fields.find((f) => f.fieldId === fieldId);
    const target = targetId ? this.players.get(targetId) : field ? this.players.get(field.players[0]) : String(fieldId).startsWith('n:') ? this.players.get(fieldId.slice(2)) : null;
    if (!target || !target.alive || target.left || (this.fields.length && !field)
      || (field ? !field.players.includes(target.playerId) : fieldId !== `n:${target.playerId}`)) return fail(ERR.BAD_TARGET);
    observer.target = target.playerId;
    this.refreshObserver(playerId, true);
    return OK;
  }

  _sendObserverBench(playerId, target, fieldId, force = false) {
    const observer = this.observers.get(playerId) || this.players.get(playerId);
    if (!observer) return;
    // 显式白名单复制，空槽原位保留；绝不发送 privateView 或原始 PlayerState。
    const pieceView = (piece, rc = null) => {
      if (!piece) return null;
      const view = target.pieceView(piece, rc);
      if (piece.kind === 'chess') {
        const rec = (target.gd || this.gd).chess(piece.id);
        const body = target.fieldRecord(rec);
        if (body?.standInFor) view.standInFor = body.standInFor;
        const pick = target.diyPickOf(piece.id);
        if (pick) view.diy = { ...pick };
        if (body && (body.standInFor || pick)) {
          view.name = body.name;
          view.spine = body.assets?.spine || body.charId;
          view.avatar = body.assets?.avatar || body.charId;
          view.maxHp = body.stats?.maxHp;
        }
        const lo = rec ? target.loadoutFor(rec) : null;
        if (lo) { view.skillIndex = lo.skillIndex; view.moduleId = lo.moduleId; }
      }
      return view;
    };
    const prep = [PHASE.PREP, PHASE.SP_DRAFT, PHASE.ROUND_START, PHASE.BATTLE_CHECK].includes(this.phase);
    const msg = { t: 'spectator.bench', playerId: target?.playerId || null, fieldId: fieldId || null, phase: this.phase,
      hand: target ? Array.from({ length: GEO.HAND_SIZE }, (_, i) => pieceView(target.hand[i])) : [],
      temp: target ? target.temp.map((piece) => pieceView(piece)) : [],
      board: prep && target ? boardOrder(target.board).map(({ r, c, piece }) => pieceView(piece, [r, c])) : [],
      deviceOverrides: prep && target ? { ...target.deviceOverrides } : {},
      tileOverrides: prep && target ? { ...target.tileOverrides } : {} };
    const sig = JSON.stringify(msg);
    if (!force && observer.benchSig === sig) return;
    if (this.sendTo(playerId, msg)) observer.benchSig = sig;
  }

  refreshObserver(playerId, force = false) {
    const observer = this.observers.get(playerId);
    if (!observer || this.disposed) return;
    if (this.phase === PHASE.RESULT) { this._sendObserverBench(playerId, null, null, force); return; }
    let target = this.players.get(observer.target);
    if (!target?.alive || target.left) target = this.order.find((p) => p.alive && !p.left);
    if (!target) {
      this.watchers.delete(playerId); observer.target = null; observer.key = null;
      this._sendObserverBench(playerId, null, null, force);
      return;
    }
    observer.target = target.playerId;
    const field = this.fields.find((f) => f.players.includes(target.playerId)) || this.fields[0];
    if (field) {
      const key = `${this.phase}:${field.battleId || field.fieldId}`;
      this.watchers.set(playerId, field.fieldId);
      if (force || observer.key !== key) {
        observer.key = key;
        if (field.cc) this.sendTo(playerId, this._startMsg(field, playerId, { watch: true }));
        else this._sendField(playerId, field.fieldId);
      }
    } else {
      const fid = `n:${target.playerId}`;
      const key = `${this.phase}:${fid}`;
      this.watchers.set(playerId, fid);
      const resend = force || observer.key !== key;
      observer.key = key;
      this._notifyPrepScouts(target, { to: resend ? playerId : null });
    }
    this._sendObserverBench(playerId, target, field?.fieldId || `n:${target.playerId}`, force);
  }

  watchersOf(fieldId) {
    const out = [];
    for (const [pid, fid] of this.watchers) if (fid === fieldId) out.push(pid);
    return out;
  }

  watch(ps, fieldId, viewOnly = false) {
    if (typeof fieldId !== 'string') return fail(ERR.BAD_TARGET);
    if (this.clientCombat && this.fields.length && this.fields.some((x) => x.cc)) return this._watchClient(ps, fieldId, viewOnly);
    const f = this.fields.find((x) => x.fieldId === fieldId);
    if (f) {
      // 最终攻势 / 隐秘核心: "两名参与者会处于同一个战场，但无法查看另一组队友的战场情况" — a fighting player sees its own
      // boss field only (eliminated / departed players spectate freely)
      const own = this.fieldOf(ps);
      if (!viewOnly && (f.kind === 'boss' || f.kind === 'hidden') && own && own !== f.fieldId) return fail(ERR.BAD_TARGET, 'other group hidden');
      this.watchers.set(ps.playerId, fieldId);
      this._sendField(ps.playerId, fieldId);
      return OK;
    }
    if (fieldId.startsWith('n:')) {
      // prep scouting, only while no battle field is up: during 各自行动 / 联防 / 最终攻势 / 隐秘核心 an 'n:<pid>' id
      // must name a live field (else the boss-group rule above could be bypassed, and the viewer would stop receiving
      // its own field's snapshots). The scout stays in `watchers` so a later board change pushes prepFieldMeta again
      // (GitHub #87); combat start clears the map and reassigns live fields, spectators included.
      if (this.fields.length) return fail(ERR.BAD_TARGET, 'no such field');
      const target = this.players.get(fieldId.slice(2));
      if (!target || !target.alive) return fail(ERR.BAD_TARGET);
      this.watchers.set(ps.playerId, fieldId);
      this._notifyPrepScouts(target, { to: ps.playerId });
      return OK;
    }
    return fail(ERR.BAD_TARGET);
  }

  _defaultWatch() {
    this.watchers.clear();
    for (const ps of this.humans()) {
      const own = this.fields.find((f) => f.players.includes(ps.playerId));
      const f = own || this.fields[0];
      if (!f) continue;
      this.watchers.set(ps.playerId, f.fieldId);
      if (ps.connected) this._sendField(ps.playerId, f.fieldId);
    }
  }

  _spectatorSpec(f) {
    if (!f.spectatorSpec) {
      const s = f.spec;
      const strip = (p) => {
        if (!p || !p.contentInfo || !Object.hasOwn(p.contentInfo, 'funds')) return p;
        const { funds, ...contentInfo } = p.contentInfo;
        void funds;
        return { ...p, contentInfo };
      };
      f.spectatorSpec = s && Array.isArray(s.players) ? { ...s, players: s.players.map(strip) } : s;
    }
    return f.spectatorSpec;
  }

  _humansShowing(f) {
    const out = new Set();
    for (const pid of f.players) out.add(pid);
    for (const [pid, fid] of this.watchers) if (fid === f.fieldId) out.add(pid);
    return [...out].filter((pid) => { const ps = this.players.get(pid); return this.observers.has(pid) || (ps && !ps.isBot && !ps.left); });
  }

  _watchClient(ps, fieldId, viewOnly = false) {
    const f = this.fields.find((x) => x.fieldId === fieldId) || null;
    if (!f) return fail(ERR.BAD_TARGET, 'no such field');
    const own = this.fields.find((x) => x.players.includes(ps.playerId)) || null;
    if (ps.alive && !viewOnly) {
      if ((f.kind === 'boss' || f.kind === 'hidden') && own && own !== f) return fail(ERR.BAD_TARGET, 'other group hidden');
      if (f.kind === 'normal' && own && own !== f && own.live) return fail(ERR.WRONG_PHASE, 'own battle running');
    }
    this.watchers.set(ps.playerId, f.fieldId);
    this.sendTo(ps.playerId, this._startMsg(f, ps.playerId, { watch: !f.players.includes(ps.playerId) }));
    return OK;
  }

  _resendBattle(ps) {
    if (!this.fields.some((f) => f.cc)) return;
    const fid = this.watchers.get(ps.playerId);
    let f = fid ? this.fields.find((x) => x.fieldId === fid) : null;
    if (!f) f = this.fields.find((x) => x.players.includes(ps.playerId)) || (this.phase === PHASE.UNITE ? this.fields[0] : null);
    if (!f && !ps.alive) f = this.fields[0] || null;
    if (!f) return;
    this.watchers.set(ps.playerId, f.fieldId);
    this.sendTo(ps.playerId, this._startMsg(f, ps.playerId, { watch: !f.players.includes(ps.playerId) }));
  }

  _watchBossFields(fields) {
    for (const ps of this.humans()) {
      const own = fields.find((f) => f.players.includes(ps.playerId)) || null;
      const f = own || fields[0];
      if (!f) continue;
      this.watchers.set(ps.playerId, f.fieldId);
      this._sendStart(ps.playerId, f, { watch: !own });
    }
  }
}
