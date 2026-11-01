import test from 'node:test';
import assert from 'node:assert/strict';
import { getData } from '../server/data.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { validateC2S, unitStatsEntry } from '../shared/protocol.js';
import { Unit } from '../server/sim/units.js';
import { grantMizukiEquipment } from '../server/modes/mizuki/Equipment.js';
import { mizukiRunLoadoutOptions, validMizukiRunLoadout } from '../server/modes/mizuki/RunLoadout.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const TEXAS = 'chess_char_1_08_a';
const command = (match, playerId, message) => {
  const result = match.handle(playerId, message); assert.equal(result.ok, true, JSON.stringify(result)); return result;
};
const state = (match, playerId = 'p0') => match.privateView(playerId).mizuki;
const rosterUnit = (match, playerId = 'p0') => match.players.get(playerId).roster.find((unit) => unit.operatorId === TEXAS);
const choose = (match, skillIndex, moduleId = 'none', playerId = 'p0') => command(match, playerId,
  { t: 'g.mizuki.loadout', uid: rosterUnit(match, playerId).uid, skillIndex, moduleId });

function fixture(t, { start = true } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false });
  const seats = [0, 1].map((seat) => ({ playerId: 'p' + seat, seat, connected: true,
    loadout: { [TEXAS]: { skill: 1, module: 'uniequip_002_texas' } } }));
  const errors = [];
  const match = new MizukiMatch({ roomCode: 'RUNL', hostId: 'p0', seed: 512, data: DATA, scheduler, seats,
    dungeon: { zones: [{ id: 'zone_1', nodes: [
      { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
      { pos: { x: 0, y: 1 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [] },
    ] }] },
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) }, send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  if (start) {
    match.start();
    for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_3' });
    const quiet = match.strategyOptions.filter((option) => DATA.bands[option.bandId]?.buffs?.every((buff) => buff.key === 'env_gbuff_new_with_verify'));
    for (const [index, player] of match.order.entries()) command(match, player.playerId, { t: 'g.mizuki.strategy', bandId: quiet[index].bandId });
    for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_2' });
    for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
    skipMizukiRecruit(match);
    for (const player of match.order) assert.equal(match._addOperator(player, TEXAS), true);
  }
  return { match, scheduler, seats, errors };
}
function prepare(match, split = false) {
  const nodes = state(match).route.filter((node) => node.available && node.type === 'combat');
  for (const [index, player] of match.order.entries()) command(match, player.playerId,
    { t: 'g.mizuki.route', nodeId: nodes[split ? index : 0].id });
  if (split) {
    const request = command(match, 'p1', { t: 'g.mizuki.splitRequest', nodeId: nodes[1].id }).request;
    command(match, 'p0', { t: 'g.mizuki.splitDecide', requestId: request.id, approve: true });
  }
  command(match, 'p0', { t: 'g.mizuki.routeStart' }); assert.equal(state(match).phase, PHASE.PREP);
}
function promote(match, playerId = 'p0') {
  const player = match.players.get(playerId), unit = rosterUnit(match, playerId);
  assert.equal(match._addOperator(player, TEXAS, { promotion: 1, existingUid: unit.uid, recruitCopies: 3 }), true);
  return rosterUnit(match, playerId);
}

test('run skill survives promotion; selected real module changes official E2 stats and the production automatic combat', (t) => {
  const { match, scheduler, seats, errors } = fixture(t);
  const sourceBefore = structuredClone(DATA.chess.chess_char_1_08_b), accountBefore = structuredClone(seats);
  assert.deepEqual(state(match).roster[0].loadout.modules.map((module) => module.id), ['none']);
  choose(match, 0);
  promote(match);
  assert.equal(rosterUnit(match).skillIndex, 0, 'promotion preserves the explicit run skill');
  assert.equal(rosterUnit(match).moduleId, 'none', 'promotion preserves explicit no-module choice');
  const before = state(match).roster[0].loadout.stats;
  const module = state(match).roster[0].loadout.modules.find((option) => option.id !== 'none');
  assert.ok(module);
  choose(match, 0, module.id);
  const selected = state(match).roster[0];
  assert.equal(selected.loadout.selectedSkill.index, 0);
  assert.equal(selected.loadout.selectedModule.id, module.id);
  assert.equal(selected.loadout.stats.maxHp, before.maxHp + module.attr.maxHp);
  assert.equal(selected.loadout.stats.atk, before.atk + module.attr.atk);
  assert.equal(selected.loadout.stats.def, before.def + module.attr.def);
  prepare(match);
  const tile = state(match).prep.legalTiles[selected.uid][0]; assert.ok(tile);
  command(match, 'p0', { t: 'g.mizuki.move', uid: selected.uid, to: { area: 'board', row: tile[0], col: tile[1] }, dir: 'RIGHT' });
  const engine = match.fields.get('n:p0').engine;
  const actual = engine.battle.getPlayer('p0').units.find((unit) => unit.uid === selected.uid);
  assert.equal(actual.def.raw.skill.index, 0);
  assert.equal(actual.def.raw.module.id, module.id);
  assert.equal(actual.def.raw.module.active, true);
  assert.equal(actual.def.raw.stats.maxHp, selected.loadout.stats.maxHp);
  assert.equal(actual.def.raw.stats.atk, selected.loadout.stats.atk);
  assert.equal(actual.def.raw.trait.moduleDesc, DATA.chess.chess_char_1_08_b.modules[0].traitOverride.moduleDesc);
  assert.equal(actual.skill.name, selected.loadout.selectedSkill.name);
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.ready', on: true });
  scheduler.advance(1000 / 30 * 2);
  const running = match.fields.get('n:p0').engine;
  const deployed = running.battle.getPlayer('p0').units.find((unit) => unit.uid === selected.uid);
  assert.equal(deployed.deployed, true); assert.equal(running.battle.errorCount, 0);
  assert.equal(deployed.def.raw.skill.index, 0); assert.equal(deployed.def.raw.module.id, module.id);
  assert.deepEqual(DATA.chess.chess_char_1_08_b, sourceBefore);
  assert.deepEqual(seats, accountBefore);
  assert.deepEqual(match.players.get('p0').loadout, seats[0].loadout, 'the account-derived loadout copy is not edited');
  assert.deepEqual(errors, []);
});

test('unknown, foreign, unavailable skills and modules reject atomically without acquiring an operator', (t) => {
  const { match } = fixture(t), player = match.players.get('p0'), uid = rosterUnit(match).uid;
  const before = structuredClone(player), publicBefore = match.revision;
  for (const selection of [
    { uid: 999999, skillIndex: 0, moduleId: 'none' },
    { uid: rosterUnit(match, 'p1').uid, skillIndex: 0, moduleId: 'none' },
    { uid, skillIndex: 2, moduleId: 'none' },
    { uid, skillIndex: '0', moduleId: 'none' },
    { uid, skillIndex: 0, moduleId: 'uniequip_002_texas' },
    { uid, skillIndex: 0, moduleId: 'uniequip_002_ling' },
    { uid, skillIndex: 0 },
  ]) {
    assert.equal(match.handle('p0', { t: 'g.mizuki.loadout', ...selection }).error, 'BAD_TARGET');
    assert.deepEqual(player, before); assert.equal(match.revision, publicBefore);
  }
});

test('six-star E1 filters an account S3 default and rejects forged S3 actions/checkpoints until promotion unlocks it', (t) => {
  const { match } = fixture(t), player = match.players.get('p0');
  const ling = match.fullCatalog.operators.find((operator) => operator.charId === 'char_2023_ling');
  assert.ok(ling);
  player.loadout[ling.operatorId] = { skill: 2, module: 'none' };
  assert.equal(match._addOperator(player, ling.operatorId), true);
  const current = () => player.roster.find((unit) => unit.operatorId === ling.operatorId);
  const view = () => state(match).roster.find((unit) => unit.operatorId === ling.operatorId).loadout;
  assert.equal(current().formStatus.phase, 1);
  assert.deepEqual(view().skills.map((skill) => skill.index), [0, 1]);
  assert.deepEqual(view().skills.map((skill) => skill.unlockCond.phase), ['PHASE_0', 'PHASE_1']);
  assert.notEqual(current().skillIndex, 2, 'locked account default falls back to an E1 skill');
  assert.notEqual(match.ds.getChess(ling.operatorId, { skillIndex: 2 }).raw.skill.index, 2,
    'the battle source enforces the same available list');
  const before = structuredClone(player), revision = match.revision;
  assert.equal(match.handle('p0', { t: 'g.mizuki.loadout', uid: current().uid, skillIndex: 2, moduleId: 'none' }).error, 'BAD_TARGET');
  assert.deepEqual(player, before); assert.equal(match.revision, revision);
  const baseCheckpoint = structuredClone(match.exportCheckpoint());
  const locked = baseCheckpoint.players[0].roster.find((unit) => unit.operatorId === ling.operatorId);
  locked.skillIndex = 2; locked.runLoadout = { skillIndex: 2, moduleId: 'none' };
  assert.equal(fixture(t, { start: false }).match.restoreCheckpoint(baseCheckpoint), false,
    'an unpromoted checkpoint cannot keep S3');
  command(match, 'p0', { t: 'g.mizuki.loadout', uid: current().uid, skillIndex: 0, moduleId: 'none' });
  assert.equal(match._addOperator(player, ling.operatorId, { promotion: 1, existingUid: current().uid, recruitCopies: 3 }), true);
  assert.equal(current().formStatus.phase, 2);
  assert.equal(current().skillIndex, 0, 'promotion preserves a legal explicit selection');
  assert.deepEqual(view().skills.map((skill) => skill.index), [0, 1, 2]);
  assert.deepEqual(view().skills[2].unlockCond, { phase: 'PHASE_2', level: 1 });
  command(match, 'p0', { t: 'g.mizuki.loadout', uid: current().uid, skillIndex: 2, moduleId: 'none' });
  assert.equal(current().skillIndex, 2); assert.equal(view().selectedSkill.index, 2);
  const checkpoint = structuredClone(match.exportCheckpoint()), restored = fixture(t, { start: false }).match;
  assert.equal(restored.restoreCheckpoint(checkpoint), true);
  assert.equal(state(restored).roster.find((unit) => unit.operatorId === ling.operatorId).loadout.selectedSkill.index, 2);
  prepare(match);
  const tile = state(match).prep.legalTiles[current().uid][0];
  command(match, 'p0', { t: 'g.mizuki.move', uid: current().uid, to: { area: 'board', row: tile[0], col: tile[1] }, dir: 'RIGHT' });
  const actual = match.fields.get('n:p0').engine.battle.getPlayer('p0').units.find((unit) => unit.uid === current().uid);
  assert.equal(actual.def.raw.status.phase, 2); assert.equal(actual.def.raw.skill.index, 2);
});

test('all real RO2 forms expose only official phase skills, including six-star E1/E2 and special skill lists', (t) => {
  const { match } = fixture(t);
  let sixStar = 0;
  for (const operator of match.fullCatalog.operators) {
    for (const id of [operator.operatorId, operator.promotionChessId].filter(Boolean)) {
      const raw = match.ds.rawChess(id), skills = mizukiRunLoadoutOptions(match.ds, { chessId: id, promotion: id !== operator.operatorId }).skills;
      assert.deepEqual(skills.map((skill) => skill.index), raw.skills.map((skill) => skill.index), id);
      for (const skill of skills) {
        const requiredPhase = Number(skill.unlockCond.phase.slice(-1));
        assert.ok(requiredPhase < raw.status.phase || requiredPhase === raw.status.phase && skill.unlockCond.level <= raw.status.level, id);
      }
      const selected = match.ds.getChess(id, { skillIndex: 9 }).raw.skill;
      assert.ok(raw.skills.some((skill) => skill.index === selected.index), id + ': valid default fallback');
    }
    if (operator.rarity === 6) {
      sixStar++;
      const base = match.ds.rawChess(operator.operatorId), upgraded = match.ds.rawChess(operator.promotionChessId);
      assert.equal(base.skills.some((skill) => skill.unlockCond.phase === 'PHASE_2'), false, operator.charId + ': E1');
      if (upgraded.skills.length === 3) {
        assert.deepEqual(base.skills.map((skill) => skill.index), [0, 1], operator.charId + ': E1');
        assert.deepEqual(upgraded.skills.map((skill) => skill.index), [0, 1, 2], operator.charId + ': E2');
      } else assert.deepEqual(base.skills.map((skill) => skill.index), upgraded.skills.map((skill) => skill.index),
        operator.charId + ': special operators keep their actual official skill slots');
    }
  }
  assert.ok(sixStar > 50);
});

test('official phase and level conditions govern both returned choices and validation even if a raw list contains locked entries', () => {
  const status = { phase: 1, level: 49 };
  const raw = { status, skills: [
    { index: 0, unlockCond: { phase: 'PHASE_0', level: 50 } },
    { index: 1, unlockCond: { phase: 'PHASE_1', level: 50 } },
    { index: 2, unlockCond: { phase: 'PHASE_2', level: 1 } },
  ] };
  const source = { rawChess: () => raw }, unit = { chessId: 'boundary', promotion: 0, moduleId: 'none' };
  assert.deepEqual(mizukiRunLoadoutOptions(source, unit).skills.map((skill) => skill.index), [0]);
  assert.equal(validMizukiRunLoadout(source, unit, { skillIndex: 1, moduleId: 'none' }), false);
  status.level = 50;
  assert.equal(validMizukiRunLoadout(source, unit, { skillIndex: 1, moduleId: 'none' }), true);
  assert.equal(validMizukiRunLoadout(source, unit, { skillIndex: 2, moduleId: 'none' }), false);
  status.phase = 2; status.level = 1; unit.promotion = 1;
  assert.deepEqual(mizukiRunLoadoutOptions(source, unit).skills.map((skill) => skill.index), [0, 1, 2]);
  assert.equal(validMizukiRunLoadout(source, unit, { skillIndex: 2, moduleId: 'none' }), true);
});

test('editing a placed operator rebuilds its prep skill and module while retaining equipment and showing effective stats', (t) => {
  const { match } = fixture(t); const unit = promote(match), player = match.players.get('p0');
  const item = grantMizukiEquipment(player, 'chess_item_1_01_e_a', match._equipmentOptions(player));
  assert.equal(item.ok, true);
  command(match, 'p0', { t: 'g.mizuki.equip', itemUid: item.item.uid, targetUid: unit.uid });
  prepare(match);
  const tile = state(match).prep.legalTiles[unit.uid][0];
  command(match, 'p0', { t: 'g.mizuki.move', uid: unit.uid, to: { area: 'board', row: tile[0], col: tile[1] }, dir: 'RIGHT' });
  const before = structuredClone({ hope: player.hope, gold: player.gold, tickets: player.tickets, items: rosterUnit(match).items });
  const oldEngine = match.fields.get('n:p0').engine;
  choose(match, 0, 'none');
  const field = match.fields.get('n:p0'), actual = field.engine.battle.getPlayer('p0').units.find((value) => value.uid === unit.uid);
  assert.notEqual(field.engine, oldEngine);
  assert.equal(actual.def.raw.skill.index, 0); assert.equal(actual.def.raw.module.active, false);
  assert.deepEqual(field.engine.battle.getPlayer('p0').input.units.find((value) => value.uid === unit.uid).items, [item.item.id]);
  const view = state(match).roster.find((value) => value.uid === unit.uid).loadout;
  assert.equal(view.statsSource, 'combat-runtime');
  assert.equal(view.stats.atk, Math.round(actual.s.atk));
  assert.ok(view.stats.atk > view.trainingStats.atk, 'the real equipped hammer contributes to displayed attack');
  assert.deepEqual({ hope: player.hope, gold: player.gold, tickets: player.tickets, items: rosterUnit(match).items }, before);
});

test('route and reserve equipment stat previews reuse native modifiers and match the prepared runtime when placed', (t) => {
  const { match } = fixture(t), player = match.players.get('p0'), unit = rosterUnit(match);
  const bare = state(match).roster[0].loadout.stats;
  for (const id of ['chess_item_1_01_e_a', 'chess_item_1_02_e_a']) {
    const granted = grantMizukiEquipment(player, id, match._equipmentOptions(player));
    command(match, 'p0', { t: 'g.mizuki.equip', itemUid: granted.item.uid, targetUid: unit.uid });
  }
  const route = state(match).roster[0].loadout;
  assert.equal(route.statsSource, 'official-training-module-and-passive-equipment');
  assert.ok(route.stats.atk > bare.atk); assert.ok(route.stats.def > bare.def);
  prepare(match);
  const bench = state(match).roster[0].loadout;
  assert.deepEqual(bench.stats, route.stats, 'not-yet-placed reserve still displays permanent equipment bonuses');
  const tile = state(match).prep.legalTiles[unit.uid][0];
  command(match, 'p0', { t: 'g.mizuki.move', uid: unit.uid, to: { area: 'board', row: tile[0], col: tile[1] }, dir: 'RIGHT' });
  const placed = state(match).roster[0].loadout;
  assert.equal(placed.statsSource, 'combat-runtime');
  const actual = match.fields.get('n:p0').engine.battle.getPlayer('p0').units.find((value) => value.uid === unit.uid);
  const equipmentOnly = new Unit({ id: 0, uid: unit.uid, side: 'ally', kind: 'op', def: actual.def, base: actual.def.stats });
  equipmentOnly.buffs = actual.buffs.filter((buff) => buff.key.startsWith('item:'));
  const actualEquipmentStats = unitStatsEntry(equipmentOnly, equipmentOnly.s);
  for (const key of ['maxHp', 'atk', 'def', 'res', 'blockCnt']) assert.equal(actualEquipmentStats[key], route.stats[key], key);
  assert.equal(actualEquipmentStats.interval, route.stats.attackInterval);
  command(match, 'p0', { t: 'g.mizuki.lineup', uids: [] });
  assert.equal(state(match).roster[0].loadout.stats.atk, route.stats.atk, 'removing from carried lineup keeps the real equipment preview');
});

test('run choices restore from checkpoint and semantically forged loadouts are rejected', (t) => {
  const { match } = fixture(t); choose(match, 0); promote(match);
  const moduleId = state(match).roster[0].loadout.modules.find((module) => module.id !== 'none').id;
  choose(match, 0, moduleId);
  const doc = structuredClone(match.exportCheckpoint());
  const { match: restored } = fixture(t, { start: false });
  assert.equal(restored.restoreCheckpoint(doc), true);
  assert.deepEqual(rosterUnit(restored).runLoadout, { skillIndex: 0, moduleId });
  assert.equal(state(restored).roster[0].loadout.moduleId, moduleId);
  for (const corrupt of [
    (unit) => { unit.skillIndex = 8; unit.runLoadout.skillIndex = 8; },
    (unit) => { unit.moduleId = 'uniequip_002_ling'; unit.runLoadout.moduleId = unit.moduleId; },
    (unit) => { unit.runLoadout.skillIndex = 1; },
  ]) {
    const bad = structuredClone(doc); corrupt(bad.players[0].roster[0]);
    const target = fixture(t, { start: false }).match;
    assert.equal(target.restoreCheckpoint(bad), false);
  }
});

test('ready, combat and pending SAN lock edits while another branch keeps independent preparation choices', (t) => {
  const { match } = fixture(t); prepare(match, true);
  command(match, 'p0', { t: 'g.mizuki.ready', on: true });
  assert.equal(state(match).phase, PHASE.COMBAT); assert.equal(state(match, 'p1').phase, PHASE.PREP);
  const combat = match.fields.get('n:p0').engine;
  assert.equal(match.handle('p0', { t: 'g.mizuki.loadout', uid: rosterUnit(match).uid, skillIndex: 0, moduleId: 'none' }).error, 'WRONG_PHASE');
  choose(match, 0, 'none', 'p1');
  assert.equal(match.fields.get('n:p0').engine, combat, 'other branch combat is not rebuilt');
  assert.equal(state(match).phase, PHASE.COMBAT);
  const player = match.players.get('p1'); player.ready = true;
  assert.equal(match.handle('p1', { t: 'g.mizuki.loadout', uid: rosterUnit(match, 'p1').uid, skillIndex: 1, moduleId: 'none' }).error, 'WRONG_PHASE');
  player.ready = false; match.floorState.pending = {};
  assert.equal(match.handle('p1', { t: 'g.mizuki.loadout', uid: rosterUnit(match, 'p1').uid, skillIndex: 1, moduleId: 'none' }).error, 'WRONG_PHASE');
  match.floorState.pending = null;
});

test('module summon deltas apply to official trained Ling tokens instead of replacing them with old slot bodies', (t) => {
  const { match } = fixture(t);
  const ling = match.fullCatalog.operators.find((operator) => operator.charId === 'char_2023_ling');
  assert.ok(ling);
  const id = ling.promotionChessId, moduleId = match.ds.rawChess(id).modules[0].uniEquipId;
  const base = match.ds.getToken('token_10020_ling_soul3', id, { skillIndex: 2, moduleId: 'none' });
  const equipped = match.ds.getToken('token_10020_ling_soul3', id, { skillIndex: 2, moduleId });
  assert.equal(base.stats.cost - equipped.stats.cost, 5, 'actual SUM-Y token module cost delta');
  assert.equal(base.stats.maxHp, equipped.stats.maxHp, 'level-one module keeps the original official E2 token HP');
  assert.ok(equipped.raw.variants[id].stats.deckStack > base.raw.variants[id].stats.deckStack,
    'source module token capacity applies to the owner-specific raw variant consumed by summon kits');
});

test('a native default module token uses its explicit no-module baseline when adapting the official summon', (t) => {
  const { match } = fixture(t);
  // Cathy is a native chess, whose original token baseline already includes
  // the default module. Backups use the opposite baseline (covered by Ling).
  const cathy = match.fullCatalog.byId.get('chess_char_4_11_a');
  assert.ok(cathy);
  const id = cathy.promotionChessId, tokenId = 'token_10041_cathy_catsld';
  const moduleId = match.ds.rawChess(id).modules[0].uniEquipId;
  const unequipped = match.ds.getToken(tokenId, id, { skillIndex: 0, moduleId: 'none' });
  const equipped = match.ds.getToken(tokenId, id, { skillIndex: 0, moduleId });
  const native = DATA.tokens[tokenId].variants.chess_char_4_11_b;
  const expectedDelta = native.stats.cost - native.byModule.none.stats.cost;
  assert.notEqual(expectedDelta, 0);
  assert.equal(equipped.stats.cost - unequipped.stats.cost, expectedDelta);
  assert.equal(equipped.stats.maxHp, unequipped.stats.maxHp, 'module does not replace the official token body');
});

test('wire protocol accepts only the complete run-loadout action shape', () => {
  assert.equal(validateC2S({ t: 'g.mizuki.loadout', uid: 10001, skillIndex: 0, moduleId: 'none' }), null);
  for (const message of [
    { t: 'g.mizuki.loadout', uid: 10001, skillIndex: 0 },
    { t: 'g.mizuki.loadout', uid: 10001, skillIndex: '0', moduleId: 'none' },
    { t: 'g.mizuki.loadout', uid: 10001, skillIndex: -1, moduleId: 'none' },
  ]) assert.equal(typeof validateC2S(message), 'string');
});
