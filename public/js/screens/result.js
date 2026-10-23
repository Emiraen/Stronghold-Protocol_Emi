import { t as trA, N_, getLang } from '../../../shared/i18n.js';
import { t } from '../../../shared/i18n.js';
import { cardStandIn, cardDiy, standInForText, diyRecordFor } from '../ui/gameLogic.js';
// Result screen (research 06 §10.6): victory / defeat hero with rounds passed, boss medallions, and a
// card per player — band, final lineup avatars with elite marks, stats, title (评语) with its icon —
// plus 返回同盟.
//
// Expected m.result (free-form in DESIGN §8.2; fields read tolerantly, see gameLogic.normalizeResult):
//   { victory, roundsPassed, lastRound?, hiddenCleared?, bossId?, hiddenBossId?, difficulty?, modeId?, durationMs?,
//     players: [{ playerId, seat, name, isBot, alive, lp, bandId, roundsPassed?,
//                 title: 'comment_1' | { id, name? } | null,
//                 lineup: [{ id /* chessId, golden id if elite */, golden?, tier?, items?: [itemId] }],
//                 bonds?: [{ bondId, layers, active }],
//                 stats: { dmgDealt, kills, leaks, gold /* funds SPENT */, refreshes, merges, bossDamage?, itemsEquipped?,
//                          activatedLayers?, lpLost?, perfectRounds? } }] }

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, DifficultyTag } from '../ui/components.js';
import { useGameData, Img, UnitThumb, BandIcon, PlayerAvatar, BondGlyph, LpTower, Sprite } from '../ui/gameComponents.js';
import { normalizeResult, fmtNum } from '../ui/gameLogic.js';
import { rankIconUrl, rankOf, normalizeRankLabel } from '../../../shared/ranks.js';
import { enemyIconUrl, titleIconUrl, uiUrl } from '../ui/assetUrls.js';
import { store, useStore, emptyMatch } from '../store.js';
import { audio } from '../audio.js';
import { data } from '../data.js';
import { useResourceUrl } from '../ui/cachedImage.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

// The first seven present are shown (+ remaining LP = a 4×2 grid); the title (评语) stats come first.
// `gold` is the funds a player SPENT (server/match/PlayerState.js spend(); the 挥金如土 title stat).
const STAT_ROWS = [
  ['dmgDealt', N_("造成伤害")], ['kills', N_("击倒敌人")], ['bossDamage', N_("领袖伤害")], ['activatedLayers', N_("盟约层数")],
  ['merges', N_("晋升次数")], ['itemsEquipped', N_("配发装备")], ['gold', N_("消耗资金")], ['perfectRounds', N_("完美作战")],
  ['refreshes', N_("刷新次数")], ['leaks', N_("未击倒")], ['lpLost', N_("损失生命")], ['assists', N_("成功协助")],
];

// 服务端段位串保留积分与排名，只转换客户端英文展示。
export function rankLabel(label) {
  label = normalizeRankLabel(label);
  if (getLang() !== 'en') return label;
  return String(label || '').replace(/^未定级/, trA('未定级')).replace(
    /^(黑铁|青铜|白银|黄金|白金|钻石|超凡|神话|源能战魂)([一二三])?(?: (\d+)分)?/,
    (_, division, tier, points) => `${trA(division)}${tier ? ` ${['I', 'II', 'III']['一二三'.indexOf(tier)]}` : ''}${points != null ? ` ${points} ${trA('分')}` : ''}`
  );
}

/** Actual settled points, including placement and bonuses; tolerate earlier score snapshots. */
export function settledRankDelta(rank) {
  if (!rank || typeof rank !== 'object') return 0;
  if (Number.isFinite(rank.totalDelta)) return rank.totalDelta;
  const score = value => Number.isFinite(value) ? value : Number.isFinite(value?.score) ? value.score : null;
  const before = score(rank.before), after = score(rank.after);
  if ((before !== null || rank.before === null) && (after !== null || rank.after === null)) return (after ?? 0) - (before ?? 0);
  return (Number.isFinite(rank.delta) ? rank.delta : 0) + (Number.isFinite(rank.bonus) ? rank.bonus : 0);
}

/** 排位段位行（m.result players[].rank；普通模式无此字段）。
 *  tierAfter 由服务端拼好：含小段小分，未定级为「未定级 (x/y)」，神话以上尾部带「#N」。 */
export function RankRow({ rank }) {
  if (!rank || typeof rank !== 'object') return null;
  const placement = !rank.placementDone;
  const delta = settledRankDelta(rank);
  const tone = delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : '';
  return html`<div class="rrank${placement ? ' is-placement' : ''}">
    <img class="rrank__icon" src=${rankIconUrl(rank.iconAfter || 'unranked')} alt=${rankLabel(rank.tierAfter) || ''} loading="lazy" />
    <span class="rrank__text">
      <b class="rrank__tier">${rankLabel(rank.tierAfter) || trA("未定级")}</b>
    </span>
    ${placement
      ? html`<span class="rrank__place num">${trA("定级赛")} ${Math.max(0, rank.placementPlayed || 0)}/${rank.placementMatches || 3}</span>`
      : html`<span class=${`rrank__delta num ${tone}`}>${delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : '±0'}</span>`}
    ${!placement ? html`<span class="rrank__pts num">${rank.after ?? 0} ${trA("分")}</span>` : null}
  </div>`;
}

/** 小段进度条区间（rankOf 的镜像几何；源能战魂无上限 ⇒ null 不画条）。 */
function tierBar(points) {
  const p = Math.max(0, Math.floor(points));
  if (p >= 2550) return null; // 源能战魂：只有全服排名，无进度条
  if (p >= 2100) { // 神话一/二各 100 分宽，神话三 2300–2549 共 250 分宽
    const from = p < 2200 ? 2100 : p < 2300 ? 2200 : 2300;
    const to = p < 2200 ? 2200 : p < 2300 ? 2300 : 2550;
    return { sub: p - from, max: to - from };
  }
  const from = Math.floor(p / 100) * 100; // 普通段位每小段 100 分（边界都是整百）
  return { sub: p - from, max: 100 };
}

/**
 * 段位结算动画（排位赛结算后、自己的卡片上方全屏遮罩）：
 * 分数从 before 走到 after（easeOutCubic，时长按分差自适应 1.4–3.2s），进度条按当前小段推进；
 * 走条过程中图标/段位名静默刷新（不重播弹入动画，避免跨段连闪），走完定格时弹跳一次；
 * 结束后展示加减分徽章，须点击确认按钮关闭。定级赛进行中：未定级图标 + x/y 进度点；
 * 定级完成的那场：从 0 走到落段分（定级揭晓），同样须确认。尊重系统减弱动效设置。
 */
export function RankSettlement({ rank, onClose }) {
  const done = !!rank.placementDone;
  const from = Number.isFinite(rank.before) ? rank.before : 0;
  const to = done && Number.isFinite(rank.after) ? rank.after : 0;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const walk = done && to !== from && !reduce; // 有分数变化才走条
  const [t, setT] = useState(walk ? 0 : 1);
  const rafRef = useRef(0);
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!walk) return undefined;
    const t0 = performance.now();
    const DUR = Math.max(1400, Math.min(3200, 800 + Math.abs(to - from) * 1.2)); // 分差越大走越久
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / DUR);
      setT(1 - Math.pow(1 - k, 3)); // easeOutCubic
      if (k < 1) rafRef.current = requestAnimationFrame(tick);
      else rafRef.current = 0;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const finished = t >= 1;
  useEffect(() => { if (finished) confirmRef.current?.focus(); }, [finished]);

  const cur = Math.round(from + (to - from) * t);
  const view = rankOf(cur, rank.globalRank);
  const globalNo = view.globalRanked && Number.isFinite(rank.globalRank) && rank.globalRank > 0 ? rank.globalRank : null;
  const bar = done ? tierBar(cur) : null;
  const delta = settledRankDelta(rank);
  const tone = delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : '';
  const isPlaceFinal = done && rank.kind === 'placement'; // 这一场完成定级
  const fill = bar ? Math.max(0, Math.min(1, bar.sub / bar.max)) : 0;
  const tierLabel = rankLabel(view.label);
  const longTier = tierLabel.length > 9; // 超凡三 99分 / 神话三 449分 等长名缩小字号防溢出

  return html`<div class="rsettle" role="dialog" aria-modal="true" aria-label=${trA("段位结算")}>
    <div class="rsettle__backdrop"></div>
    <div class="rsettle__card">
      <div class="rsettle__head"><${MicroLabel} tone="gold">RANKED RESULT</${MicroLabel}><b>${done ? trA("段位结算") : trA("定级赛")}</b></div>
      <div class="rsettle__content">
      ${done
        ? html`<img key=${finished ? `f:${view.icon}` : 'walk'} class=${cx('rsettle__icon', !finished && 'is-walk')} src=${rankIconUrl(view.icon)} alt=${trA(view.divisionName)} />
          <b class=${cx('rsettle__tier', longTier && 'is-long')}>${tierLabel}</b>
          ${globalNo != null ? html`<span class="rsettle__global num">#${globalNo} ${trA("全服排名")}</span>` : null}
          ${bar ? html`<div class="rsettle__barwrap">
            <div class="rsettle__bar"><i class=${cx('rsettle__fill', delta < 0 && 'is-down')} style=${`transform:scaleX(${fill})`}></i><span class="rsettle__cursor-track" style=${`transform:translateX(${fill * 100}%)`}><i class="rsettle__cursor"></i></span></div>
            <span class="rsettle__sub num">${bar.sub} / ${bar.max}</span>
          </div>` : html`<span class="rsettle__sub rsettle__sub--plain num">${cur} ${trA("分")}</span>`}
          ${finished && !isPlaceFinal ? html`<div class=${`rsettle__delta num ${tone}`}>${delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : '±0'}</div>` : null}
          ${bar ? html`<span class="rsettle__total num">${cur} ${trA("分")}</span>` : null}
          ${finished && isPlaceFinal ? html`<div class="rsettle__delta num is-place">${trA("定级完成")}</div>` : null}`
        : html`<img class="rsettle__icon" src=${rankIconUrl('unranked')} alt=${trA("未定级")} />
          <b class="rsettle__tier">${trA("未定级")}</b>
          <div class="rsettle__dots">${Array.from({ length: Math.max(1, rank.placementMatches || 3) }, (_, i) =>
            html`<i key=${i} class=${i < (rank.placementPlayed || 0) ? 'is-on' : ''}></i>`)}</div>
          <span class="rsettle__sub rsettle__sub--plain num">${trA("定级赛")} ${rank.placementPlayed || 0} / ${rank.placementMatches || 3}</span>`}
      </div>
      <button type="button" class="rsettle__confirm" ref=${confirmRef} disabled=${!finished} onClick=${onClose}>${finished ? trA("确认") : trA("结算中…")}</button>
    </div>
  </div>`;
}

export function detailResultBonds(bonds, bondRec = () => null) {
  const activeCore = (b) => Number(!!b.active && !!bondRec(b.bondId)?.isCore);
  return (Array.isArray(bonds) ? bonds : [])
    .filter((b) => b && (b.active || b.layers > 0))
    .sort((a, b) => activeCore(b) - activeCore(a) || (b.layers || 0) - (a.layers || 0));
}

/** Preserve explicit unavailable fields instead of the legacy normalizer's defaults. */
export function reportResult(result, pub = null) {
  const r = normalizeResult(result, pub);
  const rawRows = new Map((Array.isArray(result?.players) ? result.players : []).map(p => [p?.playerId, p]));
  r.settlementPending = result?.settlementPending === true;
  r.incomplete = !!(result?.incomplete || result?.settlementErrors?.length);
  for (const p of r.players) {
    // Battle statistics are ready before the durable economic receipt. Do not
    // present provisional rewards/rating as credited, or discard healthy stats.
    if (r.settlementPending) { p.reward = null; p.trophies = null; p.rank = null; }
    const raw = rawRows.get(p.playerId);
    if (!raw?.settlementError && raw?.stats !== null) continue;
    r.incomplete = true;
    p.settlementError = raw.settlementError || { code: 'RESULT_STATS_UNAVAILABLE' };
    p.stats = {}; p.roundsPassed = null; p.lp = null;
    p.reward = null; p.trophies = null; p.rank = null;
  }
  return r;
}

function PlayerCard({ p, myId, titles, best, solo = false }) {
  const gd = useGameData();
  const titleRec = p.title ? titles.find((t) => t.id === p.title.id) || null : null;
  const titleName = p.title?.name || titleRec?.name || null;
  const stats = STAT_ROWS.filter(([k]) => Number.isFinite(p.stats[k])).slice(0, 7);
  const band = p.bandId ? gd.band(p.bandId) : null;
  const lineup = p.lineup.slice(0, 10);
  const bonds = detailResultBonds(p.bonds, (id) => gd.bond(id));
  return html`<article class=${cx('rcard', p.playerId === myId && 'is-self', p.alive === false && 'is-dead')}>
    <header class="rcard__head">
      <${PlayerAvatar} player=${p} self=${p.playerId === myId} />
      <div class="rcard__who">
        <b class="rcard__name">${p.name}${p.isBot ? html`<span class="rcard__ai">AI</span>` : null}${p.playerId === myId ? html`<span class="rcard__you">${trA("你")}</span>` : null}</b>
        <span class="rcard__band">${band ? html`<${BandIcon} bandId=${band.bandId} size="xs" />${band.name}` : '—'}</span>
      </div>
      <div class="rcard__mid">
        <div class="rcard__lineup">
          ${lineup.length ? lineup.map((u, i) => html`<${LineupThumb} u=${u} key=${i} kind=${u.kind === 'token' ? 'token' : 'chess'} id=${u.id} skin=${u.skin ?? null} rec=${cardDiy(data.lookup('chess', u.id), { unit: u, data: { chess: data.get('chess'), backups: data.get('backups') } }) || cardStandIn(data.lookup('chess', u.id), { unit: u, backups: data.get('backups') })} golden=${!!u.golden} tier=${u.tier} size="sm" />`)
            : html`<span class="rcard__noinfo">${p.alive === false ? trA("阵容已撤离") : 'NO INFO'}</span>`}
        </div>
        ${bonds.length ? html`<div class="rcard__bonds">${bonds.map((b) => html`<span key=${b.bondId} class=${cx('rbond', b.active && 'is-on')} title=${gd.bond(b.bondId)?.name || b.bondId}>
          <${BondGlyph} bondId=${b.bondId} /><b class="num">${b.layers ?? 0}</b></span>`)}</div>` : null}
      </div>
      <div class="rcard__round"><${MicroLabel}>${p.settlementError ? trA('结算未完成') : 'ROUNDS'}</${MicroLabel}><b class="num">${p.settlementError ? '—' : p.roundsPassed}</b>
        ${p.reward > 0 ? html`<span class="rcard__gain"><span title=${trA("卫戍认证")}><${Icon} name="shield" /><b class="num">+${p.reward}</b></span></span>` : null}
      </div>
      ${p.rank ? html`<${RankRow} rank=${p.rank} />` : null}
      ${titleName ? html`<div class="rcard__title" title=${titleRec?.text || p.title?.text || ''}>
        <${Img} src=${titleIconUrl(gd.m, titleRec?.picId || p.title?.picId || String(p.title.id || '').replace('comment_', 'comment_icon_'))} class="rcard__ticon" fallback=${html`<${Icon} name="crown" />`} />
        <span><${MicroLabel} tone="gold">${trA("评语")}</${MicroLabel}><b>${titleName}</b></span>
      </div>` : html`<span class="rcard__title rcard__title--none" aria-hidden="true"></span>`}
    </header>
    <div class="rcard__stats">
      ${p.settlementError ? html`<p class="t-dim" role="status">${trA('结算未完成')} · ${trA('发生错误！请复制诊断信息并联系服主')}</p>` : null}
      ${stats.map(([k, label]) => html`<div key=${k} class=${cx('rstat', best[k] === p.playerId && 'is-best')}><span>${trA(label)}</span><b class="num">${fmtNum(p.stats[k])}</b></div>`)}
      ${Number.isFinite(p.lp) ? html`<div class="rstat" title=${p.lpShared && !solo ? trA("最终攻势起全队共享目标生命值") : ''}><span>${p.lpShared && !solo ? trA("同盟剩余生命") : trA("剩余生命")}</span><${LpTower} value=${p.lp} size="sm" /></div>` : null}
    </div>
  </article>`;
}

/** RESULT screen: only live matches play a sound and clear match state on return. */
export function ResultScreen() {
  const res = useStore((s) => s.match.result);
  const pub = useStore((s) => s.match.public);
  const myId = useStore((s) => s.me.playerId);
  const hasRoom = useStore((s) => !!s.room);
  useEffect(() => { audio.sfx(res?.victory ? 'settlementSucceed' : 'settlementFail'); }, []);
  return html`<${ResultView} result=${res} pub=${pub} myId=${myId}
    onBack=${() => store.set({ match: emptyMatch() })} backLabel=${hasRoom ? trA("返回同盟") : trA("返回大厅")} showSettlement=${true} />`;
}

/** Shared live/historical report. History passes its own callback; never touches match state or audio. */
export function ResultView({ result, pub = null, myId, onBack, backLabel = '返回大厅', showSettlement = false }) {
  const gd = useGameData();
  const r = useMemo(() => reportResult(result, pub), [result, pub]);
  const titles = Array.isArray(gd.config?.titles) ? gd.config.titles : [];
  const best = {};
  for (const [k] of STAT_ROWS) {
    let top = null;
    for (const p of r.players) if (Number.isFinite(p.stats[k]) && p.stats[k] > 0 && (top == null || p.stats[k] > top.v)) top = { v: p.stats[k], id: p.playerId };
    if (top && r.players.length > 1) best[k] = top.id;
  }
  // Historical reports keep the static rank row, but never replay the rank settlement overlay.
  const meRow = r.players.find((p) => p.playerId === myId);
  const myRank = !r.incomplete && !r.settlementPending && showSettlement && meRow && meRow.rank && typeof meRow.rank === 'object' ? meRow.rank : null;
  const [settleOpen, setSettleOpen] = useState(!!myRank);
  const boss = r.bossId ? gd.boss(r.bossId) : null;
  // the Hidden Core medal (and its corrupted leader) only once R15 was actually fought
  const hidden = r.hiddenBossId && r.hiddenReached ? gd.boss(r.hiddenBossId) : null;
  const bg = useResourceUrl(uiUrl(gd.m, r.victory ? 'settle/settlemen_teamshow_success' : 'settle/settlemen_teamshow_fail'));
  const mins = r.durationMs ? Math.round(r.durationMs / 60000) : null;

  if (!gd.ready) return html`<div class="screen result"><div class="result__loading">${trA("正在加载对局素材…")}</div></div>`;
  return html`<div class=${cx('screen', 'result', ['entertainment_multi', 'entertainment_endless'].includes(result?.variant || pub?.variant) && 'result--multi', r.victory ? 'is-win' : 'is-lose')}>
    <div class="result__bg" aria-hidden="true" style=${bg ? `--result-bg:url("${bg}")` : undefined}></div>
    <div class="result__grid" aria-hidden="true"></div>
    <main class="result__main" inert=${settleOpen && !!myRank ? true : undefined}>
      <section class="result__hero">
        <div class="result__summary">
        <div class="result__logo"><${Sprite} k="entry/season_logo_settle" class="result__logoimg" fallback=${html`<${MicroLabel} tone="mint">STRONGHOLD PROTOCOL</${MicroLabel}>`} /></div>
        ${r.difficulty ? html`<${DifficultyTag} difficulty=${r.difficulty} size="lg" />` : null}
        ${result?.unofficial === true || pub?.unofficial === true ? html`<span class="modmark" data-testid="result-unofficial" title=${trA('非官方玩法插件对局，不计入统计总览')}>${trA('非官方')}</span>` : null}
        ${(result?.variant || pub?.variant) === 'entertainment_endless' ? html`<p class="t-mint">娱乐 · 无尽模式 · 不计排位</p>` : (result?.variant || pub?.variant) === 'entertainment_multi' ? html`<p class="t-mint">娱乐 · 多人同盟 · 不计排位</p>` : null}
        <h1 class="result__headline">${r.incomplete ? trA('结算未完成') : r.settlementPending ? trA('结算处理中') : r.victory ? trA("模拟完成") : trA("模拟失败")}</h1>
        <p class="result__sub" role=${r.incomplete || r.settlementPending ? 'status' : undefined}>${r.incomplete ? trA('发生错误！请复制诊断信息并联系服主') : r.settlementPending ? trA('对局统计已就绪，积分与奖励结算处理中，可先返回。') : r.victory ? trA("成功卫戍 · 敌方领袖已被击败") : trA("防线已被突破")}</p>
        <div class="result__rounds">
          <span class="result__rlabel">${trA("通过回合")}</span>
          <b class="result__rnum num">${r.roundsPassed}</b>
          ${r.roundsPassed <= r.lastRound ? html`<span class="result__rof num">/${r.lastRound}</span>` : null}
        </div>
        <div class="result__medals">
          ${boss ? html`<div class=${cx('medal', r.victory && 'is-done')} title=${boss.name}>
            <${Img} src=${enemyIconUrl(gd.m, boss.enemyKey)} /><span class="medal__check">${r.victory ? html`<${Icon} name="check" />` : html`<${Icon} name="close" />`}</span>
            <span class="medal__label">${trA("敌方领袖")}</span></div>` : null}
          ${hidden ? html`<div class=${cx('medal', 'medal--hidden', r.hiddenCleared && 'is-done')} title=${hidden.name}>
            <${Img} src=${enemyIconUrl(gd.m, hidden.enemyKey)} /><span class="medal__check">${r.hiddenCleared ? html`<${Icon} name="check" />` : html`<${Icon} name="close" />`}</span>
            <span class="medal__label">${trA("隐秘核心")}</span></div>` : null}
        </div>
        ${mins ? html`<p class="result__time t-lo">${trA("本局耗时")} <b class="num">${mins}</b> ${trA("分钟")}</p>` : null}
        </div>
        <footer class="result__foot">
          <${Button} variant="primary" size="xl" icon="chevronLeft" onClick=${onBack}>${backLabel}<//>
        </footer>
      </section>
      <section class="result__players">
        <h2 class="brief-h"><span>${trA("同盟成员")}</span><${MicroLabel}>ALLIANCE REPORT</${MicroLabel}></h2>
        ${r.players.length ? r.players.map((p) => html`<${PlayerCard} key=${p.playerId} p=${p} myId=${myId} titles=${titles} best=${best} solo=${r.players.length < 2} />`)
          : html`<p class="t-dim">${trA("暂无结算数据")}</p>`}
      </section>
    </main>
    ${settleOpen && myRank ? html`<${RankSettlement} rank=${myRank} onClose=${() => setSettleOpen(false)} />` : null}
  </div>`;
}


export function LineupThumb({ u, gd = { chess: id => data.lookup('chess', id), backups: data.get('backups') } }) {
  const chess = u.kind === 'token' ? null : gd.chess(u.id);
  const dr = u.diy && chess ? diyRecordFor(chess, u.diy, { chess: data.get('chess'), backups: data.get('backups') }) : null;
  const si = !dr && chess ? cardStandIn(chess, { unit: u, backups: gd.backups }) : null;
  return html`<${UnitThumb} kind=${u.kind === 'token' ? 'token' : 'chess'} id=${u.id} golden=${!!u.golden} tier=${u.tier} size="sm" skin=${u.skin ?? null} rec=${dr || si}
    title=${si ? t('{name}（{note}）', { name: si.name, note: standInForText(chess.name) }) : undefined} />`;
}
