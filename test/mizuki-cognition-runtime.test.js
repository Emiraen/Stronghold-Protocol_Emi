import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { MIZUKI_SQUAD_TIERS } from '../shared/mizuki-squads.js';
import { normalizeCognition } from '../server/modes/mizuki/Cognition.js';
import { createMizukiExplorationState } from '../server/modes/mizuki/exploration.js';
import { createMizukiRouteEvent, planMizukiRouteEventChoice } from '../server/modes/mizuki/RouteEvents.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';
import { createMizukiSanCheck } from '../server/modes/mizuki/NativeMutations.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const FULL = normalizeCognition({ totalScore: 22400 });
const EMPTY = normalizeCognition({ totalScore: 0 });
const FRAME = 1000 / 30;
const DUNGEON = { zones: [{ id: 'zone_1', nodes: [
  { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [{ x: 1, y: 0 }] },
  { pos: { x: 1, y: 0 }, type: 'BATTLE_ELITE', stage: 'ro2_e_1_1', next: [] },
] }] };

function fixture(t, cognition = EMPTY, { count = 1, dungeon = DUNGEON, seed = 619 } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [];
  const options = { scheduler, data: DATA, roomCode: 'COGN', seed, ...(cognition === null ? {} : { cognition: structuredClone(cognition) }),
    hostId: 'p0', seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })), dungeon: structuredClone(dungeon),
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) }, send() {}, broadcast() {}, onEnd() {} };
  const match = new MizukiMatch(options);
  t.after(() => { match.dispose(); scheduler.dispose(); });
  return { match, scheduler, errors, options };
}
const command = (match, message) => {
  const result = match.handle('p0', message);
  assert.equal(result.ok, true, JSON.stringify({ message, result }));
  return result;
};
function squad(match, id = 'rogue_2_band_1') {
  match.start(); command(match, { t: 'g.mizuki.squad', squadId: id });
  assert.equal(match.phase, PHASE.STRATEGY);
}
function route(match, id = 'rogue_2_band_1', operatorId) {
  squad(match, id);
  command(match, { t: 'g.mizuki.strategy', bandId: 'band_amiya' });
  command(match, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  command(match, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  const choices = match.privateView('p0').mizuki.recruit.choices;
  const choice = operatorId ? choices.find(value => value.operatorId === operatorId && value.available)
    : choices.find(value => value.available && value.hopeCost === 0) || choices.find(value => value.available);
  assert.ok(choice, 'an original voucher offers the recruit through the production command');
  command(match, { t: 'g.mizuki.recruit', offerId: choice.offerId });
  skipMizukiRecruit(match); assert.equal(match.phase, PHASE.ROUTE);
  return match.order[0].roster[0];
}
function prep(match) {
  const node = match.privateView('p0').mizuki.route.find(value => value.available);
  assert.ok(node); command(match, { t: 'g.mizuki.route', nodeId: node.id });
  command(match, { t: 'g.mizuki.routeStart' }); assert.equal(match.phase, PHASE.PREP);
  return match.fields.get(match.players.get('p0').fieldId);
}
function combat(match) {
  command(match, { t: 'g.mizuki.ready', on: true });
  assert.equal(match.phase, PHASE.COMBAT);
  return match.fields.get(match.players.get('p0').fieldId);
}
function settle(match, scheduler) {
  for (const field of match.fields.values()) field.engine.forceEnd('cleared');
  scheduler.advance(FRAME * 2); assert.equal(match.phase, PHASE.REWARD);
}
function restored(t, options, doc, cognition) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const match = new MizukiMatch({ ...options, scheduler, cognition: structuredClone(cognition) });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  assert.equal(match.restoreCheckpoint(structuredClone(doc)), true);
  return match;
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, actual + ' != ' + expected);

test('empty cognition caps actual new-run commander progression at ten and publishes no next threshold', t => {
  const { match } = fixture(t); squad(match);
  match._gainCommandExperience(9999);
  assert.equal(match.commander.level, 10);
  assert.equal(match.publicView().mizuki.commander.nextLevelExp, null);
});

test('default full cognition grants original starting resources once and keeps the ordinary squad life bonus', t => {
  const control = fixture(t).match, full = fixture(t, null).match;
  assert.deepEqual(full.cognition, FULL);
  assert.equal(full.cognition.unlockedNodeIds.length, 58);
  const beforeControl = control.order[0], beforeFull = full.order[0];
  assert.equal(beforeFull.gold - beforeControl.gold, 15);
  assert.equal(beforeFull.maxLife - beforeControl.maxLife, 3);
  assert.equal(beforeFull.life - beforeControl.life, 3);
  assert.equal(full.dice - control.dice, 2); assert.equal(full.key - control.key, 2);
  assert.equal(full.squadCapacity - control.squadCapacity, 1);
  const plainLife = beforeControl.maxLife, fullLife = beforeFull.maxLife;
  squad(control); squad(full);
  assert.equal(control.order[0].maxLife, plainLife + 2);
  assert.equal(full.order[0].maxLife, fullLife + 2);
  assert.equal(full.selectedSquad.id, 'rogue_2_band_1');
});

test('default base squad cards resolve upgraded cognition effects and the eleventh commander level', t => {
  for (const [base, tier] of [[11, 14], [15, 18], [19, 22]]) {
    const { match } = fixture(t, null); squad(match, 'rogue_2_band_' + base);
    assert.equal(match.selectedSquad.id, 'rogue_2_band_' + tier);
    assert.deepEqual(match.selectedSquad.effects, MIZUKI_SQUAD_TIERS.find(value => value.id === match.selectedSquad.id).effects);
    if (base === 19) {
      match._gainCommandExperience(9999); assert.equal(match.commander.level, 11);
      assert.equal(match.publicView().mizuki.commander.nextLevelExp, null);
    }
  }
});

test('default full cognition multiplies actual settled battle experience by 1.4', t => {
  const plain = fixture(t), full = fixture(t, null);
  for (const f of [plain, full]) { route(f.match); prep(f.match); combat(f.match); settle(f.match, f.scheduler); }
  assert.equal(plain.match.order[0].battleOutcome.rewards.exp, 10);
  assert.equal(full.match.order[0].battleOutcome.rewards.exp, 14);
  assert.equal(full.match.commander.totalExp, 14);
  assert.equal(full.match.commander.level, 2);
  assert.deepEqual(full.errors, []); assert.deepEqual(plain.errors, []);
});

test('perfect battle above eight life grants the cognition shield while a real leak does not', t => {
  for (const leak of [false, true]) {
    const f = fixture(t, FULL); route(f.match);
    f.match._collectibleResource('rogue_2_hpmax', 20);
    f.match._collectibleResource('rogue_2_hp', 20);
    prep(f.match); const field = combat(f.match), player = f.match.order[0];
    assert.ok(player.life > 9); const before = player.shield;
    if (leak) {
      field.engine.battle.start();
      const enemy = field.engine.battle.spawnEnemy('enemy_1007_slime', { route: field.setup.routes[0] });
      assert.ok(enemy); field.engine.battle.leak(enemy);
    }
    settle(f.match, f.scheduler);
    assert.equal(player.shield, leak ? Math.max(0, before - 1) : before + 1, 'a real leak never earns a perfect shield');
    assert.deepEqual(f.errors, []);
  }
});

test('checkpoint freezes cognition and resolved squad effects across changed player profiles', t => {
  const f = fixture(t, null); route(f.match, 'rogue_2_band_19');
  const doc = f.match.exportCheckpoint(); assert.equal(doc.mizuki.cognitionVersion, 1);
  const loaded = restored(t, f.options, doc, EMPTY);
  assert.deepEqual(loaded.cognition, f.match.cognition);
  assert.deepEqual(loaded.cognitionMods, f.match.cognitionMods);
  assert.equal(loaded.selectedSquad.id, 'rogue_2_band_22');
  assert.deepEqual(loaded.squadMods, f.match.squadMods);
  assert.equal(loaded.squadCapacity, f.match.squadCapacity);
  loaded._gainCommandExperience(9999); assert.equal(loaded.commander.level, 11);
  const plain = fixture(t); route(plain.match);
  const plainLoaded = restored(t, plain.options, plain.match.exportCheckpoint(), FULL);
  assert.deepEqual(plainLoaded.cognition, plain.match.cognition);
  assert.deepEqual(plainLoaded.squadMods, plain.match.squadMods);
  plainLoaded._gainCommandExperience(9999); assert.equal(plainLoaded.commander.level, 10);
});

test('old checkpoint without cognition version retains the legacy level eleven cap', t => {
  const f = fixture(t); route(f.match);
  const doc = f.match.exportCheckpoint();
  delete doc.mizuki.cognitionVersion; delete doc.mizuki.cognition; delete doc.mizuki.baseSquadId;
  const loaded = restored(t, f.options, doc, FULL);
  loaded._gainCommandExperience(9999); assert.equal(loaded.commander.level, 11);
  assert.equal(loaded.publicView().mizuki.commander.nextLevelExp, null);
});

test('real recruited and deployed units receive default cognition attack, defense, and health bonuses', t => {
  const plain = fixture(t), full = fixture(t, null);
  const normalCard = route(plain.match), boostedCard = route(full.match, 'rogue_2_band_1', normalCard.operatorId);
  assert.equal(boostedCard.operatorId, normalCard.operatorId);
  const units = [];
  for (const f of [plain, full]) {
    prep(f.match);
    const card = f.match.order[0].roster[0], view = f.match.privateView('p0').mizuki.prep;
    assert.equal(view.deployCap, f === full ? 9 : 8);
    const tile = view.legalTiles[card.uid][0];
    assert.ok(tile);
    const [row, col] = tile;
    command(f.match, { t: 'g.mizuki.move', uid: card.uid, to: { area: 'board', row, col }, dir: 'RIGHT' });
    const running = combat(f.match); running.engine.step(1 / 30);
    const actual = running.engine.battle.allyUnits.find(unit => unit.uid === card.uid);
    assert.ok(actual.alive && actual.deployed); units.push(actual);
  }
  close(units[1].s.atk - units[0].s.atk, units[0].base.atk * .2);
  close(units[1].s.def - units[0].s.def, units[0].base.def * .3);
  close(units[1].s.maxHp - units[0].s.maxHp, units[0].base.maxHp * .3);
});

test('upgraded resourceful squad provides fifteen actual battle die deployments through the existing stock', t => {
  const f = fixture(t, FULL); route(f.match, 'rogue_2_band_15');
  assert.equal(f.match.selectedSquad.id, 'rogue_2_band_18');
  f.match._collectibleResource('rogue_2_dice', 20);
  prep(f.match); const field = combat(f.match); field.engine.step(1 / 30);
  const stock = field.engine.activeTools.snapshot().p0.find(tool => tool.toolId.startsWith('rogue_2_dice_battle'));
  assert.ok(stock); assert.equal(stock.count, 15);
  const before = f.match.dice;
  for (let use = 0; use < 15; use++) {
    const tile = field.engine.snapshot().geometry.tiles.find(value => !value.obstacle && value.build !== 'NONE'
      && !['start', 'end'].includes(value.special) && !field.engine.battle.unitAt(value.row, value.col));
    assert.ok(tile);
    command(f.match, { t: 'g.mizuki.deploy', battleId: field.battleId, uid: stock.uid, row: tile.row, col: tile.col, dir: 'RIGHT' });
    if (use < 14) {
      field.engine.battle.time += 20; field.engine.battle.getPlayer('p0').dp += 3;
      field.engine.battle.emit('tick', { dt: 20 });
    }
  }
  assert.equal(f.match.dice, before - 15);
  assert.equal(field.engine.activeTools.snapshot().p0.some(tool => tool.uid === stock.uid), false);
});

test('cognition permits one actual SAN reroll per run and preserves its spent state across floors and checkpoint', t => {
  const dungeon = { zones: Object.fromEntries([['one', 'zone_1'], ['two', 'zone_2'], ['three', 'zone_3']]
    .map(([key, id]) => [key, { id, zoneType: 'NORMAL', nodes: [
      { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
    ] }])) };
  for (const cognition of [EMPTY, FULL]) {
    const f = fixture(t, cognition, { dungeon }); route(f.match);
    const enter = (match, key) => match._withParty(match.expedition.partyFor('p0'), () => {
      match.explorationState = { ...createMizukiExplorationState(dungeon), zoneKey: key };
      match._enterRoute();
    });
    f.match._changeLight(-100); enter(f.match, 'two');
    const first = f.match.floorState.pending; assert.ok(first?.check.canReroll);
    const before = f.match.dice;
    const roll = f.match.handle('p0', { t: 'g.mizuki.sanVote', id: first.id, choice: 'reroll' });
    if (cognition === EMPTY) {
      assert.notEqual(roll.ok, true); assert.equal(f.match.dice, before); continue;
    }
    assert.equal(roll.ok, true); assert.equal(f.match.dice, before - 1); assert.equal(f.match.sanRerollsUsed, 1);
    const pending = f.match.floorState.pending; assert.notEqual(pending.id, first.id);
    assert.notEqual(f.match.handle('p0', { t: 'g.mizuki.sanVote', id: pending.id, choice: 'reroll' }).ok, true);
    const loaded = restored(t, f.options, f.match.exportCheckpoint(), EMPTY);
    assert.equal(loaded.sanRerollsUsed, 1);
    command(loaded, { t: 'g.mizuki.sanVote', id: loaded.floorState.pending.id, choice: 'accept' });
    skipMizukiRecruit(loaded); enter(loaded, 'three');
    assert.ok(loaded.floorState.pending);
    assert.notEqual(loaded.handle('p0', { t: 'g.mizuki.sanVote', id: loaded.floorState.pending.id, choice: 'reroll' }).ok, true);
    assert.equal(loaded.dice, before - 1);
  }
});

test('every online member can reroll immediately for one die without waiting for teammates', t => {
  for (const actor of ['p0', 'p1', 'p2', 'p3']) {
    const f = fixture(t, FULL, { count: 4 });
    f.match.start();
    f.match.phase = PHASE.ROUTE;
    const members = f.match.order.map(player => player.playerId);
    const check = createMizukiSanCheck({ light: 0, diceId: 'rogue_2_dice_1', grade: f.match.difficultyGrade,
      zoneId: 'direct-reroll', rng: () => 0, players: f.match.order, roll: 1 });
    f.match.floorState.pending = f.match._pendingSan(check, members, 0);
    f.match.dice = 3;
    const id = f.match.floorState.pending.id;
    assert.deepEqual(f.match.handle(actor, { t: 'g.mizuki.sanVote', id, choice: 'reroll' }), { ok: true });
    assert.equal(f.match.dice, 2);
    assert.notEqual(f.match.floorState.pending.id, id);
    assert.deepEqual(f.match.floorState.pending.votes, {});
    assert.notEqual(f.match.handle(actor, { t: 'g.mizuki.sanVote', id, choice: 'reroll' }).ok, true);
    assert.equal(f.match.dice, 2, 'replayed old requests cannot spend again');
  }
});

test('only cognition-upgraded people-first squad actually receives a second safe-corner reward', t => {
  const dungeon = { zones: [{ id: 'zone_1', nodes: [
    { pos: { x: 0, y: 0 }, type: 'REST', next: [{ x: 1, y: 0 }] },
    { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
  ] }] };
  for (const cognition of [EMPTY, FULL]) {
    const f = fixture(t, cognition, { dungeon }); route(f.match, 'rogue_2_band_19');
    const match = f.match, before = match.order[0].maxLife;
    command(match, { t: 'g.mizuki.route', nodeId: match.privateView('p0').mizuki.route.find(value => value.available).id });
    command(match, { t: 'g.mizuki.routeStart' }); assert.equal(match.phase, PHASE.EVENT);
    command(match, { t: 'g.mizuki.event', choiceId: 'choice_ro2_rest_1' });
    assert.equal(match.order[0].maxLife, before + 3);
    const reuse = match.event.choices.find(value => value.id === 'choice_ro2_rest_7');
    if (cognition === EMPTY) { assert.equal(reuse, undefined); continue; }
    assert.ok(reuse?.available); command(match, { t: 'g.mizuki.event', choiceId: reuse.id });
    assert.equal(match.event.choices.some(value => value.id === 'choice_ro2_rest_1'), false);
    const second = match.event.choices.find(value => value.available && value.id !== 'choice_ro2_rest_2');
    assert.ok(second);
    const resources = { hope: match.order[0].hope, dice: match.dice, carry: match.squadCapacity, light: match.light };
    command(match, { t: 'g.mizuki.event', choiceId: second.id });
    const changed = { hope: match.order[0].hope, dice: match.dice, carry: match.squadCapacity, light: match.light };
    assert.notDeepEqual(changed, resources, 'the second original choice applies its actual resource reward');
    assert.equal(match.event.choices.some(value => value.id === 'choice_ro2_rest_7'), false);
  }
});

function collectBattleRewards(match) {
  for (let guard = 0; guard < 24 && match.phase === PHASE.REWARD; guard++) {
    const rewards = match.privateView('p0').mizuki.rewards;
    const reward = rewards.find(value => !value.selected && !rewards.some(selected => selected.group === value.group && selected.selected));
    assert.ok(reward); command(match, { t: 'g.mizuki.reward', rewardId: reward.id });
  }
  skipMizukiRecruit(match);
}

test('real completed normal and elite battles score a floor and retain recruits after sale and checkpoint', t => {
  const f = fixture(t); const card = route(f.match);
  assert.equal(f.match._scoreResult('p0').counters.recruits, 1);
  prep(f.match); combat(f.match); settle(f.match, f.scheduler); collectBattleRewards(f.match);
  assert.equal(f.match.phase, PHASE.ROUTE);
  const first = f.match._scoreResult('p0');
  assert.equal(first.counters.stepsPassed, 1); assert.equal(first.counters.normalBattles, 1);
  assert.equal(first.counters.eliteBattles, 0); assert.equal(first.counters.floorsPassed, 0);
  command(f.match, { t: 'g.mizuki.dismiss', uid: card.uid, requestId: 'cognition-score-sale' });
  assert.equal(f.match.order[0].roster.length, 0);
  assert.equal(f.match._scoreResult('p0').counters.recruits, 1);
  const loaded = restored(t, f.options, f.match.exportCheckpoint(), FULL);
  assert.deepEqual(loaded._scoreResult('p0'), first);
  const checkpoint = loaded.exportCheckpoint();
  const loadedAgain = restored(t, f.options, checkpoint, FULL);
  assert.deepEqual(loadedAgain._scoreResult('p0'), first);
  prep(loadedAgain); combat(loadedAgain);
  for (const field of loadedAgain.fields.values()) field.engine.forceEnd('cleared');
  loadedAgain.sched.advance(FRAME * 2); assert.equal(loadedAgain.phase, PHASE.REWARD);
  collectBattleRewards(loadedAgain);
  assert.equal(loadedAgain._scoreResult('p0').counters.floorsPassed, 1);
  loadedAgain._finish(false, 'cognition-completed-score');
  const score = loadedAgain.resultSummary.players.find(value => value.playerId === 'p0').mizuki;
  assert.equal(score.counters.stepsPassed, 2); assert.equal(score.counters.normalBattles, 1);
  assert.equal(score.counters.eliteBattles, 1); assert.equal(score.counters.floorsPassed, 1);
  assert.equal(score.counters.recruits, 1); assert.ok(score.counters.itemsGained >= 1);
  assert.equal(score.explorationScore, 30 + 2 + 10 + 20 + 2 + score.counters.itemsGained * 5);
});

test('multiplayer result reports each player actual recruitment score separately', t => {
  const f = fixture(t, EMPTY, { count: 2 }), match = f.match; match.start();
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' }).ok, true);
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.strategy', bandId: player.playerId === 'p0' ? 'band_amiya' : 'band_cathy' }).ok, true);
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' }).ok, true);
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' }).ok, true);
  const offer = match.privateView('p0').mizuki.recruit.choices.find(value => value.available);
  assert.ok(offer); command(match, { t: 'g.mizuki.recruit', offerId: offer.offerId });
  skipMizukiRecruit(match); assert.equal(match.phase, PHASE.ROUTE); match._finish(false, 'cognition-personal-score');
  const scores = Object.fromEntries(match.resultSummary.players.map(value => [value.playerId, value.mizuki]));
  assert.equal(scores.p0.counters.recruits, 1); assert.equal(scores.p1.counters.recruits, 0);
  assert.equal(scores.p0.explorationScore - scores.p1.explorationScore, 2);
});

function routeWithoutRecruits(match) {
  match.start();
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' }).ok, true);
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.strategy',
    bandId: player.playerId === 'p0' ? 'band_amiya' : 'band_cathy' }).ok, true);
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' }).ok, true);
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' }).ok, true);
  skipMizukiRecruit(match); assert.equal(match.phase, PHASE.ROUTE);
}
const WISH_DUNGEON = { zones: [{ id: 'zone_1', nodes: [
  { pos: { x: 0, y: 0 }, type: 'WISH', next: [{ x: 1, y: 0 }] },
  { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
] }] };

test('open native dice choices refresh with shared resources and submit through the real command', t => {
  const f = fixture(t, FULL, { count: 2, dungeon: { zones: [{ id: 'zone_1', nodes: [
    ...[0, 1].map(y => ({ pos: { x: 0, y }, type: 'INCIDENT', next: [{ x: 1, y: 0 }] })),
    { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
  ] }] } });
  routeWithoutRecruits(f.match);
  const [first, second] = f.match.route;
  const split = f.match.handle('p1', { t: 'g.mizuki.splitRequest', nodeId: second.id }); assert.equal(split.ok, true);
  command(f.match, { t: 'g.mizuki.splitDecide', requestId: split.request.id, approve: true });
  command(f.match, { t: 'g.mizuki.route', nodeId: first.id });
  assert.equal(f.match.handle('p1', { t: 'g.mizuki.route', nodeId: second.id }).ok, true);
  command(f.match, { t: 'g.mizuki.routeStart' });
  f.match.dice = 0;
  const party = f.match.expedition.partyFor('p1');
  f.match._withParty(party, () => {
    f.match.event = { ...createMizukiRouteEvent(f.match.currentNode, { ...f.match._routeEventContext(),
      event: { state: { eventKey: 'prts_ro2_event_29', sceneIndex: 1, revision: 1, history: ['choice_ro2_king_1'], restUsed: [] } } }), votes: {} };
  });
  const state = f.match.partyStates.get(party.id), stored = structuredClone(state.event);
  const choice = view => view.event.choices.find(value => value.id === 'choice_ro2_king_3');
  assert.equal(choice(f.match.privateView('p1').mizuki).available, false);
  f.match.dice = 1;
  assert.equal(choice(f.match.privateView('p1').mizuki).available, true, 'new team die immediately enables the native wager');
  assert.deepEqual(state.event, stored, 'publishing a refreshed choice cannot rewrite the pending scene');
  f.match.dice = 0;
  assert.equal(choice(f.match.privateView('p1').mizuki).available, false, 'spending the shared die immediately disables the wager');
  assert.notEqual(f.match.handle('p1', { t: 'g.mizuki.event', choiceId: 'choice_ro2_king_3' }).ok, true);
  assert.deepEqual(state.event, stored);
  f.match.dice = 1;
  const result = f.match.handle('p1', { t: 'g.mizuki.event', choiceId: 'choice_ro2_king_3' });
  assert.equal(result.ok, true); assert.equal(f.match.dice, 0, 'native event consumes exactly one team die');
  assert.notDeepEqual(state.event, stored, 'the real request advances the native scene');
});

test('wish roll one waits for the original decision, freezes it in checkpoint, and settles accept or reroll once', t => {
  for (const decision of ['accept', 'reroll']) {
    const f = fixture(t, FULL, { seed: 23, dungeon: WISH_DUNGEON }); routeWithoutRecruits(f.match);
    command(f.match, { t: 'g.mizuki.route', nodeId: f.match.privateView('p0').mizuki.route.find(value => value.available).id });
    command(f.match, { t: 'g.mizuki.routeStart' }); assert.equal(f.match.phase, PHASE.EVENT);
    const chosen = f.match.event.choices[0], before = [...f.match.collectibles], diceBefore = f.match.dice;
    const expected = planMizukiRouteEventChoice(f.match.currentNode, { ...f.match._routeEventContext(), choiceId: chosen.id, wishDecision: decision });
    assert.equal(expected.ok, true);
    command(f.match, { t: 'g.mizuki.event', choiceId: chosen.id });
    assert.equal(f.match.event.state.pendingWish.choiceId, chosen.id);
    assert.equal(f.match.event.state.pendingWish.roll, 1);
    assert.deepEqual(f.match.collectibles, before); assert.equal(f.match.dice, diceBefore);
    const check = f.match.privateView('p0').mizuki.sanCheck; assert.ok(check?.id.startsWith('mzwish:'));
    const another = f.match.event.choices.find(value => value.id !== chosen.id); assert.ok(another);
    assert.notEqual(f.match.handle('p0', { t: 'g.mizuki.event', choiceId: another.id }).ok, true);
    assert.equal(f.match.event.state.pendingWish.choiceId, chosen.id);
    const loaded = restored(t, f.options, f.match.exportCheckpoint(), EMPTY);
    assert.deepEqual(loaded.event.state.pendingWish, f.match.event.state.pendingWish);
    assert.equal(loaded.privateView('p0').mizuki.sanCheck.id, check.id);
    command(loaded, { t: 'g.mizuki.sanVote', id: check.id, choice: decision });
    assert.deepEqual(loaded.collectibles, [...before, ...expected.relics]);
    assert.equal(loaded.dice, diceBefore - (decision === 'reroll' ? 1 : 0));
    assert.equal(loaded.event?.state.pendingWish, undefined);
    assert.notEqual(loaded.handle('p0', { t: 'g.mizuki.sanVote', id: check.id, choice: decision }).ok, true);
    assert.deepEqual(loaded.collectibles, [...before, ...expected.relics]);
    const again = restored(t, f.options, loaded.exportCheckpoint(), EMPTY);
    assert.deepEqual(again.collectibles, loaded.collectibles); assert.equal(again.dice, loaded.dice);
    assert.notEqual(again.handle('p0', { t: 'g.mizuki.sanVote', id: check.id, choice: 'reroll' }).ok, true);
    assert.deepEqual(again.collectibles, loaded.collectibles);
  }
});

test('parallel wish decisions and one reroll belong to their own parties while sharing team dice', t => {
  const dungeon = { zones: [{ id: 'zone_1', nodes: [
    ...[0, 1].map(y => ({ pos: { x: 0, y }, type: 'WISH', next: [{ x: 1, y: 0 }] })),
    { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
  ] }] };
  const f = fixture(t, FULL, { count: 2, seed: 23, dungeon }); routeWithoutRecruits(f.match);
  const [first, second] = f.match.route;
  const split = f.match.handle('p0', { t: 'g.mizuki.splitRequest', nodeId: second.id }); assert.equal(split.ok, true);
  assert.equal(f.match.handle('p0', { t: 'g.mizuki.splitDecide', requestId: split.request.id, approve: true }).approved, true);
  assert.equal(f.match.handle('p1', { t: 'g.mizuki.route', nodeId: first.id }).ok, true);
  command(f.match, { t: 'g.mizuki.routeStart' }); assert.equal(f.match.partyStates.size, 2);
  for (const id of ['p0', 'p1']) {
    const event = f.match.privateView(id).mizuki.event; assert.ok(event);
    assert.equal(f.match.handle(id, { t: 'g.mizuki.event', choiceId: event.choices[0].id }).ok, true);
    assert.ok(f.match.privateView(id).mizuki.sanCheck?.id.startsWith('mzwish:'));
  }
  const before = f.match.dice, firstCheck = f.match.privateView('p0').mizuki.sanCheck.id, secondCheck = f.match.privateView('p1').mizuki.sanCheck.id;
  assert.notEqual(firstCheck, secondCheck);
  assert.notEqual(f.match.handle('p0', { t: 'g.mizuki.sanVote', id: secondCheck, choice: 'reroll' }).ok, true);
  command(f.match, { t: 'g.mizuki.sanVote', id: firstCheck, choice: 'reroll' });
  assert.equal(f.match.dice, before - 1);
  assert.equal(f.match.privateView('p1').mizuki.sanCheck.id, secondCheck);
  const loaded = restored(t, f.options, f.match.exportCheckpoint(), EMPTY);
  assert.equal(loaded.privateView('p1').mizuki.sanCheck.id, secondCheck);
  assert.equal(loaded.handle('p1', { t: 'g.mizuki.sanVote', id: secondCheck, choice: 'reroll' }).ok, true);
  assert.equal(loaded.dice, before - 2);
  for (const [id, check] of [['p0', firstCheck], ['p1', secondCheck]])
    assert.notEqual(loaded.handle(id, { t: 'g.mizuki.sanVote', id: check, choice: 'reroll' }).ok, true);
  assert.equal(loaded.dice, before - 2);
});

function cacheBattle(t, cognition = FULL) {
  const f = fixture(t, cognition, { count: 2, seed: 1099 }); routeWithoutRecruits(f.match);
  const node = f.match.privateView('p0').mizuki.route.find(value => value.available); assert.ok(node);
  for (const player of f.match.order) assert.equal(f.match.handle(player.playerId, { t: 'g.mizuki.route', nodeId: node.id }).ok, true);
  command(f.match, { t: 'g.mizuki.routeStart' });
  for (const player of f.match.order) assert.equal(f.match.handle(player.playerId, { t: 'g.mizuki.ready', on: true }).ok, true);
  assert.equal(f.match.phase, PHASE.COMBAT); settle(f.match, f.scheduler);
  return f;
}
function cacheChoice(match, choiceId) {
  for (const player of match.order) assert.equal(match.handle(player.playerId, { t: 'g.mizuki.event', choiceId }).ok, true);
}

test('natural drifting-cache drops open through original reward cards and preserve personal gold across checkpoint and replay', t => {
  const locked = cacheBattle(t, EMPTY);
  assert.ok(locked.match.order.every(player => player.rewards.every(reward => reward.type !== 'driftingCache')));
  const f = cacheBattle(t), match = f.match;
  assert.ok(match.order.every(player => player.rewards.some(reward => reward.type === 'driftingCache')));
  const reward = match.players.get('p0').rewards.find(value => value.type === 'driftingCache');
  assert.equal(reward.group, 'driftingCache'); assert.ok(reward.contents.length);
  const goldBefore = match.order.map(player => player.gold), diceBefore = match.dice, relics = [...match.collectibles];
  command(match, { t: 'g.mizuki.reward', rewardId: reward.id });
  assert.equal(match.phase, PHASE.EVENT); assert.equal(match.event.driftingCache, true);
  assert.equal(match.event.ownerId, 'p0'); assert.equal(match.event.rewardId, reward.id);
  assert.deepEqual(match.event.contents, reward.contents);
  assert.deepEqual(match.event.choices.map(value => value.id), ['rogue_2_treasure_use_key', 'rogue_2_treasure_use_dice', 'rogue_2_treasure_leave']);
  const loaded = restored(t, f.options, match.exportCheckpoint(), EMPTY);
  assert.deepEqual(loaded.event, match.event);
  cacheChoice(loaded, 'rogue_2_treasure_use_dice');
  assert.equal(loaded.phase, PHASE.REWARD); assert.equal(loaded.dice, diceBefore - 1);
  assert.deepEqual(loaded.order.map(player => player.gold), [goldBefore[0] + 2, goldBefore[1]]);
  assert.deepEqual(loaded.collectibles, relics);
  assert.equal(loaded.players.get('p0').rewards.find(value => value.id === reward.id).selected, true);
  assert.notEqual(loaded.handle('p0', { t: 'g.mizuki.reward', rewardId: reward.id }).ok, true);
  const again = restored(t, f.options, loaded.exportCheckpoint(), EMPTY);
  assert.notEqual(again.handle('p0', { t: 'g.mizuki.reward', rewardId: reward.id }).ok, true);
  assert.deepEqual(again.order.map(player => player.gold), [goldBefore[0] + 2, goldBefore[1]]);
  assert.equal(again.dice, diceBefore - 1);
});

test('cache key awards saved shared contents once and weapon choice grants neither contents nor extra gold', t => {
  const f = cacheBattle(t), match = f.match;
  const first = match.players.get('p0').rewards.find(value => value.type === 'driftingCache');
  const keyBefore = match.key, diceBefore = match.dice, before = [...match.collectibles];
  command(match, { t: 'g.mizuki.reward', rewardId: first.id });
  const loaded = restored(t, f.options, match.exportCheckpoint(), EMPTY);
  cacheChoice(loaded, 'rogue_2_treasure_use_key');
  assert.equal(loaded.phase, PHASE.REWARD); assert.equal(loaded.key, keyBefore - 1);
  assert.equal(loaded.dice, diceBefore); assert.deepEqual(loaded.collectibles, [...before, ...first.contents]);
  for (const player of loaded.order) assert.equal(loaded._scoreResult(player.playerId).counters.itemsGained, first.contents.length);
  const second = loaded.players.get('p1').rewards.find(value => value.type === 'driftingCache');
  assert.equal(loaded.handle('p1', { t: 'g.mizuki.reward', rewardId: second.id }).ok, true);
  assert.equal(loaded.event.ownerId, 'p1');
  const goldBefore = loaded.order.map(player => player.gold);
  cacheChoice(loaded, 'rogue_2_treasure_leave');
  assert.equal(loaded.phase, PHASE.REWARD);
  assert.equal(loaded.key, keyBefore - 1); assert.equal(loaded.dice, diceBefore);
  assert.deepEqual(loaded.collectibles, [...before, ...first.contents]);
  assert.deepEqual(loaded.order.map(player => player.gold), goldBefore);
  assert.equal(loaded.players.get('p1').rewards.find(value => value.id === second.id).selected, true);
  const again = restored(t, f.options, loaded.exportCheckpoint(), EMPTY);
  for (const [id, rewardId] of [['p0', first.id], ['p1', second.id]])
    assert.notEqual(again.handle(id, { t: 'g.mizuki.reward', rewardId }).ok, true);
  assert.deepEqual(again.collectibles, loaded.collectibles); assert.equal(again.key, loaded.key);
});

for (const [number, sourceItemId, count, rarity] of [
  [36, 'rogue_2_upgrade_ticket_all', 3],
  [37, 'rogue_2_upgrade_ticket_pioneer', 1],
  [69, 'rogue_2_recruit_ticket_temp_5_up', 1, 5],
  [70, 'rogue_2_recruit_ticket_temp_6_up', 1, 6],
]) test('cache relic ' + number + ' preserves every immediate voucher through rewards, recovery and actual recruitment', t => {
  const f = cacheBattle(t), match = f.match, contents = ['rogue_2_relic_grace_' + number];
  const operator = match.fullCatalog.operators.find(value => value.profession === 'PIONEER' && value.rarity === 4 && value.promotionChessId);
  assert.ok(operator);
  const originalUids = new Map(match.order.map(player => [player.playerId, match._grantMetaChess(player, operator.operatorId).uid]));
  const reward = match.players.get('p0').rewards.find(value => value.type === 'driftingCache');
  // Control only the saved content; opening, granting, selection, recovery and
  // recruitment all run through the ordinary production commands.
  reward.contents = contents;
  command(match, { t: 'g.mizuki.reward', rewardId: reward.id });
  cacheChoice(match, 'rogue_2_treasure_use_key');
  assert.equal(match.phase, PHASE.REWARD);
  const voucherIds = new Map();
  for (const player of match.order) {
    const tickets = player.tickets.filter(ticket => ticket.sourceItemId === sourceItemId);
    assert.equal(tickets.length, count);
    voucherIds.set(player.playerId, tickets.map(ticket => ticket.id));
    for (const ticket of tickets) {
      const card = player.rewards.find(value => value.ticketId === ticket.id);
      assert.ok(card?.selected); assert.equal(card.type, 'recruitTicket');
    }
  }
  const loaded = restored(t, f.options, match.exportCheckpoint(), EMPTY);
  assert.notEqual(loaded.handle('p0', { t: 'g.mizuki.reward', rewardId: reward.id }).ok, true);
  while (loaded.phase === PHASE.REWARD) {
    const player = loaded.order.find(value => !value.ready); assert.ok(player);
    const next = player.rewards.find(value => !player.rewards.some(chosen => chosen.group === value.group && chosen.selected));
    assert.ok(next);
    assert.equal(loaded.handle(player.playerId, { t: 'g.mizuki.reward', rewardId: next.id }).ok, true);
    if (loaded.phase === PHASE.EVENT) cacheChoice(loaded, 'rogue_2_treasure_leave');
  }
  assert.equal(loaded.phase, PHASE.RECRUIT);
  const recovered = restored(t, f.options, loaded.exportCheckpoint(), EMPTY);
  for (const player of recovered.order) {
    const ids = voucherIds.get(player.playerId);
    assert.ok(ids.every(id => player.recruit.ticketIds.includes(id)));
    let recruited = false;
    while (recovered.privateView(player.playerId).mizuki.phase === PHASE.RECRUIT && !player.ready) {
      const view = recovered.privateView(player.playerId).mizuki.recruit;
      const target = ids.includes(view.activeTicketId) && !recruited;
      const choice = target && view.choices.find(value => value.available && (rarity ? value.rarity === rarity : value.operatorId === operator.operatorId));
      if (target) assert.ok(choice, 'the immediate voucher has an actual usable candidate');
      const beforeCount = player.roster.length, beforeHope = player.hope;
      assert.equal(recovered.handle(player.playerId, { t: 'g.mizuki.recruit', offerId: choice?.offerId || view.skipToken }).ok, true);
      if (!choice) continue;
      recruited = true; assert.equal(player.hope, beforeHope); assert.equal(choice.hopeCost, 0);
      const unit = player.roster.find(value => value.operatorId === choice.operatorId); assert.ok(unit);
      assert.equal(unit.promotion, 1); assert.equal(unit.chessId, choice.promotionChessId);
      if (rarity) assert.equal(player.roster.length, beforeCount + 1);
      else { assert.equal(player.roster.length, beforeCount); assert.equal(unit.uid, originalUids.get(player.playerId)); }
    }
    assert.equal(recruited, true);
    assert.ok(ids.every(id => player.tickets.find(ticket => ticket.id === id).status !== 'available'));
  }
  assert.equal(recovered.phase, PHASE.ROUTE);
  const again = restored(t, f.options, recovered.exportCheckpoint(), EMPTY);
  for (const player of again.order) {
    const tickets = player.tickets.filter(ticket => ticket.sourceItemId === sourceItemId);
    assert.equal(tickets.length, count); assert.ok(tickets.every(ticket => ticket.status !== 'available'));
  }
});

test('autoplay accepts each restored party wish through real votes without consuming dice or replaying the reward', t => {
  const dungeon = { zones: [{ id: 'zone_1', nodes: [
    ...[0, 1].map(y => ({ pos: { x: 0, y }, type: 'WISH', next: [{ x: 1, y: 0 }] })),
    { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
  ] }] };
  const f = fixture(t, FULL, { count: 2, seed: 23, dungeon }); routeWithoutRecruits(f.match);
  const [first, second] = f.match.route;
  const split = f.match.handle('p0', { t: 'g.mizuki.splitRequest', nodeId: second.id }); assert.equal(split.ok, true);
  assert.equal(f.match.handle('p0', { t: 'g.mizuki.splitDecide', requestId: split.request.id, approve: true }).approved, true);
  assert.equal(f.match.handle('p1', { t: 'g.mizuki.route', nodeId: first.id }).ok, true);
  command(f.match, { t: 'g.mizuki.routeStart' });
  for (const id of ['p0', 'p1']) {
    const event = f.match.privateView(id).mizuki.event; assert.ok(event);
    assert.equal(f.match.handle(id, { t: 'g.mizuki.event', choiceId: event.choices[0].id }).ok, true);
    assert.ok(f.match.privateView(id).mizuki.sanCheck?.id.startsWith('mzwish:'));
  }
  const before = f.match.dice;
  for (const id of ['p0', 'p1']) assert.equal(f.match.handle(id, { t: 'g.autoplay', on: true }).ok, true);
  const loaded = restored(t, f.options, f.match.exportCheckpoint(), EMPTY);
  assert.ok(loaded.order.every(player => player.autoplay));
  loaded.sched.advance(750);
  for (const id of ['p0', 'p1']) {
    assert.equal(loaded.privateView(id).mizuki.sanCheck, null);
    assert.equal(loaded.privateView(id).mizuki.phase, PHASE.ROUTE);
    assert.equal(loaded._scoreResult(id).counters.stepsPassed, 1);
    assert.equal(loaded.handle(id, { t: 'g.autoplay', on: false }).ok, true);
  }
  assert.equal(loaded.dice, before); assert.equal(loaded.collectibles.length, 2);
  const again = restored(t, f.options, loaded.exportCheckpoint(), EMPTY);
  assert.equal(again.dice, before); assert.deepEqual(again.collectibles, loaded.collectibles);
  for (const id of ['p0', 'p1']) assert.equal(again._scoreResult(id).counters.stepsPassed, 1);
  assert.deepEqual(loaded.sched.errors, []);
});

test('autoplay completes each native cache choice after checkpoint through the original event vote', t => {
  for (const choiceId of ['rogue_2_treasure_use_key', 'rogue_2_treasure_use_dice', 'rogue_2_treasure_leave']) {
    const f = cacheBattle(t), match = f.match;
    const cache = match.players.get('p0').rewards.find(value => value.type === 'driftingCache'); assert.ok(cache);
    command(match, { t: 'g.mizuki.reward', rewardId: cache.id });
    // Preserve the human's original choice. Autoplay follows that existing vote.
    command(match, { t: 'g.mizuki.event', choiceId });
    assert.equal(match.phase, PHASE.EVENT); assert.equal(match.votes.p0, choiceId);
    assert.equal(match.handle('p1', { t: 'g.autoplay', on: true }).ok, true);
    const before = { dice: match.dice, key: match.key, gold: match.order.map(player => player.gold), relics: [...match.collectibles] };
    const loaded = restored(t, f.options, match.exportCheckpoint(), EMPTY);
    for (let tick = 0; tick < 4 && loaded.privateView('p1').mizuki.phase === PHASE.EVENT; tick++) loaded.sched.advance(750);
    assert.equal(loaded.privateView('p1').mizuki.phase, PHASE.REWARD);
    assert.equal(loaded.event, null);
    assert.equal(loaded.players.get('p0').rewards.find(value => value.id === cache.id).selected, true);
    assert.equal(loaded.key, before.key - (choiceId.endsWith('use_key') ? 1 : 0));
    assert.equal(loaded.dice, before.dice - (choiceId.endsWith('use_dice') ? 1 : 0));
    assert.deepEqual(loaded.order.map(player => player.gold), [before.gold[0] + (choiceId.endsWith('use_dice') ? 2 : 0), before.gold[1]]);
    assert.deepEqual(loaded.collectibles, choiceId.endsWith('use_key') ? [...before.relics, ...cache.contents] : before.relics);
    assert.equal(loaded.handle('p1', { t: 'g.autoplay', on: false }).ok, true);
    const again = restored(t, f.options, loaded.exportCheckpoint(), EMPTY);
    assert.deepEqual(again.collectibles, loaded.collectibles); assert.equal(again.dice, loaded.dice);
    assert.notEqual(again.handle('p0', { t: 'g.mizuki.reward', rewardId: cache.id }).ok, true);
    assert.deepEqual(loaded.sched.errors, []);
  }
});
