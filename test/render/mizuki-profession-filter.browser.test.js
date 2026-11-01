// RENDER_E2E=1 CHROME_PATH=<Chrome> node --test test/render/mizuki-profession-filter.browser.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const enabled = process.env.RENDER_E2E === '1' && fs.existsSync(CHROME);
const sheets = [...fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').matchAll(/<link[^>]*href="([^"]+)"[^>]*>/g)]
  .map(match => match[1]).filter(url => url.startsWith('/') && url.endsWith('.css'));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${[...sheets, '/css/mizuki-hud.css', '/css/mizuki-recruit.css', '/css/mizuki-route.css'].map(url => '<link rel="stylesheet" href="' + url + '">').join('')}</head><body><div id="app"></div><script type="module">
import {h,render} from '/vendor/preact.module.js';
import {useState} from '/vendor/hooks.module.js';
import {RecruitPage,PROF_NAMES,operatorProfession} from '/js/screens/mizukiRecruit.js';
import {RouteScreen} from '/js/screens/mizukiRoute.js';
import {data} from '/js/data.js';
import {guideStore,closeGuide} from '/js/ui/guide.js';
const professions=Object.keys(PROF_NAMES);
const roster=professions.map((profession,index)=>({uid:index+1,offerId:'offer-'+index,chessId:'filter-unit-'+index,profession,name:PROF_NAMES[profession]+'干员',rarity:4,hopeCost:1,available:index!==3,skills:[]}));
const fallback=roster.map(unit=>unit.uid===8?(({profession,...rest})=>rest)(unit):unit);
data.setContent({id:'profession-filter-fixture',values:{chess:roster,config:{tips:[]}}});
window.calls=[];window.guideStore=guideStore;window.closeGuide=closeGuide;
window.professionFallback=operatorProfession(fallback[7]);
function Recruit({busy=false}){const [selected,setSelected]=useState('offer-1');return h(RecruitPage,{offers:roster,ticket:{id:'advanced',kind:'advanced'},selectedId:selected,portraitFor:()=>null,hope:9,busy,bottom:{dice:5},remaining:1,onSelect:unit=>setSelected(unit.offerId),onConfirm:unit=>window.calls.push({kind:'recruit',id:unit.offerId}),onBack:()=>window.calls.push({kind:'back'}),onExit:()=>{},onGiveUp:()=>window.calls.push({kind:'skip'}),canRefresh:true,refreshLeft:3,onRefresh:()=>window.calls.push({kind:'refresh'})});}
window.mount=(kind,busy=false)=>{render(null,document.getElementById('app'));window.calls=[];closeGuide();render(kind==='recruit'?h(Recruit,{busy}):h(RouteScreen,{model:{hostId:'p0',dice:{count:5},collectibles:[],expedition:{leaderId:'p0',parties:[{id:'party',memberIds:['p0']}],requests:[]},exploration:{nodes:[]}},priv:{roster:fallback,lineup:[2],squadCapacity:2},players:[{playerId:'p0'}],mine:'p0',busy,online:true,act:async(kind,payload)=>{window.calls.push({kind,...payload});return true;},portraitFor:()=>null}),document.getElementById('app'));};
window.ready=true;
</script></body></html>`;

test('Mizuki profession controls filter real recruit and lineup cards and preserve actions', { skip: enabled ? false : 'set RENDER_E2E=1 with Chrome' }, async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname;
    if (url === '/_profession_fixture') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
    const file = path.resolve(ROOT, (url.startsWith('/shared/') || url.startsWith('/data/') ? '.' : 'public/.') + url);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (error, body) => {
      if (error) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream' }); res.end(body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const errors = [], results = [];
  const out = path.join(ROOT, '.cache/mizuki-deploy-preview-hotupdate-20261029');
  fs.mkdirSync(out, { recursive: true });
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
    const page = await browser.newPage(); await page.setViewport({ width: 1920, height: 1080 });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port + '/_profession_fixture');
    await page.waitForFunction(() => window.ready);
    const names = () => page.$$eval('.mzr-grid .mzr-card__name', nodes => nodes.map(node => node.textContent));
    const choose = async profession => { await page.click('.mzr-filter'); await page.waitForSelector('[data-mz-profession-filter="' + profession + '"]'); await page.click('[data-mz-profession-filter="' + profession + '"]'); };
    const close = async () => { await page.click('.modal__actions button'); await page.waitForFunction(() => !document.querySelector('[role=dialog]')); };
    await page.evaluate(() => window.mount('recruit')); await page.waitForSelector('.mzr-card');
    assert.equal((await names()).length, 8);
    await choose('PIONEER'); await close(); assert.deepEqual(await names(), ['先锋干员']);
    assert.equal(await page.$eval('.mzr-confirm', button => button.disabled), false, 'hidden chosen operator remains selected');
    await choose('MEDIC'); await close(); assert.deepEqual(await names(), ['先锋干员', '医疗干员']);
    await choose('PIONEER'); await close(); assert.deepEqual(await names(), ['医疗干员']);
    await page.click('.mzr-card'); await page.click('.mzr-confirm');
    assert.deepEqual(await page.evaluate(() => window.calls), [{ kind: 'recruit', id: 'offer-5' }]);
    await choose('ALL'); await close(); assert.equal((await names()).length, 8);
    await choose('SNIPER'); await close(); assert.equal(await page.$eval('.mzr-card', button => button.disabled), true);
    await page.click('[data-mz-recruit-refresh]'); assert.equal(await page.evaluate(() => window.calls.at(-1).kind), 'refresh');
    await page.click('.mzh-diamond'); assert.equal(await page.evaluate(() => window.guideStore.get().open), true);
    results.push({ screen: 'recruit', single: true, multi: true, toggle: true, reset: true, preservesSelection: true, disabledOffer: true, refresh: true, guide: true });
    await page.evaluate(() => window.mount('route')); await page.waitForSelector('[data-mz-formation]'); await page.click('[data-mz-formation]');
    await page.waitForSelector('[data-mz-quick]'); await page.click('[data-mz-quick]'); await page.waitForSelector('.mzv-select');
    assert.equal((await names()).length, 8); assert.equal(await page.evaluate(() => window.professionFallback), 'SPECIAL');
    await choose('SPECIAL'); await close(); assert.deepEqual(await names(), ['特种干员']);
    await page.click('.mzr-grid .mzr-card');
    await choose('MEDIC'); await close(); assert.deepEqual(await names(), ['医疗干员', '特种干员']);
    await page.click('.mzr-grid .mzr-card');
    assert.equal(await page.$$eval('.mzr-card.is-selected', nodes => nodes.length), 1, 'capacity prevents selecting an extra operator');
    await page.click('[data-mz-confirm=lineup]'); await page.waitForSelector('.mzv-lineup');
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), { kind: 'lineup', uids: [2, 8] });
    results.push({ screen: 'lineup', fallbackProfession: true, filter: true, hiddenSelectionPreserved: true, capacity: true, committedUids: [2, 8] });
    await page.evaluate(() => window.mount('recruit', true)); await page.waitForSelector('.mzr-filter');
    assert.equal(await page.$eval('.mzr-filter', button => button.disabled), true);
    results.push({ screen: 'busy', filterDisabled: true });
    assert.deepEqual(errors, []);
  } finally {
    fs.writeFileSync(path.join(out, 'profession-filter-browser-evidence.json'), JSON.stringify({ results, errors }, null, 2));
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
});
