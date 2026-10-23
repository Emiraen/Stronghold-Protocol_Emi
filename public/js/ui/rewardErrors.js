import { recordError } from '../diag.js';

export const REWARD_FAILURE_TEXT = '发生错误！请复制诊断信息并联系服主';
const CODES = new Set(['LAYER_GRANT_FAILED', 'RESULT_INCOMPLETE', 'RESULT_SETTLEMENT_FAILED']);

// Keep operational facts only: never copy server stacks, credentials or arbitrary payload fields.
export function recordRewardFailure(msg) {
  if (!CODES.has(msg?.diagnostic?.code)) return false;
  const detail = {};
  for (const key of ['code', 'round', 'source', 'hook', 'bondId', 'matchId', 'attempt', 'receipt', 'before', 'after']) {
    const value = msg.diagnostic[key];
    if (typeof value === 'string') detail[key] = value.slice(0, 100);
    else if (typeof value === 'number' && Number.isFinite(value)) detail[key] = value;
  }
  recordError('server-reward', new Error(REWARD_FAILURE_TEXT), JSON.stringify(detail));
  return true;
}
