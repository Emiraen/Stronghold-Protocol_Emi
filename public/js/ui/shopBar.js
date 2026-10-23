// Bottom shop bar (research 06 §11.2 / D3): LEVEL card (upgrade price hex, 升级), 3–5 operator cards
// (tier chip, price hex with discount/markup colours, portrait, bonds — a bond the mode never activates struck through,
// 本局禁用 — frozen overlay, sold state,
// merge progress), the item card, the funds card with ✕ 收起; above it 剩余可放置角色, 冻结/解冻 and 刷新.
// Buying and upgrading take two taps (research 09 §5 / §6.5, official `EventOnFirstClick` → `EventOnConfirm` /
// `EventOnUpgrade`): the first tap selects a card — it lifts and enlarges, its detail opens and it shows 确认购买
// (无法购买 + the reason when it cannot be bought) — and a second tap on the same card buys it; the LEVEL card's first
// tap arms 确认升级 and the second upgrades (已满级 at level 6). A tap anywhere else, a shop change or the end of the
// editable phase disarms. A tap anywhere on a card is the card's tap — its 确认购买 strip included (it takes no
// pointer): there is no ⓘ corner (the official cards have none; user playtest #6 item 10 — on phones its invisible
// 44 px touch area covered the card's bottom-right quarter, half the strip, and a second tap there only re-opened the
// detail); a card that cannot be bought right now (the bar is not editable: ready, round start) opens its detail. The
// D / R / F keys stay one-press shortcuts — a 刷新 whose request is still on the wire dims the button and swallows
// further taps and the R key until the reply lands (GitHub #501; the single-flight lives in ui/gameActions.js
// onRefreshBusy, ui/shopBar.js only draws it). There is no drag-to-sell zone: selling is the 出售 +N button of a tapped
// unit's underframe (ui/underframe.js). After a promotion the operator cards are replaced by
// the 晋升奖励 cards (3 free operators, pick 1 — also two taps) until picked or put off (稍后 → rewardOverlay.js pill);
// a special refresh (凯瑟琳 定向投放's 3 items, 娜仁图亚, 寻呼模块, 信标, 松果) takes the same place under its own name, an
// item slot drawn as an item card (player report #6 after 0.1.0).
// Operator cards show portrait, name, bonds, tier, price and ownership marks.
// Skills, modules and profession branches remain available in the operator detail panel.

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Icon, HexBadge, TierChip, Tooltip, MicroLabel } from './components.js';
import { Img, BondGlyph, CoinGlyph, GIcon, RichText } from './gameComponents.js';
import { priceTone, mergeProgress, mergeTarget, shopBlockReason, offerHeader, briefingBondTip, ownStandIn, standInLabel, standInTip, standInForText, ownDiyRecord } from './gameLogic.js';
import { shopPortraitUrl, itemIconUrl, uiUrl } from './assetUrls.js';
import { portraitFor } from './skins.js';
import { data } from '../data.js';
import { hotkeyLabelOf } from './settings.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
// Keep the confirmation card visible while its secondary detail panel is open.
const cardAnchor = (target) => target?.getBoundingClientRect ? () => target.isConnected ? target.getBoundingClientRect() : null : null;

function PriceHex({ slot, free, poor = false }) {
  const tone = priceTone(slot);
  const price = Number(slot?.price) || 0;
  if (free || price === 0) return html`<span class="scard__free">FREE</span>`;
  // like the original (img_bg_price_not_enough) the price turns grey while the funds don't cover it
  return html`<${HexBadge} value=${price} tone=${poor ? 'dark' : tone} size="md" class=${cx('scard__price', poor && 'is-poor')}
    title=${poor ? t('资金不足') : tone === 'discount' ? t('折扣价（原价 {basePrice}）', { basePrice: slot.basePrice }) : tone === 'premium' ? t('加价（原价 {basePrice}）', { basePrice: slot.basePrice }) : t('价格')} />`;
}

/** Data lookups (merge progress / target, the loadout; shopBlockReason ignores them — a full hand refuses every purchase). */
const LOOKUPS = { getChess: (id) => data.lookup('chess', id), getItem: (id) => data.lookup('items', id) };

/**
 * Where a merge-completing buy sends the elite (DESIGN §20.11), null when the card completes no merge: the 可晋升 tag's
 * title, and a line of the detail card the first tap opens — a touch screen never shows a title (QA 6b).
 */
export function mergeHint(priv, chessId) {
  const prog = mergeProgress(priv, chessId, LOOKUPS.getChess);
  if (!(prog.copies > 0 && prog.copies + 1 >= prog.need)) return null;
  return mergeTarget(priv, chessId, LOOKUPS.getChess) ? t('精锐干员将出现在作战区原位置') : t('精锐干员将进入整备区');
}

/**
 * Whether a shop card shows its frost: its own slot's `frozen` (m.private shop.slots[i].frozen) — the 冻结 toggle copies onto
 * every unsold slot, and 梓兰's 猎头顾问 freezes ONE copied card with every active refresh while the toggle stays off
 * (GitHub #354: the bar drew only the toggle, so the frozen card showed no frost) — or the toggle itself (a frame without
 * per-slot flags). The 冻结 button and the bar's frame keep following the toggle alone.
 */
export const slotFrozen = (slot, toggle = false) => !!slot?.frozen || !!toggle;

/** The armed (first-tapped) card's confirm strip: 确认购买 / 确认选择, or 无法购买 + why. */
function ArmedTag({ reason, free }) {
  if (reason) return html`<span class="scard__confirm is-no" role="status"><b>${t('无法购买')}</b><small>${reason}</small></span>`;
  return html`<span class="scard__confirm" role="status"><b>${free ? t('确认选择') : t('确认购买')}</b><small>${t('再次点击')}</small></span>`;
}

/**
 * Operator card (shop and merge reward). `armed`: first tap done (second tap = `onBuy(idx)`).
 * @param {{ slot:any, idx:number, priv:any, frozen?:boolean, reason?:string|null, free?:boolean, armed?:boolean,
 *   onTap?:(idx:number)=>void, onBuy:Function, onDetail:Function }} props
 */
export function ChessCard({ slot, idx, priv, frozen = false, reason = null, free = false, armed = false, onTap = null, onBuy, onDetail, offBonds = null }) {
  const c0 = data.lookup('chess', slot.id);
  // 0.2.0 自选编队: a DIY slot the player filled is its operator (shared/diy.js, the pick of m.private.diy)
  const diyData = { chess: data.get('chess'), backups: data.get('backups') };
  const dr = c0 ? ownDiyRecord(c0, priv, diyData) : null;
  // 0.2.0 补位: the player's not-owned chess shows its stand-in (art, name, class, its backup skill); the composed record
  // keeps the chess's identity — tier, bonds, price (a DIY slot is never droppable: one or the other)
  const si = c0 && !dr ? ownStandIn(c0, priv, data.get('backups')) : null;
  const c = dr || si || c0;
  const m = data.get('assets');
  // 商店立绘 (docs/SKINS.md, local to this browser): the card's 180×360 art follows this player's choice for the
  // operator (independent of the battle model), falling back to the operator's own portrait. Read straight from the
  // store rather than with a hook: the UI tests render cards by calling them as plain functions, and the card
  // repaints with the next shop state push anyway (the choice never goes through the server).
  const portraitSkin = si ? null : portraitFor(c);
  const tier = c?.tier ?? 1;
  const prog = mergeProgress(priv, slot.id, (id) => data.lookup('chess', id));
  const hint = mergeHint(priv, slot.id);
  const willMerge = !!hint;
  const bonds = Array.isArray(c?.bonds) ? c.bonds : [];
  const disabled = !!reason;
  const tap = (e) => { if (onTap) onTap(idx, e.currentTarget); else if (!disabled) onBuy(idx); else onDetail(slot.id, 'chess', hint, cardAnchor(e.currentTarget)); };
  const name = `${c?.name || t('干员')}${si ? t('（{note}）', { note: standInForText(c0.name) }) : ''}`;
  const card = html`<button type="button" class=${cx('scard', `scard--t${tier}`, frozen && 'is-frozen', disabled && 'is-disabled', willMerge && 'is-merge', armed && 'is-armed', si && 'is-standin')}
      onClick=${tap} onContextMenu=${(e) => { e.preventDefault(); onDetail(slot.id, 'chess', hint, cardAnchor(e.currentTarget)); }}
      aria-label=${`${t('{name}，价格 {price}', { name, price: slot.price })}${armed ? (disabled ? t('，无法购买') : t('，再次点击确认')) : ''}`} aria-pressed=${onTap ? String(!!armed) : undefined}>
    <span class="scard__bg" aria-hidden="true"></span>
    <span class="scard__water" aria-hidden="true">${bonds[0] ? html`<${BondGlyph} bondId=${bonds[0]} />` : null}</span>
    <${Img} src=${shopPortraitUrl(m, c, portraitSkin)} portraitPreview=${true} class="scard__art" />
    <span class="scard__top">
      <${TierChip} tier=${tier} size="md" />
      <${PriceHex} slot=${slot} free=${free} poor=${reason === t('资金不足')} />
      ${prog.copies > 0 ? html`<span class="scard__pips" title=${t('已拥有 {copies}/{need}', { copies: prog.copies, need: prog.need })}>
        ${Array.from({ length: prog.need }, (_, i) => html`<i key=${i} class=${i < prog.copies ? 'on' : ''}></i>`)}
      </span>` : null}
    </span>
    ${si ? html`<span class="scard__standin" data-standin=${si.charId} data-for=${c0.chessId} title=${standInTip(si, c0.name)}>${standInLabel(si)}</span>` : null}
    ${dr ? html`<span class="scard__diy" data-diy=${dr.charId} title=${t('自选编队：{name}（只在你的商店出现）', { name: dr.name })}>${t('自选')}</span>` : null}
    <span class="scard__body">
      <span class="scard__name">${c?.name || slot.id}</span>
      <span class="scard__bonds">
        ${bonds.map((b) => {
          const name = data.lookup('bonds', b)?.name || b;
          const off = !!(offBonds && offBonds.has(b)); // a bond this mode never activates (gameLogic modeOffBonds)
          return html`<span key=${b} class=${cx('scard__bond', off && 'is-off')} title=${off ? briefingBondTip(name, 'off') : undefined}><${BondGlyph} bondId=${b} /><span>${name}</span></span>`;
        })}
      </span>
    </span>
    ${willMerge ? html`<span class="scard__mergetag" title=${hint}>${t('可晋升')}</span>` : null}
    ${frozen ? html`<span class="scard__ice" aria-hidden="true"><${Icon} name="snow" /></span>` : null}
    ${armed ? html`<${ArmedTag} reason=${reason} free=${free} />` : null}
  </button>`;
  return reason && reason !== t('已售出') && !armed ? html`<${Tooltip} text=${reason} block=${true} class="scard-wrap">${card}<//>` : card;
}

/**
 * Item card (the bar's item slot): the same two taps as an operator card.
 * @param {{ slot:any, idx:number, frozen?:boolean, reason?:string|null, armed?:boolean, onTap?:(idx:number)=>void,
 *   onBuy:Function, onDetail:Function }} props
 */
export function ItemCard({ slot, idx, frozen = false, reason = null, free = false, armed = false, onTap = null, onBuy, onDetail }) {
  const it = data.lookup('items', slot.id);
  const m = data.get('assets');
  const disabled = !!reason;
  const tap = (e) => { if (onTap) onTap(idx, e.currentTarget); else if (!disabled) onBuy(idx); else onDetail(slot.id, 'item', null, cardAnchor(e.currentTarget)); };
  const card = html`<button type="button" class=${cx('scard', 'scard--item', frozen && 'is-frozen', disabled && 'is-disabled', armed && 'is-armed')}
      onClick=${tap} onContextMenu=${(e) => { e.preventDefault(); onDetail(slot.id, 'item', null, cardAnchor(e.currentTarget)); }}
      aria-label=${`${t('{name}，价格 {price}', { name: it?.name || t('装备'), price: slot.price })}${armed ? (disabled ? t('，无法购买') : t('，再次点击确认')) : ''}`}
      aria-pressed=${onTap ? String(!!armed) : undefined}>
    <span class="scard__bg" aria-hidden="true"></span>
    <span class="scard__top">
      <${TierChip} tier=${it?.tier ?? 1} size="md" />
      <${PriceHex} slot=${slot} free=${free} poor=${reason === t('资金不足')} />
    </span>
    <span class="scard__itemart"><${Img} src=${itemIconUrl(m, it)} fallback=${html`<${GIcon} name="bolt" />`} /></span>
    <span class="scard__body">
      <span class="scard__name">${it?.name || slot.id}</span>
      <span class="scard__idesc"><${RichText} text=${it?.descRaw || it?.desc || ''} /></span>
    </span>
    ${frozen ? html`<span class="scard__ice" aria-hidden="true"><${Icon} name="snow" /></span>` : null}
    ${armed ? html`<${ArmedTag} reason=${reason} free=${free} />` : null}
  </button>`;
  return reason && reason !== t('已售出') && !armed ? html`<${Tooltip} text=${reason} block=${true} class="scard-wrap">${card}<//>` : card;
}

function SoldCard({ item = false }) {
  return html`<div class=${cx('scard', 'scard--sold', item && 'scard--item')} aria-label=${t('已售出')}>
    <span class="scard__soldtxt"><${MicroLabel}>SOLD OUT</${MicroLabel}><span>${item ? t('已购买') : t('已招募')}</span></span>
  </div>`;
}

/**
 * A slot with no card in it: the one a 调度中心 upgrade has just opened (a `null` slot — server/match/player/economy.js
 * _openLevelSlots; GitHub #332 / PR #333: the official shop shows the new slot, empty, until the next refresh or round
 * start fills it). Never 已招募 / SOLD OUT: nothing was bought there.
 */
function EmptyCard({ item = false }) {
  // `scard--sold` too: the same inert frame (no hover lift, not a buyable card for every `:not(.scard--sold)` rule); `scard--empty` only restyles it
  return html`<div class=${cx('scard', 'scard--sold', 'scard--empty', item && 'scard--item')} role="img" aria-label=${t('空栏位：刷新或下回合开始时补满')}
    title=${t('空栏位：刷新或下回合开始时补满')}></div>`;
}

function LevelCard({ shop, reason, armed = false, onTap, expMode = false, exp = null, need = null }) {
  const lv = shop?.level ?? 1;
  const max = lv >= (shop?.maxLevel ?? 6);
  const price = shop?.upgradePrice ?? 0;
  // 舟铲铲之战：升级按钮 = 购买 1 点经验（2 金）；徽章显示经验进度 exp/needed
  const badge = expMode && !max && exp != null && need != null ? `${exp}/${need}` : null;
  const label = max ? t('已满级') : expMode ? (armed ? t('确认购买') : t('购买经验')) : armed ? t('确认升级') : t('升级');
  return html`<button type="button" class=${cx('lvcard', max && 'is-max', reason && 'is-disabled', armed && 'is-armed')} onClick=${() => !reason && onTap()}
      title=${reason || (expMode && !max
        ? (armed ? t('再次点击确认购买经验（2 资金 = 1 经验）') : t('购买经验（2 资金 = 1 经验 · 进度 {exp}/{need}） · {key}', { exp: exp ?? 0, need, key: hotkeyLabelOf('levelUp') }))
        : (armed ? t('再次点击确认升级（{price} 资金）', { price }) : t('升级调度中心（{price} 资金） · {key}', { price, key: hotkeyLabelOf('levelUp') })))}
      aria-disabled=${reason ? 'true' : 'false'}
      aria-pressed=${String(!!armed)}>
    ${!max ? html`<${HexBadge} value=${badge ?? price} tone=${reason && reason !== t('调度中心已达最高等级') ? 'dark' : 'gold'} size="md" class="lvcard__price" />` : null}
    <span class="lvcard__frame">
      <span class="lvcard__micro">LEVEL</span>
      <b class="lvcard__num num">${lv}</b>
    </span>
    <span class="lvcard__label">${label}</span>
    <kbd class="lvcard__key">${hotkeyLabelOf('levelUp')}</kbd>
  </button>`;
}

/** Key of an armed shop card: kind + slot index + the id it showed (a reroll / sale changes it ⇒ disarm). */
export const armKey = (kind, idx, slot) => `${kind}:${idx}:${slot?.id ?? ''}`;

/**
 * The slot an armed key names (`c` / `i` shop slots, `r` reward slots), or null (a level card, nothing armed, a stale key).
 * @param {string|null} key
 * @param {any[]} slots the shop's slots
 * @param {any[]|null} rewardSlots the shown reward offer's slots
 */
export function armedSlotOf(key, slots, rewardSlots = null) {
  const m = typeof key === 'string' ? /^([cir]):(\d+):(.*)$/.exec(key) : null;
  if (!m) return null;
  const list = m[1] === 'r' ? rewardSlots : slots;
  const s = Array.isArray(list) ? list[Number(m[2])] : null;
  return s && !s.sold && s.id === m[3] ? s : null;
}

/**
 * Two-tap state of the bar (first tap arms, second confirms). Disarms on a tap outside the shop / detail panel, on
 * Escape, when the armed card changes or disappears, and when the bar stops being editable.
 * @param {{ editable: boolean, keys: Set<string> }} o the keys that are currently valid
 */
export function useTwoTap({ editable, keys }) {
  const [armed, setArmed] = useState(null);
  const valid = armed == null || (editable && keys.has(armed));
  useEffect(() => { if (!valid) setArmed(null); }, [valid]);
  useEffect(() => {
    if (armed == null) return undefined;
    const onDown = (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('.scard, .lvcard, .dpanel, .modal')) return;
      setArmed(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setArmed(null); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [armed]);
  return [valid ? armed : null, setArmed];
}

/**
 * A free pick-one offer in place of the bar's operator cards (pick 1 — g.reward idx — or put it off: 稍后选择 → the
 * normal shop + a reminder pill): the promotion reward (research 00 §3: 3 free operators of tier min(level+1, 6)) and
 * the special refreshes of strategies, items and 特质 — e.g. 凯瑟琳 【定向投放】 "在调度中心刷新随机3件装备，可以选择并获得
 * 其中1件". Each slot is drawn by its kind: an item slot is an item card (icon, name, tier, description, FREE) — player
 * report #6 after 0.1.0, the items used to be drawn as nameless operator cards — and the header names the offer
 * (gameLogic.offerHeader: 晋升奖励 / the strategy's effect name …; "之后还有 N 项" while more offers wait behind it).
 */
export function RewardCards({ offer, priv, editable, onPick, onDetail, onLater, armed, onTap, offBonds = null }) {
  const head = offerHeader(offer);
  return html`<div class=${cx('shopbar__reward', head.items && 'is-items')} role="group" aria-label=${head.title}>
    <div class="rwtag">
      <${Icon} name=${head.icon} class="rwtag__icon" />
      <b class="rwtag__title">${head.title}</b>
      <span class="rwtag__micro">${head.micro}</span>
      <span class="rwtag__sub">${head.sub}</span>
      ${head.more ? html`<span class="rwtag__sub rwtag__more">${head.more}</span>` : null}
      <button type="button" class="rwtag__later" onClick=${onLater} title=${t('稍后选择（回合结束后消失）')}><${Icon} name="minus" />${t('稍后')}</button>
    </div>
    <div class="shopbar__rwcards">
      ${offer.slots.map((s, i) => {
        if (!s || s.sold) return html`<div key=${`rw${i}`} class=${cx('scard', 'scard--sold', s && s.kind === 'item' && 'scard--item')}><span class="scard__soldtxt"><span>${t('已选择')}</span></span></div>`;
        const kind = s.kind === 'item' ? 'item' : 'chess';
        const reason = shopBlockReason('reward', { priv, editable, slot: s, ...LOOKUPS });
        const props = { slot: { ...s, price: 0 }, idx: i, free: true, reason, armed: armed === armKey('r', i, s), onBuy: onPick, onDetail,
          onTap: (idx, target) => onTap('r', idx, s, kind, reason, onPick, target) };
        return kind === 'item' ? html`<${ItemCard} key=${`rw${i}:${s.id}`} ...${props} />` : html`<${ChessCard} key=${`rw${i}:${s.id}`} priv=${priv} offBonds=${offBonds} ...${props} />`;
      })}
    </div>
  </div>`;
}

/**
 * The bar.
 * @param {{ priv:any, editable:boolean, collapsed:boolean, refreshBusy?:boolean, onCollapse:(c:boolean)=>void,
 *   onBuy:(i:number)=>void, onLevel:Function, onRefresh:Function, onFreeze:Function, onDetail:(id:string, kind?:string, hint?:string|null)=>void,
 *   onDetailClose?: () => void, onRefuse?: (reason: string) => void, barRef:any,
 *   reward?: any, onReward?: (idx:number)=>void, onRewardLater?: Function, offBonds?: Set<string>|null }} props — offBonds:
 *   the bonds this mode never activates (gameLogic modeOffBonds), struck through on the operator cards
 */
export function ShopBar({ priv, editable, collapsed, refreshBusy = false, onCollapse, onBuy, onLevel, onRefresh, onFreeze, onDetail, onDetailClose, onRefuse, barRef,
  reward = null, onReward, onRewardLater, onArm = null, offBonds = null, onRisk = null, inventoryPager = null }) {
  const shop = priv?.shop || {};
  const slots = Array.isArray(shop.slots) ? shop.slots : [];
  const layout = shop.layout && Number.isInteger(shop.layout.chess) && Number.isInteger(shop.layout.item) ? shop.layout : null;
  const chessSlots = slots.map((s, i) => ({ s, i })).filter(({ s, i }) => s ? s.kind !== 'item' : !layout || i < layout.chess);
  const itemSlots = slots.map((s, i) => ({ s, i })).filter(({ s, i }) => s ? s.kind === 'item' : !!layout && i >= layout.chess && i < layout.chess + layout.item);
  const frozen = !!shop.frozen;
  const funds = Number(priv?.funds) || 0;
  const remaining = Math.max(0, (priv?.deployCap ?? 8) - (priv?.deployCount ?? 0));
  const lvReason = shopBlockReason('levelUp', { priv, editable });
  const refReason = shopBlockReason('refresh', { priv, editable });
  const frzReason = editable ? null : shopBlockReason('freeze', { priv, editable });
  const free = Number(shop.freeRefreshes) || 0;
  const showReward = !!(reward && Array.isArray(reward.slots) && reward.slots.length);

  // A completed upgrade changes the level, so its confirmation cannot carry into the next upgrade.
  const levelKey = `lv:${shop.level ?? 1}`;
  // two-tap: the keys that may stay armed right now
  const keys = new Set();
  if (!collapsed) {
    if (!lvReason) keys.add(levelKey);
    slots.forEach((s, i) => { if (s && !s.sold) keys.add(armKey(s.kind === 'item' ? 'i' : 'c', i, s)); });
    if (showReward) reward.slots.forEach((s, i) => { if (s && !s.sold) keys.add(armKey('r', i, s)); });
  }
  const [riskUid, setRiskUid] = useState('');
  const risk = priv?.cyclopsRisk?.find(r => r.available);
  const sacrifice = [...(priv?.hand || []), ...(priv?.temp || []), ...(priv?.board || [])].filter(p => p?.kind === 'chess');
  const [armed, setArmed] = useTwoTap({ editable, keys });
  // the armed card's slot (game.js lights the tile a merge's elite will take — gameLogic.mergeTarget); kept before the
  // collapsed tab's early return (hook order)
  const armedSlot = armedSlotOf(armed, slots, showReward ? reward.slots : null);
  const armedSig = armedSlot ? `${armedSlot.kind}:${armedSlot.id}` : '';
  useEffect(() => { onArm?.(armedSlot ? { kind: armedSlot.kind === 'item' ? 'item' : 'chess', id: armedSlot.id } : null); }, [armedSig]);
  useEffect(() => () => onArm?.(null), []);
  /** First tap arms + opens the detail; the second buys (or says why it can't). */
  const tapCard = (kind, idx, slot, detailKind, reason, buy, target) => {
    const key = armKey(kind, idx, slot);
    if (armed !== key) { setArmed(key); onDetail(slot.id, detailKind, detailKind === 'chess' ? mergeHint(priv, slot.id) : null, cardAnchor(target)); return; }
    if (reason) { onRefuse?.(reason); return; }
    setArmed(null);
    onDetailClose?.();
    buy(idx);
  };
  const tapLevel = () => {
    if (armed !== levelKey) { setArmed(levelKey); return; }
    setArmed(null);
    onLevel();
  };

  if (collapsed) {
    return html`<div class=${cx('shopbar-tab', inventoryPager && 'has-inventory-pager')} ref=${barRef}>
      ${inventoryPager ? html`<div class="shopbar__capacity">${inventoryPager}<span class="shopbar__remain">${t('剩余可放置角色：')}<b class="num">${remaining}</b></span></div>` : null}
      <div class="shopbar-tab__funds"><${CoinGlyph} /><b class="num">${funds}</b></div>
      <button type="button" class="shopbar-tab__btn" onClick=${() => onCollapse(false)}><${Icon} name="chevronLeft" />${t('展开商店')}</button>
    </div>`;
  }

  const hk = { refresh: hotkeyLabelOf('refresh'), freeze: hotkeyLabelOf('freeze') }; // the player's keys (设置 → 快捷键)
  return html`<section class=${cx('shopbar', frozen && 'is-frozen', !editable && 'is-locked', showReward && 'has-reward', armed && 'has-armed')} ref=${barRef} aria-label=${t('调度中心')}>
    <div class="shopbar__tools">
      ${risk && onRisk ? html`<span class="shopbar__risk" style="display:flex;gap:6px;align-items:center;pointer-events:auto;grid-column:1 / -1">
        ${risk.quality === 'gold' ? html`<select aria-label="献祭干员" value=${riskUid} onChange=${e => setRiskUid(e.target.value)} style="max-width:140px;background:#182327;color:white"><option value="">选择献祭干员</option>${sacrifice.map(p => html`<option value=${p.uid}>${data.lookup('chess', p.id)?.name || p.id}</option>`)}</select>` : null}
        <button type="button" class="toolbtn toolbtn--amber" disabled=${!editable || (risk.quality === 'gold' && !riskUid)} title=${risk.quality === 'gold' ? '本回合献祭一次，基础招募价的2倍、最多8金币' : '消耗当前生命值的10%（向上取整，至少4点），整局最多3次，须能存活'} onClick=${() => onRisk(risk.quality === 'gold' ? Number(riskUid) : null)}>${risk.quality === 'gold' ? '献祭' : '消耗生命换12金币'}</button>
      </span>` : null}
      ${inventoryPager ? html`<div class="shopbar__capacity">${inventoryPager}<span class="shopbar__remain">${t('剩余可放置角色：')}<b class=${cx('num', remaining === 0 && 't-orange')}>${remaining}</b></span></div>` : html`<span class="shopbar__remain">${t('剩余可放置角色：')}<b class=${cx('num', remaining === 0 && 't-orange')}>${remaining}</b></span>`}
      <button type="button" class=${cx('toolbtn', 'toolbtn--ice', frozen && 'is-on')} disabled=${!!frzReason} onClick=${onFreeze}
        title=${frzReason || (frozen ? t('解冻商店 · {key}', { key: hk.freeze }) : t('冻结商店（下回合保留） · {key}', { key: hk.freeze }))}>
        <${Img} src=${uiUrl(data.get('assets'), frozen ? 'shopPanel/frozen_icon2' : 'shopPanel/frozen_icon')} class="toolbtn__img" fallback=${html`<${Icon} name="snow" />`} />
        <span>${frozen ? t('解冻') : t('冻结')}</span><kbd>${hk.freeze}</kbd>
      </button>
      <button type="button" class="toolbtn toolbtn--amber" disabled=${!!refReason || refreshBusy} onClick=${onRefresh} title=${refReason || (refreshBusy ? t('正在刷新…') : `${t('刷新商店 · {key}', { key: hk.refresh })}${priv?.expPrice != null ? ' · 免费次数可累积至下回合，优先消耗免费次数' : ''}`)}>
        <${Img} src=${uiUrl(data.get('assets'), 'shopPanel/refresh_icon')} class="toolbtn__img" fallback=${html`<${Icon} name="refresh" />`} />
        <span>${t('刷新')}</span>
        ${free > 0 ? html`<span class="toolbtn__free">${t('免费 ×{free}', { free })}</span>` : html`<${HexBadge} value=${shop.refreshPrice ?? 1} tone=${refReason || refreshBusy ? 'dark' : 'gold'} size="sm" />`}
        <kbd>${hk.refresh}</kbd>
      </button>
    </div>
    <div class="shopbar__row">
      <${LevelCard} shop=${shop} reason=${lvReason} armed=${armed === levelKey} onTap=${tapLevel}
        expMode=${Number.isFinite(priv?.shopExp) && Number.isFinite(priv?.expNeeded)} exp=${priv?.shopExp ?? null} need=${priv?.expNeeded ?? null} />
      ${showReward ? html`<${RewardCards} offer=${reward} priv=${priv} editable=${editable} onPick=${onReward} onDetail=${onDetail} onLater=${onRewardLater}
          armed=${armed} onTap=${tapCard} offBonds=${offBonds} />`
        : html`<div class="shopbar__cards">
        ${chessSlots.map(({ s, i }) => {
          if (!s) return html`<${EmptyCard} key=${`e${i}`} />`;
          if (s.sold) return html`<${SoldCard} key=${`s${i}`} />`;
          const reason = shopBlockReason('buy', { priv, editable, slot: s, ...LOOKUPS });
          return html`<${ChessCard} key=${`c${i}:${s.id}`} slot=${s} idx=${i} priv=${priv} frozen=${slotFrozen(s, frozen)} onBuy=${onBuy} onDetail=${onDetail} offBonds=${offBonds}
              reason=${reason} armed=${armed === armKey('c', i, s)} onTap=${editable ? (idx, target) => tapCard('c', idx, s, 'chess', reason, onBuy, target) : null} />`;
        })}
      </div>`}
      <div class="shopbar__item">
        ${itemSlots.length
          ? itemSlots.map(({ s, i }) => {
            if (!s) return html`<${EmptyCard} key=${`ie${i}`} item=${true} />`;
            if (s.sold) return html`<${SoldCard} key=${`is${i}`} item=${true} />`;
            const reason = shopBlockReason('buy', { priv, editable, slot: s, ...LOOKUPS });
            return html`<${ItemCard} key=${`i${i}:${s.id}`} slot=${s} idx=${i} frozen=${slotFrozen(s, frozen)} onBuy=${onBuy} onDetail=${onDetail} reason=${reason}
              armed=${armed === armKey('i', i, s)} onTap=${editable ? (idx, target) => tapCard('i', idx, s, 'item', reason, onBuy, target) : null} />`;
          })
          : html`<${SoldCard} item=${true} />`}
      </div>
      <div class="funds">
        <div class="funds__hex">
          <${CoinGlyph} class="funds__coin" />
          <b class="funds__num num">${funds}</b>
        </div>
        <span class="funds__label">${t('目前资金')}</span>
        <button type="button" class="funds__collapse" onClick=${() => onCollapse(true)}><${Icon} name="close" />${t('收起')}</button>
      </div>
    </div>
  </section>`;
}
