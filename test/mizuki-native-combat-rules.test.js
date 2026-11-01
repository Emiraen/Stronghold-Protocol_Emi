import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { mizukiDeployCost, mizukiDeploySlots, mizukiRetreatRefund } from '../server/modes/mizuki/NativeCombatRules.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';

const catalog = createMizukiCatalog(getData());
const create = (ids, extra = {}) => new MizukiCombat({
  fieldId: 'mizuki_native_rules', seed: 42, stageId: 'act1autochess_m02',
  rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, data: catalog.source,
  players: [{ playerId: 'p1', units: ids.map((chessId, i) => ({ uid: 101 + i, chessId })) }],
  flags: { dpInit: 999, dpMax: 999 }, spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }], ...extra,
});
const deploy = (c, uid = 101, row = 9, col = 5) => c.command('p1', { type: 'deploy', uid, row, col, dir: 'RIGHT' });
const retreat = (c, uid = 101) => c.command('p1', { type: 'retreat', uid });
const op = (c, uid = 101) => c.battle.getPlayer('p1').units.find((u) => u.uid === uid);
const card = (c, uid = 101) => c.snapshot().rosters.p1.find((u) => u.uid === uid);

test('Mizuki native rules retain original client hashes and all 57 catalog token prefab slot values', () => {
  const data = JSON.parse(readFileSync(new URL('../data/mizuki/native-combat-rules.json', import.meta.url), 'utf8'));
  const units = JSON.parse(readFileSync(new URL('../data/mizuki/operators.json', import.meta.url), 'utf8'));
  assert.match(data.source.gameAssemblySha256, /^[a-f0-9]{64}$/);
  assert.match(data.source.metadataSha256, /^[a-f0-9]{64}$/);
  for (const id of Object.keys(units.tokens)) assert.ok(data.entities[id], id);
  assert.equal(data.entities.token_10002_kalts_mon3tr.occupiedRemainingCharacterCnt, 1);
  assert.equal(data.entities.token_10000_silent_healrb.occupiedRemainingCharacterCnt, 0);
  assert.equal(data.entities.token_10030_mlyss_wtrman.occupiedRemainingCharacterCnt, 0);
  assert.equal(data.entities.token_10028_vigil_wolf.occupiedRemainingCharacterCnt, 0);
  assert.equal(data.deploySlotOverrides.token_10020_ling_soul3.volume, 2);
  assert.ok(data.source.bundles.some((bundle) => bundle.path === 'config/buff_template_holder.ab'));
  assert.equal(data.moduleWithdrawPolicy.dontLimitMaxWithdrawCost, true);
});

test('Mizuki ordinary operator pays base, floor 1.5x, then 2x; invalid commands do not advance cost', () => {
  const c = create(['chess_char_1_02_a']); const u = op(c);
  const base = u.base.cost; assert.equal(base, 17);
  const seen = []; c.battle.on('deploy', ({ unit }) => { if (unit === u) seen.push(c.battle.getPlayer('p1').dp); });
  for (const cost of [17, 25, 34, 34]) {
    u.respawnAt = c.time;
    const before = c.battle.getPlayer('p1').dp;
    assert.equal(card(c).cost, cost);
    assert.equal(deploy(c).cost, cost);
    assert.equal(seen.at(-1), before - cost, 'original deploy hooks see already-paid DP');
    assert.equal(card(c).paidCost, cost);
    assert.equal(deploy(c).error, 'ALREADY_DEPLOYED');
    const r = retreat(c); assert.equal(r.refund, Math.min(Math.floor(cost / 2), base));
    assert.equal(retreat(c).error, 'NOT_DEPLOYED');
    assert.equal(deploy(c).error, 'COOLDOWN');
    assert.equal(u.base.cost, base, 'kit/base stats were not temporarily overwritten');
  }
  assert.equal(u._mizukiDeployCount, 4);
});

test('Mizuki quick-redeploy Gravel keeps the real -1 talent cost and never refunds death', () => {
  const c = create(['chess_char_2_12_a']); const u = op(c);
  assert.equal(u.base.cost, 5);
  assert.equal(deploy(c).cost, 5); assert.equal(retreat(c).refund, 2);
  assert.ok(u.respawnAt - c.time < 20); u.respawnAt = c.time;
  assert.equal(deploy(c).cost, 7);
  const before = c.battle.getPlayer('p1').dp; c.battle.kill(u);
  assert.equal(c.battle.getPlayer('p1').dp, before);
  assert.equal(retreat(c).error, 'NOT_DEPLOYED');
  u.respawnAt = c.time; assert.equal(deploy(c).cost, 10);
});

test('Mizuki Charger refunds original cost on repeated deployments; Merchant refunds nothing', () => {
  for (const [id, ratio] of [['chess_char_1_05_a', 1], ['chess_char_3_04_a', 0]]) {
    const c = create([id]); const u = op(c); const base = u.base.cost;
    assert.equal(deploy(c).cost, base); assert.equal(retreat(c).refund, base * ratio);
    u.respawnAt = c.time; assert.equal(deploy(c).cost, Math.floor(base * 1.5));
    assert.equal(retreat(c).refund, base * ratio);
  }
});

test('Mizuki Mon3tr consumes shared slots, returns no DP and does not increase token redeployment cost', () => {
  const c = create(['mizuki_char_003_kalts', 'chess_char_1_02_a'], { deployLimit: 2 });
  assert.equal(deploy(c, 101, 10, 4).ok, true);
  const t = c.snapshot().rosters.p1.find((u) => u.tokenId === 'token_10002_kalts_mon3tr');
  assert.equal(t.deploySlots, 1); assert.equal(deploy(c, t.uid).cost, 10);
  assert.equal(c.snapshot().deploySlotsUsed, 2);
  assert.equal(deploy(c, 102, 9, 6).error, 'DEPLOY_LIMIT');
  assert.equal(retreat(c, t.uid).refund, 0);
  assert.equal(c.snapshot().deploySlotsUsed, 1);
  const token = op(c, t.uid); token.respawnAt = c.time; token.mem.readyAt = c.time; token.mem.respawnAt = c.time;
  assert.equal(deploy(c, t.uid).cost, 10);
  assert.equal(retreat(c, 101).ok, true);
  assert.equal(c.snapshot().deploySlotsUsed, 0, 'original owner removal also removes Mon3tr');
});

test('Mizuki medical drone is deployable at full cap after its real skill generates stock', () => {
  const silent = catalog.operators.find((o) => o.charId === 'char_108_silent');
  const c = create([silent.operatorId], { deployLimit: 1 }); const owner = op(c);
  assert.equal(deploy(c, owner.uid, 10, 4).ok, true);
  const t = c.snapshot().rosters.p1.find((u) => u.tokenId === 'token_10000_silent_healrb');
  assert.ok(t); assert.equal(t.deploySlots, 0);
  assert.equal(deploy(c, t.uid).error, 'NO_SUMMON_STOCK', 'no old-auto-mode free opening summon');
  owner.skill.setSpTotal(owner.skill.spCost * owner.skill.maxCharges);
  assert.equal(owner.skill.manual, false, 'original medical drone is an AUTO inventory-generation skill');
  c.step();
  assert.equal(owner.skill.activations, 1);
  assert.equal(c.snapshot().deploySlotsUsed, 1);
  const stock = owner.mem.summonStock[t.tokenId]; const cost = card(c, t.uid).cost;
  assert.equal(deploy(c, t.uid).cost, cost);
  assert.equal(owner.mem.summonStock[t.tokenId], stock - 1);
  assert.equal(c.snapshot().deploySlotsUsed, 1);
  assert.equal(retreat(c, t.uid).refund, 0);
});

test('Mizuki Ling fusion retains two slots in both directions and returns to one after retreat', () => {
  const ling = catalog.operators.find((o) => o.charId === 'char_2023_ling');
  for (const dir of ['RIGHT', 'LEFT']) {
    const c = create([], { deployLimit: 3, players: [{ playerId: 'p1', units: [
      { uid: 101, chessId: ling.promotionChessId, skillIndex: 2 }, { uid: 102, chessId: 'chess_char_1_02_a' },
    ] }] });
    assert.equal(op(c).skill.id, 'skchr_ling_3');
    assert.equal(deploy(c, 101, 10, 4).ok, true);
    const tokens = c.snapshot().rosters.p1.filter((u) => u.tokenId === 'token_10020_ling_soul3');
    assert.ok(tokens.length >= 2);
    assert.equal(tokens[0].summonHeld, 5);
    assert.equal(tokens[0].summonDeployLimit, 3);
    assert.equal(deploy(c, tokens[0].uid, 9, 5).ok, true);
    assert.equal(c.snapshot().deploySlotsUsed, 2);
    assert.equal(c.command('p1', { type: 'deploy', uid: tokens[1].uid, row: 9, col: 6, dir }).ok, true);
    const standing = c.battle.allyUnits.filter((u) => u.defId === 'token_10020_ling_soul3' && u.alive && u.deployed);
    assert.equal(standing.length, 1);
    const advanced = standing[0];
    assert.equal(card(c, advanced.uid).summonHeld, 3);
    assert.equal(advanced.mem.lingAdvanced, true);
    assert.equal(card(c, advanced.uid).deploySlots, 2);
    assert.equal(c.snapshot().deploySlotsUsed, 3);
    assert.equal(deploy(c, 102, 11, 5).error, 'DEPLOY_LIMIT');
    assert.equal(retreat(c, advanced.uid).refund, 0);
    assert.ok(card(c, advanced.uid).redeployRemaining > 0, 'the real summon deck cooldown remains enforced');
    assert.equal(deploy(c, advanced.uid, 9, 5).error, 'COOLDOWN');
    assert.equal(c.snapshot().deploySlotsUsed, 1);
    assert.equal(card(c, advanced.uid).deploySlots, 1, 'next deployment uses the basic form despite the old flag');
    advanced.respawnAt = c.time; advanced.mem.readyAt = c.time; advanced.mem.respawnAt = c.time; advanced.mem.deckReadyAt = c.time;
    assert.equal(deploy(c, advanced.uid, 9, 5).ok, true);
    assert.equal(advanced.mem.lingAdvanced, false);
    assert.equal(c.snapshot().deploySlotsUsed, 2);
  }
});

test('Mizuki summon deck enforces native volume capacity and consumes its real five-piece stock', () => {
  const ling = catalog.operators.find((o) => o.charId === 'char_2023_ling');
  const c = create([], { deployLimit: 8, players: [{ playerId: 'p1', units: [
    { uid: 101, chessId: ling.promotionChessId, skillIndex: 2 },
  ] }] });
  assert.equal(deploy(c, 101, 10, 4).ok, true);
  const tokens = c.snapshot().rosters.p1.filter((u) => u.tokenId === 'token_10020_ling_soul3');
  assert.equal(tokens.length, 3);
  const ready = (unit) => {
    unit.respawnAt = c.time; unit.mem.readyAt = c.time; unit.mem.respawnAt = c.time; unit.mem.deckReadyAt = c.time;
  };
  assert.equal(deploy(c, tokens[0].uid, 9, 5).ok, true);
  assert.equal(deploy(c, tokens[1].uid, 9, 6).ok, true);
  assert.equal(op(c, tokens[1].uid).mem.lingAdvanced, true);
  assert.equal(deploy(c, tokens[2].uid, 11, 8).ok, true);
  assert.equal(c.snapshot().deploySlotsUsed, 4, 'global field capacity still has room');
  ready(op(c, tokens[0].uid));
  const before = c.snapshot().dps.p1;
  assert.equal(deploy(c, tokens[0].uid, 9, 5).error, 'SUMMON_LIMIT', 'large dragon consumes two of the three summon slots');
  assert.equal(c.snapshot().dps.p1, before);
  assert.equal(card(c, tokens[0].uid).summonHeld, 2);
  assert.equal(retreat(c, tokens[2].uid).refund, 0);
  assert.equal(deploy(c, tokens[0].uid, 9, 5).ok, true);
  assert.equal(card(c, tokens[0].uid).summonHeld, 1);
  assert.equal(retreat(c, tokens[0].uid).refund, 0);
  ready(op(c, tokens[0].uid));
  const cost = card(c, tokens[0].uid).cost;
  assert.equal(deploy(c, tokens[0].uid, 9, 5).cost, cost, 'summons never gain the operator redeploy multiplier');
  assert.equal(card(c, tokens[0].uid).summonHeld, 0);
  assert.equal(retreat(c, tokens[0].uid).refund, 0);
  ready(op(c, tokens[0].uid));
  assert.equal(deploy(c, tokens[0].uid, 9, 5).error, 'NO_SUMMON_STOCK');
});

test('Mizuki refund helper honors real EXE-X and CHG-X selected-module blackboards', () => {
  const original = getData();
  for (const [id, ratio] of [['chess_char_2_12_b', 0.8], ['chess_char_1_19_b', 1]]) {
    const raw = original.chess[id]; assert.ok(raw);
    const u = { kind: 'op', defId: id, def: { raw, charId: raw.charId, trait: raw.trait, talents: raw.talents },
      base: { cost: raw.stats.cost }, _mizukiPaidCost: raw.stats.cost * 2, _mizukiDeployCount: 2 };
    assert.equal(mizukiRetreatRefund(u), Math.floor(Math.fround(u._mizukiPaidCost * Math.fround(ratio))));
    assert.equal(mizukiDeployCost(u), raw.stats.cost * 2); assert.equal(mizukiDeploySlots(u), 1);
  }
});
