import { t as trA } from '../../../shared/i18n.js';
// Briefing — INFO_CHECK "1/2 确认本局信息" (research 06 §4.1, D1): enemy leader (silhouette, name,
// abilities), stage (+ its pool: 战场固定 / 战场随机（共N张）), 特训敌人 factions (icon, name, description), the difficulty
// tag, the ready count x/N with person pips, the 准备就绪 button (g.infoReady) and the countdown. The right column — 核心盟约
// / 附加盟约 rows of bond discs (disabled bonds greyed with the banned-member badge), the legend and the 本局禁用干员
// avatars — is ui/matchInfo.js MatchInfo, the same blocks the strategy draft's 本局信息 dialog shows (screens/bandDraft.js).

import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel } from '../ui/components.js';
import { useGameData, Img, RichText } from '../ui/gameComponents.js';
import { StepHeader, ExitModal } from '../ui/matchChrome.js';
import { MatchInfo, matchInfoModel } from '../ui/matchInfo.js';
import { LoadoutButton } from './loadout.js';
import { actions, act } from '../ui/gameActions.js';
import { SetupReroll } from '../ui/setupReroll.js';
import { factionTypes, sortedPlayers, phaseTotalSeconds } from '../ui/gameLogic.js';
import { enemyIconUrl, factionIconUrl } from '../ui/assetUrls.js';
import { useStore } from '../store.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** INFO_CHECK screen. */
export function BriefingScreen() {
  const pub = useStore((s) => s.match.public);
  const myId = useStore((s) => s.me.playerId);
  const solo = useStore((s) => s.room?.mode === 'solo') || String(pub?.modeId || '').includes('single');
  const gd = useGameData();
  const [exit, setExit] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!pub) return null;

  const players = sortedPlayers(pub);
  const me = players.find((p) => p.playerId === myId);
  const readyN = players.filter((p) => p.ready).length;
  const mode = gd.config?.modes?.[pub.modeId];
  const info = matchInfoModel(pub, { bonds: gd.list('bonds'), chess: gd.chess, mode });
  const boss = pub.bossId ? gd.boss(pub.bossId) : null;
  const bossEnemy = boss ? gd.enemy(boss.enemyKey) : null;
  const stage = pub.stageId ? gd.stage(pub.stageId) : null;
  // the mode's battlefield pool (config.json modes[].stages): 标准 is always 战场#01, 险境+ draw one at random
  const poolN = Array.isArray(mode?.stages) ? mode.stages.length : 0;
  const pool = poolN > 1 ? trA("战场随机（共{n}张）", { "n": (poolN) }) : poolN === 1 ? trA("战场固定") : '';
  const types = factionTypes(pub.factions);
  const factions = gd.factions?.types || {};
  const m = gd.m;

  const ready = async () => {
    if (busy || me?.ready) return;
    setBusy(true);
    await act('g.infoReady', { setupRevision: pub.setupRevision ?? 0 });
    setBusy(false);
  };

  return html`<div class=${cx('screen brief', ['entertainment_multi', 'entertainment_endless'].includes(pub.variant) && 'brief--multi')}>
    <div class="brief__bg" aria-hidden="true"></div>
    <${StepHeader} step=${1} of=${2} title=${trA("确认本局信息")} micro="BRIEFING // INFO CHECK" pub=${pub}
      total=${phaseTotalSeconds(pub, gd.config)} onExit=${() => setExit(true)} />
    <main class="brief__main">
      <section class="brief__left">
        <div class="brief-boss brackets">
          <${MicroLabel} tone="gold">${trA("ENEMY LEADER // 敌方领袖")}</${MicroLabel}>
          <div class="brief-boss__art">
            <div class="brief-boss__ring" aria-hidden="true"></div>
            ${bossEnemy ? html`<${Img} src=${enemyIconUrl(m, boss.enemyKey)} class="brief-boss__sil" fallback=${html`<span class="brief-boss__q">?</span>`} />`
              : html`<span class="brief-boss__q">?</span>`}
          </div>
          <div class="brief-boss__text">
            <h2 class="brief-boss__name">${boss?.name || bossEnemy?.name || trA("未知领袖")}</h2>
            <span class="brief-boss__when">${trA("第")} <b class="num">${mode?.bossRound ?? pub.lastRound ?? 14}</b> ${trA("回合 · 最终攻势")}</span>
            ${Array.isArray(boss?.abilities) && boss.abilities.length ? html`<ul class="brief-boss__abil">
              ${boss.abilities.slice(0, 3).map((a, i) => html`<li key=${i}><${RichText} text=${a} /></li>`)}
            </ul>` : null}
          </div>
        </div>
        <div class="brief-stage">
          <span class="brief-stage__k"><${MicroLabel}>BATTLEFIELD</${MicroLabel}>${pool ? html`<span class="brief-stage__pool">${pool}</span>` : null}</span>
          <span class="brief-stage__name"><${Icon} name="rook" />${stage?.name || pub.stageId || '—'}</span>
        </div>
        <div class="brief-factions">
          <h3 class="brief-h"><span>${trA("特训敌人")}</span><${MicroLabel}>SPECIAL ENEMIES</${MicroLabel}></h3>
          ${types.length ? types.map((t) => html`<div key=${t} class="brief-faction">
            <span class="brief-faction__icon"><${Img} src=${factionIconUrl(m, factions[t]?.icon)} /></span>
            <span class="brief-faction__text"><b>${factions[t]?.name || t}</b><span>${factions[t]?.desc || ''}</span></span>
          </div>`) : html`<p class="t-dim">${trA("本局没有特训敌人")}</p>`}
        </div>
      </section>
      <section class="brief__right">
        <${SetupReroll} pub=${pub} />
        ${pub.variant === 'entertainment_multi' ? html`<p class="multi-groups">娱乐 · 多人同盟 · 不计排位<br />
          ${(pub.poolGroups || []).map((g) => html`<span key=${g.id}>${g.playerIds.includes(myId) ? '本组 ' : ''}${g.id}：${g.size} 人共享卡池； </span>`)}
          组间并行轮选，联防按轮次接力。</p>` : null}
        ${pub.variant === 'entertainment_endless' ? html`<p class="multi-groups">娱乐 · 无尽模式 · 不计排位<br />击败原版最终首领后继续推进，每五回合迎来新的首领，敌方强度持续增长。</p>` : null}
        <${MatchInfo} model=${info} />
      </section>
    </main>
    <footer class="brief__foot">
      <${LoadoutButton} from="briefing" size="lg" class="brief-loadout" />
      <div class="brief-ready">
        <span class="brief-ready__txt">${trA("已就绪")} <b class="num">${readyN}</b><span class="num">/${players.length}</span></span>
        <span class="brief-ready__pips">${players.map((p) => html`<i key=${p.playerId} class=${cx(p.ready && 'on', p.playerId === myId && 'me')} title=${p.name}><${Icon} name="user" /></i>`)}</span>
      </div>
      <${Button} variant="primary" size="xl" icon=${me?.ready ? 'check' : me ? 'play' : 'eye'} active=${!!me?.ready} loading=${busy}
        disabled=${!!pub.rerollVote || !!me?.ready || !me} onClick=${ready}>${me?.ready ? trA("已就绪") : me ? trA("准备就绪") : trA("观战中")}<//>
    </footer>
    <${ExitModal} open=${exit} onClose=${() => setExit(false)} solo=${solo} />
  </div>`;
}
