import { readFileSync } from 'node:fs';

const topic = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic;
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
export const MIZUKI_BANK_MAX_GOLD = topic.gameConst.bankMaxGold;
export const MIZUKI_BANK_WITHDRAW_MAX = topic.gameConst.bankDrawCount;
export const MIZUKI_BANK_UNLOCK_RELIC = 'rogue_2_relic_fight_121';

/** These are the native OuterData.Bank fields; accounts are supplied by the profile service. */
export function mizukiBankAccount(value) {
  const current = integer(value?.current, MIZUKI_BANK_MAX_GOLD) ? value.current : 0;
  const record = Math.max(current, integer(value?.record, MIZUKI_BANK_MAX_GOLD) ? value.record : 0);
  return { current, record, totalPut: Math.max(record, integer(value?.totalPut) ? value.totalPut : 0) };
}

export function mizukiBankRewards(account) {
  const { record } = mizukiBankAccount(account);
  return topic.bankRewards.map(reward => ({ id: reward.rewardId, threshold: reward.unlockGoldCnt,
    type: reward.rewardType, description: reward.desc, unlocked: record >= reward.unlockGoldCnt }))
    .sort((a, b) => a.threshold - b.threshold);
}

export function mizukiBankExtraShopSlots(account) {
  return mizukiBankRewards(account).filter(reward => reward.unlocked && reward.type === 'ADD_SHOP_POS').length;
}

export function mizukiBankView(account, { gold = 0, key = 0, available = true } = {}) {
  const value = mizukiBankAccount(account), rewards = mizukiBankRewards(value);
  const withdrawUnlocked = rewards.some(reward => reward.unlocked && reward.type === 'UNLOCK_WITHDRAW');
  return { ...value, maxGold: MIZUKI_BANK_MAX_GOLD, rewards,
    canPut: available && gold > 0 && value.current < MIZUKI_BANK_MAX_GOLD,
    canWithdraw: available && withdrawUnlocked && key > 0 && value.current > 0,
    withdrawUnlocked, withdrawKeyCost: 1, withdrawMax: Math.min(MIZUKI_BANK_WITHDRAW_MAX, value.current),
    canBattle: available && rewards.some(reward => reward.unlocked && reward.type === 'UNLOCK_SHOP_BATTLE'),
    unlockedRelics: value.record >= 325 ? [MIZUKI_BANK_UNLOCK_RELIC] : [] };
}

export function planMizukiBankTransaction(account, { action, count, gold = 0, key = 0 } = {}) {
  const value = mizukiBankAccount(account);
  if (!Number.isSafeInteger(count) || count < 1) return { ok: false, reason: 'count' };
  if (action === 'deposit') {
    // The original investment button submits one ingot at a time.
    if (count !== 1 || gold < 1 || value.current >= MIZUKI_BANK_MAX_GOLD) return { ok: false, reason: 'deposit' };
    value.current++;
    value.record = Math.max(value.record, value.current);
    value.totalPut++;
    return { ok: true, account: value, goldDelta: -1, keyDelta: 0 };
  }
  if (action === 'withdraw') {
    if (value.record < 25 || key < 1 || count > MIZUKI_BANK_WITHDRAW_MAX || count > value.current
      || gold + count > 9999) return { ok: false, reason: 'withdraw' };
    value.current -= count;
    return { ok: true, account: value, goldDelta: count, keyDelta: -1 };
  }
  return { ok: false, reason: 'action' };
}
