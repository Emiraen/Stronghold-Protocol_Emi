// Optional secondary-only projection. Main /healthz remains raw and never polls another host.
const FIXED_MAIN = 'https://super.emiraen.top:23331';
const FIXED_SECONDARY = 'https://emiraen.top';
export function createPeerHealth(config, { fetchFn = globalThis.fetch, now = Date.now, ttlMs = 5000, timeoutMs = 1000, maxBytes = 8192 } = {}) {
  if (config.role !== 'secondary' || config.mainUrl !== FIXED_MAIN || config.secondaryUrl !== FIXED_SECONDARY) return null;
  let cached = null, at = -Infinity, pending = null;
  const refresh = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchFn(FIXED_MAIN + '/healthz', { signal: controller.signal, redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('peer unavailable');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('missing peer body');
      const chunks = []; let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw new Error('peer health too large'); }
        chunks.push(part.value);
      }
      const data = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      const value = JSON.parse(new TextDecoder().decode(data));
      if (value.ok !== true || !Number.isSafeInteger(value.sockets) || value.sockets < 0
          || typeof value.build !== 'string' || !value.build || value.build.length > 128
          || value.socketScope === 'two-game-servers') throw new Error('peer health invalid');
      cached = { sockets: value.sockets, build: value.build }; at = now();
    } catch { cached = null; at = now(); }
    finally { clearTimeout(timer); pending = null; }
  };
  return async () => {
    if (now() - at >= ttlMs && !pending) {
      pending = Promise.resolve().then(refresh);
    }
    if (pending) await pending;
    return cached && now() - at < ttlMs ? { ...cached } : null;
  };
}
