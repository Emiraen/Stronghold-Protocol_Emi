import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiAutoCombat } from '../server/modes/mizuki/Combat.js';
import { getDefaultSource } from '../server/sim/simdata.js';
import { Grid } from '../server/sim/grid.js';
import { syncMizukiPrep, mizukiPrepView, mizukiPrepInput, moveMizukiPrep,
  mizukiPrepLegal, validMizukiPrep, mizukiPrepFacilityBlocks } from '../server/modes/mizuki/Prep.js';
import { createOfficialMizukiStage } from '../server/modes/mizuki/official-stages.js';
import { attackRangeGrid } from '../shared/loadoutRecord.js';
import { offsetTile } from '../server/sim/dir.js';

const source = getDefaultSource();
const RECT = { r0: 9, r1: 12, c0: 2, c1: 10 };
const ground = () => ({ id: 'mizuki_auto_test', rows: Array(19).fill('r'.repeat(21)) });
function create(t, options = {}) {
  const c = new MizukiAutoCombat({ seed: 23, battleId: 'auto-prep', stage: ground(), rect: RECT,
    spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }], timeLimit: 180,
    players: [{ playerId: 'p1', units: [{ uid: 10001, chessId: 'chess_char_1_02_a', row: 9, col: 4, dir: 'UP' }] }], ...options });
  t.after(() => c.forceEnd()); return c;
}
const bond = (combat, playerId, id) => combat.snapshot().covenants[playerId].find((value) => value.id === id);
const advance = (combat, seconds) => { for (let i = 0; i < Math.ceil(seconds / combat.dt); i++) combat.step(); };
function prepFixture(ids = ['chess_char_1_02_a', 'chess_char_2_02_a']) {
  const player = { playerId: 'p1', seat: 0, fieldId: 'mizuki_a', roster: ids.map((chessId, i) => ({
    uid: 10001 + i, chessId, operatorId: chessId, name: source.getChess(chessId).name,
    position: source.getChess(chessId).position, items: [],
  })), lineup: ids.map((_, i) => 10001 + i) };
  const grid = new Grid(ground(), RECT);
  const context = { source, grid, deployLimit: 6, fieldDeployCount: 0, otherOccupied: new Set() };
  syncMizukiPrep(player, context); return { player, grid, context };
}
const place = (fixture, uid, row, col, dir = 'RIGHT', extra = {}) => moveMizukiPrep(fixture.player, uid,
  { area: 'board', row, col }, dir, { ...fixture.context, ...extra });

test('production auto combat deploys the exact prepared field coordinates on its first step without manual DP fees', (t) => {
  const c = create(t, { flags: { dpInit: 0, dpPerSec: 0, dpMax: 99 }, players: [
    { playerId: 'p1', units: [{ uid: 10001, chessId: 'chess_char_1_02_a', row: 9, col: 4, dir: 'UP' }] },
    { playerId: 'p2', units: [{ uid: 20001, chessId: 'chess_char_1_03_a', row: 12, col: 8, dir: 'LEFT' }] },
  ] });
  assert.equal(c.battle.started, false); assert.deepEqual(c.snapshot().units, []);
  c.step();
  for (const [p, expected] of c.battle.players.map((p, i) => [p, i === 0 ? [9, 4, 'UP'] : [12, 8, 'LEFT']])) {
    const unit = p.units[0]; assert.equal(unit.alive && unit.deployed, true);
    assert.deepEqual([unit.tileR, unit.tileC, unit.dir], expected);
    assert.equal(unit._mizukiPaidCost, undefined); assert.equal(unit._mizukiDeployCount, undefined);
    assert.equal(p.dp, 0);
  }
  const view = c.snapshot(); assert.equal(view.controlMode, 'automatic');
  assert.equal(view.rosters.p1[0].paidCost, 0); assert.equal(view.rosters.p1[0].canRetreat, false);
  assert.equal(c.battle.errorCount, 0);
});

test('production auto combat accepts original internal skill activation and ordinary native skill triggers', (t) => {
  const direct = create(t, { players: [{ playerId: 'p1', units: [
    { uid: 10001, chessId: 'chess_char_1_08_a', row: 9, col: 4, dir: 'RIGHT' },
  ] }] });
  direct.step(); const texas = direct.battle.getPlayer('p1').units[0];
  assert.equal(texas.skill.manual, true); texas.skill.setSpTotal(texas.skill.spCost);
  assert.equal(texas.skill.activate('native-kit'), true);
  const natural = create(t, { players: [{ playerId: 'p1', units: [
    { uid: 10001, chessId: 'chess_char_1_08_a', row: 9, col: 4, dir: 'RIGHT' },
  ] }] });
  natural.step(); const unit = natural.battle.getPlayer('p1').units[0];
  let starts = 0; natural.battle.on('skillStart', ({ unit: owner }) => { if (owner === unit) starts++; });
  natural.battle.spawnEnemy('test:auto_target', { pos: [9, 5], countInTotal: false,
    def: { key: 'test:auto_target', name: 'target', stats: { maxHp: 1000000, atk: 0, def: 0, res: 0,
      rangeRadius: 0, moveSpeed: 0, baseAttackTime: 99 }, dmgType: 'none', motion: 'WALK' },
    route: { motion: 'WALK', start: [9, 5], end: [9, 5], checkpoints: [{ type: 'WAIT', time: 9999 }] } });
  unit.skill.setSpTotal(unit.skill.spCost); advance(natural, 4);
  assert.ok(starts > 0, 'the original automatic trigger casts a ready manual skill');
  assert.equal(natural.battle.errorCount, 0); assert.equal(direct.battle.errorCount, 0);
});

test('production auto combat rejects all player battle commands without starting or changing combat', (t) => {
  const c = create(t), before = c.snapshot();
  for (const type of ['deploy', 'retreat', 'skill', 'unknown']) {
    assert.equal(c.command('p1', { type, uid: 10001, row: 9, col: 4, dir: 'RIGHT' }).error, 'AUTOMATIC_COMBAT');
  }
  assert.equal(c.battle.started, false); assert.equal(c.commandSeq, 0); assert.deepEqual(c.snapshot(), before);
  c.step(); const unit = c.battle.getPlayer('p1').units[0], hp = unit.hp;
  assert.equal(c.command('p1', { type: 'retreat', uid: 10001 }).error, 'AUTOMATIC_COMBAT');
  assert.equal(unit.alive && unit.deployed, true); assert.equal(unit.hp, hp);
});

test('prepared native covenant membership survives knock-out and both doctors keep independent cumulative layers', (t) => {
  const ids = ['chess_char_1_09_a', 'chess_char_1_17_a'];
  const c = create(t, { players: ['p1', 'p2'].map((playerId, seat) => ({ playerId,
    layers: { preciShip: seat ? 27 : 6 }, units: ids.map((chessId, i) => ({
      uid: (seat + 1) * 10000 + i + 1, chessId, row: 9 + seat, col: 4 + i, dir: 'RIGHT',
    })) })) });
  c.step();
  assert.equal(bond(c, 'p1', 'preciShip').count, 2); assert.equal(bond(c, 'p1', 'preciShip').active, true);
  assert.equal(bond(c, 'p2', 'preciShip').count, 2);
  const first = c.battle.getPlayer('p1').units[0]; c.battle.kill(first);
  assert.equal(first.alive, false); assert.equal(c.battle.isDown(first), true);
  assert.equal(bond(c, 'p1', 'preciShip').count, 2); assert.equal(bond(c, 'p1', 'preciShip').active, true);
  assert.equal(c.snapshot().progression.players.p1.layers.preciShip, 6);
  assert.equal(c.snapshot().progression.players.p2.layers.preciShip, 27);
  c.battle.addLayers('p1', 'preciShip', 1);
  assert.equal(c.snapshot().progression.players.p1.layers.preciShip, 7);
  assert.equal(c.snapshot().progression.players.p2.layers.preciShip, 27);
  assert.equal(c.battle.errorCount, 0);
  c.forceEnd(); const progression = c.result().progression.players;
  const next = create(t, { players: c.battle.players.map((player) => ({
    ...player.input, layers: undefined, progression: progression[player.playerId],
  })) });
  assert.equal(next.snapshot().progression.players.p1.layers.preciShip, 7);
  assert.equal(next.snapshot().progression.players.p2.layers.preciShip, 27);
});

test('preparation exposes only lineup operators and retains native equipment IDs in the combat adapter', () => {
  const f = prepFixture(['chess_char_1_02_a', 'chess_char_2_02_a', 'chess_char_4_11_a']);
  f.player.lineup = [10001, 10002]; syncMizukiPrep(f.player, f.context);
  const view = mizukiPrepView(f.player, f.context);
  assert.deepEqual(view.hand.filter(Boolean).map((piece) => piece.uid).sort(), [10001, 10002]);
  assert.equal(view.hand.some((piece) => piece?.uid === 10003), false);
  f.player.roster[0].items = [{ uid: 30001, id: 'item_test', kind: 'item' }];
  assert.equal(place(f, 10001, 9, 4, 'UP').ok, true);
  const [input] = mizukiPrepInput(f.player, f.context);
  assert.deepEqual([input.uid, input.row, input.col, input.dir, input.abs], [10001, 9, 4, 'UP', true]);
  assert.deepEqual(input.items, ['item_test']); assert.equal(f.player.roster[0].items[0].uid, 30001);
});

test('preparation enforces native terrain, obstacle, teammate occupancy, deploy cap and facing', () => {
  const f = prepFixture(); f.grid.setObstacle(9, 6, true);
  assert.equal(place(f, 10001, 9, 6).error, 'BAD_TILE');
  assert.equal(place(f, 10001, 9, 4, 'FORWARD').error, 'BAD_TARGET');
  assert.equal(place(f, 10001, 9, 4, 'RIGHT', { otherOccupied: new Set(['9,4']) }).error, 'BAD_TILE');
  assert.equal(place(f, 10001, 8, 4).error, 'BAD_TILE');
  const high = ground(); high.rows[10] = high.rows[10].slice(0, 4) + 'h' + high.rows[10].slice(5);
  f.context.grid = new Grid(high, RECT);
  assert.equal(place(f, 10001, 10, 4).error, 'BAD_TILE');
  assert.equal(place(f, 10002, 10, 4, 'LEFT').ok, true);
  assert.equal(place(f, 10001, 9, 4, 'RIGHT', { fieldDeployCount: 1, deployLimit: 1 }).error, 'BOARD_FULL');
  assert.equal(place(f, 10001, 9, 4, 'UP').ok, true);
  assert.equal(f.player.prep.board.find((piece) => piece.uid === 10001).dir, 'UP');
});

test('preparation swaps legal operators and refuses swaps whose destination terrain is illegal', () => {
  const f = prepFixture(); const stage = ground(); stage.rows[10] = stage.rows[10].slice(0, 4) + 'h' + stage.rows[10].slice(5);
  f.context.grid = new Grid(stage, RECT);
  assert.equal(place(f, 10001, 9, 4, 'UP').ok, true); assert.equal(place(f, 10002, 10, 4, 'LEFT').ok, true);
  const before = structuredClone(f.player.prep);
  assert.equal(place(f, 10001, 10, 4).error, 'BAD_TILE'); assert.deepEqual(f.player.prep, before);
  assert.equal(place(f, 10002, 9, 5, 'DOWN').ok, true); assert.equal(place(f, 10001, 9, 5, 'RIGHT').ok, true);
  const board = new Map(f.player.prep.board.map((piece) => [piece.uid, piece]));
  assert.deepEqual([board.get(10001).row, board.get(10001).col, board.get(10001).dir], [9, 5, 'RIGHT']);
  assert.deepEqual([board.get(10002).row, board.get(10002).col, board.get(10002).dir], [9, 4, 'DOWN']);
  assert.equal(validMizukiPrep(f.player.prep, f.player), true);
});

test('original Cathy summon stack splits once per placement, recombines on return and is recovered when its owner moves', () => {
  const f = prepFixture(['chess_char_4_11_a']);
  assert.equal(place(f, 10001, 9, 4).ok, true);
  let stack = f.player.prep.tokens.find((piece) => piece.count === 3); assert.ok(stack);
  assert.equal(place(f, stack.uid, 9, 5).ok, true);
  assert.equal(f.player.prep.tokens.reduce((sum, piece) => sum + piece.count, 0), 3);
  stack = f.player.prep.tokens.find((piece) => !f.player.prep.board.some((place) => place.uid === piece.uid)); assert.equal(stack.count, 2);
  assert.equal(place(f, stack.uid, 9, 6).ok, true);
  assert.equal(f.player.prep.tokens.reduce((sum, piece) => sum + piece.count, 0), 3);
  assert.equal(f.player.prep.tokens.filter((piece) => f.player.prep.board.some((place) => place.uid === piece.uid)).length, 2);
  const placed = f.player.prep.board.find((place) => place.uid !== 10001);
  assert.equal(moveMizukiPrep(f.player, placed.uid, { area: 'hand' }, 'RIGHT', f.context).ok, true);
  assert.equal(f.player.prep.tokens.find((piece) => f.player.prep.hand.includes(piece.uid)).count, 2);
  assert.equal(place(f, 10001, 10, 4, 'UP').ok, true);
  assert.deepEqual(f.player.prep.board.map((place) => place.uid), [10001]);
  assert.equal(f.player.prep.tokens.length, 1); assert.equal(f.player.prep.tokens[0].count, 3);
  assert.equal(validMizukiPrep(f.player.prep, f.player), true);
  const input = mizukiPrepInput(f.player, f.context); assert.equal(input.length, 1);
});

test('original Vigil summon placement follows the owner attack range and facing', () => {
  const f = prepFixture(['chess_char_3_19_a']); assert.equal(place(f, 10001, 10, 5, 'UP').ok, true);
  const token = f.player.prep.tokens[0]; assert.ok(token);
  const def = source.getChess('chess_char_3_19_a'); const range = attackRangeGrid(def.raw || def);
  const allowed = range.map(([dr, dc]) => offsetTile(10, 5, dr, dc, 'UP'))
    .find(([row, col]) => f.grid.inRect(row, col) && !(row === 10 && col === 5));
  assert.ok(allowed); assert.equal(mizukiPrepLegal(f.player, token, ...allowed, f.context), true);
  const outside = [9, 2]; assert.equal(mizukiPrepLegal(f.player, token, ...outside, f.context), false);
  assert.equal(place(f, token.uid, ...outside).error, 'BAD_TILE');
  assert.equal(place(f, token.uid, ...allowed).ok, true); assert.equal(validMizukiPrep(f.player.prep, f.player), true);
});

test('prepared original summon instances enter the first automatic deployment on their selected tiles', (t) => {
  const f = prepFixture(['chess_char_4_11_a']); assert.equal(place(f, 10001, 9, 4).ok, true);
  const stack = f.player.prep.tokens[0]; assert.equal(place(f, stack.uid, 9, 5, 'UP').ok, true);
  const input = mizukiPrepInput(f.player, f.context), tokenInput = input.find((piece) => piece.kind === 'token');
  assert.ok(tokenInput); assert.equal(tokenInput.ownerUid, 10001);
  const c = create(t, { players: [{ playerId: 'p1', units: input }] }); c.step();
  const token = c.battle.getPlayer('p1').units.find((piece) => piece.uid === tokenInput.uid);
  assert.ok(token); assert.equal(token.alive && token.deployed, true); assert.equal(token.kind, 'token');
  assert.deepEqual([token.tileR, token.tileC, token.dir], [9, 5, 'UP']);
  assert.equal(token.ownerUnit?.uid, 10001); assert.equal(c.battle.errorCount, 0);
});

test('preparation checkpoint rejects foreign or duplicated summon UIDs, owners and equipped token items', () => {
  const f = prepFixture(['chess_char_4_11_a']); assert.equal(place(f, 10001, 9, 4).ok, true);
  assert.equal(validMizukiPrep(f.player.prep, f.player), true);
  for (const corrupt of [
    (prep) => { prep.tokens[0].uid = 2000001; },
    (prep) => { prep.tokenSeq = 0; },
    (prep) => { prep.tokens[0].ownerUid = 20001; },
    (prep) => { prep.tokens.push(structuredClone(prep.tokens[0])); },
    (prep) => { prep.tokens[0].items = [{ uid: 30001, id: 'item_test' }]; },
    (prep) => { prep.hand[0] = 10001; },
  ]) { const prep = structuredClone(f.player.prep); corrupt(prep); assert.equal(validMizukiPrep(prep, f.player), false); }
});

test('native visible facility build masks block preparation and highlights before battleStart without exposing hidden facilities', () => {
  const f = prepFixture(['chess_char_1_02_a']), setup = createOfficialMizukiStage('ro2_t_2', { data: source, seed: 1 });
  const grid = new Grid(setup.stage, setup.rect), facilityBlocked = mizukiPrepFacilityBlocks(setup.officialLevel);
  const context = { ...f.context, grid, facilityBlocked };
  const instance = setup.officialLevel.predefines.tokenInsts.find((value) => !value.hidden && value.inst.characterKey === 'trap_027_stone');
  assert.ok(instance); const { row, col } = instance.position;
  assert.equal(grid.canStand(row, col, { ranged: false }), true, 'bare original terrain is buildable until the native facility rewrites it');
  const piece = mizukiPrepView(f.player, context).hand.filter(Boolean)[0];
  assert.equal(mizukiPrepLegal(f.player, piece, row, col, context), false);
  assert.equal(moveMizukiPrep(f.player, piece.uid, { area: 'board', row, col }, 'RIGHT', context).error, 'BAD_TILE');
  assert.equal(mizukiPrepView(f.player, context).legalTiles[piece.uid].some((tile) => tile[0] === row && tile[1] === col), false);
  f.player.prep.board.push({ uid: piece.uid, row, col, dir: 'RIGHT' }); syncMizukiPrep(f.player, context);
  assert.deepEqual(f.player.prep.board, [], 'carried positions cannot overlap a facility on the next original map');
  const hidden = structuredClone(setup.officialLevel);
  for (const entry of [...hidden.predefines.characterInsts, ...hidden.predefines.tokenInsts]) entry.hidden = true;
  assert.equal(mizukiPrepFacilityBlocks(hidden).size, 0);
});
