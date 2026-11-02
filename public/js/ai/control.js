// Opt-in player automation. Never writes simulation state or reports battle results.
import { C2S, validateC2S, DIRS, isLoadoutOps } from '../../../shared/protocol.js';
import { GEO, DIFFICULTIES, EMOTES } from '../../../shared/constants.js';
import { POTENTIAL_DEFAULT, CULTIVATE_DEFAULT } from '../../../shared/potential.js';
export const AGENT_API_VERSION = 1;
const INTERNAL = new Set(['hello', 'ping', 'session.probeAck', 'session.release', 'b.progress', 'b.result', 'b.yield', 'g.test', 'room.contentReady', 'profile.presentation', 'profile.loadout']);
const SECRET_KEYS = /^(token|password|newPassword|confirmPassword|ticket|authTicket|accessToken|refreshToken|sessionToken|authorization|auth|aid|clientAid|deviceId|legacyEntries|legacyOps)$/i;
const FILES = new Set(['chess', 'items', 'enemies', 'bonds', 'bands', 'stages', 'bosses', 'tokens', 'choices', 'garrisons', 'backups', 'cyclops']);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
export function publicCopy(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (key, item) => SECRET_KEYS.test(key) ? undefined : item));
}
export function operationCatalog() {
  return Object.entries(C2S).filter(([type]) => !INTERNAL.has(type)).map(([type, spec]) => ({
    type,
    required: Object.entries(spec).filter(([key, check]) => key !== '$optional' && !(spec.$optional || []).includes(key) && !check(undefined)).map(([key]) => key),
    optional: Object.entries(spec).filter(([key, check]) => key !== '$optional' && ((spec.$optional || []).includes(key) || check(undefined))).map(([key]) => key),
  }));
}
export class AgentError extends Error {
  constructor(code, message, detail = null) { super(message); this.code = code; this.detail = detail; }
}
export function createAgentControl({ net, store, runner = null, data = null, joinRoom = null, switchServer = null, watchMatch = null, appearance = null, loadout = null, now = Date.now } = {}) {
  if (!net?.request || !store?.get) throw new Error('net and store required');
  let disposed = false, sequence = 0, revision = 0, battleSnapshot = null, battleEvents = null, eventBytes = 0, activeRequests = 0;
  const matchKey = () => store.get().match?.public?.matchId || store.get().matchChat?.matchId || null;
  let lastField = store.get().match?.field || null, lastMatch = matchKey(), lastPlayer = store.get().me?.playerId || null;
  const events = [], subscriptions = [], observers = new Set(), pendingWaits = new Set();
  const clearBattle = () => { battleSnapshot = null; battleEvents = null; };
  const push = (type, value) => {
    if (disposed) return;
    let payload = publicCopy(value);
    if (JSON.stringify(payload).length > 65536) payload = { omitted: true, reason: 'large event; use state()', fieldId: value?.fieldId, battleId: value?.battleId };
    const event = { seq: ++sequence, at: now(), type, data: payload }, bytes = JSON.stringify(event).length;
    events.push({ event, bytes }); eventBytes += bytes;
    while (events.length > 256 || eventBytes > 512 * 1024) eventBytes -= events.shift().bytes;
    for (const fn of observers) { try { fn(publicCopy(event)); } catch { /* isolate consumer errors */ } }
  };
  if (store.subscribe) subscriptions.push(store.subscribe(s => {
    revision++;
    const field = s.match?.field || null, match = matchKey(), player = s.me?.playerId || null;
    if (field !== lastField || match !== lastMatch || player !== lastPlayer) clearBattle();
    if (player !== lastPlayer) { events.length = 0; eventBytes = 0; }
    lastField = field; lastMatch = match; lastPlayer = player;
  }));
  if (net.on) subscriptions.push(net.on('*', frame => {
    if (!['b.snap', 'b.ev', 'pong', 'session.probe'].includes(frame?.t)) push(frame?.t || 'message', frame?.t === 'b.start' ? { ...frame, spec: undefined } : frame);
    if (['b.start', 'b.end', 'room.closed'].includes(frame?.t)) clearBattle();
    if (frame?.t === 'b.snap') battleSnapshot = { at: now(), data: frame };
    if (frame?.t === 'b.ev') { battleEvents = { at: now(), data: frame }; push('battle.events', frame); }
  }));
  if (runner?.on) {
    subscriptions.push(runner.on('snap', frame => { battleSnapshot = { at: now(), data: frame }; }));
    subscriptions.push(runner.on('ev', frame => { battleEvents = { at: now(), data: frame }; push('battle.events', frame); }));
    subscriptions.push(runner.on('field', frame => { clearBattle(); push('battle.field', frame); }));
    subscriptions.push(runner.on('state', frame => push('battle.state', frame)));
  }
  function assertActive() { if (disposed) throw new AgentError('CLOSED', 'AI interface is detached'); }
  function assertOnline() { assertActive(); if (net.status !== 'online') throw new AgentError('OFFLINE', 'Player is not online'); if (!store.get().session?.entered || !store.get().me?.playerId) throw new AgentError('NO_SESSION', 'Log in normally before controlling a player'); }
  function state() {
    assertActive(); const s = store.get();
    return publicCopy({ apiVersion: AGENT_API_VERSION, at: now(), sequence, revision, serverId: net.serverId, matchId: matchKey(), connection: s.connection, me: { playerId: s.me?.playerId, name: s.me?.name }, room: s.room, match: s.match, chat: s.chat, matchChat: s.matchChat, recruitment: s.recruitment, spectator: s.spectator, rank: s.rank, appearance: appearance?.get?.(), loadout: loadout?.get?.(), battle: { state: runner?.state?.() || null, snapshot: battleSnapshot, events: battleEvents } });
  }
  async function request(type, fields = {}, guard = {}) {
    assertOnline();
    if (!Object.hasOwn(C2S, type) || INTERNAL.has(type)) throw new AgentError('FORBIDDEN_OPERATION', 'Not a player intent: ' + type);
    if (!plain(fields) || Object.hasOwn(fields, 't') || Object.hasOwn(fields, 'rid')) throw new AgentError('BAD_INPUT', 'fields must not override t/rid');
    if (Object.keys(fields).some(k => !Object.hasOwn(C2S[type], k) || k === '$optional')) throw new AgentError('BAD_INPUT', 'Unknown operation field');
    const reason = validateC2S({ ...fields, t: type }); if (reason) throw new AgentError('BAD_MSG', reason);
    if (!plain(guard) || Object.keys(guard).some(k => !['matchId', 'round', 'phase', 'revision'].includes(k))) throw new AgentError('BAD_INPUT', 'Invalid guard');
    const pub = store.get().match?.public, current = { matchId: matchKey(), round: pub?.round, phase: pub?.phase, revision };
    for (const [key, value] of Object.entries(guard)) if (value !== current[key]) throw new AgentError('STALE_STATE', 'State changed: ' + key, current);
    if (activeRequests >= 4) throw new AgentError('BUSY', 'At most four outstanding player requests');
    if (JSON.stringify(fields).length > 49152) throw new AgentError('BAD_INPUT', 'Request too large');
    activeRequests++;
    try { const reply = await net.request(type, fields); return { accepted: true, type, reply: publicCopy(reply), state: disposed ? null : state() }; } finally { activeRequests--; }
  }
  async function chat({ text, channel = 'match' } = {}) {
    const matchId = matchKey();
    if (channel === 'match' && !matchId) throw new AgentError('NO_MATCH', 'Use lobby channel outside a match');
    return request('chat.send', { text, channel, ...(channel === 'match' ? { matchId } : {}) });
  }
  async function library({ file = 'chess', id, query = '', offset = 0, limit = 30 } = {}) {
    assertActive();
    if (!FILES.has(file) || typeof query !== 'string' || query.length > 100 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AgentError('BAD_INPUT', 'Invalid library query');
    if (!data?.load) throw new AgentError('UNAVAILABLE', 'Game data unavailable');
    if (!await data.load(file)) throw new AgentError('DATA_UNAVAILABLE', 'Data not loaded: ' + file);
    assertActive();
    if (id !== undefined) { if (typeof id !== 'string') throw new AgentError('BAD_INPUT', 'id must be a string'); const record = data.lookup(file, id); if (!record) throw new AgentError('NOT_FOUND', 'Unknown record: ' + id); return publicCopy({ file, record }); }
    const q = query.toLowerCase(), items = data.list(file).filter(c => !q || [c.name, c.chessId, c.charId, c.id, c.appellation].some(x => String(x || '').toLowerCase().includes(q)));
    return publicCopy({ file, total: items.length, offset, items: items.slice(offset, offset + limit) });
  }
  function unit({ unitId, uid, ownerId = store.get().me?.playerId, fieldId } = {}) {
    assertActive(); if (!runner?.unitStats) throw new AgentError('UNAVAILABLE', 'Battle runner unavailable');
    if (unitId === undefined) { if (!Number.isInteger(uid) || uid < 1 || !ownerId) throw new AgentError('BAD_INPUT', 'Pass unitId or uid and ownerId'); unitId = runner.unitIdOf?.(uid, ownerId, fieldId); }
    if (unitId == null || !Number.isInteger(unitId)) return { found: false, unit: null };
    const result = runner.unitStats(unitId, fieldId);
    return publicCopy({ found: !!result, fieldId: fieldId || runner.state?.().fieldId || null, unit: result || null });
  }
  async function profileEdit(adapter, method, args, matches = () => true) {
    assertOnline(); if (!adapter?.get || !adapter[method]) throw new AgentError('UNAVAILABLE', 'Profile adapter unavailable');
    const before = adapter.get();
    if (!before.profileReady || before.locked) throw new AgentError('PROFILE_LOCKED', 'Profile unavailable or locked');
    if (before.sync !== 'synced') throw new AgentError('BUSY', 'Wait for the current profile save');
    if (adapter[method](...args) === false) throw new AgentError('BAD_INPUT', 'Profile selection rejected');
    return new Promise((resolve, reject) => {
      let timer, off;
      const finish = (error, value) => { clearTimeout(timer); off?.(); pendingWaits.delete(cancel); error ? reject(error) : resolve(value); };
      const cancel = () => finish(new AgentError('CLOSED', 'Detached while waiting for profile save'));
      const check = () => { const s = adapter.get(); if (s.identityEpoch !== before.identityEpoch || s.profileId !== before.profileId) return finish(new AgentError('IDENTITY_CHANGED', 'Profile identity changed')); if (s.sync === 'error' || s.sync === 'locked') return finish(new AgentError('PROFILE_REJECTED', 'Server did not save profile')); if (s.sync === 'synced') { if (!matches(s)) return finish(new AgentError('PROFILE_CHANGED', 'Saved selection differs from requested selection')); finish(null, { accepted: true, saved: true, profile: publicCopy(s) }); } };
      pendingWaits.add(cancel); off = adapter.subscribe?.(check); timer = setTimeout(() => finish(new AgentError('SAVE_TIMEOUT', 'Profile save not confirmed')), 15000); check();
    });
  }
  return {
    version: AGENT_API_VERSION, state, request, chat, library, unit,
    catalog() { return { apiVersion: AGENT_API_VERSION, operations: operationCatalog(), methods: ['state', 'context', 'events', 'request', 'chat', 'strategy', 'library', 'unit', 'join', 'switchServer', 'watch', 'avatar', 'skin', 'skins', 'portrait', 'voice', 'loadout', 'operatorSettings'], coordinates: { rows: GEO.ROWS, cols: GEO.COLS, handSize: GEO.HAND_SIZE, rowZero: 'bottom', directions: DIRS }, difficulties: DIFFICULTIES, emotes: EMOTES }; },
    context() { const s = state(), pub = s.match?.public || {}, mine = s.match?.private || {}; return { at: s.at, sequence: s.sequence, revision: s.revision, matchId: s.matchId, me: s.me, phase: pub.phase, round: pub.round, deadline: pub.deadline, serverNow: pub.serverNow, players: pub.players || [], funds: mine.funds, lp: mine.lp, canReady: mine.canReady, deployCap: mine.deployCap, deployCount: mine.deployCount, shop: mine.shop, board: mine.board, hand: mine.hand, temp: mine.temp, bonds: mine.bonds, effects: mine.effects, nextEnemies: mine.nextEnemies, personalChoice: mine.personalChoice, draft: pub.draft, sp: pub.sp, unite: pub.unite, cyclops: pub.cyclops, relics: mine.relics, messages: s.matchChat?.items || [], field: s.match?.field, battle: s.battle }; },
    strategy({ text } = {}) { return chat({ text, channel: 'match' }); },
    async join({ target } = {}) { assertOnline(); if (typeof target !== 'string' || !joinRoom) throw new AgentError('BAD_INPUT', 'Room code or invitation required'); return { accepted: !!await joinRoom(target), state: state() }; },
    async switchServer({ id } = {}) { assertOnline(); if (!['main', 'secondary'].includes(id) || !switchServer) throw new AgentError('BAD_INPUT', 'Unknown server'); return { accepted: !!await switchServer(id), state: state() }; },
    async watch({ target } = {}) { assertOnline(); if (!watchMatch || (!plain(target) && typeof target !== 'string')) throw new AgentError('BAD_INPUT', 'Spectator invitation required'); return { accepted: !!await watchMatch(target), state: state() }; },
    avatar({ charId, choice } = {}) { if (typeof charId !== 'string' || (choice !== undefined && typeof choice !== 'string')) throw new AgentError('BAD_INPUT', 'charId and optional choice must be strings'); return profileEdit(appearance, 'setPlayerCard', [charId, choice], s => { if (s.card !== charId) return false; if (choice === undefined || !charId.startsWith('char_')) return true; const base = data?.list?.('chess')?.find(c => c.charId === charId && !c.isGolden && !c.isDiy); return s.portraits?.[base?.baseId || base?.chessId || ('char:' + charId)] === choice; }); },
    skin({ id, skin } = {}) { if (typeof id !== 'string' || typeof skin !== 'string') throw new AgentError('BAD_INPUT', 'id and skin required'); return profileEdit(appearance, 'setSkin', [id, skin], s => s.entries?.[id] === skin); },
    async skins({ charId } = {}) { assertActive(); if (typeof charId !== 'string' || !appearance?.availableSkins) throw new AgentError('BAD_INPUT', 'charId required'); await data?.load?.('skins'); await data?.load?.('assets'); assertActive(); return publicCopy({ charId, items: appearance.availableSkins(charId) }); },
    portrait({ id, choice } = {}) { if (typeof id !== 'string' || typeof choice !== 'string') throw new AgentError('BAD_INPUT', 'id and choice required'); return profileEdit(appearance, 'setPortrait', [id, choice], s => s.portraits?.[id] === choice); },
    voice({ enabled, lang, volume } = {}) { const patch = Object.fromEntries(Object.entries({ enabled, lang, volume }).filter(([, v]) => v !== undefined)); if (!Object.keys(patch).length || enabled !== undefined && typeof enabled !== 'boolean' || lang !== undefined && !['jp', 'cn', 'en', 'kr', 'native'].includes(lang) || volume !== undefined && !(Number.isFinite(volume) && volume >= 0 && volume <= 1)) throw new AgentError('BAD_INPUT', 'Invalid voice selection'); return profileEdit(appearance, 'setVoice', [patch], s => Object.entries(patch).every(([key, val]) => s.voice?.[key] === val)); },
    loadout({ entries } = {}) { const reason = validateC2S({ t: 'room.loadout', entries }); if (reason) throw new AgentError('BAD_MSG', reason); return profileEdit(loadout, 'setEntries', [entries], s => Object.entries(entries).every(([id, wanted]) => Object.entries(wanted).every(([key, val]) => s.entries?.[id]?.[key] === val))); },
    operatorSettings({ ops } = {}) { if (!isLoadoutOps(ops)) throw new AgentError('BAD_INPUT', 'Invalid operator potential/cultivate map'); return profileEdit(loadout, 'setOpsMap', [ops], s => Object.entries(ops).every(([id, wanted]) => Object.entries(wanted).every(([key, val]) => (s.ops?.[id]?.[key] ?? (key === 'potential' ? POTENTIAL_DEFAULT : CULTIVATE_DEFAULT)) === val))); },
    events({ after = 0, limit = 100 } = {}) {
      assertActive(); if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 256) throw new AgentError('BAD_INPUT', 'Invalid event cursor/limit');
      const selected = events.filter(x => x.event.seq > after).slice(0, limit);
      return publicCopy({ sequence, next: selected.at(-1)?.event.seq ?? after, truncated: events.length > 0 && after < events[0].event.seq - 1, events: selected.map(x => x.event) });
    },
    subscribe(fn) { assertActive(); observers.add(fn); return () => observers.delete(fn); },
    dispose() { if (disposed) return; disposed = true; for (const cancel of [...pendingWaits]) cancel(); for (const off of subscriptions) off?.(); observers.clear(); events.length = 0; eventBytes = 0; clearBattle(); },
  };
}
