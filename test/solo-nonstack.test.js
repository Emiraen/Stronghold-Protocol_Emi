import test from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { ENDLESS_VARIANT } from '../shared/constants.js';
import { ANNIHILATION_VARIANT } from '../shared/annihilation-constants.js';
import { bondsWithGains, bondSnapshot } from '../server/match/bondsMeta.js';
import { helperStats } from '../server/match/unite.js';
import { makeBattle } from './helpers/battleHarness.js';

const data = getData({ log: { info() {}, warn() {}, error() {} } });
for (const options of [
  { mode: 'solo' }, { mode: 'coop' }, { mode: 'coop', variant: 'entertainment_multi' },
  { mode: 'coop', variant: 'entertainment_cyclops' }, { mode: 'coop', variant: ENDLESS_VARIANT },
  { mode: 'coop', variant: ANNIHILATION_VARIANT },
]) test('独行 cannot gain prep layers in ' + (options.variant || options.mode), t => {
  const scheduler = new VirtualScheduler();
  const m = new Match({ ...options, difficulty: options.variant === ANNIHILATION_VARIANT ? 'ANNIHILATION' : 'NORMAL',
    seats: [{ seat: 0, playerId: 'p0', name: 'P0', connected: true }], seed: 81, data, scheduler,
    send() {}, broadcast() {}, onEnd() {}, clientCombat: false, botRehearsal: 0 });
  t.after(() => { m.dispose(); scheduler.dispose(); });
  const ps = m.players.get('p0'), receipt = {};
  assert.equal(ps.addLayers('soloShip', 100, { receipt }), 0);
  assert.equal(receipt.noop, 'non-stacking-bond');
  assert.equal(receipt.stage, 'preflight');
  assert.equal(ps.layers.soloShip, undefined);
  assert.equal(ps.addLayers('yanShip', 2), 2, 'ordinary bond still stacks');
  assert.equal(ps.addLayers('emptyShip', 2), 2, 'other noStack effect rules stay unchanged');
  ps.layers.soloShip = 77;
  ps.pendingLayerGains = { soloShip: 12, yanShip: 3 };
  ps.recompute();
  assert.equal(ps.layers.soloShip, undefined, 'obsolete layers are removed');
  assert.equal(ps.pendingLayerGains.soloShip, undefined);
  assert.equal(ps.layers.yanShip, 2);
  assert.equal(ps.bonds.soloShip.layers, 0);
});

for (const kind of ['normal', 'unite', 'boss', 'hidden', 'mizuki']) {
  test('独行 battle gains are blocked before hooks even without a cap: ' + kind, () => {
    const h = makeBattle({ kind, content: 'none', bonds: {
      soloShip: { count: 1, active: true, tier: 1, layers: 77 },
      yanShip: { count: 2, active: true, tier: 1, layers: 0 },
    }, flags: { layerGainsEnabled: true, uncappedBondLayers: true } });
    let hooks = 0;
    h.b.on('layerGain', () => { hooks++; });
    const receipt = {};
    assert.equal(h.b.getPlayer('p1').bonds.soloShip.layers, 0);
    assert.equal(h.b.addLayers('p1', 'soloShip', 1500, 'test', { receipt }), 0);
    assert.equal(receipt.added, 0);
    assert.equal(hooks, 0);
    assert.equal(h.b._pp('p1').layerGains.soloShip, undefined);
    assert.equal(h.eventsOf('layer').length, 0);
    assert.equal(h.b.addLayers('p1', 'yanShip', 1500), 1500);
    assert.equal(hooks, 1);
  });
}

test('独行 pending layers do not enter battle snapshots or rescue layer rankings', () => {
  const bonds = { soloShip: { count: 1, active: true, tier: 1, layers: 0 } };
  assert.equal(bondsWithGains(bonds, { soloShip: 50 }, Infinity).soloShip.layers, 0);
  assert.equal(bondSnapshot({ soloShip: { ...bonds.soloShip, layers: 77 } }).soloShip.layers, 0);
  const stats = helperStats({ isEndless: true }, { deployCount: 1, bonds,
    layers: { soloShip: 77 }, pendingLayerGains: { soloShip: 50 }, board: new Map() });
  assert.equal(stats.layers, 0);
  assert.equal(stats.active, true, '独行 still counts as an active bond');
});
