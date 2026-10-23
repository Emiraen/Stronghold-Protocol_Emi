// 名片干员: the portrait a doctor shows on the room's seat card (screens/room.js) and on the strategy draft's name-card rows
// — the operator the player picked (room.card; room.state seats[].card), else a deterministic operator.
// This appearance-only roster includes hidden and all reserve/selection operators, regardless of ownership or picks.
import { t as trA } from '../../../shared/i18n.js';
import { useEffect, useMemo, useState } from '../../vendor/hooks.module.js';
import { SPECIAL_GOOD_BOY_CARD, SPECIAL_TRICKSTER_CARD, canUseSpecialNameCard } from '../../../shared/nameCards.js';
import { useStore } from '../store.js';
import { html, Icon, Modal } from './components.js';
import { chessAvatarUrl, chessOwnPortraitUrl, shopPortraitUrl } from './assetUrls.js';
import { resourceCache } from '../resourceCache.js';
import { portraitFor, skinsStore } from './skins.js';
import { toast } from './toasts.js';
import { useNameCardNotice } from './nameCardNotices.js';

export const GOOD_BOY_AVATAR = '/assets/local/playercards/good-boy/avatar.png';
export const GOOD_BOY_POSTER = '/assets/local/playercards/good-boy/poster.webp';
export const GOOD_BOY_ANIMATION = '/assets/local/playercards/good-boy/card.gif';
export const TRICKSTER_AVATAR = '/assets/local/playercards/trickster-outbreak/avatar.png';
export const TRICKSTER_POSTER = '/assets/local/playercards/trickster-outbreak/poster.png';
export const TRICKSTER_ANIMATION = '/assets/local/playercards/trickster-outbreak/card.gif';
export const DUCK_BURNARD_ANIMATION = '/assets/local/playercards/duck-burnard/card.gif';
export const DUCK_FLOWER_ANIMATION = '/assets/local/playercards/duck-flower/card.gif';
export const DUCK_BRIOCHE_ANIMATION = '/assets/local/playercards/duck-brioche/card.gif';
export const HATCHBUDZ_ANIMATION = '/assets/local/playercards/hatchbudz-quacked/card.gif';

const SPECIAL_CARD_ART = [
  { id: SPECIAL_GOOD_BOY_CARD, name: '晴雨同汪', description: '段位纪念', search: ['good boy', 'dog days'], avatar: GOOD_BOY_AVATAR, poster: GOOD_BOY_POSTER, animation: GOOD_BOY_ANIMATION },
  { id: SPECIAL_TRICKSTER_CARD, name: '捣蛋鬼出没', description: '玩家纪念', search: ['捣蛋鬼', 'trickster'], avatar: TRICKSTER_AVATAR, poster: TRICKSTER_POSTER, animation: TRICKSTER_ANIMATION },
  { id: 'special_duck_burnard', name: '烈烈', description: '', search: ['烈烈', 'burnard'], avatar: '/assets/local/playercards/duck-burnard/avatar.png', poster: '/assets/local/playercards/duck-burnard/poster.png', animation: DUCK_BURNARD_ANIMATION },
  { id: 'special_duck_flower', name: '花花', description: '', search: ['花花', 'flower'], avatar: '/assets/local/playercards/duck-flower/avatar.png', poster: '/assets/local/playercards/duck-flower/poster.png', animation: DUCK_FLOWER_ANIMATION },
  { id: 'special_duck_brioche', name: '包包', description: '', search: ['包包', 'brioche'], avatar: '/assets/local/playercards/duck-brioche/avatar.png', poster: '/assets/local/playercards/duck-brioche/poster.png', animation: DUCK_BRIOCHE_ANIMATION },
  { id: 'special_paintbrush_tactics', name: '画笔战术', description: '登顶纪念', search: ["绘画战术", "paintbrush tactics"], avatar: '/assets/local/playercards/paintbrush-tactics/avatar.png', poster: '/assets/local/playercards/paintbrush-tactics/poster.png', animation: null },
  { id: 'special_soft_and_deadly', name: '柔软而致命', description: '', search: ["soft and deadly"], avatar: '/assets/local/playercards/soft-and-deadly/avatar.png', poster: '/assets/local/playercards/soft-and-deadly/poster.png', animation: null },
  { id: 'special_hatchbudz_quacked', name: '孵化小能手：破壳鸭', description: '', search: ["孵化小能手", "hatchbudz", "poptoy"], avatar: '/assets/local/playercards/hatchbudz-quacked/avatar.png', poster: '/assets/local/playercards/hatchbudz-quacked/poster.png', animation: HATCHBUDZ_ANIMATION },
  { id: 'special_commander_bruno', name: '布鲁诺中校', description: '', search: ["commander bruno"], avatar: '/assets/local/playercards/commander-bruno/avatar.png', poster: '/assets/local/playercards/commander-bruno/poster.png', animation: null },
  ...[
    ['solari', '太阳鼠'], ['lunari', '露娜猫'], ['amari', '玛玛熊'], ['terrari', '耷拉兔'], ['evori', '艾沃莉'],
  ].map(([key, name]) => ({ id: `special_evori_${key}`, name, description: '段位纪念', search: ['艾沃莉梦之翼', '梦之翼', key],
    avatar: `/assets/local/playercards/evori-${key}/avatar.png`, poster: `/assets/local/playercards/evori-${key}/card.png`,
    animation: `/assets/local/playercards/evori-${key}/card.gif` })),
];
export const isSpecialCardPortrait = (src) => SPECIAL_CARD_ART.some(card => src === card.poster || src === card.animation);

// Only react when this card's cache availability changes, not every preload progress event.
export function useNameCardCache(animation = GOOD_BOY_ANIMATION) {
  const [cached, setCached] = useState(() => resourceCache.isCached(animation));
  useEffect(() => {
    const refresh = () => setCached(resourceCache.isCached(animation));
    const off = resourceCache.subscribe(refresh);
    refresh();
    return off;
  }, [animation]);
  return cached;
}

/** One subscription covers the catalog: newly added rewards must also switch after download. */
export function useSpecialNameCardCache() {
  const availability = () => SPECIAL_CARD_ART.filter(card => card.animation && resourceCache.isCached(card.animation)).map(card => card.id).join('|');
  const [cached, setCached] = useState(availability);
  useEffect(() => {
    const refresh = () => setCached(availability());
    const off = resourceCache.subscribe(refresh);
    refresh();
    return off;
  }, []);
  return cached;
}

const selectedCard = (seat, myId, myCard) => (seat?.playerId === myId && myCard) || seat?.card;

/** FNV-1a of a string (the portrait pick: the same operator for a player on every client). */
function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Legacy device cache key; current appearance belongs to the server profile. */
export const CARD_PREF = 'room.card';

/**
 * The operators a seat card can show: one record per charId (the elite form for its E2 art), 6★ first.
 * @param {any[]} chessList chess.json records
 * @param {any} backups backups.json; includes every selection operator, not only filled DIY slots
 * @returns {any[]}
 */
export function cardOperators(chessList, backups = null) {
  const by = new Map();
  for (const c of Array.isArray(chessList) ? chessList : []) {
    if (!c || c.isDiy || typeof c.charId !== 'string' || !c.charId) continue;
    const prev = by.get(c.charId);
    if (!prev || (c.isGolden && !prev.isGolden)) by.set(c.charId, c);
  }
  for (const [charId, unit] of Object.entries(backups?.units || {})) {
    if (!unit || !charId || by.has(charId)) continue;
    const assets = unit.assets || {};
    by.set(charId, { ...unit, charId, baseId: `char:${charId}`, isGolden: true, assets: { ...assets,
      avatar: assets.avatarGolden || assets.avatar,
      portrait: assets.portraitGolden || assets.portrait,
    } });
  }
  return [...by.values()].sort((a, b) => ((b.rarity ?? 0) - (a.rarity ?? 0)) || String(a.name).localeCompare(String(b.name), 'zh'));
}

/** Every illustration is selectable without equipping or caching the skin's battle model. */
export function cardIllustrations(list, m) {
  const choices = [];
  for (const c of list) {
    const original = chessOwnPortraitUrl(m, c);
    const e2 = chessOwnPortraitUrl(m, c, true);
    const add = (choice, label, art, group = '') => {
      if (art) choices.push({ c, choice, label, art, group, key: `${c.charId}:${choice}` });
    };
    add('original', trA('原始立绘'), original);
    if (e2 !== original) add('e2', trA('精英二立绘'), e2);
    for (const [id, skin] of Object.entries(m?.chars?.[c.charId]?.skins || {})) add(id, skin.name || id, skin.portrait, skin.group || '');
  }
  return choices;
}

function selectedIllustration(c, m) {
  return portraitFor(c) || (c.isGolden && chessOwnPortraitUrl(m, c, true) !== chessOwnPortraitUrl(m, c) ? 'e2' : 'original');
}

/** Shared profile editor: the complete appearance roster is independent of owned or selected operators. */
export function CardPicker({ current, list, m, onPick, onClose, online = true, loading = false }) {
  const [q, setQ] = useState('');
  const [star, setStar] = useState(0);
  const rank = useStore(s => s.rank);
  useSpecialNameCardCache();
  const [downloading, setDownloading] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const ready = useStore((s) => s.profileReady, Object.is, skinsStore);
  const profileId = useStore((s) => s.profileId, Object.is, skinsStore);
  useNameCardNotice(ready ? profileId : null, rank, ready && !loading && !q && !star);
  const sync = useStore((s) => s.sync, Object.is, skinsStore);
  useStore((s) => s.entries, Object.is, skinsStore);
  useStore((s) => s.portraits, Object.is, skinsStore);
  const disabled = !online || !ready || loading;
  const illustrations = useMemo(() => cardIllustrations(list, m), [list, m]);
  const needle = q.trim().toLowerCase();
  const shown = illustrations.filter(({ c, label, group }) => (!star || c.rarity === star) && (!needle
    || [c.name, c.appellation, label, group].some(value => String(value || '').toLowerCase().includes(needle))));
  const specialCards = SPECIAL_CARD_ART.filter(card => !star
    && (!needle || [card.name, card.description, ...card.search].some(value => value.includes(needle))))
    .map(card => ({ ...card, locked: !canUseSpecialNameCard(rank, card.id) }));
  const downloadCard = async (card) => {
    if (downloading) return;
    setDownloading(card.id);
    setDownloadError('');
    try {
      const ok = await resourceCache.download('optional', { urls: [card.animation] });
      if (!ok || !resourceCache.isCached(card.animation)) throw new Error(trA('动态卡面尚未下载完成，请重试'));
    } catch (error) { setDownloadError(error?.message || trA('下载失败，请重试')); }
    finally { setDownloading(''); }
  };
  const status = !online ? trA('连接恢复后可更换名片') : !ready || loading ? trA('正在载入名片…')
    : sync === 'pending' || sync === 'sending' ? trA('正在保存名片…')
      : sync === 'error' ? trA('保存失败，已恢复原名片') : trA('选择后自动保存，头像和同盟立绘会同步更新');
  return html`<${Modal} open=${true} title=${trA('名片编辑')} micro="PROFILE CARD" onClose=${onClose} width="min(9.6rem, 94vw)" class="cardpick">
    <div class="cardpick__bar">
      <label class="cardpick__search"><${Icon} name="search" /><input type="search" value=${q} placeholder=${trA('搜索干员或皮肤')} aria-label=${trA('搜索干员或皮肤')} onInput=${(e) => setQ(e.currentTarget.value)} /></label>
      <div class="cardpick__stars" role="radiogroup" aria-label=${trA('稀有度')}>
        ${[[0, trA('全部')], [6, '6★'], [5, '5★'], [4, '4★']].map(([v, label]) => html`<button key=${v} type="button" role="radio" aria-checked=${star === v ? 'true' : 'false'}
          class=${star === v ? 'is-on' : ''} onClick=${() => setStar(v)}>${label}</button>`)}
      </div>
    </div>
    <div class="cardpick__grid" aria-busy=${loading}>
      <button type="button" disabled=${disabled} class=${`cardpick__op cardpick__op--auto${!current ? ' is-on' : ''}`} onClick=${() => onPick('')} title=${trA('按博士编号自动分配')}>
        <span class="cardpick__img"><${Icon} name="refresh" /></span><span class="cardpick__name">${trA('默认')}</span></button>
      ${specialCards.map(card => html`<div class="cardpick__special" key=${card.id}>
        <button type="button" disabled=${disabled && !card.locked} aria-disabled=${card.locked ? 'true' : undefined}
          class=${`cardpick__op${current === card.id && !card.locked ? ' is-on' : ''}${card.locked ? ' is-locked' : ''}`}
          onClick=${() => { if (card.locked) { toast(trA('尚未获得该头像'), 'warn'); return; } onPick(card.id); }}
          title=${card.locked ? `${trA(card.name)} · ${trA('尚未获得该头像')}` : card.description ? `${trA(card.name)} · ${trA(card.description)}` : trA(card.name)}>
          <span class="cardpick__img cardpick__img--portrait cardpick__img--special"><img src=${card.animation && resourceCache.isCached(card.animation) ? card.animation : card.poster} alt="" draggable=${false} />
            ${card.locked ? html`<span class="cardpick__locked" aria-hidden="true">${trA('未获得')}</span>` : null}</span>
          <span class="cardpick__name">${trA(card.name)}</span>${card.description ? html`<span class="cardpick__name cardpick__art-name">${trA(card.description)}</span>` : null}
        </button>
        ${card.animation && !resourceCache.isCached(card.animation) ? html`<button type="button" class="cardpick__download" disabled=${!online || !!downloading} onClick=${() => downloadCard(card)} aria-label=${`${trA('下载动态卡面')} · ${trA(card.name)}`}><${Icon} name="download" />${downloading === card.id ? trA('下载中…') : trA('下载动态卡面')}</button>` : null}
      </div>`)}
      ${shown.map(({ c, choice, label, art, key }) => html`<button key=${key} type="button" disabled=${disabled} class=${`cardpick__op${current === c.charId && selectedIllustration(c, m) === choice ? ' is-on' : ''}`} onClick=${() => onPick(c.charId, choice)} title=${`${c.name} · ${label}`}>
        <span class="cardpick__img cardpick__img--portrait"><img crossorigin="anonymous" src=${art} portraitPreview=${true} alt="" loading="lazy" draggable=${false}
              onLoad=${(event) => { event.currentTarget.style.visibility = ''; }}
              onError=${(event) => { event.currentTarget.style.visibility = 'hidden'; }} /></span>
        <span class="cardpick__name">${c.name}</span><span class="cardpick__name cardpick__art-name">${label}</span>${c.rarity ? html`<span class=${`cardpick__star r${c.rarity}`}>${c.rarity}★</span>` : null}</button>`)}
    </div>
    ${!loading && !shown.length && !specialCards.length ? html`<p class="cardpick__note">${trA('没有找到符合条件的立绘')}</p>` : null}
    ${specialCards.some(card => card.animation && !resourceCache.isCached(card.animation)) ? html`<p class="cardpick__note">${trA('动态卡面需下载个性化资源；未下载时显示静态首帧。')}</p>` : null}
    ${downloadError ? html`<p class="cardpick__note" role="alert">${downloadError}</p>` : null}
    <p class="cardpick__note" role="status"><${Icon} name="info" />${status}</p>
  <//>`;
}

function seatOperator(seat, { pool, byChar, myId, myCard }) {
  if (!seat || seat.playerId == null) return null;
  const own = seat.playerId === myId;
  const pick = (own && myCard) || seat.card;
  const rec = pick && byChar ? byChar.get(pick) : null;
  if (rec) return { rec, own };
  if (!Array.isArray(pool) || !pool.length) return null;
  return { rec: pool[hash32(seat.playerId) % pool.length], own };
}

/** Small face avatar for profile chips; use avatar art rather than cropping the half-body portrait. */
export function seatAvatar(seat, { pool, byChar, m, myId, myCard }) {
  const special = SPECIAL_CARD_ART.find(card => card.id === selectedCard(seat, myId, myCard));
  if (special) return special.avatar;
  const selected = seatOperator(seat, { pool, byChar, myId, myCard });
  if (!selected) return null;
  const choice = selected.own ? portraitFor(selected.rec) : seat?.cardSkin;
  const art = m?.chars?.[selected.rec.charId];
  const original = art?.avatar || chessAvatarUrl(m, { charId: selected.rec.charId, assets: { avatar: selected.rec.charId } });
  if (choice === 'original') return original;
  const downloaded = (url) => !!url && (/^\/p\//.test(url) || !resourceCache.isManaged(url) || resourceCache.isCached(url));
  if (choice === 'e2') return downloaded(art?.avatarE2) ? art.avatarE2 : original;
  const skin = art?.skins?.[choice];
  const selectedImage = skin?.avatar || skin?.portrait;
  return downloaded(selectedImage) ? selectedImage : original;
}

/**
 * The seat card's portrait: the operator the player picked (room.state seats[].card, or one's own pick), else one of
 * all operators chosen by the player id — the same on every client (null before the data loads).
 * @param {any} seat room.state seat @param {{ pool: any[], byChar: Map<string, any>, m: any, myId: any, myCard: string }} ctx
 */
export function seatPortrait(seat, { pool, byChar, m, myId, myCard }) {
  const special = SPECIAL_CARD_ART.find(card => card.id === selectedCard(seat, myId, myCard));
  if (special) return special.animation && resourceCache.isCached(special.animation) ? special.animation : special.poster;
  const selected = seatOperator(seat, { pool, byChar, myId, myCard });
  if (!selected) return null;
  return selected.own
    ? shopPortraitUrl(m, selected.rec, portraitFor(selected.rec))
    : shopPortraitUrl(m, selected.rec, seat?.cardSkin);
}
