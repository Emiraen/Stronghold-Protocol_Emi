const LEGACY_HOST = '121.199.43.133';
const NEW_URL = 'https://emiraen.top/';
const ANNOUNCEMENT = '新地址已上线！点击跳转emiraen.top，加入Q群964356269获取最新安装包';

if (location.hostname === LEGACY_HOST) {
  const dialog = document.createElement('dialog');
  dialog.className = 'legacy-address-notice';
  dialog.setAttribute('aria-labelledby', 'legacy-address-title');
  dialog.innerHTML = `
    <section class="legacy-address-notice__panel">
      <p class="legacy-address-notice__eyebrow">STRONGHOLD PROTOCOL</p>
      <h1 id="legacy-address-title">新地址已上线！</h1>
      <a class="legacy-address-notice__link" href="${NEW_URL}">点击跳转 emiraen.top</a>
      <p>加入QQ群 <strong>964356269</strong> 获取最新安装包</p>
      <label class="legacy-address-notice__label" for="legacy-address-copy">可复制公告</label>
      <textarea id="legacy-address-copy" readonly rows="3">${ANNOUNCEMENT}</textarea>
      <div class="legacy-address-notice__actions">
        <button type="button" data-copy>复制公告</button>
        <button type="button" data-export>导出本机资源缓存</button>
        <button type="button" data-close>继续使用旧地址</button>
      </div>
      <p class="legacy-address-notice__status" role="status" aria-live="polite">
        旧地址缓存不会清除。更换到新域名后，可在新站资源管理中导入导出的资源包。
      </p>
    </section>`;
  document.body.append(dialog);

  const status = dialog.querySelector('.legacy-address-notice__status');
  const text = dialog.querySelector('textarea');
  dialog.querySelector('[data-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(ANNOUNCEMENT);
    } catch {
      text.focus(); text.select();
      document.execCommand('copy');
    }
    status.textContent = '公告文字已复制。';
  });
  dialog.querySelector('[data-export]').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    status.textContent = '正在校验并导出本机已缓存资源…';
    try {
      const { resourceCache } = await import('./resourceCache.js');
      await resourceCache.check();
      const blob = await resourceCache.exportPack();
      if (!blob) throw new Error(resourceCache.getState().pack.error || '没有可导出的已缓存资源。');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'Stronghold-resources.sprpack';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      status.textContent = '资源包已导出。进入新站后，在资源管理中选择“导入资源包”。';
    } catch (error) {
      status.textContent = error?.message || '导出失败，请稍后重试。';
    } finally {
      button.disabled = false;
    }
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.showModal();

  const style = document.createElement('style');
  style.textContent = `
    .legacy-address-notice { width: min(520px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); padding: 0; overflow: auto; color: #e9f0ec; background: #101714; border: 1px solid #4ed8af; box-shadow: 0 18px 60px #000b; }
    .legacy-address-notice::backdrop { background: #050807c9; backdrop-filter: blur(3px); }
    .legacy-address-notice__panel { padding: 22px; font: 15px/1.55 system-ui, sans-serif; }
    .legacy-address-notice__eyebrow { margin: 0 0 8px; color: #82d9bb; font-size: 11px; }
    .legacy-address-notice h1 { margin: 0 0 12px; font-size: 25px; }
    .legacy-address-notice p { margin: 10px 0; }
    .legacy-address-notice__link { display: inline-block; color: #82e7c3; font-weight: 700; text-decoration: underline; }
    .legacy-address-notice__label { display: block; margin: 14px 0 5px; color: #a9b9b1; font-size: 12px; }
    .legacy-address-notice textarea { box-sizing: border-box; width: 100%; padding: 9px; resize: vertical; color: inherit; background: #18211d; border: 1px solid #52645a; font: inherit; }
    .legacy-address-notice__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .legacy-address-notice button { min-height: 40px; padding: 8px 12px; color: inherit; background: #1c342c; border: 1px solid #4c997d; font: inherit; cursor: pointer; }
    .legacy-address-notice button:disabled { opacity: .6; cursor: wait; }
    .legacy-address-notice__status { color: #a9b9b1; font-size: 12px; }
    @media (max-width: 520px) { .legacy-address-notice__panel { padding: 16px; } .legacy-address-notice h1 { font-size: 21px; } }
  `;
  document.head.append(style);
}
