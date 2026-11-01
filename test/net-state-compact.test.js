import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net } from '../public/js/net.js';
import { MIZUKI_VARIANT } from '../shared/mizuki-constants.js';

const full = (value, k = value.t, n = 1, extra = {}) => ({ t: 'net.state', k, e: 1, n, v: value, ...extra });
const snap = (fieldId = 'a', battleId = 'battle-a', time = 10) => ({ t: 'b.snap', fieldId, battleId, time,
  partyId: 'party-a', kind: 'normal', active: true, players: ['p1'], units: [[1, 2, 3]],
  stage: { id: 'real-map' }, meta: { units: [{ id: 1, ownerId: 'p1' }] }, objectiveLossByPlayer: { p1: 2 } });
const publicState = fields => ({ t: 'm.public', variant: MIZUKI_VARIANT, phase: 'COMBAT', mizuki: { floor: 2, fields } });
function decoder() { const net = new Net(); net._stateDelta = true; net._stateCompact = true; return net; }

test('compact public field references reconstruct every original field property', () => {
  const net = decoder(), snapshot = snap();
  net._decodeState(full(snapshot, 'b.snap:a'));
  const msg = net._decodeState(full(publicState([['$b', 'a', 'battle-a']]), 'm.public', 1, { c: 1 }));
  const { time, ...expected } = snapshot;
  assert.deepEqual(msg.mizuki.fields, [{ ...expected, t: time }]);
  assert.deepEqual(net._stateBases.get('m.public').v.mizuki.fields, [['$b', 'a', 'battle-a']]);
  msg.mizuki.fields[0].units[0][1] = 999; msg.mizuki.fields[0].stage.id = 'consumer';
  assert.equal(net._stateBases.get('b.snap:a').v.units[0][1], 2);
  assert.equal(net._stateBases.get('b.snap:a').v.stage.id, 'real-map');
});

test('compact deltas preserve reference baseline and reconstruct latest per-field snapshots', () => {
  const net = decoder();
  net._decodeState(full(snap(), 'b.snap:a'));
  net._decodeState(full(snap('b', 'battle-b', 20), 'b.snap:b'));
  net._decodeState(full(publicState([['$b', 'a', 'battle-a'], ['$b', 'b', 'battle-b']]), 'm.public', 1, { c: 1 }));
  net._decodeState({ t: 'net.delta', k: 'b.snap:a', e: 1, b: 1, n: 2, p: [[['time'], 10.1], [['units', '0', '1'], 4]] });
  const msg = net._decodeState({ t: 'net.delta', k: 'm.public', e: 1, b: 1, n: 2, c: 1, p: [[['mizuki', 'floor'], 3]] });
  assert.equal(msg.mizuki.floor, 3); assert.equal(msg.mizuki.fields[0].t, 10.1); assert.equal(msg.mizuki.fields[1].t, 20);
  assert.equal(msg.mizuki.fields[0].units[0][1], 4);
  assert.deepEqual(net._stateBases.get('m.public').v.mizuki.fields[0], ['$b', 'a', 'battle-a']);
});

test('first/full fields coexist with references, old peers remain unchanged', () => {
  const net = decoder(), value = { ...snap('b', 'battle-b'), t: 10 }; delete value.time;
  net._decodeState(full(snap(), 'b.snap:a'));
  const msg = net._decodeState(full(publicState([['$b', 'a', 'battle-a'], value]), 'm.public', 1, { c: 1 }));
  assert.deepEqual(msg.mizuki.fields[1], value);
  const old = new Net(); old._stateDelta = true;
  assert.deepEqual(old._decodeState(full(publicState([value]))), publicState([value]));
  assert.throws(() => old._decodeState(full(publicState([value]), 'm.public', 2, { c: 1 })), /unnegotiated/);
});

test('missing, wrong-battle, malformed and fresh-epoch references fail before committing public baseline', () => {
  for (const reference of [['$b', 'missing', 'battle-a'], ['$b', 'a', 'old'], ['$b', 'a'], ['wrong', 'a', 'battle-a']]) {
    const net = decoder(); net._decodeState(full(snap(), 'b.snap:a'));
    assert.throws(() => net._decodeState(full(publicState([reference]), 'm.public', 1, { c: 1 })));
    assert.equal(net._stateBases.has('m.public'), false);
  }
  const net = decoder(); net._decodeState(full(snap(), 'b.snap:a'));
  assert.throws(() => net._decodeState({ ...full(publicState([['$b', 'a', 'battle-a']]), 'm.public', 1, { c: 1 }), e: 2 }), /missing battle reference/);
  assert.equal(net._stateBases.has('b.snap:a'), false);
});

test('watched-board subscriptions require negotiation, merge pending duplicates and recover from failure', async () => {
  const net = decoder(), calls = [];
  net.status = 'online';
  net.request = (type, fields) => new Promise((resolve, reject) => calls.push({ type, fields, resolve, reject }));
  assert.equal(await net.watchMizukiField('a'), false); assert.equal(calls.length, 0);
  net._stateStream = true;
  assert.equal(await net.watchMizukiField(''), false); assert.equal(await net.watchMizukiField('a'.repeat(33)), false);
  const first = net.watchMizukiField('a');
  assert.strictEqual(net.watchMizukiField('a'), first); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].fields, { fieldId: 'a', viewOnly: true }); assert.equal(calls[0].type, 'g.watch');
  const second = net.watchMizukiField('b'); calls[0].resolve({ t: 'ok' });
  assert.equal(await first, true); assert.equal(net._mizukiWatchRequest.fieldId, 'b');
  calls[1].reject(new Error('stale field')); assert.equal(await second, false); assert.equal(net._mizukiWatchRequest, null);
  const retry = net.watchMizukiField('b'); calls[2].resolve({ t: 'ok' }); assert.equal(await retry, true);
  const observe = net.watchMizukiField('b', { spectator: true });
  assert.equal(calls[3].type, 'spectator.watch'); assert.deepEqual(calls[3].fields, { fieldId: 'b' });
  calls[3].resolve({ t: 'ok' }); assert.equal(await observe, true);
  net.status = 'reconnecting'; assert.equal(await net.watchMizukiField('a'), false); assert.equal(calls.length, 4);
});

test('unwatched overviews preserve team HUD data and privately retain full fields without rendering stale boards', () => {
  const net = decoder(); net._stateStream = true;
  const { time, ...rest } = snap(); const field = { ...rest, t: time };
  net._decodeState(full(publicState([field])));
  const overview = { fieldId: 'a', battleId: 'battle-a', t: 12, players: ['p1'], killed: 3, total: 20,
    objectiveLossByPlayer: { p1: 3 }, damageRows: [{ key: 'operator1', total: 10 }] };
  const first = net._decodeState(full(publicState([['$h', overview]]), 'm.public', 2, { c: 1 }));
  assert.deepEqual(first.mizuki.fields[0], { ...field, ...overview, __overview: true });
  first.mizuki.fields[0].stage.id = 'consumer'; first.mizuki.fields[0].units[0][1] = 999;
  const second = net._decodeState({ t: 'net.delta', k: 'm.public', e: 1, b: 2, n: 3, c: 1, p: [[['mizuki', 'floor'], 3]] });
  assert.equal(second.mizuki.fields[0].stage.id, 'real-map'); assert.equal(second.mizuki.fields[0].units[0][1], 2);
  net._decodeState(full(snap('a', 'battle-a', 12.1), 'b.snap:a'));
  const latest = net._decodeState(full(publicState([['$h', { ...overview, t: 12.2 }]]), 'm.public', 4, { c: 1 }));
  assert.equal(latest.mizuki.fields[0].t, 12.2); assert.equal(latest.mizuki.fields[0].__overview, true);
  const cold = net._decodeState(full(publicState([['$h', { ...overview, fieldId: 'cold', battleId: 'new' }]]), 'm.public', 5, { c: 1 }));
  assert.equal(cold.mizuki.fields[0].stage, undefined); assert.equal(cold.mizuki.fields[0].__overview, true);
});

test('overviews require stream negotiation and never reuse a previous battle map', () => {
  const overview = { fieldId: 'a', battleId: 'new', t: 0, players: ['p1'] };
  const old = decoder();
  assert.throws(() => old._decodeState(full(publicState([['$h', overview]]), 'm.public', 1, { c: 1 })), /invalid field overview/);
  const net = decoder(); net._stateStream = true;
  net._decodeState(full(snap(), 'b.snap:a'));
  const value = net._decodeState(full(publicState([['$h', overview]]), 'm.public', 1, { c: 1 }));
  assert.equal(value.mizuki.fields[0].stage, undefined);
  assert.deepEqual(value.mizuki.fields[0].players, ['p1']);
});

test('ordinary reliable metadata hydrates compact frames and retains new spawns across public refreshes', () => {
  const net = decoder(), metadata = { t: 'm.field', fieldId: 'a', battleId: 'battle-a',
    rect: { r0: 0, r1: 4, c0: 0, c1: 4 }, stage: { id: 'native' }, geometry: { tiles: [1] }, units: [{ id: 1, name: 'original' }] };
  net._onMessage(JSON.stringify(metadata));
  const { meta: _meta, stage: _stage, ...compact } = snap();
  net._decodeState(full(compact, 'b.snap:a'));
  const first = net._decodeState(full(publicState([['$b', 'a', 'battle-a']]), 'm.public', 1, { c: 1 }));
  assert.deepEqual(first.mizuki.fields[0].stage, { id: 'native' });
  assert.equal(first.mizuki.fields[0].meta.units[0].name, 'original');
  first.mizuki.fields[0].stage.id = 'subscriber mutation'; first.mizuki.fields[0].meta.units[0].name = 'mutation';
  net._onMessage(JSON.stringify({ t: 'b.ev', fieldId: 'a', battleId: 'battle-a', events: [['spawn', { id: 2, ownerUnitId: 1 }]] }));
  const second = net._decodeState(full(publicState([['$b', 'a', 'battle-a']]), 'm.public', 2, { c: 1 }));
  assert.equal(second.mizuki.fields[0].stage.id, 'native');
  assert.deepEqual(second.mizuki.fields[0].meta.units.map(unit => unit.id), [1, 2]);
  assert.equal(second.mizuki.fields[0].meta.units[0].name, 'original');
  net._onMessage(JSON.stringify({ ...metadata, battleId: 'battle-new', stage: { id: 'new-native' }, units: [] }));
  const old = net._decodeState(full(publicState([['$b', 'a', 'battle-a']]), 'm.public', 3, { c: 1 }));
  assert.equal(old.mizuki.fields[0].stage, undefined, 'a previous battle never inherits the new map');
});
