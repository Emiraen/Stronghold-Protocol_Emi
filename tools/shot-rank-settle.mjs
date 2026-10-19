// Screenshot the RESULT screen rank settlement overlay via the mock harness (headless Chrome).
//   node tools/shot-rank-settle.mjs [variant]
import { startServer } from '../server/index.js';
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const variant = process.argv[2] || 'ranked';
const tag = variant.replace(/[^a-z0-9-]/gi, '_');

const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  for (const [w, h] of [[1440, 900], [900, 640]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${srv.port}/dev/game-mock.html?phase=RESULT&variant=${variant}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.evaluate(() => { const b = document.getElementById('mockbar'); if (b) b.style.display = 'none'; });
    // A late screenshot verifies that the overlay persists after the score animation.
    await page.waitForSelector('.rsettle__confirm', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 900));
    await page.screenshot({ path: path.join(OUT, `rsettle-${tag}-mid-${w}.png`) });
    await new Promise((r) => setTimeout(r, 3600));
    await page.screenshot({ path: path.join(OUT, `rsettle-${tag}-late-${w}.png`) });
    if (await page.$eval('.rsettle__confirm', (b) => b.disabled)) throw new Error('Confirmation stayed disabled');
    const focusState = await page.evaluate(() => {
      const confirm = document.querySelector('.rsettle__confirm');
      const main = document.querySelector('.result__main');
      main.querySelector('button')?.focus();
      return { inert: main.inert, focusInside: document.activeElement === confirm };
    });
    if (!focusState.inert || !focusState.focusInside) throw new Error(`Background remains keyboard-accessible: ${JSON.stringify(focusState)}`);
    await page.keyboard.press('Escape');
    await page.click('.rsettle__backdrop');
    if (!await page.$('.rsettle')) throw new Error('Overlay dismissed without the confirm button');
    await page.click('.rsettle__confirm');
    await page.waitForSelector('.rsettle', { hidden: true, timeout: 5000 });
    await page.screenshot({ path: path.join(OUT, `rsettle-${tag}-cards-${w}.png`) });
    // close-up of the self card's rank row
    const card = await page.$('.rcard.is-self');
    if (card) await card.screenshot({ path: path.join(OUT, `rsettle-${tag}-selfcard-${w}.png`) });
    if (errors.length) console.log(`[${variant} ${w}] console errors:\n` + errors.slice(0, 10).join('\n'));
    else console.log(`[${variant} ${w}] no console errors`);
    await page.close();
  }
} finally {
  await browser.close();
  await srv.close();
}
console.log('shots in', OUT);
