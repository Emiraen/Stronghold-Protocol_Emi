const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
      previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}

function matchScore(track, query, tokens) {
  const title = normalize(track.title || track.name);
  const artist = normalize(track.artist);
  const text = title + (artist ? ' ' + artist : '');
  if (title === query) return 0;
  if (title.startsWith(query)) return 10 + Math.min(9, (title.length - query.length) / 100);
  const position = title.indexOf(query);
  if (position >= 0) return 20 + Math.min(9, position / 100);
  if (artist === query) return 30;
  if (text.includes(query)) return 35;
  if (tokens.every(token => text.includes(token))) return 40 + Math.min(9, text.length / 1000);
  // Short Chinese queries already match a substring. Do not invent unrelated
  // one-character hits; fuzzy matching is reserved for a useful amount of text.
  if (query.length < 3) return Infinity;
  const limit = query.length < 8 ? 1 : 2;
  const candidates = [title, artist, ...text.split(' ')].filter(Boolean);
  let best = limit + 1;
  for (const candidate of candidates) best = Math.min(best, distance(query, candidate, limit));
  return best <= limit ? 60 + best + Math.min(.9, Math.abs(title.length - query.length) / 100) : Infinity;
}

/** Search only the downloaded catalogs; never requests a server per keystroke. */
export function searchMusicTracks(playlists = [], value = '') {
  const query = normalize(value), tokens = query.split(' ');
  const tracks = playlists.flatMap(playlist => (playlist.tracks || []).map(track => ({
    ...track, playlistId: track.playlistId || playlist.id, playlistTitle: playlist.title || playlist.name || '',
  })));
  if (!query) return tracks;
  return tracks.map((track, index) => ({ track, index, score: matchScore(track, query, tokens) }))
    .filter(entry => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.index - b.index).map(entry => entry.track);
}
