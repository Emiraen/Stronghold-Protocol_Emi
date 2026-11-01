// RO2 level runes. All transformations are private copies of original data;
// no global operator, enemy, map or engine registry is modified.
const clone = (v) => structuredClone(v);
const stats = Object.freeze({ max_hp: 'maxHp', atk: 'atk', def: 'def',
  magic_resistance: 'magicResistance', move_speed: 'moveSpeed', attack_speed: 'attackSpeed' });
const matches = (rule, id) => !rule.targets.length || rule.targets.includes(id);
const values = (bb) => Object.fromEntries((bb || []).filter((v) =>
  v.valueStr == null && Number.isFinite(v.value)).map((v) => [v.key, v.value]));
const strings = (bb) => Object.fromEntries((bb || []).filter((v) => v.valueStr != null)
  .map((v) => [v.key, v.valueStr]));
const targets = (s) => [...new Set(String(s || '').split('|').filter(Boolean))];

export function compileOfficialRunes(level, difficulty) {
  const out = { hidden: [], enemyRules: [], charRules: [], replacements: {},
    forbidden: [], enabledPredefines: {}, skillReplacements: {}, tileRules: [],
    costRecovery: 1, respawnTime: 1, unsupported: [] };
  const hidden = new Set();
  for (const rune of level.runes || []) {
    if (!(rune.difficultyMask === 'ALL' || rune.difficultyMask === difficulty
      || (!rune.difficultyMask && difficulty === 'NORMAL'))) continue;
    const bb = rune.blackboard || [], str = strings(bb), nums = values(bb);
    const rule = { key: rune.key, targets: targets(str.enemy || str.char), values: nums, strings: str };
    if (['enemy_attribute_mul', 'enemy_attribute_add', 'char_attribute_mul'].includes(rune.key)) {
      for (const key of Object.keys(nums)) if (!stats[key]) out.unsupported.push({
        code: 'rune_parameter', key: rune.key, parameter: key });
      (rune.key.startsWith('char_') ? out.charRules : out.enemyRules).push(rule);
    } else if (['enemy_skill_blackb_add', 'enemy_talent_blackb_mul', 'enemy_dynamic_ability_new',
      'enemy_attackradius_mul'].includes(rune.key)) {
      if (rune.key === 'enemy_dynamic_ability_new' && str.key !== 'invisible') {
        out.unsupported.push({ code: 'rune_parameter', key: rune.key, parameter: str.key });
      } else out.enemyRules.push(rule);
    } else if (rune.key === 'level_hidden_group_enable') {
      for (const key of targets(str.key)) hidden.add(key);
    } else if (rune.key === 'level_hidden_group_disable') {
      for (const key of targets(str.key)) hidden.delete(key);
    } else if (rune.key === 'level_enemy_replace' && str.key && str.value) {
      for (const key of targets(str.key)) out.replacements[key] = str.value;
    } else if (rune.key === 'global_cost_recovery_mul' && Number.isFinite(nums.scale)) {
      out.costRecovery *= nums.scale;
    } else if (rune.key === 'char_respawntime_mul' && Number.isFinite(nums.scale) && !str.char) {
      out.respawnTime *= nums.scale;
    } else if (rune.key === 'global_forbid_location' && str.location) {
      const parts = str.location.split('|');
      for (const part of parts) {
        const pos = /^\((\d+),(\d+)\)$/.exec(part);
        if (pos) out.forbidden.push([Number(pos[1]), Number(pos[2])]);
        else out.unsupported.push({ code: 'rune_parameter', key: rune.key, parameter: part });
      }
    } else if (rune.key === 'level_predefines_enable') {
      Object.assign(out.enabledPredefines, nums);
    } else if (rune.key === 'level_predefines_skill_replace' && str.key && Number.isInteger(nums.skill)) {
      out.skillReplacements[str.key] = nums.skill;
    } else if (rune.key === 'map_tile_blackb_mul') {
      out.tileRules.push(nums);
    } else if (rune.key !== 'default_key' || bb.length) {
      out.unsupported.push({ code: 'rune', key: rune.key, parameters: { nums, str } });
    }
  }
  out.hidden = [...hidden];
  return out;
}

export function applyOfficialEnemyRunes(id, original, config) {
  const out = clone(original);
  for (const rule of config.enemyRules) {
    if (!matches(rule, id)) continue;
    if (rule.key === 'enemy_attribute_mul' || rule.key === 'enemy_attribute_add') {
      for (const [key, value] of Object.entries(rule.values)) {
        const stat = stats[key];
        if (stat && Number.isFinite(out.attributes?.[stat])) out.attributes[stat] =
          rule.key.endsWith('_mul') ? out.attributes[stat] * value : out.attributes[stat] + value;
      }
    } else if (rule.key === 'enemy_attackradius_mul') {
      out.rangeRadius *= rule.values.scale;
    } else if (rule.key === 'enemy_skill_blackb_add') {
      for (const skill of out.skills || []) if (skill.prefabKey === rule.strings.skill) {
        for (const [key, value] of Object.entries(rule.values)) {
          const item = (skill.blackboard ||= []).find((v) => v.key === key);
          if (item) item.value += value;
          else skill.blackboard.push({ key, value, valueStr: null });
        }
      }
    } else if (rule.key === 'enemy_talent_blackb_mul') {
      for (const item of out.talentBlackboard || []) if (Object.hasOwn(rule.values, item.key)) {
        item.value *= rule.values[item.key];
      }
    } else if (rule.key === 'enemy_dynamic_ability_new') {
      (out.mizukiDynamicAbilities ||= []).push(rule.strings.key);
    }
  }
  return out;
}

/** Tile edits retain movement and terrain; forbid_location changes deployment only. */
export function applyOfficialLevelRunes(original, config) {
  const level = clone(original);
  const rewrite = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v.actionType === 'SPAWN' && config.replacements[v.key]) v.key = config.replacements[v.key];
    for (const value of Object.values(v)) if (value && typeof value === 'object') {
      if (Array.isArray(value)) value.forEach(rewrite);
      else rewrite(value);
    }
  };
  rewrite(level.waves); rewrite(level.branches);
  for (const p of [...(level.predefines?.characterInsts || []), ...(level.predefines?.tokenInsts || [])]) {
    const key = p.alias || p.inst?.characterKey;
    if (Object.hasOwn(config.enabledPredefines, key)) p.hidden = !config.enabledPredefines[key];
    if (Object.hasOwn(config.skillReplacements, key)) p.skillIndex = config.skillReplacements[key];
  }
  for (const tile of level.mapData?.tiles || []) for (const rule of config.tileRules) {
    for (const item of tile.blackboard || []) if (Object.hasOwn(rule, item.key)) item.value *= rule[item.key];
  }
  for (const [r, c] of config.forbidden) {
    const map = level.mapData?.map, tiles = level.mapData?.tiles;
    const line = map?.[map.length - 1 - r], tile = tiles?.[line?.[c]];
    if (!tile) throw new RangeError('Original forbidden tile is outside the map: ' + r + ',' + c);
    const copy = { ...clone(tile), buildableType: 'NONE' };
    line[c] = tiles.length; tiles.push(copy);
  }
  return level;
}

/** Install before battleStart; new summons/devices inherit only this field's runes. */
export function installOfficialUnitRunes(battle, config) {
  const applied = new WeakSet();
  const apply = (unit) => {
    if (!unit || unit.side !== 'ally' || applied.has(unit)) return;
    applied.add(unit);
    const id = unit.def?.charId || unit.defId;
    for (const rule of config.charRules) if (matches(rule, id)) {
      for (const [key, value] of Object.entries(rule.values)) {
        const stat = ({ magicResistance: 'res', attackSpeed: 'aspd' })[stats[key]] || stats[key];
        if (stat && Number.isFinite(unit.base[stat])) unit.base[stat] *= value;
      }
    }
    if (unit.kind === 'op') unit.base.respawnTime *= config.respawnTime;
    unit.markDirty();
    void unit.s;
  };
  battle.allyUnits.forEach(apply);
  battle.on('deploy', ({ unit }) => apply(unit), { priority: 20000 });
  battle.on('enemySpawn', ({ enemy }) => {
    for (const key of enemy?.def?.raw?.officialData?.mizukiDynamicAbilities || []) if (key === 'invisible') {
      battle.addBuff(enemy, { key: 'mizuki:official:rune:invisible', persist: true,
        flags: { stealth: true }, visible: true });
    }
  }, { priority: 20000 });
  return { apply };
}
