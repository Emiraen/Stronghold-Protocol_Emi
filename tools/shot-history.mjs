// Screenshot the LOBBY match-history screens (list + detail reusing ResultView) via a real server
// and a real browser client. Seeds a HistoryStore with synthetic-but-schema-accurate results,
// then drives the real app: title skip -> lobby -> 对局记录 -> entry click -> settlement view.
//   node tools/shot-history.mjs [width] [height]
import { startServer } from '../server/index.js';
import { HistoryStore } from '../server/historyStore.js';
import { RankedStore } from '../server/rankedStore.js';
import { PlayerStore } from '../server/playerStore.js';
import assert from 'node:assert/strict';
import { loadData } from '../server/data.js';
import puppeteer from 'puppeteer-core';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[4] || path.join(ROOT, 'test/e2e/out'));
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const W = Number(process.argv[2] || 1440);
const H = Number(process.argv[3] || 900);

const NAME = 'root';
const AID = 'a'.repeat(32);            // the browser will be pinned to this aid via localStorage
const AID2 = 'b'.repeat(32);           // a teammate with their own history profile

const gd = loadData(undefined, { log: { warn: () => {}, error: () => {} } });
const chess = Object.values(gd.chess).filter((c) => c.visible !== false && !c.isHidden && !c.isGolden);
const bondIds = Object.keys(gd.bonds);
const titles = (gd.config.titles || []).filter((t) => t && t.id);
const stageId = Object.keys(gd.stages)[0];

/** Same shape as server/match/results.js buildResult (settlement page input). */
function buildResult({ victory, ranked, difficulty, modeId, players }) {
  const title = (i) => titles.length ? { id: titles[i % titles.length].id, name: titles[i % titles.length].name, picId: titles[i % titles.length].picId, text: titles[i % titles.length].text } : null;
  const lineup = (i) => chess.slice((i * 5) % 40, (i * 5) % 40 + 8).map((c, k) => (
    { id: k < 3 ? c.goldenId : c.chessId, golden: k < 3, tier: c.tier, row: 9 + (k % 4), col: 2 + k, items: [] }
  ));
  const bonds = (i) => bondIds.slice((i * 3) % 12, (i * 3) % 12 + 4).map((bondId, k) => (
    { bondId, count: 3 - (k % 3), layers: [359, 136, 34, 12][k], active: k < 3, tier: k < 3 ? 1 : 0 }
  ));
  return {
    victory, roundsPassed: victory ? 14 : 11, hiddenReached: false, hiddenCleared: false,
    reason: victory ? 'victory' : 'defeat', bossId: 'boss_5', hiddenBossId: 'boss_8',
    difficulty, modeId, stageId, durationMs: 52 * 60000,
    players: players.map((p, i) => ({
      playerId: p.playerId, seat: i, name: p.name, isBot: !!p.isBot, left: false, alive: i !== 3,
      victory, lp: [12, 12, 12, 0][i], bandId: p.bandId || null,
      roundsPassed: i === 3 ? 9 : victory ? 14 : 11, eliminatedRound: i === 3 ? 10 : null, title: title(i),
      lineup: lineup(i), bonds: bonds(i),
      stats: {
        dmgDealt: [2310000, 1720000, 980000, 402000][i], kills: [412, 388, 301, 150][i], leaks: [3, 6, 9, 31][i],
        gold: [188, 164, 231, 90][i], refreshes: [22, 18, 30, 8][i], merges: [7, 5, 9, 2][i], itemsEquipped: [9, 6, 11, 3][i],
        bossDamage: victory ? [912000, 610000, 240000, 0][i] : 0, activatedLayers: [541, 402, 377, 120][i],
        lpLost: [16, 19, 12, 24][i], perfectRounds: [11, 12, 9, 4][i],
      },
      trophies: i === 3 ? 1 : 5, reward: i === 3 ? 170 : 425,
      ...(p.rank ? { rank: p.rank } : {}),
    })),
  };
}

const rank = (o) => ({ delta: 0, skipBonus: 0, bonus: 0, kind: 'win', placementDone: true, placementPlayed: 3, placementMatches: 3, globalRank: null, ...o });
const myRank = rank({ before: 1550, after: 1620, delta: 70, tierBefore: '钻石一 50分', tierAfter: '钻石二 20分', iconBefore: 'diamond_1', iconAfter: 'diamond_2' });

const matches = [
  { // ranked coop win, an hour ago
    ranked: true, at: Date.now() - 3600e3,
    players: [
      { playerId: 'p1', name: NAME, bandId: 'band_sarkazb', rank: myRank },
      { playerId: 'p2', name: '阿米娅', bandId: 'band_victoria' },
      { playerId: 'p3', name: 'AI·近卫', isBot: true },
      { playerId: 'p4', name: 'AI·医疗', isBot: true },
    ],
    build: { victory: true, ranked: true, difficulty: 'HARD', modeId: 'mode_multi_hard' },
  },
  { // normal coop defeat, yesterday
    ranked: false, at: Date.now() - 26 * 3600e3,
    players: [
      { playerId: 'p1', name: NAME, bandId: 'band_yan' },
      { playerId: 'p2', name: '阿米娅', bandId: 'band_rhine' },
      { playerId: 'p3', name: 'AI·辅助', isBot: true },
      { playerId: 'p4', name: '凯尔希', bandId: 'band_sarkazb' },
    ],
    build: { victory: false, ranked: false, difficulty: 'NORMAL', modeId: 'mode_multi_normal' },
  },
  { // solo win, two days ago
    ranked: false, at: Date.now() - 50 * 3600e3,
    players: [{ playerId: 'p1', name: NAME, bandId: 'band_sarkazb' }],
    build: { victory: true, ranked: false, difficulty: 'FUNNY', modeId: 'mode_single_funny' },
  },
];

const tmp = mkdtempSync(path.join(tmpdir(), 'sp-history-'));
const store = new HistoryStore({ file: path.join(tmp, 'match-history.json'), log: null });

const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, history: store,
  ranked: new RankedStore({ file: null }), players: new PlayerStore({ file: null }), admin: null });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  // Pin the browser identity to the seeded aid + name, and skip the title screen.
  await page.evaluateOnNewDocument((name, aid) => {
    localStorage.setItem('sp.name', name);
    localStorage.setItem(`sp.aid.${encodeURIComponent(name.toLowerCase())}`, aid);
    sessionStorage.setItem('sp.entered', '1');
  }, NAME, AID);

  await page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'networkidle2', timeout: 90000 });
  // Wait for the lobby (rank data / connection), then open the history entry.
  await page.waitForSelector('.lobby, .screen', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await page.$eval('.ranked-toggle input', (el) => el.checked), true, 'ranked defaults checked');
  await page.screenshot({ path: path.join(OUT, `history-lobby-${W}.png`) });
  await page.evaluate(() => [...document.querySelectorAll('.diff-card')].find((el) => el.textContent.includes('标准模拟')).click());
  assert.equal(await page.$eval('.diff-card.is-selected', (el) => el.textContent.includes('标准模拟')), true);
  assert.equal(await page.$eval('.ranked-toggle input', (el) => el.checked), true, 'standard preserves ranked preference');
  assert.equal(await page.$eval('.ranked-toggle', (el) => el.textContent.includes('不计排位分')), true);
  await page.screenshot({ path: path.join(OUT, `ranked-standard-${W}.png`) });

  // Current viewerId must differ from the old match playerId; otherwise a fresh-session query bug is hidden.
  const myPlayerId = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      for (const session of srv.registry.byPlayerId.values()) {
        if (session?.aid === AID && session.playerId) return resolve(session.playerId);
      }
      if (Date.now() - t0 > 30000) return reject(new Error('hello session for the seeded aid never appeared'));
      setTimeout(poll, 200);
    };
    poll();
  });
  console.log('session playerId:', myPlayerId);

  // Seed records belonging to OLD sessions of the same stable aid, never rewrite them to the current viewer.
  assert.notEqual(myPlayerId, 'p1');
  // Chronological order: real matches end oldest-first, so the newest ends up at the top.
  for (const m of [...matches].sort((a, b) => a.at - b.at)) {
    const players = m.players.map((p) => ({ ...p }));
    const summary = buildResult({ ...m.build, players });
    store.record({
      matchId: randomBytes(16).toString('hex'), at: m.at, ranked: m.ranked,
      seats: players.map((p) => ({ playerId: p.playerId, name: p.name, isBot: !!p.isBot, aid: p.isBot ? null : (p.playerId === 'p1' ? AID : AID2) })),
      summary,
    });
  }

  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '对局记录' && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw new Error('对局记录 entry button not found in lobby');
  await page.waitForSelector('.history-screen', { timeout: 15000 });
  await page.waitForSelector('.history-entry', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, `history-list-${W}.png`) });

  // open the first (ranked) entry -> settlement view
  await page.click('.history-entry');
  await page.waitForSelector('.rcard', { timeout: 15000 });
  assert.equal(await page.$$eval('.rcard__you', (els) => els.length), 1, 'the old match player is highlighted');
  await new Promise((r) => setTimeout(r, 2500)); // let game assets for the settlement view load
  await page.screenshot({ path: path.join(OUT, `history-detail-${W}.png`) });

  const back = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '返回对局记录'));
  await back.asElement()?.click();
  await page.waitForSelector('.history-screen', { timeout: 15000 });
  await page.screenshot({ path: path.join(OUT, `history-back-${W}.png`) });

  const listCount = await page.$$eval('.history-entry', (els) => els.length);
  assert.equal(listCount, 3, 'all old-session records remain visible after returning');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '刷新记录').click());
  await page.waitForSelector('.history-entry', { timeout: 15000 });
  assert.equal(await page.$$eval('.history-entry', (els) => els.length), 3, 'history refresh works');
  console.log(`history entries visible: ${listCount} (expect 3); ranked default, standard selection and refresh passed`);
  if (errors.length) console.log('console errors:\n' + errors.slice(0, 10).join('\n'));
  else console.log('no console errors');
  await page.close();
} finally {
  await browser.close();
  await srv.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log('shots in', OUT);
