import { useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
import { ANNIHILATION_VARIANT } from '../../../shared/annihilation-constants.js';
import { ProtocolScene } from './protocolScene.js';
const LEVELS = [
  ['蚀流 1', '湮灭基础规则，20 回合，不启用藏品。'],
  ['蚀流 2', '启用正面藏品与负面藏品三选一。'],
  ['蚀流 3', '敌方生命与攻击额外提升 20%，增加首领与隐秘核心阶段。'],
  ['蚀流 4', '更频繁的负面藏品和决策藏品奖励。'],
  ['蚀流 5', '延长至 30 回合，增加敌人种类与首领阶段。'],
  ['蚀流 6 · 无尽湮灭', '无最终回合、无毒雾；30 回合后每三回合一组首领与隐秘核心。'],
];
export function AnnihilationSetup({ Frame, onBack, onCreate, online, busy }) {
  const [erosion, setErosion] = useState(1);
  const [mode, setMode] = useState('coop');
  const [capacity, setCapacity] = useState(4);
  return html`<${Frame} title="湮灭模拟" en="ANNIHILATION SIMULATION" modeName="娱乐模式 · 不计排位" onBack=${onBack}>
    <div class="proto-body annihilation-setup">
      <section class="proto-stage" style="--d-color:#e73118">
        <${ProtocolScene} key=${erosion} difficulty="ANNIHILATION" />
        <div class="proto-brief">
        <span class="proto-brief__code num">ANNIHILATION / EROSION ${erosion}</span>
        <b class="proto-brief__name">${LEVELS[erosion - 1][0]}</b>
        <p>${LEVELS[erosion - 1][1]}</p>
        <p>湮灭专属规则：敌方指数成长、致命地形、混乱索敌。藏品从蚀流 2 启用。</p>
        <p>制作：B站伊佐那邪 · v3.1.0</p>
      </div></section>
      <section class="proto-side"><div class="proto-list" role="radiogroup" aria-label="湮灭蚀流等级">
        ${LEVELS.map(([name, desc], index) => html`<button type="button" class=${'pcard' + (erosion === index + 1 ? ' is-on' : '')}
          role="radio" aria-checked=${erosion === index + 1} onClick=${() => setErosion(index + 1)}>
          <span class="pcard__head"><span class="pcard__name">${name}</span></span><span class="pcard__desc">${desc}</span>
        </button>`)}
      </div><div class="proto-foot">
        <label class="east-capacity">模拟方式<select aria-label="湮灭模拟方式" value=${mode} onChange=${e => setMode(e.currentTarget.value)}>
          <option value="coop">同盟模拟</option><option value="solo">独立模拟</option>
        </select></label>
        ${mode === 'coop' ? html`<label class="east-capacity">房间人数<select aria-label="湮灭房间人数" value=${capacity} onChange=${e => setCapacity(Number(e.currentTarget.value))}>
          ${[1, 2, 3, 4].map(n => html`<option value=${n}>${n} 人</option>`)}
        </select><span>房号邀请 / 手动 AI</span></label>` : null}
        <${Button} variant="amber" size="lg" block=${true} disabled=${!online || !!busy} loading=${busy === 'annihilation'}
          onClick=${() => onCreate({ mode, variant: ANNIHILATION_VARIANT, capacity: mode === 'solo' ? 1 : capacity,
            difficulty: 'ANNIHILATION', erosion, ranked: false })}>创建湮灭模拟<//>
      </div></section>
    </div>
  <//>`;
}
