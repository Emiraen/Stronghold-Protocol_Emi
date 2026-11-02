// 国度 (V79): the territory is owned by the deployed operator, including S3's expanded tiles.
// Numeric skill/talent values are resolved from the selected form's official blackboards.
import { num, talentBb, traitBb, moduleBb, skillRec, up, byEnemyAttack } from '../shared/tier1.js';
import { bodyInKeys } from '../../../body.js';
import { absoluteRangeKeys, canTargetEnemy } from '../../../targeting.js';
import { COLS } from '../../../constants.js';

const S1 = 'skchr_dminon_1', S2 = 'skchr_dminon_2', S3 = 'skchr_dminon_3';
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });
const FOUR = Object.freeze([[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]);
const of = (raw, sid) => skillRec(raw, sid)?.bb || {};
const on = (u, sid) => up(u) && u.skill?.active && u.skill.id === sid;

export function dminonKingdom(unit) { return unit.mem.dminonKingdom?.keys || new Set(); }

function kingdomState(unit) {
  return unit.mem.dminonKingdom ||= { keys: new Set(), extra: new Set(), seen: new Set(), nextDamage: 0, nextSpread: 0, collapsed: false };
}

function refreshKingdom(battle, unit, reset = false) {
  const state = kingdomState(unit);
  if (reset) state.extra.clear();
  if (battle.rangeChanged(unit)) battle._refreshRange(unit);
  const nextKeys = new Set([...(unit.rangeKeys || []), ...state.extra]);
  if (nextKeys.size !== state.keys.size || [...nextKeys].some(k => !state.keys.has(k))) {
    battle.fx('dminon_kingdom', { id: unit.id, x: unit.x, y: unit.y, tiles: [...nextKeys],
      skill: unit.skill?.active ? unit.skill.id : '', dur: 0 });
  }
  state.keys = nextKeys;
  return state;
}

function kingdomFoes(battle, unit, keys = dminonKingdom(unit)) {
  return battle.enemies.filter(e => canTargetEnemy(unit, e, GROUND) && bodyInKeys(e, keys));
}

function collapse(battle, unit, talent) {
  const state = kingdomState(unit);
  if (state.collapsed) return;
  state.collapsed = true;
  const foes = kingdomFoes(battle, unit);
  const attack = unit.s.atk;
  battle.fx('dminon_collapse', { id: unit.id, x: unit.x, y: unit.y, tiles: [...state.keys], dur: 1 });
  for (const target of foes) {
    if (num(talent.atk_scale) > 0) battle.dealDamage(unit, target, {
      amount: attack * num(talent.atk_scale), type: 'arts', canDodge: false,
      tags: ['talent', 'dminon:collapse'],
    });
    if (target.alive && num(talent.stun) > 0) battle.applyStatus(target, 'stun', { duration: num(talent.stun), source: unit });
  }
  state.keys.clear(); state.extra.clear(); state.seen.clear();
}

export default {
  char_4246_dminon: (_bb, raw) => {
    const b1 = of(raw, S1), b2 = of(raw, S2), b3 = of(raw, S3);
    const t0 = talentBb(raw, 0), t1 = talentBb(raw, 1), mod = moduleBb(raw);
    const end = ({ battle, unit, reason }) => {
      // _remove ends skills before wiping buffs: collapse still sees its skill ATK and full territory.
      if (reason === 'death') { collapse(battle, unit, t1); return; }
      refreshKingdom(battle, unit, true);
      // onEnd runs before the range override is removed. Rebuild from the basic range explicitly.
      kingdomState(unit).keys = new Set(absoluteRangeKeys(unit.rangeGrid || [], unit.tileR, unit.tileC, unit.dir,
        unit.s.permRangeExtend || 0));
      battle.fx('dminon_kingdom', { id: unit.id, x: unit.x, y: unit.y,
        tiles: [...kingdomState(unit).keys], skill: '', dur: 0 });
    };
    return {
      trait: {
        allInRange: true, canHitFly: false, groundOnly: true, dmgType: 'phys',
        install(battle, unit) {
          const dodge = num(traitBb(raw).prob, 0.5);
          battle.addBuff(unit, { key: 'trait:stalker', mods: { dodgePhys: dodge, dodgeArts: dodge }, persist: true, allowDead: true });
        },
      },
      skills: {
        [S1]: {
          kind: 'duration', mods: { aspd: num(b1.attack_speed) },
          onStart({ battle, unit }) { const s = refreshKingdom(battle, unit); s.seen.clear(); }, onEnd: end,
        },
        [S2]: {
          kind: 'duration', mods: { atkPct: num(b2.atk) },
          targeting: { rangeGrid: skillRec(raw, S2)?.rangeGrid },
          onStart({ battle, unit, skill }) {
            refreshKingdom(battle, unit);
            if (skill.activations >= 2) {
              skill.timeLeft = Infinity;
              battle.addBuff(unit, { key: 'dminon:s2:aspd', mods: { aspd: num(b2.attack_speed) }, tags: ['skill'] });
            }
          },
          onEnd(ctx) { end(ctx); ctx.battle.removeBuff(ctx.unit, 'dminon:s2:aspd'); },
        },
        [S3]: {
          kind: 'duration', mods: { atkPct: num(b3.atk), aspd: num(b3.attack_speed) },
          targeting: { rangeGrid: skillRec(raw, S3)?.rangeGrid },
          // Its attack selector is the entire territory, including islands outside the ordinary range.
          // The tick handler uses the normal attack pipeline and its ordinary attack cooldown.
          attack: { noAttack: true, allInRange: true },
          onStart({ battle, unit, skill }) {
            const state = refreshKingdom(battle, unit);
            state.nextSpread = battle.time;
          },
          onEnd: end,
        },
      },
      install(battle, unit) {
        const state = kingdomState(unit);
        unit.skill?.addTriggerRange(() => ({ keys: [...dminonKingdom(unit)], profile: GROUND }));
        const start = () => {
          state.extra.clear(); state.seen.clear(); state.collapsed = false;
          state.nextDamage = battle.time;
          refreshKingdom(battle, unit);
        };
        battle.on('deploy', ({ unit: target }) => { if (target === unit) start(); }, { owner: unit });
        battle.on('death', ({ unit: target }) => { if (target === unit) collapse(battle, unit, t1); }, { owner: unit });
        battle.on('hit', ctx => {
          if (on(unit, S2) && ctx.target?.side === 'enemy' && bodyInKeys(ctx.target, dminonKingdom(unit))
              && (ctx.dmg.type === 'phys' || ctx.dmg.type === 'arts')) ctx.dmg.canDodge = false;
        }, { owner: unit, priority: 500 });
        battle.on('damaged', ctx => {
          if (!on(unit, S3) || !byEnemyAttack(ctx) || ctx.source.isFlying || ctx.target?.side !== 'ally'
              || !bodyInKeys(ctx.target, dminonKingdom(unit)) || battle.time < state.nextSpread - 1e-9) return;
          state.nextSpread = battle.time + Math.max(0, num(b3['attack@cd'], 0.5));
          const row = Math.round(ctx.source.y), col = Math.round(ctx.source.x), added = new Set();
          for (const [dr, dc] of FOUR) {
            const r = row + dr, c = col + dc;
            if (!battle.grid.inBounds(r, c) || !battle.grid.groundPassable(r, c) || battle.grid.tile(r, c).height === 'HIGH') continue;
            const key = r * COLS + c;
            state.extra.add(key); state.keys.add(key); added.add(key);
          }
          battle.fx('dminon_spread', { id: unit.id, x: ctx.source.x, y: ctx.source.y,
            tiles: [...added], dur: Math.max(0, num(b3['attack@cd'], 0.5)) });
          for (const target of kingdomFoes(battle, unit, added)) battle.dealDamage(unit, target, {
            amount: unit.s.atk * num(b3['attack@aoe_atk_scale']), type: 'phys', canDodge: false,
            isSkill: true, tags: ['skill', 'dminon:spread', 'counter'],
          });
        }, { owner: unit });
        battle.on('tick', () => {
          if (!up(unit) || unit.hidden) return;
          refreshKingdom(battle, unit);
          const foes = kingdomFoes(battle, unit);
          for (const target of foes) {
            const cut = Math.abs(num(t0.attack_speed));
            if (cut > 0) battle.applyStrongest(target, 'dminon:kingdom:aspd', { duration: battle.dt * 1.5,
              value: cut, mods: value => ({ aspd: -value }), source: unit });
            if (on(unit, S1) && !state.seen.has(target.id)) {
              state.seen.add(target.id);
              battle.applyStatus(target, 'sluggish', { duration: num(b1.sluggish), source: unit });
            }
          }
          // AMB-X affects every enemy in the attack range, including flyers; S3 islands are not attack range.
          const slow = Math.abs(num(mod.move_speed));
          if (slow > 0) for (const target of battle.enemiesInKeys(unit.rangeKeys, unit, { canHitFly: true })) {
            battle.addBuff(target, { key: `dminon:ambx:${unit.id}`, duration: battle.dt * 1.5,
              mods: { moveMul: Math.max(0, 1 - slow) }, source: unit, tags: ['module'] });
          }
          if (battle.time >= state.nextDamage - 1e-9) {
            state.nextDamage = battle.time + 1;
            for (const target of foes) battle.dealDamage(unit, target, {
              amount: unit.s.atk * num(t0.atk_scale), type: 'arts', canDodge: false,
              tags: ['talent', 'dot', 'dminon:kingdom'],
            });
          }
          if (on(unit, S3) && unit.canAct && !unit.s.flags.disarm && unit.atkCd <= 1e-9 && foes.length
              && battle.forceAttack(unit, foes)) unit.atkCd = Math.max(unit.atkCd, unit.s.interval);
        }, { owner: unit });
      },
    };
  },
};
