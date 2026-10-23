import { t as trA } from '../../../shared/i18n.js';
// Left team panel (research 06 §11.1, research 09 §3.1): one row per seat — selected profile avatar,
// current match strategy icon/name, player name, LP
// tower, status glyph (… acting / ✓ ready / ⌛ deciding / ⚔ combat / door left / ✕ dead), AI badge, "you" marker, the
// field being watched (eye badge), and emote bubbles.
// 局内点击队友头像直接请求切换视角，可用性校验与错误通知仍由 onWatch 处理。
// 旁观时本人的头像和“返回战场”按钮保留返回入口；不再额外打开队友观战菜单。
// Live LP (user playtest #3 item 2): during a normal round's battle each row's tower shows lp − the loss that player's
// leaks so far will cost (red, −N): the own row the top bar's live value (`self`, ui/hud.js liveLp), a teammate's row
// m.public players[].pendingLp (server/match/Match.js, ~1 Hz). 联防 (user playtest #6 item 7): a leaker's row adds the
// runner tag ×N — its enemies still standing on the 联防 field, uncapped and live (falling as the helpers kill them,
// rising when one splits) — next to lp − min(lpCapPerRound, N): the own row the top bar's value, a teammate's row the
// local 联防 replica's count while it is on screen (`uniteLocal`: the battle runner's state().uniteLeft, the same battle
// the player watches, so the number moves with the kills on screen), else m.public players[].uniteLeft (the authority's
// report, ~1 Hz).

import { PHASE } from '../../../shared/constants.js';
import { rankIconUrl, normalizeRankLabel } from '../../../shared/ranks.js';
import { html, Icon, Tooltip, Button } from './components.js';
import { useMemo, useState } from '../../vendor/hooks.module.js';
import { actions } from './gameActions.js';
import { PlayerAvatar, BandIcon, LpTower, GIcon, LocalSprite } from './gameComponents.js';
import { cardOperators, seatAvatar } from './seatArt.js';
import { TeamEmoteBubble } from './emotes.js';
import { STATUS_META, sortedPlayers } from './gameLogic.js';
import { MissTag, uniteRemaining } from './hud.js';
import { data, localAsset } from '../data.js';

function MultiUnite({ unite, myId }) {
  const [busy, setBusy] = useState(false);
  const vote = unite.skipVote;
  const voted = vote?.voters?.includes(myId);
  return html`<section class="multi-unite" aria-label="多人联防进度">
    <b>联防 ${unite.round}/${unite.roundsMax}</b>
    ${vote ? html`<span>跳过后续联防：${vote.voters.length}/${vote.needed} 票</span>
      <${Button} size="sm" disabled=${busy || !vote.open || vote.passed || voted || !vote.eligible.includes(myId)}
        loading=${busy} onClick=${async () => { setBusy(true); await actions.uniteSkipVote(vote.id); setBusy(false); }}>
        ${vote.passed ? '已通过 · 本轮结束后结算' : voted ? '已投票' : '投票跳过后续轮次'}<//>
      <small>需在线手动博士过半同意；本轮仍会打完。</small>` : null}
  </section>`;
}

export function MultiUniteResult({ result, players, myId }) {
  const names = new Map(players.map((p) => [p.playerId, p.name]));
  const helpers = (result.helpers || []).map((id) => names.get(id) || id);
  return html`<section class="multi-unite" aria-label="多人联防结算">
    <b>联防结算 · ${result.rounds}/${result.roundsMax} 轮</b>
    <span>${result.skipped ? '投票已通过，后续轮次已跳过' : '本回合联防已结束'}</span>
    <small>接力助手：${helpers.join('、') || '无'}</small>
    <span>剩余漏怪 ${result.through ?? 0} 个 · 本人损失生命 ${result.losses?.[myId] ?? 0}</span>
    <details><summary>查看各来源结算</summary>
      ${(result.leakers || []).map((id) => html`<p key=${id}>${names.get(id) || id}：剩余 ${result.survivors?.[id] ?? 0} 个，损失生命 ${result.losses?.[id] ?? 0}</p>`)}
    </details>
  </section>`;
}

const cx = (...p) => p.flat().filter(Boolean).join(' ');

// Only decorates the existing East seat pairs / current public boss field.
function teamFrameIds(pub, myId) {
  const none = new Set();
  const alive = (pub?.players || []).filter((p) => p && p.alive !== false);
  if (!alive.some((p) => p.playerId === myId)) return none;
  if (pub.phase === PHASE.FINAL_ASSAULT || pub.phase === PHASE.HIDDEN_CORE) {
    const field = (pub.fields || []).find((f) => (f.kind === 'boss' || f.kind === 'hidden') && f.players?.includes(myId));
    return field?.players?.length > 1 ? new Set(field.players) : none;
  }
  if (!(pub.round > 0 && (pub.round === pub.bossRound || pub.round === pub.hiddenRound)) ||
      ![PHASE.ROUND_START, PHASE.SP_DRAFT, PHASE.PREP].includes(pub.phase)) return none;
  const ids = alive.sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99)).map((p) => p.playerId);
  const at = ids.indexOf(myId);
  const pair = ids.slice(at - at % 2, at - at % 2 + 2);
  return pair.length > 1 ? new Set(pair) : none;
}

/** Official status glyphs (ui/battle) per m.public players[].status; CSS glyph fallback. */
const STATUS_SPRITE = { ready: 'icon_ready', deciding: 'icon_waiting', done: 'icon_complete', dead: 'icon_dead' };

/**
 * A row's LP tower: the settled LP and the pending loss of the round's battle (0 outside COMBAT / UNITE). The own row
 * takes the top bar's live value when there is one (its m.private lp: the same number as the top bar). `left`: during
 * 联防 a leaker's enemies still standing (the ×N tag), else null — for a teammate the local 联防 replica's count when
 * one is given (`uniteLocal`, the runner's state().uniteLeft: { [playerId]: n }, absent = none left; the pending loss
 * is then min(cap, left)), else m.public players[].uniteLeft / pendingLp.
 * @param {any} p m.public players[] entry @param {any} pub m.public
 * @param {{ lp?: number|null, pending: number, unite: boolean, left?: number|null } | null} [self] the own live value (only for the own row)
 * @param {{ uniteLocal?: Record<string, number> | null, cap?: number }} [opts]
 * @returns {{ lp: number|null, pending: number, unite: boolean, left: number|null }}
 */
export function rowLp(p, pub, self = null, { uniteLocal = null, cap = 10 } = {}) {
  const pubLp = Number.isFinite(p?.lp) ? p.lp : null;
  if ((pub?.phase !== PHASE.COMBAT && pub?.phase !== PHASE.UNITE) || p?.alive === false) return { lp: pubLp, pending: 0, unite: false, left: null };
  const lp = self && Number.isFinite(self.lp) ? self.lp : pubLp;
  const leaker = pub.phase === PHASE.UNITE && Array.isArray(pub.unite?.leakers) && pub.unite.leakers.includes(p.playerId);
  const local = !self && leaker && uniteLocal && typeof uniteLocal === 'object' ? uniteRemaining(uniteLocal[p.playerId] ?? 0, null) : null;
  const rawLeft = pub.phase !== PHASE.UNITE ? null : self ? self.left : local != null ? local : p.uniteLeft;
  const left = Number.isFinite(rawLeft) && rawLeft >= 0 ? Math.trunc(rawLeft) : null;
  if (lp == null) return { lp, pending: 0, unite: false, left };
  const raw = self ? self.pending : local != null ? Math.min(cap, local) : p.pendingLp;
  const pending = Math.min(lp, Math.max(0, Math.trunc(Number(raw) || 0)));
  return { lp, pending, unite: (pending > 0 || left != null) && (self ? !!self.unite : pub.phase === PHASE.UNITE), left };
}

/**
 * Tooltip of a row's LP tower with a pending loss (null without one).
 * @param {{ lp: number|null, pending: number, unite: boolean, left: number|null } | null} lp rowLp(...)
 * @param {number} [cap] lpCapPerRound
 */
export function rowLpTip(lp, cap = 10) {
  if (!lp || !(lp.pending > 0)) return null;
  if (lp.unite && lp.left != null) return trA("目标生命值 {lp}，联防中：漏过的敌人还剩 {left} 个，按现在结算扣除 {pending} 点（每回合至多 {cap} 点）", { "lp": (lp.lp), "left": (lp.left), "pending": (lp.pending), "cap": (cap) });
  return trA("目标生命值 {p0}，{p1}结算时扣除{p2} {p3} 点", { "p0": (lp.lp), "p1": (lp.unite ? '联防中，' : ''), "p2": (lp.unite ? '至多' : ''), "p3": (lp.pending) });
}

/**
 * @param {{ pub:any, myId:string, watching:string|null, bubbles: Map<string,{id:string,seq:number}>, onWatch:(p:any)=>void,
 *   compact?: boolean, teamLp?: number|null, self?: { lp?: number|null, pending: number, unite: boolean, left?: number|null } | null,
 *   cap?: number, uniteLocal?: Record<string, number> | null, seats?: any[] | null,
 *   observe?: null | { canObserve: (p:any) => { fieldId?: string, reason?: string|null, back?: boolean }, observing: boolean, onBack: () => void } }} props
 *   uniteLocal: the local 联防 replica's per-leaker counts while it is on screen (battle runner state().uniteLeft), else null
 */
export function TeamPanel({ pub, myId, watching, bubbles, onWatch, compact = false, observe = null, self: selfLive = null, cap = 10, uniteLocal = null, spMarks = null, seats = null }) {
  const players = sortedPlayers(pub);
  const roomSeats = useMemo(() => new Map((Array.isArray(seats) ? seats : [])
    .filter((seat) => seat?.playerId).map((seat) => [seat.playerId, seat])), [seats]);
  const cardPool = useMemo(() => cardOperators(data.list('chess'), data.get('backups')),
    [data.get('chess'), data.get('backups')]);
  const cardsByChar = useMemo(() => new Map(cardPool.map((card) => [card.charId, card])), [cardPool]);
  if (!players.length) return null;
  const click = (p, self) => {
    if (observe && self) { if (observe.observing) observe.onBack(); return; }
    onWatch(p);
  };
  const multi = pub.variant === 'entertainment_multi';
  const largeRoster = multi || pub.variant === 'entertainment_endless';
  const myGroup = pub.poolGroups?.find((g) => g.playerIds.includes(myId));
  const framed = teamFrameIds(pub, myId);
  const frameArt = framed.size ? localAsset('ui/battle', 'bg_team_border') : null;
  return html`<aside class=${cx('team', compact && 'team--compact', largeRoster && 'team--multi')} aria-label=${trA("同盟成员")}>
    ${multi ? html`<div class="team__pool-note">${myGroup ? `本组 ${myGroup.id} · ${myGroup.size} 人共享卡池` : '分组共享卡池'}<br />队伍 ${players.length} 人 · 滚动查看成员</div>` : null}
    ${multi && pub.phase === PHASE.UNITE && pub.unite ? html`<${MultiUnite} unite=${pub.unite} myId=${myId} />` : null}
    ${multi && pub.phase === PHASE.SETTLE && pub.uniteResult ? html`<${MultiUniteResult} result=${pub.uniteResult} players=${players} myId=${myId} />` : null}
    ${players.map((p) => {
      const self = p.playerId === myId;
      const status = p.alive === false ? 'dead' : p.status;
      const meta = STATUS_META[status] || STATUS_META.acting;
      const watched = watching && (watching === p.fieldId || watching === `n:${p.playerId}`);
      const bubble = bubbles?.get(p.playerId);
      const offline = p.connected === false && !p.isBot;
      const back = !!observe && self && observe.observing;
      const title = observe ? (self ? (observe.observing ? trA("返回战场") : trA("你自己")) : trA("查看 {name} 的战场", { "name": (p.name) })) : (self ? trA("查看自己的阵地") : trA("查看 {name} 的阵地", { "name": (p.name) }));
      const lp = rowLp(p, pub, self ? selfLive : null, { uniteLocal, cap });
      const seat = roomSeats.get(p.playerId);
      const avatarSrc = seat && !p.isBot ? seatAvatar(seat, { pool: cardPool, byChar: cardsByChar,
        m: data.get('assets'), myId, myCard: null }) : null;
      const strategy = p.bandId ? data.lookup('bands', p.bandId)?.name || p.bandId : null;
      return html`<div key=${p.playerId} class=${cx('team__row', self && 'is-self', watched && 'is-watched', p.alive === false && 'is-dead', framed.has(p.playerId) && 'is-team')}
        style=${frameArt && framed.has(p.playerId) ? `--team-frame:url("${frameArt}")` : null}>
        <button type="button" class="team__btn" onClick=${() => click(p, self)} title=${title}>
          <${PlayerAvatar} player=${p} self=${self} avatarSrc=${avatarSrc} />
          ${framed.has(p.playerId) ? html`<span class=${cx('team__frame', !frameArt && 'team__frame--plain')} style=${frameArt ? `--frame:url("${frameArt}")` : undefined} aria-hidden="true"></span>` : null}
          <span class="team__seat num">P${(p.seat ?? 0) + 1}</span>
          ${p.isBot ? html`<span class="team__ai">AI</span>` : null}
          ${self ? html`<span class="team__you"><${Icon} name="user" /></span>` : null}
          ${spMarks?.get(p.playerId) === 'done' ? html`<span class="team__spmark is-done" title=${trA('已完成选择')}><${Icon} name="check" /></span>`
            : spMarks?.get(p.playerId) === 'turn' ? html`<span class="team__spmark is-turn" title=${trA('正在决策…')}><i></i><i></i><i></i></span>` : null}
        </button>
        <div class="team__info">
          <span class="team__identity"><span class="team__name">${p.name || trA("博士")}</span>${pub.ranked && !p.isBot && p.rank?.icon
            ? html`<img class="team__rank" src=${rankIconUrl(p.rank.icon)} alt=${normalizeRankLabel(p.rank.label)} title=${normalizeRankLabel(p.rank.label)} />` : null}</span>
          ${strategy ? html`<span class="team__strategy" title=${strategy}><${BandIcon} bandId=${p.bandId} size="xs" /><span class="team__strategy-name">${strategy}</span></span>` : null}
          ${multi && p.poolGroupId ? html`<small class="team__pool-id">卡池 ${p.poolGroupId}</small>` : null}
          <div class="team__line">
            <${LpTower} value=${lp.lp} size="sm" tone=${Number.isFinite(lp.lp) && lp.lp - lp.pending <= 5 ? 'danger' : null} pending=${lp.pending}
              tip=${rowLpTip(lp, cap)} />
            ${lp.left != null ? html`<${MissTag} n=${lp.left} name=${self ? null : p.name || trA("博士")} />` : null}
            <${Tooltip} text=${offline ? trA("连接已断开") : trA(meta.text)} placement="right">
              <span class=${cx('team__status', `is-${meta.tone}`, offline && 'is-offline', (offline || STATUS_SPRITE[status]) && localAsset('ui/battle', offline ? 'icon_lost_connect' : STATUS_SPRITE[status]) && 'has-sprite')} aria-label=${trA(meta.text)}>
                ${offline ? html`<${LocalSprite} name="icon_lost_connect" fallback=${html`<${Icon} name="wifiOff" />`} />`
                  : STATUS_SPRITE[status] ? html`<${LocalSprite} name=${STATUS_SPRITE[status]} fallback=${html`<${GIcon} name=${meta.glyph} />`} />`
                  : html`<${GIcon} name=${meta.glyph} />`}
              </span>
            <//>
            ${watched && !self ? html`<span class="team__eye" title=${trA("正在查看")}><${GIcon} name="eye" /></span>` : null}
          </div>
          ${back ? html`<button type="button" class="btn btn--secondary btn--sm team__back"
            onClick=${() => observe.onBack()}><span class="btn__label">${trA("返回战场")}</span></button>` : null}
        </div>
        ${bubble ? html`<${TeamEmoteBubble} key=${bubble.seq} id=${bubble.id} at=${bubble.at} />` : null}
      </div>`;
    })}
  </aside>`;
}
