import { t as trA } from '../../../../shared/i18n.js';
// 从 A 原正文按职责拆分；保持原有行为。
import { html, Button, MicroLabel } from '../../ui/components.js';
import { store, emptyMatch } from '../../store.js';
import { data, localAsset } from '../../data.js';
import { useResourceUrl } from '../../ui/cachedImage.js';

export function MatchEnded() {
  return html`<div class="awayov" role="dialog" aria-label=${trA("模拟已结束")}>
    <div class="awayov__box brackets">
      <${MicroLabel} tone="mint">SIMULATION CLOSED</${MicroLabel}>
      <h2>${trA("本局模拟已结束")}</h2>
      <p class="t-lo">${trA("同盟已返回等待室")}</p>
      <${Button} variant="primary" size="lg" icon="chevronLeft" onClick=${() => store.set({ match: emptyMatch() })}>${trA("返回同盟")}<//>
    </div>
  </div>`;
}

export function PausedOverlay({ canResume, busy, onResume, onExit }) {
  const plate = useResourceUrl(localAsset('ui/battle', 'matte_pause'));
  return html`<div class="pauseov" role="dialog" aria-label=${trA("暂停中")} data-testid="paused">
    <div class="pauseov__box">
      <div class="pauseov__plate" style=${plate ? `--pause-plate:url("${plate}")` : ''}>
        <span class="pauseov__micro">PAUSED</span>
        <h2>${trA("暂停中")}</h2>
      </div>
      <p class="pauseov__note">${trA("作战已暂停，计时与敌人行动均已停止")}</p>
      <div class="pauseov__btns">
        ${onExit ? html`<${Button} variant="secondary" size="lg" icon="exit" onClick=${onExit}>${trA("放弃模拟")}<//>` : null}
        ${canResume ? html`<${Button} variant="primary" size="lg" icon="play" loading=${busy} onClick=${onResume} data-autofocus>${trA("继续作战")}<//>` : null}
      </div>
    </div>
  </div>`;
}
