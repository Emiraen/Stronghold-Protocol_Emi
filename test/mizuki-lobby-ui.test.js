import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { MIZUKI_VARIANT } from '../shared/mizuki-constants.js';

const source = readFileSync(new URL('../public/js/screens/lobby.js', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'module', ecmaVersion: 2024 });
const snippets = new Map();
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'VariableDeclarator' && ['create', 'pickMizukiDifficulty'].includes(value.id?.name)) {
    snippets.set(value.id.name, source.slice(value.init.start, value.init.end));
  }
  if (value.type === 'VariableDeclarator' && value.id?.type === 'ArrayPattern'
    && value.id.elements[0]?.name === 'mizukiDifficultyGrade') {
    const init = value.init.arguments[0];
    snippets.set('initialGrade', source.slice(init.start, init.end));
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(visit); else visit(child);
  }
}
visit(ast);

function createRequest(overrides = {}) {
  let sent;
  const context = {
    rankPending: false, rankedEligible: false, entertainment: true, mizuki: true, cyclops: false,
    variant: MIZUKI_VARIANT, mizukiCapacity: 4, cyclopsCapacity: 8, capacity: 10,
    difficulty: 'HARD', ranked: false, roomMode: 'coop', mizukiDifficultyGrade: 18,
    run: (_kind, fn) => fn(), net: { request: (type, payload) => { sent = { type, payload }; } },
    ...overrides,
  };
  runInNewContext('(' + snippets.get('create') + ')', context)();
  return JSON.parse(JSON.stringify(sent));
}

test('Mizuki lobby keeps its N0-N18 preference separate and rejects malformed saved grades', () => {
  assert.equal(snippets.size, 3);
  for (const saved of [0, 8, 18]) {
    const initial = runInNewContext('(' + snippets.get('initialGrade') + ')', { loadPref: () => saved });
    assert.equal(initial(), saved);
  }
  for (const saved of [-1, 19, 1.5, '18', null, undefined, NaN]) {
    const initial = runInNewContext('(' + snippets.get('initialGrade') + ')', { loadPref: () => saved });
    assert.equal(initial(), 0);
  }
});

test('changing the Mizuki lobby grade writes only its own preference and ignores invalid values', () => {
  const states = [], writes = [];
  const pick = runInNewContext('(' + snippets.get('pickMizukiDifficulty') + ')', {
    setMizukiDifficultyGrade: grade => states.push(grade), savePref: (key, value) => writes.push([key, value]),
  });
  for (const value of [0, 9, 18, -1, 19, 2.5, '7', null, NaN]) pick(value);
  assert.deepEqual(states, [0, 9, 18]);
  assert.deepEqual(writes, states.map(value => ['lobby.mizukiDifficultyGrade', value]));
});

test('the existing Mizuki room creation action sends the selected grade and capacity', () => {
  for (const grade of [0, 7, 18]) {
    assert.deepEqual(createRequest({ mizukiDifficultyGrade: grade, mizukiCapacity: 2 }), {
      type: 'room.create', payload: { mode: 'coop', variant: MIZUKI_VARIANT, capacity: 2,
        difficulty: 'NORMAL', ranked: false, mizukiDifficultyGrade: grade },
    });
  }
});

test('other lobby modes keep their original difficulty and do not send a Mizuki grade', () => {
  assert.deepEqual(createRequest({ entertainment: false, mizuki: false, roomMode: 'solo', ranked: true }), {
    type: 'room.create', payload: { mode: 'solo', difficulty: 'HARD', ranked: true },
  });
  for (const variant of ['entertainment_multi', 'entertainment_cyclops', 'entertainment_endless']) {
    const sent = createRequest({ mizuki: false, variant });
    assert.equal(Object.hasOwn(sent.payload, 'mizukiDifficultyGrade'), false);
    assert.equal(sent.payload.difficulty, 'HARD');
    assert.equal(sent.payload.variant, variant);
  }
});
