// shared/squads.js — the 25-squad structure of the 100-seat variant. Pure ESM, no Node APIs.
//
// Seats are grouped in fours in seat order: squad `k` holds seats 4k..4k+3, so 100 seats make 25 squads. The rule
// layer uses membership for the two-stage 联防 (队内兜底 first, then the cross-squad hand-off); the topology between
// squads is an open design question and is deliberately NOT encoded here (docs/FINDINGS-100.md §6.3).

/** Players per squad. */
export const SQUAD_SIZE = 4;

/** Squad count for `seats` seats (ceil: a partial last squad still exists). @param {number} seats */
export const squadCount = (seats) => Math.max(0, Math.ceil((Number(seats) || 0) / SQUAD_SIZE));

/**
 * Squad index of a seat. `-1` for anything that is not a non-negative integer seat.
 * @param {number} seat
 */
export function squadIndex(seat) {
  return Number.isInteger(seat) && seat >= 0 ? Math.floor(seat / SQUAD_SIZE) : -1;
}

/**
 * The seat numbers of the squad that holds `seat`, in ascending order. Empty for an invalid seat.
 * @param {number} seat
 * @returns {number[]}
 */
export function squadMembers(seat) {
  const k = squadIndex(seat);
  if (k < 0) return [];
  const base = k * SQUAD_SIZE;
  return Array.from({ length: SQUAD_SIZE }, (_, i) => base + i);
}

/**
 * Whether two seats are in the same squad (false when either is invalid).
 * @param {number} a @param {number} b
 */
export function sameSquad(a, b) {
  const k = squadIndex(a);
  return k >= 0 && k === squadIndex(b);
}
