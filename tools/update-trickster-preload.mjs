#!/usr/bin/env node
// Add the standalone Trickster Outbreak animation without rebuilding existing resource packs or classifications.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = '/assets/local/playercards/trickster-outbreak/card.gif';
const bytes = await fs.readFile(path.join(root, 'public', url));
if (bytes.length < 6 || !/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) {
  throw new Error('Trickster Outbreak card.gif must be a GIF image');
}
const entry = { url, version: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, type: 'image/gif' };
const files = ['data/resource-preload.json', 'data/resource-preload.runtime.json.gz'];
// Read both first: the runtime document contains existing pack range metadata that must survive intact.
const documents = await Promise.all(files.map(async file => {
  const raw = await fs.readFile(path.join(root, file));
  const doc = JSON.parse(file.endsWith('.gz') ? gunzipSync(raw) : raw.toString('utf8'));
  if (doc.schema !== 1 || !['required', 'optional', 'voice'].every(group => Array.isArray(doc.groups?.[group]))) {
    throw new Error(`Unsupported preload manifest: ${file}`);
  }
  const misplaced = ['required', 'voice'].some(group => doc.groups[group].some(item => item.url === url));
  if (misplaced) throw new Error(`Trickster Outbreak GIF must belong only to optional: ${file}`);
  const existing = doc.groups.optional.findIndex(item => item.url === url);
  if (existing < 0) doc.groups.optional.push(entry);
  else doc.groups.optional[existing] = entry;
  return doc;
}));
for (const [index, file] of files.entries()) {
  const raw = Buffer.from(JSON.stringify(documents[index]));
  await fs.writeFile(path.join(root, file), file.endsWith('.gz') ? gzipSync(raw, { level: 9, mtime: 0 }) : raw);
}
// The static avatar intentionally stays outside the optional manifest and is served by the game host.
console.log(`Trickster Outbreak optional animation indexed: ${entry.bytes} bytes, sha256 ${entry.version}`);
