import test from 'node:test';
import assert from 'node:assert/strict';
import { getData } from '../server/data.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { grantMizukiEquipment } from '../server/modes/mizuki/Equipment.js';
import { createMizukiSanCheck } from '../server/modes/mizuki/NativeMutations.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const command = (match, playerId, message) => {
  const result = match.handle(playerId, message);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
const view = (match, playerId = 'p0') => match.privateView(playerId).mizuki;
const persistentResources = (player) => structuredClone({
  roster: player.roster, hope: player.hope, gold: player.gold, tickets: player.tickets,
  equipmentInventory: player.equipmentInventory, equipmentEffects: player.equipmentEffects,
});

function fixture(t, { recruiting = false } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const match = new MizukiMatch({ roomCode: 'LNUP', hostId: 'p0', seed: 512, data: DATA, scheduler,
    seats: [0, 1].map((seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    log: { info() {}, warn() {}, error() {} }, send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  match.start();
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_3' });
  const quiet = match.strategyOptions.filter((option) => DATA.bands[option.bandId]?.buffs
    ?.every((buff) => buff.key === 'env_gbuff_new_with_verify'));
  assert.ok(quiet.length >= match.order.length);
  for (const [index, player] of match.order.entries()) command(match, player.playerId,
    { t: 'g.mizuki.strategy', bandId: quiet[index].bandId });
  for (const player of match.order) command(match, player.playerId,
    { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  for (const player of match.order) command(match, player.playerId,
    { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  if (!recruiting) skipMizukiRecruit(match);
  const player = match.players.get('p0');
  for (const operator of match.fullCatalog.operators) {
    if (player.roster.length > match.squadCapacity) break;
    assert.equal(match._addOperator(player, operator.operatorId), true);
  }
  assert.ok(player.roster.length > match.squadCapacity, 'fixture needs acquired reserves beyond carried capacity');
  return { match, player };
}

function prepare(match) {
  const node = match.route.find((value) => value.available && value.type === 'combat');
  assert.ok(node);
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.route', nodeId: node.id });
  command(match, match.hostId, { t: 'g.mizuki.routeStart' });
  assert.equal(view(match).phase, PHASE.PREP);
}

function decisionPhaseFixture(match, phase) {
  // Event/shop availability is independent of lineup management. Exercise the
  // command using explicit decision snapshots, without inventing node rewards.
  match.phase = phase;
  for (const state of match.partyStates.values()) state.phase = phase;
  for (const player of match.order) player.ready = false;
}

test('carried lineup can change in every noncombat decision phase without spending recruitment resources', async (t) => {
  for (const phase of [PHASE.ROUTE, PHASE.REWARD, PHASE.EVENT, PHASE.SHOP, PHASE.RECRUIT]) {
    await t.test(phase, (t) => {
      const { match, player } = fixture(t, { recruiting: phase === PHASE.RECRUIT });
      if (phase !== PHASE.RECRUIT) decisionPhaseFixture(match, phase);
      const before = persistentResources(player);
      const selected = player.roster.slice(-2).map((unit) => unit.uid).reverse();
      command(match, 'p0', { t: 'g.mizuki.lineup', uids: selected });
      assert.deepEqual(view(match).lineup, selected, 'server preserves the selected UID order');
      assert.equal(view(match).phase, phase, 'editing lineup does not advance the node');
      command(match, 'p0', { t: 'g.mizuki.lineup', uids: [] });
      assert.deepEqual(view(match).lineup, [], 'an empty carried lineup retains all recruited reserves');
      assert.deepEqual(persistentResources(player), before);
    });
  }
});

test('unknown, foreign, duplicate and excess UIDs reject the whole lineup transaction', (t) => {
  const { match, player } = fixture(t);
  assert.equal(match._addOperator(match.players.get('p1'), 'chess_char_1_02_a'), true);
  const foreign = match.players.get('p1').roster[0].uid;
  const uid = player.roster[0].uid;
  const invalid = [null, [String(uid)], [uid, uid], [uid, 999999999], [foreign],
    player.roster.slice(0, match.squadCapacity + 1).map((unit) => unit.uid)];
  const before = persistentResources(player), lineup = [...view(match).lineup];
  for (const uids of invalid) {
    const result = match.handle('p0', { t: 'g.mizuki.lineup', uids });
    assert.equal(result.error, 'BAD_TARGET', JSON.stringify(uids));
    assert.deepEqual(view(match).lineup, lineup);
    assert.deepEqual(persistentResources(player), before);
  }
});

test('unready preparation immediately updates the bench and keeps equipment on removed and restored operators', (t) => {
  const { match, player } = fixture(t);
  const target = player.roster[0], other = player.roster[1];
  const granted = grantMizukiEquipment(player, 'chess_item_1_01_e_a', match._equipmentOptions(player));
  assert.equal(granted.ok, true);
  command(match, 'p0', { t: 'g.mizuki.equip', itemUid: granted.item.uid, targetUid: target.uid });
  prepare(match);
  const before = persistentResources(player);
  command(match, 'p0', { t: 'g.mizuki.lineup', uids: [other.uid] });
  assert.deepEqual(view(match).prep.hand.filter(Boolean).map((unit) => unit.uid), [other.uid]);
  command(match, 'p0', { t: 'g.mizuki.lineup', uids: [other.uid, target.uid] });
  assert.deepEqual(view(match).lineup, [other.uid, target.uid]);
  assert.deepEqual(view(match).prep.hand.filter(Boolean).map((unit) => unit.uid).sort((a, b) => a - b),
    [target.uid, other.uid].sort((a, b) => a - b));
  assert.deepEqual(view(match).prep.hand.find((unit) => unit?.uid === target.uid).items,
    before.roster.find((unit) => unit.uid === target.uid).items);
  assert.deepEqual(persistentResources(player), before);
});

test('ready and combat locks reject lineup changes without losing recruited units or equipment', (t) => {
  const { match, player } = fixture(t);
  prepare(match);
  command(match, 'p0', { t: 'g.mizuki.ready', on: true });
  const before = persistentResources(player), lineup = [...view(match).lineup];
  assert.equal(match.handle('p0', { t: 'g.mizuki.lineup', uids: [] }).error, 'WRONG_PHASE');
  assert.deepEqual(view(match).lineup, lineup);
  assert.deepEqual(persistentResources(player), before);
  command(match, 'p1', { t: 'g.mizuki.ready', on: true });
  assert.equal(view(match).phase, PHASE.COMBAT);
  const combatResources = persistentResources(player);
  assert.equal(match.handle('p0', { t: 'g.mizuki.lineup', uids: [] }).error, 'WRONG_PHASE');
  assert.deepEqual(view(match).lineup, lineup);
  assert.deepEqual(persistentResources(player), combatResources);
});

test('pending floor SAN check locks lineup changes until the team resolves it', (t) => {
  const { match, player } = fixture(t);
  const check = createMizukiSanCheck({ light: 0, diceId: 'rogue_2_dice_1', grade: 17,
    rng: { pick: (values) => values[0] }, players: match.order, zoneId: 'lineup-floor-two', roll: 1 });
  match.floorState.pending = match._pendingSan(check, match.order.map((entry) => entry.playerId), 0);
  const before = persistentResources(player), lineup = [...view(match).lineup];
  assert.equal(match.handle('p0', { t: 'g.mizuki.lineup', uids: [] }).error, 'WRONG_PHASE');
  assert.deepEqual(view(match).lineup, lineup);
  assert.deepEqual(persistentResources(player), before);
});
