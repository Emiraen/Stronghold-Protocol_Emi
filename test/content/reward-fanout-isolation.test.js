import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';
import { gainLayers, layersUsed } from '../../server/sim/content/support/index.js';

function field() {
  return makeBattle({ content: 'none', autoFinish: false,
    defs: { chess: { chain_a: chessRec({ id: 'chain_a', bonds: [], skill: null }) } },
    units: [{ chessId: 'chain_a', row: 10, col: 3 }],
    bonds: { yanShip: { active: true, tier: 1, layers: 0 }, visiShip: { active: true, tier: 1, layers: 0 } } });
}
test('battle layers: one failed bond does not suppress the next, or automatically repeat unknown grants', () => {
  const h = field(), add = h.b.addLayers; let failed = 0;
  h.b.addLayers = function(pid, bond, ...args) {
    if (bond === 'yanShip') { failed++; throw Error('first bond failed'); }
    return add.call(this, pid, bond, ...args);
  };
  assert.equal(gainLayers(h.b, { playerId: 'p1', bonds: ['yanShip', 'visiShip'], n: 12 }), 12);
  assert.equal(h.b.getPlayer('p1').bonds.visiShip.layers, 12);
  assert.equal(failed, 1); assert.ok(h.b.errors.some(x => x.message === 'first bond failed'));
});
test('battle layers: commit receipt accounts for cap when later event emission throws', () => {
  const h = field(), ev = h.b._ev;
  h.b._ev = function(event) { if (event[0] === 'layer' && event[2] === 'yanShip') throw Error('layer event failed'); return ev.call(this, event); };
  assert.equal(gainLayers(h.b, { playerId: 'p1', bonds: ['yanShip', 'visiShip'], n: 4, cap: 4, capKey: 'once' }), 8);
  assert.equal(h.b.getPlayer('p1').bonds.yanShip.layers, 4);
  assert.equal(layersUsed(h.b, 'once', 'yanShip'), 4);
  assert.equal(gainLayers(h.b, { playerId: 'p1', bonds: ['yanShip', 'visiShip'], n: 4, cap: 4, capKey: 'once' }), 0);
});
test('devices: one terrain recipient failure cannot suppress later unit refreshes', () => {
  const h = makeBattle({ stageId: 'act2autochess_m03', autoFinish: false, timeLimit: 20,
    defs: { chess: { chain_a: chessRec({ id: 'chain_a', skill: null }), chain_b: chessRec({ id: 'chain_b', skill: null }) } },
    units: [{ chessId: 'chain_a', row: 12, col: 5 }, { chessId: 'chain_b', row: 12, col: 6 }] });
  h.step(); const first = h.unit('chain_a'), second = h.unit('chain_b');
  const mem = first.mem; first.mem = new Proxy(mem, { get(target, key) { if (key === 'terrain') throw Error('terrain reader failed'); return target[key]; } });
  let refreshed = 0; const mem2 = second.mem;
  second.mem = new Proxy(mem2, { get(target, key) { if (key === 'terrain') refreshed++; return target[key]; } });
  h.b.emit('tick', { dt: .1 });
  assert.ok(refreshed > 0); assert.ok(h.b.errors.some(x => x.message === 'terrain reader failed'));
});
