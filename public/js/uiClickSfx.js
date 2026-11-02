// One delegated listener covers native controls and HTML cards marked by hFresh.
// Capture before a handler removes its DOM; play after it runs so explicit game
// feedback can replace the generic click, even when propagation was stopped.
const ACTION = 'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], '
  + '[role="checkbox"], [role="switch"], [role="radio"], [data-ui-sfx], [data-ui-click], '
  + 'input[type="button"], input[type="submit"], input[type="reset"]';
const DISABLED = ':disabled, [disabled], [inert], [aria-disabled="true"], [aria-busy="true"], .is-disabled';
const TOGGLE = 'input[type="checkbox"], input[type="radio"], select, input[type="range"]';
const GENERIC = new Set(['click', 'back', 'confirm', 'checkbox']);
const BACK = /^(?:返回|取消|关闭|退出|離開|關閉|离开|收起|忽略|不用了|back\b|cancel\b|close\b|exit\b|leave\b|dismiss\b|ignore\b|戻る|キャンセル|취소|뒤로)/i;
const CONFIRM = /^(?:确认|确定|確認|確定|同意|接受|保存|应用|套用|开始|開始|创建|建立|加入|发送|發送|完成|继续|繼續|出发|出發|招募|购买|購買|领取|領取|删除|刪除|confirm\b|ok\b|accept\b|save\b|apply\b|start\b|create\b|join\b|send\b|continue\b|done\b|確認|決定|확인)/i;
const element = event => event?.composedPath?.().find(n => n?.nodeType === 1)
  || (event?.target?.nodeType === 1 ? event.target : event?.target?.parentElement);
const markedOptions = new WeakSet();

/** Include cards built with raw h(), as well as the common HTML components. */
export function installUiClickMarkers(options) {
  if (markedOptions.has(options)) return;
  markedOptions.add(options);
  const previous = options.vnode;
  options.vnode = vnode => {
    previous?.(vnode);
    if (typeof vnode.type === 'string' && typeof vnode.props?.onClick === 'function'
      && !['dialog', 'alertdialog', 'presentation'].includes(vnode.props.role)) {
      vnode.props = { ...vnode.props, 'data-ui-click': '' };
    }
  };
}

/** Snapshot the action's meaning before a click changes labels or unmounts it. */
export function uiClickKind(event) {
  const target = element(event);
  if (!target?.closest || target.closest(DISABLED)) return null;
  if (event.type === 'change') return target.matches(TOGGLE) ? 'checkbox' : null;
  if (!['click', 'mousedown'].includes(event.type) || event.button > 0) return null;
  // Native labels forward another click to their input. Only the committed
  // change sounds, so label/input clicks and keyboard toggles are never doubled.
  const label = target.closest('label');
  if (target.matches(TOGGLE) || label?.control?.matches?.(TOGGLE)
    || label?.querySelector?.(TOGGLE)) return null;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return null;
  const action = target.closest(ACTION);
  if (!action || action.closest(DISABLED)) return null;
  const dialog = target.closest('[role="dialog"], [role="alertdialog"]');
  if (dialog && (action === dialog || !dialog.contains(action))) return null;
  const trigger = action.getAttribute('data-ui-sfx-event');
  if (trigger ? event.type !== trigger || target !== action : event.type !== 'click') return null;
  const explicit = action.getAttribute('data-ui-sfx');
  if (explicit === 'none' || explicit === 'off') return null;
  if (GENERIC.has(explicit)) return explicit;
  const role = action.getAttribute('role');
  if (['checkbox', 'switch', 'radio'].includes(role) || action.hasAttribute('aria-checked')) return 'checkbox';
  const labelText = action.getAttribute('aria-label') || action.getAttribute('title') || action.textContent || '';
  const text = labelText.trim().replace(/\s+/g, ' ').replace(/^(?:点击|點擊|click to\s+)/i, '');
  if (text.length <= 64 && BACK.test(text)) return 'back';
  if (action.getAttribute('type') === 'submit' || text.length <= 64 && CONFIRM.test(text)) return 'confirm';
  return 'click';
}

export function installUiClickSfx({ win, play, defer = fn => setTimeout(fn, 0) }) {
  let current = null, disposed = false;
  const capture = event => {
    const kind = uiClickKind(event);
    if (!kind) return;
    const pending = { kind, handled: false };
    current = pending;
    defer(() => {
      if (current === pending) current = null;
      if (!disposed && !pending.handled) play(kind);
    });
  };
  win.addEventListener('click', capture, { capture: true, passive: true });
  win.addEventListener('mousedown', capture, { capture: true, passive: true });
  win.addEventListener('change', capture, { capture: true, passive: true });
  return {
    resolve(name) { return name === 'click' || name === 'tab' ? current?.kind || 'click' : name; },
    consume() {
      if (!current) return false;
      const handled = current.handled;
      current.handled = true;
      return handled;
    },
    dispose() {
      disposed = true;
      win.removeEventListener('click', capture, { capture: true });
      win.removeEventListener('mousedown', capture, { capture: true });
      win.removeEventListener('change', capture, { capture: true });
      current = null;
    },
  };
}
