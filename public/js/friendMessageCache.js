// Account-scoped, durable browser history. No expiry: the server's 24-hour TTL
// must never remove messages that have already reached this device.
const listeners = new Set();
let opening;
function database() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open('stronghold-friend-messages', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('messages', { keyPath: ['account', 'target', 'seq'] });
      db.createObjectStore('sync', { keyPath: ['account', 'target'] });
    };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opening = null; }; resolve(db); };
    request.onerror = () => { opening = null; reject(request.error); };
    request.onblocked = () => { opening = null; reject(new Error('私信本机存储暂不可用')); };
  });
  return opening;
}
const range = (account, target, before = Number.MAX_SAFE_INTEGER) => IDBKeyRange.bound([account, target, 0], [account, target, before], false, true);
export const onFriendMessageCache = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export async function saveFriendMessages(account, target, items, syncedThrough) {
  if (!account || !target || !Array.isArray(items)) return;
  const db = await database();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(['messages', 'sync'], 'readwrite');
    for (const item of items) transaction.objectStore('messages').put({ ...item, account, target });
    if (Number.isSafeInteger(syncedThrough)) transaction.objectStore('sync').put({ account, target, through: syncedThrough });
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('私信本机存储失败'));
  });
  for (const listener of listeners) listener(account, target);
}
export async function friendMessageSyncPosition(account, target) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('sync').objectStore('sync').get([account, target]);
    request.onsuccess = () => resolve(request.result?.through || 0); request.onerror = () => reject(request.error);
  });
}
export async function localFriendMessages(account, target, before, limit = 50) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const rows = [], request = db.transaction('messages').objectStore('messages').openCursor(range(account, target, before), 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length === limit) return resolve({ items: rows.reverse(), hasOlder: !!cursor });
      const { account: _account, target: _target, ...message } = cursor.value;
      rows.push(message); cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}
