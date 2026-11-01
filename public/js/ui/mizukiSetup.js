import { useEffect, useRef } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { ProtocolScene, StampRing } from './protocolScene.js';
import { MIZUKI_CAPACITIES } from '../../../shared/mizuki-constants.js';
import { MIZUKI_DIFFICULTIES } from './mizukiDifficultyData.js';

export function MizukiSetup({ Frame, onBack, onCreate, online, busy, grade, onGrade, capacity, onCapacity }) {
  const list = useRef(null);
  const selected = MIZUKI_DIFFICULTIES.find(item => item.grade === grade) || MIZUKI_DIFFICULTIES[0];
  const locked = !online || !!busy;
  useEffect(() => {
    const group = list.current;
    const card = group?.querySelector('[aria-checked="true"]');
    if (!card) return;
    const top = card.getBoundingClientRect().top - group.getBoundingClientRect().top + group.scrollTop;
    if (card.offsetHeight >= group.clientHeight || top < group.scrollTop) group.scrollTop = top;
    else if (top + card.offsetHeight > group.scrollTop + group.clientHeight) {
      group.scrollTop = top + card.offsetHeight - group.clientHeight;
    }
  }, [selected.grade]);
  const navigate = event => {
    if (locked || !event.target.matches('[role=radio]')) return;
    const steps = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    let next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 18;
    else if (Object.hasOwn(steps, event.key)) next = (selected.grade + steps[event.key] + 19) % 19;
    else return;
    event.preventDefault();
    onGrade(next);
    list.current?.querySelector(`[data-mz-lobby-difficulty="${next}"]`)?.focus({ preventScroll: true });
  };
  return html`<${Frame} title="水月联合探索" en="MIZUKI EXPEDITION" modeName="娱乐模式 · 不计排位" onBack=${onBack}>
    <div class="proto-body mizuki-setup" style="--d-color:#8bc9ff">
      <section class="proto-stage">
        <${ProtocolScene} key=${selected.grade} difficulty="NORMAL" />
      </section>
      <section class="proto-side">
        <div ref=${list} class="proto-list" role="radiogroup" aria-label="水月探索难度" onKeyDown=${navigate}>
          ${MIZUKI_DIFFICULTIES.map(item => html`<button key=${item.grade} type="button"
            class=${'pcard' + (selected.grade === item.grade ? ' is-on' : '')}
            role="radio" aria-checked=${selected.grade === item.grade} tabindex=${selected.grade === item.grade ? 0 : -1}
            aria-label=${`N${item.grade}`} aria-describedby=${`mz-difficulty-rule-${item.grade}`}
            data-mz-lobby-difficulty=${item.grade} disabled=${locked} onClick=${() => onGrade(item.grade)}>
            <span class="pcard__glow" aria-hidden="true"></span>
            <span class="pcard__head"><span class="pcard__name num">N${item.grade}</span></span>
            <span class="pcard__desc" id=${`mz-difficulty-rule-${item.grade}`}>${item.grade ? '本级新增：' + item.ruleDesc : '无额外难度减益'}</span>
            ${item.grade ? html`<span class="pcard__effects mizuki-setup__card-growth">${item.addDesc}</span>` : null}
            <span class="pcard__stamp" aria-hidden="true"><${StampRing} /><span class="pcard__tick"><${Icon} name="check" /></span><span class="pcard__ok">已选定</span></span>
          </button>`)}
        </div>
        <div class="proto-foot">
          <label class="east-capacity">房间人数<select aria-label="水月联合探索房间人数" value=${capacity}
            disabled=${!!busy} onChange=${event => onCapacity(Number(event.currentTarget.value))}>
            ${MIZUKI_CAPACITIES.map(n => html`<option key=${n} value=${n}>${n} 人</option>`)}
          </select><span>娱乐模式 · 不计排位</span></label>
          <p class="proto-hint">${!online ? '正在连接服务器…' : '房间码邀请 · 仅限真人 · 不参与自动匹配'}</p>
          <button type="button" class="proto-start" disabled=${locked} onClick=${onCreate}>
            <span class="proto-start__mark" aria-hidden="true"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span>
            <span class="proto-start__label">${busy === 'create' ? '创建中…' : '创建水月探索房间'}</span>
            <span class="proto-start__deco" aria-hidden="true"></span>
          </button>
        </div>
      </section>
    </div>
  <//>`;
}
