// Authoritative credentials belong to the primary server, never to player/rank summaries.
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { sanitizeName } from './net.js';

const deriveKey = promisify(scrypt);
const DEFAULT_PASSWORD = '1234567';
const TICKET_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const FAILURE_WINDOW = 60_000;
const FAILURE_LIMIT = 10;
const FAILURE_NAMES = 4096;
const validAid = (value) => typeof value === 'string' && /^[0-9a-f]{8,64}$/.test(value);
const validPassword = (value) => typeof value === 'string' && value.length >= 6 && value.length <= 128;
const plain = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const invalid = () => ({ error: 'AUTH_INVALID', detail: '账户或密码错误' });
const required = () => ({ error: 'AUTH_REQUIRED', detail: '请输入账户和密码' });
const authFields = {
  login: ['action', 'password', 'ticket'],
  register: ['action', 'password'],
  reset: ['action', 'password', 'newPassword', 'confirmPassword'],
};

/** Private primary-server credential store. Every mutation commits to disk before it is visible. */
export class AccountAuth {
  #accounts = new Map();
  #secret = randomBytes(32).toString('hex');
  #pending = Promise.resolve();
  #failures = new Map();

  constructor({ file = null, now = Date.now } = {}) {
    this.file = file === null ? null : resolve(file);
    this.now = now;
    if (!this.file) return;
    let data;
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error('cannot read account credentials store', { cause: error });
    }
    if (!plain(data) || data.version !== 1 || typeof data.secret !== 'string'
        || !/^[0-9a-f]{64}$/.test(data.secret) || !Array.isArray(data.accounts)) {
      throw new Error('invalid account credentials store');
    }
    const aids = new Set();
    for (const account of data.accounts) {
      if (!plain(account) || !validAid(account.aid) || sanitizeName(account.name) !== account.name
          || !account.name || typeof account.salt !== 'string' || !/^[0-9a-f]{32}$/.test(account.salt)
          || typeof account.passwordHash !== 'string' || !/^[0-9a-f]{128}$/.test(account.passwordHash)
          || !Number.isSafeInteger(account.revision) || account.revision < 1
          || this.#accounts.has(account.name) || aids.has(account.aid)) {
        throw new Error('invalid account credentials store');
      }
      // Copy only credentials we understand; arbitrary imported fields never become a profile.
      this.#accounts.set(account.name, { aid: account.aid, name: account.name,
        salt: account.salt, passwordHash: account.passwordHash, revision: account.revision });
      aids.add(account.aid);
    }
    this.#secret = data.secret;
  }

  /** Primary-only identity inventory for one-time grants; no credential fields escape. */
  existingAids() { return [...this.#accounts.values()].map((account) => account.aid); }

  /** Resolve a unique existing identity for a primary-only, one-time migration. */
  resolveExistingName(name, stores = {}) {
    // The private account index owns registered names; callers receive no credential fields.
    if (sanitizeName(name) !== name || !name) return null;
    const account = this.#accounts.get(name);
    if (account) return { aid: account.aid, name: account.name };
    const matches = new Set();
    for (const store of [stores.players, stores.ranked, stores.history]) {
      for (const [aid, profile] of store?.profiles || []) {
        if (validAid(aid) && sanitizeName(profile?.name) === name) matches.add(aid);
      }
    }
    if (matches.size !== 1) return null;
    const [aid] = matches;
    if ([...this.#accounts.values()].some((entry) => entry.aid === aid)) return null;
    return { aid, name };
  }

  /** No caller-supplied aid is used. Authentication does not mutate any profile store. */
  async authenticate(name, auth, stores = {}) {
    // Keep validation, legacy selection and commits in one order, including concurrent registrations.
    const result = this.#pending.then(() => this.#authenticate(name, auth, stores));
    this.#pending = result.catch(() => {});
    return result;
  }

  #time() {
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(at + TICKET_LIFETIME)) {
      throw new Error('invalid account authentication clock');
    }
    return at;
  }

  #blocked(name, at) {
    const failures = this.#failures.get(name);
    if (failures && (at < failures.started || at - failures.started >= FAILURE_WINDOW)) {
      this.#failures.delete(name);
      return false;
    }
    return !!failures && failures.count >= FAILURE_LIMIT;
  }

  #failure(name, at, result = invalid()) {
    let failures = this.#failures.get(name);
    if (!failures || at < failures.started || at - failures.started >= FAILURE_WINDOW) {
      // The map is bounded even when an attacker sends a different name on each attempt.
      for (const [key, entry] of this.#failures) {
        if (at < entry.started || at - entry.started >= FAILURE_WINDOW) this.#failures.delete(key);
      }
      if (this.#failures.size >= FAILURE_NAMES) this.#failures.delete(this.#failures.keys().next().value);
      failures = { started: at, count: 0 };
      this.#failures.set(name, failures);
    }
    failures.count++;
    return result;
  }

  #legacyAid(name, { players, ranked, history }) {
    // resolveName intentionally creates an aid for unknown names: never call it before this scan.
    const matches = new Set();
    for (const store of [players, ranked, history]) {
      for (const [aid, profile] of store?.profiles || []) {
        if (validAid(aid) && sanitizeName(profile?.name) === name) matches.add(aid);
      }
    }
    if (!matches.size || typeof players?.resolveName !== 'function') return null;
    const aid = players.resolveName(name, null, { ranked, history });
    if (!matches.has(aid)) return null;
    // A historical alias must not re-enable the default password for an already claimed aid.
    for (const account of this.#accounts.values()) if (account.aid === aid) return null;
    return aid;
  }

  #nameExists(name, { players, ranked, history }) {
    if (this.#accounts.has(name)) return true;
    for (const store of [players, ranked, history]) {
      for (const [, profile] of store?.profiles || []) {
        if (sanitizeName(profile?.name) === name) return true;
      }
    }
    return false;
  }

  async #checkPassword(password, account) {
    if (!validPassword(password)) return false;
    const actual = await deriveKey(password, Buffer.from(account.salt, 'hex'), 64);
    return timingSafeEqual(actual, Buffer.from(account.passwordHash, 'hex'));
  }

  #ticket(account, at) {
    const payload = Buffer.from(JSON.stringify({ aid: account.aid, name: account.name,
      revision: account.revision, expiry: at + TICKET_LIFETIME })).toString('base64url');
    const signature = createHmac('sha256', Buffer.from(this.#secret, 'hex')).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  #checkTicket(ticket, account, at) {
    if (typeof ticket !== 'string' || ticket.length > 512
        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket)) return false;
    const [payload, signature] = ticket.split('.');
    const expected = createHmac('sha256', Buffer.from(this.#secret, 'hex')).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || actual.toString('base64url') !== signature
        || !timingSafeEqual(actual, expected)) return false;
    try {
      const bytes = Buffer.from(payload, 'base64url');
      if (bytes.toString('base64url') !== payload) return false;
      const value = JSON.parse(bytes.toString('utf8'));
      return plain(value) && value.aid === account.aid && value.name === account.name
        && value.revision === account.revision && Number.isSafeInteger(value.expiry)
        && value.expiry > at && value.expiry <= at + TICKET_LIFETIME;
    } catch { return false; }
  }

  async #save(accounts) {
    if (!this.file) return;
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, secret: this.#secret,
        accounts: [...accounts.values()] }), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.file);
    } catch (error) {
      try { await handle?.close(); } catch { /* Preserve the original storage failure. */ }
      try { await unlink(temporary); } catch { /* The temporary file may not exist. */ }
      throw new Error('account credentials save failed', { cause: error });
    }
  }

  async #commit(name, password, aid, revision, at) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('account credential revision exhausted');
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await deriveKey(password, Buffer.from(salt, 'hex'), 64)).toString('hex');
    const account = { name, aid, salt, passwordHash, revision };
    const accounts = new Map(this.#accounts);
    accounts.set(name, account);
    await this.#save(accounts);
    this.#accounts = accounts;
    this.#failures.delete(name);
    return { aid, name, ticket: this.#ticket(account, at) };
  }

  async #authenticate(rawName, auth, stores) {
    const name = sanitizeName(rawName);
    if (!name) return invalid();
    const at = this.#time();
    if (this.#blocked(name, at)) return { error: 'AUTH_RATE_LIMITED', detail: '尝试次数过多，请稍后再试' };
    if (auth == null || (plain(auth) && Object.keys(auth).length === 0)) return required();
    if (!plain(auth) || !['login', 'register', 'reset'].includes(auth.action)
        || Object.keys(auth).some((key) => !authFields[auth.action].includes(key))
        || ['password', 'newPassword', 'confirmPassword', 'ticket'].some((key) =>
          Object.hasOwn(auth, key) && typeof auth[key] !== 'string')
        || (auth.ticket !== undefined && (auth.ticket.length > 512 || auth.password !== undefined))) {
      return this.#failure(name, at);
    }
    const account = this.#accounts.get(name);
    if (auth.action === 'register') {
      if (this.#nameExists(name, stores)) {
        return this.#failure(name, at, { error: 'AUTH_NAME_TAKEN', detail: '名称已被占用' });
      }
      if (!validPassword(auth.password)) {
        return this.#failure(name, at, { error: 'AUTH_PASSWORD_INVALID', detail: '密码长度须为6至128个字符' });
      }
      return this.#commit(name, auth.password, randomBytes(16).toString('hex'), 1, at);
    }
    if (auth.action === 'login' && account && auth.password === undefined && auth.ticket !== undefined) {
      if (!this.#checkTicket(auth.ticket, account, at)) return this.#failure(name, at);
      this.#failures.delete(name);
      return { aid: account.aid, name, ticket: this.#ticket(account, at) };
    }
    if (auth.password === undefined) {
      return auth.ticket === undefined ? required() : this.#failure(name, at);
    }
    if (!validPassword(auth.password)) return this.#failure(name, at);
    const aid = account ? account.aid : this.#legacyAid(name, stores);
    if (!aid || (account ? !await this.#checkPassword(auth.password, account) : auth.password !== DEFAULT_PASSWORD)) {
      return this.#failure(name, at);
    }
    if (auth.action === 'login') {
      this.#failures.delete(name);
      return account ? { aid, name, ticket: this.#ticket(account, at) }
        : { error: 'AUTH_RESET_REQUIRED', detail: '首次登录请修改默认密码，并再次输入新密码确认' };
    }
    if (!validPassword(auth.newPassword) || auth.newPassword === DEFAULT_PASSWORD) {
      return this.#failure(name, at, { error: 'AUTH_PASSWORD_INVALID', detail: '新密码须为6至128个字符，且不能使用默认密码' });
    }
    if (auth.newPassword !== auth.confirmPassword) {
      return this.#failure(name, at, { error: 'AUTH_PASSWORD_MISMATCH', detail: '两次输入的新密码不一致' });
    }
    return this.#commit(name, auth.newPassword, aid, account ? account.revision + 1 : 1, at);
  }
}
