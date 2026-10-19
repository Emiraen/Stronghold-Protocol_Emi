// 仅使用隔离 Chrome、随机本地端口及内存数据；非实体手机验收。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startServer } from '../../server/index.js';
import { RankedStore } from '../../server/rankedStore.js';
import { HistoryStore } from '../../server/historyStore.js';
import { PlayerStore } from '../../server/playerStore.js';

const out = process.env.CHAT_LANDSCAPE_SHOTS || path.resolve(import.meta.dirname, '../e2e/out/chat-landscape');
// 与修改#25的tools/shot-match-confirm.mjs使用同一手机UA。
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const sizes = [[844, 390], [667, 375], [1440, 900]];
const request = (page, type, fields = {}) => page.evaluate(async (type, fields) =>
  (await import('/js/net.js')).net.request(type, fields), type, fields);
const state = (page) => page.evaluate(async () => (await import('/js/store.js')).store.get());
const settle = async (page) => {
  await page.waitForFunction(() => !document.querySelector('.pbanner'), { timeout: 15000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
};

async function measure(page) {
  return page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const panel = document.querySelector('.sp-chat__panel');
    const log = panel.querySelector('.sp-chat__list');
    return {
      panel: box(panel), chat: box(document.querySelector('.sp-chat')),
      corner: document.querySelector('.gm__corner') ? box(document.querySelector('.gm__corner')) : null,
      roomFooter: document.querySelector('.room-fill, .room-bar') ? box(document.querySelector('.room-fill, .room-bar')) : null,
      cornerControlsReachable: [...document.querySelectorAll('.gm__corner button, .room-fill button, .room-bar button')].every((el) => {
        const r = box(el);
        if (!r.width || !r.height) return true;
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === el || el.contains(hit);
      }),
      log: { ...box(log), scrollHeight: log.scrollHeight, clientHeight: log.clientHeight, scrollWidth: log.scrollWidth, clientWidth: log.clientWidth },
      controls: [...panel.querySelectorAll('button, input')].map((el) => {
        const r = box(el);
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { ...r, name: el.getAttribute('aria-label') || el.textContent, hit: hit === el || el.contains(hit), overflow: el.scrollWidth > el.clientWidth + 1 };
      }),
      viewport: { width: innerWidth, height: innerHeight, visibleHeight: visualViewport.height, top: visualViewport.offsetTop },
      headingOverflow: panel.querySelector('.sp-chat__heading').scrollWidth > panel.clientWidth,
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
}

function check(m, mobile, route, keyboard = false) {
  const b = m.panel;
  const v = m.viewport;
  assert.ok(b.x >= 0 && b.y >= v.top && b.right <= v.width + 1 && b.bottom <= v.top + v.visibleHeight + 1, `面板越界：${JSON.stringify(m)}`);
  if (mobile) {
    assert.ok(b.width >= 280 && b.width <= 320, `手机聊天宽度：${b.width}`);
    assert.ok(b.height <= 170 && (keyboard || b.height >= 140), `手机聊天高度：${b.height}`);
  } else {
    assert.equal(b.width, 380, '桌面聊天宽度保持不变');
    assert.equal(b.height, route === 'match' ? 240 : 360, '桌面聊天高度保持不变');
  }
  assert.equal(m.pageOverflow, false, '无横向页面溢出');
  assert.equal(m.headingOverflow, false, '头部不溢出');
  assert.ok(m.log.clientHeight > 12, '消息区保留可滚动高度');
  assert.ok(m.log.scrollWidth <= m.log.clientWidth + 1, '长消息正确折行');
  for (const c of m.controls) {
    assert.ok(c.hit && !c.overflow, `控件可点击且文字不溢出：${JSON.stringify(c)}`);
    assert.ok(c.height >= 32 && c.x >= b.x && c.right <= b.right + 1 && c.y >= b.y && c.bottom <= b.bottom + 1, `控件在面板内：${JSON.stringify(c)}`);
  }
  if (mobile && m.roomFooter && !keyboard) {
    assert.ok(m.chat.bottom + 9.5 <= m.roomFooter.y, '手机房间聊天避让底栏至少10px');
    assert.equal(m.cornerControlsReachable, true, '手机房间底部按钮保持可触控');
  }
  if (m.corner && !keyboard) {
    assert.ok(m.chat.bottom + 9.5 <= m.corner.y, `局内工具栏避让至少10px：${JSON.stringify(m)}`);
    assert.equal(m.cornerControlsReachable, true, '聊天打开时原底部工具栏仍可触控');
  }
}

async function portraitBlocked(page, width, height, route, shots) {
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, isLandscape: false });
  await page.waitForFunction(() => document.documentElement.classList.contains('sp-landscape-blocked'));
  assert.equal(await page.evaluate(() => {
    const hint = document.querySelector('.rotate-hint');
    return hint.open && [...document.body.children].filter((el) => el !== hint && el.tagName !== 'SCRIPT').every((el) => el.inert);
  }), true, '竖屏仍被全局模态及inert阻断');
  await page.evaluate(() => {
    document.querySelector('.sp-chat__toggle').click();
    Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 260 });
    visualViewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(await page.$('.sp-chat__panel'), null, '竖屏不能打开聊天');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('sp-landscape-blocked')), true, '竖屏键盘缩小可视区不能解锁');
  const shot = path.join(out, `${route}-portrait-blocked-${width}.png`);
  await page.screenshot({ path: shot }); shots.push(shot);
  await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
  await page.setViewport({ width, height, isMobile: true, hasTouch: true, isLandscape: true });
  await page.waitForFunction(() => !document.documentElement.classList.contains('sp-landscape-blocked'));
}

test('手机横屏聊天紧凑布局、真实发送、滚动、键盘可视区及桌面回归', { timeout: 240000 }, async () => {
  mkdirSync(out, { recursive: true });
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, seedFn: () => 726,
    ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }), players: new PlayerStore({ file: null }) });
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  const base = `http://127.0.0.1:${srv.port}/`;
  const report = { status: '进行中', sizes, measurements: [], screenshots: [], errors: [], blockedRemoteRequests: [],
    localOnly: true, port: srv.port, memoryStores: true, keyboard: 'visualViewport属性模拟，非实机原生软键盘', mobileUA: MOBILE_UA };
  try {
    for (const [width, height] of sizes) {
      const mobile = width < 1000;
      const context = await browser.createBrowserContext();
      try {
        const page = await context.newPage();
        page.on('pageerror', (e) => report.errors.push(e.message));
        await page.setRequestInterception(true);
        page.on('request', (r) => {
          if (r.url().startsWith(base) || /^(data:|blob:)/.test(r.url())) r.continue();
          else { report.blockedRemoteRequests.push(r.url()); r.abort(); }
        });
        if (mobile) await page.setUserAgent(MOBILE_UA);
        await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, isLandscape: true, deviceScaleFactor: 1 });
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.title-screen');
        await page.type('input[placeholder*="代号"]', `聊天${width}`);
        await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '开始').click());
        await page.waitForSelector('.lobby-screen .sp-chat__toggle');
        const sentAt = [];
        const send = async (text, channel) => {
          const delay = Math.max(0, (sentAt.at(-1) || 0) + 2100 - Date.now(), (sentAt.at(-3) || 0) + 10100 - Date.now());
          if (delay) await new Promise((r) => setTimeout(r, delay));
          await page.type('.sp-chat__compose input', text);
          if (mobile) await page.tap('.sp-chat__compose button'); else await page.click('.sp-chat__compose button');
          await page.waitForFunction(async (text, channel) => {
            const s = (await import('/js/store.js')).store.get();
            return (channel === 'match' ? s.matchChat : s.chat).items.some((item) => item.text === text) && document.querySelector('.sp-chat__compose input').value === '';
          }, {}, text, channel);
          sentAt.push(Date.now());
          assert.equal((await state(page)).connection.status, 'online', '真实WebSocket保持连接');
        };
        const longText = (route) => `${route}-${width}：` + '长消息换行与滚动验收'.repeat(18);
        const inspectRoute = async (route, channel) => {
          await settle(page);
          const closed = path.join(out, `${route}-closed-${width}x${height}.png`);
          await page.screenshot({ path: closed }); report.screenshots.push(closed);
          if (mobile) await page.tap('.sp-chat__toggle'); else await page.click('.sp-chat__toggle');
          await page.waitForSelector('.sp-chat__panel');
          await send(longText(route), channel);
          await settle(page);
          const m = await measure(page); check(m, mobile, route);
          report.measurements.push({ width, height, route, ...m });
          assert.ok(m.log.scrollHeight > m.log.clientHeight, '长消息形成滚动区域');
          const scrollBefore = await page.$eval('.sp-chat__list', (el) => { el.scrollTop = 0; return el.scrollTop; });
          if (mobile) {
            const cdp = await page.createCDPSession();
            const x = m.log.x + m.log.width / 2;
            const startY = m.log.bottom - 8;
            const distance = m.log.height - 16;
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY, id: 1 }] });
            for (let step = 1; step <= 8; step++) {
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY - distance * step / 8, id: 1 }] });
              await settle(page);
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await cdp.detach();
          } else {
            await page.mouse.move(m.log.x + m.log.width / 2, m.log.y + m.log.height / 2);
            await page.mouse.wheel({ deltaY: 100 });
          }
          await page.waitForFunction((before) => document.querySelector('.sp-chat__list').scrollTop > before, { timeout: 3000 }, scrollBefore);
          const opened = path.join(out, `${route}-open-${width}x${height}.png`);
          await page.screenshot({ path: opened }); report.screenshots.push(opened);
          if (route === 'match' && mobile) {
            await page.focus('.sp-chat__compose input');
            await page.evaluate(() => {
              Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 190 });
              Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, get: () => 12 });
              visualViewport.dispatchEvent(new Event('resize'));
              visualViewport.dispatchEvent(new Event('scroll'));
            });
            await page.waitForSelector('.sp-chat.has-keyboard');
            await settle(page);
            const k = await measure(page); check(k, mobile, route, true);
            report.measurements.push({ width, height, route, keyboard: true, ...k });
            await send(`键盘模拟真实发送${width}`, channel);
            const keyboardShot = path.join(out, `match-keyboard-emulated-${width}x${height}.png`);
            await page.screenshot({ path: keyboardShot }); report.screenshots.push(keyboardShot);
            await page.evaluate(() => {
              delete visualViewport.height; delete visualViewport.offsetTop;
              visualViewport.dispatchEvent(new Event('resize'));
            });
            await page.waitForFunction(() => !document.querySelector('.sp-chat.has-keyboard'));
          }
          if (mobile) await page.tap('.sp-chat__close'); else await page.click('.sp-chat__close');
          assert.equal(await page.$('.sp-chat__panel'), null, '收起按钮确实关闭聊天');
          if (mobile) await portraitBlocked(page, width, height, route, report.screenshots);
        };
        await inspectRoute('lobby', 'lobby');
        await request(page, 'room.create', { mode: 'coop', difficulty: 'FUNNY', ranked: false });
        await page.waitForSelector('.room-screen');
        await inspectRoute('room', 'lobby');
        if (mobile) await page.tap('button[aria-label="离开同盟"]');
        else await page.click('button[aria-label="离开同盟"]');
        await page.waitForSelector('.lobby-screen');
        await request(page, 'room.create', { mode: 'solo', difficulty: 'FUNNY', ranked: false });
        await page.waitForSelector('.room-screen');
        const code = (await state(page)).room.code;
        await request(page, 'room.start');
        await page.waitForSelector('.sp-chat--match');
        await request(page, 'g.infoReady');
        await page.waitForFunction(async () => (await import('/js/store.js')).store.get().match.public?.phase === 'BAND_DRAFT');
        const room = srv.lobby.getRoom(code);
        const me = (await state(page)).me.playerId;
        await request(page, 'g.band', { bandId: room.match.defaultBand(me) });
        await page.waitForSelector('.gm--prep', { timeout: 25000 });
        await page.waitForSelector('.gm__corner');
        await inspectRoute('match', 'match');
        // 局内关闭后仍保留原工具栏10px避让，按钮中心不被聊天遮挡。
        assert.equal(await page.evaluate(() => {
          const chat = document.querySelector('.sp-chat').getBoundingClientRect();
          const corner = document.querySelector('.gm__corner').getBoundingClientRect();
          return chat.bottom + 9.5 <= corner.top && [...document.querySelectorAll('.gm__corner button')].every((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return true;
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return hit === el || el.contains(hit);
          });
        }), true, '底部原按钮无碰撞且触控中心可用');
        console.log(`${width}x${height}：大厅/房间/局内尺寸、发送、滚动、收起${mobile ? '、键盘模拟和竖屏阻断' : '、桌面尺寸保持'}通过`);
      } finally { await context.close(); }
    }
    assert.deepEqual(report.errors, [], '无页面脚本异常');
    report.status = '通过';
  } catch (e) {
    report.status = '失败'; report.failure = e.stack; throw e;
  } finally {
    writeFileSync(path.join(out, 'browser-verification.json'), JSON.stringify(report, null, 2));
    await browser.close(); await srv.close();
  }
});
