import { h, Button, Modal } from '../ui/components.js';
import { useRef, useState } from '../../vendor/hooks.module.js';

// The server only exposes a prompt at the invited doctor's own route boundary.
// responses in TeamExpedition remain authoritative across remounts/reconnects.
export function RecallConfirmation({ prompt, players = [], busy, error, act }) {
  const [answered, setAnswered] = useState(null);
  const [submitting, setSubmitting] = useState(null);
  const pending = useRef(false);
  if (!prompt || answered === prompt.requestId) return null;
  const leaderName = players.find(player => player.playerId === prompt.leaderId)?.name || '领队';
  const respond = async accept => {
    if (busy || pending.current) return;
    pending.current = true;
    setSubmitting(accept);
    try {
      if (await act('recallRespond', { requestId: prompt.requestId, accept })) setAnswered(prompt.requestId);
    } finally {
      pending.current = false;
      setSubmitting(null);
    }
  };
  const disabled = !!busy || submitting !== null;
  return h(Modal, { open: true, title: '是否归队？', micro: 'RECALL REQUEST', closeOnBackdrop: false,
    actions: [
      h(Button, { key: 'refuse', variant: 'secondary', disabled, loading: submitting === false,
        'data-mz-recall-response': 'refuse', onClick: () => respond(false) }, '拒绝，继续当前探索'),
      h(Button, { key: 'accept', disabled, loading: submitting === true,
        'data-mz-recall-response': 'accept', onClick: () => respond(true) }, '确认归队'),
    ] },
  h('div', { 'data-mz-recall-prompt': prompt.requestId },
    h('p', {}, leaderName + ' 邀请你返回领队所在的队伍。'),
    h('p', {}, '确认后将在团队表决通过、领队返回路线时归队；拒绝后保留当前队伍与探索进度。'),
    error ? h('p', { class: 't-red', role: 'alert' }, error) : null));
}
