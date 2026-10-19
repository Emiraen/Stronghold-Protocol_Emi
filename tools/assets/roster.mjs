import { readFile, writeFile, mkdir, copyFile, stat, rename } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

async function curlFetch(url, { signal, headers = {} } = {}) {
  const { stdout } = await runFile('curl.exe', ['--silent', '--show-error', '--location', '--max-time', '30', '--user-agent', headers['user-agent'] || 'stronghold-protocol-fetch-assets/1.0', '--write-out', '\n%{http_code}', url], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, signal, windowsHide: true });
  const split = stdout.lastIndexOf(10);
  const status = Number(stdout.subarray(split + 1).toString());
  if (!status) throw new Error('系统代理传输没有有效 HTTP 响应');
  return new Response(stdout.subarray(0, split), { status });
}
import { Downloader } from './downloader.mjs';
import { RAW, joinUrl, safeName } from './sources.mjs';
import { kindOf } from './formats.mjs';
import { processModels } from './spine.mjs';
import { contentHash, droppedEntries } from './manifest.mjs';

export function dataExtras(backups) {
  const extraOperators = {};
  for (const [id, u] of Object.entries(backups?.units || {})) {
    const skills = new Map();
    for (const f of Object.values(u.forms || {})) {
      for (const sk of f.skills || []) if (!skills.has(sk.index)) skills.set(sk.index, { index: sk.index, skillId: sk.skillId, iconId: sk.iconId || sk.skillId });
    }
    extraOperators[id] = { name: u.name, subProfessionId: u.subProfessionId, nationId: u.nationId, skills: [...skills.values()].sort((a, b) => a.index - b.index) };
  }
  return { extraOperators, tokenIds: Object.keys(backups?.tokens || {}).sort() };
}

export function missingJobs(urls, skillIds = {}) {
  return urls.map(url => {
    if (!/^\/assets\/(?:char\/(?:avatar|portrait)\/|skill\/|token\/avatar\/|spine\/op\/|local\/spine\/token\/)[A-Za-z0-9_./-]+$/.test(url) || url.includes('..')) throw new Error(`缺失清单路径不受支持：${url}`);
    const rel = url.slice('/assets/'.length);
    const file = rel.split('/').pop();
    let sources;
    if (rel.startsWith('char/avatar/')) sources = [joinUrl(RAW.yuanyan, `avatar/${file}`)];
    else if (rel.startsWith('char/portrait/')) sources = [joinUrl(RAW.yuanyan, `portrait/${file}`)];
    else if (rel.startsWith('token/avatar/')) sources = [joinUrl(RAW.yuanyan, `avatar/${file}`)];
    else if (rel.startsWith('skill/')) sources = [joinUrl(RAW.yuanyan, `skill/skill_icon_${skillIds[file.slice(0, -4)] || file.slice(0, -4)}.png`)];
    else if (rel.startsWith('spine/op/')) {
      const [, , id, side] = rel.split('/');
      sources = [joinUrl(RAW.fexli, `spine/${id}/${id}/${side === 'front' ? 'Front' : 'Back'}/${file}`)];
    } else {
      const id = rel.split('/')[3];
      sources = ['Spine', 'Front'].map(side => joinUrl(RAW.fexli, `spine/${id}/${id}/${side}/${file}`));
    }
    return { rel, urls: sources, kind: kindOf(rel), ...(rel.endsWith('.atlas') ? { mutable: true } : {}) };
  });
}

function urlsOf(node, out = new Set()) {
  if (typeof node === 'string' && /^\/(assets|fonts)\//.test(node)) out.add(node);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) urlsOf(v, out);
  return out;
}

// 只填空缺，保留 A 的全部既有路径和定制数据。
export function mergeAdditions(base, extra) {
  if (base === undefined) return structuredClone(extra);
  if (!base || !extra || typeof base !== 'object' || typeof extra !== 'object' || Array.isArray(base) || Array.isArray(extra)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) out[key] = mergeAdditions(base[key], value);
  return out;
}

export async function fetchMissingRoster(root, { missingList, cacheDir, concurrency = 12, offline = false, dryRun = false }, log = console.log) {
  if (!cacheDir) throw new Error('--missing-list 必须配合 --cache-dir，缓存不得使用真实存档目录');
  const cache = resolve(cacheDir);
  const assets = join(root, 'public/assets');
  const staging = join(cache, 'staging');
  const doc = JSON.parse(await readFile(missingList, 'utf8'));
  const requested = [...new Set([...(doc.newDirectFiles || []), ...(doc.newTokenLocalFiles || [])])];
  const backups = JSON.parse(await readFile(join(root, 'data/backups.json'), 'utf8'));
  const extras = dataExtras(backups);
  const skillIds = {};
  for (const u of Object.values(extras.extraOperators)) for (const sk of u.skills) skillIds[safeName(sk.iconId)] = sk.iconId;
  const jobs = missingJobs(requested, skillIds).filter(j => !existsSync(join(assets, j.rel)));
  const report = { requested: requested.length, planned: jobs.length, downloaded: 0, downloadedBytes: 0, copied: [], remaining: [], results: {}, spineProblems: [], manifestAdded: [], requiredMisses: [] };
  log(`[roster] 必要清单 ${requested.length}，当前缺失 ${jobs.length}`);
  if (dryRun) return report;
  await mkdir(cache, { recursive: true });
  const manifestPath = join(root, 'data/assets.json');
  const originalText = await readFile(manifestPath, 'utf8');
  const original = JSON.parse(originalText);
  if (!existsSync(join(cache, 'assets-before.json'))) await writeFile(join(cache, 'assets-before.json'), originalText);
  const { withRosterAssets } = await import(pathToFileURL(join(root, 'public/js/rosterAssets.js')).href);
  const effective = withRosterAssets(original);
  const dl = new Downloader({ root: staging, ledgerPath: join(cache, 'assets-ledger.json'), concurrency, retries: 2, timeoutMs: 35000, log, ...((process.env.HTTPS_PROXY || process.env.https_proxy) ? { fetchImpl: curlFetch } : {}) });
  await dl.loadLedger();
  if (!offline) report.results = Object.fromEntries(await dl.run(jobs, '必要资源'));
  report.downloaded = dl.totals.ok;
  report.downloadedBytes = dl.totals.bytesDownloaded;
  const byRel = new Map(missingJobs(requested, skillIds).map(j => [j.rel, j]));
  const models = new Map();
  for (const [id, c] of Object.entries(effective.chars || {})) {
    for (const [side, sp] of Object.entries(c.spine || {})) {
      const rel = sp.skel?.replace(/^\/assets\//, '');
      if (!byRel.has(rel)) continue;
      const atlas = sp.atlas.replace(/^\/assets\//, '');
      const dir = rel.slice(0, rel.lastIndexOf('/') + 1);
      const key = `op:${id}:${side}`;
      models.set(key, { key, kind: 'op', dir, pma: sp.pma, skillIndices: Object.keys(sp.anims?.skills || {}).length ? Object.keys(sp.anims.skills).map(Number) : [sp.anims?.skill?.index ?? 0], skel: byRel.get(rel), atlas: byRel.get(atlas), pngs: sp.textures.map(u => byRel.get(u.slice(8))).filter(Boolean) });
    }
  }
  for (const [id, t] of Object.entries(effective.tokens || {})) {
    const sp = t.spineLocal;
    if (!sp) continue;
    const dir = `local/${sp.group}/`;
    if (!byRel.has(dir + sp.skel)) continue;
    const key = `local-token:${id}`;
    models.set(key, { key, kind: 'token', dir, pma: false, skillIndices: [0], skel: byRel.get(dir + sp.skel), atlas: byRel.get(dir + sp.atlas), pngs: sp.textures.map(n => byRel.get(dir + n)).filter(Boolean) });
  }
  // 解析在独立暂存区进行：损坏资源的清理不触及 A 已有文件。
  const spine = await processModels(models, { root: staging, dl, cachePath: join(cache, 'spine-info.json'), download: false, log });
  report.spineProblems = spine.problems;
  for (const problem of spine.problems) {
    const key = problem.split(': ').shift();
    if (problem.includes('attachment(s) not in atlas')) spine.entries.delete(key);
  }
  const completeModelFiles = new Set();
  for (const sp of spine.entries.values()) for (const u of [sp.skel, sp.atlas, ...sp.textures]) completeModelFiles.add(u.slice(8));
  for (const j of jobs) {
    if (/^(spine\/|local\/spine\/)/.test(j.rel) && !completeModelFiles.has(j.rel)) continue;
    if (!existsSync(join(staging, j.rel))) continue;
    const dest = join(assets, j.rel);
    await mkdir(dirname(dest), { recursive: true });
    try { await copyFile(join(staging, j.rel), dest, constants.COPYFILE_EXCL); report.copied.push('/assets/' + j.rel); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const hasFiles = value => [...urlsOf(value)].every(u => existsSync(join(root, 'public', u)));
  const additions = { chars: {}, tokens: {}, skills: {}, skillsById: {} };
  for (const [id, c] of Object.entries(effective.chars || {})) {
    const extra = {};
    for (const k of ['avatar', 'avatarE2', 'portrait', 'portraitE2']) if (c[k] && hasFiles(c[k])) extra[k] = c[k];
    for (const side of ['front', 'back']) {
      const sp = spine.entries.get(`op:${id}:${side}`) || c.spine?.[side];
      if (sp && hasFiles(sp)) (extra.spine ||= {})[side] = sp;
    }
    if (Object.keys(extra).length) additions.chars[id] = extra;
  }
  const localPath = join(root, 'data/local-assets.json');
  const localText = await readFile(localPath, 'utf8');
  const local = JSON.parse(localText);
  const localAdded = [];
  for (const [id, t] of Object.entries(effective.tokens || {})) {
    const extra = {};
    if (t.avatar && hasFiles(t.avatar)) extra.avatar = t.avatar;
    if (t.owner !== undefined) extra.owner = t.owner;
    if (t.spine && hasFiles(t.spine)) extra.spine = t.spine;
    const sp = spine.entries.get(`local-token:${id}`);
    if (sp && hasFiles(sp)) {
      const group = t.spineLocal.group;
      const fileName = u => u.slice(u.lastIndexOf('/') + 1);
      extra.spineLocal = { ...sp, group, skel: fileName(sp.skel), atlas: fileName(sp.atlas), textures: sp.textures.map(fileName) };
      local.groups ||= {};
      const entries = local.groups[group] ||= {};
      for (const u of [sp.skel, sp.atlas, ...sp.textures]) {
        const name = fileName(u);
        if (!entries[name]) { entries[name] = { path: u, bytes: (await stat(join(root, 'public', u))).size }; localAdded.push(`${group}/${name}`); }
      }
    }
    if (Object.keys(extra).length) additions.tokens[id] = extra;
  }
  for (const [id, u] of Object.entries(effective.skills || {})) if (hasFiles(u)) additions.skills[id] = u;
  for (const [id, icon] of Object.entries(effective.skillsById || {})) if (additions.skills[icon]) additions.skillsById[id] = icon;
  const next = mergeAdditions(original, additions);
  if (droppedEntries(original, next).length) throw new Error('增量资源清单发生收缩');
  const listAdded = (base, extra, prefix = '') => {
    for (const [k, v] of Object.entries(extra)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (base?.[k] === undefined) report.manifestAdded.push(p);
      else if (v && typeof v === 'object' && !Array.isArray(v)) listAdded(base[k], v, p);
    }
  };
  listAdded(original, additions);
  if (report.manifestAdded.length) {
    const { hash, stats, version, generator, ...body } = next;
    next.hash = contentHash(body);
    const all = [...urlsOf(next)].filter(u => u.startsWith('/assets/'));
    const chars = Object.values(next.chars || {}), tokens = Object.values(next.tokens || {});
    const spines = new Set();
    for (const c of chars) for (const s of Object.values(c.spine || {})) spines.add(s.skel);
    for (const t of tokens) if (t.spine) spines.add(t.spine.skel);
    for (const e of Object.values(next.enemies || {})) if (e.spine) spines.add(e.spine.skel);
    next.stats = { ...stats, files: all.length, bytes: (await Promise.all(all.map(u => stat(join(root, 'public', u))))).reduce((n, s) => n + s.size, 0), chars: chars.length, charsWithBack: chars.filter(c => c.spine?.back).length, tokens: tokens.length, tokensWithSpine: tokens.filter(t => t.spine).length, spineModels: spines.size, skills: Object.keys(next.skills || {}).length };
    await writeFile(manifestPath + '.tmp', JSON.stringify(next) + '\n');
    await rename(manifestPath + '.tmp', manifestPath);
  }
  if (localAdded.length) {
    local.count = Object.values(local.groups || {}).reduce((n, group) => n + Object.keys(group).length, 0);
    await writeFile(localPath + '.tmp', JSON.stringify(local) + '\n');
    await rename(localPath + '.tmp', localPath);
  }
  report.localManifestAdded = localAdded;
  report.remaining = requested.filter(u => !existsSync(join(root, 'public', u)));
  for (const id of Object.keys(extras.extraOperators)) {
    const c = withRosterAssets(next).chars?.[id];
    for (const [kind, value] of Object.entries({ avatar: c?.avatar, portrait: c?.portrait, front: c?.spine?.front })) if (!value || !hasFiles(value)) report.requiredMisses.push(`${id}.${kind}`);
  }
  await writeFile(join(cache, 'assets-report.json'), JSON.stringify(report, null, 2) + '\n');
  log(JSON.stringify({ downloaded: report.downloaded, copied: report.copied.length, remaining: report.remaining.length, manifestAdded: report.manifestAdded.length, localAdded: localAdded.length, requiredMisses: report.requiredMisses }, null, 2));
  return report;
}
