// server/match/match/views.js — Match methods: the state builders — m.public (publicView with statusOf / fieldOf, the
// fields' progress, the teammates' live pendingLp / uniteLeft, the SETTLE uniteResult), the nextEnemies preview of
// m.private and the prep scout's m.field (prepFieldMeta: board, hand and temp as units, the scouted player's effects and
// coming enemies; in a boss round's prep on the player's half of the boss field).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO, handTileOf, tempTileOf } from '../../../shared/constants.js';
import { boardOrder, pieceDir } from '../board.js';
import { bondList, offBondCounts } from '../bondsMeta.js';
import { cardView } from '../choices.js';
import { bountySpawns, previewOf } from '../waves.js';
import { timelineAt } from '../fields.js';
import { bossFieldPlacement } from '../finalAssault.js';
import { battleProgress } from '../../sim/spec.js';
import { BAND_DRAFT_SECONDS } from './common.js';

export class MatchViews {
  statusOf(ps) {
    if (ps.left) return 'left';
    if (!ps.alive) return 'dead';
    switch (this.phase) {
      case PHASE.INFO_CHECK: return ps.infoReady ? 'ready' : 'deciding';
      case PHASE.BAND_DRAFT:
        if (this.draft && this.draft.picks[ps.playerId]) return 'ready';
        return this.draft && this.draftTurn() === ps.playerId ? 'deciding' : 'acting';
      case PHASE.SP_DRAFT: {
        // per squad: the player's own squad draft decides 'ready' / 'deciding'
        const sd = this.sp ? this.spOf(ps) : null;
        if (sd && sd.picks[ps.playerId] != null) return 'ready';
        return sd && this.spTurnOf(sd) === ps.playerId ? 'deciding' : 'acting';
      }
      case PHASE.PREP: return ps.ready ? 'ready' : 'acting';
      case PHASE.COMBAT: case PHASE.FINAL_ASSAULT: case PHASE.HIDDEN_CORE: {
        const f = this.fields.find((x) => x.players.includes(ps.playerId));
        return f && f.live ? 'combat' : 'done';
      }
      case PHASE.UNITE: return this.unitePlan && this.unitePlan.helpers.includes(ps) ? 'helping' : 'done';
      case PHASE.ROUND_START: return 'acting';
      default: return 'done';
    }
  }

  fieldOf(ps) {
    const f = this.fields.find((x) => Array.isArray(x.leakers) && x.leakers.includes(ps.playerId))
      || this.fields.find((x) => x.players.includes(ps.playerId));
    return f ? f.fieldId : null;
  }

  /**
   * Which seats' `bonds` the public snapshot carries (the bandwidth trim above): every player on a field somebody is
   * watching. `watchers` changes in half a dozen places (watch.js, combat.js, bossRounds.js, phases.js — each clears
   * or fills it), so rather than requiring an invalidate call at every one of them this compares a cheap signature:
   * a missed hook would silently blank a watched board, which is exactly the kind of bug that hides for weeks.
   * @returns {Set<string>} playerIds whose bonds are included
   */
  bondsShownSet() {
    // 缓存签名要带上「共享战场上有谁」：watchers 不变但进入/离开联防、换了一对人时，集合必须重算。
    const sharedSig = Array.isArray(this.fields)
      ? this.fields.filter((f) => f && typeof f.fieldId === 'string' && (f.fieldId === 'u' || f.fieldId.startsWith('b')))
        .map((f) => f.fieldId + ':' + (Array.isArray(f.players) ? f.players.join('+') : '')).sort().join('|')
      : '';
    const sig = (this.watchers && this.watchers.size
      ? [...this.watchers.entries()].map(([a, b]) => a + '>' + b).sort().join(',')
      : '') + '#' + sharedSig;
    if (this._bondsShown && this._bondsShownSig === sig) return this._bondsShown;
    const out = new Set();
    // Spectator seats (Match.spectators, a separate map — NOT part of this.order) read the watched board through
    // `watchBonds.ownerBonds`, which resolves it from the WATCHED player's row. So there is nothing extra to add
    // here: keeping the watched field's players is already what a spectator needs.
    if (sig) {
      for (const fid of new Set(this.watchers.values())) {
        const f = this.fields.find((x) => x.fieldId === fid);
        if (f) { for (const pid of f.players) out.add(pid); continue; }
        // 回合开始 / 机变 / 休整期 watch a teammate's BOARD, and a board has no field object — `this.fields` is filled
        // only while a battle is live (phases.js startRound() sets it to []). There the watcher value is `n:<playerId>`
        // and names the player directly. Without this the set stayed EMPTY for every prep watch, so every row's `bonds`
        // went out as [] in exactly the phase the strip exists for (owner's report: 「观战他人不显示盟约」; the client
        // was fine — watchBonds.js resolves `n:` correctly — the data simply never left the server).
        if (typeof fid === 'string' && fid.startsWith('n:')) {
          const pid = fid.slice(2);
          if (this.players.has(pid)) out.add(pid);
        }
      }
    }
    // 用户 2026-10-11：「联防阶段观战无法看到他人盟约」。联防('u') / 最终攻势与隐秘核心('b1','b2') 是**共享战场**：
    // 两半在同一屏上（‹ › 切半），盟约不是暗信息。但参与者不是观战者 —— `watchers` 里没有记录，于是这一帧里队友/对手的
    // bonds 全被打成 []，客户端 watchBonds 明明能按「‹ › 指向的那个人」取，数据却从来没发出去。这里把共享战场上的
    // 玩家都放进 shown（观战者与参战者都能读到）。
    for (const f of this.fields) {
      const fid = f && f.fieldId;
      if (typeof fid !== 'string' || !Array.isArray(f.players)) continue;
      if (!(fid === 'u' || fid.startsWith('b'))) continue;
      for (const pid of f.players) out.add(pid);
    }
    this._bondsShown = out;
    this._bondsShownSig = sig;
    return out;
  }

  publicView() {
    // 带宽优化 (2026-10-09): `players[].bonds` is 75 % of this snapshot's bytes (measured: 16.7 KB of 22.2 KB at
    // 25 seats, up to 1.1 KB for one player). It exists ONLY for the 「看队友战场」 strip / popup
    // (public/js/ui/watchBonds.js ownerBonds → a teammate's row), so shipping it for all N seats on every broadcast
    // paid O(N²) bytes and O(N) JSON serialisation for data nobody was looking at. Keep it only where it is about to
    // be read: the recipient's OWN row, and the rows of players whose field someone is watching right now.
    //
    // The set is a property of the snapshot (the same frame goes to every socket), which is correct here because a
    // watcher is the only reader: rows of unwatched players are blank for everyone, exactly as they were blank for
    // that watcher before. Watch.js invalidates the cache whenever `watchers` changes.
    const shown = this.bondsShownSet();
    const v = {
      t: 'm.public',
      phase: this.phase,
      round: this.round,
      lastRound: this.gd.lastRound,
      deadline: this.deadline,
      serverNow: this.sched.now(),
      modeId: this.modeId,
      difficulty: this.difficulty,
      stageId: this.stageId,
      factions: this.factions.slice(),
      disabledBonds: [...new Set([...this.disabledBonds, ...this.staticInactiveBonds])].sort(),
      drawnDisabledBonds: this.disabledBonds.slice(),
      bannedChess: this.bannedChess.slice(),
      bossId: this.bossId,
      hiddenBossId: this.hiddenBossId,
      bossRound: this.gd.bossRound,
      hiddenRound: this.gd.hiddenRound,
      spRound: this.gd.spRounds().includes(this.round),
      // ★ 2026-10-16：本轮的**实际**战斗时限（游戏秒），客户端倒计时优先读它 —— 惊变「天堂制造」
      //   会把时限 −40s，而客户端原来只从 config 的 rounds[].combatTimeLimit 推算，会显示成没被削过的长度。
      combatTimeLimit: this.wave && Number.isFinite(this.wave.timeLimit) && this.wave.timeLimit > 0
        ? this.wave.timeLimit
        : this.gd.combatTimeLimit(this.round),
      // DESIGN §14: 'client' = battles are simulated by the browsers (b.start specs), 'server' = legacy streaming
      combatMode: this.clientCombat ? 'client' : 'server',
      // solo pause (g.pause, DESIGN §14): the battle, its field clock and every deadline are frozen while true
      paused: !!this.paused,
      players: this.order.map((ps) => ({
        playerId: ps.playerId,
        seat: ps.seat,
        name: ps.name,
        // 头像 (shared/avatars.js): 房间 / 对局内名单 / 结算都要显示它；没设置就不占字节
        ...(ps.avatar ? { avatar: ps.avatar } : {}),
        isBot: ps.isBot,
        connected: ps.isBot || (ps.connected && !ps.left),
        alive: ps.alive,
        lp: Math.max(0, ps.lp),
        bandId: ps.bandId,
        shopLevel: ps.shop.level,
        boardCount: ps.deployCount,
        ready: this.phase === PHASE.INFO_CHECK ? ps.infoReady : ps.ready,
        // the strip of a teammate watching this player (DESIGN §20.15): every bond with members, layers or an active tier
        // (= the player's own m.private list without thresholds / countsHand — the client reads those from bonds.json),
        // this round's in-battle gains included once the COMBAT phase ended (PlayerState.bondsView); [] once eliminated —
        // nobody can watch an eliminated player (g.watch refuses them, they have no field) and the result screen reads
        // m.result's own bonds, so their layers would only cost every m.public bytes for the rest of the match
        // (the mode-off bonds with members included, `off: true`, as in m.private — bondsMeta.offBondCounts)
        bonds: ps.alive && shown.has(ps.playerId)
          ? bondList(this.gd, ps.bondsView(), { off: offBondCounts(ps.gd || this.gd, ps) })
          : [],
        fieldId: this.fieldOf(ps),
        status: this.statusOf(ps),
        autoplay: ps.autoplay,
        // 干员皮肤 (docs/SKINS.md): the player's `{ [chessId]: skinId }`, public so a teammate's board shows the skin
        // they picked — that is the whole point of choosing one in co-op. Omitted when empty, so a player who never
        // opened the 换装 tab costs this frame nothing.
        ...(Object.keys(ps.skins || {}).length ? { skins: ps.skins } : {}),
        // the LP this round's own battle will cost at settlement so far (COMBAT / 联防 only, omitted when 0)
        ...this._pendingLpView(ps),
      })),
      fields: this.fields.map((f) => {
        const v = { fieldId: f.fieldId, kind: f.kind, players: f.players.slice(), live: !!f.live };
        // 联防：漏怪的人（不在 players 里）也要能认出「这是自己的战场」
        if (Array.isArray(f.leakers) && f.leakers.length) v.leakers = f.leakers.slice();
        const pr = this._fieldProgress(f);
        if (pr) v.progress = pr;
        return v;
      }),
    };
    if (this.teamLp != null) v.teamLp = Math.max(0, Math.round(this.teamLp));
    // 最终攻势 / 隐秘核心: when the overtime drain starts (ms epoch; `deadline` is the level's 120 s countdown)
    if ((this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE) && this.overtimeAt) v.overtimeAt = this.overtimeAt;
    if (this.bossPool) v.bossHp = { hp: Math.max(0, Math.round(this.bossPool.hp)), max: Math.round(this.bossPool.maxHp) };
    if (this.phase === PHASE.BAND_DRAFT && this.draft) {
      const d = this.draft;
      // turnSeconds: the length of a turn (the countdown gauge's total; 0 when untimed) — deadline = turnDeadline
      v.draft = {
        order: d.order.slice(), turn: this.draftTurn(), picks: { ...d.picks }, skipsLeft: { ...d.skipsLeft }, turnDeadline: d.turnDeadline || 0,
        // The countdown gauge's TOTAL has to match the deadline it is drawn against: simultaneous mode runs ONE
        // BAND_DRAFT_SECONDS clock for the whole room, not a BAND_TURN_SECONDS clock per turn.
        turnSeconds: d.untimed ? 0 : (d.simultaneous ? this.scaled(BAND_DRAFT_SECONDS) : this.bandTurnMs() / 1000),
        untimed: !!d.untimed,
        // 100-seat variant: one shared countdown and no turn order, so the draft screen must not gate its picker on
        // 「it is my turn」 (that would lock 99 of 100 players out of picking) and must hide 跳过 (removed with turns).
        simultaneous: !!d.simultaneous,
        // whether a teammate's pick stays selectable (config.bandDraft.duplicatesAllowed) — the draft screen greys
        // taken strategies out only when this is false
        duplicatesAllowed: !!this.gd.bandDraft.duplicatesAllowed,
      };
    }
    // 100-seat variant: the 机变 draft is PER SQUAD, so its card pool is NOT public — each player's own squad view
    // travels in m.private.sp (PlayerViews.privateView). Public keeps the progress readout only.
    if (this.phase === PHASE.SP_DRAFT && this.sp) {
      v.sp = {
        turn: this.spTurn(),
        squads: typeof this.spDone === 'function' ? this.spDrafts().length : 0,
        picked: typeof this.spPickCount === 'function' ? this.spPickCount() : 0,
      };
    }
    if (this.phase === PHASE.UNITE && this.unitePlan) v.unite = { helpers: this.unitePlan.helpers.map((p) => p.playerId), leakers: this.unitePlan.leakers.map((p) => p.playerId), round: this.uniteRound || 1 };
    // SETTLE after a 联防: its outcome as data (settle.js uniteResultView; GitHub #235, PR #112) — { through, helpers,
    // leakers, losses: { playerId: the LP settlement charged this round } } — the client's result box reads the viewer's
    // own charge from it; absent when no 联防 resolved (the client then shows the round's own battle result)
    if (this.phase === PHASE.SETTLE && this.uniteResultView) {
      const ur = this.uniteResultView;
      v.uniteResult = { through: ur.through, helpers: ur.helpers.slice(), leakers: ur.leakers.slice(), losses: { ...ur.losses } };
    }
    // 炸惊模拟 规则14: the 敌方惊变. During its reveal phase the pool rides along so every client can flicker through
    // real entries; afterwards the drawn card alone stays (a match-long global enemy buff, so it is shown all match).
    // ★ 2026-10-24（owner）：隐秘惊变（隐秘核心战前的专属揭示阶段）
    if (this.hiddenJibian) {
      v.hiddenJibian = {
        hidden: true, label: this.hiddenJibian.label, cards: this.hiddenJibian.cards, round: this.hiddenJibian.round,
      };
      if (this.phase === PHASE.HIDDEN_JIBIAN) {
        const ej = typeof this.gd.enemyJibian === 'function' ? this.gd.enemyJibian() : null;
        const hj = ej && ej.hidden;
        const pool = [...(Array.isArray(hj && hj.pool) ? hj.pool : []), ...((ej && Array.isArray(ej.pool)) ? ej.pool : [])];
        v.hiddenJibian.pool = pool.slice(0, 24).map((c) => ({
          id: c.effectId || c.id || null, name: c.name || '', desc: c.desc || '',
          rarity: c.rarity || null, flavor: c.flavor || null,
        }));
        v.hiddenJibian.flickerMs = Number(hj && hj.flickerMs) || Number(ej && ej.flickerMs) || 2200;
        v.hiddenJibian.resultMs = Number(hj && hj.resultMs) || Number(ej && ej.resultMs) || 1800;
      }
    }
    if (this.enemyJibian) {
      v.enemyJibian = { rarity: this.enemyJibian.rarity, card: this.enemyJibian.card, round: this.enemyJibian.round };
      if (this.phase === PHASE.ENEMY_JIBIAN) {
        const ej = typeof this.gd.enemyJibian === 'function' ? this.gd.enemyJibian() : null;
        if (ej) {
          // capped: the pool is only there to be flickered through, and this frame goes to every socket
          v.enemyJibian.pool = ej.pool.slice(0, 24).map((c) => ({
            id: c.id || c.effectId || c.key || null, name: c.name || '', desc: c.desc || '',
            rarity: c.rarity || null, tier: Number.isInteger(c.tier) ? c.tier : null,
          }));
          v.enemyJibian.flickerMs = ej.flickerMs;
          v.enemyJibian.resultMs = ej.resultMs;
        }
      }
    }
    return v;
  }

  /** m.public.fields[].progress: { killed, total, done } (teammates' waiting UI). */
  _fieldProgress(f) {
    if (!f) return null;
    if (!f.cc) {
      const b = f.battle;
      if (!b) return null;
      return { killed: Number(b.killed) || 0, total: Number(b.total) || 0, done: !f.live };
    }
    if (f.done && f.result) {
      let killed = 0, total = 0;
      for (const pp of Object.values(f.result.perPlayer || {})) { killed += Number(pp && pp.killed) || 0; total += Number(pp && pp.total) || 0; }
      if (f.result.synthetic) { killed = f.progress.killed; total = f.progress.total; }
      return { killed, total, done: true };
    }
    if (f.mode === 'server' && f.timeline) {
      const [, killed, total] = timelineAt(f.timeline, this._fieldElapsed(f));
      return { killed, total, done: false };
    }
    return { killed: f.progress.killed, total: f.progress.total, done: false };
  }

  /**
   * LP a player's own battle of this normal round will cost at settlement so far — settle()'s min(lpCapPerRound,
   * counted leaks) — for the teammates' live LP (m.public players[].pendingLp, user playtest #3 item 2; the own client
   * counts its local battle itself). COMBAT: the recorded result once every field is done, else the field's result, else
   * the authority's b.progress leaks (a server-run field reports none before its result is released); 联防: a leaker's
   * enemies still standing on the 联防 field (_uniteLeft, uncapped in `uniteLeft`, user playtest #6 item 7), anyone
   * else's own battle count (0: they were perfect). Omitted when 0 and in every other phase (boss rounds charge the
   * merged team LP live).
   * @returns {{ pendingLp?: number, uniteLeft?: number }}
   */
  _pendingLpView(ps) {
    if (!ps || !ps.alive || (this.phase !== PHASE.COMBAT && this.phase !== PHASE.UNITE)) return {};
    const counted = (r) => (r && Array.isArray(r.leaked) ? r.leaked.filter((l) => l && l.counted !== false).length : 0);
    // 联防: a leaker's enemies still standing on the 联防 field (uncapped), the loss capped like settle()
    const left = this._uniteLeft(ps);
    if (left != null) {
      const loss = Math.min(this.gd.lpCapPerRound, left);
      return loss > 0 ? { uniteLeft: left, pendingLp: loss } : { uniteLeft: left };
    }
    let n = 0;
    if (this.lastResults.has(ps.playerId)) n = counted(this.lastResults.get(ps.playerId));
    else if (this.phase === PHASE.COMBAT) {
      const f = this.fields.find((x) => x && x.kind === 'normal' && Array.isArray(x.players) && x.players.includes(ps.playerId));
      if (f && f.cc) n = f.done && f.result ? counted(f.result.perPlayer && f.result.perPlayer[ps.playerId]) : Number(f.progress && f.progress.leaks) || 0;
      else if (f && f.battle) { try { n = battleProgress(f.battle).leaks; } catch { n = 0; } }
    }
    const loss = Math.min(this.gd.lpCapPerRound, Math.max(0, Math.trunc(Number(n) || 0)));
    return loss > 0 ? { pendingLp: loss } : {};
  }

  /** nextEnemies preview for m.private. */
  nextEnemiesFor(ps) {
    if (!ps.alive) return [];
    if (this.bossWaves) {
      const g = this.bossGroupOf(ps);
      if (!g) return [];
      return previewOf([...g.wave.spawns, ...bountySpawns(this.gd, this.round, g.wave, ps.bounties, ps.playerId, { solo: this.isSolo, side: g.side })]);
    }
    if (!this.wave) return [];
    const bounty = bountySpawns(this.gd, this.round, this.wave, ps.bounties, ps.playerId, { solo: this.isSolo });
    return previewOf([...this.wave.spawns, ...bounty]);
  }

  /** A 自选 piece's pick (like the sim's UnitInfo.diy): a scout's card composes the operator from it (shared/diy.js). */
  _diyInfo(ps, piece) {
    const p = piece.kind === 'chess' && typeof ps.diyPickOf === 'function' ? ps.diyPickOf(piece.id) : null;
    return p ? { charId: p.charId, skillIndex: p.skillIndex, uniEquipId: p.uniEquipId } : undefined;
  }

  /** UnitInfo of a player's board pieces on their (board) tiles — a prep scout's board, the boss partner's (bossMateView). */
  _prepBoardUnits(ps) {
    const units = [];
    // the player's own view of the data (0.2.0 自选编队: its slotted DIY slots are its operators — player/diy.js)
    const gd = ps.gd || this.gd;
    for (const { r, c, piece } of boardOrder(ps.board)) {
      const chess = piece.kind === 'token' ? null : gd.chess(piece.id);
      // 0.2.0 补位: a chess this player fields as its stand-in is deployed with the stand-in's body — name, art, max HP,
      // skill, like the sim's UnitInfo (`standInFor` = the replaced operator's charId)
      const rec = piece.kind === 'token' ? gd.token(piece.id) : ps.fieldRecord(chess);
      const assets = (rec && rec.assets) || {};
      // DESIGN §16: the skill / module THIS player's operator fights with (the scout's detail card shows it, like the
      // sim's UnitInfo in a shared field); moduleId only for an elite
      const lo = piece.kind === 'chess' && chess ? ps.loadoutFor(chess) : null;
      units.push({
        id: piece.uid, uid: piece.uid, kind: piece.kind === 'token' ? 'token' : 'op', side: 'ally', ownerId: ps.playerId, defId: piece.id,
        name: rec ? rec.name : piece.id, tier: rec && Number.isInteger(rec.tier) ? rec.tier : 1, golden: !!(rec && rec.isGolden),
        spine: assets.spine || (rec && rec.charId) || piece.id, avatar: assets.avatar || (rec && rec.charId) || piece.id,
        x: c, y: r, dir: pieceDir(piece), facing: pieceDir(piece) === 'LEFT' ? -1 : 1, maxHp: rec && rec.stats && Number.isFinite(rec.stats.maxHp) ? rec.stats.maxHp : 1,
        skillIndex: lo && Number.isInteger(lo.skillIndex) ? lo.skillIndex : undefined,
        moduleId: lo && typeof lo.moduleId === 'string' ? lo.moduleId : undefined,
        // 干员皮肤 (docs/SKINS.md): the model this player chose for the chess (PlayerState.skinOfPiece is the single
        // implementation of that lookup — round.battleInput uses the same one, so the board and the battle agree).
        skin: piece.kind === 'chess' ? ps.skinOfPiece(piece.id, typeof ps.diyPickOf === 'function' ? ps.diyPickOf(piece.id) : null) : null,
        // the equipped items (like the sim's UnitInfo): a 变形同构体 wearer shows as a member of the bond it grants
        items: piece.kind === 'chess' && Array.isArray(piece.items) && piece.items.length ? piece.items.map((it) => it.id) : undefined,
        standInFor: rec && rec.standInFor ? rec.standInFor : undefined,
        diy: this._diyInfo(ps, piece),
      });
    }
    return units;
  }

  /**
   * A boss round's prep (最终攻势 / 隐秘核心: the pairing planned, no field up yet): the other player of `ps`'s pair as
   * { mate: PlayerState, side: its half 'L' | 'R' }, else null (a lone player, any other phase).
   */
  _bossMateOf(ps) {
    if (!ps || !this.bossWaves || this.fields.length) return null;
    const g = this.bossGroupOf(ps);
    const pid = g && g.players.length > 1 ? g.players.find((x) => x !== ps.playerId) : null;
    const mate = pid ? this.players.get(pid) : null;
    return mate ? { mate, side: g.side === 'R' ? 'L' : 'R' } : null;
  }

  /**
   * m.private `bossMate` (community report of 2026-10-06, item 51): in a boss round's prep the partner's board on its
   * half of the boss field, as the battle will place it (bossFieldPlacement: the right half mirrored, RIGHT ↔ LEFT) — the
   * own prep view draws it beside the own half, read-only, as the official prep shows both players of a pair together
   * (the official client knows every board: ChangePositionDn { boardStatus }, research 09). Null otherwise.
   * @returns {{ playerId: string, side: 'L'|'R', units: object[] } | null}
   */
  bossMateView(ps) {
    const m = ps && ps.alive ? this._bossMateOf(ps) : null;
    if (!m) return null;
    return { playerId: m.mate.playerId, side: m.side, units: this._prepBoardUnits(m.mate).map((u) => this._onBossHalf(u, m.side)) };
  }

  /** UnitInfo list of a player's board and hand (prep scouting): board pieces on their tiles, held pieces on the
   *   hand row (row 7) — the scout renders like the own prep bench. */
  prepFieldMeta(ps) {
    const units = this._prepBoardUnits(ps);
    const gd = ps.gd || this.gd;
    // the hand (整备区) and the 临时整备区 scout exactly like the own prep bench renders them: pieces as units on
    // their rows (hand row 7, col = hand slot; temp row 8, cols 4..8 = temp slots; no dir — bench pieces face right),
    // items included (the client draws their floating plates). PRTS 帮助 counts the temp area with the hand (review of
    // PR #129). Part of the meta for every watcher alike — the spectator seat's copy equals a teammate's
    // (test/match/spectator.test.js). User playtest #2 item 1 (GitHub #44).
    // (a held chess the player fields as its stand-in is the stand-in there too — name, art, max HP — and carries
    // `standInFor`, like a board piece: the owner's recall of the official mode, 2026-10-06, the hand shows the stand-in)
    const benchUnit = (piece, i, y) => {
      const rec = piece.kind === 'item' ? gd.item(piece.id) : piece.kind === 'token' ? gd.token(piece.id) : gd.chess(piece.id);
      const standIn = piece.kind === 'chess' && rec && ps.fieldsStandIn(rec) ? this.gd.standIn(rec.chessId) : null;
      const body = standIn || rec;
      const assets = (body && body.assets) || {};
      const lo = piece.kind === 'chess' && rec ? ps.loadoutFor(rec) : null;
      units.push({
        id: piece.uid, uid: piece.uid, kind: piece.kind === 'token' ? 'token' : piece.kind === 'item' ? 'item' : 'op',
        side: 'ally', ownerId: ps.playerId, defId: piece.id,
        name: body ? body.name : piece.id, tier: rec && Number.isInteger(rec.tier) ? rec.tier : 1, golden: !!(rec && rec.isGolden),
        spine: assets.spine || (body && body.charId) || piece.id, avatar: assets.avatar || (body && body.charId) || piece.id,
        x: i, y, maxHp: body && body.stats && Number.isFinite(body.stats.maxHp) ? body.stats.maxHp : 1,
        skillIndex: lo && Number.isInteger(lo.skillIndex) ? lo.skillIndex : undefined,
        moduleId: lo && typeof lo.moduleId === 'string' ? lo.moduleId : undefined,
        // 干员皮肤 (docs/SKINS.md), same lookup as the board units above — the 整备区 preview must show the skin too,
        // otherwise a piece would change model the moment it is deployed.
        skin: piece.kind === 'chess' ? ps.skinOfPiece(piece.id, typeof ps.diyPickOf === 'function' ? ps.diyPickOf(piece.id) : null) : null,
        items: piece.kind === 'chess' && Array.isArray(piece.items) && piece.items.length ? piece.items.map((it) => it.id) : undefined,
        standInFor: standIn && standIn.standInFor ? standIn.standInFor : undefined,
        diy: this._diyInfo(ps, piece),
      });
    };
    for (let i = 0; i < ps.hand.length; i++) {
      if (ps.hand[i]) benchUnit(ps.hand[i], i % 10, handTileOf(i, ps.gd ? ps.gd.benchSize : null).row);
    }
    for (let i = 0; i < ps.temp.length; i++) {
      if (ps.temp[i]) { const t = tempTileOf(i, ps.gd?.benchSize); benchUnit(ps.temp[i], t.col, t.row); }
    }
    // `nextEnemies`: the scouted player's coming enemies — their preview pen shows on the scouting board too (research 09
    // §2.2 "Teammates"; render/app.js enterBattle({ prep: true, nextEnemies }))
    let nextEnemies = [];
    try { nextEnemies = this.nextEnemiesFor(ps); } catch (e) { this.reportError('nextEnemies', e); }
    // the scouted player's effects column (策略 / 机变 / 悬赏 …), display-ready (user playtest #2: while scouting, the
    // right column shows the watched player's effects, not one's own)
    const meta = { t: 'm.field', fieldId: `n:${ps.playerId}`, kind: 'normal', rect: { ...GEO.NORMAL_RECT }, stageId: this.stageId, units, effects: ps.effectsView(), prep: true, nextEnemies };
    // 最终攻势 / 隐秘核心 prep: the pieces stand on the player's half of the boss field — the scout shows them there (rows
    // − 7, the right half mirrored with RIGHT ↔ LEFT: finalAssault.js bossFieldPlacement, as the own prep view), with the
    // round's leader at its spawn tile (nextEnemies `start`), framed by the boss-field prep camera of the player's side
    // (`side`). Until 0.2.0 an eliminated player or a spectator seat scouting a player then saw the normal board and no
    // leader at all (community report of 2026-10-06, item 55).
    // The pair's other player stands on the other half (item 51: both players of a pair together, as in the battle).
    const g = this.fields.length ? null : this.bossGroupOf(ps);
    if (!g) return meta;
    const mate = this.bossMateView(ps);
    const own = units.map((u) => this._onBossHalf(u, g.side));
    return { ...meta, kind: 'boss', rect: { ...GEO.BOSS_RECT }, side: g.side, units: mate ? [...own, ...mate.units] : own, ...(mate ? { mate: { playerId: mate.playerId, side: mate.side } } : {}) };
  }

  /** A prep UnitInfo (board, bench or temp row) placed on side 'L' | 'R' of the boss field (bossFieldPlacement). */
  _onBossHalf(u, side) {
    const p = bossFieldPlacement(side, u.y, u.x, u.dir || 'RIGHT');
    const v = { ...u, x: p.col, y: p.row };
    // a board piece keeps facing the same way relative to the leader (mirrored on the right half); a bench piece has no
    // stored facing (it faces right, as the own prep bench draws it)
    if (u.dir) { v.dir = p.dir; v.facing = p.dir === 'LEFT' ? -1 : 1; }
    return v;
  }
}
