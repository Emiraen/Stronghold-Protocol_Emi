// Native dzoms/dzomg prefabs: damage_resistance(PHYSICAL_AND_MAGICAL),
// BlockedToggleChecker -> enemy_bloodsucker_block_cnt[control]. The derived
// BLOCK_CNT ADDITION stacks to max_valid_stack_cnt and ends with its controller.
import { T, elem } from '../../sim/content/enemies.js';
import { summonNativeEnemies } from './NativeEnemySpawn.js';

function syncBlocker(battle, blocker) {
  if (!blocker) return;
  const sources = battle.enemies.filter((e) => e.alive && e.deployed
    && e.blockedBy === blocker && e.mem.mizukiBloodsucker);
  const key = 'enemy_bloodsucker_block_cnt';
  if (!sources.length) { battle.removeBuff(blocker, key); return; }
  const { cap, amount } = sources[0].mem.mizukiBloodsucker;
  battle.addBuff(blocker, { key, persist: true,
    mods: { blockCnt: Math.min(cap, sources.length) * amount }, refresh: 'replace' });
}

function born(battle, enemy, key) {
  const previous = enemy.profile.noAttack; enemy.profile.noAttack = true;
  battle.addBuff(enemy, { key: 'mizuki:bloodsucker:born', duration: 1, flags: { noMove: true } });
  battle.fx('phase', { id: enemy.id, kind: key, dur: 1 });
  battle.after(1, () => { if (enemy.alive) enemy.profile.noAttack = previous; });
}

function syncSupply(battle) {
  const sources = battle.enemies.filter((e) => e.alive && e.deployed && !e.hidden
    && e.mem.mizukiSupply && !e.s.flags.silence);
  for (const e of battle.enemies) {
    if (!e.alive || !e.mem.mizukiBloodsucker) continue;
    const eligible = e.deployed && !e.hidden && !e.s.flags.untargetable && !e.s.flags.sleep && !e.s.flags.invulnerable;
    const stack = eligible ? Math.min(sources.length, sources[0]?.mem.mizukiSupply.cap ?? 0) : 0;
    const key = 'enemy_dsuply_2_t[attr_buff]';
    if (stack) {
      const { atk, dark } = sources[0].mem.mizukiSupply;
      bUpdate(battle, e, key, stack, atk, dark);
    } else battle.removeBuff(e, key);
  }
}
function bUpdate(battle, enemy, key, stack, atk, dark) {
  if (enemy.findBuff(key)?.data?.stack === stack) return;
  battle.addBuff(enemy, { key, persist: true, refresh: 'replace',
    mods: { atkPct: atk * stack }, data: { stack, darkRatio: dark * stack } });
}

function supplyEffect(b, e) {
  const active = e.alive && e.deployed && !e.hidden && !e.s.flags.silence;
  if (!!e.mem.mizukiSupplyEffect === active) return;
  e.mem.mizukiSupplyEffect = active;
  b.fx('mizuki:effect', { id: 'dsuply:' + e.id, key: 'enemy_dsuply_buff_01',
    unitId: e.id, x: e.x, y: e.y, loop: true, active, phase: active ? 'start' : 'stop' });
}

function nativeBloodsucker(ab) {
  return [{
    spawn(b, e, _a, runtime) {
      runtime.atkType = 'phys'; e.profile.melee = true;
      e.mem.mizukiBloodsucker = { cap: T(ab, 'buff_to_blocker.max_valid_stack_cnt'),
        amount: T(ab, 'buff_to_blocker.block_cnt') };
      b.addBuff(e, { key: 'enemy_bloodsucker_mark', persist: true });
      syncSupply(b);
      // A mode-local instance accessor observes every original release path
      // (death/retreat, sleeping, displacement, capacity and transfer) immediately.
      let blocker = e.blockedBy;
      Object.defineProperty(e, 'blockedBy', { configurable: true, enumerable: true,
        get() { return blocker; },
        set(next) { const previous = blocker; blocker = next;
          if (previous !== next) { syncBlocker(b, previous); syncBlocker(b, next); } },
      });
      born(b, e, e.defId === 'enemy_1220_dzoms' ? 'enemy_dzoms_born_01' : 'enemy_dzomg_born_01');
    },
    hitIn(c) {
      if (c.dmg.type === 'phys' || c.dmg.type === 'arts') c.dmg.mul *= 1 - T(ab, 'dmg_res.damage_resistance');
    },
    hitOut(c, b, e) {
      const ratio = e.findBuff('enemy_dsuply_2_t[attr_buff]')?.data?.darkRatio ?? 0;
      // Native ON_CALCULATE_DAMAGE, DARK(4), baseOnHostAtk=false; the
      // separate elemental modifier is based on the source's current ATK.
      if (ratio > 0 && c.target && c.dmg.type !== 'element') elem(b, e, c.target, 'apoptosis', e.s.atk * ratio);
    },
    death(_c, b, e) { syncBlocker(b, e.blockedBy); },
  }];
}

function nativeSupply(ab) {
  return [{
    spawn(b, e, _a, runtime) {
      runtime.atkType = 'phys'; e.profile.melee = false; e.profile.deferHit = true; e.profile.shot = 'none';
      // The original non-extendable/non-scalable CircleRange radius is 2,
      // independently of the enemy DB's unused rangeRadius 1.6.
      e.base.rangeRadius = 2; e.markDirty();
      e.def = { ...e.def, attackAnim: { dur: 1.2, hit: .433 } };
      e.mem.mizukiSupply = { atk: T(ab, 'aura.enemy_dsuply_2_t[attr_buff].atk'),
        cap: T(ab, 'aura.enemy_dsuply_2_t[attr_buff].max_valid_stack_cnt'), dark: T(ab, 'aura.ep_damage_ratio') };
      syncSupply(b); supplyEffect(b, e);
    },
    tick(b, e) { syncSupply(b); supplyEffect(b, e); },
    status(_c, b, e) { syncSupply(b); supplyEffect(b, e); },
    death(_c, b, e) { syncSupply(b); supplyEffect(b, e); },
    attack(c, b, e) {
      const target = c.targets[0]; if (!target) return;
      const attackId = b._attackSeq;
      const p = b.addProjectile({ from: e, target, source: e, speed: 10, maxAge: 5, visual: 'none',
        onHit({ target: direct, x, y }) {
          if (!direct) return;
          b.fx('mizuki:effect', { key: 'enemy_dsuply_attack_hit_01', unitId: direct.id, x, y });
          // Native useCachedAtkOnly=0 and stopWhenSourceInvalid=0.
          b.dealDamage(e, direct, { amount: e.s.atk, type: 'phys', isAttack: true, attackId, isProjectile: true });
        } });
      b.fx('mizuki:effect', { key: 'enemy_dsuply_attack_start_01', unitId: e.id, x: e.x, y: e.y });
      b.fx('mizuki:effect', { id: 'dsuply:projectile:' + p.id, key: 'enemy_dsuply_attack_trail_01',
        x: e.x, y: e.y, to: { x: target.x, y: target.y }, toUnitId: target.id, speed: 10, loop: false });
    },
  }];
}

function nativeVampireInfantry(ab) {
  return [{
    spawn(_b, e, _a, runtime) { runtime.atkType = 'phys'; e.profile.melee = true; },
    death(c, b, e) {
      if (c.reason !== 'killed') return;
      summonNativeEnemies(b, e, ab.tS['deathrattle.enemy_key'], { count: 1,
        delay: T(ab, 'deathrattle.delay'), offsetBound: .1, dontBlockWave: false });
    },
  }];
}

export const MIZUKI_BLOODSUCKER_KITS = {
  enemy_1220_dzoms: nativeBloodsucker,
  enemy_1221_dzomg: nativeBloodsucker,
  enemy_1221_dzomg_2: nativeBloodsucker,
  enemy_1222_dpvt: nativeVampireInfantry,
  enemy_1224_dsuply_2: nativeSupply,
};

export function snapshotNativeSupplyEffects(battle) {
  return battle.enemies.filter((e) => e.alive && e.deployed && !e.hidden && e.mem.mizukiSupplyEffect)
    .map((e) => ({ id: 'dsuply:' + e.id, key: 'enemy_dsuply_buff_01',
      unitId: e.id, x: e.x, y: e.y, active: true, loop: true }));
}
