import { readFileSync } from 'node:fs';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { drawMizukiCollectible, mizukiCollectibleSpec } from './Collectibles.js';
import { mizukiBankAccount, mizukiBankExtraShopSlots, mizukiBankView } from './Bank.js';
const DATA = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8'));
const topic = DATA.rawTopic;
const copy = value => structuredClone(value);
const professions = ['pioneer', 'warrior', 'tank', 'sniper', 'caster', 'support', 'medic', 'special'];
const SOURCE = { id: 'ro2_prts_merchant_v2', url: 'https://prts.wiki/w/水月与深蓝之树',
  prices: 'PRTS 生物制品陈设 individual 售价',
  selection: 'Original restrictions and dice thresholds; unpublished stock/category weights use deterministic sampling.',
  recruitTicketPrice: { value: 4, source: 'https://arknights.wiki.gg/wiki/Rogue_Trader#Wares' },
  activeToolPrice: { value: 8, source: 'https://prts.wiki/w/水月与深蓝之树/生物制品陈设#No.209-214_支援道具' },
  variantStockSlots: 6,
  bank: 'rogue2.rawTopic.bankRewards/gameConst and PRTS merchant investment rules' };
const rngFor = (node, context, salt) => createRng(deriveSeed(context.seed, node.id + ':shop:' + salt));

function offer(node, context, index, revision, excluded, highRoll = false, bankMarkup = 1) {
  const rng = rngFor(node, context, revision + ':' + index), floor = context.floor || 1;
  const type = index === 0 ? 'activeTool' : index <= 2 ? 'recruitTicket' : 'collectible';
  let itemId, price;
  if (type === 'activeTool') { itemId = 'rogue_2_active_tool_' + (1 + rng.int(6)); price = SOURCE.activeToolPrice.value; }
  if (type === 'recruitTicket') {
    const pool = floor === 1 && !highRoll ? ['pioneer', 'caster', 'medic'] : professions;
    itemId = 'rogue_2_recruit_ticket_' + rng.pick(pool); price = SOURCE.recruitTicketPrice.value;
  }
  if (type === 'collectible') {
    itemId = drawMizukiCollectible({ rng, owned: [...(context.collectibles || []), ...excluded], shop: true,
      bankRecord: context.bankAccount?.record || 0, cognition: context.cognition, highRoll, ...(highRoll ? { rarity: 2 } : {}) });
    if (!itemId) itemId = drawMizukiCollectible({ rng, owned: [...(context.collectibles || []), ...excluded], shop: true,
      bankRecord: context.bankAccount?.record || 0, cognition: context.cognition, highRoll });
    price = mizukiCollectibleSpec(itemId)?.price;
  }
  const item = topic.items[itemId];
  if (!item || !Number.isSafeInteger(price)) return null;
  return { id: 'mzshop:' + node.id + ':' + revision + ':' + index, offerId: 'mzshop:' + node.id + ':' + revision + ':' + index,
    itemId, type, name: item.name, label: item.name, description: String(item.usage || item.description || '').replace(/<[^>]*>/g, ''),
    iconId: item.iconId, price: Math.max(0, Math.floor(price * bankMarkup * (context.shopPriceFactor ?? 1))),
    basePrice: price * bankMarkup, originalPrice: price, bankMarkup,
    sold: false, count: 1, rarity: mizukiCollectibleSpec(itemId)?.rarity ?? 0 };
}

export function createMizukiRouteShop(node, context = {}) {
  if (!node?.id || (node.graphType || node.type) !== 'BATTLE_SHOP') throw TypeError('An original merchant node is required');
  const excluded = [], offers = [];
  const account = mizukiBankAccount(context.bankAccount), slots = SOURCE.variantStockSlots + mizukiBankExtraShopSlots(account);
  for (let i = 0; i < slots; i++) {
    const value = offer(node, context, i, 0, excluded);
    if (value) { offers.push(value); excluded.push(value.itemId); }
  }
  const shop = { version: 2, id: node.id, graphType: 'BATTLE_SHOP', title: topic.nodeTypeData.BATTLE_SHOP.name,
    description: topic.nodeTypeData.BATTLE_SHOP.description, offers, revision: 0, canLeave: true,
    canRefresh: true, refreshCost: { resource: 'dice', count: 1 }, unsupported: false, source: copy(SOURCE),
    bankMarkupLevels: 0, looted: false };
  return updateMizukiRouteShopBank(shop, node, { ...context, bankAccount: account });
}

/** Investment unlocks affect the current merchant immediately and survive shop refreshes. */
export function updateMizukiRouteShopBank(shop, node, context = {}) {
  const next = copy(shop), account = mizukiBankAccount(context.bankAccount);
  const levels = mizukiBankExtraShopSlots(account), slots = SOURCE.variantStockSlots + levels;
  const excluded = next.offers.map(value => value.itemId);
  for (let i = next.offers.length; i < slots; i++) {
    const value = offer(node, context, i, next.revision, excluded);
    if (value) { next.offers.push(value); excluded.push(value.itemId); }
  }
  const already = next.bankMarkupLevels || 0;
  for (let level = already; level < levels; level++) {
    const candidates = next.offers.filter(value => !value.sold && (value.bankMarkup || 1) === 1);
    if (!candidates.length) break;
    const selected = rngFor(node, context, 'investment-markup:' + level).pick(candidates);
    selected.bankMarkup = level === 0 ? 1.5 : 2;
    selected.originalPrice ??= selected.basePrice;
    selected.basePrice = selected.originalPrice * selected.bankMarkup;
    selected.price = Math.max(0, Math.floor(selected.basePrice * (selected.discount || 1) * (context.shopPriceFactor ?? 1)));
  }
  next.bankMarkupLevels = levels;
  next.canBattle = !next.looted && account.record >= 100;
  next.bank = mizukiBankView(account, { gold: context.gold, key: context.key, available: !next.looted });
  return next;
}

export function refreshMizukiRouteShop(shop, node, context = {}) {
  if (!validMizukiRouteShop(shop, node) || (context.dice || 0) < 1) return { ok: false };
  const next = copy(shop), rng = rngFor(node, context, 'refresh:' + next.revision);
  const sides = DATA.modules.dice.dice[context.diceId]?.diceFaceCount || 6, roll = 1 + rng.int(sides);
  const indices = roll >= 5 ? next.offers.map((_, i) => i) : rng.shuffle(next.offers.map((_, i) => i)).slice(0, 2);
  next.revision++; next.lastRoll = roll;
  for (const index of indices) {
    const excluded = next.offers.filter((_, i) => !indices.includes(i) || i < index).map(value => value.itemId);
    const value = offer(node, context, index, next.revision, excluded, roll >= 7, next.offers[index].bankMarkup || 1);
    if (value) {
      const discount = context.cognition ? context.cognition.shopDiscount
        : Number(context.shopDiscount) > 0 ? context.shopDiscount : 0.8;
      if (roll >= 7 && value.type === 'collectible' && discount != null && rng.chance(0.5)) {
        value.discount = discount;
        value.price = Math.max(1, Math.floor(value.price * value.discount));
      }
      next.offers[index] = value;
    }
  }
  return { ok: true, shop: updateMizukiRouteShopBank(next, node, context), roll, diceCost: 1 };
}

export function validMizukiRouteShop(shop, node) {
  return !!shop && shop.version === 2 && shop.id === node?.id && Number.isSafeInteger(shop.revision) && shop.revision >= 0
    && shop.revision < 10000 && Array.isArray(shop.offers) && (shop.offers.length > 0 || shop.closed === true) && shop.offers.length <= 8
    && new Set(shop.offers.map(value => value.id)).size === shop.offers.length
    && shop.offers.every(value => value && topic.items[value.itemId] && Number.isSafeInteger(value.price) && value.price >= 0
      && value.price <= 9999 && typeof value.sold === 'boolean' && ['activeTool', 'collectible', 'recruitTicket'].includes(value.type));
}
