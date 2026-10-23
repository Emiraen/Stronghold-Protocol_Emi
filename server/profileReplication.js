import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const FIELDS = ['identity', 'loadout', 'presentation', 'rank', 'history'];
const aidOK = (aid) => typeof aid === 'string' && /^[0-9a-f]{8,64}$/.test(aid);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const clone = (value) => structuredClone(value);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const BATCH_BYTES = 1024 * 1024;
const PAGE_BYTES = 256 * 1024;

function durableWrite(file, data) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 });
  const fd = openSync(temp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = (key) => typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key);

function objectDelta(before, after) {
  return { set: Object.fromEntries(Object.entries(after).filter(([key, value]) => !isDeepStrictEqual(before[key], value))),
    remove: Object.keys(before).filter((key) => !Object.hasOwn(after, key)) };
}

function applyObjectDelta(before, delta, excluded = []) {
  if (!object(delta) || !object(delta.set) || !Array.isArray(delta.remove)
    || [...Object.keys(delta.set), ...delta.remove].some((key) => !safeKey(key) || excluded.includes(key))) throw new Error('复制对象差量无效');
  const value = { ...clone(before || {}), ...clone(delta.set) };
  for (const key of delta.remove) delete value[key];
  return value;
}

function encodeField(field, before, after) {
  if (!object(after) || !['rank', 'history'].includes(field)) return { value: after };
  if (field === 'rank') {
    const { settlements: previous = {}, ...oldFields } = before || {};
    const { settlements = {}, ...newFields } = after;
    return { codec: 'rank-v1', value: { ...objectDelta(oldFields, newFields), settlements: objectDelta(previous, settlements) } };
  }
  const { items: previous = [], ...oldFields } = before || {};
  const { items, ...newFields } = after;
  // 数字仅引用该字段 base 版本中的旧项；输出数组同时确定顺序和裁剪范围。
  return { codec: 'history-v1', value: { ...objectDelta(oldFields, newFields), items: items.map((item) => {
    const index = previous.findIndex((old) => isDeepStrictEqual(old, item));
    return index < 0 ? clone(item) : index;
  }) } };
}

function decodeField(field, before, value, codec) {
  if (!codec) return clone(value); // 已落盘的旧格式完整 patch 仍可补发。
  if (codec === 'rank-v1' && field === 'rank') {
    const rank = applyObjectDelta(before, value, ['settlements']);
    rank.settlements = applyObjectDelta(before?.settlements, value.settlements);
    return rank;
  }
  if (codec === 'history-v1' && field === 'history') {
    const history = applyObjectDelta(before, value, ['items']);
    if (!Array.isArray(value.items) || value.items.length > 10) throw new Error('复制历史差量无效');
    history.items = value.items.map((item) => {
      if (integer(item) && item < (before?.items?.length || 0)) return clone(before.items[item]);
      if (object(item)) return clone(item);
      throw new Error('复制历史基准索引无效');
    });
    return history;
  }
  throw new Error('复制字段 codec 无效');
}

function batch(items) {
  const result = []; let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (result.length >= 1024 || (result.length && bytes + size > BATCH_BYTES)) break;
    // 单账号已有 history 上限小于 RPC 上限；全服 bootstrap 不受此上限约束。
    if (size > 7 * 1024 * 1024) throw new Error('单账号复制增量超过 RPC 上限');
    result.push(item); bytes += size;
  }
  return clone(result);
}

export function replicationPlan(op, args) {
  if (op === 'rank.nameCards') return [{ aid: args[0], fields: ['rank'] }];
  if (['record', 'loadout', 'presentation'].includes(op)) return [{ aid: args[0], fields: [op === 'record' ? 'identity' : op] }];
  const job = args[0];
  return [...new Set((job.seats || []).filter((seat) => !seat.isBot && aidOK(seat.aid)).map((seat) => seat.aid))]
    .map((aid) => ({ aid, fields: op === 'complete' && job.ranked ? ['rank', 'history'] : ['history'] }));
}

// 单进程串行写入；intent 在原 stores 之前，commit 在复制物化之前落盘。
// ACK/cursor 只在全部 stores flush 成功后返回，重启以同一 commit 重做物化。
export class ProfileReplication {
  constructor({ role, stores, file = null, execute, bootstrapFromCopiedStores = false, pageBytes = PAGE_BYTES }) {
    this.role = role; this.stores = stores; this.file = file; this.execute = execute;
    this.bootstrapFromCopiedStores = bootstrapFromCopiedStores; this.pageBytes = pageBytes;
    this.serial = Promise.resolve(); this.bootData = null; this.dirty = false;
    this.firstEconomicAttempts = new WeakSet();
    this.state = { schema: 1, role, id: randomUUID(), initialized: role === 'main', revision: 0,
      cursor: 0, sequence: 0, received: 0, peer: null, versions: {}, owners: {}, grants: {},
      log: [], pending: [], releases: [] };
    if (file) {
      try {
        this.state = JSON.parse(readFileSync(file, 'utf8'));
        if (this.state.schema !== 1 || this.state.role !== role || !Array.isArray(this.state.pending)
          || !Array.isArray(this.state.log)) throw new Error('复制日志格式无效');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (this.state.economicQuarantine !== undefined && (!object(this.state.economicQuarantine)
      || Object.values(this.state.economicQuarantine).some((intent) => intent?.op !== 'complete'
        || !Array.isArray(intent.args) || !Array.isArray(intent.plan)))) throw new Error('经济隔离记录无效');
    this.recovered = !this.state.commit && !this.state.intent;
    if (role === 'secondary' && !this.state.initialized && !this.state.stage && !this.state.commit
      && !bootstrapFromCopiedStores && this.nonempty()) throw new Error('附服存在未初始化的非空档案；必须先备份并明确复制，拒绝自动覆盖');
  }
  get initialized() { return this.state.initialized && this.recovered; }
  quarantinedIntents() { return Object.values(this.state.economicQuarantine || {}); }
  quarantinedAids(includePeer = true) {
    return new Set(this.quarantinedIntents().flatMap((intent) => [
      ...intent.plan.map((entry) => entry.aid),
      ...(intent.args[0]?.seats || []).filter((seat) => !seat.isBot).map((seat) => seat.aid),
    ]).concat(includePeer ? this.state.peerEconomicQuarantine?.aids || [] : []).filter(aidOK));
  }
  hasRankUncertainty() {
    const intents = [...this.quarantinedIntents(), ...(this.state.intent?.op === 'complete' && this.state.intent.blocked ? [this.state.intent] : [])];
    return this.state.peerEconomicQuarantine?.rankingPending === true
      || intents.some((intent) => intent.args[0]?.ranked || intent.plan.some((entry) => Object.hasOwn(entry.before || {}, 'rank')));
  }
  assertIndependent(op, args = []) {
    const quarantined = this.quarantinedIntents();
    if (!quarantined.length && !this.quarantinedAids().size && !this.hasRankUncertainty()) return;
    if (['bootstrap', 'snapshot'].includes(op)) throw this.economicReceiptError();
    if (op === 'rank.nameCards' || this.hasRankUncertainty() && (op === 'leaderboard'
      || op === 'complete' && args[0]?.ranked)) throw this.economicReceiptError();
    const matchId = op === 'complete' ? args[0]?.match?.matchId : op === 'historyRecord' ? args[0]?.matchId : null;
    if (matchId && quarantined.some((intent) => intent.args[0]?.match?.matchId === matchId)) throw this.economicReceiptError();
    const aids = ['login', 'read', 'record', 'loadout', 'presentation', 'historyList', 'historyDetail', 'rank.nameCards', 'grant'].includes(op)
      ? [args[0]] : ['complete', 'historyRecord'].includes(op) ? replicationPlan(op, args).map((entry) => entry.aid) : [];
    const affected = this.quarantinedAids();
    if (aids.some((aid) => affected.has(aid))) throw this.economicReceiptError();
  }
  freezeNameCardGrantSnapshot(migration, aids) {
    return this.run(async () => {
      if (this.role !== 'main') throw new Error('纪念名片名单仅允许主服冻结');
      if (this.state.nameCardGrantSnapshots !== undefined && !object(this.state.nameCardGrantSnapshots)) {
        throw new Error('纪念名片冻结名单无效');
      }
      this.state.nameCardGrantSnapshots ||= {};
      const saved = this.state.nameCardGrantSnapshots[migration];
      if (Object.hasOwn(this.state.nameCardGrantSnapshots, migration)
        && (!object(saved) || !Array.isArray(saved.aids) || saved.aids.some((aid) => !aidOK(aid)))) {
        throw new Error('纪念名片冻结名单无效');
      }
      // Repair either durable copy from the other; never rescan current players when one already exists.
      const frozen = await this.stores.ranked.freezeNameCardGrantSnapshot(migration, saved ? saved.aids : aids);
      if (saved && !isDeepStrictEqual([...new Set(saved.aids)].sort(), [...frozen].sort())) {
        throw new Error('纪念名片冻结名单副本不一致');
      }
      if (!saved) {
        this.state.nameCardGrantSnapshots[migration] = { createdAt: Date.now(), aids: frozen };
      }
      // The cohort is durable before the first rank transaction can start.
      this.save();
      return clone(this.state.nameCardGrantSnapshots[migration].aids);
    });
  }
  deferNameCardUnlock(aid, migration) {
    return this.run(() => {
      const previous = this.state.pendingNameCardUnlocks?.[aid] || { earned: false, migrations: [] };
      const next = { earned: previous.earned || migration === null,
        migrations: [...new Set([...previous.migrations, ...(migration === null ? [] : [migration])])] };
      if (isDeepStrictEqual(previous, next)) return;
      this.state.pendingNameCardUnlocks ||= {};
      this.state.pendingNameCardUnlocks[aid] = next;
      this.save();
    });
  }
  completeDeferredNameCardUnlock(aid, migration) {
    return this.run(() => {
      const previous = this.state.pendingNameCardUnlocks?.[aid];
      if (!previous) return;
      const migrations = previous.migrations.filter((value) => value !== migration);
      if (migrations.length) this.state.pendingNameCardUnlocks[aid] = { earned: false, migrations };
      else delete this.state.pendingNameCardUnlocks[aid];
      this.save();
    });
  }
  nonempty() { return Object.values(this.stores).some((store) => store.profiles.size > 0); }
  save() {
    // A failed durable write must still be retried by the next otherwise-idle exchange.
    this.dirty = true;
    if (this.file) durableWrite(this.file, JSON.stringify(this.state));
    this.dirty = false;
  }
  run(work) {
    const next = this.serial.then(async () => { await this.recover(); return work(); });
    this.serial = next.catch(() => {});
    return next;
  }
  version(aid, field) { return this.state.versions[aid]?.[field] || 0; }
  value(aid, field) {
    if (field === 'rank') return clone(this.stores.ranked.profiles.get(aid) || null);
    if (field === 'history') return clone(this.stores.history.profiles.get(aid) || null);
    const player = this.stores.players.profiles.get(aid);
    if (field !== 'identity') return clone(player?.[field] || null);
    if (!player) return null;
    const { loadout: _loadout, presentation: _presentation, ...identity } = player;
    return clone(identity);
  }
  put(aid, field, value) {
    const store = field === 'rank' ? this.stores.ranked : field === 'history' ? this.stores.history : this.stores.players;
    if (field === 'rank' || field === 'history') {
      if (value === null) store.profiles.delete(aid); else store.profiles.set(aid, clone(value));
    } else if (field === 'identity') {
      const previous = store.profiles.get(aid);
      if (!value || value.aid !== aid) throw new Error('复制身份无效');
      store.profiles.set(aid, { ...clone(value), ...(previous?.loadout ? { loadout: previous.loadout } : {}),
        ...(previous?.presentation ? { presentation: previous.presentation } : {}) });
    } else {
      const player = store.profiles.get(aid);
      if (!player) throw new Error('复制字段缺少身份');
      if (value === null) delete player[field]; else player[field] = clone(value);
    }
  }
  async flush(names, alreadyPersisted = new Set()) {
    const uniqueNames = [...new Set(names)];
    const stores = uniqueNames.map((name) => this.stores[name]);
    for (const name of uniqueNames) if (!alreadyPersisted.has(name)) this.stores[name].writer.save();
    await Promise.all(stores.map((store) => store.flush()));
    for (const store of stores) if (store.file) {
      const fd = openSync(store.file, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  async recover(alreadyPersisted = new Set()) {
    // Durable commits are established facts. Materialize them before isolating any unknown intent.
    const commit = this.state.commit;
    if (!commit) {
      if (this.state.intent?.op === 'complete') this.blockEconomicIntent(this.state.intent);
      else if (this.state.intent) { await this.finishIntent(); return this.recover(alreadyPersisted); }
      this.recovered = true; return;
    }
    this.recovered = false;
    if (commit.snapshot) {
      for (const name of ['players', 'ranked', 'history']) this.stores[name].profiles = new Map(clone(commit.snapshot[name]));
    } else {
      for (const patch of commit.patches) for (const [field, value] of Object.entries(patch.fields)) this.put(patch.aid, field, value);
    }
    const names = commit.snapshot ? ['players', 'ranked', 'history'] : commit.patches.flatMap((patch) =>
      Object.keys(patch.fields).map((field) => field === 'rank' ? 'ranked' : field === 'history' ? 'history' : 'players'));
    // Only the executing process can prove that its first store write completed. A restarted
    // process supplies no proof and must replay every store from the durable commit.
    await this.flush(names, commit.snapshot ? new Set() : alreadyPersisted);
    if (commit.snapshot) { this.state.initialized = true; delete this.state.stage; }
    delete this.state.commit;
    try { this.save(); } catch (error) { this.state.commit = commit; throw error; }
    if (this.state.intent?.op === 'complete') this.blockEconomicIntent(this.state.intent);
    else if (this.state.intent) { await this.finishIntent(); return this.recover(); }
    this.recovered = true;
  }
  economicReceiptError() {
    return Object.assign(new Error('经济结算 intent 回执不明，已停止自动重放'), { code: 'RESULT_SETTLEMENT_FAILED', receipt: 'unknown' });
  }
  blockEconomicIntent(intent) {
    this.firstEconomicAttempts.delete(intent);
    this.recovered = false;
    const previous = this.state.economicQuarantine;
    const key = `complete:${intent.args[0]?.match?.matchId || hash(intent.args)}`;
    const retained = previous?.[key];
    if (retained && !isDeepStrictEqual(retained.args, intent.args)) throw new Error('经济隔离编号冲突');
    this.state.economicQuarantine = { ...previous, [key]: retained || { ...clone(intent),
      blocked: { code: 'RESULT_SETTLEMENT_FAILED', receipt: 'unknown' } } };
    delete this.state.intent;
    try { this.save(); } catch (error) {
      this.state.intent = intent;
      if (previous === undefined) delete this.state.economicQuarantine; else this.state.economicQuarantine = previous;
      throw error;
    }
    this.recovered = !this.state.commit;
  }
  async transact(op, args, { coordinator = false } = {}) {
    return this.run(async () => {
      if (!this.state.initialized) throw new Error('档案复制尚未初始化');
      this.assertIndependent(op, args);
      const plan = replicationPlan(op, args);
      for (const { aid } of plan) {
        if (this.role === 'secondary' && (!this.state.grants[aid]
          || this.state.releases.some((item) => item.aid === aid))) throw new Error('账号没有本服写入租约或已开始交接');
        if (this.role === 'main' && !coordinator && this.state.owners[aid]?.serverId === 'secondary') throw new Error('账号正在等待华南档案同步交接');
      }
      this.state.intent = { op, args: clone(args), plan: plan.map(({ aid, fields }) => ({ aid,
        before: Object.fromEntries(fields.map((field) => [field, this.value(aid, field)])) })) };
      this.save();
      if (op === 'complete') this.firstEconomicAttempts.add(this.state.intent);
      const proofs = new Map();
      try {
        for (const [name, store] of Object.entries(this.stores)) {
          const targets = plan.flatMap(({ aid, fields }) => fields
            .filter((field) => (field === 'rank' ? 'ranked' : field === 'history' ? 'history' : 'players') === name)
            .map((field) => ({ aid, field })));
          if (targets.length && store.writer?.observePersisted) proofs.set(name, {
            beforeRevision: store.writer.revision,
            observer: store.writer.observePersisted(() => Object.fromEntries(targets
              .map(({ aid, field }) => [`${aid}:${field}`, this.value(aid, field)]))),
          });
        }
        const value = await this.finishIntent();
        const alreadyPersisted = new Set();
        for (const [name, { beforeRevision, observer }] of proofs) {
          const writer = this.stores[name].writer;
          if (Number.isInteger(beforeRevision) && writer.persistedSince(beforeRevision)
            && observer.revision === writer.revision) alreadyPersisted.add(name);
        }
        // A saved intermediate value is insufficient: the actual persisted fields and
        // current memory must both match the durable commit before its write is reused.
        for (const patch of this.state.commit?.patches || []) for (const [field, expected] of Object.entries(patch.fields)) {
          const name = field === 'rank' ? 'ranked' : field === 'history' ? 'history' : 'players';
          if (!isDeepStrictEqual(proofs.get(name)?.observer.value?.[`${patch.aid}:${field}`], expected)
            || !isDeepStrictEqual(this.value(patch.aid, field), expected)) alreadyPersisted.delete(name);
        }
        await this.recover(alreadyPersisted);
        return value;
      } finally {
        for (const { observer } of proofs.values()) observer.stop();
      }
    });
  }
  async finishIntent() {
    const intent = this.state.intent;
    if (!intent) { if (this.quarantinedIntents().length) throw this.economicReceiptError(); return; }
    if (intent.op === 'complete') {
      // Only the newly created transaction owns one execution attempt.
      // Restored/re-entered intents cannot prove that no reward was applied.
      if (!this.firstEconomicAttempts.has(intent)) {
        this.blockEconomicIntent(intent);
        throw this.economicReceiptError();
      }
      this.firstEconomicAttempts.delete(intent);
    }
    let value;
    try { value = await this.execute(intent.op, clone(intent.args)); }
    catch (error) {
      if (intent.op === 'complete') this.blockEconomicIntent(intent);
      else if (intent.plan.every(({ aid, before }) => Object.entries(before).every(([field, previous]) => isDeepStrictEqual(previous, this.value(aid, field))))) {
        delete this.state.intent; this.save();
      }
      throw error;
    }
    const patches = [];
    for (const { aid, before } of intent.plan) {
      const fields = {}, compact = {}, codecs = {}, base = {}, versions = {};
      for (const field of Object.keys(before)) {
        const after = this.value(aid, field);
        if (isDeepStrictEqual(before[field], after)) continue;
        fields[field] = after; base[field] = this.version(aid, field); versions[field] = base[field] + 1;
        const encoded = encodeField(field, before[field], after);
        compact[field] = encoded.value;
        if (encoded.codec) codecs[field] = encoded.codec;
      }
      if (!Object.keys(fields).length) continue;
      const patch = { aid, fields: compact, base, versions, ...(Object.keys(codecs).length ? { codecs } : {}) };
      this.state.versions[aid] = { ...this.state.versions[aid], ...versions };
      if (this.role === 'main') this.state.log.push({ revision: ++this.state.revision, patch });
      else this.state.pending.push({ ...patch, sequence: ++this.state.sequence, token: this.state.grants[aid].token });
      // 待发日志保存已编码差量，恢复 commit 则保存完整值，可重复物化部分写入的 stores。
      patches.push({ aid, fields });
    }
    this.state.commit = { patches };
    delete this.state.intent;
    this.save();
    return value;
  }
  async grant(aid, lease, regions) {
    return this.run(() => {
      this.assertIndependent('grant', [aid]);
      const owner = this.state.owners[aid];
      if (owner?.lease && owner.lease.owner !== lease.owner && regions?.current(owner.lease)) return null;
      if (owner?.serverId === 'secondary' && (lease.serverId !== 'secondary'
        || owner.lease.owner !== lease.owner || owner.lease.generation > lease.generation)) return null;
      const token = owner?.serverId === 'secondary' ? owner.token : randomUUID();
      const next = { serverId: lease.serverId, token, lease: clone(lease) };
      if (!isDeepStrictEqual(owner, next)) { this.state.owners[aid] = next; this.dirty = true; }
      if (this.dirty) this.save();
      return { aid, token, versions: clone(this.state.versions[aid] || {}) };
    });
  }
  async acceptGrant(grant) {
    return this.run(() => {
      this.assertIndependent('grant', [grant?.aid]);
      if (!aidOK(grant?.aid) || !grant.token) throw new Error('账号写入租约无效');
      if (this.state.releases.some((item) => item.aid === grant.aid)) throw new Error('账号写入租约已开始交接');
      const current = this.state.grants[grant.aid];
      if (current && current.token !== grant.token) throw new Error('账号写入租约与当前 grant 不匹配');
      for (const field of FIELDS) {
        const version = this.version(grant.aid, field), offered = grant.versions[field] || 0;
        // 同 token 的旧登录响应仅可沿用 heartbeat 已确认的版本，不能认可未同步的本地写入。
        if (version !== offered && !(current?.token === grant.token && version > offered
          && version === (current.versions[field] || 0))) throw new Error('账号交接前档案尚未同步');
      }
      const next = { ...clone(grant), versions: clone(this.state.versions[grant.aid] || {}) };
      if (!isDeepStrictEqual(current, next)) { this.state.grants[grant.aid] = next; this.dirty = true; }
      if (this.dirty) this.save();
    });
  }
  releaseIdle(active) { return this.run(() => this.updateReleases(active)); }
  updateReleases(active) {
    const activeAids = new Set([...(typeof active === 'function' ? active() : active), ...this.quarantinedAids()]);
    const pendingAids = new Set(this.state.pending.map((patch) => patch.aid));
    const releases = this.state.releases.filter((item) => !activeAids.has(item.aid) && !pendingAids.has(item.aid));
    for (const [aid, grant] of Object.entries(this.state.grants)) {
      if (activeAids.has(aid) || pendingAids.has(aid)) continue;
      if (!releases.some((item) => item.aid === aid && item.token === grant.token)) releases.push({ aid, token: grant.token });
    }
    if (releases.length !== this.state.releases.length || releases.some((item, i) => item !== this.state.releases[i])) {
      this.state.releases = releases; this.dirty = true;
    }
    if (this.dirty) this.save();
  }
  exportSnapshot() {
    this.assertIndependent('snapshot');
    return { revision: this.state.revision, versions: clone(this.state.versions),
      ...Object.fromEntries(['players', 'ranked', 'history'].map((name) => [name, clone([...this.stores[name].profiles])])) };
  }
  bindPeer(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id) || (this.state.peer && this.state.peer !== id)) throw new Error('复制节点标识不匹配');
    if (this.state.peer !== id) { this.state.peer = id; this.dirty = true; }
  }
  async bootstrap(request) {
    return this.run(async () => {
      this.assertIndependent('bootstrap');
      this.bindPeer(request?.id);
      if (!request.token && !this.state.bootstrap) {
        await Promise.all(Object.values(this.stores).map((store) => store.flush()));
        this.bootData = Buffer.from(JSON.stringify(this.exportSnapshot()));
        const info = { token: randomUUID(), revision: this.state.revision, bytes: this.bootData.length };
        durableWrite(this.file && `${this.file}.bootstrap`, this.bootData);
        this.state.bootstrap = info; this.save();
      }
      const info = this.state.bootstrap;
      if (!info || (request.token && request.token !== info.token) || !integer(request.offset || 0)
        || (request.offset || 0) > info.bytes) throw new Error('全量复制游标无效');
      if (!this.bootData) this.bootData = readFileSync(`${this.file}.bootstrap`);
      const offset = request.offset || 0;
      const end = Math.min(info.bytes, offset + this.pageBytes);
      return { ...info, offset, next: end, data: this.bootData.subarray(offset, end).toString('base64') };
    });
  }
  async initialize(fetchPage) {
    return this.run(async () => {
      if (this.state.initialized) return;
      if (!this.state.stage && this.nonempty() && !this.bootstrapFromCopiedStores) throw new Error('附服非空档案拒绝自动覆盖');
      while (!this.state.stage || this.state.stage.offset < this.state.stage.bytes) {
        const stage = this.state.stage;
        const page = await fetchPage({ id: this.state.id, token: stage?.token, offset: stage?.offset || 0 });
        const data = Buffer.from(page.data, 'base64');
        if (!integer(page.bytes) || page.bytes <= 0 || page.offset !== (stage?.offset || 0)
          || page.next !== page.offset + data.length || page.next > page.bytes || !data.length
          || (stage && (page.token !== stage.token || page.revision !== stage.revision))) throw new Error('全量复制分页无效');
        this.state.stage = { token: page.token, revision: page.revision, bytes: page.bytes,
          offset: page.next, chunks: [...(stage?.chunks || []), page.data] };
        this.save();
      }
      const snapshot = JSON.parse(Buffer.concat(this.state.stage.chunks.map((chunk) => Buffer.from(chunk, 'base64'))).toString('utf8'));
      if (snapshot.revision !== this.state.stage.revision || !integer(snapshot.revision)
        || !['players', 'ranked', 'history'].every((name) => Array.isArray(snapshot[name])
          && snapshot[name].every((entry) => Array.isArray(entry) && aidOK(entry[0]) && entry[1] && typeof entry[1] === 'object'))) throw new Error('全量复制快照无效');
      if (this.bootstrapFromCopiedStores && this.nonempty()) for (const name of ['players', 'ranked', 'history']) {
        if (!isDeepStrictEqual(new Map(snapshot[name]), this.stores[name].profiles)) throw new Error('部署前复制的档案与华东全量不一致，拒绝覆盖');
      }
      this.state.versions = snapshot.versions; this.state.cursor = snapshot.revision;
      this.state.commit = { snapshot }; this.save();
      await this.recover();
    });
  }
  validatePatch(patch) {
    if (!aidOK(patch?.aid) || !patch.fields || typeof patch.fields !== 'object' || Array.isArray(patch.fields)
      || !Object.keys(patch.fields).length || Object.keys(patch.fields).some((field) => !FIELDS.includes(field)
        || !integer(patch.base?.[field]) || patch.versions?.[field] !== patch.base[field] + 1)) throw new Error('复制增量格式无效');
    if (patch.fields.identity && patch.fields.identity.aid !== patch.aid) throw new Error('复制身份键不匹配');
    if (patch.codecs && (!object(patch.codecs) || Object.entries(patch.codecs).some(([field, codec]) =>
      !Object.hasOwn(patch.fields, field) || !((field === 'rank' && codec === 'rank-v1')
        || (field === 'history' && codec === 'history-v1'))))) throw new Error('复制字段 codec 无效');
    if (!patch.codecs?.rank && patch.fields.rank && patch.fields.rank.aid !== patch.aid) throw new Error('复制排位键不匹配');
  }
  materialize(patch, field, before) {
    const value = decodeField(field, before, patch.fields[field], patch.codecs?.[field]);
    if (field === 'rank' && value && value.aid !== patch.aid) throw new Error('复制排位键不匹配');
    return value;
  }
  async exchange(request, regions) {
    return this.run(async () => {
      this.bindPeer(request?.id);
      if (!integer(request.cursor) || request.cursor > this.state.revision || !Array.isArray(request.pending)
        || !Array.isArray(request.releases) || request.pending.length > 1024 || request.releases.length > 1024) throw new Error('复制交换参数无效');
      for (const patch of request.pending) {
        this.validatePatch(patch);
        if (!integer(patch.sequence) || patch.sequence === 0) throw new Error('复制序号无效');
        if (patch.sequence <= this.state.received) {
          if (patch.sequence === this.state.received && hash(patch) !== this.state.receivedHash) throw new Error('重复增量内容不一致');
          continue;
        }
        if (patch.sequence !== this.state.received + 1) throw new Error('复制增量乱序');
        const owner = this.state.owners[patch.aid];
        this.assertIndependent('record', [patch.aid]);
        if (owner?.serverId !== 'secondary' || owner.token !== patch.token) throw new Error('复制写入租约已被交接');
        for (const field of Object.keys(patch.fields)) if (patch.base[field] !== this.version(patch.aid, field)) throw new Error('复制字段版本冲突');
        const fields = Object.fromEntries(Object.keys(patch.fields).map((field) =>
          [field, this.materialize(patch, field, this.value(patch.aid, field))]));
        this.state.versions[patch.aid] = { ...this.state.versions[patch.aid], ...patch.versions };
        this.state.log.push({ revision: ++this.state.revision, patch: clone(patch) });
        this.state.received = patch.sequence; this.state.receivedHash = hash(patch);
        this.state.commit = { patches: [{ aid: patch.aid, fields }] }; this.save();
        await this.recover();
      }
      // 新版附服只提交权威操作。先收完旧版落盘增量，再解除旧单写者归属。
      if (request.sharedWrites === true && request.pending.length === 0) {
        for (const [aid, owner] of Object.entries(this.state.owners)) {
          if (this.quarantinedAids().has(aid)) continue;
          if (owner.serverId === 'secondary') { this.state.owners[aid] = { serverId: 'main' }; this.dirty = true; }
        }
      }
      const released = [];
      for (const item of request.releases) {
        if (!aidOK(item?.aid) || typeof item.token !== 'string') throw new Error('复制交接参数无效');
        const owner = this.state.owners[item.aid];
        if (this.quarantinedAids().has(item.aid)) continue;
        if (owner?.serverId === 'secondary' && owner.token === item.token) {
          if (regions.current(owner.lease)) continue;
          this.state.owners[item.aid] = { serverId: 'main' }; this.dirty = true;
        }
        released.push(item);
      }
      // cursor 是附服已落盘的确认，不是响应已发送的确认。
      if (this.state.log.length && this.state.log[0].revision <= request.cursor) {
        this.state.log = this.state.log.filter((event) => event.revision > request.cursor); this.dirty = true;
      }
      if (this.state.bootstrap && request.cursor >= this.state.bootstrap.revision) {
        delete this.state.bootstrap; this.bootData = null; this.dirty = true;
      }
      if (this.dirty) this.save();
      const events = batch(this.state.log);
      if (request.cursor < this.state.revision && events[0]?.revision !== request.cursor + 1) throw new Error('复制确认游标已退回，拒绝丢失增量');
      return { ack: this.state.received, events, cursor: events.at(-1)?.revision ?? request.cursor,
        head: this.state.revision, released,
        economicQuarantine: { schema: 1, rankingPending: this.hasRankUncertainty(), aids: [...this.quarantinedAids()] },
        grants: Object.entries(this.state.owners).filter(([, owner]) => owner.serverId === 'secondary')
          .map(([aid, owner]) => ({ aid, token: owner.token, versions: clone(this.state.versions[aid] || {}) })) };
    });
  }
  async sync(exchange, drain = true, active = null) {
    return this.run(async () => {
      if (!this.state.initialized) throw new Error('档案复制尚未初始化');
      let response, releaseAdded;
      do {
        if (active) this.updateReleases(active);
        const releases = clone(this.state.releases.slice(0, 1024));
        response = await exchange({ id: this.state.id, cursor: this.state.cursor,
          pending: batch(this.state.pending), releases });
        const value = response.replication;
        if (!value || !integer(value.ack) || value.ack > this.state.sequence || !Array.isArray(value.events)
          || !integer(value.cursor) || !integer(value.head) || value.cursor > value.head) throw new Error('复制响应无效');
        if (value.economicQuarantine !== undefined) {
          const incoming = value.economicQuarantine;
          if (!object(incoming) || incoming.schema !== 1 || typeof incoming.rankingPending !== 'boolean'
            || !Array.isArray(incoming.aids) || incoming.aids.some((aid) => !aidOK(aid))) throw new Error('经济隔离状态无效');
          const previous = this.state.peerEconomicQuarantine;
          // No automatic reconciliation exists: absent/empty/older replies must never clear a known quarantine.
          const next = { schema: 1, rankingPending: previous?.rankingPending === true || incoming.rankingPending,
            aids: [...new Set([...(previous?.aids || []), ...incoming.aids])].sort() };
          if (!isDeepStrictEqual(previous, next)) { this.state.peerEconomicQuarantine = next; this.save(); }
        }
        const patches = [], staged = new Map(), nextVersions = new Map();
        let cursor = this.state.cursor;
        for (const event of value.events) {
          if (event.revision !== ++cursor) throw new Error('主服复制游标不连续');
          const patch = event.patch; this.validatePatch(patch);
          if (this.quarantinedAids(false).has(patch.aid)) throw this.economicReceiptError();
          const fields = {}, versions = nextVersions.get(patch.aid) || { ...this.state.versions[patch.aid] };
          for (const field of Object.keys(patch.fields)) {
            const version = versions[field] || 0;
            if (patch.versions[field] <= version) continue; // 本服尚未 ACK 的写入已物化；不得用较旧回显覆盖。
            if (patch.base[field] !== version) throw new Error('主服复制字段版本不连续');
            const key = `${patch.aid}:${field}`;
            fields[field] = this.materialize(patch, field, staged.has(key) ? staged.get(key) : this.value(patch.aid, field));
            staged.set(key, fields[field]); versions[field] = patch.versions[field];
          }
          nextVersions.set(patch.aid, versions);
          if (Object.keys(fields).length) patches.push({ aid: patch.aid, fields });
        }
        if (cursor !== value.cursor) throw new Error('主服复制响应游标不匹配');
        for (const [aid, versions] of nextVersions) { this.state.versions[aid] = versions; this.dirty = true; }
        if (this.state.pending.length && this.state.pending[0].sequence <= value.ack) {
          this.state.pending = this.state.pending.filter((patch) => patch.sequence > value.ack); this.dirty = true;
        }
        if (this.state.cursor !== cursor) { this.state.cursor = cursor; this.dirty = true; }
        for (const released of value.released || []) {
          const retained = this.state.releases.filter((item) => item.aid !== released.aid || item.token !== released.token);
          if (retained.length !== this.state.releases.length) { this.state.releases = retained; this.dirty = true; }
          if (this.state.grants[released.aid]?.token === released.token) { delete this.state.grants[released.aid]; this.dirty = true; }
        }
        for (const grant of value.grants || []) {
          if (this.state.releases.some((item) => item.aid === grant.aid)) continue;
          const current = this.state.grants[grant.aid];
          if ((!current || current.token === grant.token)
            && FIELDS.every((field) => this.version(grant.aid, field) === (grant.versions[field] || 0))) {
            if (!isDeepStrictEqual(current, grant)) { this.state.grants[grant.aid] = clone(grant); this.dirty = true; }
          }
        }
        if (this.dirty) { this.state.commit = { patches }; this.save(); await this.recover(); }
        if (active) this.updateReleases(active);
        releaseAdded = active && this.state.releases.some((item) => !releases.some((sent) => sent.aid === item.aid && sent.token === item.token));
      } while (drain && (this.state.pending.length || this.state.cursor < response.replication.head || releaseAdded));
      return response;
    });
  }
}
