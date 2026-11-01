import { useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { RelicOverlay, RelicCodex, PositiveSlotOverlay, normalizeRelicDraft } from './relics.js';
import { net } from '../net.js';
import { toastError } from './toasts.js';

export function AnnihilationRelicUi({ pub, priv, myId, spectator, codexOpen = false, onCodexClose }) {
  const [busy, setBusy] = useState(null);
  const [seen, setSeen] = useState(null);
  if (spectator || pub?.difficulty !== 'ANNIHILATION' || !priv?.relics) return null;
  const relics = priv.relics;
  const draft = pub.phase === 'PREP' && priv.alive !== false ? normalizeRelicDraft(priv) : null;
  const reveal = relics.reveal;
  const pending = reveal?.kind === 'positive' && reveal.pending && seen !== reveal.seq;
  const request = async (payload, key) => {
    if (busy !== null) return;
    setBusy(key);
    try { await net.request('g.relic', payload); } catch (error) { toastError(error); }
    finally { setBusy(null); }
  };
  const dismiss = async () => {
    try { await net.request('g.relicSeen', {}); setSeen(reveal.seq); }
    catch (error) { toastError(error); }
  };
  return html`<div class="annihilation-relic-ui">
    <${RelicCodex} open=${codexOpen} owned=${relics.owned} onClose=${onCodexClose} />
    ${pending ? html`<${PositiveSlotOverlay} key=${reveal.seq} card=${reveal} myId=${myId} onClose=${dismiss} />` : null}
    ${draft && !pending ? html`<${RelicOverlay} key=${draft.id} draft=${draft} myId=${myId} busyIdx=${busy}
      onPick=${idx => request({ idx }, idx)} onStart=${() => request({ start: true }, 'spin')} />` : null}
  </div>`;
}
