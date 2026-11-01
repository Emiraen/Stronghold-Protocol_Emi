import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import htm from 'htm';
import { PHASE } from '../../shared/constants.js';
import { battleChatDanmaku, battleEmotes } from '../../public/js/ui/gameLogic/watch.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const now = 100_000;
const players = [{ playerId: 'self', name: '自己', team: 0 }, { playerId: 'mate', name: '队友', team: 0 }, { playerId: 'other', name: '另一队', team: 1 }];
const pub = { phase: PHASE.COMBAT, players };
const message = (extra = {}) => ({ channel: 'match', kind: 'text', id: 'm1', matchId: 'match1', playerId: 'mate', text: '先守右边 ***', at: 1, danmakuAt: now, danmakuSeq: 7, ...extra });

test('文字弹幕：四种战斗阶段均显示自己及同队文字，保留正文和六秒寿命', () => {
  for (const phase of [PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]) {
    const list = ['self', 'mate', 'other', 'unknown'].map((playerId, index) => message({ playerId, id: String(index), danmakuSeq: index }));
    const actual = battleChatDanmaku(list, { ...pub, phase }, 'self', now + 5999);
    assert.deepEqual(actual.map(e => e.playerId), ['self', 'mate']);
    assert.equal(actual[1].text, '先守右边 ***');
    assert.equal(actual[1].name, '队友');
    assert.equal(actual[1].at, now);
    assert.equal(battleChatDanmaku(list, { ...pub, phase }, 'self', now + 6000).length, 0);
  }
  assert.equal(battleChatDanmaku([message()], { ...pub, phase: PHASE.PREP }, 'self', now).length, 0);
});

test('文字弹幕：不播放历史、公共聊天、邀请、无效或未来消息', () => {
  const invalid = [{ danmakuAt: undefined }, { danmakuSeq: undefined }, { channel: 'lobby' }, { kind: 'invite' }, { text: '' }, { text: '   ' }, { text: null }, { danmakuAt: NaN }, { danmakuAt: now + 1 }];
  assert.deepEqual(battleChatDanmaku(invalid.map(extra => message(extra)), pub, 'self', now), []);
  assert.deepEqual(battleChatDanmaku(null, pub, 'self', now), []);
  assert.deepEqual(battleChatDanmaku([message()], pub, 'spectator', now), []);
});

test('文字弹幕：无分组显示全房有效玩家，表情仍保持原行为', () => {
  const ungrouped = { ...pub, players: players.map(({ team, ...player }) => player) };
  assert.equal(battleChatDanmaku(players.map(p => message({ playerId: p.playerId })), ungrouped, 'self', now).length, 3);
  const emote = { playerId: 'mate', seq: 8, id: 'autochess_battle_happy', at: now };
  assert.equal(battleEmotes([emote], pub, 'self', now)[0].id, emote.id);
});

function wireHarness() {
  const source = read('../../public/js/main.js');
  const ast = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  let callback;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee?.object?.name === 'net' && node.callee?.property?.name === 'on' && node.arguments?.[0]?.value === 'chat.message') callback = node.arguments[1];
    for (const [key, value] of Object.entries(node)) if (!['start', 'end'].includes(key)) {
      if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast); assert.ok(callback);
  const state = { matchChat: { matchId: 'match1', items: [] }, chat: { items: [] } };
  const ctx = { seq: 20, Date: { now: () => now }, store: { get: () => state, set: update => Object.assign(state, typeof update === 'function' ? update(state) : update) } };
  const handle = runInNewContext('(' + source.slice(callback.start, callback.end) + ')', ctx);
  return { state, handle, ctx };
}

test('文字弹幕：仅接收本局实时文本，服务器回显一次，不更改聊天正文', () => {
  const { state, handle, ctx } = wireHarness();
  const live = message({ playerId: 'self' }); delete live.danmakuAt; delete live.danmakuSeq;
  handle(live);
  assert.equal(state.matchChat.items.length, 1);
  assert.equal(state.matchChat.items[0].text, live.text);
  assert.equal(state.matchChat.items[0].danmakuAt, now);
  assert.equal(state.matchChat.items[0].danmakuSeq, 21);
  handle(live);
  assert.equal(state.matchChat.items.length, 1);
  assert.equal(ctx.seq, 21);
  handle({ ...live, id: 'other-match', matchId: 'match2' });
  assert.equal(state.matchChat.items.length, 1);
  handle({ ...live, id: 'public', channel: 'lobby' });
  assert.equal(state.chat.items[0].danmakuAt, undefined);
  assert.equal(ctx.seq, 21);
});

test('文字弹幕：历史消息的重复送达不重播，聊天记录仍保持50条上限', () => {
  const { state, handle, ctx } = wireHarness();
  const history = message(); delete history.danmakuAt; delete history.danmakuSeq;
  state.matchChat.items = [history]; handle(history);
  assert.equal(state.matchChat.items[0].danmakuAt, undefined);
  assert.equal(ctx.seq, 20);
  for (let i = 0; i < 55; i++) handle({ ...history, id: 'live' + i });
  assert.equal(state.matchChat.items.length, 50);
  assert.equal(state.matchChat.items.at(-1).id, 'live54');
});

test('文字弹幕：HTML作为纯文字渲染，原表情图片分支仍存在', () => {
  const source = read('../../public/js/ui/emotes.js');
  const ast = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  const component = ast.body.find(n => n.type === 'ExportNamedDeclaration' && n.declaration?.id?.name === 'EmoteDanmaku').declaration;
  const html = htm.bind((type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }));
  const ctx = { html, trA: x => x, useEffect() {}, useState: fn => [fn()], Date: { now: () => now }, cx: (...args) => args.filter(Boolean).join(' '), emoteInfo: () => ({ label: '表情' }), EmoteArt() {} };
  runInNewContext(source.slice(component.start, component.end), ctx);
  const text = '<img src=x onerror=alert(1)> 中文😀';
  const tree = ctx.EmoteDanmaku({ emote: message({ text, kind: 'text', at: now }), name: '博士', lane: 2 });
  const descendants = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(descendants)];
  const nodes = descendants(tree);
  assert.equal(nodes.find(n => n.props.class === 'edanmaku__text').children[0], text);
  assert.equal(nodes.some(n => n.type === 'img'), false);
  assert.ok(tree.props.class.includes('edanmaku--text'));
  assert.equal(tree.props['aria-label'], '博士：' + text);
  const emote = ctx.EmoteDanmaku({ emote: { id: 'autochess_battle_happy', at: now }, name: '博士' });
  assert.equal(descendants(emote).some(n => n.type === ctx.EmoteArt), true);
});
