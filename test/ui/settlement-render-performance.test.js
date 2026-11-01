import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { settlementReady, reportResult, bestResultStats } from '../../public/js/screens/result.js';

// Structural guards complement the browser profile: they protect which component
// owns an animation, not machine-dependent frame-time thresholds.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const game = read('../../public/js/screens/game.js');
const settle = read('../../public/js/screens/settle.js');
const result = read('../../public/js/screens/result.js');
const rankCss = read('../../public/css/east-battle.css');
const settleCss = read('../../public/css/screens/result.css');
const ast = parse(settle, { ecmaVersion: 'latest', sourceType: 'module' });
const functions = new Map(ast.body.flatMap((entry) => {
  const node = entry.type === 'ExportNamedDeclaration' ? entry.declaration : entry;
  return node?.type === 'FunctionDeclaration' ? [[node.id.name, node]] : [];
}));
const sourceOf = (name) => {
  const node = functions.get(name);
  assert.ok(node, `missing component ${name}`);
  return settle.slice(node.start, node.end);
};

test('settlement waits for a receipt before initializing the one-shot flow, with a usable return button', () => {
  const screen = sourceOf('ResultScreen');
  const guard = screen.indexOf('if (!res)');
  const pending = screen.indexOf('if (res?.settlementPending');
  const flow = screen.indexOf('<${SettleFlow}');
  assert.ok(guard >= 0 && guard < pending && pending < flow);
  const waiting = screen.slice(guard, pending);
  assert.ok(waiting.includes('return html`'));
  assert.ok(waiting.includes('<${Spinner}'));
  assert.ok(waiting.includes("t('正在结算…')"));
  assert.ok(waiting.includes('onClick=${back}'));
  assert.ok(!waiting.includes('<${SettleFlow}'));
  assert.ok(screen.includes('const back = () => store.set({ match: emptyMatch() })'));
});

test('result phase replaces the live battlefield without waiting for the end plate', () => {
  assert.ok(game.includes('else if (over) body = html`<${ResultScreen} />`'));
  assert.ok(!game.includes('else if (over && !endOn)'));
  assert.ok(game.includes('if (spectator) body = html`<${MatchScreen} />`'));
  assert.ok(game.includes('endOn && endKind ? html`<${EndPlate}'));
});

test('round count-up timers stay in text leaves, not the expensive result pages', () => {
  assert.ok(sourceOf('CountUp').includes('return useCountUp(to, options)'));
  for (const name of ['SelfPage', 'TeamPage']) {
    const page = sourceOf(name);
    assert.ok(!page.includes('useCountUp('), `${name} must not rerender on every count-up tick`);
    assert.ok(page.includes('<${CountUp}'), `${name} must render the isolated number leaf`);
  }
  assert.ok(sourceOf('SelfPage').includes('to=${self.roundsPassed}'));
  assert.ok(sourceOf('TeamPage').includes('to=${r.roundsPassed}'));
});

test('experience count-up state is confined to the dedicated level strip', () => {
  const strip = sourceOf('LevelStrip');
  assert.ok(strip.includes('useCountUp(prog.gain'));
  assert.ok(strip.includes('useCountUp(prog.after'));
  assert.ok(sourceOf('SelfPage').includes('<${LevelStrip} prog=${prog}'));
  assert.ok(!sourceOf('SelfPage').includes('const gain ='));
  assert.ok(!sourceOf('SelfPage').includes('const total = useCountUp'));
});

test('level and ranked progress animate transform on full-width tracks, not layout width or left', () => {
  assert.ok(sourceOf('LevelStrip').includes('transform:scaleX(${lv.exp / LV_EXP})'));
  assert.ok(result.includes('transform:scaleX(${fill})'));
  assert.ok(result.includes('transform:translateX(${fill * 100}%)'));
  assert.ok(!result.includes('width:${fill'));
  assert.ok(!result.includes('left:${fill'));
  const rule = (css, selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `missing CSS rule ${selector}`);
    return css.slice(start, css.indexOf('}', start));
  };
  for (const css of [rule(settleCss, '.slv__bar i'), rule(rankCss, '.rsettle__fill')]) {
    assert.ok(css.includes('width: 100%'));
    assert.ok(css.includes('transform-origin: left center'));
  }
  assert.ok(rule(rankCss, '.rsettle__cursor-track').includes('inset: 0'));
});


test('ready receipts bypass the fixed end plate and extra radar wait, pending receipts do not', () => {
  const ready = { matchId: 'one', players: [{ playerId: 'p', stats: { kills: 2 }, reward: 17 }] };
  assert.equal(settlementReady(null), false);
  assert.equal(settlementReady({}), false);
  assert.equal(settlementReady({ ...ready, settlementPending: true }), false);
  assert.equal(settlementReady({ ...ready, incomplete: true }), false);
  assert.equal(settlementReady({ ...ready, settlementErrors: [{ code: 'FAILED' }] }), false);
  assert.equal(settlementReady({ ...ready, players: [{ stats: null }] }), false);
  assert.equal(settlementReady({ ...ready, players: [{ settlementError: { code: 'FAILED' } }] }), false);
  assert.equal(settlementReady(ready), true);
  assert.ok(game.includes('const endOn = !resultReady &&'));
  assert.ok(game.includes('if (!over || resultReady)'));
  assert.ok(game.includes('}, [over, resultReady])'));
  assert.ok(sourceOf('SettleFlow').includes("useState(() => (!self ? 'team' : 'self'))"));
});

test('same match pending and later final payloads are never confused by identity caching', () => {
  const pending = { matchId: 'same-match', settlementPending: true, players: [{ playerId: 'p', stats: { kills: 3 }, reward: 5 }] };
  const complete = { ...pending, settlementPending: false, players: [{ playerId: 'p', stats: { kills: 9 }, reward: 31 }] };
  assert.equal(reportResult(pending).players[0].reward, null);
  assert.equal(settlementReady(pending), false);
  assert.equal(settlementReady(complete), true);
  assert.equal(reportResult(complete).players[0].reward, 31);
  assert.equal(reportResult(complete).players[0].stats.kills, 9);
  assert.ok(sourceOf('SettleFlow').includes('[res, pub]'));
  assert.ok(sourceOf('SettleFlow').includes('[res, myId]'), 'late final payload refreshes the level summary');
  assert.ok(result.includes('useMemo(() => reportResult(result, pub), [result, pub])'));
});

test('best-stat comparison is memoized and preserves zero, tie and new final-data rules', () => {
  const rows = [{ playerId: 'a', stats: { kills: 3, dmgDealt: 0 } }, { playerId: 'b', stats: { kills: 3, dmgDealt: 7 } }];
  const before = structuredClone(rows);
  assert.deepEqual(bestResultStats(rows), { kills: 'a', dmgDealt: 'b' });
  assert.deepEqual(bestResultStats([rows[0]]), {});
  assert.deepEqual(bestResultStats([]), {});
  assert.deepEqual(rows, before);
  assert.equal(bestResultStats([{ ...rows[0], stats: { kills: 10 } }, rows[1]]).kills, 'a');
  assert.ok(result.includes('useMemo(() => bestResultStats(r.players), [r.players])'));
});
