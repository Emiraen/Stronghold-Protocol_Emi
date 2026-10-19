import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('East mobile battle controls keep labels, bond layers and shop purchase target visible', {
  skip: process.env.SP_E2E !== '1' || !existsSync(CHROME),
  timeout: 60_000,
}, async () => {
  const { startServer } = await import('../../server/index.js');
  const puppeteer = (await import('puppeteer-core')).default;
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const [width, height] of [[568, 320], [756, 366], [844, 390]]) {
      const page = await browser.newPage();
      await page.emulate({ viewport: { width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0.0.0 Mobile Safari/537.36' });
      await page.goto(`${base}/dev/game-mock.html?shot=1&phase=PREP&render=fallback`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.gm__corner .gm__guide, .gm__corner .ewheel__btn', { timeout: 15000 });
      await page.addStyleTag({ url: `${base}/css/east-floating-panels.css` });
      await page.addStyleTag({ url: `${base}/css/east-mobile-game.css` });
      await page.evaluate(() => document.fonts.ready);

      await page.evaluate(async () => {
        const state = globalThis.__MOCK__.S();
        const bondId = state.priv.bonds[0].bondId;
        globalThis.__MOCK__.mutate((S) => { S.layers[bondId] = 237; });
      });
      await page.waitForFunction(() => document.querySelector('.bond__count')?.textContent === '237');

      const geometry = await page.evaluate(() => {
        const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const fits = (content, container) => {
          if (!content || !container) return false;
          const r = rect(container);
          const range = document.createRange(); range.selectNodeContents(content);
          const lines = [...range.getClientRects()];
          return lines.length > 0 && lines.every((line) => line.left >= r.left - 1 && line.right <= r.right + 1 && line.top >= r.top - 1 && line.bottom <= r.bottom + 1);
        };
        const guide = document.querySelector('.gm__guide');
        const emote = document.querySelector('.ewheel__btn');
        const corner = document.querySelector('.gm__corner');
        const count = document.querySelector('.gm__bonds .bond__count');
        const disc = count?.closest('.bond__disc');
        return {
          guide: rect(guide), emote: rect(emote), corner: rect(corner),
          countInsideDisc: fits(count, disc),
          countInsideBondsClip: count.getBoundingClientRect().bottom <= document.querySelector('.gm__bonds').getBoundingClientRect().bottom + 1,
          readyFits: fits(document.querySelector('.readybtn__label'), document.querySelector('.readybtn')),
          readyDebug: { text: document.querySelector('.readybtn__label').textContent, label: rect(document.querySelector('.readybtn__label')), button: rect(document.querySelector('.readybtn')) },
          remainFits: fits(document.querySelector('.shopbar__remain'), document.querySelector('.shopbar__remain')),
          levelFits: fits(document.querySelector('.lvcard__label'), document.querySelector('.lvcard')),
        };
      });
      assert.equal(geometry.guide.left, geometry.emote.left, `${width}x${height}: guide uses the previous emote position`);
      assert.ok(geometry.guide.top < geometry.emote.top, `${width}x${height}: emote uses the previous guide position`);
      assert.equal(geometry.emote.bottom, geometry.corner.bottom, `${width}x${height}: emote stays at the bottom-left of the utility dock`);
      assert.equal(geometry.countInsideDisc, true, `${width}x${height}: layer count stays inside its disc`);
      assert.equal(geometry.countInsideBondsClip, true, `${width}x${height}: layer count clears the strip clip`);
      assert.equal(geometry.readyFits, true, `${width}x${height}: ready label fits`);
      assert.equal(geometry.remainFits, true, `${width}x${height}: remaining placements label fits`);
      assert.equal(geometry.levelFits, true, `${width}x${height}: shop upgrade label fits`);

      const card = await page.$('.shopbar__cards .scard:not(.scard--sold):not(.is-disabled)');
      assert.ok(card, `${width}x${height}: a purchasable operator card exists`);
      const fundsBefore = await page.evaluate(() => globalThis.__MOCK__.S().priv.funds);
      const tapCard = async () => {
        const r = await card.boundingBox();
        await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
        await new Promise((resolve) => setTimeout(resolve, 120));
      };
      await tapCard();
      await page.waitForSelector('.dpanel', { timeout: 5000 });
      const overlaps = await page.evaluate(() => {
        const a = document.querySelector('.dpanel')?.getBoundingClientRect();
        const b = document.querySelector('.scard.is-armed')?.getBoundingClientRect();
        return !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      });
      assert.equal(overlaps, false, `${width}x${height}: detail does not cover the selected shop card`);
      await tapCard();
      const fundsAfter = await page.evaluate(() => globalThis.__MOCK__.S().priv.funds);
      assert.ok(fundsAfter < fundsBefore, `${width}x${height}: the second tap still purchases the operator`);
      for (const expMode of [false, true]) {
        await page.evaluate((expMode) => {
          globalThis.__MOCK__.mutate(S => {
            S.priv.ready = true;
            S.priv.shop.freeRefreshes = 123;
            if (expMode) { S.priv.shopExp = 7; S.priv.expNeeded = 12; S.priv.expPrice = 2; }
            else { delete S.priv.shopExp; delete S.priv.expNeeded; delete S.priv.expPrice; }
          });
        }, expMode);
        await page.waitForFunction(() => document.querySelector('.toolbtn__free')?.textContent.includes('123'));
        const labelsFit = await page.evaluate(() => {
          return ['.readybtn__label', '.lvcard__label', '.toolbtn__free'].every(selector => {
            const el = document.querySelector(selector);
            const box = el.closest('button').getBoundingClientRect();
            const range = document.createRange(); range.selectNodeContents(el);
            return [...range.getClientRects()].every(r => r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom);
          });
        });
        assert.equal(labelsFit, true, `${width}x${height}: ready, free refresh and upgrade labels fit (experience mode ${expMode})`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
