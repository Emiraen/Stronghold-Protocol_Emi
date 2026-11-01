import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { MizukiAutoCombat } from '../server/modes/mizuki/Combat.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { Grid } from '../server/sim/grid.js';
import { normalizeMizukiDungeon } from '../server/modes/mizuki/exploration.js';
import { generateMizukiDungeon, applyMizukiEndingRoute } from '../server/modes/mizuki/RouteGeneration.js';
import { MIZUKI_ENDING_ROUTE_RULES } from '../server/modes/mizuki/OriginalRouteRules.js';
import { mizukiVariationSpec } from '../server/modes/mizuki/Variations.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const FIRST_BATTLE = { zones: [{ id: 'zone_1', nodes: [
  { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
] }] };

// This class is intentionally a controlled result fixture. Full generated-run
// tests below verify every route/reward/recruit/floor transition, not stage balance.
// Separate tests use unmodified MizukiAutoCombat until its own natural result.
class ControlledStages {
  constructor(options) {
    this.options = options; this.ticks = 0; this.done = false; this.deployLimit = options.deployLimit;
    this.battle = { grid: new Grid(options.stage, options.rect), rect: options.rect, data: options.data,
      allyUnits: [], enemies: [], players: options.players.map(player => ({ playerId: player.playerId, units: [] })),
      opts: { spawns: [] }, on() {} };
  }
  step() { if (++this.ticks >= 4) this.done = true; }
  snapshot() {
    return { battleId: this.options.battleId, fieldId: this.options.fieldId, controlMode: 'automatic', tick: this.ticks, t: this.ticks / 30,
      done: this.done, outcome: this.done ? 'victory' : null, units: [], leakedCount: 0, leakDamage: 0,
      progression: { version: 1, players: Object.fromEntries(this.options.players.map(player => [player.playerId,
        { layers: structuredClone(player.layers || {}) }])) },
      covenants: Object.fromEntries(this.options.players.map(player => [player.playerId, []])),
      geometry: { rows: 19, cols: 21, rect: this.options.rect, tiles: [] },
      rosters: Object.fromEntries(this.options.players.map(player => [player.playerId,
        player.units.map(unit => ({ ...unit, deployed: this.ticks > 0 }))])) };
  }
  result() { return this.done ? { outcome: 'victory', leakDamage: 0, leakedCount: 0, perPlayer: {} } : null; }
  fieldMeta() { return { fieldId: this.options.fieldId, kind: this.options.kind, stageId: this.options.stageId, units: [] }; }
  drainEvents() { return []; }
  forceEnd() { this.done = true; }
  dispose() { this.done = true; }
}

function fixture(t, { count, natural = false, seed = 619 } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [], warnings = [];
  const match = new MizukiMatch({ roomCode: 'MFLO', matchId: 'mizuki-multiplayer-full-flow', seed, matchNo: 1, hostId: 'p0',
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    data: DATA, scheduler, ...(natural ? { dungeon: structuredClone(FIRST_BATTLE) } : { CombatClass: ControlledStages }),
    log: { info() {}, warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) },
    send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  return { match, scheduler, errors, warnings };
}
function command(match, playerId, message) {
  const result = match.handle(playerId, message);
  assert.equal(result.ok, true, JSON.stringify({ playerId, message, result }));
  return result;
}
function autoplay(match, on) {
  for (const player of match.order) command(match, player.playerId, { t: 'g.autoplay', on });
}
function splitAtBranch(match, count) {
  const source = [...match.expedition.parties.values()][0], state = match.partyStates.get(source.id);
  const choices = state?.phase === PHASE.ROUTE ? state.route.filter(node => node.available && !node.disabled) : [];
  if (match.expedition.parties.size !== 1 || choices.length < 2 || match.floorState.pending) return false;
  autoplay(match, false);
  const childIds = count === 2 ? ['p1'] : count === 3 ? ['p2'] : ['p2', 'p3'];
  for (const player of match.order) command(match, player.playerId,
    { t: 'g.mizuki.route', nodeId: choices[childIds.includes(player.playerId) ? 1 : 0].id });
  const requests = childIds.map(playerId => command(match, playerId,
    { t: 'g.mizuki.splitRequest', nodeId: choices[1].id }).request);
  for (const request of requests) command(match, 'p0', { t: 'g.mizuki.splitDecide', requestId: request.id, approve: true });
  command(match, 'p0', { t: 'g.mizuki.routeStart' });
  assert.equal(match.expedition.parties.size, 2);
  autoplay(match, true);
  return true;
}

for (const count of [2, 3, 4]) test(`${count} players: production automatic combat reaches its natural first-stage result`, { timeout: 120000 }, t => {
  const { match, scheduler, errors, warnings } = fixture(t, { count, natural: true });
  match.start(); autoplay(match, true);
  assert.equal(scheduler.runUntil(() => match.phase === PHASE.COMBAT || match.ended,
    { maxSteps: 5000, maxTime: 180000 }), true, 'native preparation must progress to combat');
  assert.equal(match.phase, PHASE.COMBAT);
  const fields = [...match.fields.values()]; assert.equal(fields.length, count);
  for (const field of fields) assert.ok(field.engine instanceof MizukiAutoCombat);
  assert.equal(scheduler.runUntil(() => match.phase === PHASE.REWARD || match.ended,
    { maxSteps: 30000, maxTime: 600000 }), true, 'actual waves must finish or naturally eliminate the team');
  assert.notEqual(match.resultSummary?.reason, 'engine_error');
  for (const field of fields) {
    assert.ok(field.engine.tick > 0);
    assert.equal(field.engine.battle.errorCount, 0);
    assert.ok(field.engine.result(), 'each production battle has an actual authoritative result');
  }
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []); assert.deepEqual(scheduler.errors, []);
  t.diagnostic(JSON.stringify({ coverage: 'natural production first battle; no forceEnd, no stat/HP overrides', players: count,
    stageId: fields[0].setup.stageInfo?.id || 'ro2_n_1_1', simulationTicks: fields.map(field => field.engine.tick),
    outcomes: fields.map(field => field.engine.result().outcome),
    partyPhase: match.phase, life: match.order.map(player => ({ playerId: player.playerId, life: player.life, alive: player.alive })) }));
});

for (const count of [2, 3, 4]) test(`${count} players: controlled combat traverses all five generated floors, split branches, rewards, recruitment and ending settlement`, { timeout: 120000 }, t => {
  const { match, scheduler, errors, warnings } = fixture(t, { count });
  const phases = new Set(), floors = new Set(), battleIds = new Set(), seenNodeTypes = new Set();
  let split = false, maxParties = 1, callbacks = 0;
  match.start(); autoplay(match, true);
  while (!match.ended && callbacks++ < 40000) {
    phases.add(match.phase); maxParties = Math.max(maxParties, match.expedition.parties.size);
    for (const state of match.partyStates.values()) {
      phases.add(state.phase);
      if (state.explorationState?.zoneKey) floors.add(state.explorationState.zoneKey);
      if (state.currentNode?.graphType) seenNodeTypes.add(state.currentNode.graphType);
    }
    if (!split && match.partyStates.size && splitAtBranch(match, count)) split = true;
    for (const field of match.fields.values()) if (match.partyStates.get(field.partyId)?.phase === PHASE.COMBAT) battleIds.add(field.battleId);
    if (!scheduler.runNext()) break;
  }
  assert.equal(match.ended, true, JSON.stringify({ callbacks, phase: match.phase, floors: [...floors],
    parties: [...match.expedition.parties.values()].map(party => ({ id: party.id, phase: party.phase, votes: party.votes })) }));
  assert.equal(match.resultSummary.reason, 'generated_route_complete');
  assert.equal(match.resultSummary.victory, true); assert.equal(match.resultSummary.endingId, 'ro2_ending_1');
  assert.equal(split, true, 'the complete run includes an approved real branch split'); assert.ok(maxParties >= 2);
  assert.ok(['zone_1', 'zone_2', 'zone_3', 'zone_4', 'zone_5'].every(id => floors.has(id)));
  for (const phase of [PHASE.SQUAD, PHASE.STRATEGY, PHASE.INITIAL_SUPPLY, PHASE.RECRUIT_GROUP,
    PHASE.RECRUIT, PHASE.ROUTE, PHASE.PREP, PHASE.COMBAT, PHASE.REWARD, PHASE.SHOP, PHASE.EVENT]) assert.ok(phases.has(phase), phase);
  assert.ok(match.commander.totalExp > 0); assert.ok(match.commander.level > 1);
  for (const player of match.order) {
    assert.ok(player.roster.length > 0); assert.ok(player.tickets.some(ticket => ticket.status === 'used'));
    assert.ok(Number.isSafeInteger(player.gold) && player.gold >= 0);
    assert.ok(Number.isSafeInteger(player.hope) && player.hope >= 0);
    assert.equal(new Set(player.roster.map(unit => unit.uid)).size, player.roster.length);
    assert.ok(player.hopeCapacity >= player.hope);
  }
  assert.ok(match.endingProgress.battles.some(battle => battle.floor === 5 && battle.stageId === 'ro2_b_4' && battle.cleared));
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []); assert.deepEqual(scheduler.errors, []);
  t.diagnostic(JSON.stringify({ coverage: 'full generated route state machine; controlled combat results, not natural stage clears',
    players: count, floors: [...floors], maximumParties: maxParties, battleFields: battleIds.size,
    nodeTypes: [...seenNodeTypes], ending: match.resultSummary.endingId, commander: match.commander,
    rosters: match.order.map(player => player.roster.length) }));
});

test('all four ending routes expose their actual fifth/sixth-floor boss and required region depths', t => {
  const { match } = fixture(t, { count: 4 });
  const base = generateMizukiDungeon({ seed: 619, stageOptions: match.stageOptions });
  const report = [];
  for (const [endingId, expected] of Object.entries(MIZUKI_ENDING_ROUTE_RULES)) {
    const document = applyMizukiEndingRoute(base, { endingId,
      fifthBossStageId: endingId === 'ro2_ending_2' ? 'ro2_b_5' : 'ro2_b_4',
      sixthBossStageId: expected.floor === 6 ? expected.stageId : null }, { seed: 619, stageOptions: match.stageOptions });
    const floors = normalizeMizukiDungeon(document).floors.filter(floor => !floor.isExtraRegion);
    assert.equal(floors.length, expected.floor);
    assert.deepEqual(floors.slice(0, 5).map((floor, index) => new Set(floor.nodes.map(node => node.depth)).size),
      [5, 5, 6, 6, 7].map((depth, index) => depth + (mizukiVariationSpec(floors[index].variation)?.effects.extraDepth || 0)));
    const final = floors.at(-1), bosses = final.nodes.filter(node => node.type === 'BATTLE_BOSS');
    assert.equal(bosses.length, 1); assert.equal(bosses[0].stageId, expected.stageId);
    if (expected.floor === 6) assert.deepEqual(final.nodes.map(node => node.type), ['BATTLE_SHOP', 'REST',
      ...Array(1 + (mizukiVariationSpec(final.variation)?.effects.extraDepth || 0)).fill('BATTLE_NORMAL'), 'BATTLE_BOSS']);
    report.push({ endingId, floors: floors.length, finalStageId: bosses[0].stageId });
  }
  t.diagnostic('Route reachability only; this case does not claim to have naturally cleared all four endings: ' + JSON.stringify(report));
});
