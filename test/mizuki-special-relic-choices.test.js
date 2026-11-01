import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { normalizeMizukiDungeon } from '../server/modes/mizuki/exploration.js';
import { createMizukiRouteEvent } from '../server/modes/mizuki/RouteEvents.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const PROFILE = ['ro2_ending_1', 'ro2_ending_2', 'ro2_ending_3', 'ro2_ending_4'];
const IDS = { research: 'rogue_2_relic_curse_7', heart: 'rogue_2_relic_curse_8',
  memory: 'rogue_2_relic_curse_9', tree: 'rogue_2_relic_curse_10' };
const CHOICE = { research: 'choice_ro2_bossb1_1', memory: 'choice_ro2_bossb1_3',
  heart: 'choice_ro2_bossb2_6', tree: 'choice_ro2_bossc2_2' };
const copy = value => structuredClone(value);
const command = (m, message) => {
  const result = m.handle('p0', message);
  assert.equal(result.ok, true, JSON.stringify({ message, result }));
  return result;
};
function fixture(t, endingUnlocks = PROFILE) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [];
  const options = { roomCode: 'RELIC', seed: 619, hostId: 'p0', data: DATA, scheduler,
    endingUnlocks: [...endingUnlocks], seats: [{ playerId: 'p0', seat: 0, connected: true }],
    send() {}, broadcast() {}, onEnd() {}, log: { info() {}, warn() {}, error: (...args) => errors.push(args) } };
  const match = new MizukiMatch(options);
  t.after(() => { match.dispose(); scheduler.dispose(); assert.deepEqual(errors, []); });
  match.start(); command(match, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  command(match, { t: 'g.mizuki.strategy', bandId: 'band_amiya' });
  command(match, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  command(match, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  const player = match.players.get('p0'); player.hope = 200; player.hopeCapacity = 200;
  const offer = match.privateView('p0').mizuki.recruit.choices.find(value => value.available);
  assert.ok(offer); command(match, { t: 'g.mizuki.recruit', offerId: offer.offerId });
  skipMizukiRecruit(match); assert.equal(match.phase, PHASE.ROUTE); assert.equal(player.roster.length, 1);
  return { match, scheduler, options, player };
}
const floorOf = (m, number) => normalizeMizukiDungeon(m.explorationState.dungeon).floors
  .find(floor => floor.ordinaryFloor === number && !floor.isExtraRegion);
function pathTo(floor, id) {
  const visit = (node, path) => node.id === id ? [...path, id]
    : node.next.map(next => visit(floor.nodes.find(value => value.id === next), [...path, node.id])).find(Boolean);
  return floor.nodes.filter(node => !floor.edges.some(edge => edge.to === node.id)).map(node => visit(node, [])).find(Boolean);
}
// Only navigation is positioned by the fixture. Every grant, deduction, mutation,
// eligibility decision and ending milestone runs through the real Match command.
function position(m, number, predicate) {
  const party = m.expedition.partyFor('p0');
  m._withParty(party, () => {
    const floor = floorOf(m, number), target = floor.nodes.find(predicate); assert.ok(target, 'native floor node ' + number);
    const path = pathTo(floor, target.id); assert.ok(path);
    const trace = path.slice(0, -1);
    m.explorationState = { ...m.explorationState, zoneKey: floor.key, trace, cursor: trace.at(-1) || null };
    m.phase = PHASE.ROUTE; m.votes = {}; m.event = null; m.currentNode = null;
    m.route = m._routeOptions(); m.expedition.setContext(party.id, m.explorationState);
    assert.ok(m.route.some(node => node.id === target.id));
  });
}
function openEvent(m, eventNumber, number) {
  position(m, number, node => ['INCIDENT', 'UNKNOWN'].includes(node.type) && node.next.length);
  m._withParty(m.expedition.partyFor('p0'), () => {
    m.currentNode = m.route.find(node => ['INCIDENT', 'UNKNOWN'].includes(node.graphType));
    assert.ok(m.currentNode); m.phase = PHASE.EVENT; m.votes = {};
    m.event = { ...createMizukiRouteEvent(m.currentNode, { ...m._routeEventContext(), event: { state: {
      eventKey: 'prts_ro2_event_' + eventNumber, sceneIndex: 0, revision: 0, history: [], restUsed: [],
    } } }), votes: {} };
  });
  return m.privateView('p0').mizuki.event;
}
const option = (m, kind) => m.privateView('p0').mizuki.event.choices.find(choice => choice.id === CHOICE[kind]);
const choose = (m, kind) => command(m, { t: 'g.mizuki.event', choiceId: CHOICE[kind] });
function deny(m, kind) {
  assert.equal(option(m, kind)?.available, false);
  const before = { collectibles: copy(m.collectibles), progress: copy(m.endingProgress), light: m.light, roster: copy(m.order[0].roster) };
  assert.equal(m.handle('p0', { t: 'g.mizuki.event', choiceId: CHOICE[kind] }).error, 'BAD_TARGET');
  assert.deepEqual({ collectibles: m.collectibles, progress: m.endingProgress, light: m.light, roster: m.order[0].roster }, before);
}
function receipt(m, kind, floor, light) {
  assert.equal(m.collectibles.filter(id => id === IDS[kind]).length, 1);
  const records = m.endingProgress.choices.filter(value => value.choiceId === CHOICE[kind]);
  assert.equal(records.length, 1); assert.equal(records[0].relicId, IDS[kind]);
  assert.equal(records[0].floor, floor); assert.equal(records[0].light, light);
}
function routeIs(m, ending, stage) {
  const view = m.publicView().mizuki.endingRoute;
  assert.equal(view.endingId, 'ro2_ending_' + ending);
  assert.equal(view.sixthBossStageId, stage);
  const floors = normalizeMizukiDungeon(m.explorationState.dungeon).floors;
  assert.equal(floors.filter(floor => !floor.isExtraRegion).length, stage ? 6 : 5);
  if (stage) assert.ok(floors.at(-1).nodes.some(node => node.stageId === stage));
}
function restore(t, state, options) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const restored = new MizukiMatch({ ...options, scheduler });
  t.after(() => { restored.dispose(); scheduler.dispose(); });
  assert.equal(restored.restoreCheckpoint(copy(state)), true);
  return restored;
}

test('a new profile cannot choose research or memories and denied commands have no side effects', t => {
  const { match: m } = fixture(t, ['ro2_ending_1']); m.light = 0; openEvent(m, 42, 1);
  deny(m, 'research'); deny(m, 'memory');
});

for (const endingUnlocks of [['ro2_ending_1', 'ro2_ending_4'], ['ro2_ending_1', 'ro2_ending_2', 'ro2_ending_4']]) {
  test('opening event remains gated before the original quiet-era ending: ' + endingUnlocks.join('/'), t => {
    const { match: m } = fixture(t, endingUnlocks); m.light = 100; openEvent(m, 42, 1);
    deny(m, 'research'); deny(m, 'memory');
  });
}

test('an existing quiet-era-completed profile actually acquires research at zero light without immediate usage cost', t => {
  const { match: m, player } = fixture(t); m.light = 0; openEvent(m, 42, 1);
  assert.equal(option(m, 'research').available, true); assert.equal(option(m, 'memory').available, true);
  choose(m, 'research'); receipt(m, 'research', 1, 0);
  assert.equal(m.light, 0); assert.equal(player.roster[0].mutationId, null); routeIs(m, 1, null);
  openEvent(m, 42, 2); deny(m, 'research'); deny(m, 'memory');
});

for (const light of [0, 37, 100]) test('memories grant at ' + light + ' light, clamp its relic cost at zero and mutate one real recruit', t => {
  const { match: m, player } = fixture(t); m.light = light; openEvent(m, 42, 1);
  assert.equal(option(m, 'memory').available, true); choose(m, 'memory');
  receipt(m, 'memory', 1, light); assert.equal(m.light, 0);
  assert.equal(player.roster.filter(unit => unit.mutationId).length, 1); routeIs(m, 1, null);
  openEvent(m, 42, 2); deny(m, 'research'); deny(m, 'memory');
});

test('research and memories remain unavailable outside their original first three floors', t => {
  const { match: m } = fixture(t); m.light = 100; openEvent(m, 42, 4); deny(m, 'research'); deny(m, 'memory');
});

test('heart keeps its real research, floor and twenty-light requirements without using its fifty-light grant cost as entry cost', t => {
  const { match: m, player, options } = fixture(t); m.light = 100; openEvent(m, 43, 4); deny(m, 'heart');
  openEvent(m, 42, 1); choose(m, 'research'); receipt(m, 'research', 1, 100);
  assert.equal(m.light, 100, 'research charges light after battles, never on acquisition');
  openEvent(m, 43, 3); deny(m, 'heart');
  m.light = 19; openEvent(m, 43, 4); deny(m, 'heart');
  m.light = 20; openEvent(m, 43, 4); assert.equal(option(m, 'heart').available, true);
  choose(m, 'heart'); receipt(m, 'heart', 4, 20);
  assert.equal(m.light, 0); assert.equal(player.roster.filter(unit => unit.mutationId).length, 1); routeIs(m, 3, 'ro2_b_6');
  const restored = restore(t, m.exportCheckpoint(), options);
  assert.deepEqual(restored.endingProgress, m.endingProgress); assert.equal(restored.light, 0);
  assert.deepEqual(restored.players.get('p0').roster, player.roster); routeIs(restored, 3, 'ro2_b_6');
});

test('deep blue tree needs the memory milestone and original floors, grants once, then the real branch changes the sixth boss', t => {
  const { match: m, player, options } = fixture(t); m.light = 0; openEvent(m, 45, 2); deny(m, 'tree');
  openEvent(m, 42, 1); choose(m, 'memory'); receipt(m, 'memory', 1, 0);
  const mutated = copy(player.roster);
  openEvent(m, 45, 1); deny(m, 'tree'); openEvent(m, 45, 5); deny(m, 'tree');
  openEvent(m, 45, 2); assert.equal(option(m, 'tree').available, true); choose(m, 'tree');
  receipt(m, 'tree', 2, 0); assert.equal(m.light, 0); assert.deepEqual(player.roster, mutated); routeIs(m, 1, null);
  openEvent(m, 45, 3); deny(m, 'tree');
  m.light = 90; openEvent(m, 46, 4);
  const choiceId = 'choice_ro2_bossc3_1';
  assert.equal(m.privateView('p0').mizuki.event.choices.find(choice => choice.id === choiceId).available, true);
  command(m, { t: 'g.mizuki.event', choiceId });
  assert.ok(m.collectibles.includes('rogue_2_relic_grace_88')); routeIs(m, 4, 'ro2_b_7');
  const restored = restore(t, m.exportCheckpoint(), options);
  assert.deepEqual(restored.endingProgress, m.endingProgress); routeIs(restored, 4, 'ro2_b_7');
});

function settleNativeBattle(m, scheduler, { leak = false, tree = false } = {}) {
  if (m.floorState.pending) command(m, { t: 'g.mizuki.sanVote', id: m.floorState.pending.id, choice: 'accept' });
  skipMizukiRecruit(m);
  position(m, 1, node => node.type === 'BATTLE_NORMAL');
  assert.equal(m._currentVariationId(), 'rogue_2_variation_8', 'native region has no light multiplier or battle-entry life loss');
  const node = m.privateView('p0').mizuki.route.find(value => value.graphType === 'BATTLE_NORMAL' && value.available);
  assert.ok(node); command(m, { t: 'g.mizuki.route', nodeId: node.id });
  command(m, { t: 'g.mizuki.routeStart' }); assert.equal(m.phase, PHASE.PREP);
  command(m, { t: 'g.mizuki.ready', on: true }); assert.equal(m.phase, PHASE.COMBAT);
  const field = m.fields.get(m.players.get('p0').fieldId); assert.ok(field);
  field.engine.battle.start();
  const enemy = field.engine.battle.spawnEnemy('enemy_1007_slime', { route: field.setup.routes[0] }); assert.ok(enemy);
  if (tree) {
    const buff = enemy.buffs.find(value => value.key.includes('rogue_2_relic_curse_10'));
    assert.ok(buff, 'granted tree affects the actual spawned enemy: ' + JSON.stringify(enemy.buffs.map(value => ({key:value.key,mods:value.mods})))); assert.equal(buff.mods.aspd, 15);
  }
  if (leak) field.engine.battle.leak(enemy);
  field.engine.forceEnd('cleared'); scheduler.advance(1000 / 30 * 2);
  assert.equal(m.phase, PHASE.REWARD);
  assert.equal(m.order[0].battleOutcome.cleared, true);
  assert.equal(m.order[0].battleOutcome.perfect, !leak);
}

for (const initial of [3, 80]) test('research acquired through its original choice deducts five after a real battle and floors at zero from ' + initial, t => {
  const { match: m, scheduler } = fixture(t); m.light = 0; openEvent(m, 42, 1); choose(m, 'research');
  receipt(m, 'research', 1, 0); m.light = initial;
  settleNativeBattle(m, scheduler); assert.equal(m.light, Math.max(0, initial - 5));
});

for (const leak of [false, true]) test('tree acquired through its original choice buffs enemies and grants fifteen light only for a perfect real battle: leak=' + leak, t => {
  const { match: m, scheduler } = fixture(t); m.light = 0; openEvent(m, 42, 1); choose(m, 'memory');
  openEvent(m, 45, 2); choose(m, 'tree'); receipt(m, 'tree', 2, 0); m.light = 70;
  settleNativeBattle(m, scheduler, { leak, tree: true }); assert.equal(m.light, leak ? 65 : 85);
});
