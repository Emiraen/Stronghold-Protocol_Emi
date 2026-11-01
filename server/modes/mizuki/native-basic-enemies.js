// Original enemy mechanisms missing from the automatic-mode registry.
import { T, nthOf, setForm, castSlot } from '../../sim/content/enemies.js';
import { nthAttackStatus, refraction, setFloat } from '../../sim/content/enemies/archetypes.js';

const coldMage = (ab) => {
  const s = ab.sk.coldattack;
  return [{ spawn(_b, _e, _a, runtime) { runtime.atkType = 'arts'; } },
    ...(s ? [nthAttackStatus(nthOf(s), 'cold', s.bb.freeze, false, s)] : [])];
};
const frozenPower = () => [{ hitOut(c, _b, _e, _a, ab) {
  if (c.dmg.isAttack && c.target?.s.flags.freeze) c.dmg.amount *= T(ab, 'atkup.atk_scale') ?? 1;
} }];
const blockedDefense = {
  sync(b, e, ab) {
    const active = !!e.blockedBy && !e.s.flags.silence;
    const key = 'mizuki:ccsbr:def';
    if (active) b.addBuff(e, { key, mods: { defFlat: T(ab, 'Def.def') ?? 0 }, refresh: 'replace' });
    else b.removeBuff(e, key);
  },
};
function nativeRefraction(ab) {
  const r = refraction(T(ab, 'refracting.magic_resistance') ?? 0);
  return [r, {
    spawn(b, e, _a, runtime) { runtime.atkType = 'phys'; e.profile.canTarget = (u) => !u.isFlying; r.tick(b, e, r); },
    status(_c, b, e) { r.tick(b, e, r); },
    hitIn(_c, b, e) { r.tick(b, e, r); },
  }];
}
function nativeHover(ab) {
  const ground = (b, e, a) => {
    if (a.grounded || !(e.s.flags.stun || e.s.flags.groundbind)) return;
    a.grounded = true; setFloat(b, e, false); e.profile.melee = true;
    // Native enemy_durokt[fly] removal switches to mode 1 (Normal),
    // restores WALK and creates its own original 0.5-second stun.
    b.applyStatus(e, 'stun', { duration: .5, source: e });
    castSlot(b, e, ab.sk.RecoverAnim); setForm(b, e, 'ground');
  };
  return [...nativeRefraction(ab), {
    spawn(b, e) { setFloat(b, e, true); e.profile.melee = false; },
    status(_c, b, e, a) { ground(b, e, a); },
    tick(b, e, a) { ground(b, e, a); },
  }];
}
export const MIZUKI_BASIC_KITS = {
  enemy_1167_dubow_2: nativeRefraction,
  enemy_1171_durokt: nativeHover,
  enemy_1171_durokt_2: nativeHover,
  enemy_1064_snsbr: frozenPower,
  enemy_1066_snbow_2: frozenPower,
  enemy_1065_snwolf: frozenPower,
  enemy_1068_snmage: coldMage,
  enemy_1068_snmage_2: coldMage,
  enemy_1049_eagent: () => [{
    dealt(c, b, e, _a, ab) {
      if (!c.target?.alive) return;
      b.addBuff(c.target, { key: 'mizuki:eagent:blockdown', source: e,
        duration: T(ab, 'ReduceBlockCnt.duration'),
        mods: { blockCnt: T(ab, 'ReduceBlockCnt.block_cnt') ?? 0 }, refresh: 'replace', visible: true });
    },
  }],
  enemy_1093_ccsbr_2: () => [{
    tick(b, e, _a, _dt) { blockedDefense.sync(b, e, e.mem.ab); },
    hitIn(_c, b, e, _a, ab) { blockedDefense.sync(b, e, ab); },
    blocked(_c, b, e, _a, ab) { blockedDefense.sync(b, e, ab); },
  }],
};
