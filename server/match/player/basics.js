import { PHASE } from "../../../shared/constants.js";
import { checkNotOwned, checkLoadout, checkLoadoutOps, cultivationCharIds, resolveLoadout, skinKeyForRecord } from "../../../shared/protocol.js";
import { tileKey, boardOrder } from "../board.js";

import { cultivationOf } from '../../../shared/potential.js';

const OPS_IDS = new WeakMap();
function opsCharIds(raw) {
  if (!raw || typeof raw !== 'object') return new Set();
  let ids = OPS_IDS.get(raw);
  if (!ids) { ids = cultivationCharIds(raw.chess, raw.backups); OPS_IDS.set(raw, ids); }
  return ids;
}

export class PlayerBasics {
  get isHumanActive() { return !this.isBot && !this.left; }

  get botControlled() { return this.isBot || this.left || this.autoplay; }

  get deployCap() { return Math.max(1, this.gd.deployCap + this.deployCapBonus, this.deployCapMin); }

  get deployCount() { let n = 0; for (const p of this.board.values()) if (p.kind === 'chess') n++; return n; }

  // Items may bypass the temporary-zone ready gate only in the entertainment
  // variants.  In simulation/ranked rooms an item in temp occupies one of the
  // finite slots until it is equipped, moved to hand, or expires at prep end.
  get tempEmpty() {
    const unlimitedItems = !this.m.ranked && (this.m.variant === 'entertainment_multi' ||
      this.m.variant === 'entertainment_cyclops' ||
      this.m.variant === 'entertainment_endless');
    return this.temp.every((x) => x == null || (unlimitedItems && x.kind === 'item'));
  }

  tempDue(piece) {
    const due = piece ? this._tempDue.get(piece.uid) : undefined;
    return Number.isInteger(due) ? due : this.prepsEnded;
  }

  _tempDueNow() {
    return this.prepsEnded + (this.m.phase === PHASE.PREP && this.ready ? 1 : 0);
  }

  _putTemp(i, piece) {
    this.temp[i] = piece;
    this._tempDue.set(piece.uid, this._tempDueNow());
  }

  skinFor(id) {
    const rec = this.fieldRecord(this.gd.chess(id));
    return this.skins[skinKeyForRecord(rec)] || null;
  }

  setLoadout(loadout, ops = undefined) {
    if (this.isBot) return false;
    let opsRes = null;
    if (ops !== undefined) {
      const raw = {};
      if (ops && typeof ops === 'object' && !Array.isArray(ops)) {
        for (const [id, e] of Object.entries(ops)) {
          if (!e || typeof e !== 'object') continue;
          const x = {};
          if (Number.isInteger(e.potential)) x.potential = e.potential;
          if (Number.isInteger(e.cultivate)) x.cultivate = e.cultivate;
          if (Object.keys(x).length) raw[id] = x;
        }
      }
      const ids = opsCharIds(this.gd.raw);
      opsRes = checkLoadoutOps(raw, (id) => ids.has(id));
      if (!opsRes || !opsRes.ok) {
        this.m.log?.warn?.(`[match ${this.m.roomCode}] operator settings of ${this.playerId} ignored: ${opsRes && opsRes.detail}`);
        return false;
      }
    }
    const entries = {};
    if (loadout && typeof loadout === 'object' && !Array.isArray(loadout)) {
      for (const [id, e] of Object.entries(loadout)) {
        if (!e || typeof e !== 'object') continue;
        const x = {};
        if (Number.isInteger(e.skill)) x.skill = e.skill;
        if (typeof e.module === 'string') x.module = e.module;
        if (Object.keys(x).length) entries[id] = x;
      }
    }
    const res = checkLoadout(entries, (id) => this.gd.chess(id));
    if (!res || !res.ok) {
      this.m.log?.warn?.(`[match ${this.m.roomCode}] loadout of ${this.playerId} ignored: ${res && res.detail}`);
      return false;
    }
    const out = {};
    for (const [id, e] of Object.entries(res.loadout)) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
    this.loadout = Object.freeze(out);
    if (opsRes) {
      const o = {};
      for (const [id, e] of Object.entries(opsRes.ops)) o[id] = Object.freeze({ potential: e.potential, cultivate: e.cultivate });
      this.ops = Object.freeze(o);
    }
    return true;
  }

  cultivationFor(chessRecord) {
    if (!chessRecord || this.fieldsStandIn(chessRecord)) return null;
    const rec = chessRecord.isDiy && typeof chessRecord.chessId === 'string' ? this.gd.chess(chessRecord.chessId) || chessRecord : chessRecord;
    return cultivationOf(rec, this.ops);
  }

  loadoutFor(chessRecord) {
    if (this.fieldsStandIn(chessRecord)) {
      return { ...resolveLoadout(null, this.gd.standIn(chessRecord.chessId), (id) => this.gd.standIn(id) || this.gd.chess(id)), potential: null, cultivate: null };
    }
    const rec = chessRecord && chessRecord.isDiy && typeof chessRecord.chessId === 'string' ? this.gd.chess(chessRecord.chessId) || chessRecord : chessRecord;
    // 0.2.2: with the operator's potential / 练度 (null for a prototype 自选 pick) — the 自选 summons' hand count reads it
    const cv = this.cultivationFor(chessRecord);
    return { ...resolveLoadout(this.loadout, rec, (id) => this.gd.chess(id)), potential: cv ? cv.potential : null, cultivate: cv ? cv.cultivate : null };
  }

  deployMap() {
    const field = typeof this.m.deployFieldOf === 'function' ? this.m.deployFieldOf(this) : 'normal';
    if (this._deployMap && this._deployField !== undefined && this._deployField !== field) {
      this._deployMap = null;
      this._legalityStale = true;
    }
    if (!this._deployMap) this._deployMap = this.m.deployMapFor(this, field);
    this._deployField = field;
    return this._deployMap;
  }

  invalidateDeployMap() { this._deployMap = null; this._legalityStale = true; }

  _evictIllegal() {
    this._legalityStale = false;
    const names = [];
    let moved = 0;
    for (const kind of ['chess', 'token']) {
      for (const { r, c, piece } of boardOrder(this.board)) {
        if (piece.kind !== kind || this._legal(piece, r, c)) continue;
        const key = tileKey(r, c);
        this.board.delete(key);
        const ok = kind === 'chess' ? !!this.stow(piece, { allowTemp: true }) : this._returnToken(piece);
        if (!ok) { this.board.set(key, piece); continue; }
        moved++;
        if (kind === 'chess') {
          this.removeTokensOf(piece.uid);
          const rec = this.gd.chess(piece.id);
          names.push(rec && rec.name ? rec.name : piece.id);
        }
      }
    }
    if (names.length) this.m.toast(this, 'warn', `地形变化：${names.join('、')}无法停留在原位置，已撤回整备区`);
    return moved;
  }

  dirty() { this.m.markPrivate(this); }
  setNotOwned(list) {
    if (this.isBot) return false;
    const res = checkNotOwned(list, (id) => this.gd.chess(id));
    if (!res || !res.ok) {
      this.m.log?.warn?.(`[match ${this.m.roomCode}] not-owned list of ${this.playerId} ignored: ${res && res.detail}`);
      return false;
    }
    const ids = res.notOwned.filter((id) => !!this.gd.standIn(id));
    this.standIns = Object.freeze(ids);
    this._standInSet = new Set(ids);
    return true;
  }
  fieldsStandIn(rec) {
    if (!this._standInSet || this._standInSet.size === 0 || !rec) return false;
    const r = typeof rec === 'string' ? this.gd.chess(rec) : rec;
    if (!r || typeof r.chessId !== 'string') return false;
    return this._standInSet.has(r.baseId || r.chessId) && !!this.gd.standIn(r.chessId);
  }
  fieldRecord(rec) {
    if (rec && this.fieldsStandIn(rec)) return this.gd.standIn(rec.chessId) || rec;
    if (rec && rec.isDiy && !rec.diyFor && typeof rec.chessId === 'string') return this.gd.chess(rec.chessId) || rec;
    return rec;
  }
}
