import { useMemo } from '../../vendor/hooks.module.js';
import { html, AvatarFrame } from './components.js';
import { data, useData } from '../data.js';
import { cardOperators, seatAvatar } from './seatArt.js';
import { rankIconUrl, normalizeRankLabel } from '../../../shared/ranks.js';
import { rankPyramidCaption } from './rankPyramidGraphic.js';
import { t } from '../../../shared/i18n.js';

/** Shared compact identity for public, match and docked private messages. */
export function ChatIdentity({ item, me = false }) {
  useData('chess', 'assets', 'backups');
  const chess = data.get('chess'), backups = data.get('backups'), manifest = data.get('assets');
  const portraits = useMemo(() => {
    const pool = cardOperators(data.list('chess'), backups);
    return { pool, byChar: new Map(pool.map(card => [card.charId, card])), m: manifest };
  }, [chess, backups, manifest]);
  const playerId = item.playerId || item.profileId || item.from;
  const seat = { playerId, card: item.card, cardSkin: item.cardSkin || 'original' };
  const avatar = seatAvatar(seat, portraits);
  const fallback = item.cardSkin ? seatAvatar({ ...seat, cardSkin: 'original' }, portraits) : null;
  const summary = item.rank || {};
  const rank = summary.rank || summary;
  const rankLabel = normalizeRankLabel(rank.label) || t('未定级');
  const icon = rank.icon || 'unranked';
  const globalRank = summary.globalRank || rank.globalRank;
  const highRank = ['immortal', 'radiant'].includes(rank.division)
    || /^(?:immortal_[123]|radiant)$/.test(icon);
  const placement = highRank && Number.isSafeInteger(globalRank) && globalRank > 0 ? globalRank : null;
  const caption = rankPyramidCaption({ ...rank, globalRank });
  const name = item.name || t('博士');
  return html`<span class="sp-chat__identity">
    <${AvatarFrame} class="sp-chat__avatar" size="sm" name=${name} src=${avatar} fallbackSrc=${fallback} fallbackIcon="user" />
    <span class="sp-chat__name-row"><strong class="sp-chat__name" title=${name}>${name}</strong>
      <img class="sp-chat__rank-icon" src=${rankIconUrl(icon)} alt=${rankLabel} title=${rankLabel} draggable=${false} />
      ${placement ? html`<span class="sp-chat__global-rank" style=${{ color: caption.color }} title=${`${rankLabel} · #${placement}`}>
        <span>#${placement}</span>
      </span>` : null}
      ${me ? html`<small class="sp-chat__self">${t('我')}</small>` : null}
    </span>
  </span>`;
}
