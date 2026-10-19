// Visual and interaction smoke test for the private management site with synthetic in-memory data.
// node tools/shot-admin.mjs [outputDir]
import { startServer } from '../server/index.js';
import { scryptSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const out = path.resolve(process.argv[2] || 'test/e2e/out');
mkdirSync(out, { recursive: true });
const salt = randomBytes(32);
const password = 'visual-test-password-not-for-production';
const passwordHash = `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64, { maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true,
  admin: { host: '127.0.0.1', port: 0, passwordHash, allowInsecureLocal: true },
});
const p = srv.registry.create('星火');
p.aid = 'a'.repeat(32);
p.connected = true;
p.roomCode = 'ABCD';
srv.lobby.players.record(p.aid, p.name);
const q = srv.registry.create('赤霄');
q.aid = 'b'.repeat(32);
q.connected = true;
q.roomCode = 'ABCD';
srv.lobby.players.record(q.aid, q.name);
srv.lobby.ranked.ensure(p.aid, p.name);
Object.assign(srv.lobby.ranked.profile(p.aid), { points: 1650, placementDone: true, wins: 12, losses: 3, lastActive: Date.now() });
srv.lobby.ranked.ensure(q.aid, q.name);
Object.assign(srv.lobby.ranked.profile(q.aid), { points: 1950, placementDone: true, wins: 19, losses: 5, lastActive: Date.now() });
srv.lobby.rooms.set('ABCD', {
  code: 'ABCD', mode: 'coop', difficulty: 'HARD', ranked: true, createdAt: Date.now() - 100000,
  matchCtx: { startedAt: Date.now() - 90000 }, match: { round: 8, phase: 'PREP' },
  seats: [p, q].map((s) => ({ name: s.name, playerId: s.playerId, isBot: false, connected: true })),
});
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--no-sandbox'] });
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: width === 390 ? 844 : 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${srv.admin.port}/`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => !document.querySelector('#loginView').hidden || !document.querySelector('#dashboardView').hidden,
      { timeout: 15000 });
    if (await page.$eval('#loginView', (el) => !el.hidden)) {
      await page.type('#password', password);
      await page.click('#loginButton');
    }
    await page.waitForSelector('#dashboardView:not([hidden])', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('#statMatches')?.textContent === '1');
    const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    if (dimensions.content > dimensions.viewport + 1) throw new Error(`horizontal overflow at ${width}: ${JSON.stringify(dimensions)}`);
    await page.screenshot({ path: path.join(out, `admin-matches-${width}.png`), fullPage: true });
    await page.click('.match-card');
    await page.waitForSelector('#matchDialog[open]');
    const detail = await page.$eval('#matchDialog', (el) => el.textContent);
    if (!detail.includes('星火') || !detail.includes('赤霄') || !detail.includes('8')) throw new Error(`match detail missing names or round: ${detail}`);
    await page.screenshot({ path: path.join(out, `admin-detail-${width}.png`) });
    await page.click('#dialogClose');
    await page.click('[data-tab="ranking"]');
    await page.screenshot({ path: path.join(out, `admin-ranking-${width}.png`), fullPage: true });
    if (errors.length) throw new Error(`browser errors: ${errors.join('; ')}`);
    console.log(`${width}px: login, match detail, ranking and layout OK`);
    await page.close();
  }
} finally {
  await browser.close();
  await srv.close();
}
console.log('screenshots:', out);
