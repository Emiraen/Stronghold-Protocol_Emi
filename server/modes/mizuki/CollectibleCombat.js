// Native RO2 collectible blackboards, scoped to a single battle. Resource and
// route rewards remain in Match/RouteEvents; ending relics have their own layer.
import { readFileSync } from 'node:fs';
import { ROWS, COLS } from '../../sim/constants.js';
import { RESIST_STATUSES } from '../../sim/buffs.js';
import { bodyInRange } from '../../sim/body.js';
import { holdProtect } from '../../sim/content/kits/shared/tier1.js';
import { mizukiCollectibleSpec } from './Collectibles.js';

const TOPIC = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic;
const INSTALLED = new WeakMap();
const ENDING_RELICS = new Set([83, 84, 86, 88, 89, 90].map(n => 'rogue_2_relic_grace_' + n));
const ADJACENT = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const AROUND = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]];
const board = buff => Object.fromEntries((buff.blackboard || []).map(entry =>
  [entry.key.trim(), typeof entry.valueStr === 'string' ? entry.valueStr.trim() : entry.value]));
const list = value => String(value || '').toLowerCase().split(/[|,]/).filter(Boolean);
const profession = unit => unit.kind === 'token' ? 'token' : String(unit.def?.profession || '').toLowerCase();
const subProfession = unit => String(unit.def?.subProf || unit.def?.subProfessionId || unit.def?.raw?.subProfessionId || '').toLowerCase();
const identity = unit => unit.def?.charId || unit.def?.raw?.charId || unit.defId;
const buildable = unit => String(unit.mem?.mizukiOriginalBuildable || unit.def?.position || '').toLowerCase();
const alive = unit => unit.alive && unit.deployed && !unit.hidden && !unit.removed;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const hasTag = (unit, tag) => unit?.tags?.has(tag) || [unit?.def?.tags, unit?.def?.raw?.tags,
  unit?.def?.raw?.officialData?.tags, unit?.def?.raw?.officialData?.attributes?.tags]
  .some(tags => Array.isArray(tags) && tags.some(value => String(value).toLowerCase() === tag));

function matches(unit, values, side = 'ally') {
  if (!unit || unit.side !== (values['selector.side'] || side)) return false;
  if (values['selector.profession'] && !list(values['selector.profession']).includes(profession(unit))) return false;
  if (values['selector.sub_profession'] && !list(values['selector.sub_profession']).includes(subProfession(unit))) return false;
  if (values['selector.buildable'] && !list(values['selector.buildable']).includes(buildable(unit))) return false;
  if ((values['selector.char'] || values.selector) && !list(values['selector.char'] || values.selector).includes(identity(unit))) return false;
  if (values['selector.enemy'] && !list(values['selector.enemy']).includes(unit.defId)) return false;
  return true;
}

const ADD = { atk: 'atkFlat', def: 'defFlat', max_hp: 'hpFlat', magic_resistance: 'resFlat',
  attack_speed: 'aspd', block_cnt: 'blockCnt', hp_recovery_per_sec: 'hpRegen',
  hp_recovery_per_sec_by_max_hp_ratio: 'hpRegenRatio', mass_level: 'massFlat', sp_recovery_per_sec: 'spRecoveryFlat' };
const MULTIPLIER = { atk: 'atkMul', def: 'defMul', max_hp: 'hpMul', magic_resistance: 'resMul',
  move_speed: 'moveMul', respawn_time: 'redeployMul' };
function attributes(values, scale = 1, multiply = false) {
  const mods = {};
  for (const [source, target] of Object.entries(multiply ? MULTIPLIER : ADD)) {
    if (Number.isFinite(values[source])) mods[target] = multiply ? Math.max(0, 1 + values[source] * scale) : values[source] * scale;
  }
  return mods;
}

export function installMizukiCollectibleCombat(battle, { collectibles = [], light = 100, players = {}, layers = {} } = {}) {
  if (INSTALLED.has(battle)) return INSTALLED.get(battle);
  const effects = collectibles.filter(id => !ENDING_RELICS.has(id)).flatMap((id, copy) =>
    (mizukiCollectibleSpec(id)?.buffs || []).map((raw, i) => ({ id, type: raw.key, values: board(raw), key: `mizuki:relic:${id}:${copy}:${i}` })));
  const abilities = effects.filter(effect => typeof effect.values.key === 'string');
  const owned = new Set(collectibles), layerGains = {};
  const states = new WeakMap(), initialized = new WeakSet();
  const randomTargets = new Map(), randomTiles = new Map();
  const squad = battle.allyUnits.filter(unit => unit.kind === 'op');
  const kingdomCount = abilities.filter(effect => effect.values.key === 'rogue_2_relic_mark[king_suit]').length;
  const state = unit => {
    if (!states.has(unit)) states.set(unit, { stacks: {}, timers: {}, lastDamage: {}, skillEndAt: battle.time });
    return states.get(unit);
  };
  const resource = unit => players[unit.ownerId] || {};
  const oneLife = unit => resource(unit).life === 1;
  const keyOf = unit => unit.tileR * COLS + unit.tileC;
  const buff = (unit, key, mods, options = {}) => battle.addBuff(unit,
    { key, mods, duration: Infinity, allowDead: true, persist: true, ...options });
  const extraDamage = (source, target, amount, type = 'arts') => battle.dealDamage(source, target,
    { amount, type, canDodge: false, tags: ['mizukiCollectible', 'noAttackTrigger'] });
  const inRange = (source, target) => bodyInRange(target, source.rangeKeySet || source.rangeKeys || []);
  const scaleOf = (effect, unit) => {
    const values = effect.values;
    if (values.stack_by_res === 'rogue_2_gold') return Math.floor(Math.max(0, resource(unit).gold || 0) / Math.max(1, values.stack_by_res_cnt));
    const relicLayer = effects.find(other => other.id === effect.id && other.type === 'layer_relic_owned');
    if (relicLayer) return Math.min(relicLayer.values.max || 999,
      collectibles.filter(id => list(relicLayer.values.sub_type).includes(String(TOPIC.items[id]?.subType || 'NONE').toLowerCase())).length)
      * (relicLayer.values.scale ?? 1);
    if (effect.id === 'rogue_2_relic_fight_158') return Math.min(99, 1 + Math.max(0, layers[effect.id] || 0));
    if (effect.id === 'rogue_2_relic_fight_131') return Math.min(99, Math.max(0, layers[effect.id] || 0) + (layerGains[effect.id] || 0));
    return 1;
  };

  for (const effect of effects) {
    if (['char_random_target_attribute', 'layer_char_random_target_attribute'].includes(effect.type)) {
      randomTargets.set(effect.key, new Set(battle.rng.shuffle(squad.filter(unit => matches(unit, effect.values))).slice(0, effect.values.cnt || 1)));
    }
    if (['rogue_2_attribute_up[random_tile]', 'rogue_2_attribute_up_2[random_tile]'].includes(effect.values.key)) {
      const tiles = [];
      for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++)
        if (battle.grid.inRect(row, col) && battle.grid.canStand(row, col, { ranged: true }) && !battle.grid.obstacle[row * COLS + col]) tiles.push(row * COLS + col);
      randomTiles.set(effect.key, battle.rng.pick(tiles));
    }
  }

  const apply = unit => {
    if (!unit || initialized.has(unit)) return;
    initialized.add(unit);
    unit.mem.mizukiOriginalBuildable = unit.def.position;
    const sums = {}, muls = {};
    let costAdd = 0, costScale = 1, respawnAdd = 0, skillScale = 1;
    for (const effect of effects) {
      const values = effect.values;
      const enemyAttribute = effect.type === 'enemy_attribute_add';
      if (!matches(unit, values, enemyAttribute ? 'enemy' : 'ally')) continue;
      if (['char_attribute_add', 'char_attribute_mul', 'char_squad_attribute_add', 'char_squad_attribute_mul',
        'char_squad_attribute_mul_ex', 'layer_char_attribute_add', 'layer_char_attribute_mul', 'enemy_attribute_add'].includes(effect.type)) {
        let scale = effect.type.startsWith('layer_') ? scaleOf(effect, unit) : 1;
        if (effect.type.startsWith('char_squad_')) scale = effect.type.endsWith('_ex')
          ? new Set(squad.map(profession)).size : squad.filter(candidate => matches(candidate, values)).length;
        const multiply = effect.type.includes('_mul');
        for (const [source, target] of Object.entries(multiply ? MULTIPLIER : ADD)) if (Number.isFinite(values[source])) {
          const table = multiply ? muls : sums;
          table[target] = (table[target] || 0) + values[source] * scale;
        }
        if (Number.isFinite(values.cost)) {
          if (multiply) costScale += values.cost * scale; else costAdd += values.cost * scale;
        }
        if (!multiply && Number.isFinite(values.respawn_time)) respawnAdd += values.respawn_time * scale;
        if (values.base_force_level) unit.mem.mizukiRelicForce = (unit.mem.mizukiRelicForce || 0) + values.base_force_level;
      }
      if (effect.type === 'char_skill_cost_mul') skillScale *= values.scale;
      if (effect.type === 'deck_card_buff') {
        if (values.buildable_type === 3) unit.mem.mizukiBuildableAll = true;
        if (values.dont_occupy_deploy_cnt) unit.mem.mizukiNoDeploySlot = true;
      }
      if (randomTargets.get(effect.key)?.has(unit)) {
        const scale = effect.type.startsWith('layer_') ? scaleOf(effect, unit) : 1;
        for (const [source, target] of Object.entries(MULTIPLIER)) if (Number.isFinite(values['multiplier@' + source]))
          muls[target] = (muls[target] || 0) + values['multiplier@' + source] * scale;
      }
    }
    if (unit.side === 'ally') {
      unit.base.cost = Math.max(0, (unit.base.cost + costAdd) * Math.max(0, costScale));
      unit.base.respawnTime = Math.max(0, unit.base.respawnTime + respawnAdd);
      if (unit.skill && skillScale !== 1) {
        unit.skill.spCostMul *= skillScale;
      }
    }
    for (const [key, value] of Object.entries(muls)) sums[key] = Math.max(0, 1 + value);
    if (Object.keys(sums).length) buff(unit, 'mizuki:relic:attributes', sums);
    for (const effect of abilities) {
      const values = effect.values, key = values.key;
      if (key.startsWith('enemy_') && matches(unit, values, 'enemy')) {
        let mods = null;
        if (key === 'enemy_atk_down') mods = { atkMul: Math.max(0, 1 + values.atk) };
        if (key === 'enemy_def_down') mods = { defMul: Math.max(0, 1 + values.def) };
        if (key === 'enemy_max_hp_down') mods = { hpMul: effect.id === 'rogue_2_relic_curse_2' ? values.max_hp : Math.max(0, 1 + values.max_hp) };
        if (key === 'enemy_attack_speed_down') mods = { aspd: values.attack_speed };
        if (key === 'enemy_move_speed_down') mods = { moveMul: Math.max(0, 1 + values.move_speed) };
        if (key.startsWith('enemy_damage_scale[')) {
          const damageType = { phy: 'physTakenMul', mag: 'artsTakenMul', pure: 'trueTakenMul' }[key.slice(19, -1)];
          if (damageType) {
            const combined = 1 + abilities.filter(other => other.values.key === key && matches(unit, other.values, 'enemy'))
              .reduce((sum, other) => sum + other.values.damage_scale - 1, 0);
            buff(unit, 'mizuki:relic:' + key, { [damageType]: combined });
          }
        }
        if (mods) buff(unit, effect.key, mods);
      }
      if (!matches(unit, values)) continue;
      const mods = {};
      if (key === 'heal_scale') mods.healingTakenMul = values.heal_scale;
      if (key === 'evade[physical]' || key === 'evade[non_pure]') mods.dodgePhys = values.prob;
      if (key === 'evade[magical]' || key === 'evade[non_pure]') mods.dodgeArts = values.prob;
      if (key === 'damage_scale[caster]' && profession(unit) === 'caster') mods.artsDealtMul = values.damage_scale;
      if (key === 'modify_sp_recover[normal]' || key === `modify_sp_recover[${profession(unit)}]`) mods.spRecoveryFlat = values.sp_recovery_per_sec;
      if (key === 'element_resistance') mods.elemTakenMul = 1 - values.ep_damage_resistance;
      if (key === 'ensure_block[tank]' && profession(unit) === 'tank' || key === 'ensure_block[all]') unit.mem.blockCntFloor = Math.max(1, unit.mem.blockCntFloor || 0);
      if (key === 'rogue_2_occupy_zero[token]' && unit.kind === 'token') unit.mem.mizukiNoDeploySlot = true;
      if (Object.keys(mods).length) buff(unit, effect.key, mods);
      if (key === 'rogue_2_camouflage') buff(unit, effect.key, {}, { flags: { camou: true } });
    }
    unit.markDirty(); void unit.s;
  };
  battle.allyUnits.forEach(apply); battle.enemies.forEach(apply);
  // The original shuffled costs are a permutation of this player's actual
  // deployment deck, after all fixed card-cost modifiers have been applied.
  if (effects.some(effect => effect.type === 'misc_shuffle_deck_cost')) for (const player of battle.players) {
    const cards = squad.filter(unit => unit.ownerId === player.playerId);
    const costs = battle.rng.shuffle(cards.map(unit => unit.base.cost));
    cards.forEach((unit, i) => { unit.base.cost = costs[i]; });
  }

  battle.on('battleStart', () => {
    const dp = effects.filter(effect => effect.type === 'level_init_cost_add').reduce((sum, effect) => sum + effect.values.value, 0);
    if (dp) for (const player of battle.players) battle.addDp(player.playerId, dp);
  });
  battle.on('deploy', ({ unit, move }) => {
    apply(unit);
    if (move || unit?.side !== 'ally') return;
    states.set(unit, { stacks: {}, timers: {}, lastDamage: {}, skillEndAt: battle.time });
    // SkillRuntime.reset has already established initial SP. Apply native card
    // gifts/penalties before a kit can cast a deploy-triggered skill.
    for (const effect of abilities) if (matches(unit, effect.values)
      && (effect.values.key === 'modify_sp[born]' || effect.values.key === 'modify_sp[pioneer]' && profession(unit) === 'pioneer')) {
      if (unit.skill) unit.skill.setSpTotal(unit.skill.spTotal + effect.values.sp);
    }
  }, { priority: 19000 });
  battle.on('enemySpawn', ({ enemy }) => apply(enemy), { priority: 19000 });
  battle.on('deploy', ({ unit, move }) => {
    if (move || unit?.side !== 'ally') return;
    for (const effect of abilities) {
      const values = effect.values, key = values.key;
      if (!matches(unit, values)) continue;
      if (key === 'damage_block_once' || key === 'damage_block[stack]') buff(unit, effect.key + ':shield', {},
        { persist: false, shieldHits: 1 });
      if (key === 'rogue_2_attr_up[limited]' || key === 'rogue_2_attr_up[limited][effect]')
        buff(unit, effect.key + ':limited', { atkPct: values.atk || 0, defPct: values.def || 0,
          blockCnt: values.block_cnt || 0, aspd: values.attack_speed || 0 }, { persist: false, duration: values.duration });
      if (key === 'rogue_1_random_damage_on_born') {
        const center = battle.rng.pick(battle.enemies.filter(alive));
        if (center) for (const enemy of battle.enemies.filter(alive))
          if (Math.hypot(enemy.x - center.x, enemy.y - center.y) <= values.range_radius) extraDamage(unit, enemy, values.damage);
      }
    }
  }, { priority: -12000 });

  battle.on('hit', ({ source, target, dmg }) => {
    for (const effect of abilities) {
      const values = effect.values;
      if (values.key === 'damage_resistance[filter_tag]' && source?.side === 'enemy' && matches(target, values) && hasTag(source, values.tag)) dmg.mul *= 1 - values.damage_resistance;
      if (values.key === 'rogue_1_damage_scale_by_distance' && source?.side === 'ally' && target.side === 'enemy' && matches(source, values)) {
        const distance = Math.hypot(source.x - target.x, source.y - target.y);
        dmg.mul *= 1 + values.damage_scale * clamp((distance - values.min_dist) / (values.max_dist - values.min_dist), 0, 1);
      }
    }
  });
  battle.on('attack', ({ attacker }) => {
    if (attacker?.side !== 'ally') return;
    for (const effect of abilities) {
      const values = effect.values, key = values.key;
      if (!matches(attacker, values)) continue;
      if (key === 'modify_sp[warrior]' && profession(attacker) === 'warrior') attacker.skill?.gainSp(values.sp, 'relic');
    }
  });
  battle.on('damaged', ({ source, target, amount, dmg }) => {
    if (!(amount > 0) || dmg?.tags?.includes('hpLoss')) return;
    for (const effect of abilities) {
      const values = effect.values, key = values.key;
      if (target.side === 'ally' && matches(target, values)) {
        const element = dmg?.type === 'element';
        if (!element && (key === 'modify_sp[tank]' && profession(target) === 'tank' || key === 'modify_sp[take_damage]')
          || element && key === 'modify_sp[take_ep_damage]') target.skill?.gainSp(values.sp, 'relic');
      }
      if (source?.side !== 'ally' || target.side !== 'enemy' || !matches(source, values) || dmg?.tags?.includes('mizukiCollectible')) continue;
      if (key === 'hit_to_add_sp' || key === 'rogue_2_hit_to_add_sp[tag]' && hasTag(target, values.tag)) source.skill?.gainSp(values.sp, 'relic');
      // Attack riders resolve on impact, after the attack's ordinary damage.
      // Projectiles in flight and attacks that miss never trigger them early.
      if (dmg?.isAttack && target.hp > 0 && alive(target)) {
        if (key === 'rogue_2_extra_damage[pure]' && target.hp / target.s.maxHp < values.hp_ratio)
          extraDamage(source, target, values.damage, 'true');
        if (key === 'extra_damage_via_cur_hp_ratio[magic]') extraDamage(source, target, target.hp * values.hp_ratio);
      }
      if (key === 'rogue_2_atk_up_on_output_damage[stack]') {
        const mem = state(source); mem.stacks[effect.key] = Math.min(values.max_stack_cnt, (mem.stacks[effect.key] || 0) + 1);
        mem.lastDamage[effect.key] = battle.time;
        buff(source, effect.key + ':stack', { atkPct: mem.stacks[effect.key] * values.atk }, { persist: false, duration: values.duration });
      }
    }
  });
  battle.on('skillStart', ({ unit }) => {
    for (const effect of abilities) {
      if (!matches(unit, effect.values)) continue;
      if (effect.values.key === 'atk_up_on_skill_start')
        buff(unit, effect.key + ':skill', { atkPct: effect.values.atk }, { persist: false, duration: effect.values.duration });
      if (effect.values.key === 'rogue_1_attack_up_after_skill') battle.removeBuff(unit, effect.key + ':dynamic');
      if (effect.values.key === 'rogue_2_sp_recovery_up[stack]') {
        const mem = state(unit);
        mem.stacks[effect.key] = Math.min(effect.values.max_stack_cnt, (mem.stacks[effect.key] || 0) + 1);
        buff(unit, effect.key + ':sp', { spRecoveryFlat: mem.stacks[effect.key] * effect.values.sp_recovery_per_sec }, { persist: false });
      }
    }
  });
  battle.on('skillEnd', ({ unit }) => {
    if (unit?.side !== 'ally') return;
    const mem = state(unit); mem.skillEndAt = battle.time;
    for (const effect of abilities) if (effect.values.key === 'rogue_1_attack_up_after_skill' && matches(unit, effect.values))
      battle.removeBuff(unit, effect.key + ':dynamic');
  });
  battle.on('dodge', ({ target }) => {
    for (const effect of abilities) if (['rogue_2_attr_up[evade]', 'rogue_2_attr_up_2[evade]'].includes(effect.values.key) && matches(target, effect.values))
      buff(target, effect.key + ':evade', { atkPct: effect.values.atk }, { persist: false, duration: effect.values.duration });
  });
  battle.on('beforeStatus', context => {
    if (!RESIST_STATUSES.has(context.status)) return;
    if (context.target.side === 'enemy') for (const effect of effects)
      if (effect.type === 'enemy_attribute_add' && matches(context.target, effect.values, 'enemy') && effect.values.one_minus_status_resistance)
        context.duration *= 1 + effect.values.one_minus_status_resistance;
  });
  battle.on('heal', ({ source, target, amount, opts }) => {
    if (opts.regen || !(amount > 0) || target.side !== 'ally') return;
    const overflow = Math.max(0, amount - (target.s.maxHp - target.hp));
    if (!overflow) return;
    for (const effect of abilities) if (effect.values.key === 'rogue_1_damage_via_es')
      for (const enemy of battle.unitsInGrid(target, AROUND, { side: 'enemy' })) extraDamage(source || target, enemy, overflow * effect.values.atk_scale);
  }, { priority: -30000 });
  battle.on('death', ({ unit, killer, reason, dying }) => {
    if (!(dying || reason === 'killed')) return;
    for (const effect of abilities) {
      const values = effect.values, key = values.key;
      if (unit.side === 'enemy' && killer?.side === 'ally' && matches(killer, values)) {
        if (key === 'kill_target_to_add_cost') battle.addDp(killer.ownerId, values.cost);
        if (key === 'rogue_2_relic_fight_131') layerGains[effect.id] = Math.min(99, (layerGains[effect.id] || 0) + 1);
      }
      if (key === 'rogue_2_projectile_on_killed[stun]' && matches(unit, values))
        for (const enemy of battle.unitsInGrid(unit, ADJACENT, { side: 'enemy' })) battle.applyStatus(enemy, 'stun', { duration: values.stun, source: unit });
    }
  });
  battle.on('enemyLeak', () => {
    for (const effect of abilities) for (const enemy of battle.enemies.filter(alive)) {
      if (effect.values.key === 'stun_on_reach_exit') battle.applyStatus(enemy, 'stun', { duration: effect.values.stun });
      if (effect.values.key === 'damage_on_reach_exit') extraDamage(null, enemy, effect.values.damage, 'true');
    }
  });

  // Auras and HP/life-dependent attributes follow the current battlefield,
  // including newly created summons, rather than a precomputed roster image.
  battle.on('tick', ({ dt }) => {
    const allies = battle.allyUnits.filter(alive), enemies = battle.enemies.filter(alive);
    for (const effect of abilities) {
      const values = effect.values, key = values.key;
      if (key === 'rogue_2_atk_up_in_range' || key === 'defdown[support]' || key === 'statusresistance[medic]' || key === 'rogue_2_relic_fight_155') {
        const emitters = allies.filter(unit => matches(unit, values));
        const targets = key === 'defdown[support]' || key === 'rogue_2_relic_fight_155' ? enemies : allies;
        for (const target of targets) {
          const count = emitters.filter(source => key === 'rogue_2_relic_fight_155' || inRange(source, target) && battle.allySelectable(target, source)).length;
          if (key === 'statusresistance[medic]') {
            if (count) battle.applyStatus(target, 'resist', { value: Math.abs(values.one_minus_status_resistance), duration: dt * 2 + 0.05 });
          } else {
            const mods = key === 'rogue_2_atk_up_in_range' ? { atkPct: count ? values.atk : 0 }
              : key === 'defdown[support]' ? { defMul: count ? 1 + values.def : 1, resMul: count ? 1 + values.magic_resistance : 1 }
                : { resFlat: count * values.magic_resistance };
            buff(target, effect.key + ':aura', mods, { persist: false, duration: dt * 2 + 0.05 });
          }
        }
      }
      for (const unit of allies) {
        if (!matches(unit, values)) continue;
        const mem = state(unit), mods = {};
        const interval = Math.max(0.01, values.interval || 1);
        mem.timers[effect.key] = (mem.timers[effect.key] || 0) + dt;
        const pulse = mem.timers[effect.key] >= interval - 1e-9;
        if (pulse) mem.timers[effect.key] %= interval;
        if (key === 'PeriodicDamageViaDefToBlockees[Magic]' && pulse) for (const enemy of unit.blocking || [])
          if (alive(enemy)) extraDamage(unit, enemy, unit.s.def * values.atk_scale);
        if (key === 'rogue_2_damage_in_attack_range' && pulse) for (const enemy of enemies)
          if (inRange(unit, enemy)) extraDamage(unit, enemy, unit.s.atk * values.atk_scale);
        if (key === 'rogue_2_attack_speed_up[no_ally_in_range]') mods.aspd = battle.unitsInGrid(unit, ADJACENT, { side: 'ally' }).length ? 0 : values.attack_speed;
        if (key === 'AtkUp[BlockJustOne]') mods.atkPct = unit.blocking?.filter(alive).length === 1 ? values.atk : 0;
        if (key === 'rogue_2_attack_speed_up[life_point]') mods.aspd = resource(unit).life === values.life_point ? values.attack_speed : 0;
        if (key === 'rogue_2_block_cnt[life_point]') {
          mods.blockCnt = oneLife(unit) ? values.block_cnt : 0;
          if (oneLife(unit) && pulse && values.sp) unit.skill?.gainSp(values.sp, 'relic');
        }
        if (key === 'rogue_2_atk_up[life_point][king_suit]') mods.atkPct = oneLife(unit)
          ? values[kingdomCount >= 3 ? 'rogue_2_atk_up[king_suit][bonus].atk' : 'rogue_2_atk_up[king_suit].atk'] : 0;
        if (key === 'attr_up_on_trigger[def&mag_resist]') {
          mods.defFlat = battle.time - unit.deployedAt >= values.interval ? values.def : 0;
          mods.resFlat = battle.time - unit.deployedAt >= values.interval ? values.magic_resistance : 0;
        }
        if (key === 'modify_sp[attack_or_damage]' && pulse && ['attack', 'hurt'].includes(unit.skill?.spType)) unit.skill.gainSp(values.sp, 'relic');
        if (key === 'rogue_1_attack_up_after_skill') mods.atkPct = unit.skill?.active ? 0
          : Math.min(values.max_stack_cnt, Math.floor((battle.time - mem.skillEndAt) / interval)) * values.atk;
        if (key === 'rogue_2_hp_ratio_to_attr_add[atk]' || key === 'rogue_2_hp_ratio_to_attr_add[attack_speed]') {
          const factor = clamp((unit.hp / unit.s.maxHp - values.min_hp_ratio) / (values.max_hp_ratio - values.min_hp_ratio), 0, 1);
          if (key.endsWith('[atk]')) mods.atkPct = values.min_atk + (values.max_atk - values.min_atk) * factor;
          else mods.aspd = values.min_attack_speed + (values.max_attack_speed - values.min_attack_speed) * factor;
        }
        if (key === 'rogue_2_relic_fight_131') {
          const count = scaleOf(effect, unit); mods.atkMul = 1 + count * values.atk; mods.hpMul = 1 + count * values.max_hp; mods.aspd = count * values.attack_speed;
        }
        if (key === 'rogue_2_relic_fight_150') holdProtect(battle, unit,
          light < values.value ? values['damage_resistance[sanity_low].damage_resistance'] : values['damage_resistance[sanity_high].damage_resistance'],
          dt * 2 + 0.05, unit);
        if (randomTiles.has(effect.key)) {
          const selected = keyOf(unit) === randomTiles.get(effect.key);
          mods.atkPct = selected ? values.atk : 0; mods.aspd = selected ? values.attack_speed : 0;
          mods.hpRegenRatio = selected ? values.hp_recovery_per_sec_by_max_hp_ratio : 0;
          if (selected && pulse && values.sp) unit.skill?.gainSp(values.sp, 'relic');
        }
        if (key === 'rogue_2_atk_up_on_output_damage[stack]' && battle.time - (mem.lastDamage[effect.key] ?? -Infinity) > values.duration) mem.stacks[effect.key] = 0;
        if (Object.keys(mods).length) buff(unit, effect.key + ':dynamic', mods, { persist: false, duration: dt * 2 + 0.05 });
      }
      if (key === 'periodic_damage[stun&frozen&unmovable]') for (const enemy of enemies) {
        const mem = state(enemy); mem.timers[effect.key] = (mem.timers[effect.key] || 0) + dt;
        if (mem.timers[effect.key] >= 1 - 1e-9) {
          mem.timers[effect.key] %= 1;
          if (enemy.s.flags.stun || enemy.s.flags.freeze || enemy.s.flags.bind) extraDamage(null, enemy, values.damage);
        }
      }
    }
  });

  // Regen attributes are separate from healing efficiency in the native table.
  // Scaling at this battle's heal entry also covers skill-written regen buffs.
  const regenScale = 1 + abilities.filter(effect => effect.values.key === 'hp_recovery_per_sec[mul]')
    .reduce((sum, effect) => sum + effect.values.hp_recovery_per_sec, 0);
  if (regenScale !== 1) {
    const heal = battle.heal.bind(battle);
    battle.heal = (source, target, amount, options = {}) => heal(source, target,
      options.regen && target?.side === 'ally' ? amount * regenScale : amount, options);
  }
  // Skill-authored pulls toward a marked point do not always pass an explicit
  // source. Keep the current content callback's owner for the native force buff.
  let callbackSource = null;
  const safe = battle._safe;
  battle._safe = function (fn, label, owner, ...args) {
    const previous = callbackSource;
    if (owner?.side) callbackSource = owner;
    try { return safe.call(this, fn, label, owner, ...args); }
    finally { callbackSource = previous; }
  };
  for (const method of ['push', 'pull']) {
    const original = battle[method].bind(battle);
    battle[method] = (enemy, force, options = {}) => {
      const context = battle._frameCtx?.[battle._emitDepth - 1];
      const hookOwner = battle._frameOwner?.[battle._emitDepth - 1];
      const source = [options.source, options.from, options.center, callbackSource,
        hookOwner, context?.source, context?.attacker, context?.unit].find(candidate => candidate?.side);
      return original(enemy, force + (source?.side === 'ally' ? source.mem?.mizukiRelicForce || 0 : 0), options);
    };
  }
  battle.on('battleEnd', () => {
    if (owned.has('rogue_2_relic_fight_158')) layerGains.rogue_2_relic_fight_158 = 1;
  });
  const controller = { apply, layerGains, randomTiles: Object.fromEntries(randomTiles),
    snapshot: () => ({ effects: effects.length, layerGains: { ...layerGains }, randomTiles: Object.fromEntries(randomTiles) }) };
  INSTALLED.set(battle, controller); return controller;
}
