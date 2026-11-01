export const HEALTH_COUNT_KEYS = Object.freeze(['sockets', 'sessions', 'online', 'rooms', 'matches', 'humans', 'bots']);
export const validHealthCounts = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === HEALTH_COUNT_KEYS.length
  && HEALTH_COUNT_KEYS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0);

export function localHealthCounts(network, registry, lobby) {
  const stats = lobby?.stats?.() || {};
  return { sockets: network?.connectionCount || 0, sessions: registry?.size || 0,
    online: [...(registry?.all?.() || [])].filter(s => s.connected).length,
    rooms: stats.rooms || 0, matches: stats.matches || 0, humans: stats.humans || 0, bots: stats.bots || 0 };
}

// Consume the existing regional heartbeat cache. Never query another /healthz or count stale samples.
export function combinedHealthCounts(serverId, local, states, now, leaseMs = 12_000, serverIds = ['main', 'secondary']) {
  const totals = Object.fromEntries(HEALTH_COUNT_KEYS.map(key => [key, 0]));
  const servers = {};
  for (const id of serverIds) {
    const sample = states[id], ageMs = id === serverId ? 0 : sample ? Math.max(0, now - sample.at) : null;
    const available = id === serverId || (sample && now >= sample.at && ageMs < leaseMs && validHealthCounts(sample.health));
    const counts = id === serverId ? local : available ? sample.health : null;
    servers[id] = { available: !!available, ageMs, ...(counts || {}) };
    if (counts) for (const key of HEALTH_COUNT_KEYS) totals[key] += counts[key];
  }
  return { ...totals, countsComplete: Object.values(servers).every(s => s.available), servers };
}
