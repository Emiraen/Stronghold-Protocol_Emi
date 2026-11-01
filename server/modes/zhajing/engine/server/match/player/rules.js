// server/match/player/rules.js — PlayerState methods for the 100-seat variant (docs/FINDINGS-100.md): the per-player
// independent chess pool and the squad a seat belongs to.
//
//   * INDEPENDENT POOL (the 100-seat rule): every player draws its shop from a pool of its own that holds the FULL
//     original copy count of every non-banned base chess (config.economy.poolCopies), so 100 seats never compete for
//     the 3-8 copies the shared pool carries. `m.pool` stays the match's canonical catalog: its `entries`/`has`/`cap`
//     are the authoritative id set and copy ceilings (audit.js, platform.js, invariants.js read them), but no copies
//     are ever taken from it in this variant — every take/give/roll goes through `pool()`.
//
//     Measured motivation (smoke100.mjs): tier 6 ships 5 copies per base chess and an elite merge eats 3, so a 100-seat
//     room would see SOLD_OUT on nearly every tier-5/6 slot.
//
//   * SQUAD (the 25-squad structure): seats are grouped in fours, in seat order, 25 squads for 100 seats. The rule
//     layer groups by squad when 联防 runs: 队内兜底 first, then the cross-squad hand-off. The topology between squads
//     is deliberately NOT decided here (see docs/FINDINGS-100.md §6.3) — this module only answers membership.
//
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { SharedPool } from '../pool.js';
import { SQUAD_SIZE, squadIndex, squadMembers } from '../../../shared/squads.js';
import { drawPlayerBans, bannedChessFor } from '../../../shared/banPick.js';

export class PlayerRules {
  /**
   * This player's own pool — the FULL original copy count of every non-banned base chess, built from the match's
   * canonical catalog. Built lazily and kept for the match: taking copies must never leak into `m.pool`.
   *
   * 卡池预选 (the 100-seat variant's own feature): the id set comes from THIS player's ban picks, not the match's
   * `m.bannedChess` — that is what makes each player's shop different. `this.deniedBonds` / `this.bannedChess` are
   * computed once by `initBanPick` (from `seat.bans`); a player without picks gets the match-level random draw, which
   * is what every player had before the feature existed. `m.pool` stays the canonical catalog (audit / platform /
   * invariants read it) and still uses the match-level draw.
   * @returns {SharedPool}
   */
  pool() {
    if (!this._ownPool) {
      this._ownPool = new SharedPool(this.m.gd, { banned: this.bannedChess || this.m.bannedChess || [] });
    }
    return this._ownPool;
  }

  /**
   * 卡池预选: resolve this player's disabled 盟约 and the chess they take out of its own pool, once, at match start.
   *
   * `picks` may be undefined (no picks — the player then keeps whatever the match drew), an entry (the whole profile),
   * or the profile itself. `m.randomDrawFn()` supplies the fallback draw; a player's own picks REPLACE it (the two are
   * never mixed, so a player who picked three 大盟约 does not also inherit the match's random three).
   * @param {any} picks `seat.bans` (shared/banPick.js profile)
   * @param {() => string[]} randomDrawFn the match-level draw (`m.disabledBonds`)
   */
  initBanPick(picks, randomDrawFn) {
    const gd = this.m.gd;
    const bondOf = (b) => gd.bond(b);
    const entry = picks && picks.byDifficulty ? picks.byDifficulty[gd.difficulty] : picks;
    if (!entry) {
      // no picks for this difficulty: the match-level random draw, i.e. the behaviour before the feature
      const drawn = typeof randomDrawFn === 'function' ? randomDrawFn() : (this.m.disabledBonds || []);
      this.deniedBonds = Object.freeze([...drawn].sort());
      this.bannedChess = Object.freeze((this.m.bannedChess || []).slice());
      this.banPick = null;
      return;
    }
    const quota = gd.bans(gd.difficulty);
    const rng = this.m.rngSetup || Math.random;
    const denied = drawPlayerBans({
      entry, quota, bondIds: gd.bondIds, bondOf,
      modeInactive: gd.modeInactiveBonds, rng,
    });
    this.banPick = Object.freeze({ difficulty: gd.difficulty, quota, denied: Object.freeze(denied.slice()) });
    this.deniedBonds = Object.freeze(denied);
    this.bannedChess = Object.freeze(bannedChessFor({
      visibleChess: gd.visibleChess, chess: (id) => gd.chess(id), disabled: denied,
      modeInactive: gd.modeInactiveBonds,
    }));
  }

  /**
   * Copy accounting of base chess `baseId` for this player — the single routing point every buy / sell / merge /
   * temp / elimination goes through, so that all of them agree (`acquire.js`, `pieces.js`, `prep.js`, `economy.js`,
   * `effectsMeta.js` call it rather than `m.pool`).
   *
   * 自选编队 (DIY) slots are the ONE exception and they need the branch: a slotted 自选 piece is `isDiy`, which
   * `gd.visibleChess` excludes, so it is in no pool's `entries` — `SharedPool.take` would find no entry and return 0
   * WITHOUT taking anything, i.e. the shop could sell the same 自选 piece forever. Their copies live in the player's
   * own `diyStock` instead (`player/diy.js`), whose `left + held == cap` accounting `invariants.js` checks; the shop
   * draws them through `diyRollEntries()` (economy.js `_rollChessSlot`).
   *
   * The base id is what arrives here either way: `acquireChess` resolves `gd.baseIdOf(chessId)` first, so a normal
   * and an elite (golden) 自选 piece both account against the slot's `baseId` — the key `diyStock` is built with.
   * @param {string} baseId
   * @returns {SharedPool|DiyStockPool}
   */
  poolOwnedBy(baseId) {
    const diy = this._diyStockPoolFor(baseId);
    return diy || this.pool();
  }

  /** Back-compat alias of poolOwnedBy (upstream name, used by acquire.js / pieces.js / prep.js). */
  poolOf(baseId) { return this.poolOwnedBy(baseId); }

  /**
   * The copy-accounting view of this player's 自选 stock for `baseId`, or null when `baseId` is not a slotted 自选
   * slot (the common case — then the caller uses the player's own pool). Implemented inline rather than as a class so
   * `player/rules.js` keeps its imports (`SharedPool` and the squad helpers) and stays a method container.
   *
   * Only the four members the call sites actually use are exposed — `has` / `left` / `take` / `give` — plus
   * `entries` (read by `invariants.js`). The stock's records already carry `cap`, `left`, `tier` and `shopLevel`.
   * @param {string} baseId
   */
  _diyStockPoolFor(baseId) {
    if (typeof baseId !== 'string') return null;
    const stock = this.diyStock;
    if (!stock || !stock.entries || !stock.entries.has(baseId)) return null;
    const e = stock.entries.get(baseId);
    const clamp = (n) => (Number.isFinite(n) ? Math.floor(n) : 0);
    return {
      entries: stock.entries,
      has: (id) => stock.entries.has(id),
      cap: (id) => stock.entries.get(id)?.cap ?? 0,
      left: (id) => stock.entries.get(id)?.left ?? 0,
      /** Same contract as SharedPool.take: up to `n` copies, returns how many were actually taken. */
      take(id, n = 1) {
        const rec = stock.entries.get(id);
        if (!rec || !(n > 0)) return 0;
        const k = Math.min(rec.left, clamp(n));
        rec.left -= k;
        return k;
      },
      /** Same contract as SharedPool.give: clamped at the cap, returns how many were actually returned. */
      give(id, n = 1) {
        const rec = stock.entries.get(id);
        if (!rec || !(n > 0)) return 0;
        const k = Math.min(rec.cap - rec.left, clamp(n));
        rec.left += k;
        return k;
      },
    };
  }

  /** This player's squad index (0..24 at 100 seats); -1 when the seat is out of range. */
  squad() { return squadIndex(this.seat); }

  /** The player states of this player's squad, in seat order (always includes this player while it is seated). */
  squadPeers() {
    const ids = new Set(squadMembers(this.seat));
    return this.m.order.filter((ps) => ids.has(ps.seat));
  }

  /** Whether `other` (a seat number or a player state) is in this player's squad. */
  inSameSquad(other) {
    const seat = typeof other === 'number' ? other : other && other.seat;
    return Number.isInteger(seat) && squadIndex(seat) === this.squad();
  }
}

export { SQUAD_SIZE };
