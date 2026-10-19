import { t as trA } from '../../../shared/i18n.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, MicroLabel, CloseButton } from './components.js';
import { FloatingPanel } from './floatingPanel.js';
import { Img, RichText, GIcon } from './gameComponents.js';
import { effectIconUrl } from './assetUrls.js';
import { data } from '../data.js';

const KIND = { band: '策略', choice: '机变', team: '团队增益', item: '道具', garrison: '特质', cyclops: '馈赠' };
const hexQuality = e => ['silver', 'gold', 'prismatic'].includes(e?.data?.quality) ? e.data.quality : null;

/** Every active strategy and effect has a click-open, scrollable detail card. */
function EffectDetail({ eff, anchor, onClose }) {
  const q = hexQuality(eff);
  const quality = q === 'silver' ? '银阶' : q === 'gold' ? '金阶' : q === 'prismatic' ? '彩阶' : '';
  return html`<${FloatingPanel} class=${`hexpop hexpop--${q || 'x'}`} onClose=${onClose} anchor=${anchor} side="right" width=${380}
      family="match-effect" ignore=".effects__hit" role="dialog" aria-label=${`${KIND[eff.iconKind] || trA('效果')}详情：${eff.name}`}>
    <header class="sp-detail-head"><span>${KIND[eff.iconKind] || trA('效果')}${trA('详情')}</span><${CloseButton} label=${trA('效果详情')} onClose=${onClose} /></header>
    <div class="hexpop__scroll" tabindex="0">
      <header class="hexpop__head">
        <span class=${`hexpop__icon hexpop__icon--${q || 'x'}`}><${Img} src=${effectIconUrl(data.get('assets'), eff)} fallback=${html`<${GIcon} name="bolt" />`} /></span>
        <div><h3 class="hexpop__name">${eff.name}</h3><span class=${`hexpop__q hexpop__q--${q || 'x'}`}>${quality}${KIND[eff.iconKind] || ''}</span></div>
      </header>
      ${eff.counterText || eff.counter != null ? html`<p class="hexpop__counter">${eff.counterText || `${trA('当前层数')} · ${eff.counter}`}</p>` : null}
      <${RichText} as="div" class="hexpop__desc" text=${eff.desc || trA('效果已生效')} />
    </div>
  <//>`;
}

export function EffectsList({ effects }) {
  const list = (Array.isArray(effects) ? effects : []).filter(e => e && (e.name || e.desc));
  const [openId, setOpenId] = useState(null);
  const triggers = useRef(new Map());
  useEffect(() => { if (openId != null && !list.some((e, i) => (e.id ?? i) === openId)) setOpenId(null); }, [list, openId]);
  if (!list.length) return null;
  const m = data.get('assets');
  const active = list.find((e, i) => (e.id ?? i) === openId);
  return html`<div class=${`effects${list.some(e => e.iconKind === 'cyclops') ? ' effects--has-gifts' : ''}`} aria-label=${trA('生效中的效果')}>
    <${MicroLabel}>EFFECTS</${MicroLabel}>
    <div class="effects__list">${list.map((e, i) => {
      const q = hexQuality(e), key = e.id ?? i, open = openId === key;
      return html`<div key=${key} class="effects__slot">
        <button type="button" ref=${el => { if (el) triggers.current.set(key, el); else triggers.current.delete(key); }} class="effects__hit"
            title=${e.name} aria-expanded=${String(open)} aria-label=${`${e.name}（${KIND[e.iconKind] || trA('效果')}，点击查看详情）`}
            onClick=${() => setOpenId(open ? null : key)}>
          <span class=${`effect effect--${e.iconKind || 'x'}${q ? ` effect--hex-${q}` : ''}${open ? ' is-open' : ''}`}>
            <${Img} src=${effectIconUrl(m, e)} fallback=${html`<${GIcon} name="bolt" />`} />
            ${e.counter != null && e.counter !== '' ? html`<b class="effect__n num">${e.counter}</b>` : null}
          </span>
        </button>
      </div>`;
    })}</div>
    ${active ? html`<${EffectDetail} eff=${active} anchor=${() => triggers.current.get(openId)?.getBoundingClientRect()} onClose=${() => setOpenId(null)} />` : null}
  </div>`;
}
