// 干员持有和 DIY 使用独立局外配置；不替换 A 的服务器档案调配页面。
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal, Spinner, confirmDialog } from '../ui/components.js';
import { data, useData } from '../data.js';
import { loadoutStore, closeLoadout, setNotOwned, setDiyPicks, applyOwnershipImport, applyDiyImport } from '../ui/loadoutSync.js';
import { OwnershipPanel, useOwnershipRoster } from './ownership.js';
import { DiyPanel, diyData } from './diy.js';
import { setOwned, serializeOwnership, parseOwnershipImport } from '../ui/ownershipModel.js';
import { setPick, sanitizeDiyPicks, serializeDiy, parseDiyImport } from '../ui/diyModel.js';
import { t } from '../../../shared/i18n.js';
import { toast } from '../ui/toasts.js';
import { copyText } from '../ui/clipboard.js';
import { downloadText, readFileText } from './loadout.js';
import { OWNERSHIP_IMPORT_MAX_BYTES } from '../ui/ownershipModel.js';
import { DIY_IMPORT_MAX_BYTES } from '../ui/diyModel.js';

export function LoadoutTabs({ tab }) {
  return html`<nav class="lo-tabs" role="tablist" aria-label=${t('干员配置')}>
    ${[['loadout', '干员调配'], ['ownership', '干员持有'], ['diy', '自选编队']].map(([id, label]) => html`<button type="button" role="tab" class=${`lo-tab${tab === id ? ' is-on' : ''}`} aria-selected=${tab === id} onClick=${() => loadoutStore.set({ tab: id })}>${t(label)}</button>`)}
  </nav>`;
}

export function RosterPreferences({ st }) {
  const ready = useData('chess', 'bonds', 'assets', 'local', 'backups');
  const roster = useOwnershipRoster(ready);
  const [io, setIo] = useState(null);
  const fileRef = useRef(null);
  const readSerial = useRef(0);
  const diy = st.tab === 'diy';
  const title = diy ? t('自选编队') : t('干员持有');
  const loaded = ready && data.get('chess') && data.get('backups');
  useEffect(() => { setIo(null); return () => { readSerial.current++; }; }, [st.tab]);
  const closeIo = () => { readSerial.current++; setIo(null); };
  const pickFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    if (file.size > (diy ? DIY_IMPORT_MAX_BYTES : OWNERSHIP_IMPORT_MAX_BYTES)) { toast(t('内容过长，无法导入'), 'error'); return; }
    const serial = ++readSerial.current;
    try {
      const text = await readFileText(file);
      if (serial === readSerial.current) setIo({ mode: 'import', text });
    } catch { if (serial === readSerial.current) toast(t('无法读取文件'), 'error'); }
  };
  useEffect(() => {
    const key = (e) => {
      if (document.querySelector('.modal')) return;
      if (e.key === 'Escape') { e.preventDefault(); closeLoadout(); }
      if (e.key.length === 1 || e.key === 'Escape') e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  const reset = async () => {
    if (await confirmDialog({ title: diy ? t('清空自选编队') : t('全部持有'), text: t('修改将在下一局生效'), danger: true })) {
      if (diy) setDiyPicks({}); else setNotOwned([]);
    }
  };
  const apply = () => {
    const r = diy ? parseDiyImport(io.text) : parseOwnershipImport(io.text);
    if (!loaded || (diy && !st.diyKitted)) return;
    if (!r.ok) { toast(t(r.error), 'error'); return; }
    const result = diy ? applyDiyImport(r.picks, diyData(), st.diyKitted) : applyOwnershipImport(r.notOwned, id => data.lookup('chess', id));
    setIo(null);
    toast(t('已导入 {n} 项，忽略 {dropped} 项', { n: result.applied, dropped: result.dropped }), 'success');
  };
  return html`<div class="lo" role="dialog" aria-modal="true" aria-label=${title}>
    <div class="lo__bg" aria-hidden="true"></div>
    <header class="lo-top">
      <${Button} variant="ghost" icon="chevronLeft" onClick=${closeLoadout}>${t('返回')}<//>
      <h1>${title}</h1>
      <div class="lo-top__right">
        <span role="status">${t(({ pending: '保存中…', sending: '同步中…', synced: '已同步', locked: '本局已锁定 · 下一局生效', error: '同步失败' })[diy ? st.diySync : st.ownSync] || '')}</span>
        <${Button} size="sm" disabled=${!loaded} onClick=${() => setIo({ mode: 'export', text: diy ? serializeDiy(st.diy) : serializeOwnership(st.notOwned) })}>${t('导出')}<//>
        <${Button} size="sm" disabled=${!loaded || (diy && !st.diyKitted)} onClick=${() => setIo({ mode: 'import', text: '' })}>${t('导入')}<//>
        <${Button} size="sm" onClick=${reset}>${diy ? t('清空自选编队') : t('全部持有')}<//>
      </div>
    </header>
    <${LoadoutTabs} tab=${st.tab} />
    <p class="lo-note">${t('局外设置：修改将在下一局生效，不改变当前模拟。')}</p>
    ${!ready ? html`<div class="lo-loading"><${Spinner} /></div>` : !loaded ? html`<p class="lo-note">${t('干员或替补数据未载入，无法编辑配置。')}</p>` : diy ? html`<${DiyPanel} m=${data.get('assets')} picks=${st.diy} legal=${sanitizeDiyPicks(st.diy, diyData(), st.diyKitted)} kitted=${st.diyKitted} onSet=${(id, pick) => setDiyPicks(setPick(loadoutStore.get().diy, id, pick))} />` : html`<${OwnershipPanel} m=${data.get('assets')} roster=${roster} notOwned=${st.notOwned} onToggle=${(id, owned) => setNotOwned(setOwned(loadoutStore.get().notOwned, id, owned))} />`}
    ${io ? html`<${Modal} open=${true} title=${`${t(io.mode === 'export' ? '导出' : '导入')} · ${title}`} onClose=${closeIo} actions=${io.mode === 'import' ? html`<${Button} onClick=${() => fileRef.current?.click()}>${t('选择文件')}<//><${Button} disabled=${!io.text.trim() || !loaded || (diy && !st.diyKitted)} onClick=${apply}>${t('导入')}<//>` : html`<${Button} onClick=${async () => toast(t(await copyText(io.text) ? '已复制' : '复制失败，请手动复制'), 'info')}>${t('复制')}<//><${Button} onClick=${() => downloadText(`stronghold-${diy ? 'diy' : 'ownership'}.json`, io.text)}>${t('下载文件')}<//>`}>
      <input type="file" accept=".json,application/json,text/plain" class="lo-io__file" ref=${fileRef} onChange=${pickFile} />
      <textarea class="lo-io__text" aria-label=${title} value=${io.text} readOnly=${io.mode === 'export'} onInput=${e => setIo({ ...io, text: e.currentTarget.value })}></textarea>
    <//>` : null}
  </div>`;
}
