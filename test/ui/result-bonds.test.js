import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resultBonds } from '../../public/js/screens/settle.js';
import { recordBonds } from '../../public/js/screens/stats.js';
import { detailResultBonds } from '../../public/js/screens/result.js';
import { normalizeRecord, recordToResult } from '../../public/js/ui/stats.js';

const records = JSON.parse(readFileSync(new URL('../../data/bonds.json', import.meta.url), 'utf8'));
const bondRec = (id) => records[id] || null;
const noStack = (id) => !!bondRec(id)?.noStack;
const isCore = (id) => !!bondRec(id)?.isCore;
const ids = (bonds) => bonds.map((b) => b.bondId);

test('more than six bonds retain every entry, with activated core bonds first', () => {
  const bonds = [
    { bondId: 'preciShip', layers: 30, active: true },
    { bondId: 'swiftShip', layers: 29, active: true },
    { bondId: 'skillfulShip', layers: 28, active: true },
    { bondId: 'arcaneShip', layers: 27, active: true },
    { bondId: 'steadShip', layers: 26, active: true },
    { bondId: 'deputShip', layers: 25, active: true },
    { bondId: 'visiShip', layers: 24, active: true },
    { bondId: 'yanShip', layers: 1, active: true },
    { bondId: 'sargonShip', layers: 2, active: true },
  ];
  const unchanged = structuredClone(bonds);
  for (const shown of [
    resultBonds(bonds, bondRec),
    recordBonds(bonds, noStack, isCore),
    detailResultBonds(bonds, bondRec),
  ]) {
    assert.equal(shown.length, bonds.length);
    assert.deepEqual(ids(shown).slice(0, 2), ['sargonShip', 'yanShip']);
    assert.deepEqual(ids(shown).slice(2), ids(bonds).slice(0, 7));
  }
  assert.deepEqual(bonds, unchanged, 'display sorting must not mutate saved result data');
});

test('all eight active core bonds survive the former six-item limit', () => {
  const cores = Object.values(records).filter((b) => b.isCore).map((b) => ({ bondId: b.bondId, layers: 1, active: true }));
  assert.equal(cores.length, 8, 'fixture tracks actual core metadata');
  const bonds = [{ bondId: 'preciShip', layers: 99, active: true }, ...cores];
  for (const shown of [resultBonds(bonds, bondRec), recordBonds(bonds, noStack, isCore), detailResultBonds(bonds, bondRec)]) {
    assert.deepEqual(ids(shown), [...ids(cores), 'preciShip']);
  }
});

test('each view keeps its original visibility rule and never invents core activation', () => {
  const bonds = [
    { bondId: 'yanShip', layers: 40, active: false },
    { bondId: 'maniShip', layers: 6, active: true },
    { bondId: 'emptyShip', layers: 8, active: false },
    { bondId: 'oldUnknownBond', layers: 1, active: true },
    { bondId: 'sargonShip', layers: 0, active: false },
  ];
  const settled = resultBonds(bonds, bondRec);
  assert.deepEqual(ids(settled), ['yanShip', 'oldUnknownBond', 'maniShip']);
  assert.equal(settled.find((b) => b.bondId === 'maniShip').hideLayers, true);
  const saved = recordBonds(bonds, noStack, isCore);
  assert.deepEqual(ids(saved), ['oldUnknownBond', 'maniShip', 'yanShip', 'emptyShip']);
  assert.equal(saved.find((b) => b.bondId === 'emptyShip').hidden, true);
  assert.equal(saved.find((b) => b.bondId === 'yanShip').active, false);
  const details = detailResultBonds(bonds, bondRec);
  assert.deepEqual(ids(details), ['yanShip', 'emptyShip', 'maniShip', 'oldUnknownBond']);
});

test('older saved match records keep all bonds through normalization and result replay', () => {
  const bonds = Object.values(records).slice(0, 10).map((b, i) => ({ id: b.bondId, layers: i + 1, active: i < 2 }));
  const record = normalizeRecord({ id: 'old', t: 1, end: 'settled', victory: true, selfId: 'p',
    players: [{ playerId: 'p', alive: true, bonds }] });
  const result = recordToResult(record);
  assert.deepEqual(ids(result.players[0].bonds), bonds.map((b) => b.id));
  assert.equal(recordBonds(result.players[0].bonds, noStack, isCore).length, bonds.length);
});
