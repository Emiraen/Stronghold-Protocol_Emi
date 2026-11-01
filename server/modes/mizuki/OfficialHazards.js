// Mode-local original CastTile/UniformRandomTrigger and projectile_ballis.
// Geometry/timing: facility-range-classes.json, crossbow-projectile.json and
// volcano-coroutine-disassembly.txt in the local source evidence directory.
import { ALLY_COLLIDER_RADIUS, ENEMY_COLLIDER_RADIUS } from '../../sim/constants.js';
import { DIR_VEC } from '../../sim/dir.js';
import { bodyDist } from '../../sim/body.js';

const active = (u) => u.alive && u.deployed && !u.hidden;
const defaultCategory = (u) => u.kind !== 'device' || u._mizukiSourceCategory === 1;
const selectable = (u) => active(u) && defaultCategory(u)
  && !u.s.flags.untargetable && !u.s.flags.stealth && !u.s.flags.camou;
const emitEffect = (b, key, x, y, extra = {}) => b.fx('mizuki:effect', { key, x, y, ...extra });

export function installOfficialVolcano(battle, level) {
  const original = level.mapData?.map || [], vents = [];
  for (let r = 0; r < original.length; r++) for (let c = 0; c < original[r].length; c++) {
    const tile = level.mapData.tiles[original[original.length - 1 - r][c]];
    if (tile?.tileKey !== 'tile_volcano') continue;
    const bb = Object.fromEntries(tile.blackboard.map((v) => [v.key, v.value]));
    vents.push({ row: r, col: c, bb, casts: 0, next: null });
  }
  function schedule(vent) {
    // The original coroutine samples cd_min..cd_max before EVERY eruption,
    // including its first cast; it never erupts immediately at battle start.
    const wait = battle.rng.range(vent.bb.cd_min, Math.max(vent.bb.cd_min, vent.bb.cd_max));
    vent.next = battle.time + wait;
    battle.after(wait, () => {
      if (battle.finished) return;
      vent.casts++;
      emitEffect(battle, 'map_eruption_03', vent.col, vent.row);
      for (const unit of battle.units) {
        if (!selectable(unit) || unit.isFlying) continue;
        // CastTile's main collider is radius 1.71. Its enemy-only extra
        // PhysicsRange narrows hostile targets to the original 0.71 circle.
        const radius = unit.side === 'enemy' ? 0.7099999785423279 + ENEMY_COLLIDER_RADIUS
          : 1.7100000381469727 + ALLY_COLLIDER_RADIUS;
        if (bodyDist(unit, vent.col, vent.row) > radius + 1e-9) continue;
        battle.dealDamage(null, unit, { type: 'true', amount: vent.bb.damage,
          sourceless: true, canDodge: false, tags: ['mizuki:volcano'] });
        emitEffect(battle, 'common_firemagic_hit_01', unit.x, unit.y, { unitId: unit.id });
      }
      schedule(vent);
    });
  }
  battle.on('battleStart', () => { for (const vent of vents) schedule(vent); });
  return { snapshot: () => vents.map(({ row, col, casts, next }) => ({ row, col, casts, next })) };
}

export function installOfficialBallista(battle, unit, def, skillFor) {
  battle.addBuff(unit, { key: 'ballis_effect', persist: true,
    flags: { invulnerable: true, untargetable: true } });
  const shots = new Set();
  const fire = () => {
    const [dr, dc] = DIR_VEC[unit.dir];
    const rect = battle.rect;
    const length = dc > 0 ? rect.c1 + 0.5 - unit.x : dc < 0 ? unit.x - rect.c0 + 0.5
      : dr > 0 ? rect.r1 + 0.5 - unit.y : unit.y - rect.r0 + 0.5;
    const to = { x: unit.x + dc * length, y: unit.y + dr * length };
    const projectile = battle.addProjectile({ from: unit, to, source: unit,
      speed: 10, maxAge: 60, visual: 'projectile_ballis' });
    shots.add({ projectile, dr, dc, oldX: unit.x, oldY: unit.y, length });
    emitEffect(battle, 'bolt_attack_01_trail', unit.x, unit.y,
      { unitId: unit.id, dir: unit.dir, to, speed: 10 });
  };
  skillFor(unit, def, fire, { delay: 0.16699999570846558 });
  battle.on('tick', () => {
    for (const shot of shots) {
      const p = shot.projectile, sx = shot.oldX, sy = shot.oldY;
      const dx = p.x - sx, dy = p.y - sy, lengthSq = dx * dx + dy * dy;
      let first = null, firstT = Infinity;
      for (const target of battle.allyUnits) {
        if (!selectable(target) || target._mizukiSourceSide === 2) continue;
        const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((target.x - sx) * dx + (target.y - sy) * dy) / lengthSq)) : 0;
        if (bodyDist(target, sx + dx * t, sy + dy * t) > 0.5 + ALLY_COLLIDER_RADIUS + 1e-9) continue;
        if (t < firstT || (t === firstT && target.id < first.id)) { first = target; firstT = t; }
      }
      if (first) {
        battle.dealDamage(unit, first, { type: 'phys', amount: unit.s.atk * def.bb.atk_scale,
          canDodge: true, tags: ['attack', 'mizuki:ballista'] });
        emitEffect(battle, 'bolt_attack_01_hit', first.x, first.y, { unitId: first.id });
        battle.projectiles.list = battle.projectiles.list.filter((p2) => p2 !== p);
        shots.delete(shot);
      } else if (!battle.projectiles.list.includes(p)) shots.delete(shot);
      else { shot.oldX = p.x; shot.oldY = p.y; }
    }
  });
  return { snapshot: () => [...shots].map(({ projectile: p }) => ({ id: p.id, x: p.x, y: p.y, tx: p.tx, ty: p.ty })) };
}
