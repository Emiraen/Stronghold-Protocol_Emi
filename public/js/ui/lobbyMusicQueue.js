export function chooseMusicTrack(playlists, playlistIds, current = null, random = Math.random) {
  const allowed = new Set(playlistIds);
  const all = playlists.filter(playlist => allowed.has(playlist.id)).flatMap(playlist => playlist.tracks || []);
  const candidates = all.length > 1 ? all.filter(track => track.id !== current?.id || track.playlistId !== current?.playlistId) : all;
  return candidates.length ? candidates[Math.floor(random() * candidates.length)] : null;
}

export function normalizeMusicSettings(value, playlistIds = ['ost', 'personal']) {
  const allowed = new Set(playlistIds);
  const mode = ['default', 'manual', 'shuffle', 'local'].includes(value?.mode) ? value.mode : 'default';
  const shuffleIds = [...new Set(Array.isArray(value?.shuffleIds) ? value.shuffleIds.filter(id => allowed.has(id)) : [])];
  const selected = typeof value?.selected?.id === 'string' && allowed.has(value.selected.playlistId)
    ? { id: value.selected.id, playlistId: value.selected.playlistId } : null;
  return { version: 1, mode: mode === 'shuffle' && !shuffleIds.length ? 'default'
    : mode === 'manual' && shuffleIds.length ? 'shuffle' : mode,
    shuffleIds, selected, paused: value?.paused === true };
}
