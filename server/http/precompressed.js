import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './config.js';

export const PRECOMPRESSED_DIR = path.join(ROOT, '.static-compressed');
const HASH = /^[a-f0-9]{64}$/;
const stamp = (stat) => `${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;

/** Private, content-addressed build output. No compressed file is selected by mtime alone. */
export class PrecompressedStore {
  constructor(directory = PRECOMPRESSED_DIR) {
    this.directory = directory;
    this.files = {};
    this.indexStamp = null;
    this.checkedAt = -Infinity;
    this.refreshing = null;
    this.verified = new Map();
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    if (performance.now() - this.checkedAt < 1000) return;
    this.checkedAt = performance.now();
    this.refreshing = (async () => {
      try {
        const file = path.join(this.directory, 'index.json');
        const stat = await fsp.stat(file);
        const revision = stamp(stat);
        if (revision === this.indexStamp) return;
        const index = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (index.version !== 1 || !index.files || typeof index.files !== 'object' || Array.isArray(index.files)) throw new Error('invalid precompressed index');
        this.files = index.files;
        this.indexStamp = revision;
        this.verified.clear();
      } catch {
        // Missing, incomplete or unreadable output must never make an original resource unavailable.
        this.files = {};
        this.indexStamp = null;
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async available() {
    await this.refresh();
    return this.indexStamp !== null;
  }

  async find(sourceHash, sourceBytes, encoding) {
    await this.refresh();
    if (!HASH.test(sourceHash) || !['br', 'gzip'].includes(encoding)) return null;
    const entry = this.files[sourceHash];
    const variant = entry?.[encoding];
    if (entry?.bytes !== sourceBytes || !HASH.test(variant?.sha256 || '')
        || !Number.isSafeInteger(variant?.bytes) || variant.bytes <= 0 || variant.bytes >= sourceBytes) return null;
    const file = path.join(this.directory, `${sourceHash}.${encoding === 'br' ? 'br' : 'gz'}`);
    try {
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.size !== variant.bytes) return null;
      const key = `${file}\0${stamp(stat)}\0${variant.sha256}`;
      let pending = this.verified.get(key);
      if (!pending) {
        pending = (async () => {
          const hash = createHash('sha256');
          for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
          return hash.digest('hex') === variant.sha256;
        })().catch(() => false);
        this.verified.set(key, pending);
        if (this.verified.size > 4096) this.verified.delete(this.verified.keys().next().value);
      }
      return await pending ? { file, bytes: stat.size, sha256: variant.sha256 } : null;
    } catch { return null; }
  }
}
