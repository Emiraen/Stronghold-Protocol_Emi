// #28：使用真实 Battle、完整内容、真实叙拉古成员和 enemy_10027_vtsk，验证轰炸二次选人。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, checkInvariants } from '../helpers/battleHarness.js';
import { getDefaultSource, hasGeneratedData } from '../../server/sim/simdata.js';
import { canTargetAlly } from '../../server/sim/targeting.js';

const ENEMY = 'enemy_10027_vtsk'; // 本地真实名称：“帝国的甲胄”，不是假想敌：胄。
const TARGET = 'chess_char_1_08_a';
const BAIT = 'chess_char_1_02_a';
const MEMBERS = [TARGET, 'chess_char_2_16_a', 'chess_char_3_18_a', 'chess_char_4_16_a', 'chess_char_1_07_a', 'chess_char_4_10_a'];
const POSITIONS = [[9, 5], [9, 3], [12, 3], [12, 4], [11, 3], [10, 3]];
const CASES = [
  { state: 'stealth', label: '叙拉古6有效隐匿：主目标排除后，周围二次选择仍免伤', hits: 0, selectable: false },
  { state: 'removed', label: '真实羁绊隐匿移除后：仍受轰炸伤害', hits: 8, selectable: true },
  { state: 'blocked', label: '真实阻挡该甲胄：保留隐匿标记但仍受轰炸伤害', hits: 8, selectable: true },
  { state: 'reveal', label: '反隐reveal使隐匿失效：仍受轰炸伤害', hits: 8, selectable: true },
  { state: 'camou', label: '迷彩不是隐匿：主目标排除但仍受周围轰炸伤害', hits: 8, selectable: false },
];

for (const spec of CASES) test(`EMI28 ${spec.label}`, () => {
  assert.ok(hasGeneratedData(), '必须加载本地真实数据，不能跳过或改用模拟敌人');
  const rec = getDefaultSource().rawEnemy(ENEMY);
  assert.equal(rec.name, '“帝国的甲胄”');
  assert.equal(rec.skills.find((s) => s.prefabKey === 'Appear').bb.times, 8);
  const h = makeBattle({
    seed: 28, autoFinish: false, timeLimit: 5, content: 'full',
    hooks: ['damaged', 'blocked'], captureNoisy: true,
    units: [
      ...MEMBERS.map((chessId, i) => ({ chessId, row: POSITIONS[i][0], col: POSITIONS[i][1] })),
      { chessId: BAIT, row: 9, col: 6 },
    ],
    bonds: { siracusaShip: { count: 6, active: true, tier: 2, layers: 0 } },
  });
  h.step();
  const target = h.unit(TARGET), bait = h.unit(BAIT);
  for (const id of MEMBERS) {
    const u = h.unit(id);
    assert.ok(u.alive && u.deployed && u.s.flags.stealth, `${id}必须真实部署并获得叙拉古6隐匿`);
    assert.ok(u.buffs.some((b) => b.key === 'bond:siracusa:stealth'));
  }
  // 固定生命优先级和禁止干员技能/治疗，避免其他内容掩盖轰炸的实际命中。
  for (const u of h.allies()) h.b.addBuff(u, { key: 'emi28:fixture', persist: true, flags: { disarm: true, silence: true } });
  for (const [u, extra] of [[target, 100000], [bait, 50000]]) {
    h.b.addBuff(u, { key: 'emi28:hp', persist: true, mods: { hpFlat: extra } });
    u.hp = u.s.maxHp;
  }
  assert.ok(target.hp > bait.hp, '有效隐匿目标在范围内且生命更高，旧二次选择会错误命中它');
  assert.ok(!bait.s.flags.stealth, '附近有真正可选的非隐匿主目标');
  if (spec.state === 'removed' || spec.state === 'camou') h.b.removeBuff(target, 'bond:siracusa:stealth');
  if (spec.state === 'reveal') h.b.addBuff(target, { key: 'emi28:reveal', persist: true, flags: { reveal: true } });
  if (spec.state === 'camou') h.b.addBuff(target, { key: 'emi28:camou', persist: true, flags: { camou: true } });
  const e = h.spawn(ENEMY, { pos: spec.state === 'blocked' ? [9, 5] : [9, 8], mods: { speedMul: 0 } });
  // 仅隔离普通攻击；不替换敌人技能、不直接调用hurt或damage，轰炸由真实spawn延迟回调执行。
  h.b.addBuff(e, { key: 'emi28:noNormalAttack', persist: true, flags: { disarm: true } });
  h.run(0.1);
  if (spec.state === 'blocked') {
    assert.equal(e.blockedBy, target, '由真实AI建立阻挡，而非手动伪造blockedBy');
    assert.ok(target.blocking.includes(e));
    assert.ok(target.s.flags.stealth, '我方阻挡并不删除隐匿标记');
    assert.ok(h.hooksOf('blocked').some((c) => c.enemy === e || c.unit === target || c.blocker === target));
  } else assert.equal(e.blockedBy, null);
  assert.equal(canTargetAlly(e, target, true), spec.selectable, '主目标选择遵守隐匿、阻挡、反隐和迷彩语义');
  const hpBefore = target.hp;
  h.run(0.7);
  const hits = h.hooksOf('damaged').filter((c) => c.source === e && c.dmg.tags.includes('enemyAbility'));
  const targetHits = hits.filter((c) => c.target === target);
  const baitHits = hits.filter((c) => c.target === bait);
  assert.equal(hits.length, 8, '八发真实轰炸均执行，不能靠取消技能实现免伤');
  assert.equal(targetHits.length, spec.hits);
  assert.equal(baitHits.length, 8 - spec.hits);
  assert.ok(hits.every((c) => c.type === 'phys' && c.amount > 0), '可受伤目标保持物理伤害');
  if (spec.hits === 0) assert.equal(target.hp, hpBefore, '有效隐匿干员生命不变');
  else assert.ok(target.hp < hpBefore, '隐匿失效时真实扣血');
  checkInvariants(h.b);
  assert.deepEqual(h.b.errors, []);
  console.log(`EMI28_RESULT ${JSON.stringify({ state: spec.state, enemy: ENEMY, expectedTargetHits: spec.hits, actualTargetHits: targetHits.length, baitHits: baitHits.length, totalHits: hits.length, hpBefore, hpAfter: target.hp, blockedByTarget: e.blockedBy === target, stealth: !!target.s.flags.stealth, reveal: !!target.s.flags.reveal })}`);
});
