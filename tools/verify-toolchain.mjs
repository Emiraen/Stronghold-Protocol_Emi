import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const modes = { lint: ['eslint', 'bin/eslint.js', ['server', 'shared', 'public/js', 'public/studio', 'tools', 'scripts', 'test']], typecheck: ['typescript', 'bin/tsc', ['-p', 'jsconfig.json']] };
const spec = modes[process.argv[2]];
if (!spec) { console.error('Usage: node tools/verify-toolchain.mjs lint|typecheck'); process.exitCode = 2; }
else {
  let entry;
  try { entry = path.join(path.dirname(require.resolve(`${spec[0]}/package.json`)), spec[1]); } catch { /* report an actionable missing dependency */ }
  if (!entry || !fs.existsSync(entry)) { console.error(`Missing ${spec[0]}; run npm ci (including dev dependencies).`); process.exitCode = 1; }
  else {
    const result = spawnSync(process.execPath, [entry, ...spec[2]], { cwd: root, stdio: 'inherit', windowsHide: true });
    process.exitCode = result.status ?? 1;
  }
}
