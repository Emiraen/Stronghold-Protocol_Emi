import { html, Icon } from '../ui/components.js';
import { ProtocolScene } from '../ui/protocolScene.js';
import { useState } from '../../vendor/hooks.module.js';
import { ZHAJING_VARIANT, ZHAJING_CAPACITIES } from '../../../shared/zhajing-constants.js';

export function ZhajingSetup({ Frame, onBack, online, busy, onCreate }) {
  const [capacity, setCapacity] = useState(4);
  return html`<${Frame} title="选择模拟协议" en="ENTERTAINMENT" modeName="炸惊模拟" difficulty="NORMAL" onBack=${onBack}>
    <div class="proto-body"><section class="proto-stage"><${ProtocolScene} difficulty="NORMAL" />
      <div class="proto-brief"><span class="proto-brief__code num">ZHAJING</span><b class="proto-brief__name">炸惊模拟</b>
        <p>惊变卡牌 · 专属棋库 · 锻造器 · 独立经济与首领规则</p></div></section>
      <section class="proto-side"><div class="proto-list"><article class="pcard is-on">
        <span class="pcard__head"><${Icon} name="users" /><span class="pcard__name">炸惊模拟</span></span>
        <span class="pcard__effects"><span>我方惊变与敌方惊变</span><span>20 格候战区 · 不计排位</span></span>
      </article></div>
      <div class="proto-foot">
        <label class="east-capacity">房间人数<select aria-label="炸惊模拟房间人数" value=${capacity}
          disabled=${!!busy} onChange=${event => setCapacity(Number(event.currentTarget.value))}>
          ${ZHAJING_CAPACITIES.map(n => html`<option key=${n} value=${n}>${n} 人</option>`)}
        </select><span>娱乐模式 · 不计排位</span></label>
      <button type="button" class="proto-start" disabled=${!online || !!busy} onClick=${() => onCreate({ mode: capacity === 1 ? 'solo' : 'coop', variant: ZHAJING_VARIANT, difficulty: 'ZHAJING', capacity, ranked: false })}>
        <span class="proto-start__mark"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span>
        <span class="proto-start__label">创建房间</span><span class="proto-start__deco"></span>
      </button></div></section></div>
  <//>`;
}
