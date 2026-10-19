// public/js/ui/cyclopsDraftOverlay.js — 征召（R10：10 组「干员+装备」捆绑，LP 低者先选）。
//
// 公开状态 pub.cyclops = { kind: 'draft', order, idx, turn, taken }；私有 priv.cyclopsDraftMine = { groupId, items: [{chessId, itemId}] }。
// 交互：轮到自己时点亮 10 个选项（已领的置灰），点击选中 → 再次点击确认发送 g.cyclopsDraft { idx }。
// 非 tun 到自己时全部只读。选项展示：干员头像+品阶角标 | 装备图标+品阶角标。

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, MicroLabel, TierChip } from './components.js';
import { Img, GIcon } from './gameComponents.js';
import { itemIconUrl, uiUrl } from './assetUrls.js';
import { data } from '../data.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

const CHESS_ICON = (id) => {
  const rec = data.lookup('chess', id);
  const assets = data.get('assets');
  const avatar = rec && rec.assets && (rec.assets.avatar || rec.assets.portrait);
  if (avatar && assets) {
    const m = assets.chars && assets.chars[rec.charId];
    if (m && m.avatar) return m.avatar;
  }
  return null;
};

/** 单个选秀选项：干员 + 装备捆绑卡。 */
export function CyclopsDraftOption({ opt, idx, takenBy, takenName, isTurn, armed, onTap }) {
  const chess = data.lookup('chess', opt.chessId);
  const item = data.lookup('items', opt.itemId);
  const assets = data.get('assets');
  const isFree = !takenBy;
  const can = isTurn && isFree;
  return html`<button type="button" key=${idx}
    class=${cx('cyc-draft-opt', takenBy && 'is-taken', can && 'is-pickable', armed === idx && 'is-armed')}
    disabled=${!can}
    onClick=${() => can && onTap(idx)}
    aria-label=${`${chess?.name || opt.chessId} + ${item?.name || opt.itemId}${takenBy ? `，${takenName}已选` : ''}`}>
    <span class="cyc-draft-opt__idx num">${idx + 1}</span>
    <span class="cyc-draft-opt__chess">
      <span class="cyc-draft-opt__avatar"><${Img} src=${CHESS_ICON(opt.chessId)} fallback=${html`<${GIcon} name="user" />`} /></span>
      <span class="cyc-draft-opt__cname">${chess?.name || opt.chessId}</span>
      ${chess?.tier ? html`<${TierChip} tier=${chess.tier} size="sm" />` : null}
    </span>
    <span class="cyc-draft-opt__plus" aria-hidden="true">+</span>
    <span class="cyc-draft-opt__item">
      <span class="cyc-draft-opt__iicon"><${Img} src=${itemIconUrl(assets, item)} fallback=${html`<${GIcon} name="gift" />`} /></span>
      <span class="cyc-draft-opt__iname">${item?.name || opt.itemId}</span>
      ${item?.tier ? html`<${TierChip} tier=${item.tier} size="sm" />` : null}
    </span>
    ${takenBy ? html`<span class="cyc-draft-opt__taken">已选</span>` : null}
    ${armed === idx ? html`<span class="cyc-draft-opt__confirm"><b>确认选择</b><small>再次点击</small></span>` : null}
  </button>`;
}

/**
 * 选秀覆盖层。
 * @param {{ pub, priv, myId, players, onPick:(idx:number)=>void }} props
 */
export function CyclopsDraftOverlay({ pub, priv, myId, players = [], onPick }) {
  const [sel, setSel] = useState(null);
  const cyc = pub && pub.cyclops;
  const mine = priv && priv.cyclopsDraftMine;
  useEffect(() => { setSel(null); }, [cyc && cyc.idx]);
  if (!cyc || cyc.kind !== 'draft' || !mine) return null;
  const isTurn = cyc.turn === myId;
  const byId = new Map(players.map((p) => [p.playerId, p]));
  // taken: { 'g:<groupId>:<idx>': playerId }
  const takenMap = new Map();
  for (const [k, pid] of Object.entries(cyc.taken || {})) {
    if (!k.startsWith('g:')) continue;
    const [, g, i] = k.split(':');
    if (g === mine.groupId) takenMap.set(Number(i), pid);
  }
  const armed = isTurn && sel != null && !takenMap.has(sel) ? sel : null;
  const tap = (idx) => {
    if (armed === idx) { onPick(idx); setSel(null); return; }
    setSel(idx);
  };
  const turnName = byId.get(cyc.turn)?.name || '博士';
  return html`<div class=${cx('cycov', 'cycov--draft', armed != null && 'has-armed')} role="dialog" aria-label="征召">
    <div class="cycov__veil" aria-hidden="true"></div>
    <div class="cycov__inner">
      <header class="cycov__head">
        <div class="cycov__titles">
          <${MicroLabel} tone="mint">CYCLOPS DRAFT // 征召</${MicroLabel}>
          <h2 class="cycov__title">征召<span class="cycov__bar">|</span>
            <span class="cycov__desc">10 组「干员 + 装备」· 目标生命值低者先选</span>
          </h2>
          <p class="cycov__sub">${isTurn ? '轮到你了：点击选项选中，再次点击确认' : `等待 ${turnName} 选择…`}</p>
        </div>
        <div class="cycov__turn">
          <ol class="cycov__order" aria-label="选取顺序">
            ${(cyc.order || []).map((pid, i) => {
              const p = byId.get(pid);
              const done = (cyc.taken || {})[`auto:${pid}`];
              const cur = cyc.turn === pid;
              return html`<li key=${pid} class=${cx('cyc-draft-who', cur && 'is-cur', done && 'is-done', pid === myId && 'is-self')}>
                <span class="num">${i + 1}</span><b>${p?.name || pid}</b><span class="cyc-draft-who__lp">LP ${p?.lp ?? '?'}</span>
              </li>`;
            })}
          </ol>
        </div>
      </header>
      <div class="cyc-draft-grid">
        ${(mine.items || []).map((opt, i) => {
          const taker = takenMap.get(i);
          const takerName = taker === myId ? '你' : byId.get(taker)?.name || '';
          return html`<${CyclopsDraftOption} key=${i} opt=${opt} idx=${i}
            takenBy=${taker || null} takenName=${takerName}
            isTurn=${isTurn} armed=${armed} onTap=${tap} />`;
        })}
      </div>
    </div>
  </div>`;
}
