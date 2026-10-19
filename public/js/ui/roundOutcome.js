import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Chevrons } from './components.js';
import { PixBot } from './pixbots.js';
const cx = (...p) => p.flat().filter(Boolean).join(' ');

export function ResultDialog({ title, sub, micro, tone = 'mint', duration = 2800, onDone }) {
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!(duration > 0)) return undefined;
    const t1 = setTimeout(() => setLeaving(true), duration);
    const t2 = setTimeout(() => { setGone(true); onDone?.(); }, duration + 300);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [duration]);
  if (gone) return null;
  return html`<div class=${cx('rdialog', `rdialog--${tone}`, leaving && 'is-leaving')} role="status" aria-live="polite">
    <div class="rdialog__box">
      <div class="rdialog__art" aria-hidden="true">
        <span class="rdialog__tick rdialog__tick--tl"></span><span class="rdialog__tick rdialog__tick--tr"></span>
        <span class="rdialog__tick rdialog__tick--bl"></span><span class="rdialog__tick rdialog__tick--br"></span>
        <i class="rdialog__brk rdialog__brk--l"></i><i class="rdialog__brk rdialog__brk--r"></i>
        <${PixBot} kind=${tone === 'mint' ? 'cheer' : 'blade'} class="rdialog__bot" />
      </div>
      <div class="rdialog__text">
        ${micro ? html`<span class="rdialog__micro">${micro}</span>` : null}
        <div class="rdialog__row">
          <span class="rdialog__title">${title}</span>
          <${Chevrons} count=${3} tone=${tone} class="rdialog__chev" />
        </div>
        ${sub ? html`<span class="rdialog__sub">${sub}</span>` : null}
      </div>
      <${Chevrons} count=${3} tone=${tone} dir="left" class="rdialog__chev rdialog__chev--trim" />
    </div>
  </div>`;
}
