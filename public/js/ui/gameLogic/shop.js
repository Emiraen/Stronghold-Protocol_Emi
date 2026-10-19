import { t as trA } from '../../../../shared/i18n.js';
// 从 A 原正文按职责拆分；保持原有行为。
import { GEO } from '../../../../shared/constants.js';
import { itemMergeRecipe } from '../../../../shared/itemMerge.js';
import { isObj } from './shared.js';

export function priceTone(slot) {
  if (!isObj(slot)) return 'gold';
  const p = Number(slot.price);
  const b = Number(slot.basePrice);
  if (Number.isFinite(p) && p === 0) return 'discount';
  if (!Number.isFinite(p) || !Number.isFinite(b)) return 'gold';
  if (p < b) return 'discount';
  if (p > b) return 'premium';
  return 'gold';
}

export function mergeProgress(priv, chessId, getChess = () => null) {
  const c = getChess(chessId);
  const base = c?.baseId || chessId;
  const need = Number.isInteger(c?.upgradeNum) && c.upgradeNum > 0 ? c.upgradeNum : 3;
  if (c?.isGolden) return { copies: 0, need };
  let copies = 0;
  const pieces = [...(Array.isArray(priv?.board) ? priv.board : []), ...(Array.isArray(priv?.hand) ? priv.hand : []), ...(Array.isArray(priv?.temp) ? priv.temp : [])];
  for (const p of pieces) if (p?.kind === 'chess' && !p.golden && (p.id === base || getChess(p.id)?.baseId === base) && !String(p.id).endsWith('_b')) copies += 1;
  return { copies, need };
}

export function mergeTarget(priv, chessId, getChess = () => null) {
  const { copies, need } = mergeProgress(priv, chessId, getChess);
  if (!(copies > 0 && copies + 1 >= need)) return null;
  const c = getChess(chessId);
  const base = c?.baseId || chessId;
  const board = (Array.isArray(priv?.board) ? priv.board : []).filter((p) => p?.kind === 'chess' && !p.golden && Number.isInteger(p.row) && Number.isInteger(p.col)
    && !String(p.id).endsWith('_b') && (p.id === base || getChess(p.id)?.baseId === base));
  if (!board.length) return null;
  board.sort((a, b) => a.col - b.col || b.row - a.row);
  return { row: board[0].row, col: board[0].col, dir: board[0].dir || 'RIGHT' };
}

export function handFull(priv) {
  const hand = Array.isArray(priv?.hand) ? priv.hand : [];
  return hand.length >= GEO.HAND_SIZE && hand.every((p) => p != null);
}

export function completesMerge(priv, slot, { getChess = () => null, getItem = () => null, itemMergeCount = 2 } = {}) {
  if (!isObj(slot) || typeof slot.id !== 'string') return false;
  if (slot.kind === 'item') {
    const recipe = itemMergeRecipe(slot.id, getItem, itemMergeCount);
    if (!recipe) return false;
    let have = 0;
    const holders = [...(Array.isArray(priv?.hand) ? priv.hand : []), ...(Array.isArray(priv?.temp) ? priv.temp : [])];
    for (const p of holders) {
      if (!isObj(p)) continue;
      if (p.kind === 'item' && p.id === slot.id) have += 1;
    }
    return have + 1 >= recipe.count;
  }
  const rec = getChess(slot.id);
  if (!rec || rec.isGolden) return false;
  const base = getChess(rec.baseId) || rec;
  const golden = (base.goldenId && getChess(base.goldenId)) || getChess(String(base.chessId || slot.id).replace(/_a$/, '_b'));
  if (!golden) return false;
  const { copies, need } = mergeProgress(priv, slot.id, getChess);
  return need > 1 && copies + 1 >= need;
}

export function offerHeader(offer) {
  const slots = isObj(offer) && Array.isArray(offer.slots) ? offer.slots : [];
  const items = slots.some((s) => isObj(s) && s.kind === 'item');
  const label = isObj(offer) && typeof offer.label === 'string' && offer.label ? offer.label : null;
  const queued = isObj(offer) && Number.isInteger(offer.queued) && offer.queued > 0 ? offer.queued : 0;
  const tail = { queued, more: queued ? `之后还有 ${queued} 项` : null };
  if (!items && (!isObj(offer) || offer.source === 'merge' || offer.source == null) && !label) {
    return { title: '晋升奖励', micro: 'PROMOTION', sub: '免费选择 1 名', icon: 'crown', items: false, pill: '晋升奖励待选择', ...tail };
  }
  const title = label || (items ? trA("装备补给") : trA("特殊招募"));
  return { title, micro: 'SPECIAL', sub: items ? '免费选择 1 件' : '免费选择 1 名', icon: 'refresh', items, pill: `${title}待选择`, ...tail };
}

export function shopBlockReason(kind, { priv, editable, slot, getChess, getItem } = {}) {
  if (!priv) return trA("尚未就绪");
  if (priv.alive === false) return trA("你已被淘汰");
  if (kind === 'ready' && priv.personalChoice) return trA('请先完成教鞭选择');
  if (kind === 'ready') return priv.canReady === false ? trA("临时整备区不为空，请先处理溢出的资源") : null;
  if (!editable) {
    if (kind === 'reward') return trA("当前无法选择");
    return priv.ready ? trA("已准备就绪，取消准备后才能操作") : trA("当前阶段无法进行该操作");
  }
  const funds = Number(priv.funds) || 0;
  const shop = priv.shop || {};
  if (kind === 'buy' || kind === 'reward') {
    if (!isObj(slot) || slot.sold) return kind === 'reward' ? trA("已选择") : trA("已售出");
    if ((Number(slot.price) || 0) > funds) return trA("资金不足");
    if (slot.kind !== 'item' && handFull(priv) && !completesMerge(priv, slot, { getChess, getItem })) return trA("整备区已满");
    return null;
  }
  if (kind === 'refresh') return (Number(shop.refreshPrice) || 0) > funds ? trA("资金不足") : null;
  if (kind === 'levelUp') {
    if ((Number(shop.level) || 1) >= (Number(shop.maxLevel) || 6)) return trA("调度中心已达最高等级");
    // 舟铲铲之战：按钮 = 购买经验（priv.expPrice = 单价 2），按经验单价判资金而非普通模式升级价，否则 2~4 金时被误判资金不足
    const cost = Number.isFinite(Number(priv.expPrice)) ? Number(priv.expPrice) : (Number(shop.upgradePrice) || 0);
    return cost > funds ? trA("资金不足") : null;
  }
  return null;
}

export function readyFundsPrompt(priv, { ready = true, keptBands = null, autoplay = false } = {}) {
  if (!ready || autoplay || !isObj(priv) || priv.alive === false || priv.ready) return null;
  const funds = Math.trunc(Number(priv.funds) || 0);
  if (!(funds > 0)) return null;
  const kept = Array.isArray(keptBands) ? keptBands : ['band_cannot'];
  if (typeof priv.bandId === 'string' && kept.includes(priv.bandId)) return null;
  return {
    title: '剩余资金', micro: 'FUNDS LEFT', okText: '准备就绪', cancelText: '继续整备',
    text: `还有 ${funds} 资金未使用。休整期结束时，本回合的剩余资金将清零。确定准备就绪吗？`,
  };
}
