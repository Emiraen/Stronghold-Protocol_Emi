import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { Grid } from '../server/sim/grid.js';
import { grantMizukiEquipment } from '../server/modes/mizuki/Equipment.js';
import { rollMizukiEquipmentDrop } from '../server/modes/mizuki/Equipment.js';
import { createMizukiExplorationState } from '../server/modes/mizuki/exploration.js';
import { createRng } from '../server/sim/rng.js';
import { createMizukiRecruitTicket } from '../server/modes/mizuki/Recruitment.js';
import { mizukiCommanderLevelRewards } from '../server/modes/mizuki/Difficulty.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } }), FRAME = 1000 / 30;
const HAMMER = 'chess_item_1_01_e_a', SHIELD = 'chess_item_1_02_e_a', COIN = 'chess_item_1_03_e_a';
const DOCUMENT = 'chess_item_6_08_e_a', PROJECTION = 'chess_item_5_06_e_a';
const SPLIT_DUNGEON = { zones: [{ id: 'zone_1', nodes: [
  { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [{ x: 1, y: 0 }] },
  { pos: { x: 0, y: 1 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [{ x: 1, y: 1 }] },
  { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [] },
  { pos: { x: 1, y: 1 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
] }] };
const command = (match, playerId, message) => {
  const result = match.handle(playerId, message);assert.equal(result.ok, true, JSON.stringify(result));return result;
};
const totalItems = player => player.equipmentInventory.length + player.roster.reduce((sum, unit) => sum + (unit.items?.length || 0), 0);
const copy = value => JSON.parse(JSON.stringify(value));

class EconomicCombat {
  constructor(options) {
    this.options = options;this.done = false;this.ticks = 0;this.deployLimit = options.deployLimit;
    this.battle = { grid: new Grid(options.stage, options.rect) };
    this.economicCoins = Object.fromEntries(options.players.map(({ playerId }) => [playerId, 0]));
    this.rows = Object.fromEntries(options.players.map(({ playerId }) => [playerId, { perfect: false, leaked: [], leaderLpLoss: 0 }]));
  }
  step() { this.ticks++; }
  result() {
    return this.done ? { outcome: 'victory', perPlayer: Object.fromEntries(Object.entries(this.rows)
      .map(([id, row]) => [id, { ...row, coins: this.economicCoins[id] }])),
    leakedCount: Object.values(this.rows).reduce((sum, row) => sum + row.leaked.length, 0) } : null;
  }
  snapshot() {
    return { battleId: this.options.battleId, fieldId: this.options.fieldId, tick: this.ticks, t: this.ticks / 30,
      units: [], rosters: Object.fromEntries(this.options.players.map(({ playerId }) => [playerId, []])), covenants: {},
      leakedCount: this.result()?.leakedCount || 0, done: this.done,
      geometry: { rows: 19, cols: 21, rect: this.options.rect, tiles: [] } };
  }
  fieldMeta() { return { fieldId: this.options.fieldId, stageId: this.options.stageId, units: [] }; }
  drainEvents() { return []; }
  forceEnd() { this.done = true; }
  dispose() {}
}

function fixture(t, { count = 2, realCombat = false, ...extra } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [];
  const options = { roomCode: 'EQMT', hostId: 'p0', seed: 512, data: DATA, scheduler,
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    ...(realCombat ? {} : { CombatClass: EconomicCombat }),
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) }, send() {}, broadcast() {}, onEnd() {}, ...extra };
  const match = new MizukiMatch(options);t.after(() => { match.dispose();scheduler.dispose(); });
  return { match, scheduler, errors, options };
}
function enterRoute(match) {
  match.start();
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_3' });
  const quiet = match.strategyOptions.filter(option => DATA.bands[option.bandId]?.buffs?.every(buff => buff.key === 'env_gbuff_new_with_verify'));
  assert.ok(quiet.length >= match.order.length);
  for (const [index, player] of match.order.entries()) command(match, player.playerId, { t: 'g.mizuki.strategy', bandId: quiet[index].bandId });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match);assert.equal(match.phase, PHASE.ROUTE);
}
function prepare(match) {
  const node = match.route.find(value => value.available && value.type === 'combat');assert.ok(node);
  for (const player of match._active()) command(match, player.playerId, { t: 'g.mizuki.route', nodeId: node.id });
  command(match, match.hostId, { t: 'g.mizuki.routeStart' });assert.equal(match.phase, PHASE.PREP);
}
function launch(match) {
  for (const player of match._active()) command(match, player.playerId, { t: 'g.mizuki.ready', on: true });
  assert.equal(match.phase, PHASE.COMBAT);
}
function finish(match, scheduler) {
  for (const field of match.fields.values()) field.engine.done = true;
  scheduler.advance(FRAME * 2);
}
function selectRewardGroups(match, players = match._active()) {
  for (const player of players) for (const group of new Set(player.rewards.filter(value => value.group).map(value => value.group))) {
    const reward = player.rewards.find(value => value.group === group);
    command(match, player.playerId, { t: 'g.mizuki.reward', rewardId: reward.id });
  }
}
function nextRoute(match) {
  selectRewardGroups(match);
  skipMizukiRecruit(match);
}
function unit(match, player) {
  assert.equal(match._addOperator(player, 'chess_char_1_02_a'), true);
  return player.roster.find(value => value.operatorId === 'chess_char_1_02_a');
}
function grant(match, player, id) {
  const result = grantMizukiEquipment(player, id, match._equipmentOptions(player));
  assert.equal(result.ok, true, JSON.stringify(result));return result.item.uid;
}
function equip(match, player, itemUid, targetUid, extra = {}) {
  return match.handle(player.playerId, { t: 'g.mizuki.equip', itemUid, targetUid, ...extra });
}

test('actual Match combines trait, equipment and battle coins at five to one while keeping ingots personal', (t) => {
  const { match, scheduler, errors } = fixture(t);enterRoute(match);
  const player = match.order[0], other = match.order[1], holder = unit(match, player);
  const gold = match.order.map(value => value.gold), hope = match.order.map(value => value.hope);
  match._metaContext(player).addPendingFunds(2);
  const coin = grant(match, player, COIN);assert.equal(equip(match, player, coin, holder.uid).ok, true);
  prepare(match);launch(match);
  const field = match.fields.get('n:p0');field.engine.economicCoins.p0 = 2;
  scheduler.advance(FRAME * 2);
  assert.equal(player.economicCoinTotal, 5);assert.equal(player.economicCoinRemainder, 0);
  assert.equal(player.hope, hope[0] + 1);assert.equal(other.hope, hope[1]);
  assert.deepEqual(match.order.map(value => value.gold), gold);
  finish(match, scheduler);assert.equal(player.economicCoinTotal, 5);
  assert.deepEqual(errors, []);
});

test('live combat high-water survives reconnect and checkpoint rewind without paying the same coins again', (t) => {
  const { match, scheduler } = fixture(t);enterRoute(match);prepare(match);launch(match);
  const player = match.order[0], field = match.fields.get('n:p0'), gold = player.gold, hope = player.hope;
  field.engine.economicCoins.p0 = 4;match._creditCombatEconomy(field);match._creditCombatEconomy(field);
  assert.equal(player.economicCoinTotal, 4);assert.equal(player.hope, hope);
  match.onDisconnect('p0');match.onReconnect('p0');scheduler.advance(FRAME * 2);
  assert.equal(player.economicCoinTotal, 4);
  const saved = copy(match.exportCheckpoint()), restored = fixture(t).match;
  assert.equal(restored.restoreCheckpoint(saved), true);assert.equal(restored.phase, PHASE.PREP);
  const next = restored.players.get('p0');assert.equal(next.economicCoinTotal, 4);assert.equal(next.gold, gold);
  launch(restored);const replay = restored.fields.get('n:p0');assert.equal(replay.kind, field.kind);
  replay.engine.economicCoins.p0 = 4;restored._creditCombatEconomy(replay);
  assert.equal(next.economicCoinTotal, 4);assert.equal(next.hope, hope);
  replay.engine.economicCoins.p0 = 8;restored._creditCombatEconomy(replay);restored._creditCombatEconomy(replay);
  assert.equal(next.economicCoinTotal, 8);assert.equal(next.hope, hope + 1);assert.equal(next.gold, gold);
});

test('completed node settlements grant one personal equipment reward every second battle', (t) => {
  const { match, scheduler, errors } = fixture(t);enterRoute(match);
  const gold = match.order.map(player => player.gold);
  prepare(match);launch(match);finish(match, scheduler);
  assert.equal(match.phase, PHASE.REWARD);
  assert.deepEqual(match.order.map(player => player.equipmentBattlesCompleted), [1, 1]);
  assert.deepEqual(match.order.map(totalItems), [0, 0]);
  nextRoute(match);prepare(match);launch(match);finish(match, scheduler);
  assert.deepEqual(match.order.map(player => player.equipmentBattlesCompleted), [2, 2]);
  assert.deepEqual(match.order.map(totalItems), [1, 1]);
  const before = copy(match.order.map(player => [player.equipmentBattleIds, player.equipmentInventory]));
  scheduler.advance(FRAME * 5);assert.deepEqual(match.order.map(player => [player.equipmentBattleIds, player.equipmentInventory]), before);
  assert.deepEqual(match.order.map(player => player.gold), gold.map(value => value + 4));assert.deepEqual(errors, []);
});

test('a player eliminated on its second battle receives no equipment while its survivor does', (t) => {
  const { match, scheduler, errors } = fixture(t);enterRoute(match);prepare(match);launch(match);
  for (const player of match.order) { player.equipmentBattlesCompleted = 1;player.equipmentBattleIds = ['earlier-battle']; }
  const dead = match.players.get('p0'), alive = match.players.get('p1');
  match.fields.get('n:p0').engine.rows.p0.leaked.push({ sourcePlayerId: 'p0', enemyKey: 'fixture', counted: true, lpr: dead.life });
  finish(match, scheduler);
  assert.equal(dead.alive, false);assert.equal(totalItems(dead), 0);assert.equal(dead.equipmentBattlesCompleted, 1);
  assert.equal(alive.alive, true);assert.equal(alive.equipmentBattlesCompleted, 2);assert.equal(totalItems(alive), 1);
  assert.deepEqual(errors, []);
});

test('real rescue belongs to the same completed battle and cannot create an extra drop or coin payout', (t) => {
  const { match, scheduler, errors } = fixture(t, { realCombat: true });enterRoute(match);
  for (const player of match.order) { player.equipmentBattlesCompleted = 1;player.equipmentBattleIds = ['earlier-battle'];unit(match, player); }
  prepare(match);
  for (const player of match.order) {
    const field = match.fields.get(player.fieldId), holder = player.roster[0], grid = field.engine.battle.grid;
    const tile = field.engine.snapshot().geometry.tiles.find(value => grid.canStand(value.row, value.col, { ranged: holder.position === 'RANGED' }));
    assert.ok(tile);command(match, player.playerId, { t: 'g.mizuki.move', uid: holder.uid,
      to: { area: 'board', row: tile.row, col: tile.col }, dir: 'RIGHT' });
  }
  launch(match);
  const source = match.fields.get('n:p1'), battle = source.engine.battle;battle.start();
  const key = battle._pending[0]?.enemyKey || source.engine.officialWaves.waves[0].fragments[0].actions.find(entry => entry.action.key)?.action.key;
  const enemy = battle.spawnEnemy(key, { route: source.setup.routes[0], mods: { bountyCoins: 3 },
    bounty: { coins: 3, ownerPlayerId: 'p1' } });assert.ok(enemy);battle.leak(enemy);
  match.fields.get('n:p0').engine.battle.addCoins('p0', 2);
  for (const field of match.fields.values()) { field.engine.battle.start();field.engine.battle.forceEnd('cleared'); }
  scheduler.advance(FRAME * 2);
  const rescue = [...match.fields.values()].find(field => field.kind === 'unite');assert.ok(rescue);
  assert.deepEqual(match.order.map(player => player.equipmentBattlesCompleted), [1, 1]);
  assert.deepEqual(match.order.map(totalItems), [0, 0]);
  for (let n = 0; n < 1200 && !rescue.engine.battle.enemies.some(value => !value._officialFacility); n++) rescue.engine.step();
  const replay = rescue.engine.battle.enemies.find(value => !value._officialFacility);assert.ok(replay);
  assert.deepEqual(replay.bounty, { coins: 3, ownerPlayerId: 'p1' });
  const helper = rescue.engine.battle.getPlayer('p0').units[0];assert.ok(helper);
  rescue.engine.battle.kill(replay, helper);rescue.engine.battle.forceEnd('cleared');
  scheduler.advance(FRAME * 2);assert.equal(match.phase, PHASE.REWARD);
  assert.deepEqual(match.order.map(player => player.equipmentBattlesCompleted), [2, 2]);
  assert.deepEqual(match.order.map(totalItems), [1, 1]);assert.equal(match.order[0].economicCoinTotal, 5);
  assert.equal(match.order[1].economicCoinTotal, 0, 'the helper owns its kill bounty; leak source owns only life loss');
  scheduler.advance(FRAME * 5);assert.equal(match.order[0].economicCoinTotal, 5);assert.deepEqual(errors, []);
});

test('Match stage selection advances original equipment rarity and treats inserted special floors separately', (t) => {
  const { match } = fixture(t);enterRoute(match);
  const player = match.order[0], state = match.partyStates.get(match.expedition.partyFor('p0').id);
  state.archiveMode = true;
  for (const [completed, expected] of [[0, 1], [2, 2], [4, 3], [10, 6], [20, 6]]) {
    player.equipmentBattlesCompleted = completed;player.equipmentBattleIds = Array.from({ length: completed }, (_, i) => 'past-' + i);
    assert.equal(match._equipmentOptions(player).stage, expected);
  }
  state.archiveMode = false;
  const ordinary = Object.fromEntries(['zone_1', 'zone_2', 'zone_3', 'zone_4', 'zone_5', 'zone_7'].map((id, i) => ['floor' + i,
    { id, zoneType: 'NORMAL', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] }]));
  const special = { id: 'zone_7', zoneType: 'SP', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] };
  const dungeon = { zones: { floor0: ordinary.floor0, special, ...Object.fromEntries(Object.entries(ordinary).slice(1)) } };
  state.archiveMode = false;state.explorationState = createMizukiExplorationState(dungeon);
  const seen = new Map();
  for (const [zoneKey, expected] of [['floor0', 1], ['special', 1], ['floor1', 2], ['floor5', 6]]) {
    state.explorationState.zoneKey = zoneKey;
    const options = match._equipmentOptions(player);assert.equal(options.stage, expected);
    const rng = createRng(91), tiers = new Set();
    for (let n = 0; n < 1000; n++) tiers.add(match.gd.item(rollMizukiEquipmentDrop({ ...options, rng })).tier);
    seen.set(zoneKey, [...tiers].sort());
  }
  assert.deepEqual(seen.get('floor0'), [1]);assert.deepEqual(seen.get('special'), [1]);
  assert.deepEqual(seen.get('floor5'), [1, 2, 3, 4, 5, 6]);
});

test('actual Mlynar recruitment purchases preserve pending timing and combine with remainder next prep', (t) => {
  const { match, scheduler } = fixture(t);enterRoute(match);
  const player = match.order[0];
  const band = Object.values(DATA.bands).find(value => value.buffs?.some(buff => buff.key === 'round_start_gain_coin_by_bond_char_chess_buy'));
  player.bandId = band.bandId;prepare(match);launch(match);finish(match, scheduler);
  selectRewardGroups(match);
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.RECRUIT);
  const gold = player.gold;
  player.hope = 100;match._grantEconomicHope(player, 4);
  const tickets = Array.from({ length: 3 }, (_, index) => createMizukiRecruitTicket({
    id: 'mlynar-p' + player.seat + 't' + index, profession: 'ANY', kind: 'advanced' }));
  player.tickets.push(...tickets);player.recruit.ticketIds = tickets.map(value => value.id);
  player.recruit.activeTicketId = tickets[0].id;match._refreshRecruit(player);
  const eligible = match.privateView('p0').mizuki.recruit.choices.filter(value => value.bonds.includes('kazimierzShip')
    && value.promotionChessId && !value.garrisonIds?.some(id => DATA.garrisons[id]?.effectKey?.startsWith('SERVER_ONCE_GOLD')));
  assert.ok(eligible.length >= 3, 'the full-selection voucher contains three eligible Kazimierz operators');
  const selected = new Set();
  for (let n = 0; n < 3; n++) {
    const current = match.privateView('p0').mizuki.recruit;
    const offer = current.choices.find(value => eligible.some(candidate => candidate.operatorId === value.operatorId) && !selected.has(value.operatorId));
    assert.ok(offer, 'latest advanced page contains another eligible Kazimierz operator at purchase ' + n);
    selected.add(offer.operatorId);
    command(match, 'p0', { t: 'g.mizuki.recruit', offerId: offer.offerId, requestId: 'mlynar-buy-' + n });
  }
  assert.equal(player.economicCoinTotal, 4);assert.equal(player.equipmentPendingFunds, 3);
  skipMizukiRecruit(match);assert.equal(match.phase, PHASE.ROUTE);
  const hope = player.hope;prepare(match);
  assert.equal(player.economicCoinTotal, 7);assert.equal(player.equipmentPendingFunds, 0);
  assert.equal(player.economicCoinRemainder, 2);assert.equal(player.hope, hope + 1);assert.equal(player.gold, gold);
});

test('actual dismissal fires the original sale coin trait separately from its hope refund', (t) => {
  const { match, scheduler } = fixture(t);enterRoute(match);prepare(match);launch(match);finish(match, scheduler);nextRoute(match);
  const player = match.order[0], gold = player.gold;
  const operator = match.fullCatalog.operators.find(value => value.garrisonIds?.some(id => DATA.garrisons[id]?.eventType === 'SERVER_CHESS_SOLD'
    && DATA.garrisons[id]?.effectKey === 'SERVER_ONCE_GOLD'));
  assert.ok(operator);assert.equal(match._addOperator(player, operator.operatorId), true);
  const holder = player.roster.find(value => value.operatorId === operator.operatorId);
  const trait = holder.garrisonIds.map(id => DATA.garrisons[id]).find(value => value.eventType === 'SERVER_CHESS_SOLD' && value.effectKey === 'SERVER_ONCE_GOLD');
  const hammer = grant(match, player, HAMMER);assert.equal(equip(match, player, hammer, holder.uid).ok, true);
  const hope = player.hope, coins = player.economicCoinTotal;
  command(match, 'p0', { t: 'g.mizuki.dismiss', uid: holder.uid, requestId: 'sale-trait' });
  assert.equal(player.hope, hope + 1);assert.equal(player.economicCoinTotal, coins);
  assert.equal(player.equipmentPendingFunds, trait.bb.count);assert.equal(player.roster.some(value => value.uid === holder.uid), false);
  assert.equal(player.equipmentInventory.some(item => item.uid === hammer), true);
  prepare(match);assert.equal(player.economicCoinTotal, coins + trait.bb.count);assert.equal(player.equipmentPendingFunds, 0);
  assert.equal(player.gold, gold);
});

test('actual pager choice persists, rejects invalid selection and grants its selected operator once for free', (t) => {
  const { match } = fixture(t);enterRoute(match);
  const player = match.order[0], holder = unit(match, player), gold = player.gold;
  const pager = grant(match, player, 'chess_item_4_01_e_a');
  assert.equal(equip(match, player, pager, holder.uid).ok, true);assert.equal(player.equipmentOffers.length, 1);
  const offer = player.equipmentOffers[0];assert.equal(offer.kind, 'chess');assert.ok(offer.choices.length > 0);
  const before = copy(player);
  assert.equal(match.handle('p0', { t: 'g.mizuki.equipmentPick', offerId: offer.id, operatorId: 'invalid' }).error, 'BAD_TARGET');assert.deepEqual(player, before);
  match._commit();const restored = fixture(t).match;assert.equal(restored.restoreCheckpoint(copy(match.exportCheckpoint())), true);
  const next = restored.players.get('p0'), hope = next.hope, selected = offer.choices[0];
  command(restored, 'p0', { t: 'g.mizuki.equipmentPick', offerId: offer.id, operatorId: selected, requestId: 'pager-choice' });
  assert.equal(next.equipmentOffers.length, 0);assert.equal(next.roster.some(value => value.operatorId === selected), true);
  assert.ok(next.hope >= hope);assert.equal(next.gold, gold);
  const committed = copy(next);
  assert.equal(restored.handle('p0', { t: 'g.mizuki.equipmentPick', offerId: offer.id, operatorId: selected, requestId: 'pager-choice' }).error, 'BAD_TARGET');
  assert.deepEqual(next, committed);
});

test('actual beacon returns equipment, resolves the free choice and sends its original operator next preparation once', (t) => {
  const { match } = fixture(t);enterRoute(match);
  const player = match.order[0], recipient = match.order[1], holder = unit(match, player), gold = match.order.map(value => value.gold);
  const hammer = grant(match, player, HAMMER);assert.equal(equip(match, player, hammer, holder.uid).ok, true);
  const beacon = grant(match, player, 'chess_item_5_04_e_a'), recipientBefore = copy(recipient);
  assert.equal(equip(match, player, beacon, holder.uid).ok, true);
  assert.deepEqual(recipient, recipientBefore, 'equipping the beacon cannot mutate a teammate transaction');
  assert.equal(player.roster.length, 0);assert.equal(player.equipmentInventory.some(item => item.uid === hammer), true);
  assert.equal(player.equipmentOffers.length, 1);assert.equal(player.equipmentEffects[0].key, 'effect:builtin_gift');
  const offer = player.equipmentOffers[0];
  command(match, 'p0', { t: 'g.mizuki.equipmentPick', offerId: offer.id, operatorId: offer.choices[0], requestId: 'beacon-choice' });
  assert.equal(player.roster.length, 1);assert.equal(player.equipmentOffers.length, 0);assert.equal(recipient.roster.length, 0);
  prepare(match);
  assert.equal(recipient.roster.some(value => value.operatorId === holder.operatorId), true);
  assert.equal(player.equipmentEffects.some(ref => ref.key === 'effect:builtin_gift'), false);
  assert.equal(player.equipmentGiftOutbox.length, 0);assert.equal(player.equipmentInventory.some(item => item.uid === hammer), true);
  const received = copy(recipient.roster);match._flushEquipmentGifts(player);assert.deepEqual(recipient.roster, received);
  assert.deepEqual(match.order.map(value => value.gold), gold);
});

test('cross-party beacon queues while its recipient fights and checkpoint recovery retains the undelivered gift', (t) => {
  const { match, scheduler } = fixture(t, { dungeon: SPLIT_DUNGEON });enterRoute(match);
  const sender = match.players.get('p0'), recipient = match.players.get('p1'), holder = unit(match, sender);
  const choices = match.route.filter(node => node.available && node.type === 'combat').slice(0, 2);assert.equal(choices.length, 2);
  command(match, 'p0', { t: 'g.mizuki.route', nodeId: choices[0].id });
  command(match, 'p1', { t: 'g.mizuki.route', nodeId: choices[1].id });
  const request = command(match, 'p1', { t: 'g.mizuki.splitRequest', nodeId: choices[1].id });
  command(match, 'p0', { t: 'g.mizuki.splitDecide', requestId: request.request.id, approve: true });
  command(match, 'p0', { t: 'g.mizuki.routeStart' });
  assert.notEqual(match.expedition.partyFor('p0').id, match.expedition.partyFor('p1').id);
  command(match, 'p1', { t: 'g.mizuki.ready', on: true });
  const recipientState = match.partyStates.get(match.expedition.partyFor('p1').id);
  assert.equal(recipientState.phase, PHASE.COMBAT);
  const commanderBefore = match.commander.level;
  const untouchedRecipient = copy(recipient), untouchedSafe = copy(recipientState.safePlayers);
  const beacon = grant(match, sender, 'chess_item_5_04_e_a');
  assert.equal(equip(match, sender, beacon, holder.uid).ok, true);
  const offer = sender.equipmentOffers[0];
  command(match, 'p0', { t: 'g.mizuki.equipmentPick', offerId: offer.id, operatorId: offer.choices[0] });
  assert.deepEqual(recipient, untouchedRecipient);assert.deepEqual(recipientState.safePlayers, untouchedSafe);
  command(match, 'p0', { t: 'g.mizuki.ready', on: true });
  match.fields.get('n:p0').engine.done = true;scheduler.advance(FRAME * 2);
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.REWARD);
  selectRewardGroups(match, [match.players.get('p0')]);skipMizukiRecruit(match, ['p0']);
  const nextNode = match.privateView('p0').mizuki.route.find(node => node.available && node.type === 'combat');assert.ok(nextNode);
  command(match, 'p0', { t: 'g.mizuki.route', nodeId: nextNode.id });command(match, 'p0', { t: 'g.mizuki.routeStart' });
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.PREP);
  assert.equal(sender.equipmentGiftOutbox.length, 1);assert.equal(sender.equipmentEffects.some(ref => ref.key === 'effect:builtin_gift'), false);
  const commanderRewards = mizukiCommanderLevelRewards(commanderBefore, match.commander.level);
  const sharedHope = commanderRewards.reduce((sum, reward) => sum + reward.populationUp, 0);
  assert.ok(sharedHope > 0, 'the other branch receives the shared commander upgrade while still fighting');
  const withCommanderReward = previous => ({ ...previous, hope: previous.hope + sharedHope, hopeCapacity: previous.hopeCapacity + sharedHope });
  assert.deepEqual(recipient, { ...withCommanderReward(untouchedRecipient),
    nativeHookIds: [...untouchedRecipient.nativeHookIds, ...commanderRewards.map(reward => 'onLevelUp:commander-level:' + reward.level)] });
  assert.deepEqual(recipientState.safePlayers, untouchedSafe.map(withCommanderReward));
  const queued = copy(match.exportCheckpoint()), restored = fixture(t).match;
  assert.equal(restored.restoreCheckpoint(queued), true);
  const restoredSender = restored.players.get('p0'), restoredRecipient = restored.players.get('p1');
  assert.equal(restoredSender.equipmentGiftOutbox.length, 1);assert.equal(restoredRecipient.roster.length, 0);
  restored._flushEquipmentGifts(restoredSender);
  assert.equal(restoredSender.equipmentGiftOutbox.length, 0);
  assert.equal(restoredRecipient.roster.some(value => value.operatorId === holder.operatorId), true);
  const once = copy(restoredRecipient.roster);restored._flushEquipmentGifts(restoredSender);assert.deepEqual(restoredRecipient.roster, once);

  // In the original session the sender can enter another battle before the
  // recipient finishes. Delivery must clear both the live and rewind outboxes.
  command(match, 'p0', { t: 'g.mizuki.ready', on: true });
  const senderState = match.partyStates.get(match.expedition.partyFor('p0').id);
  assert.equal(senderState.phase, PHASE.COMBAT);assert.equal(senderState.safePlayers[0].equipmentGiftOutbox.length, 1);
  match.fields.get('n:p1').engine.done = true;scheduler.advance(FRAME * 2);
  assert.equal(match.privateView('p1').mizuki.phase, PHASE.REWARD);
  const rewardState = { ready: recipient.ready, selectedReward: recipient.selectedReward };
  recipient.ready = true;recipient.selectedReward = 'continue';
  match._flushEquipmentGifts(sender);
  assert.equal(sender.equipmentGiftOutbox.length, 0);assert.equal(senderState.safePlayers[0].equipmentGiftOutbox.length, 0);
  assert.equal(recipient.ready, true, 'a reward-stage acknowledgement is not a preparation ready flag');
  assert.equal(recipient.roster.some(value => value.operatorId === holder.operatorId), true);
  recipient.ready = rewardState.ready;recipient.selectedReward = rewardState.selectedReward;
  const committed = copy(match.exportCheckpoint()), restoredFixture = fixture(t), final = restoredFixture.match;
  assert.equal(final.restoreCheckpoint(committed), true, JSON.stringify(restoredFixture.errors));
  assert.equal(final.players.get('p0').equipmentGiftOutbox.length, 0);
  const finalRecipient = final.players.get('p1'), received = copy(finalRecipient.roster);
  final._flushEquipmentGifts(final.players.get('p0'));assert.deepEqual(finalRecipient.roster, received);
});

test('a beacon gift survives its sender elimination and reaches the survivor at the next prep once', (t) => {
  const { match, scheduler, errors } = fixture(t);enterRoute(match);
  const sender = match.players.get('p0'), recipient = match.players.get('p1'), holder = unit(match, sender);
  prepare(match);
  assert.equal(equip(match, sender, grant(match, sender, 'chess_item_5_04_e_a'), holder.uid).ok, true);
  const offer = sender.equipmentOffers[0];
  command(match, 'p0', { t: 'g.mizuki.equipmentPick', offerId: offer.id, operatorId: offer.choices[0] });
  launch(match);
  match.fields.get('n:p0').engine.rows.p0.leaked.push({ sourcePlayerId: 'p0', enemyKey: 'fixture', counted: true, lpr: sender.life });
  finish(match, scheduler);
  assert.equal(sender.alive, false);assert.equal(sender.equipmentEffects.some(ref => ref.key === 'effect:builtin_gift'), true);
  assert.equal(recipient.roster.length, 0);
  selectRewardGroups(match, [match.players.get('p1')]);skipMizukiRecruit(match, ['p1']);prepare(match);
  assert.equal(recipient.roster.some(value => value.operatorId === holder.operatorId), true);
  assert.equal(sender.equipmentEffects.some(ref => ref.key === 'effect:builtin_gift'), false);
  assert.equal(sender.equipmentGiftOutbox.length, 0);
  const once = copy(recipient.roster);match._flushEquipmentGifts(sender);assert.deepEqual(recipient.roster, once);
  assert.deepEqual(errors, []);
});

test('an equipped cauldron pays its original gain-operator coin effect when Match adds a qualifying operator', (t) => {
  const { match } = fixture(t);enterRoute(match);
  const player = match.players.get('p0'), gold = player.gold;
  const yan = match.fullCatalog.operators.find(value => value.bonds.includes('yanShip') && value.promotionChessId);
  assert.ok(yan);assert.equal(match._addOperator(player, yan.operatorId), true);
  const holder = player.roster.find(value => value.operatorId === yan.operatorId);
  const cauldron = grant(match, player, 'chess_item_6_03_e_a'), other = grant(match, player, 'chess_item_3_04_e_a');
  assert.equal(equip(match, player, cauldron, holder.uid).ok, true);assert.equal(equip(match, player, other, holder.uid).ok, true);
  const target = match.fullCatalog.operators.find(value => value.bonds.includes('yanShip') && value.operatorId !== yan.operatorId && value.promotionChessId);
  assert.ok(target);const before = player.economicCoinTotal || 0;
  assert.equal(match._addOperator(player, target.operatorId), true);
  assert.equal(player.economicCoinTotal, before + 2);
  assert.equal(player.gold, gold);assert.equal(player.economicCoinRemainder, 2);
  const target2 = match.fullCatalog.operators.find(value => value.bonds.includes('yanShip')
    && ![yan.operatorId, target.operatorId].includes(value.operatorId) && value.promotionChessId);
  assert.ok(target2);assert.equal(match._addOperator(player, target2.operatorId), true, 'a second qualifying operator can trigger the capped per-round effect');
  assert.equal(player.economicCoinTotal, before + 4);
});

test('actual equip command enforces ownership and slots and only consumes successful immediate effects', (t) => {
  const { match } = fixture(t);enterRoute(match);
  const player = match.order[0], holder = unit(match, player), gold = player.gold;
  for (const id of [HAMMER, SHIELD]) assert.equal(equip(match, player, grant(match, player, id), holder.uid).ok, true);
  const extra = grant(match, player, 'chess_item_1_05_e_a'), full = copy(player);
  assert.equal(equip(match, player, extra, holder.uid).error, 'HAND_FULL');assert.deepEqual(player, full);
  const document = grant(match, player, DOCUMENT);
  assert.equal(equip(match, player, document, holder.uid, { requestId: 'deploy-document' }).ok, true);
  assert.equal(player.equipmentDeployCapMin, 9);assert.equal(player.equipmentInventory.some(item => item.uid === document), false);
  const duplicate = grant(match, player, DOCUMENT), noOp = copy(player);
  assert.equal(equip(match, player, duplicate, holder.uid).ok, false);assert.deepEqual(player, noOp);
  const wrongOwner = match.handle('p1', { t: 'g.mizuki.equip', itemUid: duplicate, targetUid: holder.uid });
  assert.equal(wrongOwner.ok, false);assert.deepEqual(player, noOp);assert.equal(player.gold, gold);
  prepare(match);assert.equal(match.privateView('p0').mizuki.prep.deployCap, 9);
});

test('normal projection promotes immediately through the actual Match command and keeps existing equipment', (t) => {
  const { match } = fixture(t);enterRoute(match);
  const player = match.order[0], holder = unit(match, player), uid = holder.uid, gold = player.gold;
  const hammer = grant(match, player, HAMMER);assert.equal(equip(match, player, hammer, uid).ok, true);
  const projection = grant(match, player, PROJECTION);
  assert.equal(equip(match, player, projection, uid).ok, true);
  const promoted = player.roster.find(value => value.uid === uid);
  assert.equal(promoted.promotion, 1);assert.equal(promoted.chessId, match.fullCatalog.promotions.get(promoted.operatorId).chessId);
  assert.deepEqual(promoted.items, [{ uid: hammer, id: HAMMER, kind: 'item', meta: {} }]);
  assert.equal(player.equipmentInventory.some(item => item.uid === projection), false);assert.equal(player.gold, gold);
  const invalid = grant(match, player, PROJECTION), before = copy(player);
  assert.equal(equip(match, player, invalid, uid).ok, false);assert.deepEqual(player, before);
});

test('equipment, converted remainder and pending effects restore together and malformed ledgers are rejected', (t) => {
  const { match } = fixture(t);enterRoute(match);
  const player = match.order[0], holder = unit(match, player);
  assert.equal(equip(match, player, grant(match, player, HAMMER), holder.uid).ok, true);
  for (const id of ['chess_item_2_05_e_a', 'chess_item_2_07_e_a']) assert.equal(equip(match, player, grant(match, player, id), holder.uid).ok, true);
  match._grantEconomicHope(player, 4);match._commit();
  const doc = copy(match.exportCheckpoint()), restored = fixture(t).match;
  assert.equal(restored.restoreCheckpoint(doc), true);
  const next = restored.players.get('p0');
  for (const key of ['equipmentInventory', 'equipmentEffects', 'equipmentPendingFunds', 'economicCoinTotal', 'economicCoinRemainder', 'economicHopePending', 'gold']) {
    assert.deepEqual(next[key], player[key]);
  }
  assert.deepEqual(next.roster[0].items, player.roster[0].items);
  const beforeGold = next.gold, beforeHope = next.hope;
  restored._nativeHook(next, 'onRoundStart', { round: restored.round }, 'restored-prep');
  assert.equal(next.economicCoinTotal, 7);assert.equal(next.hope, beforeHope + 1);assert.equal(next.economicCoinRemainder, 2);
  restored._nativeHook(next, 'onRoundStart', { round: restored.round }, 'restored-prep');
  assert.equal(next.economicCoinTotal, 7);assert.equal(next.gold, beforeGold);
  for (const corrupt of [
    bad => { bad.players[0].economicCoinRemainder = 5; },
    bad => { bad.players[0].economicCoinTotal = -1; },
    bad => { bad.players[0].economicHopePending = 99; },
    bad => { bad.players[0].roster[0].items[0].uid = bad.players[0].roster[0].uid; },
  ]) {
    const bad = copy(doc);corrupt(bad);assert.equal(fixture(t).match.restoreCheckpoint(bad), false);
  }
});
