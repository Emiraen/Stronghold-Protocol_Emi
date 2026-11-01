// Import gameplay into a private engine and data namespace. Existing game files
// and installed assets are never replaced by this importer.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node tools/import-zhajing.mjs <source project>');
const dest = path.join(root, 'server/modes/zhajing/engine');
const dataDest = path.join(root, 'data/zhajing');
const reportDir = path.join(root, '.cache/zhajing-port-20261031');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async file => !!(await fs.stat(file).catch(() => null))?.isFile();
// The installed engine contains native integration fixes. Reimporting needs an explicit
// migration, since replacing those files would remove the mode's current adaptations.
if (await exists(path.join(dest, 'server/match/Match.js')))
  throw new Error('炸惊 engine already exists; compare and migrate changes instead of reimporting over adaptations.');
await fs.mkdir(reportDir, { recursive: true });
await fs.mkdir(dataDest, { recursive: true });
const report = { importedAt: new Date().toISOString(), source, engineFiles: [], data: {}, assets: [] };
async function copyCode(directory) {
  for (const entry of await fs.readdir(path.join(source, directory), { withFileTypes: true })) {
    const rel = path.join(directory, entry.name);
    if (entry.isDirectory()) await copyCode(rel);
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      const bytes = await fs.readFile(path.join(source, rel));
      const target = path.join(dest, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      report.engineFiles.push({ path: rel.replaceAll('\\', '/'), sha256: sha(bytes) });
    }
  }
}
for (const directory of ['server/match', 'server/sim', 'shared']) await copyCode(directory);
await fs.copyFile(path.join(source, 'server/data.js'), path.join(dest, 'server/data.js'));
// The imported content registry reads only this mode's injected data.
await fs.appendFile(path.join(dest, 'server/data.js'), '\nexport function setModeData(data) { singleton = deepFreeze(data); }\n');
const names = ['config', 'chess', 'garrisons', 'bonds', 'items', 'bands', 'effects', 'choices',
  'enemies', 'factions', 'waves', 'stages', 'bosses', 'tokens', 'backups', 'assets', 'skins', 'local-assets', 'local-fx'];
const objects = {};
const mergeMissing = (base, extra) => {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base ?? extra;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return extra;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) out[key] = key in out ? mergeMissing(out[key], value) : value;
  return out;
};
for (const name of names) {
  const baseFile = path.join(root, 'data', name + '.json');
  const sourceFile = path.join(source, 'data', name + '.json');
  const base = await exists(baseFile) ? await read(baseFile) : {};
  const extra = await exists(sourceFile) ? await read(sourceFile) : {};
  let out = mergeMissing(base, extra);
  if (name === 'config') out = { ...base, modes: { ...base.modes,
    ...Object.fromEntries(Object.entries(extra.modes || {}).filter(([id]) => id.includes('zhajing'))) } };
  if (name === 'chess') out = { ...base, ...Object.fromEntries(Object.entries(extra).filter(([id, c]) => c.zhajing || !(id in base))) };
  if (name === 'bonds') {
    out = { ...base };
    for (const [id, bond] of Object.entries(extra)) out[id] = base[id] ? { ...base[id], ...(bond.zj ? { zj: bond.zj } : {}) } : bond;
  }
  objects[name] = out;
  const bytes = Buffer.from(JSON.stringify(out));
  await fs.writeFile(path.join(dataDest, name + '.json'), bytes);
  report.data[name] = { baseSha256: await exists(baseFile) ? sha(await fs.readFile(baseFile)) : null,
    modeSha256: sha(bytes), bytes: bytes.length };
}
for (const name of ['jibianBonds', 'zjDefaultLoadout']) {
  objects[name] = await read(path.join(source, 'data', name + '.json'));
  await fs.writeFile(path.join(dataDest, name + '.json'), JSON.stringify(objects[name]));
}
const assetUrls = new Set();
const walk = value => {
  if (typeof value === 'string' && value.startsWith('/assets/')) assetUrls.add(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(walk);
};
Object.values(objects).forEach(walk);
const missing = [];
for (const url of assetUrls) {
  const rel = decodeURIComponent(url.split('?')[0]).replace(/^\//, 'public/');
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep)) throw new Error('Invalid asset path: ' + url);
  if (await exists(target)) continue;
  const input = path.resolve(source, rel);
  if (!input.startsWith(source + path.sep) || !await exists(input)) { missing.push(url); continue; }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(input, target);
  report.assets.push({ url, bytes: (await fs.stat(target)).size });
}
report.missingAssets = missing;
for (const name of ['LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md', 'CHANGES-mod.md'])
  await fs.copyFile(path.join(source, name), path.join(dest, name));
await fs.writeFile(path.join(reportDir, 'import.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ engineFiles: report.engineFiles.length, dataFiles: Object.keys(objects).length,
  newAssets: report.assets.length, assetBytes: report.assets.reduce((n, a) => n + a.bytes, 0), missingAssets: missing.length }));
