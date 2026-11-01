// Idempotency keys must also work on plain HTTP LAN pages, where randomUUID
// is unavailable. These IDs identify client actions, not authentication tokens.
let sequence = 0;

export function requestId(source = globalThis.crypto) {
  if (typeof source?.randomUUID === 'function') {
    try { return source.randomUUID(); } catch { /* continue with supported APIs */ }
  }
  if (typeof source?.getRandomValues === 'function') {
    try {
      const bytes = source.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
      return [hex.slice(0, 4).join(''), hex.slice(4, 6).join(''), hex.slice(6, 8).join(''),
        hex.slice(8, 10).join(''), hex.slice(10).join('')].join('-');
    } catch { /* very old browsers still get unique action identifiers */ }
  }
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return `op-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}
