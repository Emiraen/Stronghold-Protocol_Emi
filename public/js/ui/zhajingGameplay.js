import { html, Modal, Button, confirmDialog } from './components.js';
import { RichText } from './gameComponents.js';
import { useState } from '../../vendor/hooks.module.js';
import { act } from './gameActions.js';
import { data } from '../data.js';
import { loadoutOptions } from '../../../shared/protocol.js';
import { forgeOptionById, valueText, forgedEntries, forgedText } from '../../../shared/zhajing-forge.js';

export function ZhajingActions({ priv, editable }) {
  const [panel, setPanel] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (t, fields = {}) => { if (busy) return; setBusy(true); try { await act(t, fields); } finally { setBusy(false); } };
  const special = [
    ['g.specialRefresh', '特殊刷新', priv.spRefresh], ['g.mysticRefresh', '神秘商店', priv.mysticRefresh],
    ['g.sellBanteng', `出售板藤 +${priv.banteng}`, priv.banteng], ['g.cashCheque', `兑现支票 +${priv.cheque}`, priv.cheque],
  ];
  const owned = [...(priv.board || []), ...(priv.hand || [])].filter(p => p?.kind === 'chess');
  const ids = [...new Set(owned.map(p => data.lookup('chess', p.id)?.baseId || p.id))];
  const roll = priv.forge?.rolled;
  return html`<div class="zj-tools">
    <${Button} size="sm" disabled=${!editable || busy} onClick=${() => setPanel('forge')}>锻造器 ${priv.forge?.count || 0}<//>
    <${Button} size="sm" disabled=${!editable || busy} onClick=${() => setPanel('loadout')}>干员调配<//>
    <${Button} size="sm" onClick=${() => setPanel('cards')}>惊变<//>
    ${special.filter(row => row[2] > 0).map(([t, label]) => html`<${Button} key=${t} size="sm" disabled=${!editable || busy} onClick=${() => run(t)}>${label}<//>`)}
    ${priv.deathReturn ? html`<${Button} size="sm" disabled=${!editable || busy} onClick=${async () => {
      if (await confirmDialog({ title: '死亡回归', text: '使用死亡回归，结算淘汰后返回本回合整备？', okText: '使用' })) await run('g.deathReturn');
    }}>死亡回归<//>` : null}
    <${Modal} open=${panel === 'forge'} title="锻造器" onClose=${() => setPanel(null)} width="min(850px, 94vw)">
      <div class="zj-card-grid">${(roll?.picks || []).map(id => { const opt = forgeOptionById(id); return html`<${Button} key=${id} disabled=${!editable || busy} onClick=${() => run('g.forgeTake', { optId: id, rarity: roll.rarity })}>${opt?.name || id} ${opt ? valueText(opt, roll.rarity) : ''}<//>`; })}</div>
      <p>剩余 ${priv.forge?.count || 0}</p><div class="zj-effects">${forgedEntries(priv.forge?.forged || {}).map(entry => html`<p key=${entry.id}>${forgedText(entry)}</p>`)}</div>
    <//>
    <${Modal} open=${panel === 'cards'} title="惊变" onClose=${() => setPanel(null)} width="min(1000px, 94vw)">
      <div class="zj-effects">${(priv.effects || []).filter(e => e.jibian).map(e => html`<article key=${e.id}><b>${e.name}</b><${RichText} text=${e.descRaw || e.desc || ''} /></article>`)}</div>
    <//>
    <${Modal} open=${panel === 'loadout'} title="干员调配" onClose=${() => setPanel(null)} width="min(900px, 94vw)">
      <div class="zj-effects">${ids.map(id => {
        const rec = data.lookup('chess', id); const opt = loadoutOptions(rec, rec?.goldenId ? data.lookup('chess', rec.goldenId) : null);
        const saved = priv.loadout?.[id] || {};
        const save = patch => run('g.loadout', { loadout: { [id]: { ...saved, ...patch } } });
        return html`<article key=${id}><b>${rec?.name || id}</b><div class="zj-loadout">
          <label>技能 <select disabled=${!editable || busy} value=${saved.skill ?? opt.defaultSkill} onChange=${e => save({ skill: Number(e.currentTarget.value) })}>${opt.skills.map(index => html`<option value=${index}>${rec?.skills?.find(skill => skill.index === index)?.name || `技能 ${index + 1}`}</option>`)}</select></label>
          ${opt.modules.length ? html`<label>模组 <select disabled=${!editable || busy} value=${saved.module ?? opt.defaultModule} onChange=${e => save({ module: e.currentTarget.value })}><option value="none">无模组</option>${opt.modules.filter(module => module !== 'none').map(module => html`<option value=${module}>${rec?.modules?.find(m => (m.uniEquipId || m.id) === module)?.name || module}</option>`)}</select></label>` : null}
        </div></article>`;
      })}</div>
    <//>
  </div>`;
}

export function ZhajingEnemyReveal({ pub }) {
  if (!['ENEMY_JIBIAN', 'HIDDEN_JIBIAN'].includes(pub?.phase)) return null;
  const cards = pub.phase === 'HIDDEN_JIBIAN' ? pub.hiddenJibian?.cards || [] : [pub.enemyJibian?.card].filter(Boolean);
  return html`<${Modal} open=${true} title=${pub.phase === 'HIDDEN_JIBIAN' ? '隐秘惊变' : '敌方惊变'} onClose=${() => {}} width="min(1000px, 92vw)">
    <div class="zj-effects">${cards.map(card => html`<article key=${card.id}><b>${card.name}</b><${RichText} text=${card.descRaw || card.desc || ''} /></article>`)}</div>
  <//>`;
}
