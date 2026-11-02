import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Match as GameplayMatch } from './engine/server/match/Match.js';
import { loadData, setModeData } from './engine/server/data.js';
import { validateC2S } from './engine/shared/protocol.js';
import { ZHAJING_VARIANT, ZHAJING_DIFFICULTY } from '../../../shared/zhajing-constants.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'data/zhajing');
let modeData;
export function getZhajingData() {
  if (!modeData) { modeData = loadData(dataDir); setModeData(modeData); }
  return modeData;
}

/** Adapt the shared character-key format to the embedded engine's skin lookup. */
export function projectZhajingSkins(skins, data = getZhajingData()) {
  const entries = skins && typeof skins === 'object' && !Array.isArray(skins) ? Object.entries(skins) : [];
  const projected = Object.assign(Object.create(null), Object.fromEntries(entries));
  const characters = new Map();
  for (const [key, skin] of entries) {
    if (!key.startsWith('char:') || key.length === 5 || typeof skin !== 'string' || !skin) continue;
    const charId = key.slice(5);
    characters.set(charId, skin);
    projected[charId] = skin;
  }
  for (const [key, record] of Object.entries(data?.chess || {})) {
    if (!record || record.isGolden || !characters.has(record.charId)) continue;
    const chessId = record.chessId || key;
    if (record.baseId && record.baseId !== chessId) continue;
    projected[chessId] = characters.get(record.charId);
  }
  return projected;
}

const ALLOWED = new Set(['g.infoReady', 'g.band', 'g.bandSkip', 'g.bandFocus', 'g.buy', 'g.refresh',
  'g.freeze', 'g.levelUp', 'g.sell', 'g.move', 'g.equip', 'g.art', 'g.destroy', 'g.reward', 'g.choice',
  'g.ready', 'g.emote', 'g.watch', 'g.autoplay', 'g.pause', 'g.unitStats', 'g.spReroll',
  'g.specialRefresh', 'g.mysticRefresh', 'g.deathReturn', 'g.sellBanteng', 'g.cashCheque',
  'g.forgeTake', 'g.loadout']);

export class Match extends GameplayMatch {
  constructor(opts) {
    const data = getZhajingData();
    super({ ...opts, data, difficulty: ZHAJING_DIFFICULTY,
      seats: opts.seats?.map(seat => ({ ...seat, skins: projectZhajingSkins(seat.skins, data) })),
      modeId: opts.mode === 'solo' ? 'mode_single_zhajing' : 'mode_multi_zhajing' });
    this.variant = ZHAJING_VARIANT;
    this.matchId = opts.matchId;
    this._persistRev = 1;
  }
  setSkins(playerId, skins) { return super.setSkins(playerId, projectZhajingSkins(skins)); }
  publicView() { return { ...super.publicView(), variant: ZHAJING_VARIANT, matchId: this.matchId }; }
  markPublic(...args) { this._persistRev = (this._persistRev || 0) + 1; return super.markPublic(...args); }
  markPrivate(...args) { this._persistRev = (this._persistRev || 0) + 1; return super.markPrivate(...args); }
  handle(playerId, frame) {
    let msg = frame;
    if (frame.t === 'g.zhajing') {
      msg = { ...frame.intent };
      if (!ALLOWED.has(msg.t)) return { error: 'BAD_MSG' };
      if (msg.t === 'g.watch') delete msg.viewOnly;
      const error = validateC2S(msg);
      if (error) return { error: 'BAD_MSG', detail: error };
    }
    return super.handle(playerId, msg);
  }
  addObserver(id) { return this.addSpectator(id); }
  removeObserver(id) { return this.removeSpectator(id); }
  watchObserver(id, fieldId, targetId) {
    const spectator = this.spectators.get(id);
    if (!spectator) return { error: 'NOT_IN_ROOM' };
    return this.watch(spectator, fieldId, targetId);
  }
  captureRules() {
    const matchKeys = ['enemyJibian', 'enemyJibianCards', 'enemyJibianRoundsDone', 'enemyJibianDone',
      'hiddenJibian', '_hiddenJibianDone', 'jibianPlan', '_jibianSoloPick', '_jibianRewindRound'];
    const playerKeys = ['avatar', 'forge', 'greatSealUsed', 'bans', 'deniedBonds', 'bannedChess', 'banPick',
      'diyPicks', 'prepSnapshot', 'jibianConsumed', '_deathReturnRound', '_deathReturnLp'];
    return { version: 1, match: Object.fromEntries(matchKeys.filter(k => Object.hasOwn(this, k)).map(k => [k, this[k]])),
      players: this.order.map(ps => ({ playerId: ps.playerId,
        state: Object.fromEntries(playerKeys.filter(k => Object.hasOwn(ps, k)).map(k => [k, ps[k]])),
        pool: Object.fromEntries([...ps.pool().entries].map(([id, entry]) => [id, entry.left])),
      })) };
  }
  restoreRules(value) {
    if (value?.version !== 1) throw new Error('Unsupported 炸惊 checkpoint');
    Object.assign(this, value.match);
    for (const saved of value.players) {
      const ps = this.players.get(saved.playerId);
      if (!ps) throw new Error('Missing 炸惊 checkpoint seat');
      Object.assign(ps, saved.state);
      for (const [id, left] of Object.entries(saved.pool)) {
        const entry = ps.pool().entries.get(id); if (entry) entry.left = Math.min(entry.cap, left);
      }
    }
  }
  resumeRulePhase(phase, remaining) {
    if (phase === 'SP_DRAFT') {
      this.setDeadline(0);
      for (const draft of this.sp || []) if (draft) this.startSpTurn(draft);
    } else if (phase === 'ENEMY_JIBIAN') {
      this.setDeadline(Math.max(1, remaining / 1000), () => this.afterEnemyJibian());
    } else if (phase === 'HIDDEN_JIBIAN') {
      this.setDeadline(Math.max(1, remaining / 1000), () => this.enterPrep());
    }
    this.markPublic(); for (const ps of this.order) this.markPrivate(ps);
  }
}
