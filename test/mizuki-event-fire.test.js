import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
import { createOfficialMizukiStage, resolveOfficialEnemy } from '../server/modes/mizuki/official-stages.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { normalizeEnemy } from '../server/sim/simdata.js';
import { abOf, attach } from '../server/sim/content/enemies.js';
import { enemyStealthed } from '../server/sim/targeting.js';
import { MIZUKI_EVENT_FIRE_KITS, snapshotMizukiEventFireEffects } from '../server/modes/mizuki/native-event-fire-enemies.js';

const boards = (entries = []) => ({
  bb: Object.fromEntries(entries.map((v) => [v.key, v.value])),
  bbStr: Object.fromEntries(entries.filter((v) => v.valueStr != null).map((v) => [v.key, v.valueStr])),
});

function realBattle() {
  const catalog = createMizukiCatalog(getData());
  const options = createOfficialMizukiStage('ro2_n_1_1', { data: catalog.source });
  const data = Object.create(options.data);
  data.getEnemy = (id) => {
    if (!MIZUKI_EVENT_FIRE_KITS[id]) return options.data.getEnemy(id);
    const s = resolveOfficialEnemy({ id, level: 0, useDb: true });
    return normalizeEnemy(id, { key: id, name: s.name, spine: s.prefabKey, applyWay: s.applyWay,
      officialData: s, stats: { ...s.attributes, res: s.attributes.magicResistance, rangeRadius: s.rangeRadius,
        motion: s.motion, lpr: s.lifePointReduce }, talents: boards(s.talentBlackboard ?? []),
      skills: (s.skills ?? []).map((v) => ({ ...v, ...boards(v.blackboard ?? []) })) });
  };
  const combat = new MizukiCombat({ ...options, data, seed: 7, content: 'full',
    players: [{ playerId: 'p1', units: [{ uid: 101, chessId: 'chess_char_1_02_a' }] }],
    flags: { dpInit: 999, dpMax: 999 } });
  const tile = combat.snapshot().geometry.tiles.find((v) => combat.battle.grid.canStand(v.row, v.col, { ranged: false }) && !v.obstacle);
  assert.equal(combat.command('p1', { type: 'deploy', uid: 101, row: tile.row, col: tile.col, dir: 'RIGHT' }).ok, true);
  const b = combat.battle, u = b.getPlayer('p1').units[0];
  b.addBuff(u, { key: 'test:hp', mods: { hpFlat: 1000000 } }); u.hp = u.s.maxHp;
  return { combat, b, u };
}
function native(b, id, options) {
  const e = b.spawnEnemy(id, options);
  if (!e.mem._mizukiOfficialKit) {
    const ab = abOf(b, e); ab.list = []; attach(b, e, MIZUKI_EVENT_FIRE_KITS[id](ab, e, b));
  }
  return e;
}
const runAt = (b, time) => { b.time = time; b._runScheduled(); };
const stripStatus = (b, u, name) => { for (const buff of [...u.buffs]) if (buff.flags?.[name]) b.removeBuff(u, buff); };

test('native cadet variants have arts tracking attacks and reveal throughout their exact seven-second charge', () => {
  for (const id of ['enemy_1184_cadkgt', 'enemy_1184_cadkgt_2']) {
    const { b, u } = realBattle(), e = native(b, id); e.x = u.x - 1; e.y = u.y;
    assert.equal(enemyStealthed(e), true);
    assert.deepEqual(e.def.attackAnim, { dur: 1.833, hit: .667 });
    let hp = u.hp; b.emit('attack', { attacker: e, targets: [u] });
    assert.equal(u.hp, hp); b.projectiles.update(.1);
    assert.ok(Math.abs(hp - u.hp - e.s.atk * (1 - u.s.res / 100)) < 1e-8);
    hp = u.hp; b.emit('tick', { dt: 24.99 }); assert.equal(enemyStealthed(e), true);
    b.emit('tick', { dt: .01 }); assert.equal(enemyStealthed(e), false); assert.equal(e.s.flags.noMove, true);
    runAt(b, 5.666); assert.equal(u.hp, hp);
    runAt(b, 5.667); assert.ok(Math.abs(hp - u.hp - e.s.atk * 2.5 * (1 - u.s.res / 100)) < 1e-8);
    runAt(b, 6.999); assert.equal(enemyStealthed(e), false);
    runAt(b, 7); assert.equal(enemyStealthed(e), true); assert.equal(!!e.profile.noAttack, false);
    assert.equal(b.errorCount, 0);
  }
});

test('cadet charge caches its input point and stops on stun while its passive stealth survives silence', () => {
  const { b, u } = realBattle(), e = native(b, 'enemy_1184_cadkgt'); e.x = u.x - 1; e.y = u.y;
  b.applyStatus(e, 'silence', { duration: 30 }); b.emit('tick', { dt: 25 });
  assert.equal(e.mem.mizukiCadet.cast, null); assert.equal(enemyStealthed(e), true);
  stripStatus(b, e, 'silence'); b.emit('tick', { dt: 0 }); const point = { ...e.mem.mizukiCadet.cast };
  u.x += 4; const hp = u.hp; runAt(b, 5.667); assert.equal(u.hp, hp);
  assert.equal(point.x + 4, u.x);
  runAt(b, 7); u.x -= 4; b.emit('tick', { dt: 25 });
  b.applyStatus(e, 'stun', { duration: 2 }); assert.equal(e.mem.mizukiCadet.cast, null);
  runAt(b, 20); assert.equal(u.hp, hp); assert.equal(b.errorCount, 0);
});

test('native shaper uses separate attack/combat timers, native summon hit timing, route inheritance and silence immunity', () => {
  const { b, u } = realBattle(), e = native(b, 'enemy_1176_dusocr'); e.x = u.x + 2; e.y = u.y;
  e.route.legs = [{ t: 'wait', time: 30 }, { t: 'move', r: e.y, c: e.x - 1 },
    { t: 'disappear' }, { t: 'appear', r: e.y, c: e.x - 2 }, { t: 'move', r: e.y, c: e.x - 3, final: true }];
  b.applyStatus(e, 'silence', { duration: 100 });
  b.emit('tick', { dt: 2.99 }); assert.equal(e.mem.mizukiShaper.cast, null);
  b.emit('tick', { dt: .01 }); assert.ok(e.mem.mizukiShaper.cast);
  runAt(b, .766); assert.equal(b.enemies.filter((v) => v.defId === 'enemy_1177_dufrbl').length, 0);
  runAt(b, .767); let children = b.enemies.filter((v) => v.defId === 'enemy_1177_dufrbl');
  assert.equal(children.length, 1); assert.equal(children[0].x, e.x); assert.equal(children[0].y, e.y);
  assert.equal(children[0].base.moveSpeed, 2.5); assert.equal(children[0].lpr, 0); assert.ok(children[0].route.legs.length);
  // Explicitly attach when the registry is not yet part of this fixture.
  if (!children[0].mem.mizukiFlame) attach(b, children[0], MIZUKI_EVENT_FIRE_KITS.enemy_1177_dufrbl(abOf(b, children[0])));
  assert.deepEqual(children[0].route.legs.map((leg) => leg.t), ['move', 'move']);
  runAt(b, 1.333); e.blockedBy = u;
  b.emit('tick', { dt: 2 }); assert.ok(e.mem.mizukiShaper.cast);
  runAt(b, 2.1); children = b.enemies.filter((v) => v.defId === 'enemy_1177_dufrbl'); assert.equal(children.length, 2);
  assert.equal(b.errorCount, 0);
});

test('native shaper cannot release a cancelled cast and never enables generic attacks', () => {
  const { b } = realBattle(), e = native(b, 'enemy_1176_dusocr');
  b.emit('tick', { dt: 3 }); b.applyStatus(e, 'stun', { duration: 2 }); runAt(b, 1);
  assert.equal(b.enemies.filter((v) => v.defId === 'enemy_1177_dufrbl').length, 0);
  assert.equal(e.profile.noAttack, true); assert.equal(b.errorCount, 0);
});

test('native fireball weakens every tenth-second, remains untargetable and expires after ten seconds', () => {
  const { b, u } = realBattle(), e = native(b, 'enemy_1177_dufrbl'); e.x = u.x + 3; e.y = u.y;
  assert.equal(e.s.flags.invulnerable, true); assert.equal(e.s.flags.untargetable, true); assert.equal(!!e.s.flags.unblockable, false);
  assert.equal(e.s.atk, 500); b.emit('tick', { dt: .099 }); assert.equal(e.s.atk, 500);
  b.emit('tick', { dt: .001 }); assert.equal(e.s.atk, 496.5);
  b.emit('tick', { dt: 4.9 }); assert.equal(e.s.atk, 325);
  const hp = e.hp; b.dealDamage(u, e, { amount: 1000000, type: 'true' }); assert.equal(e.hp, hp);
  b.emit('tick', { dt: 4.999 }); assert.equal(e.alive, true);
  b.emit('tick', { dt: .001 }); assert.equal(e.alive, false); assert.equal(b.errorCount, 0);
});

test('native fireball triggers on its tile then deals radius-two arts and ATK-based burn after .1 seconds', () => {
  const { b, u } = realBattle(), e = native(b, 'enemy_1177_dufrbl'); e.x = u.x + 1; e.y = u.y;
  b.emit('tick', { dt: 5 }); assert.equal(e.mem.mizukiFlame.cast, null);
  e.x = u.x; const hp = u.hp; b.emit('tick', { dt: 0 }); const attack = e.s.atk;
  assert.equal(attack, 325); assert.ok(e.findBuff('dufrbl_t[stop_weaken]'));
  b.emit('tick', { dt: 1 }); assert.equal(e.s.atk, attack);
  runAt(b, .099); assert.equal(u.hp, hp); runAt(b, .1);
  assert.ok(Math.abs(hp - u.hp - attack * (1 - u.s.res / 100)) < 1e-8);
  assert.equal(u.elem.burn, attack); assert.equal(e.alive, false); assert.equal(b.errorCount, 0);
});

test('native fireball ignores flying, camouflaged and invisible trigger candidates but explosion reaches camouflage', () => {
  const { b, u } = realBattle(), e = native(b, 'enemy_1177_dufrbl'); e.x = u.x; e.y = u.y;
  u.motion = 'FLY'; b.emit('tick', { dt: 0 }); assert.equal(e.mem.mizukiFlame.cast, null); u.motion = 'WALK';
  b.addBuff(u, { key: 'test:camou', flags: { camou: true } }); b.emit('tick', { dt: 0 }); assert.equal(e.mem.mizukiFlame.cast, null);
  b.removeBuff(u, 'test:camou'); b.addBuff(u, { key: 'test:stealth', flags: { stealth: true } });
  b.emit('tick', { dt: 0 }); assert.equal(e.mem.mizukiFlame.cast, null); b.removeBuff(u, 'test:stealth');
  b.emit('tick', { dt: 0 }); b.addBuff(u, { key: 'test:camou', flags: { camou: true } });
  const hp = u.hp; runAt(b, .1); assert.ok(u.hp < hp); assert.equal(b.errorCount, 0);
});

test('fireball obstacle sequence hits one native obstacle and nearby ground allies after its fixed delay', () => {
  const { combat, b, u } = realBattle();
  const tile = combat.snapshot().geometry.tiles.find((v) => b.grid.canStand(v.row, v.col, { ranged: false })
    && !v.obstacle && (v.row !== u.tileR || v.col !== u.tileC));
  const wall = b.spawnDevice('fire-test-crate', tile.row, tile.col, { hp: 10000, obstacle: true });
  const e = native(b, 'enemy_1177_dufrbl'); e.x = wall.x; e.y = wall.y; u.x = wall.x + 1.5; u.y = wall.y;
  const wallHp = wall.hp, hp = u.hp; b.emit('tick', { dt: 0 }); assert.ok(e.mem.mizukiFlame.cast);
  runAt(b, .099); assert.equal(wall.hp, wallHp); runAt(b, .1);
  assert.ok(wall.hp < wallHp); assert.ok(u.hp < hp); assert.equal(u.elem.burn, 500);
  assert.equal(e.alive, false); assert.equal(b.errorCount, 0);
});

test('native event fire snapshot retains live fireball and charge loops and clears them at release or death', () => {
  const { b, u } = realBattle(), e = native(b, 'enemy_1184_cadkgt'); e.x = u.x + 1; e.y = u.y;
  const flame = native(b, 'enemy_1177_dufrbl'); flame.x = u.x + 4; flame.y = u.y;
  b.emit('tick', { dt: 25 });
  // Fireball lifetime has elapsed; a fresh one remains visible to reconnects.
  const next = native(b, 'enemy_1177_dufrbl'); next.x = u.x + 4; next.y = u.y;
  let effects = snapshotMizukiEventFireEffects(b);
  assert.ok(effects.some((v) => v.id === 'dufrbl:' + next.id));
  assert.ok(effects.some((v) => v.id === 'cadkgt:' + e.id + ':range'));
  assert.equal(effects.find((v) => v.id === 'cadkgt:' + e.id + ':range').unitId, null);
  runAt(b, 5.667); effects = snapshotMizukiEventFireEffects(b);
  assert.equal(effects.some((v) => v.id === 'cadkgt:' + e.id + ':range'), false);
  b.kill(next, null); assert.equal(snapshotMizukiEventFireEffects(b).some((v) => v.id === 'dufrbl:' + next.id), false);
  assert.equal(b.errorCount, 0);
});
