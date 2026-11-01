// server/sim/battle/players.js — Battle methods: players and units: board → field tiles and directions, ally creation
// from the PlayerBattleInput, token defs for an owner's loadout, and the kit / profile / skill setup of a unit.
// Installed on Battle.prototype by server/sim/Battle.js (a method container: never instantiated; `this` is the battle).

import { COLS, BOSS_ROW_OFFSET } from '../constants.js';
import { GEO } from '../../../shared/constants.js';
import { Unit } from '../units.js';
import { normDir, mirrorDir } from '../dir.js';
import { SkillRuntime } from '../skills.js';
import { resolveProfile } from '../professions.js';
import { normalizeToken } from '../simdata.js';
import { setupUnitKit } from '../content/index.js';
import { installTraitAttackSpeed } from '../content/traitMods.js';
import { isPotential, isCultivate } from '../../../shared/potential.js';
import { allyScaleOf } from '../../../shared/zhajingBase.js';
import { clone } from './util.js';

export class BattlePlayers {
  _addPlayer(p) {
    const bossLike = this.kind === 'boss' || this.kind === 'hidden';
    const side = p.side === 'R' ? 'R' : 'L';
    const mirror = bossLike && side === 'R';
    const ps = {
      playerId: p.playerId,
      seat: p.seat ?? this.players.length,
      side,
      colOffset: Number(p.colOffset) || 0,
      rowOffset: p.rowOffset,
      coords: p.coords ?? 'board',
      mirror,
      facing: mirror ? -1 : 1,
      // default direction of this player's units on this field (the FA right side is mirrored: RIGHT ↔ LEFT)
      dir: mirror ? 'LEFT' : 'RIGHT',
      half: mirror || (Number(p.colOffset) || 0) >= 8 ? 'R' : 'L',
      bonds: clone(p.bonds ?? {}),
      bandId: p.bandId ?? null,
      // ★ 2026-10-25：策略效果可能要读「调度中心等级」（山岸风花·神通法）
      shopLevel: Number.isInteger(p.shopLevel) ? p.shopLevel : 1,
      playerEffects: clone(p.playerEffects ?? []),
      lpForBoss: p.lpForBoss ?? null,
      dp: this.flags.dpInit,
      units: [],
      input: p,
    };
    this.players.push(ps);
    this._perPlayer[ps.playerId] = {
      killed: 0, total: 0, leaked: [], perfect: true, layerGains: {}, coins: 0,
      damageDealt: 0, bossDamage: 0, healingDone: 0, deaths: 0, unitsEnd: [], unitStats: [],
    };
    const late = [];
    for (const u of p.units ?? []) {
      try {
        const unit = this._createAllyFromInput(ps, u);
        if (unit && unit.kind === 'token' && !unit.ownerUnit && u.ownerUid != null) late.push([unit, u]);
      } catch (e) { this._internalError('createUnit', e); }
    }
    // a token piece listed before its owner (board order is top→bottom) is linked once every unit exists, and takes
    // the owner-level variant (elite owners: `_b` stats) of the owner's loadout (DESIGN §16)
    for (const [t, inp] of late) {
      const owner = ps.units.find((x) => x.kind === 'op' && x.uid === inp.ownerUid);
      if (!owner) continue;
      t.ownerUnit = owner;
      const def = inp.def ? null : this._tokenDef(inp.tokenId ?? inp.chessId, owner, null);
      if (!def || def === t.def) continue;
      const st = def.stats;
      t.def = def; t.defId = def.id; t.name = def.name; t.rangeGrid = def.rangeGrid;
      Object.assign(t.base, {
        maxHp: st.maxHp, atk: st.atk, def: st.def, res: st.res, aspd: st.aspd, bat: st.bat, blockCnt: st.blockCnt, spRecovery: st.spRecovery,
        tauntLevel: st.tauntLevel, massLevel: st.massLevel, hpRecoveryPerSec: st.hpRecoveryPerSec, cost: st.cost, respawnTime: st.respawnTime,
      });
      t.markDirty();
      t.hp = t.s.maxHp;
    }
  }

  /** Board → field tile for a player (see header). */
  mapTile(ps, row, col, abs = false) {
    if (abs || ps.coords === 'field') return [row, col];
    return this._boardTile(ps, row, col);
  }

  /**
   * Whether field tile (r, c) lies on player `ps`'s own board: the board region GEO.FIELD (rows 9–12, cols 2–10, the
   * tiles its pieces are deployed on) mapped onto this field — the 联防 right-hand helper's +8 columns, the boss field's
   * rows 2–5, the mirrored right half of a pair (whatever coordinates the player's input uses). Never the hand / 临时
   * 整备区 rows of a boss field (rows 0–1, inside BOSS_RECT) nor the other half of a 联防 or boss field. Moves that must
   * stay where the player could deploy read it (乌尔比安's S3 【移动】, kits/ops/chess_char_5_05-ulpia.js); the 突袭
   * landing reads onFieldBoard (any player of this field).
   */
  onOwnBoard(ps, r, c) {
    if (!ps) return false;
    let keys = ps._boardKeys;
    if (!keys) {
      keys = ps._boardKeys = new Set();
      for (let br = GEO.FIELD.r0; br <= GEO.FIELD.r1; br++) {
        for (let bc = GEO.FIELD.c0; bc <= GEO.FIELD.c1; bc++) { const [fr, fc] = this._boardTile(ps, br, bc); keys.add(fr * COLS + fc); }
      }
    }
    return keys.has(r * COLS + c);
  }

  /**
   * Whether field tile (r, c) lies on the board of a player standing on this field: onOwnBoard of one of `players`,
   * the players whose units this battle holds (a teammate eliminated before it or playing another field is not one).
   * Both halves on the two-helper 联防 field and on a Final Assault / Hidden Core pair field; the own half only for a
   * lone 联防 helper and on a solo boss field; never a boss field's hand / 临时整备区 rows. The 突袭 landing reads it
   * (bonds/addon/battle.js raidTile — the owner's decision of 2026-10-07, DESIGN §26.1).
   */
  onFieldBoard(r, c) {
    for (const ps of this.players) if (this.onOwnBoard(ps, r, c)) return true;
    return false;
  }

  _boardTile(ps, row, col) {
    const bossLike = this.kind === 'boss' || this.kind === 'hidden';
    let r = row;
    if (ps.rowOffset != null) r = row + ps.rowOffset;
    else if (bossLike && row >= 7) r = row + BOSS_ROW_OFFSET;
    const c = ps.mirror ? (col <= 10 ? COLS - 1 - col : col) : col + ps.colOffset;
    return [r, c];
  }

  /**
   * Board direction → field direction for a player (DESIGN §3): as given (default RIGHT) except on the mirrored Final
   * Assault right side, where RIGHT ↔ LEFT (UP / DOWN unchanged). `abs` / field coordinates are taken as they are.
   */
  mapDir(ps, dir, abs = false) {
    const d = normDir(dir);
    return ps && ps.mirror && !abs && ps.coords !== 'field' ? mirrorDir(d) : d;
  }

  _createAllyFromInput(ps, inp) {
    // coerce (a string row would otherwise concatenate: "10" + -7 → "10-7"); non-integers never deploy
    const row = Number(inp.row), col = Number(inp.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) { this.log(`bad tile ${inp.row},${inp.col} for ${inp.chessId ?? inp.tokenId}`); return null; }
    const [r, c] = this.mapTile(ps, row, col, !!inp.abs);
    const dir = this.mapDir(ps, inp.dir, !!inp.abs);
    if (inp.kind === 'token') {
      const owner = inp.ownerUid != null ? ps.units.find((x) => x.uid === inp.ownerUid) : null;
      const def = this._tokenDef(inp.tokenId ?? inp.chessId, owner, inp.def);
      if (!def) { this.log(`unknown token ${inp.tokenId}`); return null; }
      const u = this._makeAlly(ps, def, 'token', r, c, { uid: inp.uid, ownerUnit: owner, dir });
      u.carry = inp.carryState ?? null;
      return u;
    }
    // the unit's own loadout (DESIGN §16): an entry without loadout fields is the DEFAULT — never another player's
    // choice for the same chess id in a multi-player field (the per-battle data view maps id-only lookups); `standIn:
    // true` fields the chess as its 补位 stand-in (simdata getStandIn: the stand-in's body, the chess's identity); `diy`
    // fills a 自选 slot with its pick (simdata getDiy: the slot's identity, the operator's body, skill and module)
    const lo = { skillIndex: inp.skillIndex ?? null, moduleId: inp.moduleId ?? null };
    if (inp.standIn === true) lo.standIn = true;
    if (inp.diy && typeof inp.diy === 'object') lo.diy = inp.diy;
    // 潜能 (1–6, 0.2.2): the record is composed at the player's setting — never a 补位 stand-in's (a stand-in is
    // another operator's body, so the chess's own potential does not apply to it)
    if (inp.standIn !== true && isPotential(inp.potential)) lo.potential = inp.potential;
    const def = this.data.getChess(inp.chessId, lo);
    if (!def) { this.log(`unknown chess ${inp.chessId}${lo.diy ? ' (illegal 自选 pick)' : ''}`); return null; }
    // a DIY slot has no body of its own (甄选干员): it fights only as a 自选 piece (its `diy` pick)
    if (def.raw?.isDiy && !def.diyFor) { this.log(`自选 slot ${inp.chessId} without a pick`); return null; }
    const u = this._makeAlly(ps, def, 'op', r, c, { uid: inp.uid, dir, skin: inp.skin });
    u.items = [...(inp.items ?? [])];
    u.carry = inp.carryState ?? null;
    // 练度 (自持有, 0.2.2): the owned operator's ×ATK / ×DEF / ×max HP (units.js Πmul) — never a 补位 stand-in's
    // nor a prototype 自选 pick's (another character than the one the player owns). Kept as a multiplier on the unit
    // rather than folded into `stats`, so the detail card, a summon of it and the battle all read the same product.
    if (isCultivate(inp.cultivate) && !def.standInFor && !def.raw?.diyProto) {
      const mul = typeof this.data.cultivateMul === 'function' ? this.data.cultivateMul(inp.cultivate) : null;
      if (mul) { u.cultivate = inp.cultivate; u.cultMul = Object.freeze({ ...mul }); u.markDirty(); }
    }
    // 炸惊模拟 规则9 (0.3.x 改口径): the mode's blanket ×max HP / ×DEF / ×ATK on EVERY operator the player fields
    // (flags.allyScale) now lands on the operator's 白值 — `base.atk` / `base.def` / `base.maxHp` — instead of a final
    // multiplier (the old unit.scaleMul / units.js Πmul): 干员调配 与详情卡显示的白值就是战斗用的白值, 盟约 / 惊变 /
    // 道具的百分比加成也从它起算 (shared/zhajingBase.js 与客户端同一份口径). Unlike 练度 this is not tied to owning the
    // character, so a 补位 stand-in takes it too. Tokens (summons) are not 干员 and are left alone.
    // ★ 2026-10-14 惊变「纯粹的强大」(jibian_chuncuideqiangda)：chess 记录带 pureStrong 时，
    //   该单位的基础攻击/生命已在记录里 ×2；战斗侧再给它开两个开关（units.js _recalc）：
    //   盟约贡献的生命/攻击 ×2，且阻挡数不受任何加成影响。
    if (def.raw && def.raw.pureStrong === true) { u.pureStrong = true; u.markDirty(); }
    const as = allyScaleOf(this.flags && this.flags.allyScale);
    if (as) {
      u.base.atk *= as.atk;
      u.base.def *= as.def;
      u.base.maxHp *= as.hp;
      u.markDirty();
    }
    // ★ 炸惊模拟「锻造器」(user 2026-10-14：「把锻体的所有数值都跟吸血暴击率一样变成直接加在基础数值里（白字）」):
    //   和上面的 allyScale 同一个口径 —— **直接加进 `unit.base`（白值）**，不是挂 buff。
    //   来源是本玩家自己的输入 `ps.input.forge`（round.js battleInput → forgeBattleMods），每个玩家各不相同，
    //   所以不能用整场共享的 `flags`。基础暴击 5% 只在这里给（`this.zj` 非 null = 炸惊），它也是白值的一部分。
    const fg = ps.input && ps.input.forge;
    const zjOn = !!this.zj;
    if (fg || zjOn) {
      if (zjOn) u.base.critRate = (Number(u.base.critRate) || 0) + 0.05;   // ★ 基础暴击 5%
      if (fg) {
        if (fg.atk) u.base.atk += fg.atk;
        if (fg.def) u.base.def += fg.def;
        if (fg.hp) u.base.maxHp += fg.hp;
        if (fg.block) u.base.blockCnt += fg.block;
        if (fg.crit) u.base.critRate = (Number(u.base.critRate) || 0) + fg.crit / 100;
        if (fg.vamp) u.base.lifesteal = (Number(u.base.lifesteal) || 0) + fg.vamp / 100;
      }
      u.markDirty();
    }
    return u;
  }

  /**
   * Token def: an inline def (PlayerBattleInput `def`, spawnToken `opts.def`) as given, else the data record's variant
   * for the owner — `owner` = the owning ally unit (its chess and its selected skill / module: getToken(id,
   * owner.defId, owner.def.loadout), DESIGN §16), a chess id, or null.
   */
  _tokenDef(tokenId, owner, inline) {
    if (inline) return normalizeToken(tokenId, inline);
    if (!this.data.getToken) return null;
    if (owner && typeof owner === 'object') return this.data.getToken(tokenId, owner.defId ?? null, owner.def?.loadout ?? null);
    return this.data.getToken(tokenId, owner ?? null);
  }

  _makeAlly(ps, def, kind, r, c, extra = {}) {
    const st = def.stats;
    const u = new Unit({
      aspdCap: this.flags ? this.flags.aspdCap : undefined,   // ★ 炸惊：0 = 不夹攻速上限（flags 来自 gd.dp）
      id: ++this._idSeq, side: 'ally', kind, def, defId: def.id, name: def.name, ownerId: ps ? ps.playerId : null,
      uid: extra.uid ?? null, ownerUnit: extra.ownerUnit ?? null, skin: extra.skin ?? null, x: c, y: r, tileR: r, tileC: c,
      dir: extra.dir != null ? normDir(extra.dir) : extra.facing != null ? normDir(extra.facing) : ps ? ps.dir : 'RIGHT',
      base: {
        maxHp: st.maxHp, atk: st.atk, def: st.def, res: st.res, aspd: st.aspd, bat: st.bat, blockCnt: st.blockCnt,
        moveSpeed: 0, spRecovery: st.spRecovery, tauntLevel: st.tauntLevel, massLevel: st.massLevel,
        hpRecoveryPerSec: st.hpRecoveryPerSec, cost: st.cost, respawnTime: st.respawnTime,
      },
    });
    u.alive = false;
    u.deployed = false;
    u.items = [];
    u.rangeGrid = def.rangeGrid;
    u.player = ps;
    this.units.push(u);
    this.allyUnits.push(u);
    if (ps) ps.units.push(u);
    return u;
  }

  /** Resolve kit/profile/skill for a unit (called by content/index.js; safe to call again). */
  _setupUnit(u, kit = null) {
    if (!kit) {
      try { kit = setupUnitKit(this, u, this.contentMode); } catch (e) { this._internalError('setupUnitKit', e); kit = null; }
    }
    u.kit = kit || {};
    u.profile = resolveProfile(u.def, u.kit.trait || null);
    if (u.def.untargetable) this.addBuff(u, { key: 'trait:untargetable', flags: { untargetable: true }, persist: true, allowDead: true });
    // abnormal effects a summon holds (tokens.json `abnormal`, PRTS; user playtest #6 item 18): 禁疗 — no heal reaches it;
    // 孤立 ("无法被同阵营选中") — no ally heal or ally selection (auras over a range) reaches it
    const ab = u.def.abnormal;
    if (Array.isArray(ab) && ab.length) {
      const flags = {};
      if (ab.includes('healFree')) flags.noHeal = true;
      if (ab.includes('isolated')) { flags.isolated = true; flags.noHeal = true; }
      if (Object.keys(flags).length) this.addBuff(u, { key: 'trait:abnormal', flags, persist: true, allowDead: true });
    }
    const spec = u.kit.skill || null;
    u.skill = new SkillRuntime(this, u, u.def.skill, spec, u.def.skill?.bb ?? {});
    if (u.profile.install && !u._profInstalled) {
      u._profInstalled = true;
      this._safe(() => u.profile.install(this, u), 'profile.install', u);
    }
    for (const t of u.kit.talents || []) {
      if (t && typeof t.install === 'function') this._safe(() => t.install(this, u), 'talent.install', u);
    }
    if (typeof u.kit.install === 'function') this._safe(() => u.kit.install(this, u), 'kit.install', u);
    // trait lines the ENGINE owns for every operator (content/traitMods.js: the module attack-speed riders whose
    // condition is a pure function of the field — 「攻击范围内存在N名及以上敌人时攻击速度+X」). Runs after kit.install:
    // a kit that implements its own line for this trait is never double-counted — traitMods.js refuses every
    // condition shape a kit already owns (`reason: 'kit'`).
    this._safe(() => installTraitAttackSpeed(this, u), 'traitMods.attackSpeed', u);
    return u.kit;
  }
}
