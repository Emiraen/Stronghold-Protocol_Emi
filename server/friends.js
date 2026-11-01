import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { StoreWriter } from './historyStore.js';
import { FRIEND_ACTIONS, publicPlayerId, socialModeName } from '../shared/friends.js';
import { FRIEND_MESSAGE_PAGE_SIZE, FRIEND_MESSAGE_RETENTION_MS, validFriendMessageText, validMessageSequence } from '../shared/friendMessages.js';

const HOUR = 3600_000;
const MAX_FRIENDS = 200;
const error = message => { throw new Error(message); };
const id = () => randomBytes(16).toString('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateSocialSync(value) {
  if (!plain(value) || !['main', 'secondary'].includes(value.serverId) || !Array.isArray(value.roster)
    || value.roster.length > 10_000 || value.roster.some(row => !plain(row) || !plain(row.lease)
      || typeof row.playerId !== 'string' || row.playerId.length > 64
      || !['online', 'room', 'playing', 'spectating'].includes(row.state)
      || (row.seenRevision !== undefined && (!Number.isSafeInteger(row.seenRevision) || row.seenRevision < 0))
      || (row.room && (!plain(row.room) || !/^[A-HJ-NP-Z]{4}$/.test(row.room.code)
        || !['solo', 'coop'].includes(row.room.mode) || !Number.isInteger(row.room.capacity)
        || row.room.capacity < 1 || row.room.capacity > 20 || !Number.isInteger(row.room.humans)
        || row.room.humans < 0 || row.room.humans > row.room.capacity
        || (row.room.createdAt !== undefined && (!Number.isSafeInteger(row.room.createdAt) || row.room.createdAt < 0))
        || (row.room.variant != null && (typeof row.room.variant !== 'string' || row.room.variant.length > 64))
        || (row.room.matchId != null && !publicPlayerId(row.room.matchId)))))) error('好友状态参数无效');
}
export function validateSocialAction(value) {
  if (!plain(value) || !FRIEND_ACTIONS.includes(value.action)
    || Object.keys(value).some(key => !['action', 'targetId', 'query', 'inviteId', 'accept', 'mute', 'matchId', 'playerId', 'text', 'clientId', 'beforeSeq', 'afterSeq', 'throughSeq'].includes(key))
    || (value.targetId !== undefined && !publicPlayerId(value.targetId))
    || (value.query !== undefined && (typeof value.query !== 'string' || value.query.length > 64))
    || (value.inviteId !== undefined && !publicPlayerId(value.inviteId))
    || (value.matchId !== undefined && !publicPlayerId(value.matchId))
    || (value.playerId !== undefined && (typeof value.playerId !== 'string' || value.playerId.length > 64))
    || (value.accept !== undefined && typeof value.accept !== 'boolean')
    || (value.mute !== undefined && typeof value.mute !== 'boolean')
    || (value.text !== undefined && !validFriendMessageText(value.text))
    || (value.clientId !== undefined && !publicPlayerId(value.clientId))
    || ['beforeSeq', 'afterSeq', 'throughSeq'].some(key => value[key] !== undefined && !validMessageSequence(value[key]))) error('好友操作参数无效');
}

/** Friend relationships have one durable authority, independent of profile write ownership.
 * The regional bridge authenticates every action and presence row with the existing login lease. */
export class FriendsService {
  constructor({ players, ranked, history, cardSkin = () => '', isLeaseActive = () => true, file = null, now = Date.now, random = Math.random, log = console }) {
    Object.assign(this, { players, ranked, history, cardSkin, isLeaseActive, now, random });
    this.state = { version: 1, friends: {}, requests: {}, mutes: {}, invitations: [], conversations: {} };
    if (file) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (saved.version !== 1 || !['friends', 'requests', 'mutes'].every(key => plain(saved[key])) || !Array.isArray(saved.invitations)) error('好友存档格式无效');
        if (saved.conversations !== undefined && !plain(saved.conversations)) error('私信存档格式无效');
        this.state = { ...saved, conversations: saved.conversations || {} };
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    this.writer = new StoreWriter(file, () => this.state, log, 'friends');
    this.regions = new Map();
    this.chain = Promise.resolve();
    this.sent = new Map();
    this.epoch = id(); this.revision = 0;
  }
  profile(profileId) {
    if (!this.index || this.index.size !== this.players.profiles.size) this.index = new Map([...this.players.profiles.values()].map(p => [p.id, p.aid]));
    const aid = this.index.get(profileId);
    return aid ? this.players.profiles.get(aid) : null;
  }
  presence(profileId) {
    const now = this.now();
    for (const region of this.regions.values()) if (now - region.at < 10_000 && region.rows.has(profileId)) {
      const row = region.rows.get(profileId);
      if (this.isLeaseActive(row.lease)) return row;
    }
    return null;
  }
  beginRead() {
    this.rankPositions = new Map(this.ranked.leaderboard({ includeAid: true }).filter(row => !row.inactive).map(row => [row.aid, row.position]));
  }
  card(profileId, detailed = false) {
    const player = this.profile(profileId);
    if (!player) return null;
    const summary = this.ranked.summary(player.aid, player.name, false, this.rankPositions);
    const appearance = player.presentation?.value || {};
    const row = this.presence(profileId);
    const presence = row ? { state: row.state, serverId: row.serverId,
      ...(row.room ? { modeName: socialModeName(row.room), humans: row.room.humans, capacity: row.room.capacity } : {}),
      ...(row.state === 'playing' && row.room?.spectatable && row.room?.matchId
        ? { watch: { serverId: row.serverId, code: row.room.code, matchId: row.room.matchId } } : {}) } : { state: 'offline' };
    return { id: player.id, name: player.name, card: appearance.card || '', cardSkin: this.cardSkin(appearance.card, appearance),
      rank: detailed ? summary : { rank: summary.rank, ranked: summary.ranked, points: summary.points }, presence };
  }
  friends(profileId) { return this.state.friends[profileId] || []; }
  conversation(self, target, create = false) {
    const key = [self, target].sort().join(':');
    if (create) this.state.conversations[key] ||= { lastSeq: 0, read: {}, messages: [] };
    return this.state.conversations[key];
  }
  thread(self, target) {
    const conversation = this.conversation(self, target);
    if (!conversation?.messages.length) return null;
    const readSeq = conversation.read[self] || 0;
    return { targetId: target, lastSeq: conversation.lastSeq, readSeq,
      unread: conversation.messages.filter(row => row.from !== self && row.seq > readSeq).length,
      lastMessage: conversation.messages.at(-1) };
  }
  messageAction(self, target, value) {
    if (value.action === 'message.send') {
      if (!validFriendMessageText(value.text) || !publicPlayerId(value.clientId)) error('私信内容无效');
      const conversation = this.conversation(self, target, true), text = value.text.trim().replace(/\r\n?/g, '\n');
      const previous = conversation.messages.find(row => row.from === self && row.clientId === value.clientId);
      if (previous) {
        if (previous.text !== text) error('私信请求编号已使用');
        return { message: previous, thread: this.thread(self, target) };
      }
      if (conversation.messages.filter(row => row.from === self && this.now() - row.at < 10_000).length >= 10) error('私信发送过于频繁，请稍后再试');
      const message = { id: id(), seq: ++conversation.lastSeq, from: self, text, at: this.now(), clientId: value.clientId };
      conversation.messages.push(message);
      this.nextMessageExpiry = Math.min(this.nextMessageExpiry || Infinity, message.at + FRIEND_MESSAGE_RETENTION_MS);
      return { message, thread: this.thread(self, target) };
    }
    const conversation = this.conversation(self, target);
    if (value.action === 'message.read') {
      if (!validMessageSequence(value.throughSeq) || value.throughSeq > (conversation?.lastSeq || 0)) error('私信读取位置无效');
      if (conversation) conversation.read[self] = Math.max(conversation.read[self] || 0, value.throughSeq);
      return { thread: this.thread(self, target) };
    }
    if (value.beforeSeq !== undefined && value.afterSeq !== undefined) error('私信分页参数无效');
    const all = conversation?.messages || [];
    const candidates = all.filter(row => (value.beforeSeq === undefined || row.seq < value.beforeSeq)
      && (value.afterSeq === undefined || row.seq > value.afterSeq));
    const items = value.afterSeq !== undefined ? candidates.slice(0, FRIEND_MESSAGE_PAGE_SIZE) : candidates.slice(-FRIEND_MESSAGE_PAGE_SIZE);
    return { items, hasOlder: !!items.length && all[0].seq < items[0].seq,
      hasNewer: !!items.length && all.at(-1).seq > items.at(-1).seq, thread: this.thread(self, target) };
  }
  stamp(snapshot) { return { ...snapshot, epoch: this.epoch, revision: ++this.revision }; }
  snapshot(profileId, cards = new Map()) {
    const card = who => { if (!cards.has(who)) cards.set(who, this.card(who)); return cards.get(who); };
    return { selfId: profileId, friends: this.friends(profileId).map(card).filter(Boolean),
      threads: this.friends(profileId).map(target => this.thread(profileId, target)).filter(Boolean),
      requests: (this.state.requests[profileId] || []).map(row => ({ ...row, player: card(row.from) })).filter(row => row.player),
      outgoing: Object.entries(this.state.requests).filter(([, rows]) => rows.some(row => row.from === profileId)).map(([to]) => to),
      invitations: this.state.invitations.filter(row => row.to === profileId).map(row => ({ id: row.id, from: card(row.from),
        modeName: row.modeName, kind: row.kind, status: row.status, expiresAt: row.expiresAt })).filter(row => row.from) };
  }
  sync(serverId, roster) {
    const run = this.chain.then(async () => {
      const before = JSON.stringify([this.state.invitations, this.state.mutes]);
      const pruned = this.prune();
      const frames = this.syncNow(serverId, roster);
      if (pruned || before !== JSON.stringify([this.state.invitations, this.state.mutes])) { this.writer.save(); await this.writer.flush(); }
      return frames;
    }).catch(err => {
      this.sent.clear();
      throw err;
    });
    this.chain = run.catch(() => {});
    return run;
  }
  syncNow(serverId, roster) {
    this.beginRead();
    const rows = new Map(roster.map(row => [row.profileId, { ...row, serverId }]));
    this.regions.set(serverId, { at: this.now(), rows });
    this.prune();
    this.state.invitations = this.state.invitations.filter(invite => {
      const sender = this.presence(invite.from), receiver = this.presence(invite.to);
      if (sender && !this.roomFor(invite)) return false;
      return !(receiver?.serverId === invite.serverId && receiver.room?.code === invite.code);
    });
    const frames = [], cards = new Map(), liveKeys = new Set();
    for (const [profileId, row] of rows) {
      const key = `${serverId}:${row.lease.owner}:${row.lease.generation}`;
      liveKeys.add(key);
      const body = this.snapshot(profileId, cards), signature = JSON.stringify(body), previous = this.sent.get(key);
      if (previous?.signature !== signature || row.seenRevision !== undefined && row.seenRevision < previous.state.revision) {
        const state = previous?.signature === signature ? previous.state : this.stamp(body);
        frames.push({ lease: row.lease, state });
        this.sent.set(key, { signature, state });
      }
    }
    for (const key of this.sent.keys()) if (key.startsWith(serverId + ':') && !liveKeys.has(key)) this.sent.delete(key);
    return frames;
  }
  roomFor(invite) {
    const inviter = this.presence(invite.from);
    return inviter?.state === 'room' && inviter.serverId === invite.serverId && inviter.room?.code === invite.code
      && inviter.room.createdAt === invite.roomCreatedAt
      && inviter.room.joinable ? inviter.room : null;
  }
  prune() {
    const now = this.now();
    let messagesChanged = false;
    if (!this.nextMessageExpiry || now >= this.nextMessageExpiry) {
      this.nextMessageExpiry = Infinity;
      for (const conversation of Object.values(this.state.conversations)) {
        const retained = conversation.messages.filter(row => row.at + FRIEND_MESSAGE_RETENTION_MS > now);
        if (retained.length !== conversation.messages.length) { conversation.messages = retained; messagesChanged = true; }
        if (retained.length) this.nextMessageExpiry = Math.min(this.nextMessageExpiry, retained[0].at + FRIEND_MESSAGE_RETENTION_MS);
      }
    }
    this.state.invitations = this.state.invitations.filter(row => row.expiresAt > now);
    for (const [to, bySender] of Object.entries(this.state.mutes)) {
      for (const [from, until] of Object.entries(bySender)) if (until <= now) delete bySender[from];
      if (!Object.keys(bySender).length) delete this.state.mutes[to];
    }
    for (const invite of this.state.invitations) {
      if (invite.status === 'reserved' && this.roomFor(invite) && !['playing', 'spectating'].includes(this.presence(invite.to)?.state)) invite.status = 'ready';
    }
    return messagesChanged;
  }
  async action(aid, value, authorized = () => true) {
    validateSocialAction(value);
    const run = this.chain.then(async () => {
      if (!authorized()) error('好友操作的登录租约已失效，请重新连接');
      const player = this.players.profiles.get(aid);
      if (!player) error('玩家档案尚未就绪');
      const before = structuredClone(this.state);
      try {
        this.prune();
        this.beginRead();
        const result = this.execute(player.id, value);
        if (JSON.stringify(before) !== JSON.stringify(this.state)) {
          this.writer.save();
          try { await this.writer.flush(); } catch (err) { throw new Error('好友状态保存失败，请稍后重试', { cause: err }); }
        }
        return structuredClone(result);
      } catch (err) { this.state = before; this.nextMessageExpiry = 0; throw err; }
    });
    this.chain = run.catch(() => {});
    return run;
  }
  execute(self, value) {
    const { action, targetId: target } = value;
    if (action === 'list') return this.stamp(this.snapshot(self));
    if (action === 'search' || action === 'recommend') {
      const query = (value.query || '').trim().toLocaleLowerCase();
      if (action === 'search' && !query) return { items: [] };
      let people = [...this.players.profiles.values()].filter(p => p.id !== self && (action === 'search'
        ? p.name.toLocaleLowerCase().includes(query) : this.presence(p.id) && !this.friends(self).includes(p.id)));
      if (action === 'recommend') for (let i = people.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [people[i], people[j]] = [people[j], people[i]]; }
      else people.sort((a, b) => Number(b.name.toLocaleLowerCase() === query) - Number(a.name.toLocaleLowerCase() === query) || a.name.localeCompare(b.name));
      return { items: people.slice(0, action === 'search' ? 30 : 12).map(p => this.card(p.id)) };
    }
    if (action === 'respond') {
      const invite = this.state.invitations.find(row => row.id === value.inviteId && row.to === self);
      if (!invite) error('邀请已失效');
      if (value.mute) {
        (this.state.mutes[self] ||= {})[invite.from] = this.now() + HOUR;
        this.state.invitations = this.state.invitations.filter(row => row.to !== self || row.from !== invite.from || value.accept && row === invite);
        if (!value.accept) return { ignored: true };
      }
      if (!value.accept) { this.state.invitations = this.state.invitations.filter(row => row !== invite); return { ignored: true }; }
      if (!this.friends(self).includes(invite.from)) error('该玩家已不是好友');
      if (!this.roomFor(invite)) error('好友的房间已开始、已满或已关闭');
      if (['playing', 'spectating'].includes(this.presence(self)?.state)) {
        invite.status = 'reserved'; invite.expiresAt = this.now() + 2 * HOUR;
        return { reserved: true };
      }
      // Keep the invitation until the client actually joins; failed transfers can be retried.
      return { join: { serverId: invite.serverId, code: invite.code } };
    }
    const person = this.profile(target);
    if (!person) error('未找到该玩家');
    if (action === 'profile') return { player: this.card(target, true), items: this.history.list(person.aid) };
    if (action === 'history') {
      const detail = this.history.detail(person.aid, value.matchId, value.playerId);
      if (!detail) error('这场对局记录已不可用');
      return detail;
    }
    if (self === target) error('不能对自己执行此操作');
    if (action === 'request') {
      if (this.friends(self).includes(target)) return { alreadyFriends: true };
      if (this.friends(self).length >= MAX_FRIENDS || this.friends(target).length >= MAX_FRIENDS) error('好友数量已达上限');
      const rows = this.state.requests[target] ||= [];
      if (rows.some(row => row.from === self)) return { pending: true };
      if (rows.length >= 100) error('对方待处理的好友申请过多');
      rows.push({ id: id(), from: self, at: this.now() });
      return { pending: true };
    }
    if (action === 'accept' || action === 'reject') {
      const rows = this.state.requests[self] || [];
      if (!rows.some(row => row.from === target)) error('好友申请已处理');
      if (action === 'accept') {
        if (this.friends(self).length >= MAX_FRIENDS || this.friends(target).length >= MAX_FRIENDS) error('好友数量已达上限');
        this.state.friends[self] = [...new Set([...this.friends(self), target])];
        this.state.friends[target] = [...new Set([...this.friends(target), self])];
        this.state.requests[target] = (this.state.requests[target] || []).filter(row => row.from !== self);
      }
      this.state.requests[self] = rows.filter(row => row.from !== target);
      return { accepted: action === 'accept' };
    }
    if (!this.friends(self).includes(target)) error('请先添加该玩家为好友');
    if (action.startsWith('message.')) return this.messageAction(self, target, value);
    if (action === 'remove') {
      this.state.friends[self] = this.friends(self).filter(who => who !== target);
      this.state.friends[target] = this.friends(target).filter(who => who !== self);
      this.state.invitations = this.state.invitations.filter(row => !([self, target].includes(row.to) && [self, target].includes(row.from)));
      return { removed: true };
    }
    if (action === 'invite') {
      const sender = this.presence(self), receiver = this.presence(target);
      if (sender?.state !== 'room' || !sender.room?.joinable) error('当前房间无法邀请，请确认房间尚未开始且有空位');
      if (!receiver) error('好友当前离线');
      if (receiver.serverId === sender.serverId && receiver.room?.code === sender.room.code) error('好友已在房间中');
      if ((this.state.mutes[target]?.[self] || 0) > this.now()) return { sent: true };
      const previous = this.state.invitations.find(row => row.from === self && row.to === target);
      if (previous && this.now() - previous.at < 10_000) error('邀请已发送，请稍候再试');
      this.state.invitations = this.state.invitations.filter(row => row.from !== self || row.to !== target);
      this.state.invitations.push({ id: id(), from: self, to: target, serverId: sender.serverId, code: sender.room.code,
        roomCreatedAt: sender.room.createdAt,
        modeName: socialModeName(sender.room), kind: receiver.state === 'playing' ? 'reservation' : 'invitation',
        status: 'pending', at: this.now(), expiresAt: this.now() + 120_000 });
      return { sent: true };
    }
    error('好友操作无效');
  }
}
