#!/usr/bin/env node
// Offline only: keep expensive compression away from the game server and never rewrite source assets.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { COMPRESSIBLE } from '../server/http/files.js';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUTS = ['public', 'data', 'shared', 'server/sim', 'packs', 'plugins'];
const TEXT = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.txt', '.md', '.csv', '.xml', '.atlas', '.svg', '.gltf', '.obj', '.mtl']);
const gzip = promisify(zlib.gzip), brotli = promisify(zlib.brotliCompress);
const gunzip = promisify(zlib.gunzip), unbrotli = promisify(zlib.brotliDecompress);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value.split(path.sep).join('/');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

async function resolvedDestination(abs) {
  try { return await fs.realpath(abs); }
  catch (err) {
    if (err.code !== 'ENOENT' || path.dirname(abs) === abs) throw err;
    return path.join(await resolvedDestination(path.dirname(abs)), path.basename(abs));
  }
}

async function atomicWrite(file, bytes) {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try { await fs.writeFile(temp, bytes); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}

/** Builds a private, content-addressed directory. Old blobs stay available until deployment removes them. */
export async function buildPrecompressed({ root = DEFAULT_ROOT, output, include = DEFAULT_INPUTS, exclude = [], concurrency = 2, onProgress = () => {} } = {}) {
  root = path.resolve(root);
  output = path.resolve(output || path.join(root, '.static-compressed'));
  const inputs = include.map(input => path.resolve(root, input));
  // A compression directory must never also be an input, including through the shared assets junction.
  const outputReal = await resolvedDestination(output);
  const mountedReal = await Promise.all(DEFAULT_INPUTS.map(input => resolvedDestination(path.join(root, input))));
  if (DEFAULT_INPUTS.some(input => inside(path.join(root, input), output)) || mountedReal.some(mount => inside(mount, outputReal)) || output === root) throw new Error('Output must be a private directory outside static mounts');
  const excludes = exclude.map(value => path.resolve(root, value));
  concurrency = Math.max(1, Math.min(8, Math.trunc(concurrency) || 2));
  await fs.mkdir(output, { recursive: true });
  const indexFile = path.join(output, 'index.json');
  let old = {};
  try { const doc = JSON.parse(await fs.readFile(indexFile, 'utf8')); if (doc.version === 1 && doc.compression?.brotliQuality === 11 && doc.compression?.gzipLevel === 9) old = doc.files || {}; } catch {}
  const candidates = [];
  const seenPaths = new Set();
  async function walk(abs, ancestors = new Set()) {
    if (inside(output, abs) || excludes.some(item => inside(item, abs))) return;
    let st, real;
    try { [st, real] = await Promise.all([fs.stat(abs), fs.realpath(abs)]); }
    catch (err) { if (err.code === 'ENOENT') return; throw err; }
    if (inside(outputReal, real)) return;
    if (st.isDirectory()) {
      if (ancestors.has(real)) throw new Error(`Directory link cycle: ${abs}`);
      const next = new Set(ancestors); next.add(real);
      for (const item of (await fs.readdir(abs)).sort()) {
        if (item.startsWith('.') || item === 'node_modules') continue;
        // Studio stays behind its own authenticated handler; it is not a public static mount.
        if (path.resolve(abs, item) === path.join(root, 'public', 'studio')) continue;
        await walk(path.join(abs, item), next);
      }
    } else if (st.isFile() && st.size >= 512 && COMPRESSIBLE.has(path.extname(abs).toLowerCase())) {
      const sim = path.join(root, 'server', 'sim');
      if (inside(sim, abs) && (path.extname(abs).toLowerCase() !== '.js' || path.basename(real).toLowerCase() === 'nodedata.js')) return;
      if (!seenPaths.has(abs)) { seenPaths.add(abs); candidates.push({ abs, source: slash(path.relative(root, abs)) }); }
    }
  }
  for (const input of inputs) await walk(input);
  if (await fs.stat(path.join(root, 'server', 'plugins', 'identity.js')).catch(() => null)) {
    // The vanilla /cs index is synthesized in memory by the HTTP server, rather than stored in public/.
    const { computeVanillaContent } = await import(pathToFileURL(path.join(root, 'server', 'plugins', 'identity.js')).href);
    const { DATA_SHIM_JS } = await import(pathToFileURL(path.join(root, 'server', 'http', 'static.js')).href);
    const content = computeVanillaContent({ simDir: path.join(root, 'server', 'sim'), sharedDir: path.join(root, 'shared'), dataDir: path.join(root, 'data'), shim: DATA_SHIM_JS });
    candidates.push({ raw: Buffer.from(JSON.stringify(content.index)), source: '@generated/vanilla-content-index.json' });
  }
  const files = {}, jobs = new Map();
  const totals = { candidates: candidates.length, sourceFiles: 0, uniqueFiles: 0, originalBytes: 0, brBytes: 0, gzipBytes: 0, reusedVariants: 0, builtVariants: 0 };
  let cursor = 0;
  async function compress(raw, hash, ext) {
    const entry = { bytes: raw.length };
    for (const encoding of ['br', 'gzip']) {
      const file = path.join(output, `${hash}.${encoding === 'br' ? 'br' : 'gz'}`);
      const previous = old[hash]?.[encoding];
      let encoded;
      if (old[hash]?.bytes === raw.length && previous?.bytes > 0 && previous?.bytes < raw.length && /^[a-f0-9]{64}$/.test(previous.sha256 || '')) {
        try {
          const st = await fs.lstat(file);
          if (st.isFile() && st.size === previous.bytes) {
            const buf = await fs.readFile(file);
            if (sha256(buf) === previous.sha256 && (await (encoding === 'br' ? unbrotli(buf) : gunzip(buf))).equals(raw)) encoded = buf;
          }
        } catch {}
      }
      if (encoded) totals.reusedVariants++;
      else {
        encoded = encoding === 'br' ? await brotli(raw, { params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_MODE]: TEXT.has(ext) ? zlib.constants.BROTLI_MODE_TEXT : zlib.constants.BROTLI_MODE_GENERIC,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        } }) : await gzip(raw, { level: 9, memLevel: 9 });
        if (!(await (encoding === 'br' ? unbrotli(encoded) : gunzip(encoded))).equals(raw)) throw new Error(`Lossless verification failed: ${hash}/${encoding}`);
        if (encoded.length < raw.length) { await atomicWrite(file, encoded); totals.builtVariants++; }
      }
      if (encoded.length < raw.length) entry[encoding] = { bytes: encoded.length, sha256: sha256(encoded) };
    }
    files[hash] = entry;
    totals.uniqueFiles++;
    return entry;
  }
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const position = cursor++;
      if (position >= candidates.length) break;
      const { abs, source, raw: snapshot } = candidates[position], raw = snapshot || await fs.readFile(abs), hash = sha256(raw);
      let pending = jobs.get(hash);
      if (!pending) { pending = compress(raw, hash, path.extname(source).toLowerCase()); jobs.set(hash, pending); }
      const entry = await pending;
      entry.sources ??= [];
      entry.sources.push(source);
      totals.sourceFiles++; totals.originalBytes += raw.length;
      totals.brBytes += entry.br?.bytes ?? raw.length;
      totals.gzipBytes += entry.gzip?.bytes ?? raw.length;
      onProgress({ ...totals, current: source });
    }
  }));
  for (const entry of Object.values(files)) entry.sources.sort();
  const doc = { version: 1, compression: { brotliQuality: 11, gzipLevel: 9 }, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) };
  // Publish the index last. A live process only selects blobs that have already been completely written.
  await atomicWrite(indexFile, JSON.stringify(doc));
  const report = { ...totals, output, losslessVerified: true,
    brSavedPercent: totals.originalBytes ? +(100 * (1 - totals.brBytes / totals.originalBytes)).toFixed(2) : 0,
    gzipSavedPercent: totals.originalBytes ? +(100 * (1 - totals.gzipBytes / totals.originalBytes)).toFixed(2) : 0 };
  await atomicWrite(path.join(output, 'stats.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { include: [], exclude: [] };
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === '--help') {
      process.stdout.write('Usage: node tools/precompress-static.mjs [--root DIR] [--output DIR] [--include PATH] [--exclude PATH] [--concurrency 2]\nInputs are read-only; Brotli 11 / gzip 9 output stays private. Repeated --include replaces default inputs.\n');
      process.exit(0);
    }
    if (!['--root', '--output', '--include', '--exclude', '--concurrency'].includes(flag) || !process.argv[i + 1]) throw new Error(`Unknown or missing argument: ${flag}`);
    const value = process.argv[++i];
    if (flag === '--include' || flag === '--exclude') options[flag.slice(2)].push(value);
    else options[flag.slice(2)] = flag === '--concurrency' ? Number(value) : value;
  }
  if (!options.include.length) delete options.include;
  let lastLog = performance.now();
  options.onProgress = state => {
    if (performance.now() - lastLog > 10000) { process.stdout.write(`Precompressed ${state.sourceFiles}/${state.candidates}: ${state.current}\n`); lastLog = performance.now(); }
  };
  process.stdout.write(JSON.stringify(await buildPrecompressed(options), null, 2) + '\n');
}
