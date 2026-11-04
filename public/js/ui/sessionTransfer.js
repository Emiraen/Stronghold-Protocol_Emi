import { useRef, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button } from './components.js';
import { net } from '../net.js';
import { store, useStore } from '../store.js';

/** Welcome carries a bounded summary only. Opening this dialog never starts a request or timer. */
export function SessionTransferHost() {
  const entered = useStore(s => s.session.entered);
  const matches = useStore(s => s.session.resumeMatches);
  const online = useStore(s => s.connection.status === 'online');
  const inRoom = useStore(s => !!s.room || !!s.spectator);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const dismiss = () => {
    if (!pending.current) store.patch('session', { resumeMatches: [] });
  };
  const transfer = async target => {
    if (pending.current || !online) return;
    pending.current = true;
    setBusy(target);
    setError('');
    try {
      await net.transferSession(target);
      store.patch('session', { resumeMatches: [] });
    } catch (error) {
      setError(String(error.detail || error.message || '转移失败，请稍后重试').slice(0, 160));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };
  if (!entered || inRoom || !matches?.length) return null;
  return html`<${Modal} open title="发现进行中的对局" width="min(400px, calc(100vw - 24px))"
      class="session-transfer" onClose=${dismiss} closeDisabled=${!!busy} closeOnBackdrop=${!busy}
      actions=${html`<${Button} variant="secondary" size="sm" disabled=${!!busy} onClick=${dismiss}>暂不转移<//>`}>
    <p class="session-transfer__hint">此账号有尚未结束的对局。转移后，原设备将退出控制，本设备继续当前进度。</p>
    <div class="session-transfer__list">
      ${matches.map(match => html`<div class="session-transfer__match" key=${match.id}>
        <div class="session-transfer__info"><strong>${match.mode === 'solo' ? '单人对局' : '合作对局'} · ${match.roomCode}</strong>
          <span>${match.online ? '原设备在线' : '原设备已断开'}</span></div>
        <${Button} variant="primary" size="sm" loading=${busy === match.id} disabled=${!online || !!busy}
          onClick=${() => transfer(match.id)}>转移到本设备<//>
      </div>`)}
    </div>
    ${error ? html`<p class="session-transfer__error" role="alert">${error}</p>` : null}
    ${!online ? html`<p class="session-transfer__hint" role="status">连接恢复后可转移。</p>` : null}
  <//>`;
}
