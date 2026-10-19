import { ERR, DIFFICULTIES, ENDLESS_VARIANT, modeIdFor } from '../../shared/constants.js';
import { isContentHash } from '../../shared/plugins/identity.js';
import { KITTED_CHARS } from '../sim/content/kits/index.js';
const VANILLA_KITTED=new Set(KITTED_CHARS);
const OK=Object.freeze({ok:true});
const fail=(error,detail)=>({error,...(detail?{detail}: {})});
const isErrCode=(code)=>Object.values(ERR).includes(code);
export class PluginLobby {
  setPlugins(session, { plugins }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.variant === ENDLESS_VARIANT) return fail(ERR.PLUGIN_BLOCKED, '无尽模式使用内置规则，不接受房间插件');
    if (room.ranked) return fail(ERR.PLUGIN_BLOCKED, '排位房间仅使用原版内容');
    if (room.matchFill || room.matchCandidate) return fail(ERR.PLUGIN_BLOCKED, '请先结束匹配补齐');
    const ids = [...new Set(plugins.map((p) => p.id))];
    /** @type {Record<string, Record<string, unknown>>} */
    const settings = {};
    for (const p of plugins) if (p.settings) settings[p.id] = p.settings;
    const r = this.resolveContent(room, ids, settings);
    if ('error' in r) return r;
    let content = r.content;
    const before = room.content;
    const sameSet = (before?.vs ?? null) === (content?.vs ?? null) && (before?.cs ?? null) === (content?.cs ?? null);
    const marks = (c) => JSON.stringify((c?.plugins || []).map((p) => [p.id, !!p.auto, p.settings || null]));
    if (sameSet && marks(before) === marks(content)) return OK;
    this.dropReplay(room, session.playerId);
    // another set: a notice still waiting for the end of a match (pluginsChanged) is moot
    if (!sameSet) { room.pluginsChanged = null; room.pluginNoticeKeys = {}; }
    // the plugin mode chosen stays while the set still provides it (header "Gameplay plugins")
    if (before?.modeId && content?.modes?.some((m) => m.id === before.modeId)) content = Object.freeze({ ...content, modeId: before.modeId });
    room.content = content;
    if (!sameSet) {
      this.holdContent(content);
      this.releaseContent(before);
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      // another content set: every page loads and checks it again (room.contentReady)
      if ((before?.cs ?? null) !== (content?.cs ?? null)) for (const s of [...room.seats]) if (s && !s.isBot)  { s.content = null; s.consentCs = null; }
      this.log.info(`[lobby] ${room.code} plugins: ${content?.plugins?.length ? content.plugins.map((p) => `${p.id}@${p.version}`).join(', ') : 'none'}${room.modded ? ` (content ${content.cs.slice(0, 8)})` : ''}`);
    }
    this.broadcastState(room);
    return OK;
  }

  /**
   * The content a room gets for the plugins `ids` (header "The room's plugins", "Gameplay plugins"): the vanilla set for
   * none, else what the room sets resolve — cosmetic plugins only: the vanilla cs with their `vs`; content plugins: the
   * content set's own cs (`vanilla: false`). Nothing is held yet (holdContent).
   * @param {Room | null} room @param {string[]} ids @param {Record<string, Record<string, unknown>>} [settings]
   * @returns {{ content: Room['content'] } | { error: string, detail?: string }}
   */
  resolveContent(room, ids, settings = {}) {
    if (!ids.length) {
      // the server owner may fix every room's plugins (plugins/config.json rooms: fixed): the original game is not one
      const fixed = (() => { try { return this.plugins?.fixed?.() || null; } catch { return null; } })();
      if (fixed && fixed.length) return fail(ERR.PLUGIN_BLOCKED, 'this server fixes every room\'s plugins (plugins/config.json rooms: fixed)');
      return { content: this.vanilla };
    }
    if (!this.vanilla || !this.plugins) return fail(ERR.PLUGIN_UNKNOWN, 'this server applies no plugins');
    let r;
    try { r = this.plugins.resolve(ids, { scope: 'room', settings, replacing: room?.content ?? null }); } catch (e) {
      this.log.error(`[lobby] ${room?.code ?? '----'} plugin set failed`, e);
      return fail(ERR.INTERNAL);
    }
    if (!r || !r.ok) return fail(r && isErrCode(r.error) ? r.error : ERR.INTERNAL, r && typeof r.detail === 'string' ? r.detail.slice(0, 200) : undefined);
    const { cs, vs, plugins: list, warnings, bytes, dataBytes, modes, kitted, trusted, execution } = r.set;
    const modded = isContentHash(cs) && cs !== this.vanilla.cs;
    const frozen = (a) => Object.freeze((Array.isArray(a) ? a : []).map((p) => Object.freeze({ ...p })));
    // the operators its plugins add to a 自选 slot's list (welcome.diyKitted holds the server's own): the pages' pickers
    const extra = modded && Array.isArray(kitted) ? kitted.filter((id) => typeof id === 'string' && !VANILLA_KITTED.has(id)).slice(0, 200) : [];
    return {
      content: Object.freeze({
        cs: modded ? cs : this.vanilla.cs,
        vanilla: !modded,
        ...(vs ? { vs } : {}),
        plugins: frozen(list),
        ...(trusted ? {trusted} : {}),
        ...(execution ? {execution} : {}),
        warnings: Object.freeze([...(warnings || [])]),
        bytes: Number(bytes) || 0,
        ...(modded ? { dataBytes: Number(dataBytes) || 0, modes: frozen(modes), ...(extra.length ? { kittedExtra: Object.freeze(extra) } : {}) } : {}),
      }),
    };
  }

  /** A room now uses `content`: its visual set and its content set are held (released by releaseContent). */
  holdContent(content) {
    if (content?.vs) this.plugins?.hold?.(content.vs);
    if (content && content.vanilla === false) this.plugins?.holdContent?.(content.cs);
  }

  /** A room no longer uses `content`. */
  releaseContent(content) {
    if (content?.vs) this.plugins?.release?.(content.vs);
    if (content && content.vanilla === false) this.plugins?.releaseContent?.(content.cs);
  }

  /**
   * room.setMode (header "Gameplay plugins"): host-only, before the match. An official mode of the room's type sets its
   * difficulty (and leaves a plugin mode); a mode of the room's content set (content.modes, the room's type) becomes
   * content.modeId — its difficulty the room's. Like a difficulty change it un-readies the other humans.
   */
  setMode(session, { modeId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.ranked || room.variant) return fail(ERR.PLUGIN_BLOCKED);
    const official = DIFFICULTIES.find((d) => modeIdFor(room.mode, d) === modeId);
    let difficulty = room.difficulty;
    let content = room.content;
    if (official) {
      difficulty = official;
      if (content?.modeId) { const rest = { ...content }; delete rest.modeId; content = Object.freeze(rest); }
    } else {
      const mode = Array.isArray(content?.modes) ? content.modes.find((m) => m && m.id === modeId) : null;
      if (!mode) return fail(ERR.BAD_TARGET, 'not a mode of this room');
      if (mode.roomMode !== room.mode) return fail(ERR.BAD_TARGET, `a mode of ${mode.roomMode} rooms`);
      if (DIFFICULTIES.includes(mode.difficulty)) difficulty = mode.difficulty;
      if (content.modeId !== modeId) content = Object.freeze({ ...content, modeId });
    }
    if (difficulty === room.difficulty && content === room.content) return OK;
    this.dropReplay(room, session.playerId);
    room.difficulty = difficulty;
    room.content = content;
    for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
    this.broadcastState(room);
    return OK;
  }

  /**
   * room.contentReady { cs, ok? } (header "Gameplay plugins"): the member's page has loaded and checked the room's content
   * set (`ok: false`: it could not). Recorded for the room's current set only — a page that checked an older one is
   * answered OK and changes nothing — and only for the page that is there: a session whose socket is gone, or a message
   * that waited on the room's queue across a disconnect of its seat (`ctx.from`: the seat's generation when it was
   * queued), is answered OK and writes nothing (the page that comes back checks the set again).
   * @param {import('./net.js').Session} session @param {{ cs: string, ok?: boolean }} msg
   * @param {{ from?: { seat: Seat, gen: number } | null } | null} [ctx]
   */
  contentReady(session, { cs, ok }, ctx = null) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!room.modded || room.content.cs !== cs) return OK;
    if (!session.connected) return OK;
    const seat = room.seatOf(session.playerId);
    if (!seat) return OK;
    if (ctx && ctx.from && (ctx.from.seat !== seat || ctx.from.gen !== (seat.contentGen || 0))) return OK;

    const state = ok === false ? 'failed' : 'ready';
    if (seat.content === state) return OK;
    seat.content = state;
    if (state === 'failed') this.log.warn(`[lobby] ${room.code} ${session.name}: the room's content ${cs.slice(0, 8)} did not load or check on that page`);
    this.broadcastState(room);
    return OK;
  }


  dataFor(room) { return room?.modded ? this.plugins?.dataOf(room.content.cs) || this.safeData() : this.safeData(); }
  kittedFor(room) { return room?.modded ? this.plugins?.kittedOf(room.content.cs) || KITTED_CHARS : KITTED_CHARS; }
  notePluginsChanged(identity, ids, kind) {
    for (const room of this.rooms.values()) {
      if (room.disposed || (kind === 'content' ? room.content?.cs : room.content?.vs) !== identity) continue;
      room.pluginsChanged = [...new Set([...(room.pluginsChanged || []), ...ids])];
      if (!room.match) this.tellPluginsChanged(room);
    }
  }
  tellPluginsChanged(room) {
    const ids = room.pluginsChanged;
    room.pluginsChanged = null;
    if (!ids?.length || !room.content?.plugins?.length) return;
    this.sendToPlayer(room, room.hostId, { t:'m.toast', kind:'warn',
      text:`房间插件「${ids.slice(0,8).join('、')}」的文件在服务器上变了，请在插件面板中点「重新应用」` });
  }
  refreshPlugins(room) {
    if (!room || room.disposed || room.match) return;
    const picks=(room.content?.plugins || []).filter(p=>!p.auto);
    const session=this.registry.byId(room.hostId);
    if (session) return this.setPlugins(session,{plugins:picks});
  }
  restoreContent(room,saved) {
    if (!saved || !saved.plugins?.length) { room.content=this.vanilla; return; }
    if (room.ranked) throw new Error('ranked room cannot restore plugins');
    const settings=Object.fromEntries(saved.plugins.filter(p=>p.settings).map(p=>[p.id,p.settings]));
    const r=this.resolveContent(room,saved.plugins.filter(p=>!p.auto).map(p=>p.id),settings);
    const wrongGameplay = saved.vanilla === true ? r.content?.vanilla !== true : r.content?.cs !== saved.cs;
    if (r.error || wrongGameplay || (r.content?.vs || null)!==(saved.vs || null)) throw new Error('saved plugin content unavailable or changed; original state preserved');
    if (saved.modeId && !r.content?.modes?.some(m=>m.id===saved.modeId)) throw new Error('saved plugin mode unavailable');
    room.content=Object.freeze({...r.content,...(saved.modeId?{modeId:saved.modeId}:{})}); this.holdContent(room.content);
  }
}
export function installPluginLobby(Lobby) { for (const [key,desc] of Object.entries(Object.getOwnPropertyDescriptors(PluginLobby.prototype))) if(key!=='constructor') Object.defineProperty(Lobby.prototype,key,desc); }
