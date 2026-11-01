import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../public/js/store.js';
import { loadFxList, resetFxList } from '../public/js/render/vfx/available.js';

test('native effects select and cache each mode list without contaminating ordinary games', async () => {
  const before = store.get();
  const calls = [];
  const fetchList = async url => { calls.push(url); return { ok: true, json: async () => ({ url }) }; };
  try {
    resetFxList();
    store.set({ room: { variant: 'entertainment_zhajing', difficulty: 'ZHAJING' } });
    assert.equal((await loadFxList(fetchList)).url, '/data/zhajing/local-fx.json');
    assert.equal((await loadFxList(fetchList)).url, '/data/zhajing/local-fx.json');
    store.set({ room: { variant: '', difficulty: 'NORMAL' } });
    assert.equal((await loadFxList(fetchList)).url, '/data/local-fx.json');
    store.set({ room: { variant: 'entertainment_zhajing' } });
    assert.equal((await loadFxList(fetchList)).url, '/data/zhajing/local-fx.json');
    assert.deepEqual(calls, ['/data/zhajing/local-fx.json', '/data/local-fx.json']);
  } finally { store.set(before); resetFxList(); }
});
