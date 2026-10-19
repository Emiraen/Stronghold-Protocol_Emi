import { t as trA } from '../../../shared/i18n.js';
// 档案调配以服务器为准；无身份的旧本地配置仅供用户主动导入。
import { createStore, loadPref, savePref } from '../store.js';
import { data } from '../data.js';
import { contentSet as appContentSet } from '../content.js';
import { LOADOUT_PREF, parseStored, parseStoredOps, sanitizeEntries, sanitizeOps } from './loadoutModel.js';
import { isLoadoutEntries, isLoadoutOps, cultivationCharIds } from '../../../shared/protocol.js';
import { OWNERSHIP_PREF, parseStoredOwnership, toStoredOwnership, cleanIds, sanitizeNotOwned } from './ownershipModel.js';
import { DIY_PREF, parseStoredDiy, toStoredDiy, cleanPicks, sanitizeDiyPicks } from './diyModel.js';
import { t, N_ } from '../../../shared/i18n.js';
import { toast } from './toasts.js';

export const SYNC_DEBOUNCE_MS = 500;
export const RETRY_MS = 1500;

function readStored() {
  try { return parseStored(loadPref(LOADOUT_PREF, null)); } catch { return {}; }
}
function readStoredOps() {
  try { return parseStoredOps(loadPref(LOADOUT_PREF, null)); } catch { return {}; }
}

function readStoredOwnership() {
  try { return parseStoredOwnership(loadPref(OWNERSHIP_PREF, null)); } catch { return []; }
}
function readStoredDiy() {
  try { return parseStoredDiy(loadPref(DIY_PREF, null)); } catch { return {}; }
}


export const loadoutStore = createStore({
  notOwned: readStoredOwnership(), diy: readStoredDiy(), diyKitted: null, tab: 'loadout', ownSync: 'idle', diySync: 'idle',
  entries: {},
  ops: {},
  legacyEntries: readStored(),
  legacyOps: readStoredOps(),
  profileId: null,
  profileReady: false,
  initialized: false,
  identityEpoch: 0,
  open: false,
  from: null,
  sel: null,
  filters: { tier: null, prof: null, bond: null, query: '', changedOnly: false },
  sync: 'loading',
});

/** 仅用户编辑调用；异步导入/确认必须携带开始时的身份代次。 */
export function setEntries(entries, identityEpoch = loadoutStore.get().identityEpoch) {
  const s = loadoutStore.get();
  if (!s.profileReady || identityEpoch !== s.identityEpoch) return false;
  loadoutStore.set({ entries: entries && typeof entries === 'object' ? entries : {} });
  return true;
}

export function setOpsMap(ops, identityEpoch = loadoutStore.get().identityEpoch) {
  const state = loadoutStore.get();
  if (!state.profileReady || identityEpoch !== state.identityEpoch) return false;
  loadoutStore.set({ ops: ops && typeof ops === 'object' ? ops : {} });
  return true;
}

export function applyLoadoutEntries(entries, lookup, options = loadoutStore.get().identityEpoch) {
  const opts = typeof options === 'number' ? { identityEpoch: options } : options || {};
  const identityEpoch = opts.identityEpoch ?? loadoutStore.get().identityEpoch;
  const asked = Object.keys(entries || {}).length;
  const clean = sanitizeEntries(entries, lookup);
  const applied = Object.keys(clean).length;
  const cleanOps = opts.ops && opts.isOperator ? sanitizeOps(opts.ops, opts.isOperator) : null;
  const countOps = cleanOps ? Object.keys(cleanOps).length : 0;
  const askedOps = opts.ops ? Object.keys(opts.ops).length : 0;
  const state = loadoutStore.get();
  if (!state.profileReady || state.identityEpoch !== identityEpoch) return { applied: 0, ops: 0, dropped: asked + askedOps };
  if (applied || countOps) loadoutStore.set({ ...(applied ? { entries: clean } : {}), ...(cleanOps ? { ops: cleanOps } : {}) });
  return { applied, ...(cleanOps ? { ops: countOps } : {}), dropped: Math.max(0, asked - applied) + Math.max(0, askedOps - countOps) };
}

export function importLegacyLoadout(lookup, identityEpoch = loadoutStore.get().identityEpoch) {
  const s = loadoutStore.get();
  if (!s.profileReady || s.initialized || s.identityEpoch !== identityEpoch) return { applied: 0, dropped: 0 };
  const ids = cultivationCharIds(data.get('chess'), data.get('backups'));
  return applyLoadoutEntries(s.legacyEntries, lookup, { identityEpoch, ops: s.legacyOps, isOperator: (id) => ids.has(id) });
}

export function openLoadout(from = 'lobby', sel = null, tab = null) {
  data.load('chess');
  data.load('bonds');
  data.load('assets');
  data.load('local');
  data.load('backups');
  data.load('effects');
  data.load('garrisons');
  loadoutStore.set({ open: true, from, ...(sel ? { sel } : {}), ...(['loadout', 'ownership', 'diy'].includes(tab) ? { tab } : {}) });
}
export const closeLoadout = () => loadoutStore.set({ open: false });

/** 网络、数据与计时器可注入；服务端状态永不触发上传。 */
export function installLoadoutSync({ net, getChessReady, lookupChess, timers, target = loadoutStore, notify } = {}) {
  const T = timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  const ready = getChessReady || (() => data.load('chess'));
  const lookup = lookupChess || ((id) => data.lookup('chess', id));
  const tell = notify || ((text) => toast(text, 'warn'));
  let timer = null;
  let epoch = 0;
  let seq = 0;
  let pendingJson = null;
  let lastAccepted = null;
  let edited = false;
  let applying = false;
  let disposed = false;
  let stateSerial = 0;

  const setState = (sync) => { if (target.get().sync !== sync) target.set({ sync }); };
  const replace = (patch) => {
    applying = true;
    try { target.set(patch); } finally { applying = false; }
  };
  const cancelTimer = () => { T.clearTimeout(timer); timer = null; };
  const reset = () => {
    cancelTimer();
    epoch++;
    seq++;
    edited = false;
    pendingJson = lastAccepted = null;
    replace({ entries: {}, ops: {}, profileId: null, profileReady: false, initialized: false,
      identityEpoch: (target.get().identityEpoch || 0) + 1, sync: 'loading' });
  };
  const schedule = (ms = SYNC_DEBOUNCE_MS) => {
    if (disposed || !target.get().profileReady || !edited) return;
    cancelTimer();
    setState('pending');
    timer = T.setTimeout(() => { timer = null; void flush(); }, ms);
  };

  async function flush() {
    if (disposed || !edited || !target.get().profileReady || net.status !== 'online') return;
    const generation = epoch;
    const current = target.get().entries;
    try {
      const empty = !current || Object.keys(current).length === 0;
      const loaded = empty ? true : await ready();
      if (disposed || generation !== epoch || !edited || !target.get().profileReady || net.status !== 'online') return;
      if (loaded == null) { setState('error'); return; }
      const needsOps = Object.keys(target.get().ops || {}).length > 0;
      if (needsOps) {
        const opData = await Promise.all([data.load('chess'), data.load('backups')]);
        if (opData.some((value) => value == null)) { setState('error'); return; }
      }
      if (disposed || generation !== epoch || !edited || !target.get().profileReady || net.status !== 'online') return;
      // Read both maps after all data awaits so a newer edit cannot be paired with stale entries.
      const latest = target.get();
      const entries = sanitizeEntries(latest.entries || {}, lookup);
      const ids = cultivationCharIds(data.get('chess'), data.get('backups'));
      const ops = sanitizeOps(latest.ops || {}, (id) => ids.has(id));
      const json = JSON.stringify({ entries, ops });
      if (json === pendingJson) { edited = false; setState('sending'); return; }
      if (json === lastAccepted && pendingJson == null && target.get().initialized) {
        edited = false; setState('synced'); return;
      }
      const my = ++seq;
      const serial = stateSerial;
      edited = false;
      pendingJson = json;
      setState('sending');
      try {
        await net.request('profile.loadout', { v: 1, profileId: target.get().profileId, editId: my, entries, ops });
        if (disposed || generation !== epoch || my !== seq) return;
        pendingJson = null;
        lastAccepted = json;
        if (!edited && serial === stateSerial) setState('synced');
      } catch (err) {
        if (disposed || generation !== epoch || my !== seq) return;
        pendingJson = null;
        const code = err?.code;
        if (code === 'WRONG_PHASE' || code === 'ROOM_STARTED') {
          lastAccepted = json;
          if (!edited) setState('locked');
          tell(trA("本局的干员调配已锁定，修改将在下一局生效"));
        } else if (code === 'RATE' || code === 'TIMEOUT' || code === 'OFFLINE') {
          // 已收到权威状态就不重发超时的旧编辑，以免覆盖其他客户端的新值。
          if (serial === stateSerial) { edited = true; schedule(RETRY_MS); }
        } else {
          console.warn('[loadout] profile.loadout refused', code, err?.detail);
          if (!edited) { edited = true; setState('error'); }
        }
      }
    } catch (e) {
      if (disposed || generation !== epoch) return;
      console.warn('[loadout] sync failed', e);
      setState('error');
    }
  }

  const offWelcome = net.on('welcome', reset);
  const offStatus = net.on('status', (s) => { if (s?.status !== 'online') reset(); });
  const offState = net.on('loadout.state', (msg) => {
    if (disposed || net.status !== 'online' || msg?.v !== 1 || !/^[0-9a-f]{32}$/.test(msg.profileId)
        || typeof msg.initialized !== 'boolean' || !isLoadoutEntries(msg.entries) || (msg.ops != null && !isLoadoutOps(msg.ops))) return;
    const s = target.get();
    if (s.profileId && s.profileId !== msg.profileId) return;
    stateSerial++;
    const own = msg.editorId != null && msg.editorId === net.playerId;
    const olderOwn = own && msg.editId !== seq;
    lastAccepted = JSON.stringify({ entries: msg.entries, ops: msg.ops || {} });
    // 自己上一笔已发送编辑的推送不能擦掉稍后仍在防抖的编辑。
    const keepEdit = s.profileReady && (edited || olderOwn);
    if (!own) {
      seq++; pendingJson = null;
      if (!keepEdit) cancelTimer();
    }
    replace({ profileId: msg.profileId, profileReady: true, initialized: msg.initialized,
      ...(!keepEdit ? { entries: msg.entries, ops: msg.ops || {}, sync: msg.locked ? 'locked' : 'synced' } : {}) });
  });
  const offStore = target.subscribe((s, prev) => {
    if (!applying && s.profileReady && (s.entries !== prev.entries || s.ops !== prev.ops)) { edited = true; schedule(); }
    if (prev.open && !s.open && timer != null) { cancelTimer(); void flush(); }
  });
  // 回到大厅仅清状态，不上传；服务器已经更新了下局 seat 配置。
  const offRoom = net.on('room.state', (msg) => {
    if (msg && !msg.inMatch && target.get().sync === 'locked') setState('synced');
  });

  return {
    flush,
    dispose() {
      disposed = true;
      epoch++;
      cancelTimer();
      offWelcome?.(); offStatus?.(); offState?.(); offStore?.(); offRoom?.();
    },
  };
}

/** Replace the stored not-owned list (干员持有; persisted at once, the sync picks the change up). */
export function setNotOwned(list) {
  const next = cleanIds(list);
  savePref(OWNERSHIP_PREF, toStoredOwnership(next));
  loadoutStore.set({ notOwned: next });
}

/**
 * Apply an imported not-owned list (parseOwnershipImport(...).notOwned), sanitised against the loaded data (droppable
 * chess only), persisted and synced like an edit. An empty list is a valid import (= every operator owned).
 * @param {string[]} list @param {(id: string) => any} lookup chess lookup
 * @returns {{ applied: number, dropped: number }}
 */
export function applyOwnershipImport(list, lookup) {
  const asked = cleanIds(list).length;
  const clean = sanitizeNotOwned(list, lookup);
  setNotOwned(clean);
  return { applied: clean.length, dropped: Math.max(0, asked - clean.length) };
}

/** Replace the stored 自选编队 picks (persisted at once, the sync picks the change up). */
export function setDiyPicks(picks) {
  const next = cleanPicks(picks);
  try { savePref(DIY_PREF, toStoredDiy(next)); } catch { /* private mode: the session keeps it */ }
  loadoutStore.set({ diy: next });
}

/**
 * Apply an imported roster (parseDiyImport(...).picks), sanitised against the loaded data and the kit list (the picks
 * the server would keep), persisted and synced like an edit. An empty roster is a valid import (= every slot empty).
 * @param {Record<string, any>} picks @param {any} data `{ chess, backups }` @param {Iterable<string>|null} kitted
 * @returns {{ applied: number, dropped: number }}
 */
export function applyDiyImport(picks, data, kitted) {
  const asked = Object.keys(cleanPicks(picks)).length;
  const clean = sanitizeDiyPicks(picks, data, kitted);
  setDiyPicks(clean);
  const applied = Object.keys(clean).length;
  return { applied, dropped: Math.max(0, asked - applied) };
}


function installPrefSync({ net, timers, target, notify, key, stateKey, msgType, field, prepare, lockedText, tag, content = appContentSet }) {
  const T = timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  // (`lockedText` is a msgid: the toast is translated when it shows — docs/I18N.md)
  const tell = notify || ((text) => toast(t(text), 'warn'));
  let timer = null;
  let seq = 0;            // requests sent (the reply of an older one never overrides a newer one's state)
  let pendingJson = null; // JSON of the newest request still awaiting its reply
  let lastSent = null;    // JSON of the last payload the server accepted (on this session)
  let epoch = 0;
  let edited = false;     // an edit is waiting to be sent (a lock refusal is then worth telling the player)
  let disposed = false;

  const setState = (sync) => { if (target.get()[stateKey] !== sync) target.set({ [stateKey]: sync }); };

  const schedule = (ms = SYNC_DEBOUNCE_MS) => {
    if (disposed) return;
    T.clearTimeout(timer);
    setState('pending');
    timer = T.setTimeout(() => { timer = null; void flush(); }, ms);
  };

  // Review fix: a send is never held back behind one still in flight. The socket is ordered and the server applies
  // the frames in order, so the newest payload always wins; holding the edit until the previous reply arrived let a
  // click right after closing the overlay (准备就绪 → INFO_CHECK ends) overtake it, and the edit silently missed the match.
  async function flush() {
    if (disposed) return;
    if (net.status !== 'online') { setState('idle'); return; } // the next welcome resends
    const generation = epoch;
    try {
      const payload = await prepare();
      if (disposed || generation !== epoch || net.status !== 'online') return;
      // never sanitise against missing data: every entry would be dropped and the server's copy cleared
      if (payload == null) { setState('error'); return; }
      const json = JSON.stringify(payload);
      if (json === pendingJson) return; // the same content is already on its way
      if (json === lastSent && pendingJson == null) { edited = false; setState('synced'); return; }
      const my = ++seq;
      const wasEdit = edited;
      edited = false;
      pendingJson = json;
      setState('sending');
      try {
        await net.request(msgType, { [field]: payload });
        if (disposed || generation !== epoch || my !== seq) return;
        pendingJson = null;
        lastSent = json;
        setState('synced');
      } catch (err) {
        if (disposed || generation !== epoch || my !== seq) return;
        pendingJson = null;
        const code = err && err.code;
        if (code === 'WRONG_PHASE' || code === 'ROOM_STARTED') {
          // the server stored it for the next match; the running one keeps what it took
          lastSent = json;
          setState('locked');
          if (wasEdit) tell(lockedText);
        } else if (code === 'RATE' || code === 'TIMEOUT' || code === 'OFFLINE') { edited = edited || wasEdit; schedule(RETRY_MS); }
        else { console.warn(`[${tag}] ${msgType} refused`, code, err && err.detail); setState('error'); }
      }
    } catch (e) {
      if (disposed || generation !== epoch) return;
      console.warn(`[${tag}] sync failed`, e);
      setState('error');
    }
  }

  const resetSession = () => {
    epoch++; seq++; lastSent = null; pendingJson = null;
    T.clearTimeout(timer); timer = null;
  };
  const offWelcome = net.on('welcome', () => { resetSession(); schedule(50); });
  const offStatus = net.on('status', (s) => {
    if (s?.status !== 'online') { resetSession(); setState('idle'); }
  });
  const offStore = target.subscribe((s, prev) => {
    if (s[key] !== prev[key]) { edited = true; schedule(); }
    // closing the overlay sends a pending edit at once (review fix): the player's next click — 准备就绪 in the solo
    // briefing, 开始模拟 in the room — must not overtake the debounced message (the match locks its loadout when
    // INFO_CHECK ends, so a late edit would silently only apply to the next match). Same socket ⇒ ordered.
    if (prev.open && !s.open && timer != null) { T.clearTimeout(timer); timer = null; void flush(); }
  });
  // a match leaving INFO_CHECK locks the loadout; a new match (the room back in LOBBY / a new INFO_CHECK) accepts it again
  const offRoom = net.on('room.state', (msg) => { if (msg && !msg.inMatch && target.get()[stateKey] === 'locked') { lastSent = null; schedule(); } });
  let contentKey = content ? content.get().cs + '|' + content.get().status : '';
  const offContent = content?.subscribe((c) => {
    const key = c.cs + '|' + c.status;
    if (key === contentKey) return;
    contentKey = key;
    resetSession();
    if (c.status === 'ready' || c.status === 'idle') schedule(50);
  });


  return {
    flush,
    dispose() {
      disposed = true;
      T.clearTimeout(timer);
      offWelcome?.();
      offStatus?.();
      offStore?.();
      offRoom?.();
      offContent?.();
    },
  };
}


/**
 * Wire the 干员持有 sync once (0.2.0 补位): `room.ownership { notOwned }` after every welcome and edit. The list goes as
 * stored (structurally clean); the server keeps its droppable chess. During a match the server stores it for the next
 * one (ROOM_STARTED → 'locked'): the setting is out of match.
 * @param {{ net: any, timers?: { setTimeout: Function, clearTimeout: Function }, target?: ReturnType<typeof createStore>,
 *   notify?: (text: string) => void }} deps
 */
export function installOwnershipSync({ net, timers, target = loadoutStore, notify } = {}) {
  return installPrefSync({
    net, timers, target, notify, key: 'notOwned', stateKey: 'ownSync', msgType: 'room.ownership', field: 'notOwned', tag: 'ownership',
    lockedText: N_('干员持有是局外设置，修改将在下一局生效'),
    prepare: async () => cleanIds(target.get().notOwned),
  });
}

/**
 * Wire the 自选编队 sync once (0.2.0 DIY): `room.diy { picks }` after every welcome and edit. The picks go as stored
 * (structurally clean); the server keeps the legal ones. During a match the server stores them for the next one
 * (ROOM_STARTED → 'locked'): the setting is out of match. Every `welcome` also brings the operators a DIY slot may field
 * (`diyKitted`, the picker's list).
 * @param {{ net: any, timers?: { setTimeout: Function, clearTimeout: Function }, target?: ReturnType<typeof createStore>,
 *   notify?: (text: string) => void }} deps
 */
export function installDiySync({ net, timers, target = loadoutStore, notify, content = appContentSet } = {}) {
  let welcomeList = null;
  let joined = { base: null, extra: null, list: null };
  const pickList = () => {
    const extra = content?.get().status === 'ready' ? content.get().kitted : null;
    if (!welcomeList || !Array.isArray(extra) || !extra.length) return welcomeList;
    if (joined.base !== welcomeList || joined.extra !== extra) joined = { base: welcomeList, extra, list: [...new Set([...welcomeList, ...extra])] };
    return joined.list;
  };
  const offKit = net.on('welcome', (msg) => {
    welcomeList = msg && Array.isArray(msg.diyKitted) ? msg.diyKitted.filter((x) => typeof x === 'string') : null;
    target.set({ diyKitted: pickList() });
  });
  const offKitContent = content?.subscribe(() => {
    const list = pickList();
    if (list !== target.get().diyKitted) target.set({ diyKitted: list });
  });
  const sync = installPrefSync({
    net, timers, target, notify, content, key: 'diy', stateKey: 'diySync', msgType: 'room.diy', field: 'picks', tag: 'diy',
    lockedText: N_('自选编队是局外设置，修改将在下一局生效'),
    prepare: async () => cleanPicks(target.get().diy),
  });
  return { flush: sync.flush, dispose() { offKit?.(); offKitContent?.(); sync.dispose(); } };
}
