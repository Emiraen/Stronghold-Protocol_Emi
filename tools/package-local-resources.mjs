#!/usr/bin/env node
// Build the LAN preload index and an importable SPPACK03 from installed files.
// Original Unity object dumps and extraction evidence are retained on the host;
// the pack contains the original-quality resources used by the web runtime.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';
import { splitHashedPath } from '../shared/assetPaths.js';
import { AUDIO_EXTS } from '../shared/media.js';
import { mediaUrl } from '../public/js/media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = ['required', 'optional', 'voice'];
const HEADER_LIMIT = 16 * 1024 * 1024;
const TYPES = { '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.atlas': 'text/plain', '.obj': 'text/plain', '.skel': 'application/octet-stream',
  '.bin': 'application/octet-stream', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const COMPRESS = new Set(['.json', '.atlas', '.obj', '.skel', '.bin', '.wav', '.txt', '.svg']);

function argumentsFor(argv) {
  const args = { out: path.join(ROOT, 'public/assets/Stronghold-resources-mizuki-20261029.sprpack') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) args.out = path.resolve(argv[++i]);
    else throw Error('Usage: node tools/package-local-resources.mjs [--out file.sprpack]');
  }
  return args;
}

const fileInfo = file => { try { const value = fs.statSync(file); return value.isFile() ? value : null; } catch { return null; } };
const resourceUrl = relative => '/' + relative.split(path.sep).map(encodeURIComponent).join('/');
// Gameplay resources belong to the mandatory preload even if an older index
// treated scene dressing as personalization. Music alone remains optional.
export function resourceCategory(url) {
  let pathname;
  try { pathname = decodeURIComponent(splitHashedPath(new URL(url, 'http://localhost').pathname).path); }
  catch { return null; }
  if (/^\/(?:media\/bgm\/|assets\/(?:audio\/bgm\/|local\/audio\/bgm\/|mizuki\/native-audio\/tracks\/))/.test(pathname)) return 'bgm';
  if (/^\/(?:media\/sfx\/|assets\/(?:audio\/sfx\/|local\/audio\/sfx\/|mizuki\/native-sfx\/))/.test(pathname)) return 'sfx';
  if (/^\/(?:data\/mizuki\/levels\/|assets\/(?:map\/|scene\/|local\/(?:map|scene)\/|local\/mesh\/(?:map_autochess_bkg|s_background_common|s_common_box_01|s_wind_device|trap_110)\/|mizuki\/native-(?:maps|board|reflections|gates|cameras)\/))/.test(pathname)) return 'maps';
  if (/^\/assets\/(?:(?:local\/)?spine\/enemy\/|enemy\/models?\/|mizuki\/library\/spines\/)/.test(pathname)) return 'enemyModels';
  return null;
}
export function resourceGroup(url, fallback) {
  const category = resourceCategory(url);
  return category === 'bgm' ? 'optional' : category ? 'required' : fallback;
}
function installedFile(url) {
  let pathname;
  try { pathname = decodeURIComponent(splitHashedPath(new URL(url, 'http://localhost').pathname).path); } catch { return null; }
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part === '.')) return null;
  if (pathname.startsWith('/media/')) {
    const relative = pathname.slice(7), extension = path.extname(relative).toLowerCase();
    const stem = AUDIO_EXTS.includes(extension) ? relative.slice(0, -extension.length) : relative;
    for (const ext of [...new Set([...(extension ? [extension] : []), ...AUDIO_EXTS])]) {
      const file = path.resolve(ROOT, 'public/assets/audio', stem + ext);
      if (fileInfo(file)) return file;
    }
    return null;
  }
  const base = pathname.startsWith('/data/') || pathname.startsWith('/shared/') ? ROOT : path.join(ROOT, 'public');
  const file = path.resolve(base, '.' + pathname);
  return file.startsWith(base + path.sep) && fileInfo(file) ? file : null;
}

async function* runtimeFiles(directory) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    // These folders contain extraction evidence, not web-playable resources.
    if (entry.isDirectory() && ['raw', 'original', 'source'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* runtimeFiles(file);
    else if (entry.isFile()) yield file;
  }
}

async function writeChunk(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, 'drain');
}
async function finish(stream) {
  stream.end(); await once(stream, 'finish');
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const source = JSON.parse(await fsp.readFile(path.join(ROOT, 'data/resource-preload.json'), 'utf8'));
  const sourceRecords = new Map();
  for (const group of GROUPS) for (const record of source.groups[group] || []) {
    const url = mediaUrl(record.url, 'http://localhost');
    if (!sourceRecords.has(url) || record.transport) sourceRecords.set(url, record);
  }
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[^0-9]/g, '');
  const work = path.join(ROOT, '.cache', 'resource-package-' + stamp);
  await fsp.mkdir(work, { recursive: true });
  const manifestFile = path.join(ROOT, 'data/resource-preload.local.json');
  const indexFiles = ['resource-preload.local.json', 'resource-preload.local.json.gz', 'resource-preload.json',
    'resource-preload.json.gz', 'resource-preload.runtime.json.gz'];
  for (const name of indexFiles) {
    const file = path.join(ROOT, 'data', name);
    if (fileInfo(file)) await fsp.copyFile(file, path.join(work, name + '.before'));
  }
  const indexed = new Map(), missing = [];
  const add = (url, group, type) => {
    const canonical = mediaUrl(url, 'http://localhost');
    const file = installedFile(url);
    if (!file) { missing.push({ group, url }); return; }
    const prior = indexed.get(canonical);
    group = resourceGroup(canonical, group);
    if (prior) return;
    indexed.set(canonical, { url: canonical, file, group, type: TYPES[path.extname(file).toLowerCase()] || type || 'application/octet-stream' });
  };
  for (const group of GROUPS) for (const record of source.groups[group] || []) add(record.url, group, record.type);
  for await (const file of runtimeFiles(path.join(ROOT, 'public/assets/mizuki'))) {
    add(resourceUrl(path.relative(path.join(ROOT, 'public'), file)), 'required');
  }
  for await (const file of runtimeFiles(path.join(ROOT, 'data/mizuki'))) {
    add(resourceUrl(path.relative(ROOT, file)), 'required');
  }
  // The mode manifest also references restored skin sounds in the shared audio
  // directory, outside the native-sfx tree and the original preload index.
  const sfx = JSON.parse(await fsp.readFile(path.join(ROOT, 'public/assets/mizuki/native-sfx/manifest.json'), 'utf8'));
  for (const [url, record] of Object.entries(sfx.files)) if (record.type?.startsWith('audio/')) add(url, 'required', record.type);
  const sounds = value => {
    if (typeof value === 'string' && value.startsWith('/assets/')) add(value, 'required');
    else if (value && typeof value === 'object') Object.values(value).forEach(sounds);
  };
  sounds(sfx.audio.sfx);
  // Local extraction can restore resources that the old preload never listed.
  for (const [name, group] of [['local-assets.json', 'required'], ['local-fx.json', 'optional']]) {
    const localManifest = path.join(ROOT, 'data', name);
    if (!fileInfo(localManifest)) continue;
    add('/data/' + name, 'required', 'application/json');
    const walk = value => {
      if (typeof value === 'string' && value.startsWith('/assets/local/')) add(value, group);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(JSON.parse(await fsp.readFile(localManifest, 'utf8')));
  }
  // Include the isolated mode catalogues and every resource referenced by them.
  // Existing shared files stay authoritative; the importer only adds missing art.
  const zhajingDir = path.join(ROOT, 'data/zhajing');
  try {
    for await (const file of runtimeFiles(zhajingDir)) {
      if (!file.endsWith('.json')) continue;
      add(resourceUrl(path.relative(ROOT, file)), 'required', 'application/json');
      const walk = value => {
        if (typeof value === 'string' && value.startsWith('/assets/')) add(value, 'required');
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
      };
      walk(JSON.parse(await fsp.readFile(file, 'utf8')));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  add('/assets/relics/catalog.json', 'required', 'application/json');
  add('/data/relics.json', 'required', 'application/json');
  // Do not silently publish a partial resource bundle.
  if (missing.length) {
    await fsp.writeFile(path.join(work, 'missing-resources.json'), JSON.stringify(missing, null, 2));
    throw Error(`${missing.length} source resources are missing; see ${path.join(work, 'missing-resources.json')}`);
  }
  const records = [], groups = Object.fromEntries(GROUPS.map(group => [group, []]));
  const payloadFile = path.join(work, 'payload.bin');
  const payload = fs.createWriteStream(payloadFile, { flags: 'wx' });
  payload.on('error', error => { throw error; });
  let totalBytes = 0, storedTotal = 0, count = 0;
  try {
    for (const item of [...indexed.values()].sort((a, b) => a.url.localeCompare(b.url))) {
      const raw = await fsp.readFile(item.file);
      if (!raw.length) throw Error('Empty local resource: ' + item.url);
      const version = createHash('sha256').update(raw).digest('hex');
      const entry = { url: item.url, version, bytes: raw.length, type: item.type };
      let stored = raw, encoding = 'identity';
      if (COMPRESS.has(path.extname(item.file).toLowerCase())) {
        const compressed = gzipSync(raw, { level: 6, mtime: 0 });
        if (compressed.length < raw.length) { stored = compressed; encoding = 'gzip'; }
      }
      const previous = sourceRecords.get(item.url);
      const compatibleTransport = previous?.transport && previous.version === entry.version &&
        previous.bytes === entry.bytes && previous.type === entry.type ? previous.transport : undefined;
      groups[item.group].push({ ...entry, ...(compatibleTransport ? { transport: compatibleTransport } : {}) });
      records.push({ ...entry, storedBytes: stored.length, encoding });
      await writeChunk(payload, stored);
      totalBytes += raw.length; storedTotal += stored.length;
      if (++count % 2000 === 0) console.log(JSON.stringify({ packed: count, total: indexed.size, storedBytes: storedTotal }));
    }
    await finish(payload);
  } catch (error) { payload.destroy(); throw error; }
  const header = Buffer.from(JSON.stringify({ schema: 3, resources: records }));
  if (header.length > HEADER_LIMIT) throw Error('Resource index exceeds the browser import header limit');
  const prefix = Buffer.alloc(12); prefix.write('SPPACK03'); prefix.writeUInt32LE(header.length, 8);
  await fsp.mkdir(path.dirname(args.out), { recursive: true });
  const temporaryOutput = args.out + '.' + stamp + '.partial';
  const output = fs.createWriteStream(temporaryOutput, { flags: 'wx' });
  output.on('error', error => { throw error; });
  await writeChunk(output, prefix); await writeChunk(output, header);
  const hash = createHash('sha256').update(prefix).update(header);
  for await (const chunk of fs.createReadStream(payloadFile)) { hash.update(chunk); await writeChunk(output, chunk); }
  await finish(output);
  const packBytes = 12 + header.length + storedTotal;
  if ((await fsp.stat(temporaryOutput)).size !== packBytes) throw Error('Incomplete resource package output');
  await fsp.rename(temporaryOutput, args.out);
  const local = { schema: 1, localInstallation: true, generatedAt, source: 'installed-local-files-with-mizuki-runtime', groups };
  const content = Buffer.from(JSON.stringify(local));
  const compressedManifest = gzipSync(content, { level: 9, mtime: 0 });
  // Every production entry point must see the same installed versions/groups.
  // The immutable input snapshots above retain all original transport/pack
  // metadata: old offsets and old-image transports cannot describe new bytes.
  for (const name of indexFiles) await fsp.writeFile(path.join(ROOT, 'data', name), name.endsWith('.gz') ? compressedManifest : content);
  const categories = Object.fromEntries(['maps', 'enemyModels', 'sfx', 'bgm'].map(category => [category,
    { expectedGroup: category === 'bgm' ? 'optional' : 'required', resources: 0, bytes: 0, byGroup: {} }]));
  const classificationErrors = [];
  for (const group of GROUPS) for (const item of groups[group]) {
    const category = resourceCategory(item.url);
    if (!category) continue;
    const stat = categories[category];
    stat.resources++; stat.bytes += item.bytes;
    stat.byGroup[group] = (stat.byGroup[group] || 0) + 1;
    if (group !== stat.expectedGroup) classificationErrors.push({ group, expected: stat.expectedGroup, url: item.url });
  }
  const report = { generatedAt, output: args.out, format: 'SPPACK03', resources: count, bytes: packBytes,
    rawBytes: totalBytes, headerBytes: header.length, sha256: hash.digest('hex'),
    groups: Object.fromEntries(GROUPS.map(group => [group, { resources: groups[group].length,
      bytes: groups[group].reduce((sum, item) => sum + item.bytes, 0) }])),
    mizuki: records.filter(record => record.url.startsWith('/assets/mizuki/') || record.url.startsWith('/data/mizuki/')).length,
    missingSourceResources: missing,
    classification: { categories, errors: classificationErrors },
    manifests: { files: indexFiles.map(name => '/data/' + name), bytes: content.length,
      gzipBytes: compressedManifest.length, sha256: createHash('sha256').update(content).digest('hex'),
      schema: 1, groups: GROUPS, originalMetadataBackup: work },
    sourceMetadata: { canonicalResources: sourceRecords.size,
      originalTransports: [...sourceRecords.values()].filter(item => item.transport).length,
      retainedCompatibleTransports: Object.values(groups).flat().filter(item => item.transport).length,
      obsoletePackOffsetsRetainedInBackup: true },
    scope: 'All installed indexed resources and all web-runtime Mizuki files. Original Unity object dumps and extraction evidence stay on the host.' };
  await fsp.writeFile(args.out + '.json', JSON.stringify(report, null, 2));
  await fsp.writeFile(path.join(work, 'build-report.json'), JSON.stringify(report, null, 2));
  await fsp.unlink(payloadFile);
  console.log(JSON.stringify({ ...report, missingSourceResources: missing.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
