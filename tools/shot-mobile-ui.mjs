// #27 仅本地针对性验收：随机回环端口、内存存储、拦截外站请求，不访问既有服务。
// node tools/shot-mobile-ui.mjs <输出目录> [场景过滤，如 game-568]
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer } from '../server/index.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { PlayerStore } from '../server/playerStore.js';
import { TestClient } from '../test/helpers/wsClient.js';
import { visibleViewport } from '../public/js/ui/device.js';

const out = path.resolve(process.argv[2] || 'test/e2e/out/emi27');
const filter = process.argv[3] || '';
fs.mkdirSync(out, { recursive: true });
assert.deepEqual(visibleViewport({ innerWidth: 568, innerHeight: 320 }), { top: 0, left: 0, width: 568, height: 320, bottom: 320, right: 568, bottomGap: 0, keyboard: false });
const results = [], errors = [], clients = [];
const srv = await startServer({ port: 0, host: '127.0.0.1', admin: false, quiet: true,
  ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }), players: new PlayerStore({ file: null }),
  rateBurst: 1000, heavyBurst: 1000 });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update'] });
const version = await browser.version();
const frame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function newPage(width, height) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, isMobile: width < 1000, hasTouch: width < 1000, isLandscape: width > height });
  page.on('pageerror', (e) => errors.push({ url: page.url(), message: e.message }));
  await page.setRequestInterception(true);
  page.on('request', (r) => r.url().startsWith(srv.url + '/') || /^(data|blob):/.test(r.url()) ? r.continue() : r.abort());
  return { page, context };
}
async function hit(page, selector, { scroll = false, optional = false } = {}) {
  if (scroll) await page.$eval(selector, (e) => e.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  await frame(page);
  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { selector: sel, missing: true };
    const r = el.getBoundingClientRect();
    const vv = visualViewport;
    const css = getComputedStyle(document.documentElement);
    const sa = (s) => parseFloat(css.getPropertyValue('--sa-' + s)) || 0;
    const bounds = { top: (vv?.offsetTop || 0) + sa('t'), bottom: (vv?.offsetTop || 0) + (vv?.height || innerHeight) - sa('b'),
      left: (vv?.offsetLeft || 0) + sa('l'), right: (vv?.offsetLeft || 0) + (vv?.width || innerWidth) - sa('r') };
    const points = [[.5, .5], [.2, .5], [.8, .5], [.5, .2], [.5, .8]].map(([x, y]) => {
      const target = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y);
      return { x, y, hit: target === el || !!target && el.contains(target), target: target?.className?.baseVal ?? target?.className ?? null };
    });
    return { selector: sel, text: el.textContent.trim().slice(0, 60), disabled: !!el.disabled,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height }, bounds,
      visible: r.width > 0 && r.height > 0 && r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1 && r.left >= bounds.left - 1 && r.right <= bounds.right + 1,
      points, reachable: points.every((p) => p.hit), rootOverflow: document.documentElement.scrollWidth > innerWidth + 2 };
  }, selector);
  if (!optional) {
    if (!result.visible || !result.reachable) {
      await page.screenshot({ path: path.join(out, `emi27-failure-${page.viewport().width}-${selector.replace(/[^a-z0-9]/gi, '_')}.png`) });
      result.diagnostic = await page.evaluate((sel) => {
        const el = document.querySelector(sel); const ancestors = [];
        for (let n = el; n; n = n.parentElement) { const s = getComputedStyle(n); const r = n.getBoundingClientRect(); ancestors.push({ tag: n.tagName, class: n.className, z: s.zIndex, position: s.position, overflow: s.overflow, transform: s.transform, height: r.height, top: r.top }); }
        return { ancestors, vv: { height: visualViewport?.height, top: visualViewport?.offsetTop }, scroll: { x: scrollX, y: scrollY } };
      }, selector);
    }
    assert.equal(result.visible, true, JSON.stringify(result));
    assert.equal(result.reachable, true, JSON.stringify(result));
    assert.equal(result.rootOverflow, false, JSON.stringify(result));
  }
  return result;
}
async function tap(page, selector, opts = {}) {
  const checked = await hit(page, selector, opts);
  assert.equal(checked.disabled, false, `按钮禁用 ${selector}`);
  const { x, y, width, height } = checked.rect;
  if ((await page.viewport()).hasTouch) await page.touchscreen.tap(x + width / 2, y + height / 2);
  else await page.mouse.click(x + width / 2, y + height / 2);
  return checked;
}
async function textSelector(page, selector, text) {
  await page.evaluate((sel, wanted) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(wanted));
    if (!el) throw new Error('找不到控件 ' + wanted);
    el.dataset.emi27Target = '1';
  }, selector, text);
  return '[data-emi27-target="1"]';
}
async function tapText(page, selector, text, opts = {}) {
  await page.evaluate(() => document.querySelectorAll('[data-emi27-target]').forEach((e) => delete e.dataset.emi27Target));
  return tap(page, await textSelector(page, selector, text), opts);
}
async function screenshot(page, name) {
  const filename = name + '.png';
  await page.screenshot({ path: path.join(out, filename) });
  return filename;
}
async function request(page, type, fields = {}) {
  return page.evaluate(async (t, f) => (await import('/js/net.js')).net.request(t, f), type, fields);
}
async function login(page, name) {
  await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.title-screen');
  await page.type('input[placeholder*="代号"]', name);
  await tapText(page, '.title-screen button', '开始');
  await page.waitForSelector('.lobby-screen');
}
async function bot(name) {
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  clients.push(c); c.id = (await c.hello(name)).playerId;
  return c;
}
async function ok(c, message) { const r = await c.request(message); assert.equal(r.t, 'ok', JSON.stringify(r)); }
async function checkBox(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    const body = el.querySelector('.modal__body, .rsettle__content');
    return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, bodyScrollable: !!body && body.scrollHeight > body.clientHeight,
      bodyHeight: body?.clientHeight, horizontalOverflow: !!body && body.scrollWidth > body.clientWidth + 2 };
  });
}
async function run(name, fn) {
  if (filter && !filter.split(',').some((part) => name.includes(part))) return;
  const row = { scenario: name, passed: false, hits: [], screenshots: [] }; results.push(row);
  try { await fn(row); row.passed = true; } catch (e) { row.failure = e.message; console.error(name, e.message); }
  console.log(name, row.passed ? '通过' : '失败');
}
try {
  for (const [width, height] of [[844, 390], [667, 375], [568, 320], [1440, 900]]) {
    await run(`social-${width}x${height}`, async (row) => {
      const { page, context } = await newPage(width, height);
      try {
        await login(page, `横屏${width}`);
        if (width === 568 || width === 1440) {
          row.hits.push(await tap(page, '.rank-help-toggle', { scroll: true }));
          await page.waitForSelector('.rank-help'); await frame(page);
          row.hits.push(await hit(page, '.rank-help .modal__actions button'));
          row.rankHelp = await checkBox(page, '.rank-help'); assert.equal(row.rankHelp.horizontalOverflow, false);
          await tapText(page, '.rank-help button', '关闭');
        }
        row.hits.push(await tap(page, '.sp-chat__toggle'));
        await page.waitForSelector('.sp-chat__panel');
        row.hits.push(await hit(page, '.sp-chat__compose input'));
        row.hits.push(await tap(page, '.sp-chat__close'));
        row.hits.push(await tapText(page, '.create-box button', '创建同盟', { scroll: true }));
        await page.waitForSelector('.room-screen');
        row.hits.push(await hit(page, '.room-bar__right button'));
        row.hits.push(await tap(page, '.room-screen .sp-chat__toggle'));
        row.hits.push(await hit(page, '.sp-chat__compose input'));
        row.hits.push(await hit(page, '.sp-chat__share'));
        row.hits.push(await hit(page, '.room-bar__right button'));
        row.screenshots.push(await screenshot(page, `emi27-room-${width}x${height}`));
        await tap(page, '.sp-chat__close');
        const own = await page.evaluate(async () => { const { store } = await import('/js/store.js'); return { code: store.get().room.code, id: store.get().me.playerId }; });
        const partner = await bot(`队友${width}`); await ok(partner, { t: 'room.join', code: own.code });
        const other = await bot(`另一队${width}`); const guest = await bot(`另一队友${width}`);
        await ok(other, { t: 'room.create', mode: 'coop', difficulty: 'ABYSS', ranked: true });
        const otherRoom = await other.waitFor('room.state', (s) => s.hostId === other.id);
        await ok(guest, { t: 'room.join', code: otherRoom.code });
        await request(page, 'room.matchFill', { searching: true }); await ok(other, { t: 'room.matchFill', searching: true });
        await page.waitForSelector('.match-confirm');
        await page.waitForFunction(() => !document.querySelector('.match-confirm').getAnimations().some((a) => a.playState === 'running'));
        row.dialog = await checkBox(page, '.match-confirm'); assert.equal(row.dialog.horizontalOverflow, false);
        row.timer = await hit(page, '.match-confirm [role="timer"]');
        const candidate = await page.evaluate(async () => (await import('/js/store.js')).store.get().room.matchCandidate);
        row.deadlineMs = candidate.deadline - Date.now(); assert.ok(row.deadlineMs > 0 && row.deadlineMs <= 20000);
        for (const difficulty of candidate.allowed) row.hits.push(await hit(page, `.match-confirm [data-difficulty="${difficulty}"]`, { scroll: true }));
        row.hits.push(await tap(page, '.match-confirm [data-difficulty="NORMAL"]', { scroll: true }));
        await page.waitForFunction(() => document.querySelector('.match-confirm [data-difficulty="NORMAL"]').textContent.includes('1 票'));
        row.realVote = true;
        row.hits.push(await tapText(page, '.match-confirm .modal__actions button', '确认参加'));
        await page.waitForFunction(() => document.querySelector('.match-confirm .modal__actions').textContent.includes('已确认'));
        row.realConfirm = true;
        row.screenshots.push(await screenshot(page, `emi27-match-${width}x${height}`));
        await tapText(page, '.match-confirm .modal__actions button', '拒绝本次匹配');
        await page.waitForSelector('.match-confirm', { hidden: true });
        await Promise.all([partner, other, guest].map((c) => c.terminate()));
        if (width === 568) {
          // 准备按钮用真实浏览器访客，不用修改 DOM 伪造按钮。
          const guestTab = await newPage(width, height);
          try {
            await login(guestTab.page, '准备验收'); await request(guestTab.page, 'room.join', { code: own.code });
            await guestTab.page.waitForSelector('.room-screen');
            row.hits.push(await tapText(guestTab.page, '.room-bar__right button', '准备就绪'));
            await guestTab.page.waitForFunction(() => document.querySelector('.room-bar__right').textContent.includes('已就绪'));
            row.realReady = true;
          } finally { await guestTab.context.close(); }
          await page.setViewport({ width: 320, height: 568, isMobile: true, hasTouch: true, isLandscape: false });
          await page.waitForFunction(() => document.documentElement.classList.contains('sp-landscape-blocked'));
          row.portraitGuard = await page.evaluate(() => ({ inert: document.getElementById('app').inert, dialog: document.querySelector('.rotate-hint').open }));
          assert.deepEqual(row.portraitGuard, { inert: true, dialog: true });
        }
        if (width === 1440) {
          await page.setViewport({ width: 390, height: 844, isMobile: false, hasTouch: false });
          await frame(page);
          assert.equal(await page.evaluate(() => document.documentElement.classList.contains('sp-landscape-blocked')), false);
          row.desktopNarrowUnblocked = true;
        }
      } finally { await context.close(); }
    });
    await run(`game-${width}x${height}`, async (row) => {
      const { page, context } = await newPage(width, height);
      try {
        await page.goto(`${srv.url}/dev/game-mock.html?shot=1&render=engine&phase=PREP`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.gm__corner'); await page.waitForSelector('.gm__loading', { hidden: true });
        await page.evaluate(async () => {
          document.getElementById('mockbar').style.display = 'none';
          const { store } = await import('/js/store.js');
          store.set({ matchChat: { matchId: 'emi27-mock', items: [] } });
        });
        row.hits.push(await tap(page, '.sp-chat__toggle'));
        row.hits.push(await hit(page, '.sp-chat__compose input'));
        const tools = await page.$$eval('.gm__corner button', (els) => els.map((e, i) => { e.dataset.emi27Tool = i; return `[data-emi27-tool="${i}"]`; }));
        for (const sel of tools) row.hits.push(await hit(page, sel, { scroll: true }));
        row.screenshots.push(await screenshot(page, `emi27-game-chat-${width}x${height}`));
        await tap(page, '.sp-chat__close');
        row.hits.push(await tap(page, '.toolbtn--ice')); row.freezeTapped = true;
        row.hits.push(await tap(page, '.toolbtn--amber')); row.refreshTapped = true;
        row.hits.push(await hit(page, '.lvcard', { scroll: true }));
        row.hits.push(await tap(page, '.shopbar__cards .scard:not(.scard--sold)', { scroll: true }));
        await page.waitForSelector('.scard.is-armed');
        row.hits.push(await hit(page, '.scard.is-armed'));
        row.hits.push(await tap(page, '.funds__collapse', { scroll: true }));
        await page.waitForSelector('.shopbar-tab__btn'); row.hits.push(await tap(page, '.shopbar-tab__btn'));
        if (width === 568 || width === 1440) {
          row.hits.push(await tap(page, '.gm__gear[aria-label="设置"]'));
          await page.waitForSelector('.modal__box'); await frame(page);
          row.settings = await checkBox(page, '.modal__box'); assert.equal(row.settings.horizontalOverflow, false);
          row.hits.push(await hit(page, '.modal__actions button'));
          await page.$eval('.modal__body', (e) => { e.scrollTop = e.scrollHeight; });
          row.hits.push(await hit(page, '.modal__actions button'));
          await page.keyboard.press('Escape'); await page.waitForSelector('.modal__box', { hidden: true });
          row.hits.push(await tap(page, '.gm__guide'));
          await page.waitForSelector('.guide__close'); await frame(page);
          row.hits.push(await hit(page, '.guide__close'));
          row.hits.push(await hit(page, '.guide__next'));
          await tap(page, '.guide__close');
        }
        if (width === 667) {
          // 仅模拟 API 属性与 CSS 安全区，不是实机键盘/刘海测试。
          await page.evaluate(() => {
            const vv = visualViewport;
            Object.defineProperties(vv, { height: { configurable: true, get: () => 220 }, offsetTop: { configurable: true, get: () => 28 } });
            const root = document.documentElement;
            root.style.setProperty('--sa-t', '8px'); root.style.setProperty('--sa-b', '10px');
            root.style.setProperty('--sa-l', '20px'); root.style.setProperty('--sa-r', '12px');
            vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll'));
          });
          await frame(page);
          row.hits.push(await tap(page, '.sp-chat__toggle'));
          row.keyboardHits = [await hit(page, '.sp-chat__compose input'), await hit(page, '.sp-chat__close')];
          row.keyboardHits.push(await hit(page, '.gm__gear[aria-label="设置"]', { scroll: true }));
          row.screenshots.push(await screenshot(page, 'emi27-keyboard-safearea-simulated-667'));
          await tap(page, '.sp-chat__close');
          await page.evaluate(() => {
            delete visualViewport.height; delete visualViewport.offsetTop;
            for (const side of ['t', 'b', 'l', 'r']) document.documentElement.style.removeProperty('--sa-' + side);
            visualViewport.dispatchEvent(new Event('resize'));
          });
        }
        if (width === 568) {
          await page.evaluate(async () => { const { store } = await import('/js/store.js'); store.set({ spectator: { code: 'MOCK', matchId: 'emi27' } }); });
          await page.waitForSelector('.spectator-bar');
          row.spectatorHits = [await hit(page, '.spectator-bar select', { scroll: true }), await hit(page, '.spectator-bar button', { scroll: true })];
          row.screenshots.push(await screenshot(page, 'emi27-spectator-568x320'));
        }
        row.fixture = '仓库 game-mock；聊天消息和观战状态为确定性 fixture；商店按钮由 mock 处理';
      } finally { await context.close(); }
    });
    await run(`result-${width}x${height}`, async (row) => {
      const { page, context } = await newPage(width, height);
      try {
        await page.goto(`${srv.url}/dev/game-mock.html?shot=1&render=engine&phase=RESULT&variant=ranked`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.rsettle');
        await page.evaluate(() => { document.getElementById('mockbar').style.display = 'none'; });
        row.disabledDuringAnimation = await page.$eval('.rsettle__confirm', (b) => b.disabled);
        await page.waitForFunction(() => !document.querySelector('.rsettle__confirm')?.disabled);
        await page.waitForFunction(() => !document.querySelector('.rsettle__delta')?.getAnimations().some((a) => a.playState === 'running'));
        row.dialog = await checkBox(page, '.rsettle__card'); assert.equal(row.dialog.horizontalOverflow, false);
        row.hits.push(await hit(page, '.rsettle__confirm'));
        row.screenshots.push(await screenshot(page, `emi27-result-${width}x${height}`));
        await page.keyboard.press('Escape'); assert.ok(await page.$('.rsettle'));
        row.hits.push(await tap(page, '.rsettle__confirm'));
        await page.waitForSelector('.rsettle', { hidden: true });
        row.confirmDismissed = true;
        row.hits.push(await hit(page, '.result__foot button', { scroll: true }));
      } finally { await context.close(); }
    });
  }
} finally {
  await Promise.all(clients.map((c) => c.terminate()));
  await browser.close(); await srv.close();
  const report = { build: 27, browser: version, engine: '真实已安装 Chromium/Chrome', emulation: '手机使用 Chrome touch/mobile viewport 仿真，未冒用 Safari UA',
    viewports: ['844x390', '667x375', '568x320', '1440x900'], port: srv.port, localOnly: true, memoryOnly: true, existing3100Untouched: true,
    filter: filter || null, results, errors,
    limitations: ['未实测 Safari、Firefox、Edge、真实 iOS/Android 手机或 WebKit', '键盘与安全区只模拟 visualViewport 属性和 CSS 变量，不是实机',
      '聊天、商店、详情等浮层仍可能覆盖局部棋盘；可收起或滚动，不承诺棋盘始终无遮挡', '不承诺任意手机浏览器绝对兼容；无 VisualViewport 的浏览器使用 vh/svh/dvh 回退', '观战为真实组件的 mock 状态，不是线上观战连接'] };
  fs.writeFileSync(path.join(out, filter ? `emi27-browser-${filter}.json` : 'emi27-browser.json'), JSON.stringify(report, null, 2));
}
if (errors.length || results.some((r) => !r.passed)) process.exitCode = 1;
