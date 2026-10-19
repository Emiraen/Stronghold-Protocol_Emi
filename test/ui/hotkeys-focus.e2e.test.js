import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('game shortcuts survive shop detail and focused HUD controls', {
  skip: process.env.SP_E2E !== '1' || !existsSync(chrome), timeout: 45_000,
}, async () => {
  const { startServer } = await import('../../server/index.js');
  const puppeteer = (await import('puppeteer-core')).default;
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(`${server.url}/dev/game-mock.html?shot=1&phase=PREP&render=fallback`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.scard', { timeout: 15000 });
    await page.addStyleTag({ url: `${server.url}/css/east-ui-polish.css` });
    await page.addStyleTag({ url: `${server.url}/css/east-floating-panels.css` });
    const state = () => page.evaluate(() => JSON.parse(JSON.stringify(__MOCK__.S().priv)));
    const position = await page.evaluate(() => {
      const e = document.querySelector('.ewheel').getBoundingClientRect();
      const peers = [...document.querySelector('.gm__corner').children].map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
      return { left: e.left, bottom: e.bottom, minLeft: Math.min(...peers.map(r => r.left)), maxBottom: Math.max(...peers.map(r => r.bottom)) };
    });
    assert.equal(position.left, position.minLeft, 'desktop communication is the leftmost corner control');
    assert.equal(position.bottom, position.maxBottom, 'desktop communication sits on the bottom edge');
    await page.click('[data-testid=check-player]');
    await page.waitForSelector('.edrawer');
    await page.evaluate(() => __MOCK__.mutate(S => { S.priv.funds = 80; }));
    const drawerBefore = await state();
    await page.keyboard.press('KeyF');
    await page.waitForFunction(f => __MOCK__.S().priv.shop.frozen !== f, {}, drawerBefore.shop.frozen);
    await page.keyboard.press('KeyR');
    await page.waitForFunction(f => __MOCK__.S().priv.funds < f, {}, drawerBefore.funds);
    await page.keyboard.press('KeyD');
    await page.waitForFunction(l => __MOCK__.S().priv.shop.level > l, {}, drawerBefore.shop.level);
    await page.keyboard.press('Space');
    await page.waitForSelector('.modal');
    const modalBefore = await state();
    await page.keyboard.press('KeyF');
    assert.equal((await state()).shop.frozen, modalBefore.shop.frozen, 'modal confirmation still owns the keyboard');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.modal'));
    // Escape closes the non-modal panel itself, rather than running a game action.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.edrawer'));
    await page.click('[data-testid=check-player]');
    await page.waitForSelector('.edrawer');
    await page.evaluate(async () => (await import('/js/ui/guide.js')).openGuide(0));
    await page.waitForSelector('.guide');
    assert.equal(await page.evaluate(async () => (await import('/js/ui/components.js')).isTopOverlay(document.querySelector('.guide'))), true, 'guide owns keyboard above the info panel');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.guide'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.edrawer'));
    await page.click('.scard:not(.scard--sold)');
    await page.waitForSelector('.dpanel');
    const before = await state();
    await page.keyboard.press('KeyF');
    await page.waitForFunction(frozen => __MOCK__.S().priv.shop.frozen !== frozen, {}, before.shop.frozen);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.dpanel'));
    await page.focus('.toolbtn');
    const funds = (await state()).funds;
    await page.keyboard.press('KeyR');
    await page.waitForFunction(f => __MOCK__.S().priv.funds < f, {}, funds);
    await page.evaluate(() => { const input = document.createElement('input'); input.id = 'chat-focus-probe'; document.body.append(input); input.focus(); });
    const chatBefore = await state();
    await page.keyboard.press('KeyF');
    assert.equal((await state()).shop.frozen, chatBefore.shop.frozen, 'typing in chat must not freeze the shop');
    await page.evaluate(() => document.querySelector('#chat-focus-probe').remove());
    await page.keyboard.press('KeyF');
    await page.waitForFunction(f => __MOCK__.S().priv.shop.frozen !== f, {}, chatBefore.shop.frozen);
  } finally { await browser.close(); await server.close(); }
});
