// Original Stronghold coin rewards convert to personal hope. Mizuki originium
// ingots (player.gold) never enter this ledger. Callers own event deduplication.
const COINS_PER_HOPE = 5, MAX_HOPE = 9999;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const field = (player, key) => player[key] === undefined ? 0 : player[key];

/** Legacy players may omit the ledger; explicit malformed values are rejected. */
export function validMizukiEconomy(player) {
  if (!plain(player) || !integer(player.hope) || player.hope > MAX_HOPE) return false;
  const total = field(player, 'economicCoinTotal'), remainder = field(player, 'economicCoinRemainder');
  const pending = field(player, 'economicHopePending');
  return integer(total) && integer(remainder) && remainder < COINS_PER_HOPE
    && total % COINS_PER_HOPE === remainder && integer(pending)
    && pending <= Math.floor(total / COINS_PER_HOPE);
}

/** Credit newly earned coins; zero also releases hope banked at the hope cap. */
export function grantMizukiEconomicHope(player, amount) {
  if (!validMizukiEconomy(player) || !integer(amount)) throw TypeError('Invalid Mizuki economic reward');
  const total = field(player, 'economicCoinTotal') + amount;
  if (!integer(total)) throw RangeError('Mizuki economic coin total exceeds the safe integer range');
  const coins = field(player, 'economicCoinRemainder') + amount;
  const owed = field(player, 'economicHopePending') + Math.floor(coins / COINS_PER_HOPE);
  const hopeGranted = Math.min(MAX_HOPE - player.hope, owed);
  const economicCoinRemainder = coins % COINS_PER_HOPE, economicHopePending = owed - hopeGranted;
  player.hope += hopeGranted;
  player.economicCoinTotal = total;
  player.economicCoinRemainder = economicCoinRemainder;
  player.economicHopePending = economicHopePending;
  return { coinGranted: amount, hopeGranted, economicCoinTotal: total, economicCoinRemainder, economicHopePending };
}
