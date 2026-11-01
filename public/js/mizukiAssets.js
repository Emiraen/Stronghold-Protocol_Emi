// Mizuki uses the same asset store, decoded images and required-resource cache as Stronghold.
import { h } from '../vendor/preact.module.js';
import { useEffect, useState } from '../vendor/hooks.module.js';
import { assets, loadImageElement } from './assets.js';
import { cachedFetch, fetchResourceData } from './resourceCache.js';
import { CachedImage } from './ui/cachedImage.js';
import { data } from './data.js';
import { TierChip } from './ui/components.js';
import { chessAvatarUrl, itemIconUrl, tokenAvatarUrl, enemyIconUrl } from './ui/assetUrls.js';

export function mizukiLocalAssetUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const origin = globalThis.location?.origin || 'http://localhost';
    const url = new URL(value, origin);
    if (url.origin !== origin || !/^\/(?:assets|data|fonts)\//.test(url.pathname)) return null;
    // Keep the server's content-hashed /assets/~hash/ views intact. Atlas pages
    // are supplied explicitly to the native parser, so relative URLs are safe.
    return url.pathname + url.search;
  } catch { return null; }
}

export async function fetchMizukiLocalAsset(url, options = {}) {
  const local = mizukiLocalAssetUrl(url);
  if (!local) throw Error('Resource outside Mizuki local art: ' + url);
  return local.startsWith('/data/') ? fetchResourceData(local, options) : cachedFetch(local, options);
}

export function loadMizukiLocalImage(url) {
  const local = mizukiLocalAssetUrl(url);
  if (!local) return Promise.reject(Error('Image outside Mizuki local art: ' + url));
  return loadImageElement(local);
}

export const mizukiAssets = assets;

function useMizukiManifest() {
  const [, update] = useState(0);
  useEffect(() => {
    const off = mizukiAssets.onChange(() => update(n => n + 1));
    void mizukiAssets.ready();
    return off;
  }, []);
  return mizukiAssets.manifest;
}

/** Keep the existing markup and image lifecycle while sharing Stronghold's cache. */
export function MizukiImage({ src, portraitPreview = false, ...props }) {
  return h(CachedImage, { ...props, portraitPreview, src: mizukiLocalAssetUrl(src) || undefined });
}

/** Same Stronghold thumbnail markup and classes, with this mode's resolver. */
export function MizukiUnitThumb({ kind = 'chess', id, skin = null, golden, size = 'md', tier, showTier = true, class: cls, dim = false, badge = null, title, rec = null }) {
  const manifest = useMizukiManifest();
  const [bad, setBad] = useState(null);
  let src = null, name = '', value = tier, standIn = null;
  if (kind === 'chess') {
    const record = rec || data.lookup('chess', id);
    standIn = record?.standInFor ? record : null;
    src = chessAvatarUrl(manifest, record, skin); name = record?.name || '';
    value ??= record?.tier; golden ??= !!record?.isGolden;
  } else if (kind === 'item') {
    const record = data.lookup('items', id);
    src = itemIconUrl(manifest, record); name = record?.name || '';
    value ??= record?.tier; golden ??= !!record?.isGolden;
  } else if (kind === 'token') {
    src = tokenAvatarUrl(manifest, id); name = data.lookup('tokens', id)?.name || '';
  } else if (kind === 'enemy') {
    src = enemyIconUrl(manifest, id); name = data.lookup('enemies', id)?.name || '';
  }
  const classes = ['uthumb', 'uthumb--' + size, 'uthumb--' + kind, golden && 'is-golden', dim && 'is-dim', value && 'uthumb--t' + Math.max(1, Math.min(6, value | 0)), cls].filter(Boolean).join(' ');
  return h('span', { class: classes, title: title ?? name }, h('span', { class: 'uthumb__art' }, src && bad !== src
    ? h(MizukiImage, { src, alt: '', draggable: false, loading: 'lazy', onError: () => setBad(src) })
    : h('span', { class: 'uthumb__glyph' }, [...(name || '?')][0] || '?')),
  showTier && value && kind !== 'enemy' && kind !== 'token' ? h(TierChip, { tier: value, golden, size: 'sm', class: 'uthumb__tier' }) : null,
  kind === 'token' ? h('span', { class: 'uthumb__tag' }, '召唤') : null,
  standIn ? h('span', { class: 'uthumb__si', 'data-standin': standIn.charId, 'aria-hidden': true }, '替补') : null, badge);
}
