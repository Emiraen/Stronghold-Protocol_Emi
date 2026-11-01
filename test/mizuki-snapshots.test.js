import test from 'node:test';
import assert from 'node:assert/strict';
import { MIZUKI_VARIANT } from '../shared/mizuki-constants.js';
import { mergeMizukiSnapshot, mergeMizukiField, mergeMizukiEvents } from '../public/js/mizukiSnapshots.js';
import { mizukiLiveHealth } from '../public/js/mizukiHealth.js';

const current = () => ({ variant: MIZUKI_VARIANT, phase: 'COMBAT', players: [{ playerId: 'p1', life: 10 }],
  mizuki: { floor: 2, fields: [
    { fieldId: 'own', battleId: 'battle-a', t: 1, partyId: 'a', kind: 'normal', active: true, players: ['p1'],
      damageRows: [], objectiveUnrescuedByPlayer: { p1: 0 }, stage: { id: 'stage' }, units: [[1, 1, 1]] },
    { fieldId: 'other', battleId: 'battle-b', t: 1, players: ['p2'], units: [[1, 8, 8]] },
  ] } });
const snapshot = () => ({ t: 'b.snap', fieldId: 'own', battleId: 'battle-a', time: 1.1, tick: 33,
  killed: 1, total: 10, units: [[1, 2, 2]], objectiveLossByPlayer: { p1: 2 }, meta: { units: [{ id: 1 }] } });

test('live snapshots update the matching board and health without replacing the run state', () => {
  const before = current(), next = mergeMizukiSnapshot(before, snapshot());
  assert.notEqual(next, before); assert.equal(before.mizuki.fields[0].t, 1);
  assert.equal(next.mizuki.fields[0].t, 1.1); assert.deepEqual(next.mizuki.fields[0].units, [[1, 2, 2]]);
  assert.equal(next.mizuki.fields[0].partyId, 'a'); assert.equal(next.mizuki.fields[0].kind, 'normal');
  assert.strictEqual(next.mizuki.fields[0].stage, before.mizuki.fields[0].stage);
  assert.strictEqual(next.mizuki.fields[1], before.mizuki.fields[1]); assert.strictEqual(next.players, before.players);
  assert.equal(Object.hasOwn(next.mizuki.fields[0], 'time'), false);
  assert.equal(mizukiLiveHealth({ fields: next.mizuki.fields, playerId: 'p1', health: { life: 10, shield: 1 }, phase: 'COMBAT' }).shown, 9);
});

test('late, unknown, old battle, wrong mode and invalid snapshots are ignored', () => {
  const before = current();
  for (const update of [
    { time: .9 }, { time: 1 }, { time: NaN }, { time: undefined }, { fieldId: 'unknown' },
    { battleId: 'previous-battle' }, { battleId: null }, { t: 'b.ev' },
  ]) assert.strictEqual(mergeMizukiSnapshot(before, { ...snapshot(), ...update }), before);
  assert.strictEqual(mergeMizukiSnapshot({ ...before, variant: 'normal' }, snapshot()).variant, 'normal');
  assert.strictEqual(mergeMizukiSnapshot(before, null), before);
});

test('two doctors with matching unit ids keep their own boards when viewing either field', () => {
  const before = current(), next = mergeMizukiSnapshot(before, { ...snapshot(), fieldId: 'other', battleId: 'battle-b', units: [[1, 9, 9]] });
  assert.deepEqual(next.mizuki.fields[0].units, [[1, 1, 1]]);
  assert.deepEqual(next.mizuki.fields[1].units, [[1, 9, 9]]);
});

test('a full watched snapshot hydrates an equal-time overview and clears its render guard', () => {
  const before = current(); before.mizuki.fields[0] = { fieldId: 'own', battleId: 'battle-a', t: 1.1, players: ['p1'], __overview: true };
  const next = mergeMizukiSnapshot(before, { ...snapshot(), stage: { id: 'real' }, meta: { units: [] } });
  assert.equal(next.mizuki.fields[0].t, 1.1); assert.equal(Object.hasOwn(next.mizuki.fields[0], '__overview'), false);
  assert.deepEqual(next.mizuki.fields[0].stage, { id: 'real' }); assert.deepEqual(next.mizuki.fields[0].units, [[1, 2, 2]]);
  assert.equal(before.mizuki.fields[0].__overview, true);
});

test('ordinary reliable field metadata survives compact snapshots and spawn events without merging boards', () => {
  const before = current();
  const metadata = { t: 'm.field', fieldId: 'own', battleId: 'battle-a', rect: { r0: 0, r1: 4, c0: 0, c1: 4 },
    stage: { id: 'native' }, geometry: { tiles: [{ row: 1, col: 1 }] }, units: [{ id: 1, name: 'doctor one' }] };
  const full = mergeMizukiField(before, metadata);
  const { meta: _meta, ...compact } = snapshot();
  const live = mergeMizukiSnapshot(full, compact);
  assert.strictEqual(live.mizuki.fields[0].stage, metadata.stage);
  assert.deepEqual(live.mizuki.fields[0].meta.units, metadata.units);
  const spawned = mergeMizukiEvents(live, { t: 'b.ev', fieldId: 'own', battleId: 'battle-a',
    events: [['spawn', { id: 2, kind: 'token', ownerUnitId: 1 }]] });
  assert.deepEqual(spawned.mizuki.fields[0].meta.units.map(unit => unit.id), [1, 2]);
  assert.strictEqual(spawned.mizuki.fields[1], before.mizuki.fields[1]);
  assert.strictEqual(mergeMizukiField(spawned, { ...metadata, battleId: 'old' }), spawned);
  assert.strictEqual(mergeMizukiEvents(spawned, { fieldId: 'own', battleId: 'old', events: [['spawn', { id: 3 }]] }), spawned);
});
