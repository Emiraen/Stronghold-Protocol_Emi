import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startServer } from '../../server/index.js';
import { RankedStore } from '../../server/rankedStore.js';
import { HistoryStore } from '../../server/historyStore.js';
import { PlayerStore } from '../../server/playerStore.js';

const out = process.env.SOCIAL_SHOTS || path.resolve(import.meta.dirname, '../e2e/out/social');
// 此旧流程只覆盖桌面及桌面窄窗；手机真实横屏/竖屏阻断由chat-landscape.e2e.test.js验证。
const sizes = [[1440, 900], [844, 390], [390, 844]];
async function request(page, t, fields = {}) {
  return page.evaluate(async (t, fields) => (await import('/js/net.js')).net.request(t, fields), t, fields);
}
async function state(page) {
  return page.evaluate(async () => (await import('/js/store.js')).store.get());
}
async function clickText(page, text) {
  const clicked = await page.evaluate((text) => {
    const node = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    if (!node || node.disabled) return false;
    node.click(); return true;
  }, text);
  assert.ok(clicked, `按钮不可用：${text}`);
}
async function settle(page) {
  await page.waitForFunction(() => !document.querySelector('.pbanner'), { timeout: 15000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}
async function bounds(page, selector) {
  const b = await page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight };
  });
  assert.ok(b.x >= -1 && b.y >= -1 && b.right <= b.width + 1 && b.bottom <= b.height + 1, `${selector} 超出屏幕 ${JSON.stringify(b)}`);
}

test('真实五浏览器：四人聊天、只读观战、视角切换、断线及三尺寸截图', { timeout: 240000 }, async () => {
  mkdirSync(out, { recursive: true });
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, seedFn: () => 721,
    ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }), players: new PlayerStore({ file: null }) });
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const errors = [];
  const measurements = [];
  const remote = [];
  const pages = [];
  try {
    for (let i = 0; i < 5; i++) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      pages.push(page);
      page.on('pageerror', (err) => errors.push(err.message));
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const url = req.url();
        if (/^(data:|blob:)/.test(url) || url.startsWith(`http://127.0.0.1:${srv.port}/`)) req.continue();
        else { remote.push(url); req.abort(); }
      });
      await page.setViewport({ width: 1440, height: 900, hasTouch: false });
      await page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.title-screen', { timeout: 25000 });
      await page.type('input[placeholder*="代号"]', i === 4 ? '本地观众' : `本地队员${i + 1}`);
      // 标题出现不等于WebSocket握手完成，等待真实可用的开始按钮。
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '开始' && !b.disabled));
      await clickText(page, '开始');
      await page.waitForSelector('.lobby-screen', { timeout: 25000 });
    }
    const [host, ...others] = pages;
    const team = pages.slice(0, 4);
    const viewer = pages[4];
    for (const [width, height] of sizes) {
      await host.setViewport({ width, height, hasTouch: false });
      await settle(host);
      assert.equal(await host.$('.sp-chat__panel'), null, '聊天默认收起');
      await bounds(host, '.sp-chat__toggle');
      await host.screenshot({ path: path.join(out, `lobby-closed-${width}x${height}.png`) });
      await host.click('.sp-chat__toggle');
      await settle(host);
      await bounds(host, '.sp-chat__panel');
      await host.screenshot({ path: path.join(out, `lobby-open-${width}x${height}.png`) });
      await host.click('.sp-chat__close');
    }
    await host.setViewport({ width: 1440, height: 900, hasTouch: false });
    await request(host, 'room.create', { mode: 'coop', difficulty: 'FUNNY', ranked: false });
    await host.waitForSelector('.room-screen');
    const code = (await state(host)).room.code;
    for (const member of team.slice(1)) {
      await request(member, 'room.join', { code });
      await request(member, 'room.ready', { ready: true });
    }
    for (const [width, height] of sizes) {
      await host.setViewport({ width, height, hasTouch: false });
      await host.click('.sp-chat__toggle');
      await settle(host);
      await bounds(host, '.sp-chat__panel');
      await bounds(host, '.sp-chat__share');
      await host.screenshot({ path: path.join(out, `room-open-${width}x${height}.png`) });
      await host.click('.sp-chat__close');
    }
    await host.setViewport({ width: 1440, height: 900, hasTouch: false });
    await request(host, 'room.start');
    await host.waitForSelector('.sp-chat--match');
    for (let i = 0; i < 4; i++) {
      const page = team[i];
      await page.waitForSelector('.sp-chat--match');
      assert.equal(await page.$('.sp-chat__panel'), null);
      await page.click('.sp-chat__toggle');
      await page.type('.sp-chat__compose input', `四人实测消息${i + 1}：注意协作`);
      await page.click('.sp-chat__compose button');
      await page.waitForFunction((text) => document.querySelector('.sp-chat__list')?.textContent.includes(text), {}, `四人实测消息${i + 1}`);
      await page.click('.sp-chat__close');
    }
    for (const page of team) {
      const s = await state(page);
      assert.equal(s.matchChat.items.length, 4);
      assert.ok(!s.chat.items.some((x) => x.text?.includes('四人实测消息')));
    }
    assert.equal((await state(viewer)).chat.items.length, 0);
    await clickText(viewer, '观战大厅 · 观看进行中的对局');
    await viewer.waitForSelector('.spectator-hall__card');
    for (const [width, height] of sizes) {
      await viewer.setViewport({ width, height, hasTouch: false });
      await settle(viewer);
      await bounds(viewer, '.spectator-hall__header');
      await viewer.screenshot({ path: path.join(out, `spectator-hall-${width}x${height}.png`) });
    }
    await viewer.setViewport({ width: 1440, height: 900, hasTouch: false });
    await clickText(viewer, '进入观战');
    await viewer.waitForSelector('.spectator-bar', { timeout: 25000 });
    assert.equal((await state(viewer)).match.private, null);
    assert.equal(await viewer.$('.sp-chat'), null);
    assert.equal(await viewer.$('.shopbar'), null);
    await assert.rejects(request(viewer, 'g.ready', { ready: true }));
    await assert.rejects(request(viewer, 'b.progress', { battleId: 'forged', gt: 0, killed: 0, total: 0 }));
    for (const page of team) await request(page, 'g.infoReady');
    const room = srv.lobby.getRoom(code);
    await host.waitForFunction(async () => (await import('/js/store.js')).store.get().match.public?.phase === 'BAND_DRAFT');
    for (let i = 0; i < 4; i++) {
      const pid = room.match.draftTurn();
      const page = await Promise.all(team.map(state)).then((states) => team[states.findIndex((s) => s.me.playerId === pid)]);
      await request(page, 'g.band', { bandId: room.match.defaultBand(pid) });
    }
    await host.waitForSelector('.gm--prep', { timeout: 20000 });
    await viewer.waitForFunction(async () => (await import('/js/store.js')).store.get().match.public?.phase === 'PREP');
    const target = (await state(team[1])).me.playerId;
    await viewer.select('select[aria-label="观战视角"]', target);
    await viewer.waitForFunction(async (id) => (await import('/js/store.js')).store.get().match.field?.fieldId === `n:${id}`, {}, target);
    await host.click('.team__row:nth-child(2) .team__btn');
    if (await host.$('.team__ob')) await host.click('.team__ob');
    await host.waitForFunction(async (id) => (await import('/js/store.js')).store.get().match.field?.fieldId === `n:${id}`, {}, target);
    await host.click('.team__row.is-self .team__btn');
    await host.waitForFunction(async () => {
      const s = (await import('/js/store.js')).store.get();
      return s.match.field?.fieldId === `n:${s.me.playerId}`;
    });
    for (const [width, height] of sizes) {
      await host.setViewport({ width, height, hasTouch: false });
      await settle(host);
      await bounds(host, '.sp-chat__toggle');
      assert.equal(await host.$('.sp-chat__panel'), null);
      assert.equal(await host.evaluate(() => {
        const chat = document.querySelector('.sp-chat--match').getBoundingClientRect();
        const corner = document.querySelector('.gm__corner').getBoundingClientRect();
        return chat.bottom + 6 <= corner.top;
      }), true, 'left-bottom chat reserves a separate row above game controls');
      await host.screenshot({ path: path.join(out, `match-closed-${width}x${height}.png`) });
      await host.click('.sp-chat__toggle');
      await settle(host);
      await bounds(host, '.sp-chat__panel');
      await bounds(host, '.sp-chat__compose input');
      assert.equal(await host.$$eval('.sp-chat__message', (els) => els.length), 4);
      await host.screenshot({ path: path.join(out, `match-open-${width}x${height}.png`) });
      measurements.push({ width, height, panel: await host.$eval('.sp-chat__panel', (el) => ({ height: el.clientHeight, width: el.clientWidth })) });
      if (width === 390) {
        await host.focus('.sp-chat__compose input');
        await host.evaluate(() => {
          Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 320 });
          visualViewport.dispatchEvent(new Event('resize'));
        });
        await host.waitForSelector('.sp-chat.has-keyboard');
        const bottom = await host.$eval('.sp-chat__compose', (el) => el.getBoundingClientRect().bottom);
        assert.ok(bottom <= 320, `键盘可见区内输入框 ${bottom}`);
        await host.screenshot({ path: path.join(out, 'match-keyboard-emulated-390x844.png') });
        await host.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
      }
      await host.click('.sp-chat__close');
      await viewer.setViewport({ width, height, hasTouch: false });
      await settle(viewer);
      await bounds(viewer, '.spectator-bar');
      await bounds(viewer, 'select[aria-label="观战视角"]');
      await viewer.screenshot({ path: path.join(out, `spectator-prep-${width}x${height}.png`) });
    }
    await viewer.reload({ waitUntil: 'domcontentloaded' });
    await viewer.waitForSelector('.spectator-bar', { timeout: 25000 });
    assert.equal((await state(viewer)).spectator.code, code);
    assert.equal((await state(viewer)).match.private, null);
    await viewer.select('select[aria-label="观战视角"]', target);
    for (const page of team) await request(page, 'g.ready', { ready: true });
    await viewer.waitForFunction(async () => !!(await import('/js/store.js')).store.get().match.battle?.watch, { timeout: 25000 });
    const spectatorBattle = (await state(viewer)).match.battle;
    assert.equal(spectatorBattle.authoritative, false);
    assert.equal(spectatorBattle.watch, true);
    const firstId = (await state(host)).me.playerId;
    const own = room.match.fields.find((f) => f.players.includes(firstId));
    const other = room.match.fields.find((f) => f.players.includes(target));
    const authority = own.authority;
    await host.click('.team__row:nth-child(2) .team__btn');
    await host.waitForSelector('.team__ob');
    await host.click('.team__ob');
    await host.waitForFunction(async (id) => (await import('/js/store.js')).store.get().match.battle?.fieldId === id, {}, other.fieldId);
    assert.equal(room.match.fields.find((f) => f.players.includes(firstId)).authority, authority);
    assert.equal((await state(host)).match.battle.authoritative, false);
    for (const [width, height] of sizes) {
      await viewer.setViewport({ width, height, hasTouch: false });
      await settle(viewer);
      await viewer.screenshot({ path: path.join(out, `spectator-combat-${width}x${height}.png`) });
    }
    await clickText(viewer, '离开观战');
    await viewer.waitForSelector('.lobby-screen');
    assert.equal((await state(viewer)).spectator, null);
    await clickText(viewer, '观战大厅 · 观看进行中的对局');
    await viewer.waitForSelector('.spectator-hall__card');
    await clickText(viewer, '进入观战');
    await viewer.waitForSelector('.spectator-bar');
    room.match.finish({ victory: false, reason: 'defeat' });
    await viewer.waitForSelector('.lobby-screen');
    assert.equal((await state(viewer)).match.result, null);
    assert.equal((await state(viewer)).match.public, null);
    assert.deepEqual(errors, [], `浏览器异常：${errors.join('; ')}`);
    console.log('五个独立浏览器上下文与真实 WebSocket 验证完成；截图目录：', out);
    writeFileSync(path.join(out, 'browser-report.json'), JSON.stringify({ clients: 5, sizes, measurements, errors, blockedRemoteRequests: remote, keyboard: 'visualViewport 模拟，非实体手机键盘' }, null, 2));
  } finally { await browser.close(); await srv.close(); }
});
