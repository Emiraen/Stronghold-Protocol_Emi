import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { createMizukiCatalog, MIZUKI_RECRUIT_RULES } from '../server/modes/mizuki/catalog.js';
import { createMizukiRecruitTicket } from '../server/modes/mizuki/Recruitment.js';
import { mizukiCommanderLevelRewards } from '../server/modes/mizuki/Difficulty.js';
import { MIZUKI_SQUADS } from '../shared/mizuki-squads.js';
import { Grid } from '../server/sim/grid.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const FRAME_MS = 1000 / 30;
const TEST_DUNGEON = { zones: [{ id: 'zone_1', nodes: [
  { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [{ x: 1, y: 0 }] },
  { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [] },
] }] };
class FakeCombat {
  constructor(options) { this.options = options; this.ticks = 0; this.leaks = 0; this.done = false; this.outcome = 'victory'; this.commands = []; this.deployLimit = options.deployLimit; this.battle = { grid: new Grid(options.stage, options.rect), players: options.players, allyUnits: [], enemies: [], opts: { spawns: [] }, addBuff() {}, on() {} }; }
  step() { this.ticks++; }
  snapshot() {
    return { battleId: this.options.battleId, fieldId: this.options.fieldId, tick: this.ticks, t: this.ticks / 30,
      units: [], dps: {}, killed: 0, total: 6, resolved: 0, leakedCount: this.leaks, leakDamage: this.leaks,
      done: this.done, outcome: this.done ? this.outcome : null,
      covenants: Object.fromEntries(this.options.players.map((p) => [p.playerId, Object.entries(p.layers || {}).map(([id, layers]) => ({ id, layers, active: false }))])),
      geometry: { rows: 19, cols: 21, rect: this.options.rect, tiles: [{ row: 1, col: 2, build: 'ALL', height: 'LOW' }] },
      rosters: Object.fromEntries(this.options.players.map((p) => [p.playerId, p.units.map((unit) => ({ ...unit, deployed: false }))])) };
  }
  fieldMeta() { return { fieldId: this.options.fieldId, kind: 'mizuki', rect: this.options.rect, stageId: this.options.stageId, units: [] }; }
  drainEvents() { return []; }
  result() { return this.done ? { outcome: this.outcome, leakDamage: this.leaks, leakedCount: this.leaks,
    perPlayer: Object.fromEntries(this.options.players.map((p) => [p.playerId, { perfect: false, leaderLpLoss: 0,
      leaked: this.leaks ? [{ enemyKey: 'fixture', sourcePlayerId: p.playerId, counted: true, lpr: this.leaks }] : [] }])) } : null; }
  forceEnd() { this.done = true; this.outcome = 'aborted'; }
  command(playerId, command) { this.commands.push({ playerId, ...command }); return { ok: true }; }
}
function fixture(t, { count = 4, realCombat = false, seed = 123, ...extra } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const frames = [], broadcasts = [], ended = [], checkpoints = [];
  const options = { roomCode: 'MZKI', mode: 'coop', difficulty: 'NORMAL', matchId: 'mizuki-test', matchNo: 2, seed,
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    data: DATA, scheduler, dungeon: structuredClone(TEST_DUNGEON), dungeonSourceLabel: 'schema fixture', ...(realCombat ? {} : { CombatClass: FakeCombat }),
    send: (playerId, message) => frames.push({ playerId, message }), broadcast: (message) => broadcasts.push(message),
    onEnd: (summary) => ended.push(summary), onCheckpoint: (match) => checkpoints.push(match.exportCheckpoint()), ...extra };
  const match = new MizukiMatch(options);
  t.after(() => { match.dispose(); scheduler.dispose(); });
  return { match, scheduler, frames, broadcasts, ended, checkpoints, options };
}
function voteSquad(match, squadId = 'rogue_2_band_1') {
  for (const p of match.order.filter((p) => p.connected && !p.left)) assert.deepEqual(match.handle(p.playerId, { t: 'g.mizuki.squad', squadId }), { ok: true });
  assert.equal(match.phase, PHASE.STRATEGY);
}
function pickStrategies(match) {
  for (const [i, p] of match.order.entries()) if (!p.left) assert.deepEqual(match.handle(p.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[i].bandId }), { ok: true });
  assert.equal(match.phase, PHASE.INITIAL_SUPPLY);
  for (const p of match.order.filter((p) => !p.left)) assert.deepEqual(match.handle(p.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' }), { ok: true });
  assert.equal(match.phase, PHASE.RECRUIT_GROUP);
}
function startRecruit(match, { squadId = 'rogue_2_band_1', groupId = 'recruit_group_1' } = {}) {
  match.start(); voteSquad(match, squadId); pickStrategies(match);
  for (const p of match.order.filter((p) => !p.left)) assert.deepEqual(match.handle(p.playerId, { t: 'g.mizuki.recruitGroup', groupId }), { ok: true });
  assert.equal(match.phase, PHASE.RECRUIT);
}
function skipRecruit(match) {
  skipMizukiRecruit(match);
  assert.notEqual(match.phase, PHASE.RECRUIT);
}
function recruitThree(match) {
  for (let n = 0; n < 3; n++) for (const p of match.order.filter((p) => !p.left)) {
    const offer = match.privateView(p.playerId).mizuki.recruit.choices.filter((o) => o.available && !o.owned).sort((a, b) => a.hopeCost - b.hopeCost)[0];
    assert.ok(offer); assert.deepEqual(match.handle(p.playerId, { t: 'g.mizuki.recruit', offerId: offer.offerId }), { ok: true });
  }
  skipRecruit(match);
  assert.equal(match.phase, PHASE.ROUTE);
}
// Without an imported native graph the selector is empty, so fixtures import a schema-only two-stage route
// (ro2_n_1_1 then ro2_n_1_2); the nodes carry the real stage records and nothing about official topology is asserted.
function importFixtureRoute(match) {
  if (match.explorationState?.sourceLabel === 'schema fixture') return;
  assert.equal(match.completedNodes, 0, 'schema fixture route is installed before the first node');
  const dungeon = { zones: [{ id: 'zone_1', nodes: [
    { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [{ x: 1, y: 0 }] },
    { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [] },
  ] }] };
  assert.deepEqual(match.handle(match.hostId, { t: 'g.mizuki.importDungeon', dungeon, sourceLabel: 'schema fixture' }), { ok: true });
}
function chooseStage(match, stageId = 'ro2_n_1_1') {
  importFixtureRoute(match);
  const node = match.route.find((value) => value.stageId === stageId);
  assert.ok(node, 'route offers ' + stageId);
  for (const p of match.order.filter((p) => !p.left && p.connected)) assert.deepEqual(match.handle(p.playerId, { t: 'g.mizuki.route', nodeId: node.id }), { ok: true });
  assert.equal(match.phase, PHASE.ROUTE);
  assert.deepEqual(match.handle(match.hostId, { t: 'g.mizuki.routeStart' }), { ok: true });
  assert.equal(match.phase, PHASE.PREP);
}
function prepare(match) { startRecruit(match); recruitThree(match); chooseStage(match); }
function launch(match) {
  for (const p of match.order.filter((p) => !p.left && p.connected)) assert.deepEqual(match.handle(p.playerId, { t: 'g.mizuki.ready', on: true }), { ok: true });
  assert.equal(match.phase, PHASE.COMBAT);
}
function finishFields(match, scheduler) { for (const field of match.fields.values()) field.engine.done = true; scheduler.advance(FRAME_MS * 2); }
function confirmRecord(match) {
  for (const p of match.order.filter((p) => p.connected && !p.left)) {
    const groups = [...new Set(p.rewards.map((reward) => reward.group).filter(Boolean))];
    assert.ok(groups.includes('recruitTicket'));
    for (const group of groups) {
      const reward = p.rewards.find((entry) => entry.group === group);
      assert.ok(reward);
      assert.deepEqual(match.handle(p.playerId, { t: 'g.mizuki.reward', rewardId: reward.id }), { ok: true });
    }
  }
  assert.equal(match.phase, PHASE.RECRUIT, 'battle reward choices enter their voucher queue before completing the node');
  skipRecruit(match);
}

test('official startup resources and human seat contract are exact', (t) => {
  const { match, options } = fixture(t); match.start();
  assert.equal(match.phase, PHASE.SQUAD);
  assert.ok(match.order.every((player) => player.life === 4 && player.maxLife === 4 && player.shield === 0));
  for (const key of ['life', 'maxLife', 'shield']) assert.equal(Object.hasOwn(match, key), false);
  assert.equal(match.squadCapacity, 6); assert.ok(match.order.every((p) => p.hope === 6 && p.gold === 6 && !p.roster.length));
  assert.equal(match.publicView().mizuki.squads.length, 13); assert.equal(match.publicView().players[0].gold, undefined);
  assert.deepEqual(match.order.map((p) => p.fieldId), ['n:p0', 'n:p1', 'n:p2', 'n:p3']);
  assert.equal(fixture(t, { count: 1 }).match.order.length, 1);
  assert.equal(fixture(t, { count: 3 }).match.order.length, 3);
  assert.throws(() => new MizukiMatch({ ...options, seats: [] }), /one to four/);
  assert.throws(() => new MizukiMatch({ ...options, seats: options.seats.map((p, i) => ({ ...p, isBot: i === 0 })) }), /bots/);
});

test('host-imported native graph drives voting battle progression and canonical checkpoint restoration', (t) => {
  const { match, scheduler } = fixture(t, { count: 2 });
  startRecruit(match); recruitThree(match);
  // Schema fixture only; no generated or asserted official topology.
  const dungeon = { zones: [{ id: 'zone_1', nodes: [
    { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [{ x: 1, y: 0 }, { x: 1, y: 1 }] },
    { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
    { pos: { x: 1, y: 1 }, type: 'REST', next: [] },
  ] }] };
  assert.equal(match.handle('p1', { t: 'g.mizuki.importDungeon', dungeon }).error, 'BAD_TARGET');
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.importDungeon', dungeon, sourceLabel: 'synthetic native-schema test' }), { ok: true });
  assert.equal(match.publicView().mizuki.archiveMode, false);
  assert.equal(match.publicView().mizuki.exploration.nodes.length, 3);
  assert.deepEqual(match.route.map((node) => node.id), ['mzgraph:0:0:0']);
  assert.equal(match.handle('p0', { t: 'g.mizuki.route', nodeId: 'mzgraph:0:1:0' }).error, 'BAD_TARGET');
  for (const player of match.order) assert.deepEqual(match.handle(player.playerId, { t: 'g.mizuki.route', nodeId: 'mzgraph:0:0:0' }), { ok: true });
  assert.deepEqual(match.handle(match.hostId, { t: 'g.mizuki.routeStart' }), { ok: true });
  assert.equal(match.phase, PHASE.PREP); assert.equal(match.currentNode.stageId, 'ro2_n_1_1');
  const prep = fixture(t, { count: 2 }).match;
  assert.equal(prep.restoreCheckpoint(match.exportCheckpoint()), true);
  assert.equal(prep.currentNode.id, 'mzgraph:0:0:0');
  assert.equal(prep.publicView().mizuki.exploration.currentNodeId, 'mzgraph:0:0:0');
  launch(match); finishFields(match, scheduler); confirmRecord(match);
  assert.equal(match.phase, PHASE.ROUTE);
  assert.deepEqual(match.explorationState.trace, ['mzgraph:0:0:0']);
  assert.deepEqual(match.route.map((node) => node.id), ['mzgraph:0:1:0', 'mzgraph:0:1:1']);
  const checkpoint = match.exportCheckpoint(); const restored = fixture(t, { count: 2 }).match;
  assert.equal(restored.restoreCheckpoint(checkpoint), true);
  assert.deepEqual(restored.explorationState, match.explorationState);
  const bad = structuredClone(checkpoint); bad.mizuki.route[0].id = 'mzgraph:0:99:99';
  assert.equal(fixture(t, { count: 2 }).match.restoreCheckpoint(bad), false);
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.archive', on: true }), { ok: true });
  assert.ok(match.route.every((node) => node.id === node.stageId));
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.archive', on: false }), { ok: true });
  assert.deepEqual(match.explorationState.trace, ['mzgraph:0:0:0']);
  assert.deepEqual(match.route.map((node) => node.id), ['mzgraph:0:1:0', 'mzgraph:0:1:1']);
});

test('squad team vote validates choices and host resolves a tie', (t) => {
  const { match } = fixture(t); match.start();
  assert.equal(match.handle('p0', { t: 'g.mizuki.squad', squadId: 'invented' }).error, 'BAD_TARGET');
  for (const [id, squadId] of [['p0', 'rogue_2_band_3'], ['p1', 'rogue_2_band_2'], ['p2', 'rogue_2_band_2']]) match.handle(id, { t: 'g.mizuki.squad', squadId });
  assert.equal(match.phase, PHASE.SQUAD); match.handle('p3', { t: 'g.mizuki.squad', squadId: 'rogue_2_band_3' });
  assert.equal(match.phase, PHASE.STRATEGY); assert.equal(match.selectedSquad.id, 'rogue_2_band_3');
  assert.ok(match.order.every((p) => p.gold === 26 && p.hope === 8));
});

test('all original strategies remain explicit individual choices without automatic offline picks', (t) => {
  const { match } = fixture(t, { count: 2 }); match.start(); voteSquad(match);
  assert.equal(match.strategyOptions.length, 40);
  assert.equal(match.handle('p0', { t: 'g.mizuki.strategy', bandId: 'fake' }).error, 'BAD_TARGET');
  match.handle('p0', { t: 'g.mizuki.strategy', bandId: match.strategyOptions[0].bandId });
  assert.equal(match.handle('p1', { t: 'g.mizuki.strategy', bandId: match.strategyOptions[0].bandId }).error, 'ALREADY');
  match.onDisconnect('p1'); assert.equal(match.phase, PHASE.STRATEGY); assert.equal(match.players.get('p1').bandId, null);
  match.onReconnect('p1'); match.handle('p1', { t: 'g.mizuki.strategy', bandId: match.strategyOptions[1].bandId });
  assert.equal(match.phase, PHASE.INITIAL_SUPPLY);
});

test('original recruit groups issue real profession tickets; unknown guaranteed temporary pool is disabled', (t) => {
  const { match } = fixture(t, { count: 2 }); match.start(); voteSquad(match); pickStrategies(match);
  assert.equal(match.privateView('p0').mizuki.recruitGroup.options.length, 4);
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_fake' }).error, 'BAD_TARGET');
  for (const p of match.order) match.handle(p.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_2' });
  assert.deepEqual(match.players.get('p0').tickets.map((v) => v.profession), ['TANK', 'CASTER', 'SNIPER']);
  const view = match.privateView('p0').mizuki;
  assert.equal(view.recruit.remaining, 3); assert.equal(view.recruit.ticket.profession, 'TANK');
  const expectedCandidates = [1, 2, 3, 4, 5, 6].reduce((sum, rarity) => sum + Math.min(MIZUKI_RECRUIT_RULES.candidatesPerRarity,
    match.fullCatalog.operators.filter((operator) => operator.rarity === rarity).length), 0);
  assert.equal(view.recruit.choices.length, expectedCandidates);
  assert.ok(view.recruit.choices.every((operator) => match.fullCatalog.byId.has(operator.operatorId)));

  const random = fixture(t, { count: 1 }).match; random.start(); voteSquad(random); pickStrategies(random);
  assert.deepEqual(random.handle('p0', { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_random' }), { ok: true });
  const randomTickets = random.players.get('p0').tickets;
  assert.equal(randomTickets.length, 3);
  assert.equal(randomTickets.filter((ticket) => ticket.kind === 'sixstar_free').length, 1);
  assert.equal(randomTickets.filter((ticket) => ticket.kind === 'normal').length, 2);
  const freeTicket = randomTickets.find((ticket) => ticket.kind === 'sixstar_free');
  assert.deepEqual(random.handle('p0', { t: 'g.mizuki.recruit', offerId: 'ticket:' + freeTicket.id }), { ok: true });
  assert.ok(random.privateView('p0').mizuki.recruit.choices.every((offer) => offer.rarity === 6));
});

test('full 218 entries use real E1 bodies and E2 promotion bodies including all 89 backups', () => {
  const c = createMizukiCatalog(DATA); assert.equal(c.report.entries, 218); assert.equal(c.report.characters, 210);
  assert.equal(c.report.normal, 129); assert.equal(c.report.extraDiy + c.report.extraStandin, 89); assert.deepEqual(c.report.unsupported, []);
  assert.equal(c.trainingReport.generated, 210); assert.deepEqual(c.trainingReport.errors, []);
  for (const o of c.operators) { assert.ok(c.source.getChess(o.operatorId).raw.status.phase <= 1);
    if (o.promotionChessId) assert.equal(c.source.getChess(o.promotionChessId).raw.status.phase, 2); }
  const kalts = c.source.getChess('mizuki_char_003_kalts');
  assert.deepEqual(kalts.raw.status, { phase: 1, level: 80, skillLevel: 7, equipLevel: 0 });
  assert.equal(kalts.raw.skills.length, 2); assert.equal(c.source.getChess(c.byId.get(kalts.id).promotionChessId).raw.skills.length, 3);
  const mon3tr = c.source.getToken('token_10002_kalts_mon3tr', kalts.id, kalts.loadout);
  assert.ok(mon3tr.stats.maxHp > 0); assert.ok(mon3tr.sources.includes('talent'));
});

test('Mizuki form wrapping leaves the original shared data and old-mode training untouched', () => {
  const original = structuredClone(DATA), before = JSON.stringify(original);
  const catalog = createMizukiCatalog(original);
  assert.equal(JSON.stringify(original), before);
  assert.notEqual(catalog.source.raw.chess, original.chess);
  const native = original.chess.chess_char_3_12_a;
  assert.equal(catalog.source.getChess(native.chessId).raw.status.phase, 1);
  assert.deepEqual(original.chess[native.chessId], native);
});

test('Mizuki token capacities include only their own original hidden talent blackboards', () => {
  const catalog = createMizukiCatalog(DATA), tokenId = 'token_10020_ling_soul3';
  const ling = catalog.operators.find((operator) => operator.charId === 'char_2023_ling');
  for (const [id, deckStack] of [[ling.operatorId, 4], [ling.promotionChessId, 5]]) {
    const token = catalog.source.getToken(tokenId, id, { skillIndex: id === ling.promotionChessId ? 2 : 1 });
    const variant = catalog.source.rawToken(tokenId).variants[id];
    assert.deepEqual(variant.hiddenTalentCapacityBonus, { deployLimit: 2, deckStack });
    assert.equal(variant.stats.deployLimit, 3); assert.equal(variant.stats.deckStack, deckStack);
    assert.equal(token.raw.variants[id].stats.deployLimit, 3); assert.equal(token.raw.variants[id].stats.deckStack, deckStack);
    const hidden = variant.talents.find((talent) => talent.hidden);
    assert.equal(hidden.bb.max_deploy_count, 2); assert.equal(hidden.bb.max_deck_stack_cnt, deckStack);
  }
  assert.match(catalog.trainingSource.hiddenTokenCapacity, /max_deploy_count/);
});

test('voucher and hope spending are atomic and private offers cannot be replayed or stolen', (t) => {
  const { match } = fixture(t, { count: 2 }); startRecruit(match);
  const other = match.privateView('p1').mizuki.recruit.choices[0];
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: other.offerId }).error, 'BAD_TARGET');
  const offer = match.privateView('p0').mizuki.recruit.choices.find((o) => o.hopeCost === 6);
  assert.ok(offer); assert.deepEqual(match.handle('p0', { t: 'g.mizuki.recruit', offerId: offer.offerId }), { ok: true });
  assert.equal(match.players.get('p0').hope, 0); assert.equal(match.players.get('p1').hope, 6);
  const before = structuredClone(match.players.get('p0'));
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: offer.offerId }).error, 'BAD_TARGET');
  const costly = match.privateView('p0').mizuki.recruit.choices.find((o) => o.hopeCost > 0);
  assert.equal(match.handle('p0', { t: 'g.mizuki.recruit', offerId: costly.offerId }).error, 'NO_FUNDS');
  assert.deepEqual(match.players.get('p0'), before);
});

test('selecting and skipping a voucher consumes exactly that one voucher with no hope cost', (t) => {
  const { match } = fixture(t, { count: 2 }); startRecruit(match); const p = match.players.get('p0');
  const ids = [...p.recruit.ticketIds]; match.handle('p0', { t: 'g.mizuki.recruit', offerId: 'ticket:' + ids[2] });
  assert.equal(p.recruit.activeTicketId, ids[2]);
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.recruit', offerId: match.privateView('p0').mizuki.recruit.skipToken }), { ok: true });
  assert.equal(p.tickets.find((v) => v.id === ids[2]).status, 'skipped'); assert.equal(p.hope, 6);
  assert.equal(match.privateView('p0').mizuki.recruit.remaining, 2);
});

test('an explicit advanced voucher upgrades the same UID using official hope cost and true E2 data', (t) => {
  const { match } = fixture(t, { count: 2 }); startRecruit(match, { squadId: 'rogue_2_band_3' }); const p = match.players.get('p0');
  const operator = match.fullCatalog.operators.find((value) => value.rarity === 4 && value.promotionChessId);
  assert.equal(match._addOperator(p, operator.operatorId), true);
  const uid = p.roster[0].uid;
  const ticket = createMizukiRecruitTicket({ id: p.recruit.ticketIds[0], profession: 'ANY', kind: 'advanced' });
  p.tickets[p.tickets.findIndex((value) => value.id === ticket.id)] = ticket;
  p.recruit.activeTicketId = ticket.id;
  match._refreshRecruit(p);
  const upgrade = match.privateView('p0').mizuki.recruit.choices.find((o) => o.operatorId === operator.operatorId);
  assert.ok(upgrade);
  assert.equal(upgrade.action, 'upgrade'); assert.equal(upgrade.hopeCost, 1); const hope = p.hope;
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.recruit', offerId: upgrade.offerId }), { ok: true });
  assert.equal(p.hope, hope - 1); assert.equal(p.roster.length, 1); assert.equal(p.roster[0].uid, uid);
  assert.equal(p.roster[0].promotion, 1); assert.equal(p.roster[0].formStatus.phase, 2); assert.equal(new Set(p.lineup).size, p.lineup.length);
});

test('only supported original levels enter the selector and no fabricated event shop or ending remains', (t) => {
  const { match, ended } = fixture(t); startRecruit(match); skipRecruit(match); importFixtureRoute(match);
  assert.ok(match.route.length > 0); assert.ok(match.route.every((n) => n.available && n.stageId.startsWith('ro2_')));
  assert.deepEqual(match.publicView().mizuki.unsupportedStages, []); assert.equal(match.publicView().mizuki.totalNodes, null);
  assert.equal(match.publicView().mizuki.completeExploration, false); assert.equal(ended.length, 0);
  assert.equal(match.handle('p0', { t: 'g.mizuki.route', nodeId: 'act1autochess_m01' }).error, 'BAD_TARGET');
  assert.equal(match.handle('p0', { t: 'g.mizuki.buy', offerId: 'operator_fake' }).error, 'WRONG_PHASE');
});

test('official first stage PREP preserves map cost and waves; cluster deploy bonus caps at nine independently of carry capacity', (t) => {
  const { match } = fixture(t); startRecruit(match, { squadId: 'rogue_2_band_2' }); recruitThree(match); chooseStage(match);
  assert.equal(match.squadCapacity, 8); assert.equal(match.fields.size, 4);
  for (const f of match.fields.values()) { assert.equal(f.engine.options.stageId, 'ro2_n_1_1');
    assert.equal(f.engine.options.deployLimit, 9); assert.equal(f.engine.options.flags.dpInit, 10); assert.equal(f.engine.options.officialLevel.waves.length, 2);
    assert.deepEqual(f.engine.options.rect, { r0: 0, r1: 5, c0: 0, c1: 8 }); assert.equal(f.engine.options.players[0].bandId, match.players.get(f.engine.options.players[0].playerId).bandId); }
});

test('acquired roster is unlimited while explicit carried lineup enforces official capacity', (t) => {
  const { match } = fixture(t); prepare(match); const p = match.players.get('p0');
  for (const o of match.fullCatalog.operators) { if (p.roster.length >= 9) break; match._addOperator(p, o.operatorId); }
  assert.equal(p.roster.length, 9); assert.equal(p.lineup.length, 6); assert.equal(match.privateView('p0').mizuki.maxRoster, null);
  assert.equal(match.handle('p0', { t: 'g.mizuki.lineup', uids: p.roster.slice(0, 7).map((u) => u.uid) }).error, 'BAD_TARGET');
  const selected = p.roster.slice(-2).map((u) => u.uid); assert.deepEqual(match.handle('p0', { t: 'g.mizuki.lineup', uids: selected }), { ok: true });
  assert.deepEqual(match.privateView('p0').mizuki.prep.hand.filter(Boolean).map((u) => u.uid).sort(), [...selected].sort());
  assert.deepEqual(match.fields.get(p.fieldId).engine.options.players[0].units, [], 'unplaced bench units never enter automatic battle');
});

test('automatic battle rejects combat deployment skills and retreat while waiting for every independent field', (t) => {
  const { match, scheduler } = fixture(t); prepare(match); const p = match.players.get('p0'); launch(match);
  // Prep-end original effects rebuild the battle input before simulation starts.
  const f = match.fields.get(p.fieldId);
  for (const type of ['deploy', 'skill', 'retreat']) assert.equal(match.handle('p0', { t: 'g.mizuki.' + type, battleId: f.battleId, uid: p.roster[0].uid, row: 1, col: 2, dir: 'RIGHT' }).error, 'WRONG_PHASE');
  assert.deepEqual(f.engine.commands, []);
  f.engine.done = true; scheduler.advance(FRAME_MS * 2); assert.equal(match.phase, PHASE.COMBAT);
  for (const field of [...match.fields.values()].slice(1, 3)) field.engine.done = true;
  scheduler.advance(FRAME_MS * 2); assert.equal(match.phase, PHASE.COMBAT);
  match.fields.get('n:p3').engine.done = true; scheduler.advance(FRAME_MS * 2); assert.equal(match.phase, PHASE.REWARD);
});

test('personal leakage settles once after battle and each shield absorbs only its owner damage', (t) => {
  const { match, scheduler } = fixture(t); startRecruit(match, { squadId: 'rogue_2_band_9' }); recruitThree(match); chooseStage(match); launch(match);
  const initialHealth = match.order.map(player => [player.life, player.shield]);
  assert.deepEqual(initialHealth, [[4, 3], [4, 3], [4, 3], [6, 3]], 'the fourth selected strategy grants its owner extra initial life');
  const a = match.fields.get('n:p0'), b = match.fields.get('n:p1'); a.engine.leaks = 2; b.engine.leaks = 2;
  scheduler.advance(FRAME_MS * 2); assert.deepEqual(match.order.map(player => [player.life, player.shield]), initialHealth, 'persistent health is not charged before settlement');
  a.engine.leaks = 4; finishFields(match, scheduler); assert.equal(match.phase, PHASE.REWARD);
  assert.deepEqual(match.order.map((player) => [player.life, player.shield]), [[3, 0], [4, 1], [4, 3], [6, 3]]);
  scheduler.advance(FRAME_MS * 3);
  assert.deepEqual(match.order.map((player) => [player.life, player.shield]), [[3, 0], [4, 1], [4, 3], [6, 3]]);
});

test('battle rewards grant recorded resources and advance only after one choice per reward group', (t) => {
  const { match, scheduler, ended } = fixture(t); prepare(match); const gold = match.order.map((p) => p.gold), hope = match.order.map((p) => p.hope), light = match.light;
  const commanderBefore = { ...match.commander };
  launch(match); finishFields(match, scheduler); assert.equal(match.phase, PHASE.REWARD);
  const rewardGold = match.order.map((p) => p.battleOutcome.rewards.gold);
  const hopeBonus = mizukiCommanderLevelRewards(commanderBefore.level, match.commander.level)
    .reduce((sum, reward) => sum + reward.populationUp, 0);
  assert.ok(match.order.every((p) => p.rewards.some((reward) => reward.type === 'recruitTicket'))); confirmRecord(match);
  assert.equal(match.phase, PHASE.ROUTE); assert.equal(match.completedNodes, 1);
  assert.deepEqual(match.order.map((p) => p.gold), gold.map((value, index) => value + rewardGold[index]));
  assert.deepEqual(match.order.map((p) => p.hope), hope.map((value) => value + hopeBonus)); assert.ok(match.commander.totalExp > commanderBefore.totalExp);
  assert.equal(match.light, light); assert.equal(ended.length, 0);
});

test('all offline freezes simulation and reconnect resends authoritative snapshot wire type', (t) => {
  const { match, scheduler, frames } = fixture(t); prepare(match); launch(match); for (const p of match.order) match.onDisconnect(p.playerId);
  scheduler.advance(1000); assert.ok([...match.fields.values()].every((f) => f.engine.ticks === 0));
  match.onReconnect('p0'); scheduler.advance(FRAME_MS * 4); assert.ok([...match.fields.values()].every((f) => f.engine.ticks > 0));
  assert.ok(frames.some((f) => f.playerId === 'p0' && f.message.t === 'b.snap' && typeof f.message.time === 'number'));
});

test('all startup checkpoints restore canonical choices and reject altered official IDs', (t) => {
  const { match } = fixture(t, { count: 2 }); match.start(); const checkpoints = [match.exportCheckpoint()];
  voteSquad(match); checkpoints.push(match.exportCheckpoint()); pickStrategies(match); checkpoints.push(match.exportCheckpoint());
  for (const doc of checkpoints) { const restored = fixture(t, { count: 2 }).match; assert.equal(restored.restoreCheckpoint(doc), true); assert.equal(restored.phase, doc.phase); }
  const bad = structuredClone(checkpoints[1]); bad.mizuki.squadId = 'invented'; assert.equal(fixture(t, { count: 2 }).match.restoreCheckpoint(bad), false);
});

test('recruit checkpoints preserve pending vouchers hope forms layers and do not spend twice', (t) => {
  const { match } = fixture(t, { count: 2 }); startRecruit(match); const offer = match.privateView('p0').mizuki.recruit.choices[0]; match.handle('p0', { t: 'g.mizuki.recruit', offerId: offer.offerId });
  match.players.get('p0').layers.visiShip = 37; match.players.get('p0').layers.soloShip = 77;
  const doc = match.exportCheckpoint(); const restored = fixture(t, { count: 2 }).match;
  assert.equal(restored.restoreCheckpoint(doc), true); assert.deepEqual(restored.players.get('p0').tickets, match.players.get('p0').tickets);
  assert.equal(restored.players.get('p0').hope, match.players.get('p0').hope); assert.equal(restored.players.get('p0').layers.visiShip, 37);
  assert.equal(restored.players.get('p0').layers.soloShip, undefined, 'restore removes obsolete 独行 layers');
  assert.equal(restored.handle('p0', { t: 'g.mizuki.recruit', offerId: offer.offerId }).error, 'BAD_TARGET');
});

test('combat checkpoint rolls back to PREP retains authoritative offline identity and invalidates old commands', (t) => {
  const { match, scheduler } = fixture(t); prepare(match); match.players.get('p0').layers.visiShip = 37;
  match.handle('p0', { t: 'g.mizuki.lineup', uids: match.players.get('p0').lineup }); const oldId = match.fields.get('n:p0').battleId; launch(match); scheduler.advance(FRAME_MS * 3);
  const doc = match.exportCheckpoint(); assert.equal(doc.phase, PHASE.PREP);
  const seats = match.order.map((p) => ({ ...p, connected: false })); const restored = fixture(t, { seats }).match; assert.equal(restored.restoreCheckpoint(doc), true);
  assert.ok(restored.order.every((p) => !p.connected)); assert.equal(restored.players.get('p0').layers.visiShip, 37); assert.notEqual(restored.fields.get('n:p0').battleId, oldId);
});

test('native economic layer milestones settle only once including after restore', (t) => {
  const { match } = fixture(t, { count: 2 }); startRecruit(match); const p = match.players.get('p0');
  match._addOperator(p, 'chess_char_1_11_a'); match._addOperator(p, 'chess_char_2_02_a'); p.layers.visiShip = 25;
  const gold = p.gold, hope = p.hope;
  match._settleEconomicBonds(p); assert.equal(p.gold, gold); assert.equal(p.hope, hope); assert.equal(p.economicCoinRemainder, 4);
  match._settleEconomicBonds(p); assert.equal(p.economicCoinTotal, 4); assert.equal(p.gold, gold);
  const doc = match.exportCheckpoint(); const restored = fixture(t, { count: 2 }).match; assert.equal(restored.restoreCheckpoint(doc), true);
  const rp = restored.players.get('p0'); restored._settleEconomicBonds(rp); assert.equal(rp.gold, p.gold);
  rp.layers.visiShip = 35; restored._settleEconomicBonds(rp);
  assert.equal(rp.gold, gold); assert.equal(rp.hope, hope + 1); assert.equal(rp.economicCoinRemainder, 1); assert.equal(rp.economicCoinTotal, 6);
});

test('genuine deployment layers survive official wave settlement next stage and PREP restore', (t) => {
  const { match, scheduler } = fixture(t, { count: 2, realCombat: true });
  startRecruit(match); skipRecruit(match); const player = match.players.get('p0');
  for (const id of ['chess_char_2_12_a', 'chess_char_6_17_a', 'chess_char_3_12_a']) assert.equal(match._addOperator(player, id), true);
  // Personal HP reserves isolate persistence from deliberately unattended waves.
  for (const member of match.order) member.life = member.maxLife = 9999;
  chooseStage(match);
  const place = (m, uid) => {
    const prep = m.privateView('p0').mizuki.prep;
    const tile = prep.legalTiles[uid].find(([row, col]) => !prep.board.some((piece) => piece.row === row && piece.col === col));
    assert.ok(tile);
    assert.equal(m.handle('p0', { t: 'g.mizuki.move', uid, to: { area: 'board', row: tile[0], col: tile[1] }, dir: 'RIGHT' }).ok, true);
  };
  for (const unit of player.roster) place(match, unit.uid);
  launch(match);
  scheduler.advance(FRAME_MS * 2);
  const openingLayers = player.layers.kazimierzShip;
  assert.ok(openingLayers >= 4, 'actual automatic deployment earns native covenant and garrison layers');
  const first = match.fields.get('n:p0').engine;
  for (let seconds = 0; seconds < 600 && match.phase === PHASE.COMBAT; seconds++) scheduler.advance(1000);
  assert.equal(match.phase, PHASE.REWARD); assert.equal(first.result().outcome, 'victory');
  const settledLayers = player.layers.kazimierzShip;
  assert.equal(first.result().progression.players.p0.layers.kazimierzShip, settledLayers);
  confirmRecord(match); chooseStage(match, 'ro2_n_1_2');
  assert.equal(match.fields.get('n:p0').engine.snapshot().progression.players.p0.layers.kazimierzShip, settledLayers);
  const nextBoard = structuredClone(match.privateView('p0').mizuki.prep.board);
  const checkpoint = match.exportCheckpoint(), gold = player.gold;
  const restored = fixture(t, { count: 2, realCombat: true }).match;
  assert.equal(restored.restoreCheckpoint(checkpoint), true);
  assert.equal(restored.players.get('p0').layers.kazimierzShip, settledLayers);
  assert.equal(restored.players.get('p0').gold, gold);
  assert.equal(restored.fields.get('n:p0').engine.snapshot().progression.players.p0.layers.kazimierzShip, settledLayers);
  assert.deepEqual(restored.privateView('p0').mizuki.prep.board, nextBoard, 'restore retains all positions legal on the next original map');
  for (const unit of restored.players.get('p0').roster) if (!restored.players.get('p0').prep.board.some((piece) => piece.uid === unit.uid)) place(restored, unit.uid);
  launch(restored);
  restored._tickBattle();
  assert.ok(restored.players.get('p0').layers.kazimierzShip >= settledLayers + 4, 'next official battle starts with fresh native earning cap');
  assert.equal(restored.fields.get('n:p0').engine.battle.errorCount, 0);
});

test('Match prepares real E1 owner and summon without granting teammate ownership or combat commands', (t) => {
  const { match } = fixture(t, { count: 2, realCombat: true });
  startRecruit(match); skipRecruit(match); const player = match.players.get('p0');
  assert.equal(match._addOperator(player, 'mizuki_char_003_kalts'), true); chooseStage(match);
  const bench = () => { const prep = match.privateView('p0').mizuki.prep; return [...prep.hand, ...prep.temp].filter(Boolean); };
  const owner = bench().find((unit) => unit.kind === 'chess');
  assert.equal(player.roster[0].formStatus.phase, 1);
  assert.equal(bench().some((unit) => unit.kind === 'token'), false, 'owner must be on board before summon exists');
  const command = (playerId, unit) => {
    const prep = match.privateView('p0').mizuki.prep;
    const tile = prep.legalTiles[unit.uid].find(([row, col]) => !prep.board.some((piece) => piece.row === row && piece.col === col));
    assert.ok(tile);
    return match.handle(playerId, { t: 'g.mizuki.move', uid: unit.uid, to: { area: 'board', row: tile[0], col: tile[1] }, dir: 'RIGHT' });
  };
  assert.equal(command('p0', owner).ok, true);
  const summon = bench().find((unit) => unit.kind === 'token');
  assert.ok(summon); assert.equal(summon.id, 'token_10002_kalts_mon3tr');
  assert.equal(command('p1', summon).error, 'BAD_TARGET');
  assert.equal(command('p0', summon).ok, true);
  const field = match.fields.get('n:p0'), combat = field.engine;
  const ownerInput = combat.battle.players.find((entry) => entry.playerId === 'p0').input.units;
  assert.ok(ownerInput.some((unit) => unit.kind === 'token' && unit.tokenId === summon.id && unit.uid === summon.uid));
  assert.ok(match.fields.get('n:p1').engine.battle.players.every((entry) => entry.input.units.every((unit) => unit.uid !== summon.uid)));
  launch(match); match._tickBattle();
  assert.equal(match.handle('p0', { t: 'g.mizuki.retreat', battleId: field.battleId, uid: summon.uid }).error, 'WRONG_PHASE');
  assert.equal(combat.battle.errorCount, 0);
});

test('official squad effects are applied once and unresolved raw rules stay explicitly marked', (t) => {
  for (const squad of MIZUKI_SQUADS) { const { match } = fixture(t, { count: 2 }); match.start(); voteSquad(match, squad.id);
    assert.equal(match.selectedSquad.id, squad.id); assert.ok(match.diceId.startsWith('rogue_2_dice_'));
    const view = match.publicView().mizuki.selectedSquad; assert.equal(view.effects.length, squad.effects.length);
    if (squad.effects.some((e) => e.key === 'direct_upgrade')) assert.ok(view.effectSupport.some((e) => e.key === 'direct_upgrade' && e.implemented));
    if (squad.id === 'rogue_2_band_4') { assert.ok(match.order.every((player) => player.life === 1)); assert.deepEqual(match.squadMods, { atkPct: 0.15, defPct: 0, hpPct: 0.15 }); }
  }
  assert.deepEqual(MIZUKI_RECRUIT_RULES.hopeByRarity, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 3, 6: 6 });
});

test('aborted engine never grants a reward or fabricated success', (t) => {
  const { match, scheduler, ended } = fixture(t); prepare(match); launch(match); const f = match.fields.get('n:p0'); f.engine.done = true; f.engine.outcome = 'aborted';
  scheduler.advance(FRAME_MS * 2); assert.equal(match.phase, PHASE.RESULT); assert.equal(ended.length, 1); assert.equal(ended[0].victory, false); assert.equal(ended[0].reason, 'combat_aborted');
  match.onLeave('p0'); scheduler.advance(1000); assert.equal(ended.length, 1); assert.ok(match.order.every((p) => !p.rewards.length));
});
