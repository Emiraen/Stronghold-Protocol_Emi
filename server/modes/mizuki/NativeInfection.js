// RO2 env_027_rogue2enroll3 only. Native manager evidence and prefab hashes:
// docs/research/mizuki-native-infection.md. No shared Battle prototypes change.
import { readFileSync } from 'node:fs';
import { holdProtect } from '../../sim/content/kits/shared/tier1.js';
import { getMizukiMutation, installMizukiNativeMutations, mizukiMutationForGrade,
  setMizukiMutationSuppressed } from './NativeMutations.js';

const RULES = JSON.parse(readFileSync(new URL('../../../data/mizuki/native-infection.json', import.meta.url), 'utf8'));
const INSTALLED = new WeakMap();
const GENE = 'rogue_2_relic_fight_159', EVOLUTION = 'rogue_2_mutation_19';
const PENETRATION = 'mizuki:infection:ascension';
const eligible = (unit) => unit?.kind === 'op' && unit.side === 'ally';
const present = (unit) => eligible(unit) && unit.alive && unit.deployed && !unit.hidden && unit.hp > 0;
const sharedReaction = (id) => { const n = Number(String(id).split('_').at(-1)); return n >= 9 && n <= 18; };

/** Original PILL / BIGPILL reward: persist evolution on affected roster cards. */
export function applyMizukiEvolutionReward(players, itemId, rng) {
  if (!['rogue_2_pill', 'rogue_2_bigpill'].includes(itemId)) return { ok: false, error: 'BAD_ITEM' };
  const candidates = players.flatMap((player) => (player.roster || []).filter((unit) => {
    const id = getMizukiMutation(unit); return id !== null && id !== EVOLUTION;
  }).map((unit) => ({ playerId: player.playerId, unit })));
  if (!candidates.length) return { ok: false, error: 'NO_TARGET' };
  if (itemId === 'rogue_2_pill' && typeof rng?.pick !== 'function') throw new TypeError('Evolution reward requires a seeded RNG');
  const chosen = itemId === 'rogue_2_bigpill' ? candidates : [rng.pick(candidates)];
  const changes = chosen.map(({ playerId, unit }) => ({ playerId, uid: unit.uid, before: unit.mutationId, mutationId: EVOLUTION }));
  for (const { unit } of chosen) unit.mutationId = EVOLUTION;
  return { ok: true, itemId, changes };
}

/** Install before the first deployment; all infection state lasts this battle. */
export function installMizukiNativeInfection(battle, { grade = 0, players = battle.players.map((p) => p.input),
  collectibles = [], enabled = grade >= 16 || collectibles.some((item) => (item?.id ?? item) === GENE) } = {}) {
  if (INSTALLED.has(battle)) return INSTALLED.get(battle);
  const mutations = installMizukiNativeMutations(battle, { players });
  const original = new Map(), infected = new Set(), evolved = new Set();
  let infectionId = null;
  for (const unit of battle.allyUnits.filter(eligible)) {
    const id = mizukiMutationForGrade(getMizukiMutation(unit), grade);
    if (id === EVOLUTION) { evolved.add(unit); original.set(unit, { id, remaining: 0 }); }
    else if (enabled && sharedReaction(id)) {
      // Native _RegisterOriginalCharBuff keeps the FIRST char_shared_data
      // blackboard for this field. Infection never picks a new random type.
      infectionId ??= id; original.set(unit, { id, remaining: RULES.maxInfectionCount });
      infected.add(unit);
    }
  }
  if (enabled && infectionId) for (const [unit, state] of original) {
    if (state.id !== EVOLUTION) mutations.setMutation(unit, infectionId, { temporary: true });
  }

  const effect = (unit, key, extra = {}) => battle.fx('mizuki:effect', { key, unitId: unit.id, x: unit.x, y: unit.y, ...extra });
  const evolutionEffect = (unit) => ({ id: 'mizuki:evolution:' + unit.id, key: RULES.ascensionEffect,
    unitId: unit.id, x: unit.x, y: unit.y, loop: true, active: true });
  const restoreEvolution = (unit) => {
    setMizukiMutationSuppressed(unit, true);
    if (!present(unit)) return;
    // The original damage_resistance[inf] is shared 庇护: strongest wins,
    // physical/arts only. Do not multiply a second generic damage-taken cut.
    holdProtect(battle, unit, RULES.protection, Infinity, unit);
    battle.addBuff(unit, { key: PENETRATION, duration: Infinity,
      mods: { defIgnorePct: RULES.defPenetration, resIgnorePct: RULES.resPenetration } });
  };
  const ascend = (unit) => {
    if (evolved.has(unit)) { restoreEvolution(unit); return false; }
    infected.delete(unit); evolved.add(unit);
    unit.mem.mizukiEvolution = true; restoreEvolution(unit);
    effect(unit, RULES.ascensionEffect, evolutionEffect(unit));
    battle.emit('mizuki:ascend', { unit, mutationId: EVOLUTION });
    return true;
  };
  const canInfect = (unit) => present(unit) && !infected.has(unit) && !evolved.has(unit) && !original.has(unit);
  const infect = (unit, sources) => {
    if (!infectionId || !canInfect(unit)) return false;
    if (!mutations.setMutation(unit, infectionId, { temporary: true })) return false;
    infected.add(unit); unit.mem.mizukiInfected = true;
    for (const source of sources) {
      effect(source, RULES.projectileEffect, { to: { x: unit.x, y: unit.y }, toUnitId: unit.id, speed: RULES.projectileSpeed, loop: false });
      battle.after(Math.hypot(source.x - unit.x, source.y - unit.y) / RULES.projectileSpeed,
        () => effect(unit, RULES.projectileHitEffect, { loop: false }));
    }
    effect(unit, RULES.infectionEffect, { loop: false });
    battle.emit('mizuki:infect', { unit, sources, mutationId: infectionId });
    return true;
  };
  const decrement = (unit) => {
    const state = original.get(unit);
    if (!state || state.remaining <= 0) return;
    if (--state.remaining === 0) ascend(unit);
  };
  const locate = ({ unit, move = false }) => {
    if (move || !present(unit)) return;
    if (evolved.has(unit)) { restoreEvolution(unit); return; }
    if (!enabled) return;
    const state = original.get(unit);
    if (state) {
      if (state.remaining <= 0) { ascend(unit); return; }
      effect(unit, RULES.infectionEffect, { loop: false });
      for (const offset of RULES.gridCheckList) {
        if (!state.remaining) break;
        const row = unit.tileR + offset.row, col = unit.tileC + offset.col;
        const target = battle.allyUnits.find((candidate) => candidate.tileR === row && candidate.tileC === col && canInfect(candidate));
        if (target && infect(target, [unit])) decrement(unit);
      }
      return;
    }
    // A previously infected normal operator retains its reaction on redeploy,
    // but never becomes an original host and cannot infect another operator.
    if (infected.has(unit)) return;
    const nearby = [...original].filter(([host, value]) => value.remaining > 0 && present(host)
      && Math.hypot(host.x - unit.x, host.y - unit.y) <= RULES.nearbyDistance).map(([host]) => host);
    // Native _OnClearCharacterBorn infects ONCE, then credits EVERY nearby
    // original host. Two hosts can evolve from the same successful target.
    if (nearby.length && infect(unit, nearby)) nearby.forEach(decrement);
  };
  const controller = {
    enabled,
    snapshot: () => ({ enabled, infectionId, effects: [...evolved].filter(present).map(evolutionEffect), units: battle.allyUnits.filter(eligible)
      .filter((unit) => original.has(unit) || infected.has(unit) || evolved.has(unit)).map((unit) => ({
        unitId: unit.id, ownerId: unit.ownerId, uid: unit.uid, original: original.has(unit),
        infected: infected.has(unit), evolved: evolved.has(unit),
        remaining: original.get(unit)?.remaining ?? 0, mutationId: getMizukiMutation(unit),
      })) }),
  };
  INSTALLED.set(battle, controller);
  if (enabled || evolved.size) {
    // Native mutations run at -9000; evolution removes their derived effects
    // immediately after that hook and restores its own effects after death.
    battle.on('deploy', locate, { priority: -10000 });
    for (const unit of evolved) { unit.mem.mizukiEvolution = true; restoreEvolution(unit); }
    for (const unit of battle.allyUnits) if (present(unit)) locate({ unit });
  }
  return controller;
}
