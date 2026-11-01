import { h } from '../ui/components.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { useStore } from '../store.js';
import { audio } from '../audio.js';
import { ResultDialog } from '../ui/roundOutcome.js';
import { mizukiBattlePresentation } from '../mizukiBattlePresentation.js';

// Stay mounted across COMBAT -> rewards so the ordinary result animation can finish.
export function MizukiBattleOutcome() {
  const outcome = useStore(state => state.match.private?.mizuki?.battleOutcome);
  const phase = useStore(state => state.match.private?.mizuki?.phase);
  const spectator = useStore(state => state.spectator);
  const matchId = useStore(state => state.match.public?.matchId);
  const seen = useRef(outcome?.id || null);
  const playing = useRef(null);
  const run = useRef(matchId);
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (run.current !== matchId) {
      run.current = matchId; seen.current = outcome?.id || null;
      if (playing.current) mizukiBattlePresentation.release(playing.current);
      playing.current = null; setResult(null); return;
    }
    if (['MIZUKI_SQUAD', 'MIZUKI_STRATEGY', 'MIZUKI_RECRUIT_GROUP'].includes(phase)) {
      seen.current = null;
      if (playing.current) mizukiBattlePresentation.release(playing.current);
      playing.current = null; setResult(null); return;
    }
    if (!outcome?.id || seen.current === outcome.id) return;
    seen.current = outcome.id;
    if (spectator) return;
    // Autoplay may already reach another node; finish the visible battle's one animation.
    if (playing.current) return;
    mizukiBattlePresentation.begin(outcome);
    playing.current = outcome.id;
    const loss = Math.max(0, Number(outcome.lpLoss) || 0);
    setResult({ ...outcome,
      tone: loss > 0 || outcome.cleared === false ? 'red' : outcome.perfect ? 'mint' : 'orange',
      sub: loss > 0 ? `生命值减少 −${loss}` : outcome.perfect ? '完美作战！' : '本场作战未损失生命值',
    });
    audio.sfx(loss > 0 ? 'battleOverReduce' : outcome.perfect ? 'battleOverNormal' : 'battleOverNoReduce');
  }, [matchId, outcome?.id, phase, spectator]);
  return result ? h(ResultDialog, { key: result.id, title: '作战结束', micro: 'BATTLE OVER',
    tone: result.tone, sub: result.sub, duration: 2500, onDone: () => {
      mizukiBattlePresentation.release(result.id);
      playing.current = null; setResult(null);
    } }) : null;
}
