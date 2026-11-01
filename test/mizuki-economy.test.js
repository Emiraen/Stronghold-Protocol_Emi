import test from 'node:test';
import assert from 'node:assert/strict';
import { grantMizukiEconomicHope, validMizukiEconomy } from '../server/modes/mizuki/Economy.js';

const roundtrip = value => JSON.parse(JSON.stringify(value));

test('five original coins grant one personal hope across separate payouts', () => {
  const player = { hope: 3, gold: 17, roster: [{ uid: 1 }] };
  assert.equal(validMizukiEconomy(player), true);
  assert.deepEqual(grantMizukiEconomicHope(player, 2), { coinGranted: 2, hopeGranted: 0,
    economicCoinTotal: 2, economicCoinRemainder: 2, economicHopePending: 0 });
  grantMizukiEconomicHope(player, 2);
  assert.equal(grantMizukiEconomicHope(player, 1).hopeGranted, 1);
  assert.deepEqual(player, { hope: 4, gold: 17, roster: [{ uid: 1 }],
    economicCoinTotal: 5, economicCoinRemainder: 0, economicHopePending: 0 });
});

test('large payouts combine with the previous remainder and keep the excess coins', () => {
  const player = { hope: 0, gold: 42 };
  grantMizukiEconomicHope(player, 4);
  const result = grantMizukiEconomicHope(player, 7);
  assert.equal(result.hopeGranted, 2);
  assert.equal(player.economicCoinTotal, 11);
  assert.equal(player.economicCoinRemainder, 1);
  assert.equal(player.hope, 2);
  assert.equal(player.gold, 42);
  assert.equal(validMizukiEconomy(roundtrip(player)), true);
});

test('independent players never share conversion remainders', () => {
  const a = { hope: 1 }, b = { hope: 8 };
  grantMizukiEconomicHope(a, 4);grantMizukiEconomicHope(b, 1);
  assert.equal(a.hope, 1);assert.equal(b.hope, 8);
  grantMizukiEconomicHope(a, 1);
  assert.equal(a.hope, 2);assert.equal(b.economicCoinRemainder, 1);
});

test('conversion does not read, write or validate Mizuki originium ingots', () => {
  const player = { hope: 0 };
  Object.defineProperty(player, 'gold', { get() { throw Error('ingots were read'); },
    set() { throw Error('ingots were written'); } });
  assert.equal(validMizukiEconomy(player), true);
  assert.equal(grantMizukiEconomicHope(player, 10).hopeGranted, 2);
});

test('invalid reward amounts fail before any state mutation', () => {
  for (const amount of [undefined, null, '5', -1, .5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const player = { hope: 7, gold: 99, economicCoinTotal: 4, economicCoinRemainder: 4, economicHopePending: 0 };
    const before = roundtrip(player);
    assert.throws(() => grantMizukiEconomicHope(player, amount), TypeError);
    assert.deepEqual(player, before);
  }
});

test('malformed ledger states and impossible remainder or pending amounts are rejected', () => {
  for (const player of [null, [], new Date(), {}, { hope: null }, { hope: -1 }, { hope: 10000 },
    { hope: 1.5 }, { hope: 1, economicCoinTotal: null }, { hope: 1, economicCoinTotal: 6 },
    { hope: 1, economicCoinTotal: 5, economicCoinRemainder: 5 },
    { hope: 1, economicCoinTotal: 5, economicCoinRemainder: 1 },
    { hope: 1, economicCoinTotal: 5, economicHopePending: 2 },
    { hope: 1, economicCoinTotal: 5, economicHopePending: null }]) {
    assert.equal(validMizukiEconomy(player), false);
    assert.throws(() => grantMizukiEconomicHope(player, 1), TypeError);
  }
});

test('there is no artificial coin cap at the hope display maximum', () => {
  const player = { hope: 0 };
  grantMizukiEconomicHope(player, 50001);
  assert.equal(player.hope, 9999);
  assert.equal(player.economicCoinTotal, 50001);
  assert.equal(player.economicCoinRemainder, 1);
  assert.equal(player.economicHopePending, 1);
  assert.equal(validMizukiEconomy(player), true);
});

test('the hope cap retains owed whole hope and zero credit redeems it exactly once after spending', () => {
  const player = { hope: 9998, gold: 15 };
  grantMizukiEconomicHope(player, 18);
  assert.equal(player.hope, 9999);assert.equal(player.economicHopePending, 2);
  assert.equal(player.economicCoinRemainder, 3);
  player.hope -= 2;
  const redeemed = grantMizukiEconomicHope(player, 0);
  assert.equal(redeemed.hopeGranted, 2);assert.equal(player.hope, 9999);
  assert.equal(player.economicHopePending, 0);assert.equal(player.economicCoinTotal, 18);
  assert.equal(grantMizukiEconomicHope(player, 0).hopeGranted, 0);
  assert.equal(player.gold, 15);
  assert.equal(validMizukiEconomy(roundtrip(player)), true);
});

test('partial redemption keeps the remaining pending hope serializable', () => {
  const player = { hope: 9999 };
  grantMizukiEconomicHope(player, 29);
  player.hope--;
  grantMizukiEconomicHope(player, 0);
  assert.equal(player.economicHopePending, 4);assert.equal(player.economicCoinRemainder, 4);
  const restored = roundtrip(player);
  restored.hope -= 2;
  grantMizukiEconomicHope(restored, 1);
  assert.equal(restored.hope, 9999);assert.equal(restored.economicHopePending, 3);
  assert.equal(restored.economicCoinRemainder, 0);assert.equal(validMizukiEconomy(restored), true);
});

test('safe integer boundary is accepted and overflow is rejected atomically', () => {
  const player = { hope: 0 };
  grantMizukiEconomicHope(player, Number.MAX_SAFE_INTEGER);
  assert.equal(player.economicCoinTotal, Number.MAX_SAFE_INTEGER);
  assert.equal(player.economicCoinRemainder, Number.MAX_SAFE_INTEGER % 5);
  assert.equal(validMizukiEconomy(player), true);
  const before = roundtrip(player);
  assert.throws(() => grantMizukiEconomicHope(player, 1), RangeError);
  assert.deepEqual(player, before);
});

test('batching the same coins produces the same ledger with and without hope saturation', () => {
  for (const hope of [0, 9998, 9999]) {
    const single = { hope }, batched = { hope };
    const batches = [4, 7, 0, 21, 2, 13];
    grantMizukiEconomicHope(single, batches.reduce((sum, value) => sum + value, 0));
    for (const amount of batches) grantMizukiEconomicHope(batched, amount);
    assert.deepEqual(batched, single);
  }
});

test('the caller owns payout deduplication and legacy defaults initialize on zero credit', () => {
  const player = { hope: 3 };
  assert.equal(grantMizukiEconomicHope(player, 0).hopeGranted, 0);
  grantMizukiEconomicHope(player, 5);grantMizukiEconomicHope(player, 5);
  assert.equal(player.hope, 5);assert.equal(player.economicCoinTotal, 10);
});
