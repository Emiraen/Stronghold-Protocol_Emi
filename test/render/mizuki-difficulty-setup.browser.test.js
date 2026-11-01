import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIZUKI_DIFFICULTIES } from '../../public/js/ui/mizukiDifficultyData.js';
import { mizukiDifficultyOptions } from '../../server/modes/mizuki/Difficulty.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const enabled = process.env.RENDER_E2E === '1' && fs.existsSync(CHROME);

test('all 19 displayed difficulty rules match the original server records', () => {
  assert.equal(MIZUKI_DIFFICULTIES.length, 19);
  assert.deepEqual(MIZUKI_DIFFICULTIES, mizukiDifficultyOptions().map(({ grade, name, ruleDesc, addDesc, color, scoreFactor }) =>
    ({ grade, name, ruleDesc, addDesc, color, scoreFactor })));
});

const sheets = [...fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').matchAll(/<link[^>]*href="([^"]+)"[^>]*>/g)]
  .map(match => match[1]).filter(url => url.startsWith('/') && url.endsWith('.css'));
const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${sheets.map(url => '<link rel="stylesheet" href="' + url + '">').join('')}
</head><body><div id="app"></div><script type="module">
import { h, render } from '/vendor/preact.module.js';
import { useState } from '/vendor/hooks.module.js';
import { html, Icon } from '/js/ui/components.js';
import { MizukiSetup } from '/js/ui/mizukiSetup.js';
function Frame({title,en,modeName,onBack,children}) {return h('div',{class:'proto east-hall',style:'--d-color:#53c9a5'},
  h('div',{class:'proto__bg'}),h('header',{class:'proto-top'},
    h('button',{class:'proto-back',onClick:onBack,'aria-label':'返回大厅'},h(Icon,{name:'chevronLeft'}),h('span',{class:'proto-back__home'},h(Icon,{name:'rook'}))),
    h('div',{class:'proto-title'},h('h2',null,title),h('span',{class:'proto-title__mode'},modeName,h('i',null,en)))),children);}
function App({initial=0,online=true,busy=null}) {
  const [grade,onGrade]=useState(initial);const [capacity,onCapacity]=useState(4);
  return h(MizukiSetup,{Frame,online,busy,grade,onGrade,capacity,onCapacity,onBack:()=>window.calls.push({back:true}),onCreate:()=>window.calls.push({grade,capacity})});
}
window.mount=(options={})=>{render(null,document.getElementById('app'));window.calls=[];render(h(App,options),document.getElementById('app'));};
window.mount();window.ready=true;
</script></body></html>`;

test('difficulty cards retain per-grade rules and the original create button without left-side text', { skip: enabled ? false : 'set RENDER_E2E=1 with Chrome' }, async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname;
    if (url === '/_difficulty_fixture') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fixture); }
    const file = path.resolve(ROOT, (url.startsWith('/shared/') || url.startsWith('/data/') ? '.' : 'public/.') + url);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (error, body) => {
      if (error) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const out = path.join(ROOT, '.cache/mizuki-difficulty-ui-20261031');
  fs.mkdirSync(out, { recursive: true });
  const errors = [], evidence = [];
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto('http://127.0.0.1:' + server.address().port + '/_difficulty_fixture');
    await page.waitForFunction(() => window.ready);
    assert.equal(await page.$$eval('[role=radio]', cards => cards.length), 19);
    assert.equal(await page.$$eval('.pcard__glow', nodes => nodes.length), 19);
    assert.equal(await page.$$eval('.pcard__stamp .pcard__ring', nodes => nodes.length), 19);
    for (const item of MIZUKI_DIFFICULTIES) {
      const selector = '[data-mz-lobby-difficulty="' + item.grade + '"]';
      await page.$eval(selector, card => card.scrollIntoView({ block: 'nearest' }));
      await page.click(selector);
      await page.waitForFunction(grade => document.querySelector('[role=radio][aria-checked=true]')?.dataset.mzLobbyDifficulty === String(grade), {}, item.grade);
      assert.equal(await page.$$eval('[role=radio][aria-checked=true]', cards => cards.length), 1);
      assert.equal(await page.$eval(selector + ' .pcard__name', node => node.textContent), 'N' + item.grade);
      assert.equal(await page.$eval(selector + ' .pcard__desc', node => node.textContent), item.grade ? '本级新增：' + item.ruleDesc : '无额外难度减益');
      if (item.grade) assert.equal(await page.$eval(selector + ' .mizuki-setup__card-growth', node => node.textContent), item.addDesc);
    }
    assert.equal(await page.$$eval('.proto-stage .proto-brief, .mizuki-setup__rules', nodes => nodes.length), 0);
    assert.equal(await page.$eval('.proto-stage', node => node.textContent.includes('波涛迭起')), false);
    assert.equal(await page.$eval('.mizuki-setup', node => node.textContent.includes('波涛迭起')), false);
    assert.equal(await page.$$eval('.proto-foot .proto-start__mark .proto-start__rook .icon', nodes => nodes.length), 1);
    assert.equal(await page.$$eval('.proto-foot .proto-start__deco', nodes => nodes.length), 1);
    assert.deepEqual(await page.$eval('.pcard.is-on', card => ({
      stamp: getComputedStyle(card.querySelector('.pcard__stamp')).animationName,
      ring: getComputedStyle(card.querySelector('.pcard__ring path')).animationName,
      transition: getComputedStyle(card).transitionProperty,
    })), { stamp: 'proto-stamp', ring: 'tr-draw', transition: 'transform, border-color' });
    await page.select('select', '2');
    await page.click('.proto-foot button');
    assert.deepEqual(await page.evaluate(() => window.calls), [{ grade: 18, capacity: 2 }]);
    await page.focus('[role=radio][aria-checked=true]');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.querySelector('[data-mz-lobby-difficulty="0"]').getAttribute('aria-checked') === 'true');
    await page.evaluate(() => { window.previousScene = document.querySelector('.proto-stage .ps'); });
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.$eval('[role=radio][aria-checked=true]', card => card.dataset.mzLobbyDifficulty), '1');
    assert.equal(await page.evaluate(() => window.previousScene !== document.querySelector('.proto-stage .ps')), true, 'difficulty selection restarts the shared scene entrance');
    for (const viewport of [{ width: 1920, height: 1080, name: 'desktop', grade: 7 }, { width: 844, height: 390, name: 'mobile-landscape', grade: 18 }, { width: 375, height: 812, name: 'mobile-portrait', grade: 18 }]) {
      await page.setViewport({ width: viewport.width, height: viewport.height });
      await page.evaluate(initial => window.mount({ initial }), viewport.grade);
      await page.waitForFunction(() => { const list=document.querySelector('.proto-list'),card=list?.querySelector('[aria-checked=true]');if(!card)return false;const r=card.getBoundingClientRect(),l=list.getBoundingClientRect();return r.top>=l.top-1&&r.top<l.bottom; });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => Promise.allSettled(document.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
      const layout = await page.evaluate(() => {
        const rect = selector => {const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
        return { list:rect('.proto-list'), create:rect('.proto-foot button'), stage:rect('.proto-stage'), width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth };
      });
      assert.equal(layout.overflow, false, viewport.name + ' horizontal overflow');
      assert.ok(layout.list.height > 70, viewport.name + ' list can scroll');
      assert.ok(layout.create.bottom <= viewport.height + 1 && layout.create.top >= 0, viewport.name + ' create remains visible');
      assert.ok(layout.create.height >= 44, viewport.name + ' create has a usable touch target');
      await page.screenshot({ path:path.join(out, viewport.name + '.png') });
      evidence.push({ ...viewport, layout });
    }
    for (const options of [{ busy: 'create' }, { online: false }]) {
      await page.evaluate(options => window.mount(options), options);
      assert.equal(await page.$$eval('[role=radio]:disabled', cards => cards.length), 19);
      assert.equal(await page.$eval('.proto-foot button', button => button.disabled), true);
    }
    assert.deepEqual(errors, []);
  } finally {
    fs.writeFileSync(path.join(out,'browser-evidence.json'), JSON.stringify({ allGradesSelected:19,evidence,errors },null,2));
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
