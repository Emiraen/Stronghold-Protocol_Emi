import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { mizukiBattleBaseReward } from '../server/modes/mizuki/BattleRewards.js';
import { completeMizukiExplorationNode, enterMizukiPortalExploration } from '../server/modes/mizuki/exploration.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });

function fixture(t, { variation, nodes, count = 1, seed = 123, zones = null }) {
  const scheduler = new VirtualScheduler();
  const dungeon = { zones: zones || [{ id: 'zone_1', variation, nodes }] };
  const options = { scheduler, data: DATA, seed, roomCode: 'VARY', dungeon,
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat })),
    send() {}, broadcast() {}, onEnd() {} };
  const match = new MizukiMatch(options);
  t.after(() => { match.dispose(); scheduler.dispose(); });
  match.start();
  for (const player of match.order) match.handle(player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  for (const [index, player] of match.order.entries())
    match.handle(player.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[index].bandId });
  for (const player of match.order) match.handle(player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
  for (const player of match.order) match.handle(player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match);
  assert.equal(match.phase, PHASE.ROUTE);
  return { match, options };
}

function enterNode(match, nodeId, playerIds = match.order.map(player => player.playerId)) {
  for (const playerId of playerIds) assert.deepEqual(match.handle(playerId, { t: 'g.mizuki.route', nodeId }), { ok: true });
  assert.deepEqual(match.handle(match.hostId, { t: 'g.mizuki.routeStart' }), { ok: true });
}

function wishNode(x, y) { return { pos: { x, y }, type: 'WISH', next: [] }; }
function battleNode() { return { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }; }

function splitAtTwoRoots(match) {
  const [first, second] = match.route;
  assert.ok(first && second);
  const split = match.handle('p0', { t: 'g.mizuki.splitRequest', nodeId: second.id });
  assert.equal(split.ok, true);
  assert.equal(match.handle('p0', { t: 'g.mizuki.splitDecide', requestId: split.request.id, approve: true }).approved, true);
  assert.equal(match.handle('p1', { t: 'g.mizuki.route', nodeId: first.id }).ok, true);
  assert.equal(match.handle('p0', { t: 'g.mizuki.routeStart' }).ok, true);
  assert.equal(match.partyStates.size, 2);
}

function convergeNodes(type) {
  return [0, 1].map(y => ({ pos: { x: 0, y }, type: 'REST', next: [{ x: 1, y: 0 }] })).concat([
    { pos: { x: 1, y: 0 }, type, ...(type === 'BATTLE_NORMAL' ? { stage: 'ro2_n_1_1' } : {}), next: [{ x: 2, y: 0 }] },
    { pos: { x: 2, y: 0 }, type: 'REST', next: [] },
  ]);
}

function completePartiesAndEnterCommonNode(match) {
  for (const party of [...match.expedition.parties.values()]) match._withParty(party, () => match._completeNode());
  for (const player of match.order) {
    const party = match.expedition.partyFor(player.playerId), state = match.partyStates.get(party.id);
    assert.equal(state.route.length, 1);
    assert.equal(match.handle(player.playerId, { t: 'g.mizuki.route', nodeId: state.route[0].id }).ok, true);
  }
  assert.equal(match.handle('p0', { t: 'g.mizuki.routeStart' }).ok, true);
}

test('variation three pays each party member when parallel branches converge on one nonbattle node', (t) => {
  const { match } = fixture(t, { variation: 'rogue_2_variation_3', count: 2, nodes: convergeNodes('REST') });
  const initial = match.order.map(player => player.gold);
  splitAtTwoRoots(match);
  assert.deepEqual(match.order.map(player => player.gold), initial.map(gold => gold + 3));
  completePartiesAndEnterCommonNode(match);
  assert.deepEqual(match.order.map(player => player.gold), initial.map(gold => gold + 6));
});

test('variations one and five change actual light and post-battle ticket results', (t) => {
  const lightRun = fixture(t, { variation: 'rogue_2_variation_1', nodes: [battleNode()] }).match;
  const lightBefore = lightRun.light;
  lightRun._changeLight(-5);
  assert.equal(lightRun.light, lightBefore - 10);

  const ticketRun = fixture(t, { variation: 'rogue_2_variation_5', nodes: [battleNode()] }).match;
  enterNode(ticketRun, ticketRun.route[0].id);
  ticketRun.offerSeq++;
  const seed = Array.from({ length: 100 }, (_, index) => index + 1).find(value => {
    ticketRun.seed = value;
    return ticketRun._rng('variation-ticket:p0').chance(0.3);
  });
  ticketRun.offerSeq--;
  assert.ok(seed);
  ticketRun.seed = seed;
  ticketRun._enterReward();
  assert.equal(ticketRun.players.get('p0').rewards.filter(reward => reward.group === 'variationTicket').length, 1);
});

test('variation four charges every participant once when parallel branches enter the same combat node', (t) => {
  const { match, options } = fixture(t, { variation: 'rogue_2_variation_4', count: 2, nodes: convergeNodes('BATTLE_NORMAL') });
  const expectedLife = match.order.map(player => player.life - 1);
  splitAtTwoRoots(match);
  completePartiesAndEnterCommonNode(match);
  assert.deepEqual(match.order.map(player => player.life), expectedLife);
  const restored = new MizukiMatch(options); t.after(() => restored.dispose());
  assert.equal(restored.restoreCheckpoint(structuredClone(match.exportCheckpoint())), true);
  for (const party of restored.expedition.parties.values()) restored._withParty(party, () => restored._applyVariationBattleEntry());
  assert.deepEqual(restored.order.map(player => player.life), expectedLife, 'checkpoint restore cannot repeat combat entry damage');
});

test('variation three consumes tracked earnings before existing savings when buying from a merchant', (t) => {
  const { match } = fixture(t, { variation: 'rogue_2_variation_3', nodes: [
    { pos: { x: 0, y: 0 }, type: 'BATTLE_SHOP', next: [{ x: 1, y: 0 }] },
    { pos: { x: 1, y: 0 }, type: 'REST', next: [] },
  ] });
  const player = match.players.get('p0'), initial = player.gold, zoneKey = match.explorationState.zoneKey;
  enterNode(match, match.route[0].id);
  assert.equal(match.phase, PHASE.SHOP);
  player.shop.offers = [{ id: 'tracked-gold', itemId: 'rogue_2_population', count: 1, price: 5, sold: false }];
  assert.equal(match.handle('p0', { t: 'g.mizuki.buy', offerId: 'tracked-gold' }).ok, true);
  assert.equal(player.gold, initial + 3 - 5);
  assert.deepEqual(match.floorState.variations[zoneKey].goldEarnedByPlayer, {});
  match._leaveVariationZone(zoneKey);
  assert.equal(player.gold, initial - 2, 'already spent earnings must not be clawed back from pre-layer savings');
});

test('variation three settles a portal region before resuming the source region', (t) => {
  const { match } = fixture(t, { variation: null, nodes: [
    { pos: { x: 0, y: 0 }, type: 'PORTAL', next: [{ x: 1, y: 0 }] },
    { pos: { x: 1, y: 0 }, type: 'REST', next: [] },
  ] });
  enterNode(match, match.route[0].id);
  const party = match.expedition.partyFor('p0'), player = match.players.get('p0'), initial = player.gold,
    originZoneKey = match.explorationState.zoneKey;
  match._withParty(party, () => {
    match.explorationState = completeMizukiExplorationNode(match.explorationState, match.currentNode.id, match.stageOptions);
    match.explorationState = enterMizukiPortalExploration(match.explorationState, { id: 'zone_7', zoneType: 'SP',
      variation: 'rogue_2_variation_3', returnZoneKey: match.explorationState.zoneKey,
      nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_BOSS', stage: match.stageOptions.find(stage => stage.type === 'boss' && stage.available).stageId, next: [] }] });
    match._enterRoute();
    match._enterNode(match.route[0]);
    match._enterReward();
    assert.ok(player.gold > initial);
    match._completeNode();
    assert.equal(match.explorationState.zoneKey, originZoneKey);
    assert.equal(player.gold, initial, 'leaving a portal must settle its tracked source ingots');
    const portalKey = Object.keys(match.floorState.variations).find(key => key.startsWith('portal_'));
    assert.ok(portalKey);
    assert.equal(match.floorState.variations[portalKey].exited, true);
  });
});

test('variation three bank deposits reduce the recoverable earnings and checkpoint validation rejects corrupt ledgers', (t) => {
  const { match, options } = fixture(t, { variation: 'rogue_2_variation_3', nodes: [
    { pos: { x: 0, y: 0 }, type: 'BATTLE_SHOP', next: [{ x: 1, y: 0 }] },
    { pos: { x: 1, y: 0 }, type: 'REST', next: [] },
  ] });
  const player = match.players.get('p0'), initial = player.gold, zoneKey = match.explorationState.zoneKey;
  enterNode(match, match.route[0].id);
  assert.equal(match.handle('p0', { t: 'g.mizuki.bank', action: 'deposit', count: 1 }).ok, true);
  assert.equal(player.gold, initial + 2);
  assert.deepEqual(match.floorState.variations[zoneKey].goldEarnedByPlayer, { p0: 2 });
  const checkpoint = structuredClone(match.exportCheckpoint());
  for (const ledger of [{ p0: -1 }, { p0: player.gold + 1 }, { stranger: 1 }]) {
    const corrupted = structuredClone(checkpoint);
    corrupted.mizuki.floorState.variations[zoneKey].goldEarnedByPlayer = ledger;
    const candidate = new MizukiMatch(options); t.after(() => candidate.dispose());
    assert.equal(candidate.restoreCheckpoint(corrupted), false);
  }
  const restored = new MizukiMatch(options); t.after(() => restored.dispose());
  assert.equal(restored.restoreCheckpoint(checkpoint), true);
  restored._leaveVariationZone(zoneKey);
  assert.equal(restored.players.get('p0').gold, initial, 'deposited earnings are retained in the bank rather than charged twice on exit');
});

test('variation three credits a nonbattle node once, persists its ledger, then claws back the layer earnings once', (t) => {
  const { match, options } = fixture(t, { variation: 'rogue_2_variation_3',
    nodes: [{ pos: { x: 0, y: 0 }, type: 'REST', next: [] }] });
  const node = match.route[0], zoneKey = match.explorationState.zoneKey;
  const before = match.players.get('p0').gold;
  enterNode(match, node.id);
  assert.equal(match.phase, PHASE.EVENT);
  assert.equal(match.players.get('p0').gold, before + 3);
  const entered = match.currentNode;
  match._enterVariationNode(entered);
  assert.equal(match.players.get('p0').gold, before + 3, 're-entering the same node cannot pay twice');
  assert.deepEqual(match.floorState.variations[zoneKey].goldEarnedByPlayer, { p0: 3 });

  const restored = new MizukiMatch(options); t.after(() => restored.dispose());
  assert.equal(restored.restoreCheckpoint(structuredClone(match.exportCheckpoint())), true);
  assert.deepEqual(restored.floorState.variations[zoneKey], match.floorState.variations[zoneKey]);
  const party = restored.expedition.partyFor('p0');
  restored._withParty(party, () => restored._completeNode());
  assert.equal(restored.explorationState.zoneKey, zoneKey);
  assert.equal(restored.players.get('p0').gold, before);
  assert.equal(restored.floorState.variations[zoneKey].exited, true);
  restored._leaveVariationZone(zoneKey, ['p0']);
  assert.equal(restored.players.get('p0').gold, before, 'a repeated floor exit must not charge twice');
});

test('variation eight grants the first wish collectible once across parallel parties and restores the grant flag', (t) => {
  const { match, options } = fixture(t, { variation: 'rogue_2_variation_8', count: 2,
    nodes: [wishNode(0, 0), wishNode(0, 1)] });
  const first = match.route.find(node => node.graphType === 'WISH');
  const second = match.route.find(node => node.graphType === 'WISH' && node.id !== first.id);
  assert.ok(first && second);
  const split = match.handle('p0', { t: 'g.mizuki.splitRequest', nodeId: second.id });
  assert.equal(split.ok, true);
  assert.equal(match.handle('p0', { t: 'g.mizuki.splitDecide', requestId: split.request.id, approve: true }).approved, true);
  assert.equal(match.handle('p1', { t: 'g.mizuki.route', nodeId: first.id }).ok, true);
  assert.equal(match.handle('p0', { t: 'g.mizuki.routeStart' }).ok, true);
  assert.equal(match.partyStates.size, 2);
  assert.ok([...match.partyStates.values()].every(state => state.phase === PHASE.EVENT));
  const zoneKey = match.explorationState.zoneKey;
  assert.equal(match.floorState.variations[zoneKey].wishGranted, true);
  assert.equal(match.collectibles.length, 1);

  const restored = new MizukiMatch(options); t.after(() => restored.dispose());
  assert.equal(restored.restoreCheckpoint(structuredClone(match.exportCheckpoint())), true);
  assert.equal(restored.partyStates.size, 2);
  assert.equal(restored.collectibles.length, 1);
  for (const party of restored.expedition.parties.values()) restored._withParty(party, () => {
    restored._enterVariationNode({ graphNodeId: 'second-wish', graphType: 'WISH', type: 'event' });
  });
  assert.equal(restored.collectibles.length, 1, 'the shared reward is not duplicated by another party or checkpoint restore');
});

test('battle variations change entry life, credited gold and command experience on the reward path', (t) => {
  for (const variation of ['rogue_2_variation_4', 'rogue_2_variation_6']) {
    const { match } = fixture(t, { variation, nodes: [battleNode()] });
    const node = match.route[0], player = match.players.get('p0');
    const goldBefore = player.gold, expBefore = match.commander.totalExp, lifeBefore = player.life;
    enterNode(match, node.id);
    assert.equal(match.phase, PHASE.PREP);
    if (variation === 'rogue_2_variation_4') assert.equal(player.life, lifeBefore - 1);
    const base = mizukiBattleBaseReward({ node: match.currentNode, floor: 1, extraRegion: false });
    match._enterReward();
    if (variation === 'rogue_2_variation_4') assert.equal(player.gold, goldBefore + base.gold * 2);
    else assert.equal(match.commander.totalExp - expBefore, Math.floor(base.exp * 1.5));
  }
});

test('variation seven increases maximum life and doubles actual battle damage', (t) => {
  const { match } = fixture(t, { variation: 'rogue_2_variation_7', nodes: [battleNode()] });
  const node = match.route[0], player = match.players.get('p0');
  enterNode(match, node.id);
  const before = { life: player.life, maxLife: player.maxLife, shield: player.shield };
  const party = match.expedition.partyFor('p0');
  match._withParty(party, () => {
    match.lastResults = new Map();
    match._settlePartyBattle(new Map([['p0', 1]]));
  });
  assert.equal(player.maxLife, before.maxLife + 1);
  assert.equal(player.shield, Math.max(0, before.shield - 2));
  assert.equal(player.life, before.life - 2 + 1, 'double battle loss is followed by the squad\'s one-life recovery');
  assert.equal(player.shield, before.shield);
  assert.equal(player.battleOutcome.lpLoss, 2);
});

function settleLightBattle(match, { leaked = true, lowLife = false } = {}) {
  enterNode(match, match.route.find(node => node.available && node.type === 'combat').id);
  const player = match.players.get('p0');
  if (lowLife) player.life = 2;
  const engine = match.fields.get(player.fieldId).engine;
  const snapshot = engine.snapshot.bind(engine);
  const leaks = leaked ? [{ enemyKey: 'fixture_light', counted: true, sourcePlayerId: 'p0', lpr: 0 }] : [];
  engine.result = () => ({ outcome: 'victory', leakedCount: leaks.length,
    perPlayer: { p0: { leaked: leaks, leaderLpLoss: 0, perfect: !leaked } } });
  engine.snapshot = () => ({ ...snapshot(), leakedCount: leaks.length });
  match._withParty(match.expedition.partyFor('p0'), () => {
    match.lastResults = new Map();
    match._settlePartyBattle(new Map([['p0', 0]]));
  });
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.REWARD);
}

test('lamp oil scales actual battle light losses and combines with regional loss amplification', t => {
  for (const [relic, expected] of [[null, 10], ['rogue_2_relic_grace_74', 6], ['rogue_2_relic_grace_75', 4]]) {
    for (const variation of [null, 'rogue_2_variation_1']) {
      const { match } = fixture(t, { variation, nodes: [battleNode()] });
      match.light = 50;
      if (relic) match.collectibles.push(relic);
      settleLightBattle(match, { lowLife: true });
      assert.equal(match.light, 50 - expected * (variation ? 2 : 1), `${relic} / ${variation}`);
    }
  }
});

test('lamp oil does not discount cursed light costs or event losses and leaves perfect light recovery intact', t => {
  const cost = fixture(t, { variation: null, nodes: [battleNode()] }).match;
  cost.light = 50;cost.collectibles.push('rogue_2_relic_grace_75', 'rogue_2_relic_curse_5');
  settleLightBattle(cost);
  assert.equal(cost.light, 46, 'five battle loss becomes two, plus the full cursed two');
  cost._changeLight(-5);
  assert.equal(cost.light, 41, 'ordinary event light loss is outside battle damage reduction');

  const perfect = fixture(t, { variation: 'rogue_2_variation_1', nodes: [battleNode()] }).match;
  perfect.light = 50;perfect.collectibles.push('rogue_2_relic_grace_75', 'rogue_2_relic_grace_72');
  settleLightBattle(perfect, { leaked: false });
  assert.equal(perfect.light, 56, 'perfect recovery is neither reduced nor multiplied');

  const mixed = fixture(t, { variation: 'rogue_2_variation_1', nodes: [battleNode()] }).match;
  mixed.light = 0;mixed.collectibles.push('rogue_2_relic_grace_72', 'rogue_2_relic_curse_5');
  settleLightBattle(mixed, { leaked: false, lowLife: true });
  assert.equal(mixed.light, 0, 'loss, curse and recovery settle together before the zero-light clamp');
});
