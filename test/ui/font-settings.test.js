import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { TEXT_SIZES, TEXT_SIZE_LABELS, DEFAULT_SETTINGS, sanitizeSettings } from '../../public/js/ui/gameLogic/settings.js';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const settingsSource = read('../../public/js/ui/settings.js');
const theme = read('../../public/css/theme.css');
const emotes = read('../../public/css/emotes.css');

test('字号：新增两档更小文字，原有默认和标签保持不变', () => {
  assert.deepEqual(TEXT_SIZES, ['xxs', 'xs', 'sm', 'md', 'lg', 'xl']);
  assert.deepEqual(TEXT_SIZES.map(id => TEXT_SIZE_LABELS[id]), ['极小', '小', '标准', '中', '大', '特大']);
  assert.equal(DEFAULT_SETTINGS.textSize, 'sm');
  assert.equal(DEFAULT_SETTINGS.danmakuTextSize, 'sm');
  assert.deepEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS });
  for (const id of ['sm', 'md', 'lg', 'xl']) assert.equal(sanitizeSettings({ textSize: id }).textSize, id);
});

test('字号：界面和弹幕可独立选择、持久化和恢复全部档位', () => {
  for (const textSize of TEXT_SIZES) for (const danmakuTextSize of TEXT_SIZES) {
    const original = sanitizeSettings({ textSize, danmakuTextSize, bgm: .35, damageNumbers: false, fpsLimit: 60 });
    assert.deepEqual(sanitizeSettings(JSON.parse(JSON.stringify(original))), original);
    const changed = sanitizeSettings({ ...original, textSize: 'xs' });
    assert.equal(changed.danmakuTextSize, danmakuTextSize);
    assert.equal(changed.bgm, .35);
    assert.equal(changed.damageNumbers, false);
    assert.equal(changed.fpsLimit, 60);
    assert.equal(sanitizeSettings({ ...original, danmakuTextSize: 'xxs' }).textSize, textSize);
  }
});

test('字号：旧偏好迁移与无效值回退不会改变其它设置', () => {
  for (const value of [undefined, null, '', 'invalid', 0, {}, '__proto__']) {
    const actual = sanitizeSettings({ textSize: value, danmakuTextSize: value, sfx: .45, muted: true });
    assert.equal(actual.textSize, 'sm');
    assert.equal(actual.danmakuTextSize, 'sm');
    assert.equal(actual.sfx, .45);
    assert.equal(actual.muted, true);
  }
  assert.equal(sanitizeSettings({ textSize: 'lg' }).danmakuTextSize, 'sm');
});

test('字号：根属性即时应用、互不覆盖且缺少 DOM 时可安全加载', () => {
  const ast = parse(settingsSource, { sourceType: 'module', ecmaVersion: 'latest' });
  const names = ['applyTextSize', 'applyDanmakuTextSize'];
  const functions = ast.body.filter(n => n.type === 'ExportNamedDeclaration' && names.includes(n.declaration?.id?.name));
  assert.equal(functions.length, 2);
  const declarations = functions.map(n => settingsSource.slice(n.declaration.start, n.declaration.end)).join(';');
  const attributes = new Map();
  const ctx = { TEXT_SIZES, document: { documentElement: { setAttribute: (name, value) => attributes.set(name, value) } } };
  runInNewContext(declarations, ctx);
  ctx.applyTextSize('xs'); ctx.applyDanmakuTextSize('xl');
  assert.equal(attributes.get('data-text'), 'xs');
  assert.equal(attributes.get('data-danmaku-text'), 'xl');
  ctx.applyTextSize('xxs');
  assert.equal(attributes.get('data-danmaku-text'), 'xl');
  ctx.applyDanmakuTextSize('bad');
  assert.equal(attributes.get('data-text'), 'xxs');
  assert.equal(attributes.get('data-danmaku-text'), 'sm');
  delete ctx.document;
  assert.doesNotThrow(() => { ctx.applyTextSize('sm'); ctx.applyDanmakuTextSize('sm'); });
  assert.ok(settingsSource.includes('applyDanmakuTextSize(settingsStore.get().danmakuTextSize)'));
  assert.ok(settingsSource.includes('applyDanmakuTextSize(s.danmakuTextSize)'));
  assert.ok(settingsSource.includes('updateSettings({ danmakuTextSize: id })'));
});

test('字号：较小档位只改文字根，弹幕字号不改变图标与运动参数', () => {
  assert.ok(theme.includes(':root[data-text="xxs"] { --t: calc(1rem * .7); }'));
  assert.ok(theme.includes(':root[data-text="xs"] { --t: calc(1rem * .85); }'));
  assert.ok(emotes.includes(':root[data-danmaku-text="xxs"] { --danmaku-font-size: .084rem; }'));
  assert.ok(emotes.includes(':root[data-danmaku-text="xs"] { --danmaku-font-size: .102rem; }'));
  assert.ok(emotes.includes('font-size: var(--danmaku-font-size, .12rem)'));
  assert.ok(emotes.includes('width: .34rem; height: .34rem;'));
  assert.ok(emotes.includes('animation: edanmaku-fly 6s linear forwards'));
  assert.ok(emotes.includes('pointer-events: none'));
  assert.ok(emotes.includes('prefers-reduced-motion: reduce'));
});
