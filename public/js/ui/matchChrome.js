import { t as trA } from '../../../shared/i18n.js';
// Chrome shared by every in-match screen: the step header of the pre-game screens (exit + ping +
// difficulty | "1/2 确认本局信息" | countdown) and the exit flow (confirm with 暂离 / 放弃, AI 托管 overlay).
//
// 暂离 (co-op): turns on AI 托管 (g.autoplay on) so the seat keeps playing; the overlay's 返回模拟 turns it
// off. 放弃模拟: room.leave (the platform treats it as a quit), back to the lobby after confirmation.

import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal, Overlay, CloseButton, isTopOverlay, PingPill, DifficultyTag, Countdown, MicroLabel } from './components.js';
import { actions } from './gameActions.js';
import { toastError } from './toasts.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual, emptyMatch, createStore } from '../store.js';
import { GIcon, UnitThumb } from './gameComponents.js';
import { battleRunner } from '../battle/runner.js';
import { GuideButton } from './guide.js';
import { recordQuit, liveMatch } from './stats.js';

/**
 * Exit dialog lines. 放弃模拟 (room.leave) ends the run on the server as 'abandoned' and returns to the
 * lobby straight away — no settlement screen follows, so the solo text must not promise one.
 */
export const EXIT_TEXT = Object.freeze({
  soloRest: '独立模拟的休整期没有时间限制，你可以随时继续。',
  soloQuit: '放弃模拟将立即结束本局并返回大厅，本局进度不会保留，也不会进行结算。',
});

/** Local "暂离 / AI 托管" flag (the server keeps no per-client autoplay view). */
export const awayStore = createStore({ away: false });

/**
 * Whether a store change ends the match the 暂离 flag belongs to: its state was cleared (result → 返回同盟, 放弃模拟, a
 * new match starting, the room closing, a new server session) or its settlement arrived. The next match must never
 * open under the previous one's "AI 托管中" overlay (the server starts every match with autoplay off).
 * @param {any} s store state
 * @param {any} prev previous store state
 */
export const awayEnds = (s, prev) => (!!prev?.match?.public && !s?.match?.public) || (!!s?.match?.result && !prev?.match?.result);
store.subscribe((s, prev) => { if (awayStore.get().away && awayEnds(s, prev)) awayStore.set({ away: false }); });

/**
 * Leave the match for good (room.leave), then drop local state only after confirmation.
 * @returns {Promise<boolean>}
 */
export async function quitMatch() {
  const before = store.get();
  const liveBefore = { ...liveMatch };
  const quitAt = Date.now();
  let settled = !!before.match.result;
  // 请求期间结算可能先到、随后被 room.closed 清空；不能只检查最终 store。
  const off = store.subscribe((s) => { if (s.match.result) settled = true; });
  try {
    try { await net.request('room.leave', {}); }
    catch (err) { if (err?.code !== 'NOT_IN_ROOM') throw err; }
    if (!settled && liveMatch.settledSerial === liveBefore.settledSerial) {
      recordQuit(before, { live: liveBefore, now: quitAt });
    }
    liveMatch.active = false;
    store.set({ room: null, spectator: null, match: emptyMatch(), matchChat: { matchId: null, items: [] }, ticker: [], emotes: [] });
    return true;
  } catch (err) {
    toastError(err);
    return false;
  } finally {
    off();
  }
}

/**
 * Exit confirmation modal.
 * @param {{ open: boolean, onClose: Function, solo: boolean, onAway?: Function }} props
 */
export function ExitModal({ open, onClose, solo, onAway }) {
  const [busy, setBusy] = useState(null);
  const quit = async () => {
    setBusy('quit');
    const ok = await quitMatch();
    setBusy(null);
    if (ok) onClose();
  };
  const away = async () => {
    setBusy('away');
    const ok = await actions.autoplay(true);
    setBusy(null);
    onClose();
    if (ok) { awayStore.set({ away: true }); onAway?.(); }
  };
  return html`<${Modal} open=${open} onClose=${onClose} tone="red" title=${trA("离开模拟")} micro="LEAVE SIMULATION" width="6.8rem"
    actions=${html`
      <${Button} variant="secondary" onClick=${onClose}>${trA("取消")}<//>
      ${!solo ? html`<${Button} variant="ice" icon="robot" loading=${busy === 'away'} onClick=${away}>${trA("暂离（AI 托管）")}<//>` : null}
      <${Button} variant="danger" icon="exit" loading=${busy === 'quit'} onClick=${quit}>${trA("放弃模拟")}<//>`}>
    <div class="exitm">
      ${solo
        ? html`<p>${EXIT_TEXT.soloRest}</p><p class="t-lo">${EXIT_TEXT.soloQuit}</p>`
        : html`<p><b class="t-ice">${trA("暂离")}</b>${trA("：由 AI 托管你的席位（自动部署、准备与选择），随时可以返回。")}</p>
               <p><b class="t-red">${trA("放弃模拟")}</b>${trA("：离开后无法返回本局，你的干员将回到共享卡池。")}</p>`}
    </div>
  <//>`;
}

/** The original East round chart, using the round-specific simulation counters. */
export function RoundDamageModal({ open, onClose, round, ownerIds }) {
  const [sample, setSample] = useState({ round: null, owners: '', rows: [] });
  const panelRef = useRef(null), closeRef = useRef(onClose);
  closeRef.current = onClose;
  const owners = ownerIds ? JSON.stringify(ownerIds) : '';
  useEffect(() => {
    if (!open) return;
    const ids = owners ? JSON.parse(owners) : null;
    const refresh = () => setSample({ round, owners, rows: battleRunner?.roundDamage(round, ids) || [] });
    refresh();
    const timer = setInterval(refresh, 200);
    return () => clearInterval(timer);
  }, [open, round, owners]);
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (e) => {
      const panel = panelRef.current;
      if (!panel || panel.contains(e.target) || !isTopOverlay(panel) || e.target.closest?.('.gm__damage')) return;
      closeRef.current?.();
    };
    const escape = (e) => {
      if (e.key !== 'Escape' || !isTopOverlay(panelRef.current)) return;
      e.preventDefault(); e.stopImmediatePropagation(); closeRef.current?.();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  const rows = sample.round === round && sample.owners === owners ? sample.rows : [];
  const scale = Math.max(1, ...rows.map((r) => r.total));
  const number = (n) => Math.round(n).toLocaleString('zh-CN');
  if (!open) return null;
  return html`<${Overlay} level="game-panel"><aside ref=${panelRef} class="dpanel brackets round-damage" role="dialog" aria-label=${trA("本回合伤害统计")}>
    <header class="sp-detail-head"><span>${trA("伤害统计")} · ${round || 0}</span><${CloseButton} class="dpanel__close" label=${trA("伤害统计")} onClose=${onClose} /></header>
    <div class="dpanel__scroll" tabindex="0">
    <div class="round-damage__legend">
      <span><i class="round-damage__phys"></i>${trA("物理")}</span>
      <span><i class="round-damage__arts"></i>${trA("法术")}</span>
      <span><i class="round-damage__other"></i>${trA("元素及其他")}</span>
    </div>
    <p class="round-damage__note" title=${trA("含本回合联防、所属召唤物；元素损伤与元素伤害均计入灰色部分。换回合清零。")}>${trA("含召唤物 · 换回合清零")}</p>
    <div class="round-damage__heading"><span>${trA("干员")}</span><span>${trA("伤害构成")}</span><span>${trA("总伤害")}</span></div>
    ${rows.length ? rows.map((r) => html`<div key=${r.key} class="round-damage__row">
      <${UnitThumb} kind=${r.kind} id=${r.id} rec=${r.rec} skin=${r.skin} size="sm" showTier=${false} title=${r.name} />
      <div class="round-damage__chart">
        <span class="round-damage__name">${r.name}</span>
        <div class="round-damage__track" role="img" aria-label=${`${r.name}：物理 ${number(r.phys)}，法术 ${number(r.arts)}，元素及其他 ${number(r.other)}，总伤害 ${number(r.total)}`}>
          <div class="round-damage__bar" style=${`width:${r.total / scale * 100}%`}>
            <i class="round-damage__phys" style=${`flex:${r.phys} 1 0%`} title=${`${trA("物理")} ${number(r.phys)}`}></i>
            <i class="round-damage__arts" style=${`flex:${r.arts} 1 0%`} title=${`${trA("法术")} ${number(r.arts)}`}></i>
            <i class="round-damage__other" style=${`flex:${r.other} 1 0%`} title=${`${trA("元素及其他")} ${number(r.other)}`}></i>
          </div>
        </div>
      </div>
      <span class="round-damage__total num">${number(r.total)}</span>
    </div>`) : html`<p class="round-damage__empty">${trA("本回合暂无战斗伤害记录")}</p>`}
    </div>
  </aside><//>`;
}

/** Full-screen "AI 托管中" overlay with 返回模拟. */
export function AwayOverlay({ onBack = () => {} }) {
  const [busy, setBusy] = useState(false);
  return html`<div class="awayov" role="dialog" aria-label=${trA("AI 托管中")}>
    <div class="awayov__box brackets">
      <${GIcon} name="robot" class="awayov__icon" />
      <${MicroLabel} tone="mint">${trA("AUTOPILOT // AI 托管")}</${MicroLabel}>
      <h2>${trA("AI 托管中")}</h2>
      <p class="t-lo">${trA("AI 正在代为操作你的席位")}</p>
      <${Button} variant="primary" size="lg" icon="play" loading=${busy} onClick=${async () => { setBusy(true); const ok = await actions.autoplay(false); setBusy(false); if (ok) { awayStore.set({ away: false }); onBack(); } }}>${trA("返回模拟")}<//>
    </div>
  </div>`;
}

/**
 * Pre-game step header.
 * @param {{ step: number, of: number, title: string, micro: string, pub: any, total?: number|null, onExit: Function }} props
 */
export function StepHeader({ step, of, title, micro, pub, total, onExit }) {
  const conn = useStore((s) => s.connection, shallowEqual);
  return html`<header class="stephead">
    <div class="stephead__left">
      <${Button} variant="danger" size="lg" square=${true} icon="exit" onClick=${onExit} aria-label=${trA("离开")} title=${trA("离开")} />
      <div class="stephead__meta">
        <${PingPill} ms=${conn.ping} online=${conn.status === 'online'} />
        ${pub?.difficulty ? html`<${DifficultyTag} difficulty=${pub.difficulty} />` : null}
      </div>
    </div>
    <div class="stephead__center">
      <${MicroLabel} tone="mint">${micro}</${MicroLabel}>
      <h1 class="stephead__title"><b class="num">${step}</b><span class="num stephead__of">/${of}</span>${title}</h1>
    </div>
    <div class="stephead__right">
      <${GuideButton} class="stephead__guide" variant="secondary" />
      <${Countdown} deadline=${pub?.deadline} total=${total ?? undefined} size="md" />
    </div>
  </header>`;
}

