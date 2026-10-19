import { standInRecord } from '../../../../shared/standIn.js';
import { diyRecordOf } from '../../../../shared/diy.js';
// 从 A 原正文按职责拆分；保持原有行为。
import { createAssets, assets as defaultAssets } from '../../assets.js';

// Older WebViews have AbortController but no AbortSignal.throwIfAborted().
export function checkActive(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('战场初始化已取消', 'AbortError');
}

// 只取消本 view 的等待，不取消共享资源加载。
export function withTimeout(p, ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (done, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      done(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new DOMException('战场初始化已取消', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (ms != null) timer = setTimeout(() => finish(resolve), ms);
    // 取消本次等待后仍接住共享加载的迟到拒绝。
    Promise.resolve(p).then((value) => finish(resolve, value), (err) => finish(reject, err));
    if (signal?.aborted) onAbort();
  });
}

export function resolveAssets(a) {
  if (a && typeof a === 'object' && typeof a.ready === 'function' && typeof a.spineEntry === 'function') return a;
  if (a && typeof a === 'object' && (a.chars || a.enemies || a.version)) return createAssets({ manifest: a });
  return defaultAssets;
}

export function makeData(src) {
  const look = (file, id) => {
    if (id == null || id === '') return null;
    try {
      if (src && typeof src.lookup === 'function') return src.lookup(file, id) || null;
      const m = src && src[file];
      if (m instanceof Map) return m.get(id) || null;
      if (m && typeof m === 'object' && Object.hasOwn(m, id)) return m[id] || null;
    } catch { /* ignore */ }
    return null;
  };
  // 0.2.0 补位: the composed stand-in record of a chess (shared/standIn.js over data/backups.json), cached per chess
  const standIns = new Map();
  const backups = () => {
    try { return (src && typeof src.get === 'function' ? src.get('backups') : src && src.backups) || null; } catch { return null; }
  };
  const standIn = (id) => {
    const c = look('chess', id);
    const b = backups();
    if (!c || !b) return null;
    if (standIns.has(c)) return standIns.get(c);
    let rec;
    try { rec = standInRecord(c, b); } catch { rec = null; }
    standIns.set(c, rec);
    return rec;
  };
  // 0.2.0 自选编队: the composed 自选 record of a DIY slot filled with a pick (shared/diy.js over chess.json + backups.json)
  const diys = new Map();
  const chessMap = () => {
    try { return (src && typeof src.get === 'function' ? src.get('chess') : src && src.chess) || null; } catch { return null; }
  };
  const diy = (id, pick) => {
    const c = look('chess', id);
    const b = backups();
    if (!c || !c.isDiy || !b || !pick || typeof pick.charId !== 'string') return null;
    const key = `${id}|${pick.charId}|${pick.skillIndex ?? ''}|${pick.uniEquipId ?? ''}`;
    if (diys.has(key)) return diys.get(key);
    let rec;
    try { rec = diyRecordOf(c, pick, { chess: chessMap(), backups: b }); } catch { rec = null; }
    diys.set(key, rec);
    return rec;
  };
  return {
    // (a 自选 operator's summons are data/backups.json tokens, 0.2.0)
    chess: (id) => look('chess', id), token: (id) => look('tokens', id) || (backups()?.tokens && Object.hasOwn(backups().tokens, id) ? backups().tokens[id] : null), item: (id) => look('items', id),
    enemy: (id) => look('enemies', id), stage: (id) => look('stages', id), bond: (id) => look('bonds', id),
    standIn, diy,
  };
}

export const QUALITY_RES = { high: 2, medium: 1.5, low: 1 };

export const BOARD_RES = { high: 2, medium: 1.25, low: 1 };

export function releaseGl(renderer) {
  const ts = renderer && renderer.texture;
  if (ts && Array.isArray(ts.managedTextures) && typeof ts.destroyTexture === 'function') {
    for (const bt of ts.managedTextures.slice()) { try { ts.destroyTexture(bt, true); } catch { /* ignore */ } }
    ts.managedTextures.length = 0;
  }
  for (const sys of [renderer?.geometry, renderer?.buffer, renderer?.framebuffer]) {
    try { if (sys && typeof sys.disposeAll === 'function') sys.disposeAll(false); } catch { /* ignore */ }
  }
  // shader programs are cached globally by source (PIXI.utils.ProgramCache) with one GLProgram per context
  const uid = renderer?.CONTEXT_UID, gl = renderer?.gl;
  const programs = globalThis.PIXI?.utils?.ProgramCache;
  if (uid != null && programs && typeof programs === 'object') {
    for (const prog of Object.values(programs)) {
      const g = prog && prog.glPrograms && prog.glPrograms[uid];
      if (!g) continue;
      try { if (gl && g.program) gl.deleteProgram(g.program); } catch { /* ignore */ }
      delete prog.glPrograms[uid];
    }
  }
}
