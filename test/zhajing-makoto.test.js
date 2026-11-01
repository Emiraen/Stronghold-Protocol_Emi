import test from 'node:test';
import assert from 'node:assert/strict';
import { getZhajingData } from '../server/modes/zhajing/Match.js';
import { makeBattle, enemyRec, chessRec } from './helpers/zhajingBattleHarness.js';

for (const index of [0, 1, 2]) for (const entry of ['skill', 'fatal']) for (const pos of [[9, 7], [9, 8], [10, 7], [11, 6]]) {
  test(`结城理技能${index + 1}，${entry}进入替身后攻击${pos}`, () => {
    const raw = getZhajingData().chess.chess_zj_60_5_b;
    const record = { ...raw, skill: raw.skills.find(s => s.index === index) };
    const h = makeBattle({ modeId: 'mode_single_zhajing',
      defs: { chess: { [raw.chessId]: record }, enemies: { audit_dummy: enemyRec({ key: 'audit_dummy', hp: 1e9, speed: 0 }) } },
      units: [{ chessId: raw.chessId, row: 9, col: 6 }],
      enemies: [{ key: 'audit_dummy', route: { motion: 'WALK', start: pos, end: pos, checkpoints: [] } }],
      autoFinish: false, timeLimit: 100, flags: { startOpCooldown: 0 }, captureNoisy: true,
    });
    h.step(); const u = h.unit(raw.chessId), e = h.enemies()[0];
    if (entry === 'skill') { u.skill.addCharge(1); assert.equal(u.skill.activate('test'), true); }
    else h.b.dealDamage(e, u, { amount: 1e7, type: 'true', canDodge: false });
    h.run(2);
    assert.equal(u.trait.doll, true);
    assert.equal(u.trait.dollSwitching, false);
    const before = u.stats.dmg, attacks = u.stats.attacks;
    h.run(5);
    assert.ok(u.stats.attacks > attacks, `mask=${u.mem.makotoMask} active=${u.skill.active} attacks=${u.stats.attacks} disarm=${u.s.flags.disarm}`);
    assert.ok(u.stats.dmg > before, `mask=${u.mem.makotoMask}, damage=${u.stats.dmg}`);
    assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors));
  });
}

function phaseFixture(index) {
  const raw = getZhajingData().chess.chess_zj_60_5_b;
  const record = { ...raw, skill: raw.skills.find(s => s.index === index) };
  const h = makeBattle({ modeId: 'mode_single_zhajing',
    defs: { chess: { [raw.chessId]: record, audit_heal: chessRec({ id: 'audit_heal', stats: { maxHp: 10000, atk: 0 } }) },
      enemies: { audit_dummy: enemyRec({ key: 'audit_dummy', hp: 1e9, atk: 0, def: 0, res: 90, speed: 0 }) } },
    units: [{ chessId: raw.chessId, row: 9, col: 6 }, { chessId: 'audit_heal', row: 9, col: 7 }],
    enemies: [{ key: 'audit_dummy', route: { motion: 'WALK', start: [9, 8], end: [9, 8], checkpoints: [] } }],
    autoFinish: false, timeLimit: 100, captureNoisy: true, flags: { startOpCooldown: 0 },
  });
  h.step(); return { h, u: h.unit(raw.chessId), e: h.enemies()[0], a: h.unit('audit_heal') };
}

for (const index of [0, 1, 2]) test(`结城理技能${index + 1}替身结束后恢复本体范围和面具状态`, () => {
  const { h, u, e } = phaseFixture(index); const grid = u.rangeGrid;
  u.skill.addCharge(1); assert.equal(u.skill.activate('test'), true); h.run(2);
  assert.equal(u.trait.doll, true); h.b.kill(e);
  assert.equal(h.runUntil(() => !u.trait.doll && !u.trait.dollSwitching, 60), true);
  assert.equal(u.mem.makotoMask, null); assert.deepEqual(u.rangeGrid, grid);
  assert.equal(h.b.errors.length, 0);
});

test('结城理一技能俄耳甫斯遇到低血队友时用本次攻击治疗，血量恢复后继续攻击', () => {
  const { h, u, e, a } = phaseFixture(0);
  u.skill.addCharge(1); u.skill.activate('test'); h.run(2); a.hp = 1000;
  const hp = a.hp, enemyHp = e.hp; h.b.forceAttack(u, [e]);
  assert.ok(a.hp > hp); assert.equal(e.hp, enemyHp);
  a.hp = a.s.maxHp; const before = u.stats.dmg; h.b.forceAttack(u, [e]);
  assert.ok(u.stats.dmg > before); assert.equal(u.mem.makotoMask, 'orpheus');
});

test('结城理三技能塔纳托斯受致命伤切俄耳甫斯，保持剩余时间并治疗、不普攻', () => {
  const { h, u, e, a } = phaseFixture(2);
  u.skill.addCharge(1); u.skill.activate('test'); h.run(3);
  h.b.dealDamage(e, u, { amount: 1e9, type: 'true', canDodge: false }); h.run(2);
  assert.equal(u.mem.makotoMask, 'orpheus'); assert.equal(u.alive, true);
  a.hp = 1000; const hp = a.hp, attacks = u.stats.attacks;
  h.run(3); assert.ok(a.hp > hp); assert.equal(u.stats.attacks, attacks);
  assert.equal(h.b.errors.length, 0);
});

test('结城理三技能塔纳托斯按敌人的弱点结算实际伤害', () => {
  const { h, u, e } = phaseFixture(2);
  u.skill.addCharge(1); u.skill.activate('test'); h.run(2);
  h.b.addBuff(u, { key: 'audit:noCrit', mods: { critRate: -1 } });
  const before = u.stats.dmg; h.b.forceAttack(u, [e]);
  const hit = h.hooks.damaged.filter(c => c.source === u && c.target === e).at(-1);
  assert.equal(hit.dmg.type, 'phys'); assert.ok(u.stats.dmg - before > u.s.atk);
});
