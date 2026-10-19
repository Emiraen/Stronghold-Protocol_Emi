import { performance } from 'node:perf_hooks';
import { DIFFICULTIES, MAX_SEATS, ENTERTAINMENT_MAX_SEATS, CYCLOPS_MAX_SEATS, ENDLESS_VARIANT } from '../shared/constants.js';

const IDS = ['main', 'secondary'];
export const RECRUITMENT_TTL_MS = 12_000;
const keys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const text = (value, max = 64) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;

// Only public, server-generated invitation fields cross the signed profile bridge.
// URLs are deliberately excluded: the receiving server supplies its trusted directory URLs.
export function validateRecruitmentItems(items, serverId) {
  if (!IDS.includes(serverId) || !Array.isArray(items) || items.length > 1000) throw new Error('招募目录无效');
  const seen = new Set();
  for (const row of items) {
    const capacityLimit = row?.variant === 'entertainment_cyclops' ? CYCLOPS_MAX_SEATS : row?.variant === 'entertainment_multi' || row?.variant === ENDLESS_VARIANT ? ENTERTAINMENT_MAX_SEATS : MAX_SEATS;
    if (!keys(row, ['serverId', 'code', 'mode', 'variant', 'modeId', 'difficulty', 'ranked', 'hostId', 'hostName',
      'capacity', 'occupied', 'missing', 'seats', 'stage', 'createdAt', 'invitedAt'])
      || row.serverId !== serverId || !/^[A-HJ-NP-Z]{4}$/.test(row.code) || seen.has(row.code)
      // Same partition as regions.roomServer; no import cycle through regions -> validator.
      || !(serverId === 'main' ? 'ABCDEFGHJKLM' : 'NPQRSTUVWXYZ').includes(row.code[0])
      || row.mode !== 'coop' || ![null, 'entertainment_multi', 'entertainment_cyclops', ENDLESS_VARIANT].includes(row.variant)
      || !text(row.modeId) || !DIFFICULTIES.includes(row.difficulty) || typeof row.ranked !== 'boolean'
      || (row.variant !== null && row.ranked) || !text(row.hostId) || !text(row.hostName)
      || !integer(row.capacity, capacityLimit) || row.capacity < 2
      || !integer(row.occupied, row.capacity - 1) || row.occupied < 1
      || row.missing !== row.capacity - row.occupied || row.stage !== null
      || !integer(row.createdAt) || !integer(row.invitedAt) || !Array.isArray(row.seats)
      || row.seats.length !== row.occupied) throw new Error('招募房间无效');
    seen.add(row.code);
    const seats = new Set(), players = new Set();
    for (const seat of row.seats) {
      if (!keys(seat, ['seat', 'playerId', 'name', 'isBot']) || !integer(seat.seat, row.capacity - 1)
        || seats.has(seat.seat) || !text(seat.playerId) || !seat.playerId || players.has(seat.playerId)
        || !text(seat.name) || typeof seat.isBot !== 'boolean') throw new Error('招募座位无效');
      seats.add(seat.seat); players.add(seat.playerId);
    }
  }
  return structuredClone(items);
}

export function createRecruitmentCache(serverId, now = () => performance.now()) {
  let samples = {};
  return {
    update(value, started = now()) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((id) => !IDS.includes(id))) throw new Error('招募快照无效');
      const next = {};
      for (const [id, sample] of Object.entries(value)) {
        if (!keys(sample, ['ageMs', 'items']) || !(sample.ageMs === null || (Number.isFinite(sample.ageMs) && sample.ageMs >= 0))
          || (sample.items !== null && (sample.ageMs === null || sample.ageMs >= RECRUITMENT_TTL_MS))) throw new Error('招募快照年龄无效');
        if (sample.items !== null) next[id] = { at: started - sample.ageMs, items: validateRecruitmentItems(sample.items, id) };
      }
      samples = next;
    },
    directory(localItems) {
      const items = [...localItems], at = now();
      for (const id of IDS) {
        if (id === serverId) continue;
        const sample = samples[id];
        if (sample && at >= sample.at && at - sample.at < RECRUITMENT_TTL_MS) items.push(...structuredClone(sample.items));
      }
      return items;
    },
  };
}
