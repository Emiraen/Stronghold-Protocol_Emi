

import { PHASE } from "../../../shared/constants.js";

import { DELAYS } from "./common.js";
import { markSend } from '../../sendMetadata.js';
export class MatchMessaging {
  sendTo(playerId, msg) {
    if (this.disposed) return false;
    const ps = this.players.get(playerId);
    if (msg?.t === 'spectator.bench' && !this.observers.has(playerId)) {
      const target = this.players.get(msg.playerId);
      if (!ps || !target?.alive || target.left || target === ps || this.fields.length
        || ![PHASE.PREP, PHASE.SP_DRAFT, PHASE.ROUND_START, PHASE.BATTLE_CHECK].includes(this.phase)
        || msg.phase !== this.phase || msg.fieldId !== `n:${target.playerId}`
        || this.watchers.get(playerId) !== msg.fieldId) return false;
    }
    const observer = this.observers.has(playerId) && ['m.public', 'm.field', 'b.start', 'b.snap', 'b.ev', 'b.end', 'spectator.bench'].includes(msg?.t);
    if (!observer && (!ps || ps.isBot || ps.left)) return false;
    try { return !!this.sendFn(playerId, msg); } catch (e) { this.reportError('send', e); return false; }
  }

  broadcast(msg) {
    if (this.disposed) return;
    try { this.broadcastFn(msg); } catch (e) { this.reportError('broadcast', e); }
    if (msg?.t === 'm.public') {
      for (const pid of this.observers.keys()) {
        try { this.refreshObserver(pid); }
        catch (e) { this.reportError(`broadcast observer ${pid}`, e); }
      }
      if (!this.fields.length) for (const [pid, fid] of this.watchers) {
        if (this.observers.has(pid) || !fid.startsWith('n:')) continue;
        const target = this.players.get(fid.slice(2));
        if (target?.alive && !target.left) {
          try { this._sendObserverBench(pid, target, fid); }
          catch (e) { this.reportError(`broadcast scout ${pid}`, e); }
        }
      }
    }
  }

  toast(ps, kind, text) {
    if (!ps || ps.isBot || ps.left || !ps.connected) return;
    this.sendTo(ps.playerId, { t: 'm.toast', kind, text });
  }

  tickerFor(type, args = [], { playerId = null, to = null, param = null } = {}) {
    const list = Array.isArray(this.gd.config.broadcasts) ? this.gd.config.broadcasts.filter((b) => b && b.type === type) : [];
    let b = list[0];
    if (param != null) b = list.find((x) => Array.isArray(x.params) && x.params.includes(String(param))) || b;
    const tpl = b && typeof b.text === 'string' ? b.text : null;
    if (!tpl) return;
    const text = tpl.replace(/\{(\d)\}/g, (_, i) => (args[Number(i)] != null ? String(args[Number(i)]) : ''));
    const msg = { t: 'm.ticker', text, id: b.id, type, priority: Number(b.priority) || 0, playerId };
    if (to) this.sendTo(to, msg);
    else this.broadcast(msg);
  }

  tickerText(text, priority = 0) {
    if (!text) return;
    this.broadcast({ t: 'm.ticker', text: String(text).slice(0, 200), id: null, type: 'CUSTOM', priority: Number(priority) || 0, playerId: null });
  }

  markPublic() { this._pubDirty = true; this._persistRev = (this._persistRev | 0) + 1; }

  markPrivate(ps) { if (ps) { this._privDirty.add(ps); this._pubDirty = true; } }

  flush(forcePublic = false) {
    if (this.disposed) return;
    const scope = `${this.phase}:${this.round}:${!!this.paused}:${this.deadline}`;
    const boundary = forcePublic || this._lastFlowScope !== scope;
    if (boundary) for (const ps of this.players.values()) this._privDirty.add(ps);
    if (this._privDirty.size) {
      const list = [...this._privDirty];
      this._privDirty.clear();
      for (const ps of list) {
        if (!(ps.isBot || ps.left || !ps.connected)) {
          try { this._sendPrivate(ps, false, boundary); }
          catch (e) { this._privDirty.add(ps); this.reportError(`flush private player ${ps.playerId}`, e); }
        }
        try { this._notifyPrepScouts(ps); }
        catch (e) { this._privDirty.add(ps); this.reportError(`flush scouts player ${ps.playerId}`, e); }
        // 库存变化可能不改变公开视图，仍须更新正在看该玩家的外部观众。
        for (const [pid, observer] of this.observers) if (observer.target === ps.playerId) {
          try { this.refreshObserver(pid); }
          catch (e) { this._privDirty.add(ps); this.reportError(`flush observer ${pid} player ${ps.playerId}`, e); }
        }
      }
    }
    if (this._pubDirty || forcePublic) this._maybeSendPublic(forcePublic);
  }

  _sendPrivate(ps, force, core = force) {
    let view;
    try { view = ps.privateView(); } catch (e) {
      if (force) throw e;
      this._privDirty.add(ps);
      this.reportError('privateView', e); return;
    }
    const json = JSON.stringify(view);
    if (!core && json === ps._lastPriv) return;
    const sent = this.sendTo(ps.playerId, markSend(view, {
      priority: core ? 'high' : 'medium', key: 'm.private', periodic: !core,
    }));
    if (sent) ps._lastPriv = json;
    // A failed online send must not turn into a successful de-duplication on
    // the next flush. Offline players receive a forced full view on reconnect.
    else if (ps.connected && !ps.isBot && !ps.left) this._privDirty.add(ps);
  }

  _maybeSendPublic(force) {
    const now = this.sched.now();
    const currentScope = `${this.phase}:${this.round}:${!!this.paused}:${this.deadline}`;
    if (!force && currentScope === this._lastFlowScope && now - this._lastPubAt < DELAYS.PUBLIC_THROTTLE) {
      if (!this._pubTimer) {
        const wait = Math.max(1, DELAYS.PUBLIC_THROTTLE - (now - this._lastPubAt));
        this._pubTimer = this.sched.setTimeout(() => {
          this._pubTimer = null;
          if (this.disposed) return;
          try { this._maybeSendPublic(false); } catch (e) { this.reportError('public', e); }
        }, wait);
      }
      return;
    }
    let view, json;
    try {
      view = this.publicView();
      const { serverNow, ...rest } = view;
      json = JSON.stringify(rest);
    } catch (e) {
      this._pubDirty = true;
      this.reportError('publicView', e);
      return;
    }
    this._pubDirty = false;
    if (!force && json === this._lastPubJson) return;
    this._lastPubJson = json;
    this._lastPubAt = now;
    const scope = `${view.phase}:${view.round}:${!!view.paused}:${view.deadline}`;
    const boundary = force || this._lastFlowScope !== scope;
    this._lastFlowScope = scope;
    this.broadcast(markSend(view, {
      priority: boundary ? 'high' : 'medium', key: 'm.public', periodic: !boundary,
      clearBattle: boundary && !['COMBAT', 'UNITE', 'FINAL_ASSAULT', 'HIDDEN_CORE'].includes(view.phase),
    }));
  }
}
