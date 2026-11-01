#!/usr/bin/env node
// Generate preload records for the shipped native facility/tool models.
// Existing pack metadata for unrelated resources remains unchanged.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestUrl = '/assets/mizuki/native-facilities/manifest.json';
const manifest = JSON.parse(await fs.readFile(path.join(root, 'public', manifestUrl), 'utf8'));
const urls = new Set([manifestUrl, '/data/mizuki/runtime-ui.json']);
for (const url of ['/assets/mizuki/library/manifest.json', '/assets/mizuki/fx/manifest.json',
  '/assets/mizuki/fx/index.json', '/assets/mizuki/fx/textures.json', '/assets/mizuki/native-facilities/fx/manifest.json',
  '/assets/mizuki/native-facilities/fx/index.json', '/assets/mizuki/native-facilities/fx/textures.json']) urls.add(url);
const diceFx = JSON.parse(await fs.readFile(path.join(root, 'public/assets/mizuki/native-facilities/fx/manifest.json'), 'utf8'));
for (const group of ['fx/prefabs', 'fx/tex', 'fx/mesh'])
  for (const record of Object.values(diceFx.groups[group])) {
    urls.add(record.path); if (record.half) urls.add(record.half);
  }
const library = JSON.parse(await fs.readFile(path.join(root, 'public/assets/mizuki/library/manifest.json'), 'utf8'));
urls.add(library.groups.items.rogue_2_dice_battle1.path);
for (const spine of Object.values(manifest.spines || {})) {
  for (const url of [spine.skel, spine.atlas, ...(spine.textures || [])]) if (url) urls.add(url);
}
const mime = { '.png': 'image/png', '.webp': 'image/webp', '.atlas': 'text/plain', '.skel': 'application/octet-stream', '.json': 'application/json' };
const additions = await Promise.all([...urls].map(async url => {
  const file = path.join(root, url.startsWith('/data/') ? '' : 'public', url);
  const content = await fs.readFile(file);
  return { url, version: createHash('sha256').update(content).digest('hex'), bytes: content.length,
    type: mime[path.extname(file)] || 'application/octet-stream' };
}));
const files = ['data/resource-preload.json', 'data/resource-preload.json.gz',
  'data/resource-preload.runtime.json.gz', 'data/resource-preload.local.json'];
for (const file of files) {
  const target = path.join(root, file), compressed = file.endsWith('.gz');
  const source = await fs.readFile(target);
  const doc = JSON.parse((compressed ? gunzipSync(source) : source).toString('utf8'));
  for (const group of ['required', 'optional', 'voice']) doc.groups[group] = doc.groups[group].filter(entry => !urls.has(entry.url));
  doc.groups.required.push(...additions);
  doc.groups.required.sort((a, b) => a.url.localeCompare(b.url));
  const content = Buffer.from(JSON.stringify(doc));
  await fs.writeFile(target, compressed ? gzipSync(content, { level: 9, mtime: 0 }) : content);
}
console.log('Indexed ' + additions.length + ' native Mizuki facility/tool resources in the four shipped preload manifests.');
