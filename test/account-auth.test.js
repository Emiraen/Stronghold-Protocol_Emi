import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountAuth } from '../server/accountAuth.js';
import { PlayerStore } from '../server/playerStore.js';

const A = '1111111111111111';
const B = '2222222222222222';
const C = '3333333333333333';
const PASSWORD = 'private-test-password';
const NEXT_PASSWORD = 'different-test-password';
const DAY = 24 * 60 * 60 * 1000;

function stores() {
  const players = new PlayerStore({ file: null, now: () => 1000 });
  const ranked = { profiles: new Map(), profile(aid) { return this.profiles.get(aid) || null; } };
  return { players, ranked, history: { profiles: new Map() } };
}

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stronghold-account-auth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'account-auth.json') };
}

const login = (password) => ({ action: 'login', password });
const register = (password = PASSWORD) => ({ action: 'register', password });
const reset = (password = '1234567', newPassword = PASSWORD, confirmPassword = newPassword) =>
  ({ action: 'reset', password, newPassword, confirmPassword });

test('legacy default password requires a confirmed change, without creating any profile or credentials', async (t) => {
  const { file, directory } = temporary(t);
  const h = stores();
  h.players.record(A, '旧账户');
  h.ranked.profiles.set(B, { name: '旧账户', placementDone: true, points: 1800 });
  h.history.profiles.set(C, { name: '旧账户', items: [] });
  const before = structuredClone([...h.players.profiles]);
  const auth = new AccountAuth({ file });

  const required = await auth.authenticate('旧账户', undefined, h);
  assert.deepEqual(required, { error: 'AUTH_REQUIRED', detail: '请输入账户和密码' });
  assert.deepEqual(await auth.authenticate('旧账户', login('wrong-password'), h),
    { error: 'AUTH_INVALID', detail: '账户或密码错误' });
  const pending = await auth.authenticate('旧账户', login('1234567'), h);
  assert.equal(pending.error, 'AUTH_RESET_REQUIRED');
  assert.equal(pending.aid, undefined);
  assert.equal(pending.ticket, undefined);
  assert.deepEqual([...h.players.profiles], before);
  assert.deepEqual(readdirSync(directory), []);

  assert.equal((await auth.authenticate('旧账户', reset('wrong-password'), h)).error, 'AUTH_INVALID');
  assert.equal((await auth.authenticate('旧账户', reset('1234567', 'short'), h)).error, 'AUTH_PASSWORD_INVALID');
  assert.equal((await auth.authenticate('旧账户', reset('1234567', '1234567'), h)).error, 'AUTH_PASSWORD_INVALID');
  assert.equal((await auth.authenticate('旧账户', reset('1234567', PASSWORD, NEXT_PASSWORD), h)).error,
    'AUTH_PASSWORD_MISMATCH');
  assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual([...h.players.profiles], before);

  const success = await auth.authenticate('旧账户', reset(), h);
  assert.equal(success.aid, B);
  assert.equal(success.name, '旧账户');
  assert.equal(typeof success.ticket, 'string');
  assert.deepEqual([...h.players.profiles], before);
  // Once claimed, account ownership cannot drift when the ranked candidate ordering changes.
  h.ranked.profiles.set(A, { name: '旧账户', placementDone: true, points: 10000 });
  assert.equal((await auth.authenticate('旧账户', login(PASSWORD), h)).aid, B);
  assert.equal((await auth.authenticate('旧账户', login('1234567'), h)).error, 'AUTH_INVALID');
  assert.equal((await auth.authenticate('旧账户', register(), h)).error, 'AUTH_NAME_TAKEN');
});

test('legacy names are recognized independently in ranked and history stores', async () => {
  for (const source of ['players', 'ranked', 'history']) {
    const h = stores();
    h[source].profiles.set(A, { name: ' e\u0301  队 ', placementDone: true, points: 10 });
    const auth = new AccountAuth();
    assert.equal((await auth.authenticate('é 队', login('1234567'), h)).error, 'AUTH_RESET_REQUIRED');
    assert.equal((await auth.authenticate('é 队', reset(), h)).aid, A);
  }
});

test('unknown names never use default-password login or call resolveName to create an identity', async (t) => {
  const { file, directory } = temporary(t);
  const h = stores();
  let resolutions = 0;
  h.players.resolveName = () => { resolutions++; return A; };
  const auth = new AccountAuth({ file });
  assert.deepEqual(await auth.authenticate('不存在', login('1234567'), h),
    { error: 'AUTH_INVALID', detail: '账户或密码错误' });
  assert.equal((await auth.authenticate('不存在', reset(), h)).error, 'AUTH_INVALID');
  assert.equal(resolutions, 0);
  assert.equal(h.players.size, 0);
  assert.deepEqual(readdirSync(directory), []);
});

test('registration reserves the normalized name, generates an aid and supports password and ticket login', async () => {
  const h = stores();
  const auth = new AccountAuth();
  const success = await auth.authenticate(' e\u0301   队 ', register(), h);
  assert.match(success.aid, /^[0-9a-f]{32}$/);
  assert.equal(success.name, 'é 队');
  assert.ok(success.ticket.length <= 512);
  assert.deepEqual(Object.keys(success).sort(), ['aid', 'name', 'ticket']);
  assert.deepEqual(await auth.authenticate('é 队', register(NEXT_PASSWORD), h),
    { error: 'AUTH_NAME_TAKEN', detail: '名称已被占用' });
  assert.equal((await auth.authenticate('é 队', login('wrong-password'), h)).error, 'AUTH_INVALID');
  assert.equal((await auth.authenticate('é 队', login(PASSWORD), h)).aid, success.aid);
  assert.equal((await auth.authenticate('é 队', { action: 'login', ticket: success.ticket }, h)).aid, success.aid);
  assert.equal((await auth.authenticate('其他账户', { action: 'login', ticket: success.ticket }, h)).error, 'AUTH_INVALID');
  assert.equal(h.players.size, 0);
  assert.equal(h.ranked.profiles.size, 0);
  assert.equal(h.history.profiles.size, 0);
});

test('registration checks all legacy stores and uses the existing case-sensitive NFC naming rules', async () => {
  const h = stores();
  h.players.profiles.set(A, { name: ' e\u0301 队 ' });
  h.ranked.profiles.set(B, { name: '排位' });
  h.history.profiles.set(C, { name: '历史' });
  const auth = new AccountAuth();
  for (const name of ['é 队', '排位', '历史']) {
    assert.deepEqual(await auth.authenticate(name, register(), h),
      { error: 'AUTH_NAME_TAKEN', detail: '名称已被占用' });
  }
  const first = await auth.authenticate('Alpha', register(), h);
  const second = await auth.authenticate('alpha', register(), h);
  assert.ok(first.aid && second.aid);
  assert.notEqual(first.aid, second.aid);
});

test('successful writes survive reload and tickets keep the persisted signing secret', async (t) => {
  const { file, directory } = temporary(t);
  const h = stores();
  const auth = new AccountAuth({ file });
  const success = await auth.authenticate('持久账户', register(), h);
  const loaded = new AccountAuth({ file });
  assert.equal((await loaded.authenticate('持久账户', login(PASSWORD), h)).aid, success.aid);
  assert.equal((await loaded.authenticate('持久账户', { action: 'login', ticket: success.ticket }, h)).aid, success.aid);
  assert.equal((await loaded.authenticate('持久账户', register(), h)).error, 'AUTH_NAME_TAKEN');
  assert.deepEqual(readdirSync(directory), ['account-auth.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('credential files contain independent salted hashes and no plaintext passwords or public profile fields', async (t) => {
  const { file } = temporary(t);
  const h = stores();
  const auth = new AccountAuth({ file });
  await auth.authenticate('一号账户', register(), h);
  await auth.authenticate('二号账户', register(), h);
  const serialized = readFileSync(file, 'utf8');
  assert.ok(!serialized.includes(PASSWORD));
  assert.ok(!serialized.includes('1234567'));
  const data = JSON.parse(serialized);
  assert.equal(data.version, 1);
  assert.match(data.secret, /^[0-9a-f]{64}$/);
  assert.equal(data.accounts.length, 2);
  const [first, second] = data.accounts;
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.passwordHash, second.passwordHash);
  for (const account of data.accounts) {
    assert.match(account.salt, /^[0-9a-f]{32}$/);
    assert.match(account.passwordHash, /^[0-9a-f]{128}$/);
    assert.equal(account.password, undefined);
    assert.equal(account.ticket, undefined);
  }
  assert.equal(JSON.stringify(h.players.list()), '[]');
  assert.ok(!JSON.stringify(h).includes('passwordHash'));
});

test('password changes revoke older tickets while preserving the account aid across reload', async (t) => {
  const { file } = temporary(t);
  const h = stores();
  const auth = new AccountAuth({ file });
  const original = await auth.authenticate('改密账户', register(), h);
  const changed = await auth.authenticate('改密账户', reset(PASSWORD, NEXT_PASSWORD), h);
  assert.equal(changed.aid, original.aid);
  assert.notEqual(changed.ticket, original.ticket);
  assert.equal((await auth.authenticate('改密账户', login(PASSWORD), h)).error, 'AUTH_INVALID');
  assert.equal((await auth.authenticate('改密账户', { action: 'login', ticket: original.ticket }, h)).error, 'AUTH_INVALID');
  const loaded = new AccountAuth({ file });
  assert.equal((await loaded.authenticate('改密账户', login(NEXT_PASSWORD), h)).aid, original.aid);
  assert.equal((await loaded.authenticate('改密账户', { action: 'login', ticket: changed.ticket }, h)).aid, original.aid);
  assert.equal((await loaded.authenticate('改密账户', { action: 'login', ticket: original.ticket }, h)).error, 'AUTH_INVALID');
});

test('tickets expire at thirty days and reject payload or signature changes', async () => {
  let time = 1000;
  const auth = new AccountAuth({ now: () => time });
  const h = stores();
  const success = await auth.authenticate('票据账户', register(), h);
  const [payload, signature] = success.ticket.split('.');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(parsed.expiry, time + 30 * DAY);
  assert.equal(parsed.aid, success.aid);
  const changedPayload = Buffer.from(JSON.stringify({ ...parsed, aid: A })).toString('base64url');
  assert.equal((await auth.authenticate('票据账户', { action: 'login', ticket: `${changedPayload}.${signature}` }, h)).error,
    'AUTH_INVALID');
  const changedSignature = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
  assert.equal((await auth.authenticate('票据账户', { action: 'login', ticket: `${payload}.${changedSignature}` }, h)).error,
    'AUTH_INVALID');
  time += 30 * DAY - 1;
  assert.equal((await auth.authenticate('票据账户', { action: 'login', ticket: success.ticket }, h)).aid, success.aid);
  time++;
  assert.equal((await auth.authenticate('票据账户', { action: 'login', ticket: success.ticket }, h)).error, 'AUTH_INVALID');
});

test('concurrent registrations of the same normalized name commit exactly one account', async (t) => {
  const { file } = temporary(t);
  const auth = new AccountAuth({ file });
  const h = stores();
  const results = await Promise.all([
    auth.authenticate(' e\u0301  队 ', register(), h),
    auth.authenticate('é 队', register(NEXT_PASSWORD), h),
  ]);
  assert.equal(results.filter((value) => value.aid).length, 1);
  assert.equal(results.filter((value) => value.error === 'AUTH_NAME_TAKEN').length, 1);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).accounts.length, 1);
  assert.equal((await auth.authenticate('é 队', login(PASSWORD), h)).aid, results[0].aid);
});

test('failed registration writes leave no in-memory account and can be retried after repair', async (t) => {
  const { directory } = temporary(t);
  const blocker = join(directory, 'blocked');
  writeFileSync(blocker, 'not a directory');
  const file = join(blocker, 'account-auth.json');
  // Construct before introducing the obstruction so constructor startup validation remains strict.
  rmSync(blocker);
  const auth = new AccountAuth({ file });
  writeFileSync(blocker, 'not a directory');
  const h = stores();
  await assert.rejects(auth.authenticate('写入失败', register(), h), /account credentials save failed/);
  assert.equal((await auth.authenticate('写入失败', login(PASSWORD), h)).error, 'AUTH_INVALID');
  assert.equal(h.players.size, 0);
  rmSync(blocker);
  const success = await auth.authenticate('写入失败', register(), h);
  assert.match(success.aid, /^[0-9a-f]{32}$/);
  assert.equal((await new AccountAuth({ file }).authenticate('写入失败', login(PASSWORD), h)).aid, success.aid);
});

test('failed legacy reset and later password changes preserve prior credentials and tickets', async (t) => {
  const { file, directory } = temporary(t);
  const h = stores();
  h.players.record(A, '回滚账户');
  const auth = new AccountAuth({ file });
  mkdirSync(file);
  await assert.rejects(auth.authenticate('回滚账户', reset(), h), /account credentials save failed/);
  assert.equal((await auth.authenticate('回滚账户', login('1234567'), h)).error, 'AUTH_RESET_REQUIRED');
  assert.deepEqual(readdirSync(directory), ['account-auth.json']);
  rmSync(file, { recursive: true });
  const first = await auth.authenticate('回滚账户', reset(), h);
  const saved = readFileSync(file, 'utf8');
  rmSync(file);
  mkdirSync(file);
  await assert.rejects(auth.authenticate('回滚账户', reset(PASSWORD, NEXT_PASSWORD), h), /account credentials save failed/);
  assert.equal((await auth.authenticate('回滚账户', login(PASSWORD), h)).aid, A);
  assert.equal((await auth.authenticate('回滚账户', { action: 'login', ticket: first.ticket }, h)).aid, A);
  assert.equal((await auth.authenticate('回滚账户', login(NEXT_PASSWORD), h)).error, 'AUTH_INVALID');
  assert.deepEqual(readdirSync(directory), ['account-auth.json']);
  rmSync(file, { recursive: true });
  writeFileSync(file, saved);
  assert.equal((await new AccountAuth({ file }).authenticate('回滚账户', login(PASSWORD), h)).aid, A);
});

test('malformed or corrupt stored data aborts startup instead of falling back to default passwords', async (t) => {
  const { file } = temporary(t);
  const h = stores();
  await new AccountAuth({ file }).authenticate('文件账户', register(), h);
  const good = JSON.parse(readFileSync(file, 'utf8'));
  const invalidStores = [
    '{', '{}', 'null',
    JSON.stringify({ ...good, secret: '' }),
    JSON.stringify({ ...good, accounts: {} }),
    JSON.stringify({ ...good, accounts: [{ ...good.accounts[0], passwordHash: 'invalid' }] }),
    JSON.stringify({ ...good, accounts: [{ ...good.accounts[0], revision: 0 }] }),
    JSON.stringify({ ...good, accounts: [good.accounts[0], good.accounts[0]] }),
  ];
  for (const value of invalidStores) {
    writeFileSync(file, value);
    assert.throws(() => new AccountAuth({ file }), /account credentials store/);
  }
});

test('malformed authentication data fails closed and passwords obey the length bounds', async () => {
  const auth = new AccountAuth();
  const h = stores();
  assert.deepEqual(await auth.authenticate('账户', {}, h), { error: 'AUTH_REQUIRED', detail: '请输入账户和密码' });
  const malformed = [false, '', [], { password: PASSWORD }, { action: 'unknown' },
    { action: 'login', password: [PASSWORD] }, { action: 'login', ticket: null },
    { action: 'login', ticket: 'a'.repeat(513) }, { action: 'register', password: PASSWORD, aid: A },
    { action: 'login', password: PASSWORD, ticket: 'invalid' },
    { action: 'reset', password: PASSWORD, newPassword: 123456, confirmPassword: PASSWORD }];
  for (let i = 0; i < malformed.length; i++) {
    assert.equal((await auth.authenticate(`畸形${i}`, malformed[i], h)).error, 'AUTH_INVALID');
  }
  assert.equal((await auth.authenticate(null, register(), h)).error, 'AUTH_INVALID');
  assert.equal((await auth.authenticate('短密码', register('12345'), h)).error, 'AUTH_PASSWORD_INVALID');
  assert.equal((await auth.authenticate('长密码', register('x'.repeat(129)), h)).error, 'AUTH_PASSWORD_INVALID');
  assert.ok((await auth.authenticate('六位密码', register('a'.repeat(6)), h)).aid);
  assert.ok((await auth.authenticate('上限密码', register('b'.repeat(128)), h)).aid);
});

test('failed attempts are limited per normalized name, expire, and are cleared by success', async () => {
  let time = 1000;
  const auth = new AccountAuth({ now: () => time });
  const h = stores();
  const account = await auth.authenticate('受限账户', register(), h);
  for (let i = 0; i < 10; i++) {
    assert.equal((await auth.authenticate(i % 2 ? ' 受限账户 ' : '受限账户', login('wrong-password'), h)).error, 'AUTH_INVALID');
  }
  assert.equal((await auth.authenticate('受限账户', login(PASSWORD), h)).error, 'AUTH_RATE_LIMITED');
  assert.ok((await auth.authenticate('其他账户', register(), h)).aid);
  time += 60_000;
  assert.equal((await auth.authenticate('受限账户', login(PASSWORD), h)).aid, account.aid);
  for (let i = 0; i < 9; i++) await auth.authenticate('受限账户', login('wrong-password'), h);
  assert.equal((await auth.authenticate('受限账户', login(PASSWORD), h)).aid, account.aid);
  assert.equal((await auth.authenticate('受限账户', login('wrong-password'), h)).error, 'AUTH_INVALID');
  assert.equal((await auth.authenticate('受限账户', login(PASSWORD), h)).aid, account.aid);
});

test('an old historical alias cannot default-reset an already claimed aid', async () => {
  const h = stores();
  h.players.profiles.set(A, { name: '现在名字' });
  h.history.profiles.set(A, { name: '过去名字' });
  const auth = new AccountAuth();
  assert.equal((await auth.authenticate('现在名字', reset(), h)).aid, A);
  assert.equal((await auth.authenticate('过去名字', reset(), h)).error, 'AUTH_INVALID');
  assert.equal((await auth.authenticate('现在名字', login(PASSWORD), h)).aid, A);
});
