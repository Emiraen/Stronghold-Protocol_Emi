import { MIZUKI_VARIANT, MIZUKI_CAPACITIES } from '../shared/mizuki-constants.js';
import { ZHAJING_VARIANT, ZHAJING_DIFFICULTY, ZHAJING_CAPACITIES } from '../shared/zhajing-constants.js';
// Automatic server restart recovery. East's room identities, variants and ranked match ids remain authoritative.
import { ERR, ROOM_CODE_LEN, DIFFICULTIES, ENTERTAINMENT_CAPACITIES, CYCLOPS_CAPACITIES, ENDLESS_VARIANT } from '../shared/constants.js';
import { roomServer } from './regions.js';
import { restoreMatch as applyCheckpoint } from './match/snapshot.js';
import { createRngFromState } from './sim/rng.js';
import { ANNIHILATION_VARIANT, ANNIHILATION_DIFFICULTY, ANNIHILATION_CAPACITIES, EROSION_MAX } from '../shared/annihilation-constants.js';

export function seatEntries(room, checkpoint, registry) {
  return (checkpoint ? checkpoint.players : room.seats.filter(Boolean)).map((p) => ({
    seat: p.seat, playerId: p.playerId, name: p.name, isBot: !!p.isBot,
    connected: checkpoint ? !!p.isBot : !!p.connected,
    ...(room.variant === MIZUKI_VARIANT ? { left: checkpoint ? !!room.seatOf(p.playerId)?.left : !!p.left } : {}),
    zhajingLoadout: p.isBot ? null : p.zhajingLoadout || null, zhajingOps: p.isBot ? null : p.zhajingOps || null,
    loadout: p.isBot ? null : p.loadout || null, ops: p.isBot ? null : p.ops || null,
    notOwned: p.isBot ? null : p.notOwned || p.standIns || null,
    diy: p.isBot ? null : p.diy || null, skins: p.isBot ? null : p.skins || null,
    aid: p.isBot ? null : p.aid || null,
    debugAuthorized: !p.isBot && registry.byId(p.playerId)?.debugAuthorized === true,
  }));
}

export function restoreLobbyRooms(lobby, docs, { Room, now = lobby.now() } = {}) {
  const stats = { rooms: 0, seats: 0, droppedSeats: 0 };
  for (const d of docs) {
    if (!d || typeof d.code !== 'string' || d.code.length !== ROOM_CODE_LEN || !/^[A-Z]+$/.test(d.code)
        || roomServer(d.code) !== lobby.serverId || lobby.rooms.has(d.code)) continue;
    const annihilation = d.variant === ANNIHILATION_VARIANT;
    const zhajing = d.variant === ZHAJING_VARIANT;
    if (!['solo', 'coop'].includes(d.mode) || !(zhajing ? d.difficulty === ZHAJING_DIFFICULTY : annihilation ? d.difficulty === ANNIHILATION_DIFFICULTY : DIFFICULTIES.includes(d.difficulty))) continue;
    if (d.test === true && !lobby.testEnabled) continue;
    const variant = d.variant || null;
    if (variant && !annihilation && !zhajing && (d.mode !== 'coop' || ![MIZUKI_VARIANT, 'entertainment_multi', 'entertainment_cyclops', ENDLESS_VARIANT].includes(variant))) continue;
    if ((variant === ENDLESS_VARIANT || variant === MIZUKI_VARIANT) && d.difficulty !== 'NORMAL') continue;
    if (d.mizukiDifficultyGrade !== undefined && (variant !== MIZUKI_VARIANT || !Number.isInteger(d.mizukiDifficultyGrade)
      || d.mizukiDifficultyGrade < 0 || d.mizukiDifficultyGrade > 18)) continue;
    if (variant && !(zhajing ? ZHAJING_CAPACITIES : variant === MIZUKI_VARIANT ? MIZUKI_CAPACITIES : annihilation ? ANNIHILATION_CAPACITIES : variant === 'entertainment_cyclops' ? CYCLOPS_CAPACITIES : ENTERTAINMENT_CAPACITIES).includes(d.capacity)) continue;
    if (zhajing && (d.mode === 'solo' && d.capacity !== 1 || d.ranked === true)) continue;
    if (annihilation && (!Number.isInteger(d.erosion) || d.erosion < 1 || d.erosion > EROSION_MAX || (d.mode === 'solo' && d.capacity !== 1))) continue;
    const room = new Room(d.code, d.mode, d.difficulty, now, annihilation ? false : d.ranked === true, variant, d.capacity);
    if (annihilation) room.erosion = d.erosion;
    if (variant === MIZUKI_VARIANT) room.mizukiDifficultyGrade = d.mizukiDifficultyGrade ?? 0;
    room.test = d.test === true;
    if (room.test) room.ranked = false;
    if (Number.isFinite(d.createdAt) && d.createdAt >= 0 && d.createdAt <= now) room.createdAt = d.createdAt;
    room.aiPicksLast = d.mode !== 'solo' && d.aiPicksLast === true;
    room.ownerKey = typeof d.ownerKey === 'string' ? d.ownerKey : null;
    room.matchKey = typeof d.matchKey === 'string' ? d.matchKey : null;
    room.matchCount = Number.isInteger(d.matchCount) && d.matchCount >= 0 ? d.matchCount : 0;
    room.restoredMatchContext = d.matchContext || null;
    if (variant === ENDLESS_VARIANT || variant === MIZUKI_VARIANT || annihilation || zhajing) room.content = lobby.vanilla;
    else lobby.restoreContent(room,d.content);
    for (const s of Array.isArray(d.seats) ? d.seats : []) {
      if (!s || typeof s.playerId !== 'string' || !Number.isInteger(s.seat) || s.seat < 0 || s.seat >= room.capacity
          || room.seats[s.seat] || room.seatOf(s.playerId) || (d.mode === 'solo' && (s.seat !== 0 || s.isBot))) continue;
      const session = s.isBot ? null : lobby.registry.byId(s.playerId);
      if (!s.isBot && !s.left && (!session || lobby.registry.isExpired(session, now)
          || session.roomCode !== room.code)) { stats.droppedSeats++; continue; }
      room.seats[s.seat] = {
        ...s, isBot: !!s.isBot, left: !!s.left, ready: !!s.ready, connected: !!s.isBot,
        name: session?.name || s.name || '博士', aid: s.aid || session?.aid || null,
        zhajingLoadout: session?.zhajingLoadout || s.zhajingLoadout || null, zhajingOps: session?.zhajingOps || s.zhajingOps || null,
        loadout: session?.loadout || s.loadout || null, ops: session?.ops || s.ops || null,
        notOwned: session?.notOwned || s.notOwned || null, diy: session?.diy || s.diy || null,
        skins: session?.skins || s.skins || null, card: s.card || '', cardSkin: s.cardSkin || '', nameplate: s.nameplate || '',
      };
      stats.seats++;
    }
    if (!room.activeHumans().length) { lobby.releaseContent(room.content); continue; }
    room.lastSummary = d.lastSummary || null;
    if (d.replay && Array.isArray(d.replay.frames) && Array.isArray(d.replay.pending)) {
      room.replay = { publicFrame: d.replay.publicFrame || null,
        frames: new Map(d.replay.frames), pending: new Set(d.replay.pending) };
    }
    const host = room.seatOf(d.hostId);
    room.hostId = host && !host.isBot && !host.left ? host.playerId : null;
    if (!room.hostId) lobby.migrateHost(room);
    lobby.rooms.set(room.code, room);
    stats.rooms++;
    for (const s of room.activeHumans()) lobby.startGrace(room, s);
  }
  // Invitations and matchmaking votes need connected humans to be published again after a restart.
  for (const s of lobby.registry.all()) if (s.roomCode && !lobby.rooms.get(s.roomCode)?.seatOf(s.playerId)) s.roomCode = null;
  return stats;
}

export async function restoreLobbyMatch(lobby, room, checkpoint) {
  if (!room || room.disposed || room.match || !checkpoint || !Array.isArray(checkpoint.players) || !checkpoint.players.length) return false;
  if (checkpoint.roomCode !== room.code || checkpoint.mode !== room.mode || checkpoint.difficulty !== room.difficulty
      || (checkpoint.variant || null) !== room.variant) return false;
  const seen = new Set();
  for (const p of checkpoint.players) {
    const seat = room.seatOf(p?.playerId);
    if (!seat || seen.has(p.playerId) || seat.seat !== p.seat || seat.isBot !== !!p.isBot) return false;
    if (!seat.isBot && !seat.left && !lobby.registry.byId(p.playerId)) return false;
    seen.add(p.playerId);
  }
  if (seen.size !== room.seats.filter(Boolean).length) return false;
  return !(await lobby.startMatchWith(room, room.matchKey, checkpoint))?.error;
}

export async function adoptRestoredMatch(lobby, room, { match, ctx, key, checkpoint }) {
  if (match.hosted) {
    if (checkpoint.cs !== room.content?.cs) { lobby.disposeMatchCtx(ctx); return {error:ERR.INTERNAL,detail:'plugin checkpoint content changed'}; }
    try { match.start(); await match.restoreReady; }
    catch(e) { lobby.disposeMatchCtx(ctx); return {error:ERR.INTERNAL,detail:'plugin checkpoint refused'}; }
  } else if (!applyCheckpoint(match, checkpoint, { createRngFromState, log: lobby.log })) {
    lobby.disposeMatchCtx(ctx);
    return { error: ERR.INTERNAL, detail: 'match checkpoint refused' };
  }
  if (!match.hosted) {
    // Official checkpoints resume under the installed official engine; gameplay plugin identities stay pinned above.
    match.cs = room.content?.cs || null;
    match.vs = room.content?.vs || null;
    match.requireCs = false;
  }
  room.match = match; room.matchCtx = ctx; room.matchKey = key; room.replay = null;
  if (room.variant === MIZUKI_VARIANT) room.mizukiDifficultyGrade = match.difficultyGrade;
  delete room.restoredMatchContext;
  for (const s of room.activeHumans()) lobby.clearGrace(s.playerId);
  lobby.log.info(`[lobby] ${room.code} match #${room.matchCount} restored (${room.variant || room.mode}/${room.difficulty}, round ${match.round}, ${match.phase})`);
  lobby.broadcastState(room);
  lobby.checkpoint(room.code, match);
  return { ok: true };
}
