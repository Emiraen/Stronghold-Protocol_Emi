// Isolated Chromium layout/touch regression; physical phone acceptance is separate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const css = read('public/index.html').split('href="').slice(1).map(s => s.split('"')[0])
  .filter(path => path.startsWith('/css/')).map(path => read('public' + path)).join('\n');
const sections = Array.from({ length: 20 }, (_, i) => '<section style="height:70px;overflow:hidden">内容 ' + i + '<p>' + '说明文字'.repeat(35) + '</p></section>').join('');
const modal = (name, cls = '') => '<div class="sp-overlay-layer sp-overlay-layer--modal" data-name="' + name + '"><div class="modal"><div class="modal__box ' + cls
  + '"><div class="modal__stripe"></div><header class="modal__head"><h2>详情</h2></header><div class="modal__body">' + sections
  + '</div><footer class="modal__actions"><button>关闭</button></footer></div></div></div>';

async function swipe(page, selector) {
  const point = await page.$eval(selector, el => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.bottom - Math.min(40, r.height / 4) };
  });
  const session = await page.createCDPSession();
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  for (let step = 1; step <= 8; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - step * 10 }] });
    await new Promise(resolve => setTimeout(resolve, 16));
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(resolve => setTimeout(resolve, 80));
  await session.detach();
}

test('secondary modal touch scroll preserves content and background protection', { skip: !existsSync(chrome), timeout: 45000 }, async () => {
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  const report = { localOnly: true, realPhone: false, measurements: [] };
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => request.abort());
    for (const [width, height] of [[568, 320], [844, 390], [1440, 900]]) {
      await page.setViewport({ width, height, isMobile: width < 1000, hasTouch: true, isLandscape: true });
      for (const cls of ['', 'eqr', 'minfo-dlg', 'utility-modal settings-modal']) {
        await page.setContent('<html class="sp-coarse"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css
          + '</style></head><body><div class="gm__field"><canvas></canvas></div>' + modal('under') + modal('top', cls) + '</body></html>');
        await page.addStyleTag({ content: '*,*::before,*::after { animation:none!important; transition:none!important; }' });
        const selector = '[data-name="top"] .modal__body';
        await swipe(page, selector);
        const m = await page.$eval(selector, el => {
          const footer = el.closest('.modal__box').querySelector('.modal__actions').getBoundingClientRect();
          return { height: el.clientHeight, content: el.scrollHeight, top: el.scrollTop, touch: getComputedStyle(el).touchAction,
            sectionHeight: el.firstElementChild.clientHeight, footerBottom: footer.bottom, viewportHeight: innerHeight,
            underlyingTop: document.querySelector('[data-name="under"] .modal__body').scrollTop, pageTop: document.scrollingElement.scrollTop,
            boardTouch: getComputedStyle(document.querySelector('.gm__field canvas')).touchAction };
        });
        report.measurements.push({ width, height, cls, ...m });
        assert.ok(m.content > m.height + 100, JSON.stringify(m));
        assert.equal(m.sectionHeight, 70, 'sections do not shrink and clip');
        assert.ok(m.top > 20, 'touch gesture scrolls top dialog');
        assert.equal(m.touch, 'pan-y');
        assert.equal(m.underlyingTop, 0, 'parent dialog remains still');
        assert.equal(m.pageTop, 0, 'background remains still');
        assert.equal(m.boardTouch, 'none', 'board drag contract remains unchanged');
        assert.ok(m.footerBottom <= m.viewportHeight + 1, 'footer is reachable');
      }
    }
    await page.setViewport({ width: 667, height: 375, isMobile: true, hasTouch: true, isLandscape: true });
    await page.setContent('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css + '</style></head><body>' + modal('social', 'social-modal') + '</body></html>');
    const social = await page.$eval('.social-modal > .modal__body', el => {
      el.innerHTML = '<div class="screen" style="display:flex;flex-direction:column"><div class="inner-scroll" style="flex:1;min-height:0;overflow:auto;touch-action:pan-y"><div style="height:1200px">社交列表</div></div></div>';
      return { overflow: getComputedStyle(el).overflow, shrink: getComputedStyle(el.firstElementChild).flexShrink };
    });
    assert.equal(social.overflow, 'hidden');
    assert.equal(social.shrink, '1');
    await page.addStyleTag({ content: '*,*::before,*::after { animation:none!important; transition:none!important; }' });
    await swipe(page, '.inner-scroll');
    assert.ok(await page.$eval('.inner-scroll', el => el.scrollTop) > 20);
    if (process.env.MODAL_SCROLL_RECEIPT) writeFileSync(process.env.MODAL_SCROLL_RECEIPT, JSON.stringify(report, null, 2) + '\n');
  } finally { await browser.close(); }
});
