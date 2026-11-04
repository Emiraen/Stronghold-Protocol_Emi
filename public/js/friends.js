import { net } from './net.js';
import { createStore } from './store.js';
import { saveFriendMessages, friendMessageSyncPosition } from './friendMessageCache.js';

const empty = () => ({ selfId: null, epoch: null, revision: 0, friends: [], requests: [], outgoing: [], invitations: [], threads: [], loaded: false, error: '' });
export const friendsStore = createStore(empty());
export function applyFriends(state) {
  if (!state?.selfId) return;
  const current = friendsStore.get();
  if (current.epoch && current.epoch === state.epoch && state.selfId === current.selfId
    && Number.isFinite(state.revision) && state.revision <= current.revision) return;
  friendsStore.set({ ...state, threads: state.threads || [], loaded: true, error: '' });
  if (installed) queueArchive(state);
}
export async function friendAction(action, fields = {}) {
  if (net.status !== 'online') throw new Error('连接中断，请稍后重试');
  const account = friendsStore.get().selfId;
  const reply = await net.request('friends.action', { action, ...fields });
  if (account && account !== friendsStore.get().selfId) throw new Error('当前账号已变化，请重新打开好友列表');
  if (reply.t !== 'friends.result' || reply.action !== action || !reply.result) throw new Error('好友服务未返回有效结果，请重试');
  if (action === 'list') applyFriends(reply.result);
  if (action === 'message.list' || action === 'message.send') {
    const items = reply.result.items || [reply.result.message];
    try { await saveFriendMessages(account, fields.targetId, items); }
    catch { friendsStore.set({ cacheError: '私信已同步，但本机记录保存失败' }); }
  }
  return reply.result;
}
export const unreadFriendMessages = (state, targetId = null) => (state.threads || []).reduce((sum, row) =>
  sum + (targetId == null || row.targetId === targetId ? Math.max(0, Number(row.unread) || 0) : 0), 0);
let installed = false;
let archivePending = null, archiving = false;
function queueArchive(state) {
  archivePending = state;
  if (!archiving) void archiveMessages();
}
async function archiveMessages() {
  archiving = true;
  try {
    while (archivePending) {
      const state = archivePending; archivePending = null;
      for (const thread of state.threads || []) {
        let position = await friendMessageSyncPosition(state.selfId, thread.targetId);
        while (position < thread.lastSeq && net.status === 'online' && friendsStore.get().selfId === state.selfId) {
          const result = await friendAction('message.list', { targetId: thread.targetId, afterSeq: position });
          const next = result.items.at(-1)?.seq || result.thread?.lastSeq || thread.lastSeq;
          if (next <= position) break;
          await saveFriendMessages(state.selfId, thread.targetId, result.items, next); position = next;
        }
      }
    }
  } catch {
    // Retry on the next presence snapshot or reconnect; no busy polling during combat.
  } finally { archiving = false; }
}
export function installFriendsSync() {
  if (installed) return;
  installed = true;
  net.on('welcome', msg => { if (!msg.transferred) friendsStore.set(empty()); });
  net.on('serverSwitch', () => friendsStore.set(empty()));
  net.on('friends.state', applyFriends);
  net.on('rank.me', msg => {
    if (!msg.profileId) return;
    if (friendsStore.get().selfId && friendsStore.get().selfId !== msg.profileId) friendsStore.set(empty());
    friendAction('list').catch(error => friendsStore.set({ error: error.message }));
  });
}
