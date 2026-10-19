import { t as trA } from '../../../shared/i18n.js';
// 从 A 原正文按职责拆分；保持原有行为。
import { html, Spinner } from '../ui/components.js';
import { useGameData } from '../ui/gameComponents.js';
import { AwayOverlay, awayStore } from '../ui/matchChrome.js';
import { phaseMode } from '../ui/gameLogic.js';
import { BriefingScreen } from './briefing.js';
import { BandDraftScreen } from './bandDraft.js';
import { ResultScreen } from './settle.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { PHASE } from '../../../shared/constants.js';
import { ProtocolBoot } from '../ui/matchIntro.js';
import { EndPlate, endPlateOf, bossIconOf, END_PLATE_MS } from '../ui/matchPlates.js';
import { usePresence } from '../ui/transitions.js';
import { sortedPlayers } from '../ui/gameLogic.js';
import { ChatPanel } from './chat.js';
import { useStore } from '../store.js';
import { MatchEnded } from './game/overlays.js';
import { MatchScreen } from './game/match.js';
import { UiPluginSlot } from '../ui/pluginSlots.js';
import { UnofficialMark } from '../ui/pluginTag.js';

export function GameScreen() {
  useEffect(() => {
    document.body.classList.add('east-match-legacy');
    return () => document.body.classList.remove('east-match-legacy');
  }, []);
  const pub = useStore((s) => s.match.public);
  const room = useStore((s) => s.room);
  const spectator = useStore((s) => s.spectator);
  const me = useStore((s) => s.me);
  const online = useStore((s) => s.connection.status === 'online');
  const inMatch = useStore((s) => !!s.room?.inMatch);
  const chatId = useStore((s) => s.matchChat.matchId);
  const hasResult = useStore((s) => !!s.match.result);
  const ended = useStore((s) => !!s.room && !s.room.inMatch && !!s.match.public);
  const away = useStore((s) => s.away, Object.is, awayStore);
  const autoplay = useStore((s) => !!(Array.isArray(s.match.public?.players) && s.match.public.players.find((p) => p && p.playerId === s.me.playerId)?.autoplay));
  const gd = useGameData();
  const endKind = useStore((s) => endPlateOf(s.match.result));
  const [bootShown, bootLeaving] = usePresence(pub?.phase === PHASE.BATTLE_CHECK && !hasResult && !spectator, 360);
  const mode = pub ? phaseMode(pub.phase) : "loading";
  const over = hasResult || mode === "result";
  const sawPlay = useRef(false);
  if (!over && ["prep", "combat", "settle"].includes(mode)) sawPlay.current = true;
  const [endStage, setEndStage] = useState(null);
  useEffect(() => {
    if (!over) { setEndStage(null); return undefined; }
    if (!sawPlay.current || spectator) return undefined;
    sawPlay.current = false; setEndStage("on");
    const a = setTimeout(() => setEndStage("leaving"), END_PLATE_MS - 320);
    const b = setTimeout(() => setEndStage("done"), END_PLATE_MS);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [over]);
  const endOn = !spectator && over && (endStage === "on" || endStage === "leaving" || (endStage == null && sawPlay.current));
  if (!pub || !gd.ready) {
    return html`<div class="screen gload">
      <${Spinner} size="lg" label=${pub ? 'LOADING DATA' : 'ENTERING SIMULATION'} />
      <p class="t-lo">${pub ? trA("正在载入模拟数据…") : trA("正在进入模拟…")}</p>
    </div>`;
  }
  let body;
  if (spectator) body = html`<${MatchScreen} />`;
  else if (over && !endOn) body = html`<${ResultScreen} />`;
  else if (mode === 'briefing') body = html`<${BriefingScreen} />`;
  else if (mode === 'draft') body = html`<${BandDraftScreen} />`;
  else body = html`<${MatchScreen} />`;
  return html`${body}
    <${UnofficialMark} room=${room} compact=${!over} class="east-plugin-mark" />
    <${UiPluginSlot} key=${over ? 'result-plugin' : 'hud-plugin'} slot=${over ? 'result.tab' : 'hud.right'} class=${over ? 'east-plugin-result' : 'east-plugin-hud'} />
    ${endOn && endKind ? html`<${EndPlate} kind=${endKind} leaving=${endStage === "leaving"} leaderIcon=${bossIconOf(gd, pub.bossId)} coreIcon=${bossIconOf(gd, pub.hiddenBossId)} />` : null}
    ${bootShown ? html`<${ProtocolBoot} players=${sortedPlayers(pub)} myId=${me.playerId} leaving=${bootLeaving} />` : null}
    ${!spectator && inMatch && !hasResult ? html`<${ChatPanel} key=${chatId} channel="match" online=${online} me=${me} />` : null}
    ${(away || autoplay) && !hasResult && mode !== 'result' && !ended ? html`<${AwayOverlay} />` : null}
    ${ended && !hasResult && mode !== 'result' ? html`<${MatchEnded} />` : null}`;
}
