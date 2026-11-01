// RO2-only enemy abilities. Sources: original enemy database and the local
// enm_pfb_* / buff_template_holder bundles; never installed in the shared KITS.
import { T, spawnChildren, stayRoute } from '../../sim/content/enemies.js';
import { ep } from '../../sim/content/enemies/archetypes.js';
import { applyHpLoss, makeDamageInfo } from '../../sim/damage.js';

export const MIZUKI_SEA_KITS = {
  enemy_2035_sybox: () => [{
    spawn(b, e, a, ab) {
      // enm_pfb_19: BornState waits _delayToBorn=1.27 before entering
      // the ordinary movement/attack FSM. No invented invincibility.
      ab.atkType = 'phys'; e.profile.melee = true;
      ab.immune = new Set([...(ab.immune ?? []), 'stun', 'freeze', 'silence']);
      a.noAttack = e.profile.noAttack; e.profile.noAttack = true;
      b.addBuff(e, { key: 'mizuki:sybox:born', duration: 1.27, flags: { noMove: true } });
      b.fx('phase', { id: e.id, kind: 'enemy_sybox_start', dur: 1.27 });
      b.after(1.27, () => {
        b.removeBuff(e, 'mizuki:sybox:born');
        e.profile.noAttack = a.noAttack;
      }, { owner: e });
    },
    death(c, b, e) {
      // enemy_sybox_t[logkilled] DEATH event logs the original trap key.
      // Leaks/withdrawals must not count; numOfExtraDrops is reward data.
      if (c.reason !== 'killed') return;
      b.emit('mizuki:extraBattleInfo', { key: 'trap_068_badbox', additionValue: 1, source: e });
      b.fx('phase', { id: e.id, x: e.x, y: e.y, kind: 'enemy_sybox_die' });
    },
  }],
  enemy_2022_syzeni: () => [{
    attack(_c, b, e, a, ab) {
      if (a.triggered) return;
      a.triggered = true;
      // enemy_syzeni_def event 26 then FinishBuff: once in its lifetime.
      b.addBuff(e, { key: 'mizuki:syzeni:stationary', duration: T(ab, 'Attack.duration'),
        flags: { noMove: true }, mods: { defFlat: T(ab, 'Attack.def') }, visible: true });
    },
  }],
  enemy_2023_sypult: () => [{
    spawn(b, e) {
      // The prefab's Ground + LOW selector excludes high-ground operators.
      e.profile.canTarget = (u) => !u.isFlying && b.grid.tile(u.tileR, u.tileC)?.height === 'LOW';
    },
    hitOut(c, b, e, _a, ab) {
      if (!c.dmg.isAttack || !c.target?.alive) return;
      const target = c.target;
      const key = ab.tS['Attack.enemy_key'];
      if (!key) return;
      // The non-missable active buff is carried by the original projectile.
      // Its child is unharmful to the scheduled count and waits 9999 seconds.
      spawnChildren(b, e, key, 1, { pos: [target.y, target.x],
        route: stayRoute(target, 9999), countInTotal: false, tag: 'mizuki:sypult' });
    },
  }],
  enemy_2024_synut: (ab) => [ep('erosion', T(ab, 'EpDamage.attack@ep_damage_ratio') ?? 0), {
    iv: 1,
    // The prefab uses NoSourceDamage(PURE, damageWithoutModify, ignoreForSp).
    // applyHpLoss is the existing final damage primitive; this deliberately
    // carries no hpLoss tag because the native operation is a damage event.
    tick(b, e) {
      const amount = T(ab, 'EpDamage.damage');
      if (amount > 0) applyHpLoss(b, null, e, amount, makeDamageInfo({ amount, type: 'true',
        sourceless: true, noSp: true, canDodge: false, tags: ['dot', 'periodic', 'mizuki:synut'] }));
    },
  }],
};
