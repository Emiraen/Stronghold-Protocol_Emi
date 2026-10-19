import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatHub } from '../server/chat.js';

const session = (playerId = 'p_one', aid = null) => ({ playerId, aid, name: '小明' });

test('text uses server session identity, rejects empty and overlong UTF-16 content', () => {
  const hub = new ChatHub();
  const who = session();
  assert.deepEqual(hub.publishText(who, ''), { error: 'BAD_MSG' });
  assert.deepEqual(hub.publishText(who, '  \u200b\ufeff '), { error: 'BAD_MSG' });
  assert.deepEqual(hub.publishText(who, '😀'.repeat(101)), { error: 'BAD_MSG' });
  assert.deepEqual(hub.publishText(who, { text: 'hello', name: 'spoofed' }), { error: 'BAD_MSG' });
  const result = hub.publishText({ ...who, name: '服务端昵称' }, 'a'.repeat(200), 1);
  assert.equal(result.ok, true);
  assert.equal(result.message.t, 'chat.message');
  assert.equal(result.message.kind, 'text');
  assert.equal(result.message.name, '服务端昵称');
  assert.equal(result.message.playerId, 'p_one');
  assert.equal(result.message.text.length, 200);
  assert.equal(hub.history().length, 1);
});

test('configurable moderation masks the original spans after NFKC and separator folding', () => {
  const sent = [];
  const hub = new ChatHub({ sensitiveWords: ['敏感词', 'badword'], memberSink: (frame) => sent.push(frame) });
  const first = hub.publishText(session(), '没问题，敏-感\u200b词，别说ＢＡＤ－ｗｏｒｄ。', 1);
  assert.equal(first.ok, true);
  assert.equal(first.message.text, '没问题，***，别说***。');
  assert.deepEqual(hub.history(), sent);
  assert.equal(hub.history()[0].text.includes('敏'), false);
  assert.equal(hub.history()[0].text.includes('Ｂ'), false);
  assert.equal(hub.publishText(session('p_two'), '平常聊天，欢迎讨论。', 1).message.text, '平常聊天，欢迎讨论。');
});

test('defaults cover distinct abuse, scam, solicitation and privacy-leak phrases', () => {
  const hub = new ChatHub();
  const result = hub.publishText(session(), '傻\u200b逼，刷-单返利、招 嫖、身份证号不要发', 1);
  assert.equal(result.message.text, '***，***、***、***不要发');
  assert.equal(hub.history()[0].text, result.message.text);
});

test('text rate limit applies per aid across sessions: 2 seconds and 3 per 10 seconds', () => {
  const hub = new ChatHub();
  const first = session('p_first', 'same-aid');
  const resumed = session('p_second', 'same-aid');
  assert.equal(hub.publishText(first, 'one', 0).ok, true);
  assert.equal(hub.publishText(resumed, 'too soon', 1_999).error, 'RATE');
  assert.equal(hub.publishText(resumed, 'two', 2_000).ok, true);
  assert.equal(hub.publishText(first, 'three', 4_000).ok, true);
  assert.equal(hub.publishText(first, 'too many', 6_000).error, 'RATE');
  assert.equal(hub.publishText(first, 'window moved', 10_000).ok, true);
  assert.equal(hub.history().length, 4);
  assert.equal(hub.publishText(session('another'), 'different identity', 10_000).ok, true);
});

test('invite is independently throttled and always uses the server room code', () => {
  const sent = [];
  const hub = new ChatHub({ memberSink: (message) => sent.push(message) });
  const who = session();
  const room = { code: 'ABCD', text: 'fake text', name: 'fake name' };
  assert.deepEqual(hub.publishInvite(who, { code: 'bad<script>' }, 0), { error: 'BAD_MSG' });
  const first = hub.publishInvite(who, room, 0);
  assert.equal(first.message.kind, 'invite');
  assert.equal(first.message.code, 'ABCD');
  assert.equal(first.message.text, undefined);
  assert.equal(first.message.name, who.name);
  assert.equal(first.message.t, 'chat.message');
  assert.equal(hub.publishInvite(who, room, 9_999).error, 'RATE');
  assert.equal(hub.publishText(who, 'text is independent', 1).ok, true);
  assert.equal(hub.publishInvite(who, room, 10_000).ok, true);
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map((message) => message.id)).size, 3);
});

test('history retains only 50 sanitized messages and returns independent snapshots', () => {
  const hub = new ChatHub({ sensitiveWords: ['秘密'] });
  for (let i = 0; i < 51; i++) {
    assert.equal(hub.publishText(session(`p_${i}`), `秘密${i}`, i).ok, true);
  }
  const list = hub.history();
  assert.equal(list.length, 50);
  assert.equal(list[0].text, '***1');
  assert.equal(list.at(-1).text, '***50');
  list[0].text = 'not stored';
  list.push({});
  assert.equal(hub.history()[0].text, '***1');
  assert.equal(hub.history().length, 50);
});
