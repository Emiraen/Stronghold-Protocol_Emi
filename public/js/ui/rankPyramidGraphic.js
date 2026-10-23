import { html } from './components.js';
import { rankIconUrl } from '../../../shared/ranks.js';

const TILE_ICONS = /^(?:(?:iron|bronze|silver|gold|platinum|diamond|ascendant|immortal)_[123]|radiant)$/;
// Measured from each native frame's inner diagonal and horizontal pixel edges.
// Entire texture images are fitted inside; no clipping or masking is applied.
const BADGE_LAYOUTS = [
  { top: 64, width: 184, frameBottom: 238 },
  { top: 66, width: 180, frameBottom: 259 },
  { top: 67, width: 176, frameBottom: 266 },
  { top: 68, width: 174, frameBottom: 277 },
  { top: 69, width: 170, frameBottom: 281 },
];
const FULL_LAYOUTS = {
  2: { top: 67, width: 170 },
  3: { top: 70, width: 166 },
  4: { top: 71, width: 164 },
};
// Native Episode5_CompetitiveTierDataTable primary FLinearColors converted to sRGB.
// Keep Mythic/Radiant at the screenshot colors already confirmed by the user.
const RANK_TEXT_COLORS = {
  iron: '#868986', bronze: '#a5855d', silver: '#bbc2c2', gold: '#eccf56',
  platinum: '#59a9b6', diamond: '#b489c4', ascendant: '#6ae2af',
  immortal: '#b93f66', radiant: '#ffffaa',
};

export function rankPyramidCaption(best) {
  const name = best ? `${best.division === 'radiant' ? '源能战魂' : best.divisionName}${best.tier ? ['', '一', '二', '三'][best.tier] : ''}` : '';
  const placement = ['immortal', 'radiant'].includes(best?.division)
    && Number.isSafeInteger(best.globalRank) && best.globalRank > 0 ? `#${best.globalRank}` : '';
  return { name, placement, color: RANK_TEXT_COLORS[best?.division] || 'var(--text-hi, #eef0ef)' };
}

function triangle(cell, row, column, rowCount, layout) {
  const width = layout.width / rowCount;
  const height = width * 111 / 125;
  const x = 140.5 - (row + 1) * width / 2 + column * width / 2;
  const y = layout.top + row * height;
  const down = column % 2 === 1;
  const points = down
    ? `${x},${y} ${x + width},${y} ${x + width / 2},${y + height}`
    : `${x + width / 2},${y} ${x + width},${y + height} ${x},${y + height}`;
  const icon = TILE_ICONS.test(cell?.icon || '') ? cell.icon : null;
  return { x, y, width, height, points, texture: icon ? `/assets/rank-pyramid/triangles/${icon}_${down ? 'down' : 'up'}.png` : null };
}

/** Shared native geometry: three rows on cards, seven in the ranked menu. */
export function RankPyramidGraphic({ view, mini = false }) {
  const rows = (view?.rows || []).slice(0, mini ? 3 : 7);
  const best = view?.best;
  const caption = rankPyramidCaption(best);
  const bestName = caption.name;
  const label = mini ? caption.placement : '';
  const labelColor = caption.color;
  const wins = view?.totalWins ?? view?.filledWins ?? 0;
  const badgeLevel = wins >= 100 ? 5 : wins >= 75 ? 4 : wins >= 50 ? 3 : wins >= 25 ? 2 : 1;
  const fullLevel = wins >= 75 ? 4 : wins >= 50 ? 3 : 2;
  const frame = mini ? `ActRanked_Badge_L${badgeLevel}.png` : `ActRank_lvl${fullLevel}.png`;
  const layout = mini ? BADGE_LAYOUTS[badgeLevel - 1] : FULL_LAYOUTS[fullLevel];
  const tiles = rows.flatMap((row, i) => row.map((cell, j) => triangle(cell, i, j, rows.length, layout)));
  const height = layout.width * 111 / 125;
  // Center the rank icon on the triangle, independent of whether it has a placement.
  const iconWidth = 124;
  const iconHeight = 150;
  const iconY = layout.top + height / 2 - iconHeight / 2;
  // Follow each visible frame edge rather than its transparent image padding.
  const labelSize = 60;
  const labelY = (layout.frameBottom || 281) + 3 + labelSize * .72;
  const viewHeight = label ? Math.max(281, labelY + 9) : 281;
  return html`<svg class=${`rank-pyramid-graphic${mini ? ' rank-pyramid-graphic--mini' : ''}`} viewBox=${`0 0 281 ${viewHeight}`} role="img" aria-label=${best ? `排位金字塔，历史最高段位 ${label || bestName}` : '排位金字塔'}>
    <title>${best ? `历史最高段位 ${label || bestName}` : '排位金字塔'}</title>
    <image class="rank-pyramid-graphic__frame" href=${`/assets/rank-pyramid/frames/${frame}`} x="0" y="0" width="281" height="281" preserveAspectRatio="xMidYMid meet" />
    <g class="rank-pyramid-graphic__tiles">${tiles.map((tile, i) => html`<g key=${i}>
      ${!tile.texture && mini ? html`<polygon points=${tile.points} fill="#152026" fill-opacity=".5" stroke="#657075" stroke-opacity=".35" stroke-width=".5" />` : null}
      ${tile.texture ? html`<image href=${tile.texture} x=${tile.x} y=${tile.y} width=${tile.width} height=${tile.height} preserveAspectRatio="xMidYMid meet" />` : null}
    </g>`)}</g>
    ${mini && best ? html`<image class="rank-pyramid-graphic__rank" href=${rankIconUrl(best.icon)} x=${(281 - iconWidth) / 2} y=${iconY} width=${iconWidth} height=${iconHeight} preserveAspectRatio="xMidYMid meet" />` : null}
    ${label ? html`<text class="rank-pyramid-graphic__label" x="140.5" y=${labelY} text-anchor="middle" fill=${labelColor} font-family="ValorantRankDigits" font-size=${labelSize} font-weight="700">${label}</text>` : null}
  </svg>`;
}
