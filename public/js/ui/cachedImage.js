import { h, options } from '../../vendor/preact.module.js';
import { useCallback, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { acquireResourceUrl, resourceCache } from '../resourceCache.js';
import { data } from '../data.js';
import { personalImageFallback } from './portraitFallback.js';

function selectedSource(src) {
  const fallback = personalImageFallback(src, data.get('assets'));
  return fallback && !resourceCache.isCached(src) ? fallback : src;
}

// CSS 图片与 img 共用缓存入口；仅在失败资源补齐后重新解析。
export function useResourceUrl(src, onUnavailable) {
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const [retry, setRetry] = useState(0);
  const [resolved, setResolved] = useState(null);
  const current = useRef(null);
  const available = !!resolved && resolved === current.current && resolved.src === src;
  const failed = available && !!resolved.failed;
  const watchCache = !!src && (!available || failed || !!resourceCache.isOptional?.(src));

  useLayoutEffect(() => {
    if (!watchCache) return undefined;
    let selected = selectedSource(src);
    let cached = resourceCache.isCached(selected);
    const refresh = () => {
      const next = selectedSource(src);
      const nextCached = resourceCache.isCached(next);
      const hit = current.current;
      // Preloading extra art replaces its original fallback; clearing it restores the same operator's original.
      if (next !== selected || (resourceCache.isOptional?.(next) && nextCached !== cached)
        || (hit?.src === src && hit.failed && nextCached)) {
        selected = next;
        cached = nextCached;
        setRetry(value => value + 1);
      }
    };
    const offCache = resourceCache.subscribe(refresh);
    return offCache;
  }, [src, watchCache]);

  useLayoutEffect(() => {
    let cancelled = false;
    let resource;
    if (typeof src === 'string' && src) {
      const selected = selectedSource(src);
      const fallback = personalImageFallback(src, data.get('assets'));
      const cachedOnly = !!personalImageFallback(selected, data.get('assets')) || !!resourceCache.isOptional?.(selected);
      current.current = null;
      const request = acquireResourceUrl(selected, { cachedOnly }).catch(error => {
        if (fallback && selected !== fallback) return acquireResourceUrl(fallback);
        throw error;
      });
      request.then(result => {
        if (cancelled) { result.release(); return; }
        resource = result;
        const next = { src, url: result.url };
        current.current = next;
        setResolved(next);
      }).catch(() => {
        if (!cancelled) {
          const next = { src, url: undefined, failed: true };
          current.current = next;
          setResolved(next);
          unavailable.current?.();
        }
      });
    } else {
      current.current = null;
      setResolved(null);
    }
    return () => {
      cancelled = true;
      resource?.release();
    };
  }, [src, retry]);
  return available ? resolved.url : undefined;
}

export function CachedImage(props) {
  const { src, ref, portraitPreview = false, ...imgProps } = props;
  const element = useRef(null);
  // Retain the old preview prop as a no-op so it never becomes a DOM attribute.
  void portraitPreview;
  const url = useResourceUrl(src, () => element.current?.dispatchEvent(new Event('error')));
  const imageRef = useCallback(node => {
    element.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  useLayoutEffect(() => {
    // Preact 对已存在的 src 写入 undefined 时会留下 src=""；缺失必须移除地址。
    if (!url) element.current?.removeAttribute('src');
  }, [url]);
  return h('img', {
    key: typeof src === 'string' ? src : '',
    ...imgProps,
    src: url,
    srcSet: undefined,
    srcset: undefined,
    ref: imageRef,
  });
}

// Preact 核心把组件 ref 放在 vnode 上；只为本组件转交给 img，避免返回组件实例。
const previousVNode = options.vnode;
options.vnode = vnode => {
  if (previousVNode) previousVNode(vnode);
  if (vnode.type === CachedImage && vnode.ref != null) {
    vnode.props = { ...vnode.props, ref: vnode.ref };
    vnode.ref = null;
  }
};
