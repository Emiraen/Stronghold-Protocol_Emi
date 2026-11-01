import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { normalizeMizukiDungeon } from '../server/modes/mizuki/exploration.js';
import { createMizukiRouteEvent } from '../server/modes/mizuki/RouteEvents.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';
import { MIZUKI_ENDING_RELICS, recordMizukiEndingChoice } from '../server/modes/mizuki/EndingProgression.js';
import { moveMizukiPrep, mizukiPrepView } from '../server/modes/mizuki/Prep.js';

const data = getData({ log: { info() {}, warn() {}, error() {} } });
const cmd = (m, id, msg) => { const result = m.handle(id, msg); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
function fixture(t, count) {
  const scheduler = new VirtualScheduler(), errors = [];
  const match = new MizukiMatch({ roomCode: 'SEND', seed: 619, hostId: 'p0', data, scheduler, cognition: {totalScore:0},
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    endingUnlocks: ['ro2_ending_1', 'ro2_ending_2', 'ro2_ending_3', 'ro2_ending_4'],
    send() {}, broadcast() {}, onEnd() {}, log: { info() {}, warn() {}, error: (...args) => errors.push(args) } });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  return { match, errors };
}
function enterRoute(m) {
  m.start();
  for (const p of m.order) cmd(m, p.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  for (const [i, p] of m.order.entries()) cmd(m, p.playerId, { t: 'g.mizuki.strategy', bandId: m.strategyOptions[i].bandId });
  for (const p of m.order) cmd(m, p.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  for (const p of m.order) cmd(m, p.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(m);
}
const floorOf = (state, n) => normalizeMizukiDungeon(state.dungeon).floors.find(f => f.ordinaryFloor === n && !f.isExtraRegion);

for (const count of [1, 2, 4]) for (const endingNo of [1, 2, 3, 4]) test(`${count} players: ending ${endingNo} final battle settles XP and goes directly to final results`, t => {
  const { match: m } = fixture(t, count); enterRoute(m);
  const party = m.expedition.partyFor('p0');
  const R = MIZUKI_ENDING_RELICS;
  const choices = endingNo === 1 ? [] : endingNo === 2 ? [['choice_ro2_bossa1_1', R.knight, 1]]
    : endingNo === 3 ? [['choice_ro2_bossb1_1', R.research, 1], ['choice_ro2_bossb2_6', R.heart, 4]]
    : [['choice_ro2_bossb1_3', R.memory, 1], ['choice_ro2_bossc3_1', R.determination, 4]];
  for (const [choiceId, relicId, floor] of choices) {
    const before = [...m.collectibles]; m.collectibles.push(relicId);
    m.endingProgress = recordMizukiEndingChoice(m.endingProgress, { choiceId, relicId, floor, light: 100,
      nodeId: 'fixture:' + choiceId, collectiblesBefore: before, collectibles: m.collectibles, endingUnlocks: m.endingUnlocks });
  }
  m._withParty(party, () => m._syncEndingRoutes());
  position(m, party, endingNo >= 3 ? 6 : 5, n => n.type === 'BATTLE_BOSS');
  m._withParty(party, () => {
    m.currentNode = m.route.find(n => n.type === 'boss'); assert.ok(m.currentNode);
    m._prepareFields(); m.lastResults = new Map();
    for (const f of m.fields.values()) f.engine.result = () => ({ outcome: 'victory', perPlayer: {}, leakedCount: 0 });
    const before = m.commander.totalExp;
    m._settlePartyBattle(new Map(m.order.map(p => [p.playerId, 0])));
    assert.ok(m.commander.totalExp >= before);
    assert.equal(m.ended, true); assert.equal(m.resultSummary.endingId, 'ro2_ending_' + endingNo);
    assert.equal(m.resultSummary.victory, true);
    for (const row of m.resultSummary.players) {
      assert.equal(row.mizuki.counters.bossBattles, 1);
      assert.equal(row.mizuki.counters.stepsPassed, 1);
      assert.equal(row.mizuki.counters.floorsPassed, 1);
      assert.equal(row.mizuki.breakdown.points.bossBattles, 30);
      assert.equal(row.mizuki.explorationScore, row.mizuki.breakdown.total);
    }
    for (const p of m.order) {
      assert.deepEqual(p.rewards, []); assert.equal(p.recruit, null);
      assert.equal(p.battleOutcome.perfect, true);
      assert.equal(m.commander.totalExp - before, p.battleOutcome.rewards.exp);
    }
  });
});

test('ordinary floor bosses still enter reward selection and personal deployment cap ignores carried capacity', t => {
  const { match: m } = fixture(t, 2); enterRoute(m);
  const party = m.expedition.partyFor('p0');
  position(m, party, 3, n => n.type === 'BATTLE_BOSS');
  m._withParty(party, () => {
    m.currentNode = m.route.find(n => n.type === 'boss'); m._prepareFields(); m.lastResults = new Map();
    const p = m.order[0], peer = m.order[1], cap = m._prepContext(p).deployLimit;
    assert.equal(cap, 8);
    m.squadCapacity = cap + 5; assert.equal(m._prepContext(p).deployLimit, cap);
    m.squadCapacity = 1; assert.equal(m._prepContext(p).deployLimit, cap);
    peer.roster.push({ uid: 99001 });
    peer.prep.board = [{ uid: 99001, row: 2, col: 2, dir: 'RIGHT' }];
    assert.equal(m._prepContext(p).fieldDeployCount, 0);
    peer.prep.board = []; peer.roster.pop();
    for (const f of m.fields.values()) f.engine.result = () => ({ outcome: 'victory', perPlayer: {}, leakedCount: 0 });
    m._settlePartyBattle(new Map(m.order.map(p => [p.playerId, 0])));
    assert.equal(m.phase, PHASE.REWARD); assert.equal(m.ended, false);
    assert.ok(p.rewards.some(r => r.type === 'recruitTicket'));
  });
});

test('shared boss board permits eight operators per doctor and only the equipped doctor gains a ninth slot', t => {
  const { match: m } = fixture(t, 2); enterRoute(m);
  const party = m.expedition.partyFor('p0');
  position(m, party, 3, node => node.type === 'BATTLE_BOSS');
  m._withParty(party, () => {
    m.currentNode = m.route.find(node => node.type === 'boss'); m.phase = PHASE.PREP;
    m.squadCapacity = 12;
    for (const player of m.order) {
      player.roster = Array.from({ length: 10 }, (_, i) => ({ uid: (player.seat + 1) * 10000 + i,
        chessId: 'chess_char_1_02_a', name: 'test', position: 'MELEE', items: [] }));
      player.lineup = player.roster.map(unit => unit.uid); player.prep = null;
    }
    m._prepareFields();
    const place = (player, index) => {
      const context = m._prepContext(player), uid = player.roster[index].uid;
      const legal = mizukiPrepView(player, context).legalTiles[uid];
      const target = legal.find(([row, col]) => !player.prep.board.some(piece => piece.row === row && piece.col === col));
      assert.ok(target);
      return moveMizukiPrep(player, uid, { area: 'board', row: target[0], col: target[1] }, 'RIGHT', context);
    };
    for (const player of m.order) for (let i = 0; i < 8; i++) assert.equal(place(player, i).ok, true);
    for (const player of m.order) {
      assert.equal(m._prepContext(player).fieldDeployCount, 8);
      const context = m._prepContext(player), index = context.grid.tiles.findIndex((tile, index) => {
        const row = Math.floor(index / 21), col = index % 21;
        return context.grid.inRect(row, col) && tile?.build === 'MELEE'
          && !context.otherOccupied.has(row + ',' + col) && !player.prep.board.some(piece => piece.row === row && piece.col === col);
      });
      assert.ok(index >= 0);
      assert.ok(mizukiPrepView(player, context).legalTiles[player.roster[8].uid]
        .every(([row, col]) => player.prep.board.some(piece => piece.row === row && piece.col === col)));
      assert.equal(moveMizukiPrep(player, player.roster[8].uid, { area: 'board', row: Math.floor(index / 21), col: index % 21 }, 'RIGHT', context).error, 'BOARD_FULL');
    }
    m.order[0].equipmentDeployCapBonus = 1; m._prepareFields();
    assert.equal(m._prepContext(m.order[0]).deployLimit, 9);
    assert.equal(m._prepContext(m.order[1]).deployLimit, 8);
    assert.equal(place(m.order[0], 8).ok, true);
    m.order[0].equipmentDeployCapBonus = 30; m._prepareFields();
    assert.equal(m._prepContext(m.order[0]).deployLimit, 9);
    m.squadCapacity = 1;
    assert.equal(m._prepContext(m.order[0]).deployLimit, 9);
    assert.equal(m._prepContext(m.order[1]).deployLimit, 8);
    m._startBattle();
    const engine = [...m.fields.values()][0].engine; engine.step();
    const view = engine.snapshot();
    assert.deepEqual(view.deployLimits, { p0: 9, p1: 8 });
    assert.deepEqual(view.deploySlotsUsedByPlayer, { p0: 9, p1: 8 });
  });
});
function pathTo(floor, id) {
  const visit = (node, path) => node.id === id ? [...path, id]
    : node.next.map(next => visit(floor.nodes.find(n => n.id === next), [...path, node.id])).find(Boolean);
  return floor.nodes.filter(node => !floor.edges.some(e => e.to === node.id)).map(node => visit(node, [])).find(Boolean);
}
// Jump only fixture navigation to native graph positions. Milestones are still
// acquired by actual g.mizuki.event commands with original eligibility/effects.
function position(m, party, floorNo, predicate, { complete = false } = {}) {
  m._withParty(party, () => {
    const floor = floorOf(m.explorationState, floorNo), target = floor.nodes.find(predicate);
    assert.ok(target, `native fixture node on floor ${floorNo}`);
    const path = pathTo(floor, target.id); assert.ok(path);
    const trace = complete ? path : path.slice(0, -1);
    m.explorationState = { ...m.explorationState, zoneKey: floor.key, trace, cursor: trace.at(-1) || null };
    m.currentNode = null; m.event = null; m.votes = {}; m.phase = PHASE.ROUTE;
    m.route = m._routeOptions();
    m.expedition.setContext(party.id, m.explorationState);
  });
}
function split(m, childId) {
  const party = m.expedition.partyFor('p0');
  position(m, party, 1, n => n.next.length >= 2, { complete: true });
  const choices = m.privateView('p0').mizuki.route;
  assert.ok(choices.length >= 2);
  for (const p of m.order) cmd(m, p.playerId, { t: 'g.mizuki.route', nodeId: choices[p.playerId === childId ? 1 : 0].id });
  const request = cmd(m, childId, { t: 'g.mizuki.splitRequest', nodeId: choices[1].id }).request;
  cmd(m, 'p0', { t: 'g.mizuki.splitDecide', requestId: request.id, approve: true });
  const child = m.expedition.partyFor(childId); child.approvedNodeId = null;
  return { leader: m.expedition.partyFor('p0'), child };
}
function waitAtFloor(m, party, floorNo) {
  position(m, party, floorNo, n => !n.next.length, { complete: true });
  m._withParty(party, () => { assert.equal(m._arriveParty('floor', m.explorationState.zoneKey).ok, true); });
}
function milestone(m, party, playerId, floorNo, eventNo, choiceId) {
  position(m, party, floorNo, n => ['INCIDENT', 'UNKNOWN'].includes(n.type) && n.next.length);
  m._withParty(party, () => {
    m.currentNode = m.route.find(n => n.graphType === 'INCIDENT' || n.graphType === 'UNKNOWN');
    assert.ok(m.currentNode);
    m.phase = PHASE.EVENT;
    m.event = { ...createMizukiRouteEvent(m.currentNode, { ...m._routeEventContext(), event: { state: {
      eventKey: 'prts_ro2_event_' + eventNo, sceneIndex: 0, revision: 0, history: [], restUsed: [],
    } } }), votes: {} };
    m.votes = {};
  });
  const option = m.privateView(playerId).mizuki.event.choices.find(choice => choice.id === choiceId);
  assert.ok(option && option.available !== false);
  cmd(m, playerId, { t: 'g.mizuki.event', choiceId });
}
function assertShared(m, expected) {
  assert.equal(m.publicView().mizuki.endingRoute.endingId, expected);
  for (const party of m.expedition.parties.values()) {
    const state = m.partyStates.get(party.id);
    const canonical = value => normalizeMizukiDungeon(value).dungeon;
    assert.deepEqual(canonical(state.explorationState.dungeon), canonical(party.context.dungeon));
    const floors = normalizeMizukiDungeon(state.explorationState.dungeon).floors;
    const expectedBoss = { ro2_ending_1: 'ro2_b_4', ro2_ending_2: 'ro2_b_5', ro2_ending_3: 'ro2_b_6', ro2_ending_4: 'ro2_b_7' }[expected];
    assert.equal(floors.length, ['ro2_ending_3', 'ro2_ending_4'].includes(expected) ? 6 : 5);
    assert.ok(floors.at(-1).nodes.some(n => n.stageId === expectedBoss));
    for (const id of party.memberIds) assert.deepEqual(canonical(m.expedition.memberContexts[id].dungeon), canonical(state.explorationState.dungeon));
  }
}

for (const count of [2, 4]) for (const ending of [2, 3, 4]) {
  test(`${count} players: child branch ending ${ending} replaces the entire expedition route and survives restore`, t => {
    const { match: m, errors } = fixture(t, count); enterRoute(m);
    const childId = 'p' + (count - 1), { leader, child } = split(m, childId);
    waitAtFloor(m, leader, 1);
    if (ending === 2) milestone(m, child, childId, 1, 40, 'choice_ro2_bossa1_1');
    else {
      milestone(m, child, childId, 1, 42, ending === 3 ? 'choice_ro2_bossb1_1' : 'choice_ro2_bossb1_3');
      // Complete only the waiting fixture transition, then position both native
      // branches on IV to exercise the original follow-up floor requirements.
      m.expedition.barrier = null; leader.rendezvous = null;
      waitAtFloor(m, leader, 4); m.light = 100;
      milestone(m, child, childId, 4, ending === 3 ? 43 : 46, ending === 3 ? 'choice_ro2_bossb2_6' : 'choice_ro2_bossc3_1');
    }
    const expected = 'ro2_ending_' + ending; assertShared(m, expected);
    // Re-entering another branch scope must not restore its old ending.
    m._withParty(leader, () => { m._syncEndingRoutes(); }); assertShared(m, expected);
    const checkpoint = m.exportCheckpoint(); assert.ok(checkpoint);
    const restored = fixture(t, count).match;
    assert.equal(restored.restoreCheckpoint(JSON.parse(JSON.stringify(checkpoint))), true);
    assertShared(restored, expected); assert.deepEqual(errors, []);
  });
}
