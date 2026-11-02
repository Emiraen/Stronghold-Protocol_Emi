import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { mkdir, lstat, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const validAid = value => typeof value === 'string' && /^[0-9a-f]{8,64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const META = '_meta';
const integrity = (file, error) => Object.assign(new Error(`Invalid profile record overlay ${file}: ${error.message}`, { cause: error }), { code: 'PROFILE_RECORD_INTEGRITY' });
const unsupportedDirectorySync = error => ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'].includes(error.code)
  || (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBADF'].includes(error.code));

/** The immutable legacy snapshot is the baseline; atomic records override it before store sanitization. */
export function loadProfileDocument(file) {
  let document;
  try { document = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw integrity(file, error); document = { version: 1, profiles: [] }; }
  const directory = `${resolve(file)}.records`;
  let entries;
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('record path must be a real directory');
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return document; throw integrity(directory, error); }
  try {
    if (!object(document)) throw new Error('legacy document must be an object');
    const profiles = new Map((Array.isArray(document.profiles) ? document.profiles : [])
      .filter(value => validAid(value?.aid)).map(value => [value.aid, value]));
    let metadata = null;
    for (const entry of entries) {
      const isMetadata = entry.name === '_meta.json';
      const aid = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
      if (!isMetadata && !validAid(aid)) continue; // Interrupted unique temporary writes are never committed records.
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`record is not a regular file: ${entry.name}`);
      const envelope = JSON.parse(readFileSync(join(directory, entry.name), 'utf8'));
      if (!object(envelope) || envelope.version !== 1) throw new Error(`unsupported envelope: ${entry.name}`);
      if (isMetadata) {
        if (!object(envelope.value) || Object.hasOwn(envelope.value, 'profiles')) throw new Error('invalid metadata envelope');
        metadata = envelope.value;
      } else {
        if (envelope.aid !== aid || (envelope.value !== null && (!object(envelope.value) || envelope.value.aid !== aid))) {
          throw new Error(`record identity mismatch: ${entry.name}`);
        }
        if (envelope.value === null) profiles.delete(aid); else profiles.set(aid, envelope.value);
      }
    }
    return { ...document, ...metadata, profiles: [...profiles.values()] };
  } catch (error) { throw integrity(directory, error); }
}

function idsOf(value) {
  const values = typeof value === 'string' ? [value] : [...(value || [])];
  if (values.some(aid => !validAid(aid))) throw new TypeError('invalid profile record aid');
  return [...new Set(values)];
}
function syncDirectory(directory) {
  let fd;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); }
  catch (error) { if (!unsupportedDirectorySync(error)) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
async function asyncDirectory(directory) {
  let handle;
  try { handle = await open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!unsupportedDirectorySync(error)) throw error; }
  finally { await handle?.close(); }
}

/** A dirty aid is the unit of serialization, replacement and durable acknowledgement. */
export class ProfileRecordWriter {
  constructor({ file, record, metadata = null, log = null, label = 'profiles' }) {
    this.file = file == null ? null : resolve(file);
    this.directory = this.file && `${this.file}.records`;
    this.record = record; this.metadata = metadata; this.log = log; this.label = label;
    this.revision = 0; this.persistedRevision = -1;
    this.dirty = new Map(); this.pending = null; this.error = null;
    this.persistenceObservers = new Set();
  }
  mark(aidOrIterable, { metadata = false } = {}) {
    const keys = idsOf(aidOrIterable);
    if (metadata) {
      if (typeof this.metadata !== 'function') throw new TypeError('profile metadata callback is required');
      keys.push(META);
    }
    if (!this.file || !keys.length) return [];
    this.revision++;
    for (const key of keys) this.dirty.set(key, this.revision);
    return keys;
  }
  save(aidOrIterable = [], options = {}) {
    const keys = this.mark(aidOrIterable, options);
    if (keys.length) { this.error = null; this.start(); }
  }
  serialize(keys) {
    const items = keys.map(key => {
      const revision = this.dirty.get(key);
      if (key === META) {
        const value = this.metadata();
        if (!object(value) || Object.hasOwn(value, 'profiles')) throw new TypeError('invalid profile metadata');
        return { key, revision, data: JSON.stringify({ version: 1, value }) };
      }
      const value = this.record(key);
      if (value !== null && (!object(value) || value.aid !== key)) throw new TypeError('profile record identity mismatch');
      return { key, revision, data: JSON.stringify({ version: 1, aid: key, value }) };
    });
    // There is no await between serialization and observation of the exact same records.
    return { items, proofs: this.capturePersistence(keys.filter(key => key !== META)) };
  }
  async prepare() {
    const created = await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('record path must be a real directory');
    if (created) await asyncDirectory(dirname(this.directory));
  }
  prepareSync() {
    const created = mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('record path must be a real directory');
    if (created) syncDirectory(dirname(this.directory));
  }
  temporary(key) { return join(this.directory, `.${key}.${randomBytes(12).toString('hex')}.tmp`); }
  target(key) { return join(this.directory, `${key}.json`); }
  start() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      await new Promise(resolve => setImmediate(resolve));
      try {
        while (this.dirty.size) {
          const revision = this.revision;
          const { items, proofs } = this.serialize([...this.dirty.keys()]);
          await this.prepare();
          for (const item of items) {
            const temp = this.temporary(item.key);
            let handle;
            try {
              handle = await open(temp, 'wx', 0o600);
              await handle.writeFile(item.data, 'utf8'); await handle.sync();
              await handle.close(); handle = null;
              // Keep this check and rename synchronous: an older async write cannot overwrite a newer sync save.
              if (this.dirty.get(item.key) !== item.revision) { await unlink(temp); continue; }
              renameSync(temp, this.target(item.key));
              await asyncDirectory(this.directory);
              if (this.dirty.get(item.key) === item.revision) this.dirty.delete(item.key);
            } finally {
              await handle?.close();
              try { await unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
          }
          this.confirmPersistence(revision, proofs, items.map(item => item.key));
        }
        this.error = null; return true;
      } catch (error) {
        this.error = error; this.log?.error?.(`[${this.label}] record save failed: ${error.message}`); return false;
      } finally { this.pending = null; }
    })();
    return this.pending;
  }
  saveSync(aidOrIterable = [], options = {}) {
    const keys = this.mark(aidOrIterable, options);
    if (!keys.length) return true;
    const revision = this.revision;
    try {
      const { items, proofs } = this.serialize(keys);
      this.prepareSync();
      for (const item of items) {
        const temp = this.temporary(item.key); let fd;
        try {
          fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, item.data, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
          renameSync(temp, this.target(item.key)); syncDirectory(this.directory);
          if (this.dirty.get(item.key) === item.revision) this.dirty.delete(item.key);
        } finally {
          if (fd !== undefined) closeSync(fd);
          try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      this.confirmPersistence(revision, proofs, keys); this.error = null; return true;
    } catch (error) {
      this.error = error; this.log?.error?.(`[${this.label}] record save failed: ${error.message}`); return false;
    }
  }
  async flush() {
    if (!this.file) return;
    if (!this.pending && this.error) throw this.error;
    const ok = await (this.pending || (this.dirty.size ? this.start() : true));
    if (!ok || this.error) throw this.error || new Error('profile records were not persisted');
  }
  persistedSince(revision) {
    return !!this.file && this.revision > revision && this.persistedRevision === this.revision
      && !this.dirty.size && !this.pending && !this.error;
  }
  observePersisted(capture) {
    const observer = { capture, revision: -1, value: null, stop: () => this.persistenceObservers.delete(observer) };
    this.persistenceObservers.add(observer); return observer;
  }
  capturePersistence(aids = []) {
    const included = new Set(aids);
    const proofs = [];
    for (const observer of this.persistenceObservers) {
      const value = observer.capture();
      // Current receipt observers return { 'aid:field': value }. Unknown scopes stay unproven.
      const keys = object(value) ? Object.keys(value) : [];
      const required = keys.map(key => key.split(':', 1)[0]);
      if (keys.length && required.every(aid => validAid(aid) && included.has(aid))) proofs.push([observer, value, required]);
    }
    return proofs;
  }
  confirmPersistence(revision, proofs, aids = []) {
    if (this.dirty.size) return;
    // A newer sync save may finish while an older async batch is syncing another aid.
    // Once the dirty set is empty all current records are durable, but old observations stay unproven.
    this.persistedRevision = this.revision;
    if (revision !== this.revision) return;
    const included = new Set(aids);
    for (const [observer, value, required] of proofs) if (this.persistenceObservers.has(observer)
      && required?.length && required.every(aid => included.has(aid))) {
      observer.revision = revision; observer.value = value;
    }
  }
}
