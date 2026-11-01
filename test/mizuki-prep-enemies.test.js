import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiAutoCombat } from '../server/modes/mizuki/Combat.js';
import { createOfficialMizukiStage } from '../server/modes/mizuki/official-stages.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';

const route = { start: [9, 9], end: [9, 3], checkpoints: [{ type: 'WAIT', time: 30 }] };
const spawn = extra => ({ actionType: 'SPAWN', key: 'enemy_1007_slime', count: 1, preDelay: 0, routeIndex: 0, ...extra });
const fragment = (actions, extra) => ({ preDelay: 0, postDelay: 0, actions, ...extra });
const wave = (fragments, extra) => ({ preDelay: 0, postDelay: 0, fragments, ...extra });
const create = (t, waves, options = {}) => {
  const c = new MizukiAutoCombat({ seed: 42, fieldId: 'preview', stageId: 'act1autochess_m02',
    rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, content: 'none', timeLimit: 60,
    players: [{ playerId: 'p0', units: [] }], officialLevel: { routes: [route], waves }, ...options });
  t.after(() => c.forceEnd()); return c;
};

test('opening preview respects all scheduler delays, hidden groups, counts, random selection and fragment/wave blocking', t => {
  const c = create(t, [wave([fragment([spawn({ count: 2, interval: 1 }), spawn({ preDelay: 1 }),
    spawn({ count: 0 }), spawn({ hiddenGroup: 'off' }), spawn({ hiddenGroup: 'on' }),
    spawn({ randomSpawnGroupKey: 'rng', weight: 1 }), spawn({ randomSpawnGroupKey: 'rng', weight: 1 })]),
    fragment([spawn({ count: 7 })])]), wave([fragment([spawn({ count: 8 })])])],
  { officialWaveOptions: { enabledHiddenGroups: ['on'] } });
  assert.equal(c.preparationEnemies().length, 3);
  assert.equal(create(t, [wave([fragment([spawn({})])], { preDelay: .1 })]).preparationEnemies().length, 0);
  assert.equal(create(t, [wave([fragment([spawn({})], { preDelay: .1 })])]).preparationEnemies().length, 0);
  const blocked = create(t, [wave([fragment([spawn({ blockFragment: true })]), fragment([spawn({ count: 4 })])])]);
  assert.equal(blocked.preparationEnemies().length, 1);
  const instant = create(t, [wave([fragment([])]), wave([fragment([]), fragment([spawn({ count: 2, interval: 0 })])])]);
  assert.equal(instant.preparationEnemies().length, 2);
});

test('repeated PREP snapshots are pure and COMBAT spawns the opening enemies once with real AI', t => {
  const c = create(t, [wave([fragment([spawn({})], { postDelay: 15 })])]);
  const before = { time: c.time, tick: c.tick, started: c.battle.started, dp: c.battle.players[0].dp,
    pending: structuredClone(c.battle._pending), rng: c.officialWaves.rng.state };
  const first = c.snapshot().prepEnemies;
  for (let i = 0; i < 5; i++) assert.deepEqual(c.snapshot().prepEnemies, first);
  assert.deepEqual({ time: c.time, tick: c.tick, started: c.battle.started, dp: c.battle.players[0].dp,
    pending: structuredClone(c.battle._pending), rng: c.officialWaves.rng.state }, before);
  assert.equal(c.battle.enemies.length, 0); assert.deepEqual(c.drainEvents(), []);
  c.step(); assert.equal(c.battle.enemies.length, 1);
  assert.equal(c.snapshot().prepEnemies, undefined);
  const enemy = c.battle.enemies[0]; assert.equal(enemy.defId, first[0].defId);
  assert.deepEqual([enemy.spawnX, enemy.spawnY], [first[0].x, first[0].y]);
  for (let i = 0; i < 60; i++) c.step();
  assert.equal(c.battle.enemies.length, 1); assert.equal(c.battle.errorCount, 0);
});

test('real Match public field carries frozen previews through re-preparation and keeps each field separate', t => {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const match = new MizukiMatch({ roomCode: 'PREVIEW', matchId: 'prep-enemies', mode: 'coop', difficulty: 'NORMAL', seed: 17,
    seats: ['p0', 'p1'].map((playerId, seat) => ({ playerId, seat, connected: true })),
    data: getData({ log: { warn() {}, error() {}, info() {} } }), scheduler, send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  match.phase = 'PREP'; match.currentNode = { id: 'opening', type: 'combat', stageId: 'ro2_n_1_2' };
  match._prepareFields();
  const view = match.publicView().mizuki.fields;
  assert.equal(view.length, 2); assert.notEqual(view[0].fieldId, view[1].fieldId);
  assert.ok(view.every(field => field.prepEnemies.length === 3 && field.t === 0 && field.tick === 0));
  const units = view.map(field => field.prepEnemies.map(({ id, defId, x, y }) => ({ id, defId, x, y })));
  assert.ok([...match.fields.values()].every(field => !field.engine.battle.started && !field.engine.battle.enemies.length));
  match._prepareFields();
  assert.deepEqual(match.publicView().mizuki.fields.map(field => field.prepEnemies.map(({ id, defId, x, y }) => ({ id, defId, x, y }))), units);
  assert.equal(match.privateView('p0').mizuki.fieldId, view[0].fieldId);
  match.phase = 'COMBAT';
  for (const field of match.fields.values()) field.engine.step();
  const combatFields = match.publicView().mizuki.fields;
  assert.ok(combatFields.every(field => field.prepEnemies === undefined));
  for (let i = 0; i < combatFields.length; i++) {
    // Native bonus boxes are enemy-sided facilities as well; compare the
    // opening wave monsters themselves instead of incorrectly counting boxes.
    const enemies = combatFields[i].meta.units.filter(u => u.side === 'enemy' && u.defId.startsWith('enemy_'));
    assert.equal(enemies.length, units[i].length);
    assert.deepEqual(enemies.map(u => u.defId), units[i].map(u => u.defId));
    assert.equal([...match.fields.values()][i].engine.battle.errorCount, 0);
  }
});
