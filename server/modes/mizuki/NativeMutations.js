// Water Moon only. Values and reaction combinations come from the original
// charBuffData and config/buff_template_holder.ab, not shared mode definitions.
import { readFileSync } from 'node:fs';

const OFFICIAL = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8'));
const REACTIONS = OFFICIAL.rawTopic.charBuffData;
const DICE = OFFICIAL.modules.dice;
const SAN_RANGES = OFFICIAL.modules.sanCheck.sanRanges;
const INSTALLED = new WeakMap(), OWNERS = new WeakMap();
const PREFIX = 'mizuki:mutation:';
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const copy = (value) => structuredClone(value);
const bb = (buff) => Object.fromEntries((buff.blackboard || []).map((entry) => [entry.key, entry.valueStr ?? entry.value]));
const number = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const isId = (id) => typeof id === 'string' && Object.hasOwn(REACTIONS, id);
const suffix = (id) => Number(String(id).split('_').at(-1));
const idFor = (index) => 'rogue_2_mutation_' + index;

export const MIZUKI_MUTATION_SOURCE = Object.freeze({
  data: 'data/mizuki/rogue2.json:rawTopic.charBuffData;modules.sanCheck;modules.dice',
  actions: 'config/buff_template_holder.ab (local official client)',
  evidence: '.cache/mizuki-native-rules/mutation-template-actions.json',
});

export function mizukiMutationOptions() {
  return Object.values(REACTIONS).map(({ id, outerName, functionDesc, iconId }) => ({ id, name: outerName, description: functionDesc, iconId }));
}

/** Official post-review IDs: N16 uses infection-capable base reactions. */
export function mizukiMutationPool(grade = 0) {
  if (!integer(grade, 0, 18)) throw new TypeError('Invalid Mizuki difficulty grade');
  return (grade >= 17 ? [13, 14, 15, 16, 17, 18] : grade >= 16 ? [9, 10, 11, 12] : [1, 2, 3, 4]).map(idFor);
}

export function mizukiMutationForGrade(id, grade = 0) {
  if (!isId(id) || !integer(grade, 0, 18)) return null;
  const index = suffix(id);
  return grade >= 16 && index >= 1 && index <= 4 ? idFor(index + 8) : id;
}

/** Decode all base, strengthened and combination effects from native keys. */
export function mizukiMutationSpec(id) {
  if (!isId(id)) return null;
  const data = REACTIONS[id], spec = { id, name: data.outerName, description: data.functionDesc, iconId: data.iconId,
    bleed: 0, auto: false, freeze: 0, attributeScale: 1, initialSp: 0, frozenAtk: 0, frozenDef: 0, lowHpAtk: null, idleStack: null };
  for (const buff of data.buffs) {
    const values = bb(buff), key = String(values.key || values.buff_key || '');
    if (buff.key === 'char_attribute_final_scaler' || key.includes('attribute')) spec.attributeScale = number(values.max_hp, 1);
    if (key.includes('bleed')) spec.bleed = number(values.damage);
    if (key === 'AutoSkillTrigger' || /(?:_|\b)auto(?:_|\[)/.test(key)) spec.auto = true;
    if (key.includes('frozen')) {
      spec.freeze = number(values.freeze); spec.frozenAtk = number(values.atk); spec.frozenDef = number(values.def);
    }
    if (key.startsWith('passive_modify_sp')) spec.initialSp = number(values.sp);
    if (key.startsWith('passive_hp_ratio_to_attr_add')) spec.lowHpAtk = { minRatio: values.min_hp_ratio, maxRatio: values.max_hp_ratio,
      minAtk: values.min_atk, maxAtk: values.max_atk };
    if (key === 'char_attack_up_after_skill') spec.idleStack = { ...(spec.idleStack || {}), atk: values.atk,
      interval: values.interval, max: values.max_stack_cnt };
    if (key === 'char_attack_speed_after_skill') spec.idleStack = { ...(spec.idleStack || {}), aspd: values.attack_speed,
      interval: values.interval, max: values.max_stack_cnt };
  }
  return spec;
}

/** Read a persistent/native reaction ID even while evolution suppresses it. */
export function getMizukiMutation(unit) { return isId(unit?.mutationId) ? unit.mutationId : null; }

export function validMizukiMutation(id) { return id == null || isId(id); }

export function setMizukiMutationSuppressed(unit, on = true) {
  if (!unit || typeof unit !== 'object') return false;
  const controller = OWNERS.get(unit);
  if (controller) return controller.setSuppressed(unit, on);
  unit._mizukiMutationSuppressed = on === true;
  return true;
}

function pick(rng, values) {
  if (!values.length) return null;
  if (typeof rng?.pick === 'function') return rng.pick(values);
  if (typeof rng !== 'function') throw new TypeError('A seeded Mizuki RNG is required');
  const value = rng();
  if (!(value >= 0 && value < 1)) throw new TypeError('Invalid Mizuki RNG value');
  return values[Math.floor(value * values.length)];
}

export function mizukiSanRange(light) {
  if (!integer(light, 0, 100)) throw new TypeError('Invalid Mizuki light');
  return copy([...SAN_RANGES].sort((a, b) => a.sanMax - b.sanMax).find((range) => light <= range.sanMax));
}

export function createMizukiMutationState() { return { version: 1, checkedZones: [], checks: [] }; }

export function validMizukiSanCheck(check) {
  if (!check || typeof check.zoneId !== 'string' || !check.zoneId || check.zoneId.length > 100
      || !integer(check.grade, 0, 18) || !integer(check.light, 0, 100)) return false;
  const dice = DICE.dice[check.diceId], range = mizukiSanRange(check.light);
  if (!dice || !integer(check.roll, 1, dice.diceFaceCount) || check.diceGroupId !== range.diceGroupId) return false;
  const event = Object.values(DICE.diceEvents).filter((entry) => entry.diceGroupId === range.diceGroupId && check.roll <= entry.dicePointMax)
    .sort((a, b) => a.dicePointMax - b.dicePointMax)[0];
  if (!event || check.diceEventId !== event.diceEventId || check.canReroll !== event.canReroll
      || check.resultClass !== event.diceResultClass || check.kind !== (event.showType === 'MUTATION' ? 'mutation' : event.showType === 'VIRTUE' ? 'virtue' : 'quiet')) return false;
  const max = event.showType === 'MUTATION' ? (event.diceResultClass === 'VERYBAD' ? 2 : 1) : 0;
  return Array.isArray(check.targets) && check.targets.length <= max && check.targets.every((target) => target && typeof target.playerId === 'string'
    && target.playerId.length > 0 && integer(target.uid, 0, Number.MAX_SAFE_INTEGER) && mizukiMutationPool(check.grade).includes(target.mutationId))
    && new Set(check.targets.map((target) => target.playerId + ':' + target.uid)).size === check.targets.length
    && new Set(check.targets.map((target) => target.mutationId)).size <= 1;
}

export function validMizukiMutationState(state) {
  return state?.version === 1 && Array.isArray(state.checkedZones) && state.checkedZones.length <= 100
    && state.checkedZones.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100)
    && new Set(state.checkedZones).size === state.checkedZones.length && Array.isArray(state.checks)
    && state.checks.length === state.checkedZones.length && state.checks.every((check, index) => check?.zoneId === state.checkedZones[index] && validMizukiSanCheck(check));
}

/** Generate a pending result. A reroll is generated before committing this result. */
export function createMizukiSanCheck({ light, diceId, grade = 0, rng, players = [], zoneId, roll = null }) {
  const dice = DICE.dice[diceId];
  if (!dice || typeof zoneId !== 'string' || !zoneId || zoneId.length > 100) throw new TypeError('Invalid Mizuki sanity check identity');
  const range = mizukiSanRange(light), pool = mizukiMutationPool(grade);
  const value = roll ?? pick(rng, Array.from({ length: dice.diceFaceCount }, (_, index) => index + 1));
  if (!integer(value, 1, dice.diceFaceCount)) throw new TypeError('Invalid Mizuki dice roll');
  const event = Object.values(DICE.diceEvents).filter((entry) => entry.diceGroupId === range.diceGroupId && value <= entry.dicePointMax)
    .sort((a, b) => a.dicePointMax - b.dicePointMax)[0];
  if (!event) throw new TypeError('Missing original sanity dice event');
  const count = event.showType === 'MUTATION' ? (event.diceResultClass === 'VERYBAD' ? 2 : 1) : 0;
  const candidates = players.flatMap((player) => (player.roster || []).filter((unit) => !getMizukiMutation(unit))
    .map((unit) => ({ playerId: player.playerId, uid: unit.uid })));
  const mutationId = count && candidates.length ? pick(rng, pool) : null, targets = [];
  while (targets.length < count && candidates.length) {
    const candidate = pick(rng, candidates); candidates.splice(candidates.indexOf(candidate), 1);
    targets.push({ ...candidate, mutationId });
  }
  return { zoneId, light, diceId, grade, roll: value, diceGroupId: range.diceGroupId, diceEventId: event.diceEventId,
    kind: event.showType === 'MUTATION' ? 'mutation' : event.showType === 'VIRTUE' ? 'virtue' : 'quiet',
    resultClass: event.diceResultClass, canReroll: event.canReroll, targets };
}

/** Apply once after the team accepts the floor roll; roster IDs persist to later battles. */
export function commitMizukiSanCheck({ state, check, players = [] }) {
  if (!validMizukiMutationState(state) || !validMizukiSanCheck(check)) return { ok: false, error: 'BAD_TARGET' };
  if (state.checkedZones.includes(check.zoneId)) return { ok: false, error: 'ALREADY' };
  const dice = DICE.dice[check.diceId], event = DICE.diceEvents[check.diceEventId];
  if (!dice || !event || !integer(check.roll, 1, dice.diceFaceCount) || !Array.isArray(check.targets) || check.targets.length > 2
      || event.diceGroupId !== mizukiSanRange(check.light).diceGroupId || check.roll > event.dicePointMax) return { ok: false, error: 'BAD_TARGET' };
  const expected = Object.values(DICE.diceEvents).filter((entry) => entry.diceGroupId === event.diceGroupId && check.roll <= entry.dicePointMax)
    .sort((a, b) => a.dicePointMax - b.dicePointMax)[0];
  if (expected?.diceEventId !== event.diceEventId) return { ok: false, error: 'BAD_TARGET' };
  const maxTargets = event.showType === 'MUTATION' ? (event.diceResultClass === 'VERYBAD' ? 2 : 1) : 0;
  const available = players.flatMap((player) => player.roster || []).filter((unit) => !getMizukiMutation(unit)).length;
  if (check.targets.length !== Math.min(maxTargets, available)) return { ok: false, error: 'BAD_TARGET' };
  if (check.targets.length > maxTargets || new Set(check.targets.map((target) => target.playerId + ':' + target.uid)).size !== check.targets.length) return { ok: false, error: 'BAD_TARGET' };
  const resolved = [];
  for (const target of check.targets) {
    const unit = players.find((player) => player.playerId === target.playerId)?.roster?.find((value) => value.uid === target.uid);
    if (!unit || getMizukiMutation(unit) || !mizukiMutationPool(check.grade).includes(target.mutationId)) return { ok: false, error: 'BAD_TARGET' };
    resolved.push([unit, target.mutationId]);
  }
  for (const [unit, id] of resolved) unit.mutationId = id;
  state.checkedZones.push(check.zoneId); state.checks.push(copy(check));
  return { ok: true, check: copy(check) };
}

export function rerollMizukiSanCheck({ check, dice, rng, players = [] }) {
  if (!validMizukiSanCheck(check)) return { ok: false, error: 'BAD_TARGET' };
  if (!check.canReroll || !integer(dice, 1, 9999)) return { ok: false, error: 'NO_FUNDS' };
  const next = createMizukiSanCheck({ ...check, roll: null, rng, players });
  return { ok: true, dice: dice - 1, check: next };
}

/** Install before battleStart. No shared Battle, skill, or ability definition is modified. */
export function installMizukiNativeMutations(battle, { players = battle.players.map((player) => player.input) } = {}) {
  if (INSTALLED.has(battle)) return INSTALLED.get(battle);
  const states = new WeakMap();
  const inputFor = (unit) => players.find((player) => player.playerId === unit.ownerId)?.units?.find((input) => input.uid === unit.uid);
  const allowed = (unit) => unit?.kind === 'op' && unit.side === 'ally';
  const remember = (unit) => {
    if (!allowed(unit)) return null;
    if (!states.has(unit)) {
      const input = inputFor(unit); if (input?.mutationId != null) unit.mutationId = input.mutationId;
      states.set(unit, { input, cost: unit.base.cost, respawn: unit.base.respawnTime, deployment: -1, freezeId: null,
        bleedAt: null, idle: 0, stacks: 0 });
      OWNERS.set(unit, controller);
    }
    return states.get(unit);
  };
  const removeEffects = (unit) => {
    for (const buff of [...unit.buffs]) if (buff.key.startsWith(PREFIX)) battle.removeBuff(unit, buff);
  };
  const sync = (unit) => {
    const state = remember(unit); if (!state) return null;
    const spec = !unit._mizukiMutationSuppressed ? mizukiMutationSpec(getMizukiMutation(unit)) : null;
    const scale = spec?.attributeScale ?? 1;
    unit.base.cost = state.cost * scale; unit.base.respawnTime = state.respawn * scale;
    battle.removeBuff(unit, PREFIX + 'attribute');
    if (scale !== 1) battle.addBuff(unit, { key: PREFIX + 'attribute', allowDead: true, persist: true, duration: Infinity,
      mods: { hpMul: scale, atkMul: scale, defMul: scale } });
    unit.markDirty(); void unit.s;
    return spec;
  };
  const freeze = (unit, spec) => {
    if (!(spec?.freeze > 0) || unit.def?.immune?.has('frozen')) return;
    const duration = spec.freeze * (1 - battle.resistOf(unit));
    if (!(duration > 0)) return;
    battle.addBuff(unit, { key: PREFIX + 'freeze', status: 'freeze', source: unit, duration,
      flags: { freeze: true, stun: true }, visible: true });
    if (spec.frozenAtk || spec.frozenDef) battle.addBuff(unit, { key: PREFIX + 'frozen-attributes', source: unit, duration,
      mods: { atkPct: spec.frozenAtk, defPct: spec.frozenDef } });
  };
  const deploy = ({ unit, move }) => {
    const state = remember(unit); if (!state || move) return;
    const spec = sync(unit); if (!spec || state.deployment === unit.deploySeq) return;
    state.deployment = unit.deploySeq; state.bleedAt = null; state.idle = 0; state.stacks = 0;
    freeze(unit, spec);
    if (spec.initialSp) unit.skill?.setSpTotal(unit.skill.spTotal + spec.initialSp);
  };
  const controller = {
    getMutation: getMizukiMutation,
    setMutation(unit, id, { temporary = false } = {}) {
      if (!allowed(unit) || !validMizukiMutation(id)) return false;
      const state = remember(unit); removeEffects(unit); unit.mutationId = id;
      unit._mizukiMutationSuppressed = false; state.bleedAt = null; state.idle = 0; state.stacks = 0;
      if (!temporary && state.input) state.input.mutationId = id;
      const spec = sync(unit); if (unit.alive && unit.deployed) freeze(unit, spec);
      return true;
    },
    setSuppressed(unit, on = true) {
      const state = remember(unit); if (!state) return false;
      unit._mizukiMutationSuppressed = on === true; removeEffects(unit); state.bleedAt = null; state.idle = 0; state.stacks = 0;
      sync(unit); return true;
    },
    apply: sync,
    snapshot: () => battle.allyUnits.filter(allowed).filter((unit) => getMizukiMutation(unit)).map((unit) => ({
      ownerId: unit.ownerId, uid: unit.uid, mutationId: getMizukiMutation(unit), suppressed: unit._mizukiMutationSuppressed === true,
    })),
  };
  INSTALLED.set(battle, controller);
  battle.allyUnits.forEach(sync);
  battle.on('deploy', deploy, { priority: -9000 });
  // Native NoSourceDamage has _isUndeadable=true. Clamp the actual mutable
  // context after shields and modifiers without changing any other damage.
  battle.on('hpDamage', (event) => {
    if (event.dmg?.tags?.includes(PREFIX + 'bleed')) event.amount = Math.max(0, Math.min(event.amount, event.target.hp - 1));
  }, { priority: 10000 });
  battle.on('skillEnd', ({ unit }) => {
    const state = states.get(unit); if (!state) return;
    state.idle = 0; state.stacks = 0; battle.removeBuff(unit, PREFIX + 'idle');
  });
  battle.on('tick', ({ dt }) => {
    for (const unit of battle.allyUnits) {
      if (!allowed(unit) || !unit.alive || !unit.deployed || unit._mizukiMutationSuppressed) continue;
      const state = remember(unit), spec = mizukiMutationSpec(getMizukiMutation(unit)); if (!spec) continue;
      if (spec.bleed > 0) {
        if (unit.hp >= unit.s.maxHp - 1e-9) state.bleedAt = null;
        else if (state.bleedAt == null) state.bleedAt = battle.time + 1;
        else if (battle.time + 1e-9 >= state.bleedAt) {
          state.bleedAt += 1;
          battle.dealDamage(null, unit, { amount: spec.bleed, type: 'true', canDodge: false, noSp: true,
            sourceless: true, tags: [PREFIX + 'bleed'] });
        }
      }
      if (spec.lowHpAtk) {
        const rule = spec.lowHpAtk, ratio = Math.max(rule.minRatio, Math.min(rule.maxRatio, unit.hp / unit.s.maxHp));
        const fraction = (rule.maxRatio - ratio) / (rule.maxRatio - rule.minRatio);
        battle.addBuff(unit, { key: PREFIX + 'low-hp', duration: Infinity,
          mods: { atkPct: rule.maxAtk + fraction * (rule.minAtk - rule.maxAtk) } });
      }
      if (spec.idleStack && !unit.skill?.active) {
        const rule = spec.idleStack; state.idle += dt;
        const stacks = Math.min(rule.max, Math.floor((state.idle + 1e-9) / rule.interval));
        if (stacks !== state.stacks) { state.stacks = stacks; battle.addBuff(unit, { key: PREFIX + 'idle', duration: Infinity,
          mods: { atkPct: number(rule.atk) * stacks, aspd: number(rule.aspd) * stacks } }); }
      }
      if (spec.auto && unit.canAct && !unit.s.flags.silence && unit.skill?.manual && unit.skill.ready) {
        // Native TriggerSkill is an involuntary cast even when a field supports
        // manual control. Use that field's private cast permission temporarily.
        const previous = battle._manualSkill;
        battle._manualSkill = unit.skill;
        try { unit.skill.activate('mizuki:mutation:auto'); }
        finally { battle._manualSkill = previous; }
      }
    }
  }, { priority: 10000 });
  return controller;
}
