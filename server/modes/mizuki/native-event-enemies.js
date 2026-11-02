// Original Bolivar enemies used by RO2 shop raids. Never change shared KITS.
import { T, castSlot, setForm } from '../../sim/content/enemies.js';
import { aggroCmp } from '../../sim/targeting.js';

function nativeLifeguard(ab) {
  const trigger = (b, e, a) => {
    // Original HpRatioToggle: <= max, toggleOnce, silenceable talent. Its
    // produced evade buff is itself not silenceable and expires normally.
    if (a.triggered || e.s.flags.silence || e.hpRatio > T(ab, 'Evade.hp_ratio')) return;
    a.triggered = true;
    b.addBuff(e, { key: 'enemy_durwar_t', duration: T(ab, 'Evade.duration'),
      mods: { dodgePhys: T(ab, 'Evade.prob') }, visible: true });
  };
  return [{
    spawn(b, e, a) { trigger(b, e, a); },
    taken(_c, b, e, a) { trigger(b, e, a); },
    tick(b, e, a) { trigger(b, e, a); },
    status(_c, b, e, a) { trigger(b, e, a); },
  }];
}

function nativeSurfCoach(ab) {
  return [{
    // Native Resist is silenceable and its BlockCountToggle is active at 0.
    // Damage resistance scales the mitigated physical/magical result: mul,
    // rather than modifying the raw attack before DEF/minimum damage.
    hitIn(c, _b, e) {
      if (e.blockedBy || e.s.flags.silence || !['phys', 'arts'].includes(c.dmg.type)) return;
      c.dmg.mul *= Math.max(0, 1 - T(ab, 'Resist.damage_resistance'));
    },
  }];
}

function nativeWaitingKnight(ab) {
  const awake = (b, e, a) => {
    if (a.awake) return; a.awake = true;
    b.removeBuff(e, 'napkgt_wait_awake'); e.profile.noAttack = false;
    setForm(b, e, 'normal');
  };
  const check = (b, e, a) => {
    // The native NightBuff actually uses RootTileBuildableMaskToggleChecker
    // with toggleOnMask=MELEE(1). Night maps rewrite this mask as vision moves;
    // on this original RO2 map use the tile's actual mask, not invented fog.
    const tile = b.grid.tile(Math.round(e.y), Math.round(e.x));
    if (tile.build === 'ALL' || tile.build === 'MELEE') awake(b, e, a);
  };
  return [{
    spawn(b, e, a) {
      e.profile.melee = true; e.profile.noAttack = true;
      e.def = { ...e.def, attackAnim: { dur: 2, hit: 1 } };
      setForm(b, e, 'sleep');
      // Waiting uses DISARMED + UNMOVABLE_PRIVATE, not the sleeping status:
      // allies can still attack the knight during its original 50s timer.
      b.addBuff(e, { key: 'napkgt_wait_awake', duration: T(ab, 'SleepBuff.sleep_duration'),
        flags: { disarm: true, noMove: true }, onExpire: () => awake(b, e, a) });
      check(b, e, a);
    },
    tick(b, e, a) { if (!a.awake) check(b, e, a); },
  }];
}

function nativeMerchant(ab) {
  const skill = ab.sk.Spray;
  if (!skill) throw new TypeError('Missing original Can’t Spray skill');
  const targets = (b, e) => b.enemies.filter((u) => u !== e && u.alive && u.deployed && !u.hidden
    && !u._officialFacility && !u.s.flags.untargetable && !u.s.flags.sleep).sort(aggroCmp);
  return [{
    spawn(b, e, a) {
      const source = e.def.raw.officialData?.spData;
      if (!source || source.spType !== 'INCREASE_WITH_TIME') throw new TypeError('Missing original merchant SP');
      a.sp = { value: source.initSp, max: source.maxSp, increment: source.increment };
      a.left = skill.icd; e.profile.noAttack = true; e.mem.mizukiMerchant = a;
      // Raw syshop_invincible flags are INVINCIBLE and BLOCK_FREE.
      b.addBuff(e, { key: 'syshop_invincible', persist: true, flags: { invulnerable: true, unblockable: true } });
      b.on('hpDamage', (event) => {
        if (event.target.findBuff('syshop_s[atk]')?.source !== e) return;
        event.amount = Math.max(0, Math.min(event.amount, event.target.hp - 1));
      }, { priority: 10000 });
    },
    tick(b, e, a, dt) {
      a.left -= dt;
      a.sp.value = Math.min(a.sp.max, a.sp.value + a.sp.increment * dt);
      if (a.left > 1e-9 || a.sp.value + 1e-9 < skill.sp || !e.canAct || e.s.flags.silence) return;
      a.sp.value -= skill.sp; a.left = skill.cd;
      // Native AbilityRandomGroup: selectMethod Random, two equal subabilities.
      const mode = b.rng.int(2); a.lastMode = mode; a.casts = (a.casts || 0) + 1; castSlot(b, e, skill);
      b.fx('mizuki:effect', { key: 'enemy_syshop_skill_start', unitId: e.id, x: e.x, y: e.y });
      const list = targets(b, e);
      if (mode === 0) for (const target of list) {
        const duration = skill.bb['syshop_s[sleep].duration'];
        // The original template removes the entire sleep/heal buff when the
        // target is sleep-immune. Healing is 4% of the healed target per second.
        if (!b.applyStatus(target, 'sleep', { duration, source: e })) continue;
        b.addBuff(target, { key: 'syshop_s[sleep]', source: e, duration, interval: 1,
          onTick: () => b.heal(e, target, target.s.maxHp * skill.bb['syshop_s[sleep].hp_ratio']) });
        b.fx('mizuki:effect', { key: 'enemy_syshop_skill_buff_01', unitId: target.id, x: target.x, y: target.y, duration });
      }
      else for (const target of list.slice(0, 2)) {
        const duration = skill.bb['syshop_s[atk].duration'];
        b.addBuff(target, { key: 'syshop_s[atk]', source: e, duration,
          mods: { atkPct: skill.bb['syshop_s[atk].atk'], aspd: skill.bb['syshop_s[atk].attack_speed'] } });
        b.fx('mizuki:effect', { key: 'enemy_syshop_skill_buff_02', unitId: target.id, x: target.x, y: target.y, duration });
      }
    },
  }];
}

export const MIZUKI_EVENT_KITS = {
  enemy_1259_durwar: nativeLifeguard,
  enemy_1259_durwar_2: nativeLifeguard,
  enemy_1262_durplc: nativeSurfCoach,
  enemy_2036_syshop: nativeMerchant,
  enemy_1181_napkgt_2: nativeWaitingKnight,
};
