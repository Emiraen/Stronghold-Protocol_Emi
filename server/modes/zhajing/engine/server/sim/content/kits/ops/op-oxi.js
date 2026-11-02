// 塔露拉 — V79 char_4247_oxi. Values are read from the selected form/rank's official blackboards.
// Sources: character_table, skill_table, buff_template_data; local charpack/char_4247_oxi.ab,
// battle/prefabs/[uc]skills.ab and [uc]projectiles.ab (26-10-29-15-35-15-96278206).
// The source's STACK buff refreshes its clock and peels one stack on expiry (clearAllStackCntWhenTimeUp=false).
// Fire-field leases reject NEW tiles at capacity, retain/refresh existing tiles, and detach with their owner.
// Heatwave projectiles snapshot ATK, share one hit ledger per volley, and survive the end of their source's cast.

import { num, talentBb, skillRec, up, PROTECT } from '../shared/tier1.js';
import { elementDmg } from '../shared/tier6.js';
import { hasHp, isHpLoss } from '../../../damage.js';
import { tileKeyOf, canTargetEnemy } from '../../../targeting.js';
import { hitRect, bodyInKeys } from '../../../body.js';
import { dirVec } from '../../../dir.js';
import * as SIM_CONSTANTS from '../../../constants.js';

const { COLS, TICK } = SIM_CONSTANTS;
// The isolated Zhajing engine predates the shared collider constant; this operator still uses the official radius.
const ENEMY_COLLIDER_RADIUS = SIM_CONSTANTS.ENEMY_COLLIDER_RADIUS ?? 0.1;

const S1 = 'skchr_oxi_1', S2 = 'skchr_oxi_2', S3 = 'skchr_oxi_3';
const STACK = 'oxi:s2Stack';
const ANY = Object.freeze({ canHitFly: true });
const GROUND = Object.freeze({ canHitFly: false, groundOnly: true });
const EPS = 1e-8;
// Front and Back Spine: Skill_2_Cambat.OnAttack = 0.1666667 s (fixed ability, not affected by ASPD).
const COUNTER_FRAME = 1 / 6;
const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};

/** Original map-edge volley: shift the whole lane window inward; each lane finds its own rear tile. */
export function oxiVolleyLanes(battle, unit, halfWidth, maxBack = 11, exit = 5) {
  const [dy, dx] = dirVec(unit.dir), g = battle.grid, R = g.rect;
  const lo = dx ? R.r0 : R.c0, hi = dx ? R.r1 : R.c1;
  const width = Math.min(hi - lo + 1, Math.floor(halfWidth) * 2 + 1);
  const center = dx ? unit.tileR : unit.tileC;
  const first = Math.max(lo, Math.min(center - Math.floor(halfWidth), hi - width + 1));
  const lanes = [];
  for (let lane = first; lane < first + width; lane++) {
    let rear = null, forward = null;
    const min = dx ? R.c0 : R.r0, max = dx ? R.c1 : R.r1;
    for (let axis = min; axis <= max; axis++) {
      const r = dx ? lane : axis, c = dx ? axis : lane;
      if (g.tile(r, c).pass === 'NONE') continue;
      const d = (r - unit.tileR) * dy + (c - unit.tileC) * dx;
      if (d >= -maxBack - EPS && (!rear || d < rear.d)) rear = { r, c, d };
      if (!forward || d > forward.d) forward = { r, c, d };
    }
    if (rear && forward) lanes.push({ x: rear.c, y: rear.r, toX: forward.c + dx * exit, toY: forward.r + dy * exit, dx, dy });
  }
  return lanes;
}

/** Squared distance from a point to this tick's short projectile segment (no tunnelling). */
function segmentDistanceSq(e, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const f = len ? Math.max(0, Math.min(1, ((e.x - ax) * dx + (e.y - ay) * dy) / len)) : 0;
  const x = e.x - ax - dx * f, y = e.y - ay - dy * f;
  return x * x + y * y;
}

function waveTouches(e, ax, ay, bx, by, radius) {
  const R = hitRect(e);
  if (!R) return segmentDistanceSq(e, ax, ay, bx, by) <= (radius + ENEMY_COLLIDER_RADIUS) ** 2 + EPS;
  // These waves are axis-aligned: interval/rectangle distance is exact for their whole swept segment.
  const dx = Math.max(0, Math.min(ax, bx) - R.x1, R.x0 - Math.max(ax, bx));
  const dy = Math.max(0, Math.min(ay, by) - R.y1, R.y0 - Math.max(ay, by));
  return dx * dx + dy * dy <= radius * radius + EPS;
}

export default {
  char_4247_oxi: (bb, chess) => {
    const t1 = talentBb(chess, 0), t2 = talentBb(chess, 1);
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    const arcaneStep = num(t1.arcane_step), arcaneMax = num(t1.arcane_max);
    const arcaneCap = arcaneStep > 0 ? Math.round(arcaneMax / arcaneStep) : 0;
    const fieldIv = Math.max(TICK, num(t2.field_interval, 0.3));
    const fieldDuration = num(t2.field_duration), fieldCapacity = Math.floor(num(t2.max_count));
    const guardDuration = num(b2.skill_duration, 1.3), guardHold = num(b2.shelter_hold_duration, 0.2);
    const maxStacks = Math.max(1, Math.floor(num(b2.max_stack_cnt, 5)));
    const stackDuration = num(b2.stack_duration, 5);

    function state(battle, unit) {
      return unit.mem.oxi ?? (unit.mem.oxi = {
        stacks: 0, idleUntil: battle.time + num(t1.arcane_idle_delay, 3), arcaneAt: battle.time,
        tiles: new Map(), trails: new Map(), waves: [], nextShot: 0, nextWave: 0, channel: null, guard: null,
      });
    }

    function clearFields(battle, unit, st) {
      for (const [tile] of st.tiles) battle.fx('oxiFireField', { id: unit.id, x: tile % COLS, y: Math.floor(tile / COLS), tile, on: 0 });
      st.tiles.clear();
      st.trails.clear();
    }

    function lease(battle, unit, st, enemy) {
      const tile = tileKeyOf(enemy), r = Math.floor(tile / COLS), c = tile % COLS;
      if (tile < 0 || !battle.grid.groundPassable(r, c, true)) return;
      if (!st.tiles.has(tile)) {
        if (st.tiles.size >= fieldCapacity) return;
        battle.fx('oxiFireField', { id: unit.id, x: c, y: r, tile, dur: fieldDuration, on: 1 });
      }
      // Refresh is sent too: a client must not end the original effect while the lease is renewed.
      else battle.fx('oxiFireField', { id: unit.id, x: c, y: r, tile, dur: fieldDuration, on: 1, refresh: true });
      st.tiles.set(tile, battle.time + fieldDuration);
    }

    function addStack(battle, unit, n = null) {
      const current = unit.findBuff(STACK);
      const count = Math.min(maxStacks, n ?? (current?.stacks ?? 0) + 1);
      if (!(count > 0) || !up(unit)) {
        unit.profile.hitAllBlocked = false;
        battle.fx('oxiEnhance', { id: unit.id, on: 0, stacks: 0 });
        return;
      }
      battle.addBuff(unit, {
        key: STACK, source: unit, duration: stackDuration, stacks: count, maxStacks,
        mods: { atkPct: num(b2.atk), defPct: num(b2.def) }, tags: ['skill'],
        onExpire({ battle, unit, buff }) { addStack(battle, unit, buff.stacks - 1); },
        onRemove({ battle, unit }) {
          unit.profile.hitAllBlocked = false;
          battle.fx('oxiEnhance', { id: unit.id, on: 0, stacks: 0 });
        },
      });
      unit.profile.hitAllBlocked = true;
      battle.fx('oxiEnhance', { id: unit.id, on: 1, stacks: count });
    }

    function counter(battle, unit, guard) {
      if (guard.struck || !up(unit) || !hasHp(unit) || guard.seq !== unit.deploySeq) return;
      guard.struck = true;
      let target = guard.target;
      // The source selector first uses the attacking enemy; if it is no longer valid, fall back to own melee range.
      if (!target?.alive || !target.deployed || target.hidden) target = battle.enemiesInKeys(unit.rangeKeys, unit, GROUND)[0];
      if (target) {
        const x = target.x, y = target.y;
        const radius = num(b2.ability_range_radius, 1);
        const amount = unit.s.atk * num(b2.retaliate_atk_scale);
        battle.fx('oxiCounter', { id: unit.id, x, y, radius, target: target.id });
        for (const e of battle.foesInRadius(x, y, radius, true)) {
          battle.dealDamage(unit, e, { amount, type: 'arts', isSkill: true, tags: ['skill', 'counter', 'oxiCounter'] });
        }
      }
    }

    function emitWave(battle, unit, st, overload) {
      const wave = ++st.nextWave, hit = new Set();
      const speed = num(b3.wave_speed, 2.3);
      const lanes = oxiVolleyLanes(battle, unit, num(overload ? b3.overload_half_width : b3.normal_half_width, overload ? 6 : 2), num(b3.wave_max_back_distance, 11), num(b3.wave_exit_distance, 5));
      for (const lane of lanes) {
        const shot = ++st.nextShot;
        const dist = Math.abs(lane.toX - lane.x) + Math.abs(lane.toY - lane.y);
        const delay = num(b3.random_birth_delay) * battle.rng();
        const p = { ...lane, wave, shot, hit, speed, remaining: dist, age: 0, delay, atk: unit.s.atk, born: false };
        st.waves.push(p);
      }
    }

    function tickWaves(battle, unit, st, dt) {
      if (!st.waves.length) return;
      const keep = [], collision = num(b3.projectile_range, 0.5), radius = num(b3.range_radius, 1.5);
      for (const p of st.waves) {
        p.age += dt;
        if (p.delay > 0) { p.delay -= dt; keep.push(p); continue; }
        if (!p.born) {
          p.born = true;
          battle.fx('oxiHeatwave', { id: unit.id, wave: p.wave, shot: p.shot, x: p.x, y: p.y, toX: p.toX, toY: p.toY, speed: p.speed, dur: Math.min(25, p.remaining / p.speed), on: 1 });
        }
        const travel = Math.min(p.speed * dt, p.remaining), nx = p.x + p.dx * travel, ny = p.y + p.dy * travel;
        let target = null, best = Infinity;
        for (const e of battle.enemies) {
          if (!canTargetEnemy(unit, e, ANY)) continue;
          if (!waveTouches(e, p.x, p.y, nx, ny, collision)) continue;
          const along = (e.x - p.x) * p.dx + (e.y - p.y) * p.dy;
          if (along < best) { best = along; target = e; }
        }
        p.x = nx; p.y = ny; p.remaining -= travel;
        if (target) {
          battle.fx('oxiHeatwave', { id: unit.id, wave: p.wave, shot: p.shot, x: p.x, y: p.y, on: 0 });
          battle.fx('oxiHeatwaveHit', { id: unit.id, wave: p.wave, shot: p.shot, x: target.x, y: target.y, target: target.id, radius });
          for (const e of battle.foesInRadius(target.x, target.y, radius, true)) {
            const scale = p.hit.has(e.id) ? num(b3.same_wave_repeat_damage_scale, 0.15) : 1;
            const type = e.findBuff('burnBurst') ? 'elemental' : 'arts';
            battle.dealDamage(unit, e, { amount: p.atk * num(b3.heatwave_atk_scale) * scale, type, element: type === 'elemental' ? 'burn' : null, isSkill: true, tags: ['skill', 'oxiHeatwave'] });
            p.hit.add(e.id);
          }
        } else if (p.remaining > EPS && p.age < 25) keep.push(p);
        else battle.fx('oxiHeatwave', { id: unit.id, wave: p.wave, shot: p.shot, x: p.x, y: p.y, on: 0 });
      }
      st.waves = keep;
    }

    return {
      trait: { dmgType: 'arts', canHitFly: false },
      skills: {
        [S1]: {
          kind: 'instant',
          attack: {
            dmgType: 'arts', atkScale: num(b1.atk_scale, 1), canHitFly: false,
            onEachHit({ battle, unit, target }) {
              if (target.alive) battle.applyStatus(target, 'fear', { duration: num(b1.fear), source: unit });
            },
          },
        },
        [S2]: {
          kind: 'duration', duration: guardDuration, trigger: 'NEVER', attack: { noAttack: true },
          onStart({ battle, unit }) {
            const st = state(battle, unit);
            const guard = st.guard = { start: battle.time, until: battle.time + guardDuration, target: st.counterSource, seq: unit.deploySeq, struck: false };
            st.counterSource = null;
            // BuffToOwnerOnEvent: ON_CAST_START. The counter's ON_SPELL_ON therefore sees this stack too.
            addStack(battle, unit);
            battle.fx('oxiGuard', { id: unit.id, x: unit.x, y: unit.y, dur: guardDuration });
            // Damage is delayed to the original OnAttack frame, including when the triggering hit was dodged.
            battle.after(COUNTER_FRAME, () => counter(battle, unit, guard), { owner: unit });
          },
        },
        [S3]: {
          kind: 'duration', mods: { atkPct: num(b3.atk) }, attack: { noAttack: true },
          onStart({ battle, unit }) {
            const st = state(battle, unit);
            st.channel = { start: battle.time, next: battle.time, overload: false };
            emitWave(battle, unit, st, false);
            st.channel.next += num(b3.normal_interval, 2.67);
          },
          onTick({ battle, unit, skill }) {
            const st = state(battle, unit), channel = st.channel;
            if (!channel || !up(unit)) return;
            if (!unit.canAct) { skill.stop(); return; }
            const overload = battle.time - channel.start >= skill.duration / 2 - EPS;
            if (overload && !channel.overload) {
              channel.overload = true;
              channel.next = battle.time;
              battle.fx('overload', { id: unit.id, x: unit.x, y: unit.y, skill: S3 });
            }
            if (battle.time + EPS >= channel.next) {
              emitWave(battle, unit, st, overload);
              channel.next += num(overload ? b3.overload_interval : b3.normal_interval, overload ? 2 : 2.67);
            }
          },
          onEnd({ battle, unit }) { state(battle, unit).channel = null; },
        },
      },
      install(battle, unit) {
        const st = state(battle, unit);
        battle.on('deploy', ({ unit: deployed, move }) => {
          if (deployed !== unit || move) return;
          clearFields(battle, unit, st);
          st.stacks = 0; st.idleUntil = battle.time + num(t1.arcane_idle_delay, 3); st.arcaneAt = battle.time;
          st.channel = null; st.guard = null;
          unit.profile.hitAllBlocked = false;
        }, { owner: unit });
        battle.on('hit', (ctx) => {
          if (ctx.source === unit && up(unit) && (ctx.dmg?.type === 'arts' || ctx.dmg?.type === 'elemental')) ctx.dmg.mul *= 1 + st.stacks * arcaneStep;
          if (ctx.target !== unit || !up(unit) || !ctx.dmg) return;
          const d = ctx.dmg, sk = unit.skill;
          const tags = d.tags ?? [];
          const attack = ctx.source?.side === 'enemy' && !d.sourceless && !isHpLoss(d) && !tags.some((t) => ['dot', 'periodic', 'continuous', 'counter', 'reflect', 'environment'].includes(t));
          if (sk?.id === S2 && sk.ready && !sk.active && unit.canAct && !unit.s.flags.silence && attack && (!st.guard || battle.time >= st.guard.until - EPS)) {
            st.counterSource = ctx.source;
            sk.activate('oxi:receivedAttack');
          }
          const guard = st.guard;
          if (!guard || battle.time >= guard.until - EPS || (d.type !== 'arts' && d.type !== 'phys')) return;
          const elapsed = battle.time - guard.start;
          const protection = num(b2.damage_resistance, 1 - num(b2.damage_remaining_scale, 0.1)) * (elapsed <= guardHold ? 1 : Math.max(0, (guardDuration - elapsed) / Math.max(TICK, guardDuration - guardHold)));
          // Same-name shelter takes the strongest value. Other damage-reduction categories keep their own factor.
          const other = num(unit.findBuff(PROTECT)?.data?.value);
          if (protection > other && other < 1) d.mul *= (1 - protection) / (1 - other);
        }, { owner: unit, priority: 50 });
        battle.on('damaged', (ctx) => {
          if (ctx.source === unit && ctx.target?.side === 'enemy') {
            if (ctx.type === 'arts' && num(t1.ep_damage_ratio) > 0) elementDmg(battle, unit, ctx.target, 'burn', ctx.amount * num(t1.ep_damage_ratio), ['talent', 'oxiBurn']);
            if (ctx.dmg?.tags?.includes('oxiCounter') && ctx.amount > 0 && up(unit)) battle.heal(unit, unit, ctx.amount * num(b2.heal_ratio), { self: true });
          }
        }, { owner: unit });
        battle.on('beforeAttack', (ctx) => {
          if (ctx.attacker !== unit || unit.skill?.id !== S1 || !unit.skill.pending || !ctx.targets.length) return;
          // The isolated Zhajing engine's pre-0.3 enemiesInKeys is the same centre/tile selector.
          const tileSearch = battle.enemiesOnTiles || battle.enemiesInKeys;
          ctx.targets = tileSearch.call(battle, [tileKeyOf(ctx.targets[0])], unit, GROUND);
        }, { owner: unit });
        battle.on('attack', (ctx) => {
          if (ctx.attacker !== unit) return;
          st.stacks = Math.max(0, st.stacks - 1);
          st.idleUntil = battle.time + num(t1.arcane_idle_delay, 3);
        }, { owner: unit });
        battle.on('elementBurst', ({ target, element }) => {
          if (element !== 'burn' || !up(unit) || !(fieldDuration > 0) || !(fieldCapacity > 0) || target?.side !== 'enemy') return;
          st.trails.set(target.id, { enemy: target, until: battle.time + num(t2.duration, 5), next: battle.time + fieldIv, tile: tileKeyOf(target) });
          lease(battle, unit, st, target);
        }, { owner: unit });
        battle.on('tick', ({ dt }) => {
          tickWaves(battle, unit, st, dt);
          if (!up(unit)) { if (st.tiles.size || st.trails.size) clearFields(battle, unit, st); return; }
          if (arcaneCap > 0 && battle.time + EPS >= st.arcaneAt + num(t1.arcane_step_interval, 0.5)) {
            st.arcaneAt = battle.time;
            if (battle.time + EPS >= st.idleUntil) st.stacks = Math.min(arcaneCap, st.stacks + 1);
          }
          for (const [tile, until] of st.tiles) if (battle.time >= until - EPS) {
            st.tiles.delete(tile);
            battle.fx('oxiFireField', { id: unit.id, x: tile % COLS, y: Math.floor(tile / COLS), tile, on: 0 });
          }
          for (const [id, trail] of st.trails) {
            const e = trail.enemy;
            if (!e.alive || !e.deployed || battle.time >= trail.until - EPS) { st.trails.delete(id); continue; }
            const key = tileKeyOf(e);
            if (key !== trail.tile || battle.time + EPS >= trail.next) {
              lease(battle, unit, st, e); trail.tile = key; trail.next = battle.time + fieldIv;
            }
          }
          if (!st.tiles.size) return;
          const keys = [...st.tiles.keys()];
          for (const e of battle.enemiesOnTiles(keys, unit, GROUND)) {
            battle.addBuff(e, {
              key: `oxi:field:${unit.id}`, source: unit, refresh: 'extend', duration: fieldIv * num(t2.fire_field_damage_lifetime_ratio, 2), interval: fieldIv,
              tags: ['talent'],
              onTick({ battle, unit: enemy }) {
                if (!up(unit) || !bodyInKeys(enemy, st.tiles) || !canTargetEnemy(unit, enemy, GROUND)) return;
                battle.dealDamage(unit, enemy, { amount: unit.s.atk * num(t2.field_atk_scale), type: 'arts', tags: ['talent', 'dot', 'oxiField'] });
              },
            });
          }
        }, { owner: unit });
      },
    };
  },
};
