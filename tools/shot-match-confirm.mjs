// 仅本地验收：真实Chrome + 真实WebSocket + 随机端口内存服务。
// 用法：托管node tools/shot-match-confirm.mjs <截图输出目录>
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer } from '../server/index.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { PlayerStore } from '../server/playerStore.js';
import { TestClient } from '../test/helpers/wsClient.js';
import { rankBoundaries } from '../shared/ranks.js';

const out = path.resolve(process.argv[2] || 'test/e2e/out');
fs.mkdirSync(out, { recursive: true });
const errors = [], results = [], clients = [];
const srv = await startServer({ port: 0, host: '127.0.0.1', admin: false,
  ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }), players: new PlayerStore({ file: null }),
  rateBurst: 1000, heavyBurst: 1000,
  log: { info() {}, warn() {}, debug() {}, error: (...args) => errors.push(args.join(' ')) } });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
async function request(page, type, data = {}) {
  return page.evaluate(async (t, fields) => (await import('/js/net.js')).net.request(t, fields), type, data);
}
async function clickText(page, selector, text) {
  const buttons = await page.$$(selector);
  for (const button of buttons) if ((await button.evaluate((e) => e.textContent.trim())).includes(text)) {
    await button.click(); return;
  }
  throw new Error(`找不到按钮 ${text}`);
}
async function checkDialog(page, selector) {
  return page.evaluate((sel) => {
    const box = document.querySelector(sel);
    const body = box.querySelector('.modal__body');
    const rect = box.getBoundingClientRect();
    const overflow = [];
    for (const el of box.querySelectorAll('button, td, th, .match-confirm__humans > div')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < rect.left - 2 || r.right > rect.right + 2)) overflow.push(el.textContent);
    }
    const footer = box.querySelector('.modal__actions').getBoundingClientRect();
    const buttons = [...box.querySelectorAll('.modal__actions button')].map((b) => {
      const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { text: b.textContent.trim(), reachable: !!top && (top === b || b.contains(top)) };
    });
    const votes = [...box.querySelectorAll('.match-confirm__votes button')].map((b) => {
      const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { text: b.textContent.trim(), visible: r.top >= 0 && r.bottom <= innerHeight, reachable: !!top && (top === b || b.contains(top)) };
    });
    const timer = box.querySelector('[role="timer"]')?.getBoundingClientRect();
    const timerVisible = !timer || (timer.top >= 0 && timer.bottom <= innerHeight && box.querySelector('.modal__head').contains(box.querySelector('[role="timer"]')));
    return { timerVisible, box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth, bodyScrollable: body.scrollHeight > body.clientHeight,
      footerVisible: footer.top >= 0 && footer.bottom <= innerHeight + 2, buttons, votes, overflow };
  }, selector);
}
function assertLayout(layout) {
  assert.ok(layout.box.x >= -1 && layout.box.y >= -1);
  assert.ok(layout.box.x + layout.box.width <= layout.viewport.width + 2);
  assert.ok(layout.box.y + layout.box.height <= layout.viewport.height + 2);
  assert.ok(layout.scrollWidth <= layout.viewport.width + 2);
  assert.equal(layout.footerVisible, true);
  assert.equal(layout.timerVisible, true);
  assert.ok(layout.buttons.every((b) => b.reachable));
  assert.ok(layout.votes.every((b) => b.visible && b.reachable), '每个投票按钮首屏可见且无遮挡');
  assert.deepEqual(layout.overflow, []);
}
async function botPlayer(name) {
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  clients.push(client); const welcome = await client.hello(name); client.id = welcome.playerId;
  return client;
}
async function ok(c, message) { const r = await c.request(message); assert.equal(r.t, 'ok', JSON.stringify(r)); }
try {
  for (const [width, height] of [[1440, 900], [844, 390], [667, 375]]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage(); page.on('pageerror', (err) => errors.push(err.message));
    const mobile = width < 1000;
    const viewport = (w, h) => ({ width: w, height: h, isMobile: mobile, hasTouch: mobile, isLandscape: w > h });
    if (mobile) await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1');
    await page.setViewport(viewport(width, height));
    // 旧缓存false必须首次迁移；普通房重连不能被偏好迁移覆盖。
    await page.evaluateOnNewDocument(() => {
      if (!localStorage.getItem('emi25.test.seeded')) {
        localStorage.setItem('sp.pref.lobby.ranked', 'false');
        localStorage.setItem('emi25.test.seeded', 'true');
      }
    });
    // 拦截外站请求确保整段验收不联网，也不接触用户已有服务。
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const url = r.url();
      if (url.startsWith(srv.url + '/') || url.startsWith('data:') || url.startsWith('blob:')) r.continue(); else r.abort();
    });
    await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.title-screen', { timeout: 30_000 });
    if (mobile) {
      await page.setViewport(viewport(390, 844));
      await page.waitForFunction(() => document.documentElement.classList.contains('sp-landscape-blocked'));
      await page.screenshot({ path: path.join(out, `emi25-title-blocked-${width}.png`) });
      await page.setViewport(viewport(width, height));
      await page.waitForFunction(() => !document.documentElement.classList.contains('sp-landscape-blocked'));
    }
    await page.type('input[placeholder*="代号"]', `确认验收${width}`);
    await clickText(page, '.title-screen button', '开始');
    await page.waitForSelector('.rank-help-toggle', { timeout: 30_000 });
    assert.equal(await page.$eval('.ranked-toggle input', (el) => el.checked), true);
    if (mobile) {
      await page.setViewport(viewport(390, 844));
      await page.waitForFunction(() => document.documentElement.classList.contains('sp-landscape-blocked'));
      await page.screenshot({ path: path.join(out, `emi25-lobby-blocked-${width}.png`) });
      await page.keyboard.press('Tab');
      assert.equal(await page.$eval('#app', (el) => el.inert), true);
      await page.setViewport(viewport(width, height));
      await page.waitForFunction(() => !document.documentElement.classList.contains('sp-landscape-blocked'));
    } else {
      await page.setViewport(viewport(390, 844));
      console.log('桌面窄窗设备参数', await page.evaluate(async () => ({ ...(await import('/js/ui/device.js')).detectFeatures(), touchPoints: navigator.maxTouchPoints, width: innerWidth, height: innerHeight })));
      await page.waitForFunction(() => !document.documentElement.classList.contains('sp-landscape-blocked'));
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('sp-landscape-blocked')), false);
      await page.setViewport(viewport(width, height));
    }
    await page.click('.sp-chat__toggle');
    await page.waitForSelector('.sp-chat__compose');
    const chat = await page.$eval('.sp-chat__compose', (el) => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { visible: r.top >= 0 && r.bottom <= innerHeight + 2, reachable: !!t && el.contains(t) }; });
    assert.deepEqual(chat, { visible: true, reachable: true });
    const createVisible = await page.$eval('.create-box button', (el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.top >= 0 && r.bottom <= innerHeight + 1 && (top === el || el.contains(top)); });
    assert.equal(createVisible, true, '最小横屏创建按钮完整可见且无遮挡');
    await page.screenshot({ path: path.join(out, `emi25-chat-${width}x${height}.png`) });
    await page.click('.sp-chat__close');
    await page.click('.rank-help-toggle');
    await page.waitForSelector('.rank-help');
    const rows = await page.$$eval('.rank-help tbody tr', (elements) => elements.map((r) => [...r.cells].map((c) => c.textContent.trim())));
    assert.deepEqual(rows, rankBoundaries().map((r) => [r.label, r.to == null ? `≥ ${r.from}` : `${r.from}–${r.to}`]));
    await page.waitForFunction(() => !document.querySelector('.rank-help')?.getAnimations().some((a) => a.playState === 'running'));
    const rankLayout = await checkDialog(page, '.rank-help');
    await page.screenshot({ path: path.join(out, `emi25-rank-help-${width}x${height}.png`) });
    console.log('段位弹窗布局', JSON.stringify(rankLayout));
    assertLayout(rankLayout);
    await page.screenshot({ path: path.join(out, `emi25-rank-help-${width}x${height}.png`) });
    await page.$eval('.rank-help .modal__body', (b) => { b.scrollTop = b.scrollHeight; });
    await page.screenshot({ path: path.join(out, `emi25-rank-help-bottom-${width}x${height}.png`) });
    await clickText(page, '.rank-help button', '关闭');
    await page.waitForSelector('.rank-help', { hidden: true });
    const checkedAfterHelp = await page.$eval('.ranked-toggle input', (el) => el.checked);
    assert.equal(checkedAfterHelp, true, '问号和关闭不应改变排位勾选');
    await page.click('.rank-help-toggle');
    await page.waitForSelector('.rank-help');
    await page.waitForFunction(() => !document.querySelector('.rank-help')?.getAnimations().some((a) => a.playState === 'running'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.rank-help', { hidden: true });
    for (const ranked of [true, false]) {
      if (!ranked) await page.click('.ranked-toggle');
      await clickText(page, '.lobby-screen button', '创建同盟');
      await page.waitForSelector('.room-screen');
      if (!ranked) {
        const code = await page.evaluate(async () => (await import('/js/store.js')).store.get().room.code);
        await page.reload({ waitUntil: 'domcontentloaded' });
        // 既有identity.wasEntered会自动恢复房间，不再错误等待标题页。
        await page.waitForSelector('.room-screen', { timeout: 30_000 });
        assert.deepEqual(await page.evaluate(async () => { const r = (await import('/js/store.js')).store.get().room; return { code: r.code, ranked: r.ranked }; }), { code, ranked: false });
        assert.equal(await page.evaluate(() => localStorage.getItem('sp.pref.lobby.ranked')), 'false');
        // 模拟尚未迁移的老用户重连已有普通房：偏好变true，房间仍false。
        await page.evaluate(() => localStorage.removeItem('sp.pref.lobby.rankedDefaultVersion'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.room-screen', { timeout: 30_000 });
        assert.deepEqual(await page.evaluate(async () => { const r = (await import('/js/store.js')).store.get().room; return { code: r.code, ranked: r.ranked }; }), { code, ranked: false });
        assert.equal(await page.evaluate(() => localStorage.getItem('sp.pref.lobby.ranked')), 'true');
      }
      if (mobile && ranked) {
        await page.setViewport(viewport(390, 844));
        await page.waitForFunction(() => document.documentElement.classList.contains('sp-landscape-blocked'));
        await page.screenshot({ path: path.join(out, `emi25-room-blocked-${width}.png`) });
        await page.setViewport(viewport(width, height));
        await page.waitForFunction(() => !document.documentElement.classList.contains('sp-landscape-blocked'));
      }
      const own = await page.evaluate(async () => {
        const { store } = await import('/js/store.js'); return { me: store.get().me.playerId, code: store.get().room.code };
      });
      const partner = await botPlayer(`原队友${width}${ranked ? '排位' : '普通'}`);
      await ok(partner, { t: 'room.join', code: own.code });
      const other = await botPlayer(`另一队房主${width}`);
      const otherGuest = await botPlayer(`另一队友${width}`);
      await ok(other, { t: 'room.create', mode: 'coop', difficulty: ranked ? 'ABYSS' : 'FUNNY', ranked });
      const otherState = await other.waitFor('room.state', (s) => s.hostId === other.id);
      await ok(otherGuest, { t: 'room.join', code: otherState.code });
      await request(page, 'room.matchFill', { searching: true });
      await ok(other, { t: 'room.matchFill', searching: true });
      await page.waitForSelector('.match-confirm');
      const candidate = await page.evaluate(async () => (await import('/js/store.js')).store.get().room.matchCandidate);
      assert.equal(candidate.pool, ranked ? 'ranked' : 'normal');
      assert.equal(candidate.allowed.includes('FUNNY'), !ranked);
      assert.equal(candidate.humans.length, 4);
      const visibleText = await page.$eval('.match-confirm', (el) => el.textContent);
      assert.ok(visibleText.includes('平票取最高难度') && visibleText.includes('投票不等于确认'));
      assert.ok(candidate.deadline > Date.now() && candidate.deadline - Date.now() <= 20_000);
      await page.waitForFunction(() => !document.querySelector('.match-confirm')?.getAnimations().some((a) => a.playState === 'running'));
      const layout = await checkDialog(page, '.match-confirm');
      console.log('确认弹窗布局', JSON.stringify(layout));
      await page.screenshot({ path: path.join(out, `emi25-confirm-${ranked ? 'ranked' : 'normal'}-${width}x${height}.png`) });
      assertLayout(layout);
      await page.screenshot({ path: path.join(out, `emi25-confirm-${ranked ? 'ranked' : 'normal'}-${width}x${height}.png`) });
      await page.$eval('.match-confirm .modal__body', (b) => { b.scrollTop = b.scrollHeight; });
      assertLayout(await checkDialog(page, '.match-confirm'));
      if (mobile && ranked) {
        const votes = candidate.humans.map((h) => h.vote);
        await page.setViewport(viewport(390, 844));
        await page.waitForFunction(() => document.documentElement.classList.contains('sp-landscape-blocked'));
        const guard = await page.evaluate(() => {
          const hint = document.querySelector('.rotate-hint');
          const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
          return { open: hint.open, covers: top === hint || hint.contains(top), inert: document.querySelector('#app').inert };
        });
        assert.deepEqual(guard, { open: true, covers: true, inert: true });
        await page.screenshot({ path: path.join(out, `emi25-confirm-portrait-blocked-${width}.png`) });
        await page.evaluate(() => document.querySelector('.match-confirm [data-difficulty="NORMAL"]').click());
        await page.mouse.click(195, 420);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.rotate-hint')), true, 'Tab不可聚焦背景');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        assert.equal(await page.$eval('.rotate-hint', (el) => el.open), true);
        const after = await page.evaluate(async () => (await import('/js/store.js')).store.get().room.matchCandidate);
        assert.deepEqual(after.humans.map((h) => h.vote), votes, '竖屏不能通过点击或键盘投票');
        assert.equal(after.id, candidate.id, '旋转不丢失候选状态');
        await page.setViewport(viewport(width, height));
        await page.waitForFunction(() => !document.documentElement.classList.contains('sp-landscape-blocked'));
        assertLayout(await checkDialog(page, '.match-confirm'));
      }
      await page.click('.match-confirm [data-difficulty="NORMAL"]');
      await page.waitForFunction(() => document.querySelector('.match-confirm [data-difficulty="NORMAL"]')?.textContent.includes('1 票'));
      const voted = await page.evaluate(async () => (await import('/js/store.js')).store.get().room.matchCandidate);
      assert.equal(voted.humans.find((h) => h.playerId === own.me).confirmed, false);
      await clickText(page, '.match-confirm .modal__actions button', '确认参加');
      for (const p of [partner, other, otherGuest]) await ok(p, { t: 'room.matchConfirm', candidateId: candidate.id, accept: true });
      await page.waitForFunction(() => document.querySelector('.match-confirm__wait')?.textContent.includes('全员已确认'));
      assert.equal(srv.lobby.getRoom(own.code).match, null);
      await page.screenshot({ path: path.join(out, `emi25-confirm-wait-${ranked ? 'ranked' : 'normal'}-${width}x${height}.png`) });
      await page.keyboard.press('Escape');
      assert.ok(await page.$('.match-confirm'), '确认不能通过Esc绕过');
      if (ranked) {
        // 拒绝后原队不拆散，已确认的另队收到整队回队列通知。
        await clickText(page, '.match-confirm .modal__actions button', '拒绝本次匹配');
        await page.waitForSelector('.match-confirm', { hidden: true });
        const notice = await other.waitFor('room.matchCancelled', (m) => m.candidateId === candidate.id);
        assert.equal(notice.requeued, true);
        assert.equal(srv.lobby.getRoom(own.code).activeHumans().length, 2);
        await page.screenshot({ path: path.join(out, `emi25-confirm-cancel-${width}x${height}.png`) });
      } else {
        for (const p of [partner, other, otherGuest]) await ok(p, { t: 'room.matchDifficultyVote', candidateId: candidate.id, difficulty: 'NORMAL' });
        await page.waitForSelector('.match-confirm', { hidden: true });
        await page.waitForFunction(async () => (await import('/js/store.js')).store.get().room?.inMatch === true);
        assert.equal(srv.lobby.getRoom(own.code).difficulty, 'NORMAL');
        if (mobile) {
          const viewerContext = await browser.createBrowserContext();
          const viewer = await viewerContext.newPage();
          viewer.on('pageerror', (err) => errors.push(err.message));
          await viewer.setViewport(viewport(width, height));
          await viewer.setRequestInterception(true);
          viewer.on('request', (r) => r.url().startsWith(srv.url + '/') || /^(data|blob):/.test(r.url()) ? r.continue() : r.abort());
          await viewer.goto(srv.url, { waitUntil: 'domcontentloaded' });
          await viewer.waitForSelector('.title-screen');
          await viewer.type('input[placeholder*="代号"]', `观战横屏${width}`);
          await clickText(viewer, '.title-screen button', '开始');
          await viewer.waitForSelector('.lobby-screen');
          await request(viewer, 'spectator.join', { code: own.code, matchId: srv.lobby.getRoom(own.code).matchCtx.matchId });
          await viewer.waitForSelector('.spectator-bar', { timeout: 30_000 });
          await viewer.waitForSelector('.gm__loading', { hidden: true, timeout: 30_000 });
          const state = await viewer.evaluate(async () => (await import('/js/store.js')).store.get().spectator);
          await viewer.screenshot({ path: path.join(out, `emi25-spectator-${width}x${height}.png`) });
          await viewer.setViewport(viewport(390, 844));
          await viewer.waitForFunction(() => document.documentElement.classList.contains('sp-landscape-blocked'));
          assert.equal(await viewer.$eval('#app', (el) => el.inert), true);
          await viewer.screenshot({ path: path.join(out, `emi25-spectator-blocked-${width}.png`) });
          await viewer.keyboard.press('Escape');
          await viewer.setViewport(viewport(width, height));
          await viewer.waitForFunction(() => !document.documentElement.classList.contains('sp-landscape-blocked'));
          assert.deepEqual(await viewer.evaluate(async () => (await import('/js/store.js')).store.get().spectator), state);
          results.push({ viewport: `${width}x${height}`, route: 'spectator', realWebSocket: true, portraitBlocked: true, statePreserved: true });
          await viewerContext.close();
        }
      }
      results.push({ viewport: `${width}x${height}`, pool: ranked ? 'ranked' : 'normal', rankLayout, layout, flows: '真实WS独立确认、投票、等待未投票、拒绝整队恢复/全员投票开局' });
      await request(page, 'room.leave');
      // room.leave是请求回执；与RoomScreen.leave相同，成功后清理本页导航状态。
      await page.evaluate(async () => { const { store, emptyMatch } = await import('/js/store.js'); store.set({ room: null, match: emptyMatch() }); });
      await page.waitForSelector('.lobby-screen');
      for (const p of [partner, other, otherGuest]) await p.terminate();
    }
    await context.close();
    console.log(`${width}x${height} 真实Chrome与WS验收通过`);
  }
  // 全局入口相同；用真实Chrome对战斗、结算等重型路由逐一证明旋转不会销毁状态。
  for (const [width, height] of [[844, 390], [667, 375]]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(err.message));
    const viewport = (w, h) => ({ width: w, height: h, isMobile: true, hasTouch: true, isLandscape: w > h });
    await page.setViewport(viewport(width, height));
    await page.setRequestInterception(true);
    page.on('request', (r) => r.url().startsWith(srv.url + '/') || /^(data|blob):/.test(r.url()) ? r.continue() : r.abort());
    for (const phase of ['INFO_CHECK', 'PREP', 'COMBAT', 'RESULT']) {
      await page.goto(`${srv.url}/dev/game-mock.html?shot=1&render=engine&phase=${phase}${phase === 'RESULT' ? '&variant=ranked' : ''}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.screen:not(.gload)', { timeout: 30_000 });
      if (phase === 'RESULT') await page.waitForSelector('.rsettle');
      else await page.waitForSelector('.gm__loading', { hidden: true, timeout: 30_000 });
      await page.evaluate(() => { document.getElementById('mockbar').style.display = 'none'; });
      await page.screenshot({ path: path.join(out, `emi25-${phase}-${width}x${height}.png`) });
      const before = await page.evaluate(async () => { const s = (await import('/js/store.js')).store.get(); return { phase: s.match.public?.phase, room: s.room?.code, spectator: s.spectator }; });
      await page.setViewport(viewport(390, 844));
      await page.waitForFunction(() => document.documentElement.classList.contains('sp-landscape-blocked'));
      assert.equal(await page.$eval('#app', (el) => el.inert), true);
      assert.equal(await page.$eval('.rotate-hint', (el) => el.open), true);
      await page.screenshot({ path: path.join(out, `emi25-${phase}-blocked-${width}.png`) });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.setViewport(viewport(width, height));
      await page.waitForFunction(() => !document.documentElement.classList.contains('sp-landscape-blocked'));
      assert.deepEqual(await page.evaluate(async () => { const s = (await import('/js/store.js')).store.get(); return { phase: s.match.public?.phase, room: s.room?.code, spectator: s.spectator }; }), before);
      assert.equal(await page.$eval('#app', (el) => el.inert), false);
      results.push({ viewport: `${width}x${height}`, phase, portraitBlocked: true, statePreserved: true });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'emi25-browser-verification.json'), JSON.stringify({ port: srv.port, memoryOnly: true, results, errors }, null, 2));
} finally { await Promise.all(clients.map((c) => c.terminate())); await browser.close(); await srv.close(); }
console.log('验收截图目录', out);
