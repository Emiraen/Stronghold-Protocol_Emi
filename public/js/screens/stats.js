// The local stats viewer (统计数据): this browser's record of the matches the player took part in — see ui/stats.js for
// what is recorded, what counts and how the storage is bounded. A full-screen overlay opened imperatively from the
// title screen / lobby / room (`openStats()`); <StatsHost/> is mounted once by main.js. Ported from PR #323 by
// @2321Robin; the overview now uses PR 643's achievement panel: alliance header, six-title hexagon, best lineup,
// bond records and strategy records. Trophy and social counters are replaced by East rank and best-round information.
//
//   总览      – per-mode records, the six 评语, highest-stacked bond / lineup, bond and strategy records
//   策略      – per strategy (band): games used / passed (self alive on a winning team) / pass rate
//   战斗累计  – combat sums plus the detailed games / difficulty / hidden-core / time summary
//   对局记录  – every stored match, newest first. A settled row re-views that match's settlement screen (the record is
//               inverted into an m.result payload for <ResultView/>); a match given up early is marked 中途退出 and,
//               when it did not count, 不计入统计
// Everything is 本机数据 (localStorage, `sp.pref.stats`) and the page says so, teammates' names included. 导出 / 导入 (a
// JSON file, merged by record id on the way in) moves it between devices; 清空 resets it after a confirm dialog.
// The host renders nothing until opened and the game data files the replay needs load only then (the lobby alone never
// downloads them): the overview loads the operator, bond and item records required by the stored lineup.

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS } from '../../../shared/constants.js';
import { html, Icon, MicroLabel, Spinner, Button, confirmDialog, Overlay, isTopOverlay } from '../ui/components.js';
import { useGameData, makeLookups, BandIcon, Img, BondGlyph, UnitThumb } from '../ui/gameComponents.js';
import { data, useData } from '../data.js';
import { fmtNum } from '../ui/gameLogic.js';
import { titleIconUrl } from '../ui/assetUrls.js';
import { useLeave } from '../ui/transitions.js';
import { OpCard } from './settle.js';
import { rankIconUrl } from '../../../shared/ranks.js';
import { useDocClass } from '../ui/device.js';
import { createStore, useStore, selectRoute, loadPref } from '../store.js';
import { cardOperators, seatAvatar } from '../ui/seatArt.js';
import { skinsStore } from '../ui/skins.js';
import { ResultView } from './result.js';
import { toast, toastError } from '../ui/toasts.js';
import {
  loadStats, saveStats, emptyStats, importStats, exportStats, aggregateStats, countsTowardStats, selfRowOf, roundsOf,
  recordToResult, MAX_RECORDS, FULL_KEEP, IMPORT_MAX_CHARS,
} from '../ui/stats.js';
import { t, N_ } from '../../../shared/i18n.js';
import { UiPluginSlot } from '../ui/pluginSlots.js';


// PR 643 achievement panel, fed by East's actual local match records.
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
/** 绝境突破: a clear on these difficulties. */
const HARD_UP = new Set(['HARD', 'ABYSS']);
/** The hexagon's 评语, clockwise from the top (the official order). */
export const HEX_TITLES = ['comment_4', 'comment_5', 'comment_6', 'comment_1', 'comment_2', 'comment_3'];

/**
 * Everything the panel shows, from the local records (any order). `hiddenLayers(bondId)`: a bond whose layers the game
 * never shows (bonds.json noStack) cannot be the 战果纪录.
 * @param {any[]} records
 * @param {{ hiddenLayers?: (bondId: string) => boolean }} [o]
 */
export function achievementStats(records, { hiddenLayers = () => false } = {}) {
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const out = {
    bestRound: 0,
    modes: { solo: { games: 0, wins: 0, hard: 0 }, coop: { games: 0, wins: 0, hard: 0 } },
    titles: {}, best: null, maxima: { gold: 0, merges: 0, kills: 0 },
    topBonds: [], topBands: [], markedBands: [],
  };
  const bonds = new Map();
  const bands = new Map();
  const marked = new Set();
  for (const rec of Array.isArray(records) ? records : []) {
    const self = rec ? selfRowOf(rec) : null;
    if (!self) continue;
    if (!countsTowardStats(rec)) continue;
    out.bestRound = Math.max(out.bestRound, roundsOf(rec));
    const won = !!self.victory;
    const hardWin = won && HARD_UP.has(rec.difficulty);
    const mode = out.modes[rec.roomMode];
    if (mode) { mode.games++; if (won) mode.wins++; if (hardWin) mode.hard++; }
    const tid = self.title?.id;
    if (tid) out.titles[tid] = (out.titles[tid] || 0) + 1;
    const st = self.stats || {};
    for (const k of ['gold', 'merges', 'kills']) if (num(st[k]) > out.maxima[k]) out.maxima[k] = st[k];
    if (self.bandId) {
      bands.set(self.bandId, (bands.get(self.bandId) || 0) + 1);
      if (hardWin) marked.add(self.bandId);
    }
    for (const b of Array.isArray(self.bonds) ? self.bonds : []) {
      if (!b || !b.bondId) continue;
      if (b.active) bonds.set(b.bondId, (bonds.get(b.bondId) || 0) + 1);
      const layers = num(b.layers);
      if (layers > 0 && !hiddenLayers(b.bondId) && (!out.best || layers > out.best.layers)) out.best = { rec, self, bondId: b.bondId, layers };
    }
  }
  const top = (map) => [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3);
  out.topBonds = top(bonds).map(([bondId, games]) => ({ bondId, games }));
  out.topBands = top(bands).map(([bandId, games]) => ({ bandId, games }));
  out.markedBands = [...marked];
  return out;
}

/** The operators of a bond (plain chess, one per operator), by tier. */
export function bondOperators(chessList, bondId) {
  const seen = new Set();
  return (Array.isArray(chessList) ? chessList : [])
    .filter((c) => c && !c.isGolden && c.visible !== false && !c.isHidden && !c.isDiy && Array.isArray(c.bonds) && c.bonds.includes(bondId))
    .sort((a, b) => (a.tier - b.tier) || ((a.shopSortId ?? 0) - (b.shopSortId ?? 0)))
    .filter((c) => { const k = c.charId || c.chessId; if (seen.has(k)) return false; seen.add(k); return true; });
}


function SectionBar({ title, micro }) {
  return html`<h3 class="ach-bar">
    <span class="ach-bar__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 3h2v16h16v2H3zm5 9h3v5H8zm5-4h3v9h-3zm5-4h3v13h-3z" /></svg></span>
    <span class="ach-bar__title">${title}</span>
    <span class="ach-bar__marks" aria-hidden="true"><i><${Icon} name="rook" /></i><i><svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z" fill="none" stroke="currentColor" stroke-width="2" /></svg></i>
      <${MicroLabel} class="ach-bar__micro">STRONGHOLD PROTOCOL<br />${micro}<//></span>
  </h3>`;
}

/**
 * The six 评语 round a hexagon of six solid triangles (gaps between them, the outer corners cut, a ruler along each
 * outer edge, a dark hub). Exported for the tests: the segment paths are plain geometry.
 */
export function hexSegments(R = 172) {
  const pt = (deg, r) => [Math.cos((deg * Math.PI) / 180) * r, Math.sin((deg * Math.PI) / 180) * r];
  const mix = (p, q, u) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
  const r1 = (p) => p.map((v) => Math.round(v * 10) / 10);
  return HEX_TITLES.map((id, i) => {
    const a = -90 + i * 60;
    const n = pt(a, 1); // outward normal of the outer edge
    const off = (p, d) => [p[0] + n[0] * d, p[1] + n[1] * d];
    const p1 = pt(a - 30, R), p2 = pt(a + 30, R);
    // the gaps: each triangle shrunk towards its centroid; then the hub corner and the two outer corners cut
    const g = [(p1[0] + p2[0]) / 3, (p1[1] + p2[1]) / 3];
    const s = (p) => [g[0] + (p[0] - g[0]) * 0.93, g[1] + (p[1] - g[1]) * 0.93];
    const [C, P1, P2] = [s([0, 0]), s(p1), s(p2)];
    const poly = [mix(C, P1, 0.12), mix(C, P1, 0.93), mix(P1, P2, 0.06), mix(P1, P2, 0.94), mix(C, P2, 0.93), mix(C, P2, 0.12)];
    // the ruler: a line inside the outer edge and ticks reaching towards it (every fourth one longer)
    const e1 = off(mix(P1, P2, 0.12), -14), e2 = off(mix(P1, P2, 0.88), -14);
    const ticks = Array.from({ length: 17 }, (_, j) => { const q = mix(e1, e2, j / 16); return [r1(q), r1(off(q, j % 4 === 0 ? 9 : 5))]; });
    return { id, i, points: poly.map((p) => r1(p).join(',')).join(' '), rule: [r1(e1), r1(e2)], ticks };
  });
}
const HEX = hexSegments();
const seg = ([p, q], key) => html`<line key=${key} x1=${p[0]} y1=${p[1]} x2=${q[0]} y2=${q[1]} />`;

function TitleHex({ titles, gd }) {
  const recs = Array.isArray(gd.config?.titles) ? gd.config.titles : [];
  const pt = (deg, r) => [Math.cos((deg * Math.PI) / 180) * r, Math.sin((deg * Math.PI) / 180) * r];
  return html`<div class="ach-hex">
    <span class="ach-hex__cap" aria-hidden="true"><i></i>STRONGHOLD PROTOCOL<small></small></span>
    <svg class="ach-hex__svg" viewBox="-300 -240 600 480" aria-hidden="true">
      ${HEX.map((h) => html`<g key=${h.id} class="ach-hex__seg" style=${`--i:${h.i}`}>
        <polygon points=${h.points} />
        <g class="ach-hex__ticks">${seg(h.rule, 'rule')}${h.ticks.map(seg)}</g>
      </g>`)}
      <circle class="ach-hex__hub" r="15" />
    </svg>
    ${HEX_TITLES.map((id, i) => {
      const [x, y] = pt(-90 + i * 60, 222);
      const rec = recs.find((r) => r.id === id);
      return html`<span key=${id} class="ach-hex__label" style=${`left:calc(50% + ${(x / 600) * 100}%);top:calc(50% + ${(y / 480) * 100}%);--i:${i}`} title=${rec?.text || ''}>
        <b class="num">${titles[id] || 0}</b><span>${rec?.name || id}</span></span>`;
    })}
  </div>`;
}


function ModeTable({ modes }) {
  const row = (key, icon, label) => html`<div class="ach-modes__row">
    <span class="ach-modes__mode"><${Icon} name=${icon} /><b>${label}</b></span>
    <span class="ach-modes__cell"><b class="num">${modes[key].games}</b><small>${t('总模拟数')}</small></span>
    <span class="ach-modes__cell"><b class="num">${modes[key].wins}</b><small>${t('成功卫戍')}</small></span>
    <span class="ach-modes__cell" title=${t('在绝境模拟或终极模拟中成功卫戍')}><b class="num">${modes[key].hard}</b><small>${t('绝境突破')}</small></span>
  </div>`;
  return html`<div class="ach-modes">${row('solo', 'user', t('独立模拟'))}${row('coop', 'users', t('同盟模拟'))}</div>`;
}

function BestRecord({ best, gd }) {
  if (!best) return html`<p class="ach-empty">${t('还没有可展示的战果：完成一局模拟后在这里记录盟约叠加最高的一局')}</p>`;
  const lineup = Array.isArray(best.self.lineup) ? best.self.lineup : [];
  const slots = Array.from({ length: 10 }, (_, i) => lineup[i] || null);
  const bonds = recordBonds(best.self.bonds, (id) => !!gd.bond?.(id)?.noStack, (id) => !!gd.bond?.(id)?.isCore);
  const bond = gd.bond?.(best.bondId);
  return html`<div class="ach-best">
    <div class="ach-best__left">
      <span class="ach-pill">${t('战果纪录')}<${Icon} name="chevrons" /></span>
      <span class="ach-best__mount">
        <span class="ach-best__glyph" title=${bond?.name || best.bondId}><${BondGlyph} bondId=${best.bondId} /></span>
        <span class="ach-best__label">${t('盟约最高叠加')}</span>
        <b class="ach-best__num num">${best.layers}</b>
        <i class="ach-best__wire" aria-hidden="true"></i>
      </span>
    </div>
    <div class="ach-best__lineup">
      <div class="ach-best__rows">
        <div class="ach-best__row">${slots.slice(0, 5).map((u, i) => html`<${OpCard} key=${i} u=${u} gd=${gd} i=${i} />`)}</div>
        <div class="ach-best__row">${slots.slice(5).map((u, i) => html`<${OpCard} key=${i} u=${u} gd=${gd} i=${i + 5} />`)}</div>
      </div>
      <div class="ach-best__bonds">${bonds.map((b, i) => html`<span key=${b.bondId} class=${cx('sbond', b.active && 'is-on')} style=${`--i:${i}`} title=${gd.bond?.(b.bondId)?.name || b.bondId}>
        <span class="sbond__disc"><${BondGlyph} bondId=${b.bondId} /></span><b class="num">${b.hidden ? '—' : b.layers}</b></span>`)}</div>
    </div>
  </div>`;
}

/**
 * The 战果纪录's bonds beside the lineup: all recorded bonds, activated core bonds first, then active ones / layers.
 * `noStack(bondId)`: a bond whose layers the game never shows prints a dash.
 */
export function recordBonds(list, noStack = () => false, isCore = () => false) {
  const activeCore = (b) => Number(b.active && !!isCore(b.bondId));
  return (Array.isArray(list) ? list : [])
    .filter((b) => b && b.bondId && (b.active || Number(b.layers) > 0))
    .map((b) => ({ bondId: b.bondId, active: !!b.active, layers: Math.max(0, Number(b.layers) || 0), hidden: noStack(b.bondId) }))
    .sort((a, b) => activeCore(b) - activeCore(a) || (b.active - a.active)
      || ((b.hidden ? -1 : b.layers) - (a.hidden ? -1 : a.layers)));
}

function Maxima({ maxima }) {
  const box = (cls, label, v, glyph) => html`<div class=${cx('ach-max', cls)}>
    <span class="ach-max__label">${label}</span><b class="ach-max__num"><small>x</small><span class="num">${v}</span></b>
    <svg class="ach-max__glyph" viewBox="0 0 48 48" aria-hidden="true"><path d=${glyph} /></svg>
  </div>`;
  return html`<div class="ach-maxima">
    ${box('is-gold', t('单局最多消耗资金:'), maxima.gold, 'M24 3 33 13 24 23 15 13zM12 21l9 10-9 10-9-10zM36 21l9 10-9 10-9-10z')}
    ${box('is-orange', t('单局最多晋级次数:'), maxima.merges, 'M4 22 16 10l8 8 8-8 12 12-5 5-7-7-8 8-8-8-7 7zM4 38l12-12 8 8 8-8 12 12-5 5-7-7-8 8-8-8-7 7z')}
    ${box('is-mint', t('单局最多击败数:'), maxima.kills, 'M6 4h8l10 13L34 4h8L28 22l16 18-6 5-14-15-14 15-6-5 16-18z')}
  </div>`;
}

function BondRecord({ topBonds, gd }) {
  if (!topBonds.length) return html`<p class="ach-empty">${t('暂无盟约记录')}</p>`;
  const ops = bondOperators(data.list('chess'), topBonds[0].bondId);
  return html`<div class="ach-list">
    <p class="ach-sub">${t('最常使用的盟约:')}</p>
    <div class="ach-tops">${topBonds.map((b, i) => html`<div key=${b.bondId} class="ach-top ach-top--bond" title=${t('{n} 局中激活', { n: b.games })}>
      <span class="ach-top__frame"><i class="ach-top__rank">TOP${i + 1}</i><${BondGlyph} bondId=${b.bondId} /></span>
      <b class="ach-top__name">${gd.bond?.(b.bondId)?.name || b.bondId}</b></div>`)}</div>
    ${ops.length ? html`<p class="ach-sub">${t('盟约下干员为:')}</p>
      <div class="ach-ops">${ops.map((c) => html`<span key=${c.chessId} class=${cx('ach-op', `sop--t${c.tier}`)} title=${c.name}>
        <${UnitThumb} kind="chess" id=${c.chessId} size="md" showTier=${false} /><b class="ach-op__tier">${ROMAN[c.tier] || ''}</b></span>`)}</div>` : null}
  </div>`;
}

function BandRecord({ topBands, marked, gd }) {
  if (!topBands.length) return html`<p class="ach-empty">${t('暂无策略记录')}</p>`;
  const name = (id) => gd.band?.(id)?.name || id;
  return html`<div class="ach-list">
    <p class="ach-sub">${t('最常使用的策略:')}</p>
    <div class="ach-tops ach-tops--band">${topBands.map((b, i) => html`<div key=${b.bandId} class="ach-top ach-top--band">
      <span class="ach-top__frame"><i class="ach-top__rank">TOP${i + 1}</i><${BandIcon} bandId=${b.bandId} size="lg" /></span>
      <span class="ach-top__side"><b class="ach-top__name">${name(b.bandId)}</b><span class="ach-top__count"><small>x</small><b class="num">${b.games}</b></span></span></div>`)}</div>
    <p class="ach-sub" title=${t('用该策略在绝境模拟或终极模拟中成功卫戍')}>${t('已获得特殊标识的策略:')}</p>
    ${marked.length ? html`<div class="ach-marks">${marked.map((id) => html`<div key=${id} class="ach-mark">
      <span class="ach-mark__frame"><${BandIcon} bandId=${id} size="lg" /><i class="ach-mark__badge" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 1.5 14 13H2zM8 6v3.6M8 11v.6" fill="none" stroke="currentColor" stroke-width="1.8" /></svg></i></span>
      <b>${name(id)}</b></div>`)}</div>` : html`<p class="ach-empty">${t('在绝境模拟或终极模拟中成功卫戍，所用策略会获得特殊标识')}</p>`}
  </div>`;
}


function AchievementOverview({ records, gd, me, rank, avatarSrc }) {
  const s = useMemo(() => achievementStats(records, { hiddenLayers: id => !!gd.bond?.(id)?.noStack }), [records, gd]);
  return html`<div class="east-achievements">
    <section class="ach-top-area">
      <div class="ach-top-area__left">
        <div class="ach-plate">
          <div class="ach-card"><span class="ach-card__ava"><${Img} src=${avatarSrc} fallback=${html`<${Icon} name="user" />`} /></span>
            <span class="ach-card__who"><b class="ach-card__name">${me?.name || t('博士')}</b><span class="ach-card__id">${t('卫戍模拟档案')}</span><span class="east-ach-rank">${rank?.rank?.label || t('未定级')}</span></span><span class="ach-card__brand">STRONGHOLD<br />PROTOCOL</span></div>
          <div class="ach-counts"><span class="ach-counts__badge"><img src=${rankIconUrl(rank?.rank?.icon || 'unranked')} alt="" /></span>
            <span class="ach-counts__row"><small>${t('排位积分')}</small><b class="num">${rank?.points ?? 0}</b></span>
            <span class="ach-counts__badge"><${Icon} name="chevrons" /></span><span class="ach-counts__row"><small>${t('最高回合')}</small><b class="num">${s.bestRound}</b></span></div>
        </div>
        <${ModeTable} modes=${s.modes} />
      </div><${TitleHex} titles=${s.titles} gd=${gd} />
    </section>
    <${SectionBar} title=${t('卫戍成就')} micro="ACHIEVEMENTS" />
    <${BestRecord} best=${s.best} gd=${gd} /><${Maxima} maxima=${s.maxima} />
    <${SectionBar} title=${t('盟约纪录')} micro="BONDS" /><${BondRecord} topBonds=${s.topBonds} gd=${gd} />
    <${SectionBar} title=${t('策略纪录')} micro="STRATEGIES" /><${BandRecord} topBands=${s.topBands} marked=${s.markedBands} gd=${gd} />
  </div>`;
}

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** Rows of 对局记录 shown at first and added by each 显示更多. */
export const HISTORY_PAGE = 50;

const statsStore = createStore({ open: false, tab: 'overview' });

/** Open the stats viewer (title screen / lobby / room entry points). */
export function openStats(tab = 'overview') {
  data.load('config');
  data.load('bands');
  data.load('assets');
  statsStore.set({ open: true, tab: ['overview', 'bands', 'totals', 'history'].includes(tab) ? tab : 'overview' });
}
export const closeStats = () => statsStore.set({ open: false });

const TABS = [
  { id: 'overview', name: N_('总览'), micro: 'OVERVIEW' },
  { id: 'bands', name: N_('策略'), micro: 'STRATEGIES' },
  { id: 'totals', name: N_('战斗累计'), micro: 'COMBAT TOTALS' },
  { id: 'history', name: N_('对局记录'), micro: 'HISTORY' },
];

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');
const dateTime = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** Time played: minutes up to 99, then hours with one decimal. */
function playedText(ms) {
  const mins = Math.round((ms || 0) / 60000);
  return mins < 100 ? t('{n} 分', { n: fmtNum(mins) }) : t('{n} 小时', { n: (mins / 60).toFixed(1) });
}
const difficultyName = (d) => (Object.hasOwn(DIFFICULTY_NAMES, d) ? t(DIFFICULTY_NAMES[d]) : t('未知'));

/** Save `text` as a download. Silent no-op when the browser refuses downloads. */
function downloadText(filename, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch { /* ignore */ }
}

/** Read a picked file as text (`File.text()`, with a FileReader fallback for older Safari). */
function readFileText(file) {
  if (typeof file?.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsText(file);
  });
}

/** `stronghold-stats-20261008-2130.json` */
function exportFilename(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `stronghold-stats-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/** One labelled number card. */
function StatCard({ label, micro, value, tone }) {
  return html`<div class=${cx('st-card', tone && `st-card--${tone}`)}>
    <${MicroLabel} tone=${tone === 'gold' ? 'gold' : 'mint'}>${micro}<//>
    <b class="st-card__num num">${value}</b>
    <span class="st-card__label">${label}</span>
  </div>`;
}

function Section({ title, micro, children, class: cls }) {
  return html`<section class=${cx('st-sec', cls)}>
    <h3 class="st-sec__h"><span>${title}</span><${MicroLabel}>${micro}<//></h3>
    ${children}
  </section>`;
}

/** 总览: cards, the per-difficulty table, the six titles, and the line about what counts. */
function Overview({ agg, gd }) {
  const rows = DIFFICULTIES.filter((d) => agg.byDifficulty[d]).concat(Object.keys(agg.byDifficulty).filter((d) => !DIFFICULTIES.includes(d)));
  const titles = (Array.isArray(gd.config?.titles) ? gd.config.titles : []).map((x) => ({ ...x, count: agg.titles[x.id]?.count || 0 }));
  return html`<${Section} title=${t('总览')} micro="OVERVIEW">
    <div class="st-cards">
      <${StatCard} micro="GAMES" value=${fmtNum(agg.count)} label=${t('总局数')} />
      <${StatCard} micro="WINS" value=${fmtNum(agg.wins)} label=${t('胜场')} tone="mint" />
      <${StatCard} micro="WIN RATE" value=${pct(agg.wins, agg.count)} label=${t('胜率')} tone="gold" />
      <${StatCard} micro="HIDDEN CORE" value=${fmtNum(agg.hidden.reached)} label=${t('到达隐秘核心')} />
      <${StatCard} micro="HIDDEN CLEAR" value=${fmtNum(agg.hidden.cleared)} label=${t('通关隐秘核心')} />
      <${StatCard} micro="BEST ROUND" value=${fmtNum(agg.rounds.max)} label=${t('最远回合')} />
      <${StatCard} micro="TIME PLAYED" value=${playedText(agg.duration.totalMs)} label=${t('累计时长')} />
    </div>
    <p class="st-split"><span>${t('单人')} <b class="num">${fmtNum(agg.byMode.solo)}</b></span><span>${t('同盟')} <b class="num">${fmtNum(agg.byMode.coop)}</b></span></p>
    ${rows.length ? html`<div class="st-tablewrap"><table class="st-table">
      <thead><tr><th>${t('难度')}</th><th class="num">${t('局数')}</th><th class="num">${t('胜场')}</th><th class="num">${t('胜率')}</th><th class="num">${t('隐秘核心通关')}</th></tr></thead>
      <tbody>
        ${rows.map((d) => {
          const v = agg.byDifficulty[d];
          return html`<tr key=${d}>
            <td class="st-diff" style=${`--d-color:${(Object.hasOwn(DIFFICULTY_COLORS, d) ? DIFFICULTY_COLORS[d] : null) || 'var(--text-lo)'}`}>${difficultyName(d)}</td>
            <td class="num">${fmtNum(v.games)}</td>
            <td class="num">${fmtNum(v.wins)}</td>
            <td class="num">${pct(v.wins, v.games)}</td>
            <td class="num">${fmtNum(v.hiddenCleared)}</td>
          </tr>`;
        })}
      </tbody>
    </table></div>` : null}
    ${titles.length ? html`<h4 class="st-sub">${t('称号')}</h4>
      <div class="st-titles">
        ${titles.map((x) => html`<div key=${x.id} class=${cx('st-title', !x.count && 'is-none')} title=${x.text || ''}>
          <${Img} src=${titleIconUrl(gd.m, x.picId)} class="st-title__icon" fallback=${html`<${Icon} name="crown" />`} />
          <div class="st-title__text"><span>${x.name}</span><b class="num">${fmtNum(x.count)}</b></div>
        </div>`)}
      </div>` : null}
    <p class="st-rule"><${Icon} name="info" />${t('计入统计：原版玩法中打到结算的对局，以及中途退出前至少清完 1 个回合的对局；更早退出及使用玩法插件的对局只留在对局记录里。')}${agg.excluded
      ? html` <b>${t('另有 {n} 局未计入统计', { n: agg.excluded })}</b>` : null}</p>
  <//>`;
}

/** 策略: per-band used / passed / pass rate, most used first (the user's headline ask). */
function Bands({ agg, gd }) {
  const rows = Object.entries(agg.bands).sort((a, b) => (b[1].games - a[1].games) || (b[1].wins - a[1].wins));
  return html`<${Section} title=${t('策略')} micro="STRATEGIES">
    ${rows.length ? html`<div class="st-tablewrap"><table class="st-table">
      <thead><tr><th>${t('策略')}</th><th class="num">${t('使用局数')}</th><th class="num">${t('通过局数')}</th><th class="num">${t('通过率')}</th></tr></thead>
      <tbody>
        ${rows.map(([bandId, v]) => {
          const band = gd.band(bandId);
          const rate = v.games > 0 ? Math.round((v.wins / v.games) * 100) : 0;
          return html`<tr key=${bandId}>
            <td><span class="st-band">${band ? html`<${BandIcon} bandId=${band.bandId} size="xs" />${band.name}` : bandId}</span></td>
            <td class="num">${fmtNum(v.games)}</td>
            <td class="num">${fmtNum(v.wins)}</td>
            <td class="num st-rate"><span class="st-bar" aria-hidden="true"><i style=${`width:${rate}%`}></i></span><b>${pct(v.wins, v.games)}</b></td>
          </tr>`;
        })}
      </tbody>
    </table></div>` : html`<p class="st-empty">${t('还没有记录 —— 完成一局对局后，这里会开始积累。')}</p>`}
  <//>`;
}

const SUM_ROWS = [
  ['kills', N_('击倒敌人')], ['bossDamage', N_('领袖伤害')], ['dmgDealt', N_('造成伤害')], ['activatedLayers', N_('盟约层数')],
  ['merges', N_('晋升次数')], ['itemsEquipped', N_('配发装备')], ['gold', N_('消耗资金')], ['perfectRounds', N_('完美作战')],
  ['refreshes', N_('刷新次数')], ['leaks', N_('未击倒')], ['lpLost', N_('损失生命')], ['assists', N_('成功协助')],
];

/** 战斗累计: the self player's sums over the settled matches. */
function CombatSums({ agg }) {
  const rows = SUM_ROWS.filter(([k]) => Number.isFinite(agg.sums[k]));
  return html`<${Section} title=${t('战斗累计')} micro="COMBAT TOTALS">
    ${rows.length ? html`<div class="st-sums">
      ${rows.map(([k, label]) => html`<div key=${k} class="st-sum"><span>${t(label)}</span><b class="num">${fmtNum(agg.sums[k])}</b></div>`)}
    </div>` : html`<p class="st-empty">${t('还没有记录 —— 完成一局对局后，这里会开始积累。')}</p>`}
  <//>`;
}

/** One 对局记录 row: what it was, who won, whether it counted and whether the settlement can be re-viewed. */
function HistoryRow({ rec, gd, onOpen }) {
  const self = selfRowOf(rec);
  const quit = rec.end === 'quit';
  const counted = countsTowardStats(rec);
  const won = self ? !!self.victory : !!rec.victory;
  const band = self?.bandId ? gd.band(self.bandId) : null;
  const rounds = roundsOf(rec);
  const known = Number.isFinite(self?.roundsPassed) || Number.isFinite(rec.roundsPassed);
  const view = !quit && !rec.compact; // a quit has nothing settled; a compacted record no rows left
  const open = () => onOpen(rec);
  return html`<tr class=${cx(quit ? 'is-quit' : won ? 'is-win' : 'is-lose', !counted && 'is-excluded', view && 'is-clickable')}
      title=${view ? t('点击查看该局结算') : rec.unofficial ? t('非官方玩法插件对局，不计入统计总览') : !counted ? t('没有清完第一个回合就退出，不计入统计') : quit ? t('中途退出的对局没有结算可看') : t('较早的对局只保留汇总，不能回看结算')}
      tabIndex=${view ? 0 : undefined}
      onClick=${view ? open : undefined} onKeyDown=${view ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } : undefined}>
    <td class="st-t">${dateTime(rec.t)}</td>
    <td>${difficultyName(rec.difficulty)}</td>
    <td>${rec.variant === 'entertainment_endless' ? t('娱乐 · 无尽模式 · 不计排位') : rec.variant === 'entertainment_multi' ? t('娱乐 · 多人同盟 · 不计排位') : rec.roomMode === 'solo' ? t('单人') : rec.roomMode === 'coop' ? t('同盟') : '—'}</td>
    <td><span class="st-band">${band ? html`<${BandIcon} bandId=${band.bandId} size="xs" />${band.name}` : self?.bandId || '—'}</span></td>
    <td class="st-res">${quit ? html`<span class="t-quit">${t('中途退出')}</span>` : html`<span class=${won ? 't-win' : 't-lose'}>${won ? t('胜') : t('负')}</span>`}
      ${rec.unofficial ? html`<em class="st-chip" data-testid="history-unofficial">${t('非官方')}</em>` : null}
      ${!counted ? html`<em class="st-chip">${t('不计入统计')}</em>` : null}</td>
    <td class="num">${known ? fmtNum(rounds) : '—'}</td>
    <td class="st-go" aria-hidden="true">${view ? html`<${Icon} name="chevronRight" />` : null}</td>
  </tr>`;
}

/** 对局记录: every stored match, newest first, HISTORY_PAGE rows at a time. */
function History({ records, gd, onOpen }) {
  const [shown, setShown] = useState(HISTORY_PAGE);
  const rows = records.slice(0, shown);
  return html`<${Section} title=${t('对局记录')} micro=${`HISTORY · ${records.length}`}>
    ${rows.length ? html`<div class="st-tablewrap"><table class="st-table st-table--history">
      <thead><tr><th>${t('时间')}</th><th>${t('难度')}</th><th>${t('模式')}</th><th>${t('策略')}</th><th>${t('结果')}</th><th class="num">${t('回合')}</th><th aria-hidden="true"></th></tr></thead>
      <tbody>${rows.map((r) => html`<${HistoryRow} key=${r.id} rec=${r} gd=${gd} onOpen=${onOpen} />`)}</tbody>
    </table></div>
    ${records.length > shown ? html`<div class="st-more"><${Button} size="sm" variant="secondary" onClick=${() => setShown(shown + HISTORY_PAGE)}>${t('显示更多（还有 {n} 局）', { n: records.length - shown })}<//></div>` : null}
    <p class="st-hint">${t('点击一行，回看该局结算；中途退出的对局只留记录。')} ${t('最多保留最近 {max} 局，优先保留最新 {full} 局的完整结算；存储空间不足时可能减少。', { max: MAX_RECORDS, full: FULL_KEEP })}</p>`
      : html`<p class="st-empty">${t('还没有记录 —— 完成一局对局后，这里会开始积累。')}</p>`}
  <//>`;
}

/** A stored match re-viewed as its settlement screen: the full game data is loaded now (the lobby alone never loads it). */
function Replay({ rec, onBack }) {
  const gd = useGameData();
  const res = useMemo(() => recordToResult(rec), [rec]);
  if (!gd.ready) return html`<div class="st-loading"><${Spinner} size="md" /></div>`;
  return html`<${ResultView} result=${res} pub=${null} myId=${rec.selfId} backLabel=${t('返回本机统计')} onBack=${onBack} showSettlement=${false} />`;
}

/** The overlay, rendered while open (its data hooks run only then). */
function StatsScreen({ tab }) {
  const ready = useData('config', 'bands', 'assets', 'chess', 'bonds', 'items', 'backups', 'skins');
  const gd = useMemo(() => makeLookups(ready), [ready, data.locale()]);
  const [stats, setStats] = useState(() => loadStats());
  const [replay, setReplay] = useState(null);
  const me = useStore(s => s.me);
  const rank = useStore(s => s.rank);
  useStore(s => s.entries, Object.is, skinsStore);
  useStore(s => s.portraits, Object.is, skinsStore);
  const cardList = useMemo(() => cardOperators(data.list('chess'), data.get('backups')), [ready, data.get('chess'), data.get('backups')]);
  const myCard = useStore((s) => s.card, Object.is, skinsStore);
  const avatarSrc = seatAvatar({ playerId: me.playerId, card: myCard }, {
    pool: cardList,
    byChar: new Map(cardList.map(c => [c.charId, c])), m: gd.m, myId: me.playerId, myCard,
  });
  const [leaving, leave] = useLeave(closeStats, 180);
  const boxRef = useRef(null);
  const fileRef = useRef(null);
  const replayRef = useRef(null);
  replayRef.current = replay;
  const inMatch = useStore((s) => selectRoute(s) === 'game');
  useDocClass('sp-stats-open');

  // a match starting (the host pressed 开始) takes the player to its briefing: the overlay must not sit on top of it
  useEffect(() => { if (inMatch) closeStats(); }, [inMatch]);
  useEffect(() => {
    const previous = document.activeElement;
    const onKey = (e) => {
      if (!isTopOverlay(boxRef.current)) return;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        if (replayRef.current) setReplay(null); else leave();
      } else if (e.key === 'Tab') {
        const buttons = [...boxRef.current.querySelectorAll('button, input, [href], [tabindex]')].filter(el => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length);
        const first = buttons[0] || boxRef.current, last = buttons.at(-1) || first;
        if (!buttons.includes(document.activeElement) || document.activeElement === (e.shiftKey ? first : last)) {
          e.preventDefault(); (e.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    const timer = setTimeout(() => boxRef.current?.focus?.(), 30);
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(timer); if (previous?.isConnected) previous.focus?.(); };
  }, []);

  const agg = useMemo(() => aggregateStats(stats.newer ? [] : stats.records), [stats]);
  const reload = () => setStats(loadStats());

  const doExport = () => {
    try {
      const payload = exportStats(stats);
      downloadText(exportFilename(), JSON.stringify(payload));
      toast(t('已导出 {n} 条对局记录', { n: payload.records.length }), 'success');
    } catch (err) {
      toastError(err);
    }
  };
  const doFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = ''; // allow re-picking the same file
    if (!file) return;
    if (file.size > IMPORT_MAX_CHARS) { toast(t('文件过大，无法导入'), 'error'); return; }
    try {
      const raw = JSON.parse(await readFileText(file));
      const { stats: merged, added, skipped, dropped } = importStats(raw, loadStats());
      if (added && !saveStats(merged)) { toast(t('无法写入本机存储，可能已满'), 'error'); return; }
      reload();
      const tail = (skipped ? t('（跳过重复 {skipped} 条）', { skipped }) : '') + (dropped ? t('（{n} 条无法读取）', { n: dropped }) : '');
      toast(added ? t('已导入 {added} 条记录{tail}', { added, tail }) : t('没有新记录（全部与现有数据重复）'), 'success');
    } catch (err) {
      toast(err?.code === 'stats-newer-version' ? t('导入失败：这份文件由更新版本的客户端导出，请先升级客户端') : t('导入失败：不是有效的统计导出文件'), 'error');
    }
  };
  const doClear = async () => {
    const ok = await confirmDialog({
      utility: true,
      title: t('清空统计数据'), micro: 'CLEAR STATISTICS', danger: true, okText: t('清空'),
      text: t('将删除本机保存的 {n} 条对局记录，无法恢复。', { n: stats.records.length }),
    });
    if (!ok) return;
    if (!saveStats(emptyStats())) {
      reload();
      toast(t('无法写入本机存储，可能已满或数据版本更新'), 'error');
      return;
    }
    reload();
    toast(t('已清空本机统计数据'), 'success');
  };

  if (replay) return html`<div class=${`st st--replay${leaving ? ' is-leaving' : ''}`} ref=${boxRef} tabindex="-1" role="dialog" aria-modal="true" aria-label=${t('统计数据')}>
    <${Replay} rec=${replay} onBack=${() => setReplay(null)} />
  </div>`;

  const tabInfo = TABS.find((x) => x.id === tab) || TABS[0];
  const empty = !stats.records.length;
  return html`<div class=${`st east-stats${leaving ? ' is-leaving' : ''}`} role="dialog" aria-modal="true" aria-label=${t('统计数据')} tabindex="-1" ref=${boxRef}>
    <div class="st__bg" aria-hidden="true"></div>
    <header class="ach__head east-stats__banner"><span class="ach__logo"><svg viewBox="0 0 40 30" aria-hidden="true"><path d="M8 4h10v8H8zM22 4h10v8H22zM8 18h10v8H8zM22 18h10v8H22z" fill="none" stroke="currentColor" stroke-width="2.4" /><path d="M2 2v26M38 2v26" stroke="currentColor" stroke-width="2" /></svg><b>STRONGHOLD<br />PROTOCOL</b></span>
      <span class="ach__band"><svg class="ach__dunes" viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden="true"><path class="is-far" d="M0 24c28-7 58-13 92-9s56 11 90 4 64-14 118-7V40H0z" /><path d="M0 34c34-9 60-12 96-6s52 9 86 3 70-11 118-5V40H0z" /></svg><span class="ach__titles"><i aria-hidden="true">ALLIANCE</i><b>${t('卫戍协议：盟约')}</b></span></span></header>
    <header class="st-top">
      <div class="st-top__left">
        <${Button} variant="ghost" size="md" icon="chevronLeft" class="st-back" onClick=${leave} aria-label=${t('返回')} title=${t('返回 (Esc)')}>${t('返回')}<//>
      </div>
      <div class="st-top__center">
        <${MicroLabel} tone="mint">STATISTICS // ${tabInfo.micro}<//>
        <div class="st-tabs" role="tablist" aria-label=${t('统计数据')}>
          ${TABS.map((x) => html`<button key=${x.id} type="button" role="tab" aria-selected=${x.id === tab ? 'true' : 'false'} data-tab=${x.id}
            class=${cx('st-tab', x.id === tab && 'is-on')} onClick=${() => statsStore.set({ tab: x.id })}>${t(x.name)}</button>`)}
        </div>
      </div>
      <div class="st-top__right">
        <${Button} variant="ghost" size="sm" data-testid="stats-export" disabled=${empty || stats.newer} onClick=${doExport} title=${t('导出为文件（可在别的设备上导入）')}>${t('导出')}<//>
        <${Button} variant="ghost" size="sm" data-testid="stats-import" disabled=${stats.newer} onClick=${() => fileRef.current?.click()} title=${t('从导出的文件导入（与现有记录合并）')}>${t('导入')}<//>
        <input ref=${fileRef} type="file" accept="application/json,.json" hidden onChange=${doFile} />
        <${Button} variant="secondary" size="sm" data-testid="stats-clear" disabled=${empty || stats.newer} onClick=${doClear} title=${t('清空本机的统计数据')}>${t('清空')}<//>
      </div>
    </header>
    <p class="st-note"><${Icon} name="info" />${t('本机数据：只保存在这个浏览器里，不会上传到服务器；同盟对局里队友的代号也会存在本机（导出文件里也有）。')}</p>
    ${stats.damaged ? html`<p class="st-note is-warn"><${Icon} name="warn" />${t('本机保存的统计数据无法读取，已另存为备份，从现在起重新记录。')}</p>` : null}
    ${stats.dropped ? html`<p class="st-note is-warn"><${Icon} name="warn" />${t('有 {n} 条记录已损坏，已忽略。', { n: stats.dropped })}</p>` : null}
    <main key=${tab} class="st-body" data-tab=${tab}>
      ${!ready ? html`<div class="st-loading"><${Spinner} size="md" /></div>`
        : stats.newer ? html`<p class="st-empty">${t('检测到更新版本的统计数据，请先升级客户端再查看，以免覆盖数据。')}</p>`
          : empty && tab !== 'overview' ? html`<p class="st-empty">${t('还没有记录 —— 完成一局对局后，这里会开始积累。')}</p>`
            : tab === 'bands' ? html`<${Bands} agg=${agg} gd=${gd} />`
              : tab === 'totals' ? html`<div><${CombatSums} agg=${agg} /><${Overview} agg=${agg} gd=${gd} /></div>`
                : tab === 'history' ? html`<${History} records=${stats.records} gd=${gd} onOpen=${setReplay} />`
                  : html`<${AchievementOverview} records=${stats.records} gd=${gd} me=${me} rank=${rank} avatarSrc=${avatarSrc} />`}
      <${UiPluginSlot} slot="stats.tab" class="east-plugin-stats" />
    </main>
  </div>`;
}

/** Global stats viewer host — mounted once by main.js; renders nothing (and loads nothing) until opened. */
export function StatsHost() {
  const { open, tab } = useStore((s) => s, Object.is, statsStore);
  if (!open) return null;
  return html`<${Overlay} level="stats"><${StatsScreen} tab=${tab} /><//>`;
}

