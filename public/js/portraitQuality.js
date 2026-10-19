import { createStore, savePref } from './store.js';

// Compatibility for pages holding older module references. HD artwork is no longer enabled or downloaded.
export const portraitQualityStore = createStore({
  enabled: false, status: 'idle', done: 0, total: 0, bytes: 0, totalBytes: 0,
  active: 0, pending: 0, failed: 0, error: null,
});
savePref('hdPortraits', false);
export function initPortraitQuality() {}
export function retainHdPortrait() { return () => {}; }
export function retryHdPortraits() {}
export function setHdPortraitsEnabled() {
  savePref('hdPortraits', false);
  portraitQualityStore.set({ enabled: false });
}
