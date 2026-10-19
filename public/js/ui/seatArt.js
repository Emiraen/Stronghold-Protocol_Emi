// 名片干员: the portrait a doctor shows on the room's seat card (screens/room.js) and on the strategy draft's name-card rows
// — the operator the player picked (room.card; room.state seats[].card), else a deterministic operator.
// This appearance-only roster includes hidden and all reserve/selection operators, regardless of ownership or picks.
import { t as trA } from '../../../shared/i18n.js';
import { useMemo, useState } from '../../vendor/hooks.module.js';
import { useStore } from '../store.js';
import { html, Icon, Modal } from './components.js';
import { chessAvatarUrl, chessOwnPortraitUrl, shopPortraitUrl } from './assetUrls.js';
import { resourceCache } from '../resourceCache.js';
import { portraitFor, skinsStore } from './skins.js';

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
  const ready = useStore((s) => s.profileReady, Object.is, skinsStore);
  const sync = useStore((s) => s.sync, Object.is, skinsStore);
  useStore((s) => s.entries, Object.is, skinsStore);
  useStore((s) => s.portraits, Object.is, skinsStore);
  const disabled = !online || !ready || loading;
  const illustrations = useMemo(() => cardIllustrations(list, m), [list, m]);
  const needle = q.trim().toLowerCase();
  const shown = illustrations.filter(({ c, label, group }) => (!star || c.rarity === star) && (!needle
    || [c.name, c.appellation, label, group].some(value => String(value || '').toLowerCase().includes(needle))));
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
      ${shown.map(({ c, choice, label, art, key }) => html`<button key=${key} type="button" disabled=${disabled} class=${`cardpick__op${current === c.charId && selectedIllustration(c, m) === choice ? ' is-on' : ''}`} onClick=${() => onPick(c.charId, choice)} title=${`${c.name} · ${label}`}>
        <span class="cardpick__img cardpick__img--portrait"><img crossorigin="anonymous" src=${art} portraitPreview=${true} alt="" loading="lazy" draggable=${false}
              onLoad=${(event) => { event.currentTarget.style.visibility = ''; }}
              onError=${(event) => { event.currentTarget.style.visibility = 'hidden'; }} /></span>
        <span class="cardpick__name">${c.name}</span><span class="cardpick__name cardpick__art-name">${label}</span>${c.rarity ? html`<span class=${`cardpick__star r${c.rarity}`}>${c.rarity}★</span>` : null}</button>`)}
    </div>
    ${!loading && !shown.length ? html`<p class="cardpick__note">${trA('没有找到符合条件的立绘')}</p>` : null}
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
  const selected = seatOperator(seat, { pool, byChar, myId, myCard });
  if (!selected) return null;
  return selected.own
    ? shopPortraitUrl(m, selected.rec, portraitFor(selected.rec))
    : shopPortraitUrl(m, selected.rec, seat?.cardSkin);
}
