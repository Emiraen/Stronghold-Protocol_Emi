// server/match/player/basics.js — PlayerState methods: the basics — seat flags and counts (isHumanActive,
// botControlled, deployCap, deployCount, tempEmpty), the prep that resolves a temp piece (tempDue, _putTemp: every
// write into a temp slot), the operator loadout (DESIGN §16: setLoadout, loadoutFor), the not-owned operators fielded
// as their stand-ins (0.2.0 补位: setNotOwned, fieldsStandIn, fieldRecord), the deploy map on the field the
// player deploys on (Match.deployFieldOf) and the withdrawal of pieces a terrain / deploy-field change left on tiles
// they may no longer occupy (_evictIllegal), dirty.
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { PHASE } from '../../../shared/constants.js';
import { msg, dn } from '../../../shared/i18n.js';
import { checkLoadout, checkNotOwned, resolveLoadout, checkLoadoutOps, cultivationCharIds, checkLoadoutBans } from '../../../shared/protocol.js';
import { tileKey, boardOrder } from '../board.js';

export class PlayerBasics {
  get isHumanActive() { return !this.isBot && !this.left; }
  /** The engine acts for this seat (AI teammate or "AI 托管"; a departed human is eliminated, so nothing is left to do). */
  get botControlled() { return this.isBot || this.left || this.autoplay; }

  /**
   * 最大可部署人数 = 基础（gd.deployCap，默认 8）+ 加成（deployCapBonus，如惊变「人事部文件夹」+2）
   * + 基线差额（deployCapMin，如装备「人事部文档」把基线抬到 9 → 差额 1）。
   *
   * ★ 2026-10-16 修 bug（玩家反馈「人事部文件夹和人事部文档无法叠加生效，叠加后应该能部署 11 个人」）：
   *   原来是 `Math.max(1, gd.deployCap + deployCapBonus, deployCapMin)` —— 那个 `max` **会吃掉加法**：
   *   基础 8 + 文件夹 2 = 10，而 max(10, 9) = 10，文档那 1 点净增益被抹掉（文件夹的 +2 实际只生效 1）。
   *   现在 `deployCapMin` 的语义是「相对基础要额外补的差额」（由 effectsMeta.setDeployCapAtLeast 写入），
   *   三项**相加**：文档 9 + 文件夹 2 = **11** ✓；单独吃文档 = 9 ✓（与卡面「变为9」一致）。
   *   下限保护只剩 `Math.max(1, …)`（人数不能为 0 或负）。
   */
  get deployCap() { return Math.max(1, this.gd.deployCap + this.deployCapBonus + this.deployCapMin); }
  /**
   * 已占用的可部署位数。
   * ★ 2026-10-17（用户：「我在剩余1的时候放了它会变成0然后也放不了其他干员…可以改成不吃那个人数吗」）：
   *   带「不占用可部署位置」卫戍特质（`bb.no_deploy_slot > 0`，目前是虎狼丸）的干员**不计入**。
   *   这样它既不会被上限挡住（`placement.js` 的 `noDeploySlot` 放行），也不会占掉别人的名额，
   *   右下角「剩余可放置角色」也就不会因为放它而减少。
   *   原注释曾担心 bot 摆位 / deployCap 视图 / 审计会受影响 —— 那些都只是"数了几个人"，
   *   把不占位的排除掉在语义上是对的。
   */
  get deployCount() {
    let n = 0;
    for (const p of this.board.values()) {
      if (p.kind !== 'chess') continue;
      const rec = this.gd && this.gd.chess ? this.gd.chess(p.id) : null;
      const gids = rec && Array.isArray(rec.garrisonIds) ? rec.garrisonIds : null;
      let exempt = false;
      if (gids) {
        for (const gid of gids) {
          const g = this.gd.garrison(gid);
          if (g && g.bb && Number(g.bb.no_deploy_slot) > 0) { exempt = true; break; }
        }
      }
      if (!exempt) n++;
    }
    return n;
  }
  get tempEmpty() { return this.temp.every((x) => x == null); }

  /**
   * Index of the prep whose deadline resolves a temp piece (compare with `prepsEnded`): recorded when the piece entered
   * temp (_putTemp); a piece put there by other means counts as due at the current (or next) prep.
   */
  tempDue(piece) {
    const due = piece ? this._tempDue.get(piece.uid) : undefined;
    return Number.isInteger(due) ? due : this.prepsEnded;
  }

  /**
   * Due prep of a piece entering temp now: the current prep while the player can still act on it (PREP, not ready);
   * after Ready or at the prep end (onPrepEnd grants) the next one; outside PREP (COMBAT, SETTLE, ROUND_START, 机变)
   * the next prep to end — `prepsEnded` then already names it.
   */
  _tempDueNow() {
    return this.prepsEnded + (this.m.phase === PHASE.PREP && this.ready ? 1 : 0);
  }

  /** Every write of a piece into a temp slot goes through here (records its due prep). */
  _putTemp(i, piece) {
    this.temp[i] = piece;
    this._tempDue.set(piece.uid, this._tempDueNow());
  }

  /**
   * Replace the operator loadout (DESIGN §16) after re-checking it against this match's data. Accepts the checked
   * form `{ id: { skill, module|null } }` or raw `room.loadout` entries. Returns false (loadout unchanged) when it does
   * not fit the data; bots keep the defaults.
   * @param {any} loadout
   * @returns {boolean}
   */
  setLoadout(loadout) {
    if (this.isBot) return false;
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
    return true;
  }

  /**
   * 干员皮肤 (docs/SKINS.md): replace this player's skin choices, `{ [chessId]: skinId }`.
   *
   * Every id is re-checked against this match's data the same way `setLoadout` does, because the selection arrives
   * from a client and the match's bans may have removed a chess since it was made. Two shapes are accepted:
   *   * a `char_*` id (or a DIY slot id) — the 自选编队 slots are keyed by character, and their skin is chosen once
   *     for the slot rather than per composed chess;
   *   * a plain chess id — accepted only when it IS the base (a golden/variant `baseId !== id` record would share
   *     the base's model anyway, so allowing it would just be a second way to say the same thing).
   *
   * An empty map is legitimate and means "every chess on its default model".
   * @param {Record<string, string>|null} skins
   * @returns {boolean} whether anything was accepted
   */
  setSkins(skins) {
    if (this.isBot) return false;
    const out = {};
    if (skins && typeof skins === 'object' && !Array.isArray(skins)) {
      for (const [id, skinId] of Object.entries(skins)) {
        if (typeof skinId !== 'string' || !skinId) continue;
        if (typeof id === 'string' && (id.startsWith('char_') || (id.startsWith('chess_char_') && id.includes('_diy')))) {
          out[id] = skinId;
          continue;
        }
        const rec = this.gd.chess(id);
        // ★ 2026-10-16（用户：初雪/银灰/圣聆初雪的战斗小人还是原皮）—— lobby.freezeSkins 早已为
        //   【炸惊棋库的卡（visible === false 且 zhajing === true）】开了豁免（见 server/lobby.js 2026-10-15 的注释），
        //   但这里漏了：进入对局时 PlayerState.setSkins 会把这些条目**再丢一次**，于是 this.skins 里根本没有
        //   炸惊形态的键 ⇒ skinOfPiece 解析不出 ⇒ 战斗小人用默认模型（lobby 放行、match 丢弃 = 白修）。
        //   两处口径必须一致：记录存在、不是精锐/隐藏、且（可见 或 是炸惊专用卡）。普通模式行为不变。
        const okVisible = !!rec && rec.visible !== false;
        const zjOnly = !!rec && rec.visible === false && rec.zhajing === true;
        if (!rec || rec.isGolden || rec.isHidden || (rec.baseId && rec.baseId !== id) || !(okVisible || zjOnly)) continue;
        out[id] = skinId;
      }
    }
    this.skins = Object.freeze(out);
    if (this.m?._privDirty) this.dirty();
    return Object.keys(out).length > 0;
  }

  /**
   * 干员潜能 / 练度 (0.2.2, the owner's decision of 2026-10-08 「调配干员里自己设置吧，默认满潜满加成」): replace this
   * player's per-operator settings, `{ [charId]: { potential?: 1–6, cultivate?: 0–3 } }`.
   *
   * Keyed by charId, not chess id: the normal, elite and 自选 forms of one operator share one setting, and a skin
   * chosen for the operator clothes every form (same key space as `setSkins`). Re-checked against this match's data
   * exactly like `setLoadout` — the ids `cultivationCharIds` accepts (the visible normal chess plus the owned 自选
   * pool). Entries equal to the defaults are dropped, so an empty map means "everything at 潜能 6 / 精英2 Lv.60".
   * @param {any} ops
   * @returns {boolean} whether the settings were accepted（**不是**"结果非空"，见下）
   */
  setOps(ops) {
    if (this.isBot) return false;
    const allowed = cultivationCharIds(this.gd.raw?.chess, this.gd.raw?.backups);
    const res = checkLoadoutOps(ops, (id) => allowed.has(id));
    if (!res || !res.ok) {
      this.m.log?.warn?.(`[match ${this.m.roomCode}] operator settings of ${this.playerId} ignored: ${res && res.detail}`);
      return false;
    }
    const out = {};
    for (const [id, e] of Object.entries(res.ops)) {
      out[id] = Object.freeze({ potential: e.potential, cultivate: e.cultivate });
    }
    this.ops = Object.freeze(out);
    if (this.m?._privDirty) this.dirty();
    // ★ 2026-10-12（用户反馈：boss 关里"下面的干员完全点不了"，控制台 `room.loadout refused BAD_TARGET operator /
    //   settings do not match the game data`）：这里原来返回 `Object.keys(out).length > 0` —— 也就是"结果非空"。
    //   但空表是**合法状态**（全部满潜满练度），而"不认识的干员"按 checkLoadoutOps 的口径是**只丢这一条**。
    //   于是只要玩家的设置全是默认值、或全被丢弃（炸惊花名册里 visible:false 的干员就是这种），
    //   platform.setLoadout 就会把它当成"数据不匹配"→ BAD_TARGET → 整份 room.loadout（含 entries / bans）被拒，
    //   客户端与服务器的配发/潜能/练度全部同步不上，局内干员交互随之失效。
    //   判定的正确含义是"这次设置被接受了"—— 调用方（platform.js:76）只拿它做 ok/fail 判断。
    return true;
  }

  /**
   * The 潜能 / 练度 this player set for an operator (`charId`), or null when it is at the defaults. A 补位 stand-in
   * and a prototype 自选 pick never take them (another operator's body), so the caller only asks for a real one.
   * @param {string|null|undefined} charId
   * @returns {{ potential: number, cultivate: number } | null}
   */
  opsFor(charId) {
    const ops = this.ops;
    if (!ops || typeof ops !== 'object' || typeof charId !== 'string') return null;
    return ops[charId] ?? null;
  }

  /**
   * 卡池预选 (the 100-seat variant's own feature): replace this player's 盟约 ban picks — the profile of
   * shared/banPick.js, keyed by difficulty; only the difficulty the match runs with is used.
   *
   * Re-checked against this match's data exactly like `setOps`: an unknown 盟约 id or a 小盟约 marked 「特别关心 ❤」
   * is refused, the lists are cleaned against the difficulty quotas and a favourited 盟约 is lifted out of the ban
   * list. The picks only take effect through `initBanPick` (player/rules.js), which the match runs at setup — a room
   * that already started a match stores them for the NEXT one (the pool of a running match is fixed).
   * @param {any} bans the profile, or a single difficulty's entry
   * @returns {boolean} whether anything was accepted
   */
  setBans(bans) {
    if (this.isBot) return false;
    const gd = this.gd;
    const res = checkLoadoutBans(bans, {
      quota: (d) => gd.bans(d),
      bond: (b) => gd.bond(b),
    });
    if (!res || !res.ok) {
      this.m.log?.warn?.(`[match ${this.m.roomCode}] ban picks of ${this.playerId} ignored: ${res && res.detail}`);
      return false;
    }
    this.bans = Object.freeze(res.bans);
    // a running match keeps the pool it started with; recomputing here would swap a live player's shop mid-match
    if (this.m.phase === PHASE.LOBBY) this.initBanPick(this.bans, null);
    if (this.m?._privDirty) this.dirty();
    return true;
  }

  /**
   * The skinId to draw for a piece of this player (docs/SKINS.md), or null for the default model.
   *
   * The lookup order matches `Match.publicView` / the client's `pieceInfo`: the base chess id first (a variant with
   * `baseId !== id` shares the base's model, and `setSkins` only ever stored base ids), then the piece's own id, then
   * the character of a 自选 pick. `skinOfPiece` is deliberately tolerant of a missing record: it is called while the
   * battle input is being built, and a piece whose chess record is gone must still deploy.
   *
   * @param {string} pieceId
   * @param {{ charId?: string } | null} [pick] the 自选 pick of the slot this piece fills, when it fills one
   * @returns {string|null}
   */
  skinOfPiece(pieceId, pick = null) {
    const skins = this.skins;
    if (!skins || typeof skins !== 'object') return null;
    const rec = this.gd.chess(pieceId);
    const baseId = rec?.baseId || pieceId;
    // `rec.charId` is a different key space from the chess id (`char_498_inside` vs `chess_char_1_01_a`) and is
    // exactly the key a 自选 slot stores its skin under (the picker offers one skin per operator). Checking it here
    // means a skin chosen for an operator also clothes every chess that operator appears as — which is what a player
    // who picked it on the 换装 tab expects, whatever route the piece took onto the board.
    return skins[baseId] || skins[pieceId] || (rec?.charId ? skins[rec.charId] : null) || (pick && pick.charId ? skins[pick.charId] : null) || null;
  }

  /**
   * The skill index / module a chess record fights with under this player's loadout (DESIGN §16) — for a chess this
   * player fields as its stand-in (0.2.0 补位) the stand-in's backup selection, whatever the loadout says; for a slotted
   * 自选 slot (0.2.0, player/diy.js) its pick's skill and module (the composed record's defaults — the loadout never names
   * a DIY slot: shared/protocol.js checkLoadout).
   */
  loadoutFor(chessRecord) {
    if (this.fieldsStandIn(chessRecord)) {
      return resolveLoadout(null, this.gd.standIn(chessRecord.chessId), (id) => this.gd.standIn(id) || this.gd.chess(id));
    }
    const rec = chessRecord && chessRecord.isDiy && typeof chessRecord.chessId === 'string' ? this.gd.chess(chessRecord.chessId) || chessRecord : chessRecord;
    return resolveLoadout(this.loadout, rec, (id) => this.gd.chess(id));
  }

  /**
   * Replace the not-owned list (0.2.0 补位; the seat's list at the match start — the setting never changes during a
   * match): keeps the droppable chess (checkNotOwned) whose stand-in this match's data has. Bots own every operator.
   * @param {any} list base chess ids
   * @returns {boolean} false when the list is malformed (nothing changes) or the player is a bot
   */
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

  /**
   * Whether this player's piece of chess record (or id) `rec` fights as its stand-in (0.2.0 补位): its base chess is
   * in `standIns` and the data has the stand-in. Normal and elite alike (the elite uses the same backup).
   * @param {object|string|null} rec
   */
  fieldsStandIn(rec) {
    if (!this._standInSet || this._standInSet.size === 0 || !rec) return false;
    const r = typeof rec === 'string' ? this.gd.chess(rec) : rec;
    if (!r || typeof r.chessId !== 'string') return false;
    return this._standInSet.has(r.baseId || r.chessId) && !!this.gd.standIn(r.chessId);
  }

  /**
   * The record this player's piece of chess record `rec` fights with (0.2.0 补位): the stand-in record
   * (gd.standIn — the chess's identity, the stand-in's body) when the player fields its stand-in; for a DIY slot record
   * the player's 自选 record of that slot (this.gd — a caller holding the match's own record of the slot gets the
   * operator); else `rec` itself. Rules about the unit's body read it (placement class, summon / bot ranges), and so
   * does what shows the piece (the scouting art, the elite / gift tickers' names — the owner's recall of 2026-10-06: the official
   * mode shows the stand-in everywhere); rules about the chess (price, bonds, 特质, merges, pools) keep reading gd.chess.
   * @param {object|null} rec
   */
  fieldRecord(rec) {
    if (rec && this.fieldsStandIn(rec)) return this.gd.standIn(rec.chessId) || rec;
    if (rec && rec.isDiy && !rec.diyFor && typeof rec.chessId === 'string') return this.gd.chess(rec.chessId) || rec;
    return rec;
  }

  /**
   * Deploy classes of the board tiles (server/match/board.js buildDeployMap) on the field the player deploys on now
   * (Match.deployFieldOf: the own board, or its half of the boss field in a boss round — user playtest #5 item 7).
   * A change of that field (the boss round begins, a re-pairing) re-checks the board's legality like a terrain change.
   */
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
  /**
   * The board's terrain changed (terrain 机变 cards, content device / tile overrides): legality is re-checked at the
   * next recompute() / battleInput() — after the whole change, so an intermediate state of a card that toggles several
   * devices never moves a piece.
   */
  invalidateDeployMap() { this._deployMap = null; this._legalityStale = true; }

  /**
   * After a terrain change, pieces standing on tiles they may no longer occupy (a melee operator on a tile that became
   * a 射击台, anything on a tile that became undeployable) are withdrawn like 撤退: an operator goes to the hand
   * (overflow temp — a passive move; the player re-places it during the prep), its summons leave the board with it; a
   * summon returns to its owner's stack. Nothing is lost: with the hand and temp both full a piece stays put.
   * @returns {number} pieces moved
   */
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
    if (names.length) this.m.toast(this, 'warn', msg('地形变化：{names}无法停留在原位置，已撤回整备区', { names: names.map(dn) }));
    return moved;
  }

  dirty() { this.m.markPrivate(this); }
}
