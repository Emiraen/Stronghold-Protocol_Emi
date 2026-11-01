import { createAgentControl } from './control.js';
import { invokeAgent } from './rpc.js';

// Loaded on demand from a logged-in game tab; never imported by the game bootstrap.
export async function install() {
  if (globalThis.__SP_AI__) return globalThis.__SP_AI__;
  const app = globalThis.__SP__;
  if (!app?.store?.get()?.session?.entered || !app.store.get().me?.playerId) throw new Error('请先在当前游戏页面正常登录');
  if (!globalThis.confirm('允许 AI 控制当前登录角色、读取玩家可见战场并发送聊天？仅当前标签页有效，可随时调用 __SP_AI__.dispose() 停用。')) throw new Error('未启用 AI 控制');
  const [servers, skins, loadout] = await Promise.all([import('../servers.js'), import('../ui/skins.js'), import('../ui/loadoutSync.js')]);
  if (globalThis.__SP_AI__) return globalThis.__SP_AI__;
  if (!app.store.get().session?.entered || !app.store.get().me?.playerId) throw new Error('登录状态已改变，请重新启用');
  const api = createAgentControl({ ...app, runner: globalThis.__SP_RUNNER__,
    joinRoom: servers.joinRoom, switchServer: servers.switchServer, watchMatch: servers.watchMatch,
    appearance: { get: skins.skinsStore.get, subscribe: skins.skinsStore.subscribe, setPlayerCard: skins.setPlayerCard, setSkin: skins.setSkin, setPortrait: skins.setPortrait, setVoice: skins.setVoice, availableSkins: skins.availableSkins },
    loadout: { get: loadout.loadoutStore.get, subscribe: loadout.loadoutStore.subscribe, setEntries: loadout.setEntries, setOpsMap: loadout.setOpsMap },
  });
  const detach = api.dispose;
  let profileId = skins.skinsStore.get().profileId;
  const offIdentity = skins.skinsStore.subscribe(s => {
    if (!s.profileReady || !s.profileId) return;
    if (profileId && profileId !== s.profileId) api.dispose();
    else profileId = s.profileId;
  });
  const badge = document.createElement('button');
  badge.type = 'button'; badge.textContent = 'AI 控制已启用 · 点击停用';
  badge.setAttribute('aria-label', '停用当前标签页的 AI 控制');
  Object.assign(badge.style, { position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647', color: '#fff', background: '#38322a', border: '1px solid #d3b477', borderRadius: '5px', padding: '7px 12px', cursor: 'pointer', fontSize: '12px' });
  api.dispose = () => { detach(); offIdentity(); badge.remove(); if (globalThis.__SP_AI__ === api) delete globalThis.__SP_AI__; globalThis.removeEventListener('pagehide', api.dispose); };
  api.call = (method, params) => invokeAgent(api, method, params);
  badge.addEventListener('click', api.dispose); document.body.append(badge);
  globalThis.addEventListener('pagehide', api.dispose, { once: true });
  globalThis.__SP_AI__ = api;
  return api;
}
