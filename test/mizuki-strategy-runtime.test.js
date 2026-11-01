import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { MizukiAutoCombat } from '../server/modes/mizuki/Combat.js';
import { createOfficialMizukiStage } from '../server/modes/mizuki/official-stages.js';
import { getData } from '../server/data.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { mizukiDifficultyInitial } from '../server/modes/mizuki/Difficulty.js';
import { MIZUKI_SQUADS } from '../shared/mizuki-squads.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
function fixture(t, bandId, squadId = 'rogue_2_band_1') {
  const scheduler = new VirtualScheduler();
  const match = new MizukiMatch({ data: DATA, scheduler, seed: 503, roomCode: 'STRUN',
    seats: [{ playerId: 'p0', seat: 0 }], send() {}, broadcast() {}, onEnd() {} });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  match.start();
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.squad', squadId }), { ok: true });
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.strategy', bandId }), { ok: true });
  return { match, player: match.players.get('p0') };
}

test('Goliath scales Mizuki starting life by its 45/30 advantage while keeping squad bonuses', t => {
  const { match, player } = fixture(t, 'band_sarkazb');
  const initial = mizukiDifficultyInitial(0);
  assert.equal(player.maxLife, initial.initialMaxHp + 2 + Math.ceil(initial.initialMaxHp / 2));
  assert.equal(player.life, initial.initialHp + 2 + Math.ceil(initial.initialMaxHp / 2));
  const ordinary = fixture(t, 'band_amiya').player;
  assert.equal(ordinary.maxLife, initial.initialMaxHp + 2);
  assert.deepEqual(match.handle('p0', { t: 'g.mizuki.strategy', bandId: 'band_sarkazb' }).error, 'WRONG_PHASE');
});

test('fixed-round strategies grant their real items and Pith through Mizuki player adapters', t => {
  const cases = [
    ['band_orchid', 10, 'chess_item_4_01_e_a'], ['band_justin', 1, 'chess_item_3_12_e_a'],
    ['band_quintus', 3, 'chess_item_5_08_e_a'], ['band_malkie', 1, 'chess_item_5_07_e_a'],
    ['band_damaztic', 5, 'chess_item_6_09_e_a'], ['band_jesica', 4, 'chess_item_4_01_e_a'],
    ['band_mlyss', 1, 'chess_item_5_06_e_b'], ['band_fang', 8, 'chess_item_5_04_e_a'],
    ['band_dusk', 1, 'chess_item_6_02_m'], ['band_doberm', 2, 'chess_item_6_03_m'],
  ];
  for (const [band, round, item] of cases) {
    const { match, player } = fixture(t, band);
    match.round = round;
    match._nativeHook(player, 'onRoundStart', { round }, 'strategy-runtime');
    assert.ok(player.equipmentInventory.some(value => value.id === item), band + ' actually grants ' + item);
    const before = structuredClone(player.equipmentInventory);
    match._nativeHook(player, 'onRoundStart', { round }, 'strategy-runtime');
    assert.deepEqual(player.equipmentInventory, before, 'replayed preparation does not duplicate ' + band);
  }
  const { match, player } = fixture(t, 'band_pith');
  match._nativeHook(player, 'onRoundStart', { round: 1 }, 'pith-start');
  assert.ok(player.roster.some(unit => unit.operatorId === 'chess_char_1_15_a'));
});

test('Makiri obtains an operator on even preparations after every recruitment ticket is consumed', t => {
  const { match, player } = fixture(t, 'band_makiri');
  player.recruit = null;
  match.round = 2;
  const before = player.roster.length;
  match._nativeHook(player, 'onRoundStart', { round: 2 }, 'makiri-r2');
  assert.equal(player.roster.length, before + 1);
  assert.ok(match.fullCatalog.byId.get(player.roster.at(-1).operatorId).tier <= match._equipmentStage(player));
  match.round = 3;
  match._nativeHook(player, 'onRoundStart', { round: 3 }, 'makiri-r3');
  assert.equal(player.roster.length, before + 1, 'odd rounds do not grant operators');
});

test('Shamare exchanges the first dismissed normal operator once per round without the hope refund', t => {
  const { match, player } = fixture(t, 'band_vodfox');
  match.phase = PHASE.ROUTE; match.completedNodes = 1;
  const candidates = match.fullCatalog.operators.filter(operator => operator.tier === 1).slice(0, 3);
  for (const operator of candidates) match._addOperator(player, operator.operatorId);
  const first = player.roster[0], second = player.roster[1], hope = player.hope, count = player.roster.length;
  assert.equal(match.handle('p0', { t: 'g.mizuki.dismiss', uid: first.uid, requestId: 'shamare-1' }).ok, true);
  assert.equal(player.roster.length, count, 'first sale replaces the removed operator');
  assert.equal(player.hope, hope, 'an exchange does not also pay hope');
  assert.equal(match.handle('p0', { t: 'g.mizuki.dismiss', uid: second.uid, requestId: 'shamare-2' }).ok, true);
  assert.equal(player.roster.length, count - 1, 'the second sale is an ordinary dismissal');
  assert.equal(player.hope, hope + 1);
});

test('Ducklord replaces actual official-wave copies from round five and preserves scheduler ownership and bounties', () => {
  let changed = 0;
  for (let seed = 1; seed < 12; seed++) {
    const official = createOfficialMizukiStage('ro2_n_1_1', { data: DATA, seed });
    const options = { ...official, battleId: 'duck-' + seed, fieldId: 'n:p0', seed,
      players: [{ playerId: 'p0', seat: 0, bandId: 'band_amiya', units: [],
        contentInfo: { round: 5, matchBands: ['band_amiya', 'band_ducklord'] } }], content: 'full' };
    const combat = new MizukiAutoCombat(options);
    try {
      for (const replacement of combat.strategyWaveChanges) {
        changed++;
        assert.ok(replacement.enemyKey.endsWith('_2'));
        assert.ok(combat.battle.data.getEnemy(replacement.enemyKey));
        assert.ok(combat.officialWaves.meta.has(replacement.tag), 'the wave scheduler retains its tag');
        assert.deepEqual(replacement.bounty, { coins: 1, ownerPlayerId: 'p0' });
      }
      for (let tick = 0; tick < 240; tick++) combat.step();
      assert.equal(combat.battle.errors.length, 0);
      const beforeFive = new MizukiAutoCombat({ ...options, battleId: 'early-' + seed,
        players: [{ ...options.players[0], contentInfo: { round: 4, matchBands: ['band_ducklord'] } }] });
      assert.deepEqual(beforeFive.strategyWaveChanges, []);
      beforeFive.dispose?.();
    } finally { combat.dispose?.(); }
  }
  assert.ok(changed > 0, 'actual selected official enemies were replaced across seeds');
});

test('all thirteen squad records apply initial resource, life, capacity and dice blackboards', t => {
  assert.equal(MIZUKI_SQUADS.length, 13);
  for (const squad of MIZUKI_SQUADS) {
    const { match, player } = fixture(t, 'band_amiya', squad.id), initial = mizukiDifficultyInitial(0);
    const values = effect => Object.fromEntries(effect.blackboard.map(row => [row.key, row.valueStr ?? row.value]));
    let gold = initial.initialGold, hope = initial.initialPopulation, hp = initial.initialHp, maxHp = initial.initialMaxHp;
    let shield = initial.initialShield, capacity = initial.initialSquadCapacity;
    for (const effect of squad.effects) {
      const value = values(effect);
      if (effect.key === 'set_dice') assert.equal(match.diceId, value.id, squad.name);
      if (effect.key === 'immediate_reward') {
        if (value.id === 'rogue_2_gold') gold += value.count;
        if (value.id === 'rogue_2_population') hope += value.count;
        if (value.id === 'rogue_2_hpmax') { hp += value.count; maxHp += value.count; }
        if (value.id === 'rogue_2_shield') shield += value.count;
        if (value.id === 'rogue_2_squad_capacity') capacity += value.count;
      }
      if (effect.key === 'item_cover_set' && value.id === 'rogue_2_hp') hp = value.count;
      if (effect.key === 'char_attribute_mul') assert.deepEqual(match.squadMods, { atkPct: value.atk, defPct: 0, hpPct: value.max_hp });
    }
    assert.deepEqual([player.gold, player.hope, player.life, player.maxLife, player.shield, match.squadCapacity],
      [gold, hope, hp, maxHp, shield, capacity], squad.name);
  }
});
