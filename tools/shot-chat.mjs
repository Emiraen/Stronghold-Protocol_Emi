// Local-only visual smoke test of the real lobby/room chat across two browser clients.
// node tools/shot-chat.mjs [output-directory]
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { startServer } from '../server/index.js';
import { RankedStore } from '../server/rankedStore.js';
import { HistoryStore } from '../server/historyStore.js';
import { PlayerStore } from '../server/playerStore.js';
import puppeteer from 'puppeteer-core';

const out = path.resolve(process.argv[2] || 'test/e2e/out');
mkdirSync(out, { recursive: true });
const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true,
  ranked: new RankedStore({ file: null }), history: new HistoryStore({ file: null }), players: new PlayerStore({ file: null }) });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
try {
  for (const [width, height] of [[844, 390], [1440, 900]]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.setViewport({ width, height });
    await page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.title-screen', { timeout: 25000 });
    const nameInput = await page.$('input[placeholder*="代号"]');
    if (!nameInput) throw new Error(`nickname input missing at ${width}`);
    await nameInput.type(`验收${width}`);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '开始')?.click());
    await page.waitForSelector('.lobby-screen .sp-chat__toggle', { timeout: 25000 });
    await page.click('.sp-chat__toggle');
    await page.waitForSelector('.sp-chat__panel');
    await page.screenshot({ path: path.join(out, `emi-chat-lobby-${width}.png`) });
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    if (size.scroll > size.viewport + 2) throw new Error(`lobby overflow ${width}: ${JSON.stringify(size)}`);
    await page.evaluate(() => [...document.querySelectorAll('.lobby-screen button')].find((b) => b.textContent.includes('创建同盟'))?.click());
    await page.waitForSelector('.room-screen', { timeout: 15000 });
    await page.click('.room-screen .sp-chat__toggle');
    await page.screenshot({ path: path.join(out, `emi-chat-room-${width}.png`) });
    const share = await page.$('.room-screen .sp-chat__share');
    if (!share) throw new Error('share room code button missing');
    await share.click();
    await page.waitForSelector('.sp-chat__invite');
    const code = await page.$eval('.sp-chat__invite b', (node) => node.textContent.trim());
    if (!/^[A-HJ-NP-Z]{4}$/.test(code)) throw new Error(`bad share code: ${code}`);
    await page.screenshot({ path: path.join(out, `emi-chat-invite-${width}.png`) });
    const guestContext = await browser.createBrowserContext();
    try {
      const guest = await guestContext.newPage();
      guest.on('pageerror', (err) => errors.push(err.message));
      await guest.setViewport({ width, height });
      await guest.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'domcontentloaded' });
      await guest.waitForSelector('.title-screen', { timeout: 25000 });
      await guest.type('input[placeholder*="代号"]', `队友${width}`);
      await guest.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '开始')?.click());
      await guest.waitForSelector('.lobby-screen .sp-chat__toggle', { timeout: 25000 });
      await guest.click('.lobby-screen .sp-chat__toggle');
      await guest.waitForSelector('.sp-chat__invite', { timeout: 15000 });
      await guest.click('.sp-chat__invite button');
      await guest.waitForSelector('.room-screen', { timeout: 15000 });
      if (!await guest.evaluate((wanted) => document.querySelector('.room-screen')?.textContent.includes(wanted), code)) {
        throw new Error(`guest did not enter invitation room ${code}`);
      }
      await guest.screenshot({ path: path.join(out, `emi-chat-joined-${width}.png`) });
    } finally { await guestContext.close(); }
    if (errors.length) throw new Error(`browser errors: ${errors.join('; ')}`);
    console.log(`${width}x${height}: lobby/room/share/join OK`);
    await context.close();
  }
} finally { await browser.close(); await srv.close(); }
console.log('screenshots:', out);
