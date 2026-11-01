// Mizuki-only enemy kits. Numerical blackboards come from the original level;
// mode constants below were read from the installed client's enemy prefabs.
// Evidence: .cache/mizuki-native-rules/boss-evidence.json and enemy-actions.json.
import { T, elem, areaAllies, auraBuff, setForm, castSlot, fieldAllies } from '../../sim/content/enemies/helpers.js';
import { ep, reborn, float, setFloat } from '../../sim/content/enemies/archetypes.js';
import { summonNativeEnemies } from './NativeEnemySpawn.js';

export const MIZUKI_BOSS_NATIVE_RULES = Object.freeze({
  source: 'Arknights Game/enm_pfb_*.ab; buff_template_data enemy_symon_t[heal],enemy_sygirl_fly,enemy_sydonq_t[inverse_freeze]',
  girl: Object.freeze({ firstTargets: 3, secondTargets: 5, recoveryHpRatio: 0.95, fallStun: 0.5 }),
  knight: Object.freeze({ postRebirthInvincibility: 2, secondFormHpRatio: 1, reflectionHpThreshold: 0.5 }),
  pathmaker: Object.freeze({ useRandomDelay: false, summonDelay: 0, summonDelayRange: 0.5, summonOffsetBound: 0.2 }),
  isha: Object.freeze({ healRadius: 20, monsterRadius: 4, targets: 3, fetchDelay: 0.04 }),
  jelly: Object.freeze({ birthDelay: 1, summonCount: 1 }),
  // FROM_ANIMATION: the original enemy_2042_syboss.skel clips, not the
  // serialized but inactive _cooldown=10 fallback on ExtraSummon.
  izumik: Object.freeze({ initialHpRatio: 0.6, devourRadius: 0.5, maxStacks: 4,
    extraCastDuration: 65 / 30, stunCastDuration: 97 / 30, attackRadius: 1.3 }),
});

export const MIZUKI_BOSS_BRANCH_KEYS = Object.freeze(['syboss_jely1', 'syboss_jely2', 'syboss_jely3', 'syboss_jely4', 'syboss_extra']);

const FAKE_DEATH_IDS = new Set(['enemy_2028_syevil', 'enemy_2029_symon', 'enemy_2030_symon2']);
const FAKE_KEY = 'mizuki:boss:fakeDeath';

function clearExternalRebirthBuffs(battle, enemy) {
  for (const buff of enemy.buffs.slice()) {
    if (buff.persist || buff.source?.side === 'enemy') continue;
    if (buff.source || buff.status || buff.key === 'terrain:infection') battle.removeBuff(enemy, buff);
  }
}

function fakeDeathPart(ab, enemy) {
  const isPriest = enemy.defId === 'enemy_2028_syevil';
  return [
    { spawn(_battle, _enemy, _ability, abilityData) { abilityData.atkType = isPriest ? 'arts' : 'phys'; } },
    ...(!isPriest ? [ep('erosion', T(ab, 'EpDamage.attack@ep_damage_ratio') ?? 0)] : []),
    {
      iv: 0,
      spawn(_battle, unit, ability) { unit.mem.mizukiFakeDeath = ability; },
      killed(context, battle, unit, ability) {
        if (ability.final) return false;
        if (ability.fake) { unit.hp = Math.max(1, unit.hp); return true; }
        const partners = battle.enemies.filter((other) => other !== unit && other.alive && FAKE_DEATH_IDS.has(other.defId));
        const fallen = partners.filter((other) => other.mem.mizukiFakeDeath?.fake);
        if (!partners.length || fallen.length === partners.length) {
          ability.final = true;
          for (const other of fallen) { other.mem.mizukiFakeDeath.final = true; battle.kill(other, context.killer); }
          return false;
        }
        clearExternalRebirthBuffs(battle, unit);
        ability.fake = true; ability.noAttack = unit.profile.noAttack;
        ability.nextHeal = battle.time + 1;
        unit.hp = Math.max(1, unit.s.maxHp * (T(ab, 'Reborn.hp_ratio') ?? 0));
        unit.profile.noAttack = true; unit.unbalanceUntil = -Infinity;
        battle.addBuff(unit, { key: FAKE_KEY, persist: true, visible: true,
          flags: { invulnerable: true, untargetable: true, unblockable: true, noMove: true, stun: true } });
        setForm(battle, unit, 'reborn', 'telegraph', { kind: 'fakeDeath' });
        return true;
      },
      tick(battle, unit, ability) {
        if (!ability.fake || ability.final || battle.time + 1e-9 < ability.nextHeal) return;
        const partners = battle.enemies.filter((other) => other !== unit && other.alive && FAKE_DEATH_IDS.has(other.defId) && !other.mem.mizukiFakeDeath?.fake);
        if (!partners.length) { ability.final = true; battle.kill(unit, null); return; }
        while (battle.time + 1e-9 >= ability.nextHeal) {
          ability.nextHeal += 1;
          unit.hp = Math.min(unit.s.maxHp, unit.hp + unit.s.maxHp * (T(ab, 'FakeDeath.hp_ratio') ?? 0));
        }
        if (unit.hp + 1e-6 >= unit.s.maxHp * (T(ab, 'FakeDeath.target_hp_ratio') ?? 1)) {
          ability.fake = false; battle.removeBuff(unit, FAKE_KEY);
          unit.profile.noAttack = ability.noAttack; unit.atkCd = 0;
          if (unit.route) unit.route.pts = null;
          setForm(battle, unit, 'default', 'revive', { kind: 'fakeDeath' });
        }
      },
    },
  ];
}

function girlKit(ab) {
  const native = MIZUKI_BOSS_NATIVE_RULES.girl;
  return [float(), {
    iv: 0,
    spawn(_battle, enemy, ability, abilityData) {
      abilityData.atkType = 'phys'; enemy.profile.maxTargets = native.firstTargets;
      enemy.mem.mizukiGirl = ability; ability.second = false; ability.fallen = false;
    },
    status(context, battle, enemy, ability) {
      if (ability.fallen || !['stun', 'freeze', 'sleep', 'groundbind'].includes(context.status) || enemy.mem.mizukiGirlReborn) return;
      ability.fallen = true; setFloat(battle, enemy, false);
      battle.applyStatus(enemy, 'stun', { duration: native.fallStun, source: null });
      setForm(battle, enemy, ability.second ? 'form2' : 'ground');
    },
    dealt(context, battle, enemy, ability) {
      elem(battle, enemy, context.target, 'erosion', enemy.s.atk * (T(ab, ability.second ? 'Attack2.attack@ep_damage_ratio' : 'Attack.attack@ep_damage_ratio') ?? 0));
    },
    tick(battle, enemy, ability) {
      if (enemy.mem.mizukiGirlReborn) return;
      const slowdown = T(ab, ability.second ? 'SlowDown2.attack_speed' : 'SlowDown.attack_speed') ?? 0;
      for (const target of areaAllies(battle, enemy, enemy.x, enemy.y, enemy.base.rangeRadius)) {
        auraBuff(battle, target, `mizuki:boss:girlSlow:${enemy.id}`, 1 / 30, { aspd: slowdown });
      }
    },
  }, reborn({
    key: 'mizuki:boss:girlRebirth', dur: T(ab, 'Reborn.duration') ?? 0, hpRatio: native.recoveryHpRatio,
    onKo(battle, enemy) {
      enemy.mem.mizukiGirlReborn = true;
      // Mizuki mode keeps the boss grounded from its first defeat onward,
      // including recovery and the entire second form.
      setFloat(battle, enemy, false);
      battle._officialWaves?.finishCurrentWave({ source: enemy });
    },
    onReborn(battle, enemy) {
      enemy.mem.mizukiGirlReborn = false;
      const ability = enemy.mem.mizukiGirl; ability.second = true; ability.fallen = true;
      enemy.profile.maxTargets = native.secondTargets; setFloat(battle, enemy, false);
    },
  })];
}

function knightKit(ab) {
  const native = MIZUKI_BOSS_NATIVE_RULES.knight;
  const finishRecovery = (battle, enemy, ability) => {
    if (ability.phase !== 'recovering') return;
    ability.phase = 'walking'; battle.removeBuff(enemy, 'mizuki:boss:knightRecovery');
    enemy.profile.noAttack = true;
    battle.addBuff(enemy, { key: 'mizuki:boss:knightWalking', persist: true, visible: true,
      flags: { unblockable: true }, mods: { moveMul: 1 + (T(ab, 'Slow.move_speed') ?? 0) } });
    if (enemy.route) enemy.route.pts = null;
    setForm(battle, enemy, 'form2', 'revive', { kind: 'knight' });
  };
  return [{
    iv: 0,
    spawn(_battle, _enemy, _ability, abilityData) { abilityData.atkType = 'phys'; },
    taken(context, battle, enemy, ability) {
      const source = context.source || context.credit;
      if (source?.alive && source.side === 'ally') battle.applyStatus(source, 'cold', { source: enemy,
        duration: T(ab, enemy.hpRatio < native.reflectionHpThreshold ? 'InverseDamage.sydonq_t[freeze2].freeze' : 'InverseDamage.sydonq_t[freeze1].freeze') ?? 0 });
      if (enemy.hpRatio <= (T(ab, 'Reborn.hp_ratio') ?? 0)) finishRecovery(battle, enemy, ability);
    },
    hitOut(context) {
      if (context.dmg.isAttack && context.target?.s.flags.freeze) context.dmg.amount *= T(ab, 'DamageScaleToFrozen.atk_scale') ?? 1;
    },
    killed(_context, battle, enemy, ability) {
      if (ability.phase) return false;
      clearExternalRebirthBuffs(battle, enemy);
      ability.phase = 'recovering'; ability.until = battle.time + (T(ab, 'Reborn.duration') ?? 0);
      enemy.hp = enemy.s.maxHp * native.secondFormHpRatio; enemy.profile.noAttack = true;
      battle.addBuff(enemy, { key: 'mizuki:boss:knightRecovery', persist: true, visible: true, flags: { noMove: true } });
      battle.addBuff(enemy, { key: 'mizuki:boss:knightRebirthInvulnerability', duration: native.postRebirthInvincibility,
        flags: { invulnerable: true }, visible: true });
      battle._officialWaves?.finishCurrentWave({ source: enemy });
      setForm(battle, enemy, 'reborn', 'telegraph', { dur: T(ab, 'Reborn.duration') ?? 0, kind: 'knight' });
      return true;
    },
    tick(battle, enemy, ability) { if (ability.phase === 'recovering' && battle.time + 1e-9 >= ability.until) finishRecovery(battle, enemy, ability); },
  }];
}

function pathmakerKit(ab, parent) {
  const summon = ab.sk.Summon;
  const isFragment = parent.defId === 'enemy_2033_syboys';
  const createFragments = (battle, enemy, fromDamage = false) => {
    const key = (fromDamage && ab.tS['SummonMark.enemy_key']) || summon?.bs.enemy_key;
    const count = (fromDamage && T(ab, 'SummonMark.cnt')) || summon?.bb.cnt || 0;
    const limit = (fromDamage && T(ab, 'SummonMark.limit_amount')) || summon?.bb.limit_amount || 0;
    if (!key || !(count > 0) || battle.enemies.filter((unit) => unit.alive && unit.defId === key).length >= limit) return;
    const native = MIZUKI_BOSS_NATIVE_RULES.pathmaker;
    summonNativeEnemies(battle, enemy, key, { count, countInTotal: false,
      delay: (fromDamage ? T(ab, 'SummonMark.delay') : summon?.bb.delay) ?? native.summonDelay,
      offsetBound: (fromDamage ? T(ab, 'SummonMark.offset_bound') : summon?.bb.offset_bound) ?? native.summonOffsetBound,
      tryOutside: true, stopHostDead: true, dontBlockWave: false,
      useRandomDelay: native.useRandomDelay, randomDelayRange: native.summonDelayRange,
      onSpawn(child) {
        child.mem.mizukiSummonHostId = enemy.id;
        // Native FetchEnemyHpToHost initializes a new fragment to its host's
        // current HP ratio. It does not reflect later damage back to the host.
        const missingHp = child.s.maxHp * (1 - enemy.hpRatio);
        if (missingHp > 0) battle.dealDamage(null, child, { amount: missingHp, type: 'true', canDodge: false,
          tags: ['enemyAbility', 'mizuki:fragmentHpInheritance'] });
      },
    });
  };
  return [{
    spawn(battle, enemy, ability, abilityData) {
      abilityData.atkType = 'phys'; ability.attacks = 0; ability.received = 0;
      if (isFragment) {
        const lifetime = T(ab, 'Suicide.duration') ?? 0;
        if (lifetime > 0) battle.after(lifetime, () => { if (enemy.alive) battle.kill(enemy, null); }, { owner: enemy });
      }
    },
    before(_context, battle, enemy, ability) { if (summon && (ability.attacks + 1) % (summon.sp + 1) === 0) castSlot(battle, enemy, summon); },
    attack(_context, battle, enemy, ability) {
      ability.attacks++;
      if (summon && ability.attacks % (summon.sp + 1) === 0) createFragments(battle, enemy);
    },
    taken(context, battle, enemy, ability) {
      const threshold = T(ab, 'SummonMark.damage_counter');
      if (!(threshold > 0) || !(context.amount > 0) || enemy.hp <= 0) return;
      ability.received++;
      if (ability.received >= threshold) { ability.received = 0; createFragments(battle, enemy, true); }
    },
    death(_context, battle) {
      if (!isFragment) for (const unit of battle.enemies.slice()) if (unit.alive && unit.defId === 'enemy_2033_syboys') battle.kill(unit, null);
    },
  }];
}

function originalTimeSp(enemy) {
  const data = enemy.def.raw.officialData?.spData;
  if (!data || data.spType !== 'INCREASE_WITH_TIME') throw new TypeError('Original boss time SP is missing: ' + enemy.defId);
  return { value: data.initSp, max: data.maxSp, increment: data.increment };
}

function clearIshaTears(battle, enemy) {
  for (const child of battle.enemies.slice()) if (child.alive && child.defId === 'enemy_2040_syrott'
    && child.mem.mizukiSummonHostId === enemy.id) battle.kill(child, enemy);
}

function createIshaTears(battle, enemy, count) {
  const occupied = new Set(battle.allies().map((unit) => unit.tileR + ':' + unit.tileC));
  for (const unit of battle.enemies) if (unit.alive && unit.defId === 'enemy_2040_syrott') occupied.add(Math.round(unit.y) + ':' + Math.round(unit.x));
  const tiles = [];
  for (let row = battle.rect.r0; row <= battle.rect.r1; row++) for (let col = battle.rect.c0; col <= battle.rect.c1; col++) {
    if (!occupied.has(row + ':' + col) && battle.grid.canStand(row, col, { ranged: false }) && battle.grid.groundPassable(row, col)) tiles.push([row, col]);
  }
  for (let index = 0; index < count && tiles.length; index++) {
    const pos = tiles.splice(Math.floor(battle.rng() * tiles.length), 1)[0];
    summonNativeEnemies(battle, enemy, 'enemy_2040_syrott', { pos, route: { start: pos, end: pos, motion: 'WALK', steps: [{ t: 'wait', s: Infinity }] },
      dontBlockWave: true, countInTotal: false, onSpawn(child) { child.mem.mizukiSummonHostId = enemy.id; } });
  }
}

function ishaKit(ab) {
  const native = MIZUKI_BOSS_NATIVE_RULES.isha;
  const transform = (battle, enemy, ability) => {
    if (ability.phase !== 'human') return;
    ability.savedHp = enemy.hp; ability.phase = 'monster';
    clearIshaTears(battle, enemy);
    const prefix = 'FetchAttributes.syskad_t[monster].';
    battle.addBuff(enemy, { key: 'mizuki:boss:ishaMonster', persist: true, visible: true, mods: {
      hpPct: T(ab, prefix + 'max_hp') ?? 0, atkPct: T(ab, prefix + 'atk') ?? 0, defPct: T(ab, prefix + 'def') ?? 0,
      resMul: 1 + (T(ab, prefix + 'magic_resistance') ?? 0), moveMul: 1 + (T(ab, prefix + 'move_speed') ?? 0),
      batPct: T(ab, prefix + 'base_attack_time') ?? 0,
    } });
    enemy.hp = enemy.s.maxHp * (T(ab, prefix + 'hp_ratio') ?? 1);
    enemy.profile.noAttack = false; enemy.profile.dmgType = 'true'; enemy.profile.melee = false;
    enemy.profile.maxTargets = native.targets; enemy.base.rangeRadius = native.monsterRadius; enemy.atkCd = 0;
    castSlot(battle, enemy, ab.sk.change); setForm(battle, enemy, 'monster');
  };
  return [{
    iv: 0,
    spawn(battle, enemy, ability) {
      ability.phase = 'human'; ability.sp = originalTimeSp(enemy);
      ability.corruptAt = battle.time + (ab.sk.Corrupt?.icd ?? 0); enemy.mem.mizukiIsha = ability;
      enemy.profile.noAttack = true; enemy.base.rangeRadius = native.healRadius;
    },
    taken(_context, battle, enemy, ability) {
      if (ability.phase !== 'human' || ability.berserk || enemy.hp <= 0 || enemy.hpRatio >= (T(ab, 'Berserk.hp_ratio') ?? 0)) return;
      ability.berserk = true;
      battle.addBuff(enemy, { key: 'mizuki:boss:ishaBerserk', persist: true, visible: true, mods: { atkPct: T(ab, 'Berserk.atk') ?? 0 } });
      castSlot(battle, enemy, ab.sk.BerserkCorrupt); createIshaTears(battle, enemy, 2);
    },
    killed(_context, battle, enemy, ability) {
      if (ability.phase !== 'monster') return false;
      ability.phase = 'reborn'; ability.sp.value = 0;
      clearExternalRebirthBuffs(battle, enemy); enemy.hp = Math.max(1, enemy.s.maxHp * (T(ab, 'Reborn.hp_ratio') ?? 0));
      enemy.profile.noAttack = true;
      battle.addBuff(enemy, { key: 'mizuki:boss:ishaReborn', persist: true, visible: true,
        flags: { invulnerable: true, untargetable: true, unblockable: true, noMove: true, stun: true } });
      setForm(battle, enemy, 'reborn', 'telegraph', { dur: T(ab, 'Reborn.duration') ?? 0 });
      battle.after(T(ab, 'Reborn.duration') ?? 0, () => {
        if (!enemy.alive) return;
        battle.removeBuff(enemy, 'mizuki:boss:ishaMonster'); enemy.base.rangeRadius = native.healRadius;
        enemy.hp = Math.max(1, enemy.s.maxHp * (T(ab, 'Reborn.hp_ratio') ?? 0));
        setForm(battle, enemy, 'default');
        battle.after(native.fetchDelay, () => {
          if (!enemy.alive) return;
          enemy.hp = Math.min(enemy.s.maxHp, ability.savedHp); ability.phase = 'human';
          ability.corruptAt = battle.time + (ab.sk.Corrupt?.icd ?? 0);
          battle.removeBuff(enemy, 'mizuki:boss:ishaReborn');
        }, { owner: enemy });
      }, { owner: enemy });
      return true;
    },
    death(_context, battle, enemy) { clearIshaTears(battle, enemy); },
    tick(battle, enemy, ability, dt) {
      if (ability.phase !== 'human') return;
      ability.sp.value = Math.min(ability.sp.max, ability.sp.value + ability.sp.increment * dt);
      if (ability.sp.value >= ab.sk.change.sp) { transform(battle, enemy, ability); return; }
      if (battle.time + 1e-9 >= ability.corruptAt) {
        castSlot(battle, enemy, ab.sk.Corrupt); createIshaTears(battle, enemy, 1);
        ability.corruptAt = battle.time + ab.sk.Corrupt.cd;
      }
      if (enemy.atkCd > 0 || enemy.s.flags.disarm || enemy.s.flags.stun || !(enemy.s.atk > 0)) return;
      const targets = battle.enemiesInRadius(enemy.x, enemy.y, native.healRadius)
        .filter((unit) => unit.alive && !unit.s.flags.untargetable && unit.hp < unit.s.maxHp)
        .sort((a, b) => a.hpRatio - b.hpRatio || a.id - b.id).slice(0, native.targets);
      if (!targets.length) return;
      enemy.lastAttackAt = battle.time; enemy.stats.attacks++; enemy.atkCd = enemy.s.interval;
      for (const target of targets) { battle._ev(['atk', enemy.id, target.id, 'orb']); battle.heal(enemy, target, enemy.s.atk); }
    },
  }];
}

function tearKit(ab) {
  return [{
    iv: 0,
    spawn(battle, enemy, ability) {
      enemy.profile.noAttack = true; ability.targets = new Map();
      ability.spAt = battle.time + (T(ab, 'RecoverSp.interval') ?? 0);
      battle.addBuff(enemy, { key: 'mizuki:boss:tearMask', persist: true, flags: { invulnerable: true, untargetable: true, unblockable: true, noMove: true } });
    },
    tick(battle, enemy, ability) {
      const host = battle.units.find((unit) => unit.id === enemy.mem.mizukiSummonHostId);
      if (!host?.alive) { battle.kill(enemy, null); return; }
      const targets = fieldAllies(battle, enemy).filter((unit) => unit.tileR === Math.round(enemy.y) && unit.tileC === Math.round(enemy.x));
      const ids = new Set(targets.map((unit) => unit.id));
      for (const id of ability.targets.keys()) if (!ids.has(id)) ability.targets.delete(id);
      for (const target of targets) {
        const next = ability.targets.get(target.id) ?? battle.time + (T(ab, 'Damage.interval') ?? 0);
        if (battle.time + 1e-9 >= next) {
          // Native DamageViaAttr explicitly reads the contact target's ATK.
          battle.dealDamage(enemy, target, { amount: target.s.atk * (T(ab, 'Damage.atk_scale') ?? 0), type: 'true', canDodge: false, tags: ['enemyAbility'] });
          ability.targets.set(target.id, next + (T(ab, 'Damage.interval') ?? 0));
        } else ability.targets.set(target.id, next);
      }
      if (battle.time + 1e-9 >= ability.spAt) {
        ability.spAt += T(ab, 'RecoverSp.interval') ?? 0;
        if (!targets.length) for (const boss of battle.enemies) if (boss.alive && boss.defId === 'enemy_2039_syskad' && boss.mem.mizukiIsha?.phase === 'human') {
          const sp = boss.mem.mizukiIsha.sp; sp.value = Math.min(sp.max, sp.value + (T(ab, 'RecoverSp.sp') ?? 0));
        }
      }
    },
  }];
}

function jellyKit(ab) {
  return [{
    spawn(battle, enemy) {
      enemy.profile.noAttack = true;
      battle.addBuff(enemy, { key: 'mizuki:boss:jellyBorn', duration: MIZUKI_BOSS_NATIVE_RULES.jelly.birthDelay,
        flags: { invulnerable: true, untargetable: true, unblockable: true, noMove: true } });
    },
    blocked(_context, battle, enemy) {
      if (enemy.mem.mizukiJellyTransformed || enemy.findBuff('mizuki:boss:jellyBorn')) return;
      enemy.mem.mizukiJellyTransformed = true;
      summonNativeEnemies(battle, enemy, ab.tS['Combat.enemy_key'], {
        count: MIZUKI_BOSS_NATIVE_RULES.jelly.summonCount, offsetBound: T(ab, 'Combat.offset_bound') ?? 0,
        dontBlockWave: true, countInTotal: false, stopHostDead: false,
      });
      battle.kill(enemy, enemy);
    },
  }];
}

function izumikKit(ab) {
  const native = MIZUKI_BOSS_NATIVE_RULES.izumik;
  const branch = (battle, key, repeat) => {
    const result = battle._officialWaves?.triggerBranch(key, { random: true, notRepeatInOneLoop: !repeat, blockGameFinish: false });
    if (!result?.ok) throw new Error('Original Izumik branch unavailable: ' + key);
  };
  const stun = (battle, enemy) => {
    const skill = ab.sk.StunAOE; castSlot(battle, enemy, skill);
    enemy.mem.mizukiIzumik.castUntil = battle.time + native.stunCastDuration;
    battle.addBuff(enemy, { key: 'mizuki:boss:izumikCasting', duration: native.stunCastDuration,
      flags: { noMove: true, disarm: true } });
    for (const target of fieldAllies(battle, enemy)) {
      const status = battle.applyStatus(target, 'stun', { duration: skill.bb.duration, source: enemy });
      if (!status || !target.s.flags.stun) continue;
      const deployment = target.deploySeq;
      battle.addBuff(target, { key: 'mizuki:boss:izumikStun:' + enemy.id,
        duration: skill.bb.duration * (1 - battle.resistOf(target)), source: enemy,
        interval: 1, onTick() {
          if (target.deploySeq !== deployment || !target.s.flags.stun) return;
          battle.dealDamage(enemy, target, { amount: enemy.s.atk * skill.bb.atk_scale, type: 'arts', canDodge: false, tags: ['enemyAbility'] });
        } });
    }
  };
  const change = (battle, enemy, ability) => {
    if (ability.phase !== 'feeding') return;
    ability.phase = 'recovering'; ability.busyUntil = battle.time + ab.sk.RecoverAnim.bb.duration;
    delete ability.extraUntil; delete ability.castUntil;
    battle.removeBuff(enemy, 'mizuki:boss:izumikCasting');
    battle._officialWaves?.finishCurrentWave({ source: enemy });
    battle.removeBuff(enemy, 'mizuki:boss:izumikFeeding');
    battle.addBuff(enemy, { key: 'mizuki:boss:izumikRecovery', persist: true, visible: true,
      flags: { invulnerable: true, noMove: true, disarm: true } });
    castSlot(battle, enemy, ab.sk.Change); castSlot(battle, enemy, ab.sk.RecoverAnim);
    enemy.base.rangeRadius = native.attackRadius; enemy.profile.maxTargets = 1;
    setForm(battle, enemy, 'recovering', 'telegraph', { dur: ab.sk.RecoverAnim.bb.duration });
  };
  return [{
    iv: 0,
    spawn(battle, enemy, ability, abilityData) {
      abilityData.atkType = 'phys'; enemy.mem.mizukiIzumik = ability; ability.sp = originalTimeSp(enemy);
      ability.phase = 'feeding'; ability.startedAt = battle.time; ability.devoured = 0; ability.stacks = 0; ability.extraCasts = 0;
      ability.summonStage = 1; ability.summonAt = battle.time + (T(ab, 'Summon.syboss_summon[1].interval') ?? 0);
      ability.rage = new Set(); enemy.hp = enemy.s.maxHp * native.initialHpRatio; enemy.profile.noAttack = true;
      battle.addBuff(enemy, { key: 'mizuki:boss:izumikFeeding', persist: true, visible: true, flags: { invulnerable: true } });
    },
    taken(_context, battle, enemy, ability) {
      if (ability.phase !== 'fighting') return;
      for (let index = 3; index >= 1; index--) {
        if (ability.rage.has(index) || enemy.hpRatio >= (T(ab, `Rage.syboss_t[rage_${index}].hp_ratio`) ?? 0)) continue;
        ability.rage.add(index); stun(battle, enemy);
      }
    },
    dealt(context, battle, enemy, ability) {
      if (ability.phase === 'fighting' && context.target?.alive) battle.dealDamage(enemy, context.target, {
        amount: enemy.s.atk * (T(ab, 'Attack.atk_scale') ?? 1), type: 'arts', canDodge: false, tags: ['enemyAbility', 'mizuki:izumikExtraArts'] });
    },
    tick(battle, enemy, ability, dt) {
      if (ability.phase === 'feeding' && enemy.hpRatio >= ab.sk.SplashAOE.bb.max_hp_ratio) {
        change(battle, enemy, ability); return;
      }
      if (ability.phase === 'recovering') {
        if (battle.time + 1e-9 < ability.busyUntil) return;
        ability.phase = 'fighting'; enemy.profile.noAttack = false; battle.removeBuff(enemy, 'mizuki:boss:izumikRecovery');
        setForm(battle, enemy, 'form2');
      }
      const casting = ability.extraUntil != null || battle.time + 1e-9 < (ability.castUntil ?? -Infinity);
      if (!casting) ability.sp.value = Math.min(ability.sp.max, ability.sp.value + ability.sp.increment * dt);
      if (ability.phase === 'fighting') {
        if (!casting && ability.sp.value >= ab.sk.StunAOE.sp) { ability.sp.value -= ab.sk.StunAOE.sp; stun(battle, enemy); }
        return;
      }
      if (casting && battle.time + 1e-9 >= ability.extraUntil) {
        delete ability.extraUntil; ability.extraCasts++;
        if (ability.extraCasts >= ab.sk.ExtraSummon.bb.skill_stack) { change(battle, enemy, ability); return; }
      }
      const age = battle.time - ability.startedAt;
      const nextStage = [1, 2, 3].find((index) => age < (T(ab, `Summon.syboss_summon[${index}].duration`) ?? 0)) ?? 4;
      if (nextStage !== ability.summonStage) {
        ability.summonStage = nextStage; ability.summonAt = battle.time + (T(ab, `Summon.syboss_summon[${nextStage}].interval`) ?? 0);
      }
      if (battle.time + 1e-9 >= ability.summonAt) {
        branch(battle, ab.tS[`Summon.syboss_summon[${ability.summonStage}].branch_id`], false);
        ability.summonAt += T(ab, `Summon.syboss_summon[${ability.summonStage}].interval`) ?? 0;
      }
      for (const child of battle.enemiesInRadius(enemy.x, enemy.y, native.devourRadius)) {
        if (!child.alive || child.def.raw.officialData?.prefabKey !== 'enemy_2041_syjely' || child.findBuff('mizuki:boss:jellyBorn')) continue;
        battle.kill(child, enemy); ability.devoured++;
        if (ability.devoured < (T(ab, 'Devour.counter_stack') ?? 0)) continue;
        ability.devoured = 0; ability.stacks = Math.min(native.maxStacks, ability.stacks + 1);
        battle.addBuff(enemy, { key: 'mizuki:boss:izumikDevour', persist: true, visible: true,
          mods: { atkPct: ability.stacks * (T(ab, 'Devour.atk') ?? 0) } });
        battle.heal(enemy, enemy, enemy.s.maxHp * (T(ab, 'Devour.hp_ratio') ?? 0), { self: true });
        castSlot(battle, enemy, ab.sk.SplashAOE);
        for (const target of fieldAllies(battle, enemy)) battle.dealDamage(enemy, target, { amount: enemy.s.atk, type: 'arts', canDodge: false, tags: ['enemyAbility'] });
        if (enemy.hpRatio >= ab.sk.SplashAOE.bb.max_hp_ratio) { change(battle, enemy, ability); return; }
      }
      if (!ability.extraUntil && ability.sp.value >= ab.sk.ExtraSummon.sp) {
        ability.sp.value -= ab.sk.ExtraSummon.sp; ability.extraUntil = battle.time + native.extraCastDuration;
        battle.addBuff(enemy, { key: 'mizuki:boss:izumikCasting', duration: native.extraCastDuration,
          flags: { noMove: true, disarm: true } });
        castSlot(battle, enemy, ab.sk.ExtraSummon); branch(battle, ab.sk.ExtraSummon.bs.branch_id, true);
      }
    },
  }];
}

export const MIZUKI_BOSS_KITS = {
  enemy_2028_syevil: fakeDeathPart, enemy_2029_symon: fakeDeathPart, enemy_2030_symon2: fakeDeathPart,
  enemy_2037_sygirl: girlKit, enemy_2038_sydonq: knightKit,
  enemy_2031_syboy: pathmakerKit, enemy_2032_syboy2: pathmakerKit, enemy_2033_syboys: pathmakerKit,
  enemy_2039_syskad: ishaKit, enemy_2040_syrott: tearKit, enemy_2041_syjely: jellyKit, enemy_2042_syboss: izumikKit,
};
for (const suffix of ['boom1', 'boom2', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'l', 'm', 'n', 'o']) {
  MIZUKI_BOSS_KITS['enemy_2041_syjely_' + suffix] = jellyKit;
}
