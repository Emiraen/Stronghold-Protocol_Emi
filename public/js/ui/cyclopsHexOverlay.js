// public/js/ui/cyclopsHexOverlay.js — 独眼巨人的馈赠（entertainment_cyclops 三选一界面）。
//
// 第 5/10/15 回合的 CYCLOPS_HEX 阶段：3 个馈赠槽位，品质按 银→金→彩 固定推进（本回合品质由服务端下发）。
// 交互（对齐 choiceOverlay 的两步确认习惯）：
//   * 点击槽位选中（升起金框），再次点击同一槽位确认发送 g.cyclopsHex { slot }
//   * 每个槽位有 1 次刷新机会（按钮「刷新此槽」→ g.cyclopsHexReroll { slot }），用完置灰
//   * 品质配色：银 = 银灰描边；金 = 金色描边；彩 = 白彩渐变描边（CSS 类 cyc-hex--silver / --gold / --prismatic）
//   * logo：仅原版盟约图案本体品质染色，无额外徽章外框、底板或运行时蒙版。

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, MicroLabel, Icon } from './components.js';
import { Img, GIcon } from './gameComponents.js';
import { effectIconUrl, uiUrl } from './assetUrls.js';
import { data } from '../data.js';

const QUALITY_NAMES = { silver: '银', gold: '金', prismatic: '彩' };

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** 馈赠卡的展示字段（logo 兜底：assets.json 无该 ui 键时用图标族 fallback）。 */
function hexIconUrl(logo, quality) {
  const assets = data.get('assets');
  if (!logo) return null;
  const iconId = logo.startsWith('cyclopsIcon/') && quality ? `${logo}_${quality}` : logo;
  const url = uiUrl(assets, iconId);
  return url || effectIconUrl(assets, { iconKind: 'cyclops', iconId: logo, data: { quality } });
}

/**
 * 单个馈赠槽位卡。
 * @param {{ card, slot, quality, rerollable, armed, onTap, onReroll, busy }} props
 */
export function CyclopsHexCard({ card, slot, quality, rerollable, armed, onTap, onReroll, busy }) {
  if (!card) {
    return html`<div class=${cx('cyc-hex', 'cyc-hex--empty', `cyc-hex--${quality}`)} data-slot=${slot}>
      <div class="cyc-hex__empty">槽位待刷新…</div>
    </div>`;
  }
  return html`<button type="button"
    class=${cx('cyc-hex', `cyc-hex--${quality}`, armed && 'is-armed', busy && 'is-busy')}
    data-slot=${slot}
    onClick=${() => onTap(slot)}
    aria-label=${`${card.levelName}·${card.name}（${QUALITY_NAMES[quality]}）${armed ? '，再次点击确认' : ''}`}>
    <span class="cyc-hex__glow" aria-hidden="true"></span>
    <span class="cyc-hex__head">
      <span class=${cx('cyc-hex__icon', `cyc-hex__icon--${quality}`)}>
        <${Img} src=${hexIconUrl(card.logo, quality)} fallback=${html`<${Img} src=${uiUrl(data.get('assets'), 'garrisonTypeIcon/s_icon_bond')} fallback=${html`<${GIcon} name="gift" />`} />`} />
      </span>
      <span class="cyc-hex__title">
        <b class="cyc-hex__name">${card.levelName || card.name}</b>
        <span class=${cx('cyc-hex__lvl', `cyc-hex__lvl--${quality}`)}>${card.name} · ${QUALITY_NAMES[quality]}阶</span>
      </span>
    </span>
    <span class="cyc-hex__desc">${card.desc}</span>
    ${armed ? html`<span class="cyc-hex__confirm" role="status"><b>确认选择</b><small>再次点击</small></span>` : null}
    ${rerollable ? html`<span class="cyc-hex__reroll" role="button" tabindex="0"
      aria-label="刷新馈赠"
      onClick=${(e) => { e.stopPropagation(); onReroll(slot); }}
      onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onReroll(slot); } }}><${Icon} name="refresh" /><span>刷新馈赠</span></span>` : null}
  </button>`;
}

/**
 * 馈赠覆盖层：pub.cyclops = { round, quality, deadline, turnSeconds, state: { [playerId]: { slots, rerolls, picked } } }。
 * @param {{ pub: any, myId: string, onPick: (slot:number)=>void, onReroll: (slot:number)=>void, rerollBusy?: number|null }} props
 */
export function CyclopsHexOverlay({ pub, myId, onPick, onReroll, rerollBusy = null }) {
  const [sel, setSel] = useState(null);
  const [bondId, setBondId] = useState('');
  const bonds = Object.values(data.get('bonds') || {}).filter(b => b.bondId || b.id);
  const cyc = pub && pub.cyclops;
  const mine = cyc && cyc.state ? cyc.state[myId] : null;
  useEffect(() => { if (mine && mine.picked != null && sel != null) setSel(null); }, [mine && mine.picked]);
  if (!cyc || !mine) return null;
  const slots = Array.isArray(mine.slots) ? mine.slots : [];
  const armed = mine.picked == null && sel != null && slots[sel] ? sel : null;
  const done = mine.picked != null;
  const tap = (slot) => {
    if (done) return;
    if (armed === slot) {
      if (slots[slot]?.id === 'cyc_universal' && !bondId) return;
      onPick(slot, slots[slot]?.id === 'cyc_universal' ? bondId : undefined); setSel(null); return;
    }
    setSel(slot);
  };
  return html`<div class=${cx('cycov', armed != null && 'has-armed')} role="dialog" aria-label="独眼巨人的馈赠">
    <div class="cycov__veil" aria-hidden="true"></div>
    <div class="cycov__inner">
      <header class="cycov__head">
        <div class="cycov__titles">
          <${MicroLabel} tone="mint">CYCLOPS GIFT // 独眼巨人的馈赠</${MicroLabel}>
          <h2 class=${cx('cycov__title', `cycov__title--${cyc.quality}`)}>
            ${QUALITY_NAMES[cyc.quality] || ''}阶馈赠<span class="cycov__bar">|</span>
            <span class="cycov__desc">三选一强化 · 每槽一次刷新机会</span>
          </h2>
          <p class="cycov__sub">${done ? '已完成选择，等待其他博士' : `限时${cyc.turnSeconds || 35}秒；未选择将随机获得一项`}</p>
        </div>
        ${done ? html`<span class="cycov__turntxt is-done">${slots[mine.picked] ? `已选择「${slots[mine.picked].levelName || slots[mine.picked].name || ''}」` : '已完成选择'}</span>` : null}
      </header>
      ${armed != null && slots[armed]?.id === 'cyc_universal' ? html`<label style="display:flex;gap:12px;align-items:center;color:#fff;padding:12px;background:#182327">选择强化盟约
        <select aria-label="选择强化盟约" value=${bondId} onChange=${e => setBondId(e.target.value)} style="max-width:65%;padding:8px;color:#fff;background:#24383d">
          <option value="">请选择盟约</option>
          ${bonds.map(b => html`<option value=${b.bondId || b.id}>${b.name || b.bondName || b.bondId || b.id}</option>`)}
        </select></label>` : null}
      <div class="cycov__grid">
        ${slots.map((card, i) => html`<${CyclopsHexCard} key=${i} card=${card} slot=${i}
          quality=${cyc.quality} rerollable=${!done && mine.rerolls && mine.rerolls[i]}
          armed=${armed === i} busy=${rerollBusy === i}
          onTap=${tap} onReroll=${(s) => { if (!done) onReroll(s); }} />`)}
      </div>
    </div>
  </div>`;
}
