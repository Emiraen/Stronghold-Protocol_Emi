import { acquireResourceUrl, hdPortraitUrl, win7PortraitUrl } from '../resourceCache.js';
import { PORTRAIT_FRAMES } from './portraitFrames.js';

const framed = new Map();
let rendering = Promise.resolve();

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (error) => {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      if (error) { image.removeAttribute('src'); reject(error); }
      else resolve(image);
    };
    const timer = setTimeout(() => finish(new Error('立绘裁切图加载超时。')), 20000);
    image.crossOrigin = 'anonymous';
    image.onload = () => finish();
    image.onerror = () => finish(new Error('立绘裁切图不可用。'));
    image.src = url;
  });
}

// The matrix maps SD pixels to the original HD artwork. Invert it into the SD-shaped display viewport.
export function frameTransform(frame, scale) {
  const [a, b, x, c, d, y] = frame;
  const determinant = a * d - b * c;
  if (![a, b, x, c, d, y, scale].every(Number.isFinite) || determinant <= 0.000001) {
    throw new Error('立绘裁切参数无效。');
  }
  return [scale * d / determinant, -scale * c / determinant,
    -scale * b / determinant, scale * a / determinant,
    scale * (b * y - d * x) / determinant, scale * (c * x - a * y) / determinant];
}

async function renderPortrait(src, frame) {
  const original = await acquireResourceUrl(hdPortraitUrl(src), { cachedOnly: true });
  let canvas;
  let images;
  try {
    // Read the SD silhouette from the same Win7 host; CORS is required for the resulting display Blob.
    const decoded = await Promise.allSettled([loadImage(original.url), loadImage(win7PortraitUrl(src))]);
    images = decoded.filter(item => item.status === 'fulfilled').map(item => item.value);
    const failed = decoded.find(item => item.status === 'rejected');
    if (failed) throw failed.reason;
    const [art, mask] = images;
    if (art.naturalWidth !== frame[6] || art.naturalHeight !== frame[7]
      || mask.naturalWidth !== 180 || mask.naturalHeight !== 360) throw new Error('立绘尺寸与裁切参数不符。');
    // Keep native detail within the crop, while bounding memory on mobile devices.
    const nativeScale = Math.max(Math.hypot(frame[0], frame[3]), Math.hypot(frame[1], frame[4]));
    const width = Math.ceil(180 * Math.max(1, Math.min(4, nativeScale)));
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = width * 2;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('立绘裁切画布不可用。');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.setTransform(...frameTransform(frame, width / 180));
    context.drawImage(art, 0, 0);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = 'destination-in';
    context.drawImage(mask, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => {
      if (value) resolve(value); else reject(new Error('立绘裁切图生成失败。'));
    }, 'image/png'));
    return URL.createObjectURL(blob);
  } finally {
    original.release();
    for (const image of images || []) image.removeAttribute('src');
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

export async function acquireFramedPortrait(src) {
  const path = new URL(src, globalThis.location?.href || 'http://localhost/').pathname;
  const frame = PORTRAIT_FRAMES[path];
  if (!frame) throw new Error('此立绘尚无匹配的裁切参数。');
  let entry = framed.get(path);
  if (!entry) {
    entry = { refs: 0, url: null, promise: null };
    // Serial generation avoids decoding several 2980px originals at once on a phone.
    const task = rendering.then(() => renderPortrait(src, frame));
    rendering = task.catch(() => {});
    entry.promise = task.then(url => { entry.url = url; return url; }).catch(error => {
      if (framed.get(path) === entry) framed.delete(path);
      throw error;
    });
    framed.set(path, entry);
  }
  entry.refs++;
  try {
    const url = await entry.promise;
    let released = false;
    return { url, release() {
      if (released) return;
      released = true;
      if (--entry.refs === 0) {
        URL.revokeObjectURL(url);
        if (framed.get(path) === entry) framed.delete(path);
      }
    } };
  } catch (error) { entry.refs--; throw error; }
}
