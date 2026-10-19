import { randomUUID } from 'node:crypto';
import { ERR } from '../shared/constants.js';

const MAX_HISTORY = 50;
const MAX_TEXT_LENGTH = 200;
const TEN_SECONDS = 10_000;
const rateKeys = (session) => [`player:${session.playerId}`, ...(session.aid ? [`aid:${session.aid}`] : [])];

// Keep this list specific: short everyday words would censor unrelated conversation.
export const DEFAULT_SENSITIVE_WORDS = Object.freeze([
  '傻逼', '傻叉', '滚你妈', '废物东西',
  '刷单返利', '杀猪盘', '免押贷款', '骗钱',
  '招嫖', '援交', '色情服务',
  '人肉搜索', '身份证号', '银行卡密码', '家庭住址',
]);

// Retain the original UTF-16 offsets so that masking never broadcasts the original spelling,
// including full-width forms and separators inserted between the sensitive characters.
function fold(text) {
  let value = '';
  const spans = [];
  for (let index = 0; index < text.length;) {
    const character = String.fromCodePoint(text.codePointAt(index));
    const end = index + character.length;
    for (const normalized of character.normalize('NFKC').toLowerCase()) {
      if (!/[\s\p{P}\p{S}\p{Cf}]/u.test(normalized)) {
        value += normalized;
        for (let unit = 0; unit < normalized.length; unit++) spans.push({ start: index, end });
      }
    }
    index = end;
  }
  return { value, spans };
}

function mask(text, words) {
  const { value, spans } = fold(text);
  const hits = [];
  for (const word of words) {
    let from = 0;
    while ((from = value.indexOf(word, from)) !== -1) {
      hits.push({ start: spans[from].start, end: spans[from + word.length - 1].end });
      from += 1;
    }
  }
  if (!hits.length) return text;
  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  let filtered = '';
  let cursor = 0;
  for (const hit of hits) {
    if (hit.end <= cursor) continue;
    if (hit.start > cursor) filtered += text.slice(cursor, hit.start);
    filtered += '***';
    cursor = hit.end;
  }
  return filtered + text.slice(cursor);
}

/** Server-owned, room-independent public chat; the lobby owns routing and membership checks. */
export class ChatHub {
  constructor({ memberSink = null, sensitiveWords = DEFAULT_SENSITIVE_WORDS, frameFields = {} } = {}) {
    this.frameFields = { ...frameFields };
    this.memberSink = memberSink;
    this.words = [...new Set(sensitiveWords.map((word) => fold(word).value).filter(Boolean))];
    this.messages = [];
    this.limits = new Map();
  }

  history() { return this.messages.map((message) => ({ ...message })); }

  publishText(session, text, now = Date.now()) {
    if (!session?.playerId || typeof session.name !== 'string' || typeof text !== 'string' ||
        text.length > MAX_TEXT_LENGTH || !/[^\s\p{Cf}]/u.test(text)) return { error: ERR.BAD_MSG };
    // Check both stable session identity and client-provided aid: rotating hello.aid must not reset a live session's limit.
    const keys = rateKeys(session);
    const states = keys.map((key) => this.limits.get(key) || { texts: [], invite: -Infinity });
    if (states.some((state) => { const recent = state.texts.filter((at) => now - at < TEN_SECONDS);
      return recent.length >= 3 || (recent.length && now - recent.at(-1) < 2_000); })) return { error: ERR.RATE };
    const message = this.record({ kind: 'text', playerId: session.playerId,
      name: mask(session.name, this.words), text: mask(text, this.words), at: now });
    states.forEach((state, index) => { state.texts = [...state.texts.filter((at) => now - at < TEN_SECONDS), now]; this.limits.set(keys[index], state); });
    return { ok: true, message };
  }

  publishInvite(session, room, now = Date.now()) {
    if (!session?.playerId || typeof session.name !== 'string' ||
        typeof room?.code !== 'string' || !/^[A-HJ-NP-Z]{4}$/.test(room.code)) return { error: ERR.BAD_MSG };
    const keys = rateKeys(session);
    const states = keys.map((key) => this.limits.get(key) || { texts: [], invite: -Infinity });
    if (states.some((state) => now - state.invite < TEN_SECONDS)) return { error: ERR.RATE };
    const message = this.record({ kind: 'invite', playerId: session.playerId,
      name: mask(session.name, this.words), code: room.code, ...(room.serverId ? { serverId: room.serverId } : {}), at: now });
    states.forEach((state, index) => { state.invite = now; this.limits.set(keys[index], state); });
    return { ok: true, message };
  }

  record(data) {
    const message = { t: 'chat.message', id: randomUUID(), ...this.frameFields, ...data };
    this.messages.push(message);
    if (this.messages.length > MAX_HISTORY) this.messages.shift();
    if (this.memberSink) this.memberSink({ ...message });
    return { ...message };
  }
}
