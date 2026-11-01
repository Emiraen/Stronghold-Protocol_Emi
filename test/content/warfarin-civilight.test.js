import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle } from '../helpers/battleHarness.js';
import { makeBattle as makeZhajing } from '../helpers/zhajingBattleHarness.js';
import { DataSource as ZhajingSource } from '../../server/modes/zhajing/engine/server/sim/simdata.js';
import { getZhajingData } from '../../server/modes/zhajing/Match.js';
import { MizukiCombat, MizukiAutoCombat } from '../../server/modes/mizuki/Combat.js';
import { GRANTED_CAP_OVERRIDE } from '../../server/sim/content/garrisons/battle.js';
import { dirVec, dirFromDelta } from '../../server/sim/dir.js';
import { ENDLESS_MODE_ID } from '../../shared/constants.js';

const directions = ['RIGHT', 'LEFT', 'UP', 'DOWN'];
const active = (layers = 0) => ({ count: 3, active: true, tier: 1, layers });
function lineup({ direction = 'RIGHT', pointing = 'recipient', mw = 'a', war = 'a', tier = 4 } = {}) {
  const [dr, dc] = dirVec(direction), target = [10, 6];
  // Warfarin always faces the recipient; Civilight approaches from another side.
  const warfarin = [target[0] - dc, target[1] + dr];
  const facing = pointing === 'recipient' ? target : warfarin;
  return [
    { uid: 101, chessId: `chess_char_${tier === 4 ? '4_25' : '5_09'}_${mw}`, row: facing[0] - dr, col: facing[1] - dc, dir: direction },
    { uid: 102, chessId: `chess_char_${tier === 4 ? '4_26' : '5_04'}_${war}`, row: warfarin[0], col: warfarin[1], dir: dirFromDelta(dc, -dr) },
    { uid: 103, chessId: 'chess_char_1_09_a', row: target[0], col: target[1], dir: 'RIGHT' },
    { uid: 104, chessId: 'chess_char_1_17_a', row: 12, col: 3, dir: 'RIGHT' },
  ];
}
function cast(unit, manualCombat = null) {
  unit.skill.end('test-cycle');
  unit.skill.addCharge(1);
  if (manualCombat) assert.equal(manualCombat.command(unit.ownerId, { type: 'skill', uid: unit.uid }).ok, true, 'real manual skill command succeeds');
  else assert.equal(unit.skill.activate('test'), true, 'activates the real selected skill');
}
const modes = [
  ['常规', makeBattle, {}],
  ['湮灭', makeBattle, { modeId: 'mode_single_annihilation' }],
  ['无尽', makeBattle, { modeId: ENDLESS_MODE_ID, flags: { uncappedBondLayers: true } }],
  ['独眼巨人', makeBattle, { modeId: 'mode_cyclops' }],
  ['炸惊', makeZhajing, { modeId: 'mode_single_zhajing', data: new ZhajingSource(getZhajingData()) }],
];
for (const [name, make, extra] of modes) for (const tier of [4, 5]) for (const mw of ['a', 'b']) for (const war of ['a', 'b']) {
  test(`${name}: T${tier} 魔王${mw}/华法琳${war} strengthens granted traits in all directions until their original cap`, () => {
    const base = war === 'a' ? 1 : 2, bonus = mw === 'a' ? 1 : 2;
    const cap = name === '炸惊' ? getZhajingData().garrisons[`garrison_95_${war}`].bb.max_add_count_per_battle : GRANTED_CAP_OVERRIDE[`garrison_95_${war}`];
    for (const direction of directions) {
      const h = make({ ...extra, units: lineup({ direction, mw, war, tier }),
        bonds: { preciShip: active(), arcaneShip: { count: 1, active: false, tier: 0, layers: 0 } },
        autoFinish: false, timeLimit: 180 });
      h.step(); const target = h.unit(103);
      assert(target, 'real recipient is on the field');
      const before = h.result().perPlayer.p1.layerGains.preciShip || 0;
      cast(target);
      assert.equal(h.result().perPlayer.p1.layerGains.preciShip - before, base + bonus, direction);
      for (let i = 1; i < 30; i++) cast(target);
      assert.equal(h.result().perPlayer.p1.layerGains.preciShip, cap + Math.ceil(cap / base) * bonus, 'bonus does not consume the granted trait cap');
      assert.equal(h.result().perPlayer.p1.layerGains.arcaneShip || 0, 0, 'inactive bonds receive no layers');
      assert.equal(h.b.errorCount, 0);
    }
  });
}
for (const Combat of [MizukiCombat, MizukiAutoCombat]) for (const mw of ['a', 'b']) for (const war of ['a', 'b']) {
  test(`${Combat.name}: 魔王${mw}/华法琳${war} real casts, caps and grantor-only control`, () => {
    for (const pointing of ['recipient', 'grantor']) {
      const units = lineup({ pointing, direction: 'RIGHT', mw, war });
      const c = new Combat({ battleId: 'warfarin-civilight', seed: 43, stageId: 'act1autochess_m02',
        rect: { r0: 9, r1: 12, c0: 2, c1: 10 },
        players: [{ playerId: 'p1', units, bonds: { preciShip: active() } }],
        flags: { dpInit: 999, dpMax: 999 }, timeLimit: 180,
        spawns: [{ time: 150, enemyKey: 'enemy_1007_slime', count: 1 }] });
      if (Combat === MizukiCombat) for (const u of units) assert.equal(c.command('p1', { type: 'deploy', uid: u.uid, row: u.row, col: u.col, dir: u.dir }).ok, true);
      else c.step();
      const target = c.battle.getPlayer('p1').units.find(u => u.uid === 103);
      const base = war === 'a' ? 1 : 2, bonus = pointing === 'recipient' ? mw === 'a' ? 1 : 2 : 0;
      const gains = () => c.battle.result().perPlayer.p1.layerGains.preciShip || 0;
      const manual = Combat === MizukiCombat ? c : null;
      cast(target, manual); assert.equal(gains(), base + bonus);
      for (let i = 1; i < 30; i++) cast(target, manual);
      const cap = GRANTED_CAP_OVERRIDE[`garrison_95_${war}`];
      assert.equal(gains(), cap + cap / base * bonus);
      assert.equal(c.battle.errorCount, 0);
    }
  });
}
for (const [name, make, extra] of modes) test(`${name}: pointing at Warfarin alone does not boost the recipient`, () => {
  const h = make({ ...extra, units: lineup({ pointing: 'grantor' }), bonds: { preciShip: active() }, autoFinish: false });
  h.step(); cast(h.unit(103));
  assert.equal(h.result().perPlayer.p1.layerGains.preciShip, 1);
  assert.equal(h.b.errorCount, 0);
});
