// Original RO2 b-5 has only three trap_027_stone predefines and no magic
// circuit or gramophone. Those native special selectors genuinely have zero
// targets here. Refuse a different field rather than fake either mechanism.
import { T } from '../../sim/content/enemies.js';

function requireNativeField(b) {
  const level = b._officialWaves?.level; if (!level) return;
  const tiles = level.mapData?.tiles || [], traps = [...(level.predefines?.characterInsts || []), ...(level.predefines?.tokenInsts || [])];
  if (tiles.some((tile) => /magic|circuit|tower/i.test(tile.tileKey))
    || traps.some((p) => /magic|circuit|tower/i.test(p.inst?.characterKey || '')))
    throw new TypeError('RO2 Leithanien adapter requires the original circuit/gramophone-free field');
}

function nativeDrunk(ab) {
  return [{
    spawn(b, e) { requireNativeField(b); e.profile.melee = true; e.def = { ...e.def, attackAnim: { dur: 1.1, hit: .4 } }; },
    attack(c, b, e) {
      // Native enemy_ltmob_t tests BUFF_OWNER's circuit, not TARGET's. The
      // source field has no circuit. Extra NORMAL arts has ignoreForSP=true.
      for (const target of c.targets) if (target.alive) {
        b.fx('mizuki:effect', { key: 'enemy_ltmob_attack_hit_02', unitId: target.id, x: target.x, y: target.y });
        b.dealDamage(e, target, { type: 'arts', amount: e.s.atk * T(ab, 'ExAtk.atk_scale'), isAttack: true, noSp: true });
      }
    },
  }];
}

function nativeArtsProjectile({ duration, hit, lifetime, trail, impact }) {
  return () => [{
    spawn(b, e) {
      requireNativeField(b); e.profile.melee = false; e.profile.deferHit = true; e.profile.shot = 'none';
      e.def = { ...e.def, attackAnim: { dur: duration, hit } };
    },
    attack(c, b, e) {
      const target = c.targets[0]; if (!target) return;
      const p = b.addProjectile({ from: e, source: e, target, speed: 10, maxAge: lifetime, visual: 'none',
        onHit({ target: direct }) {
          if (!direct) return;
          b.dealDamage(e, direct, { type: 'arts', amount: e.s.atk, isAttack: true, isProjectile: true });
          b.fx('mizuki:effect', { key: impact, unitId: direct.id, x: direct.x, y: direct.y });
          // The original ltsmag backward/forward selectors require linked
          // magic circuits; there is no linked target in any source RO2 field.
        } });
      b.fx('mizuki:effect', { id: 'leithanien:' + p.id, key: trail, unitId: e.id, x: e.x, y: e.y,
        to: { x: target.x, y: target.y }, toUnitId: target.id, speed: 10, loop: false });
    },
  }];
}

export const MIZUKI_LEITHANIEN_KITS = {
  enemy_1238_ltmob_2: nativeDrunk,
  enemy_1242_ltsmag_2: nativeArtsProjectile({ duration: 2, hit: .633, lifetime: 5,
    trail: 'enemy_ltsmag_attack_trail_1', impact: 'enemy_ltsmag_attack_hit_01' }),
  // Charge's original selector only accepts tag=tower not bearing the enemy
  // ownership mark. With no tower in b-5 it never becomes ready, as on client.
  enemy_1088_ltsmer_2: nativeArtsProjectile({ duration: 1.833, hit: 1.1, lifetime: 10,
    trail: 'enemy_ltsmer_attack_01_trail', impact: 'enemy_ltsmer_attack_01_hit' }),
};
