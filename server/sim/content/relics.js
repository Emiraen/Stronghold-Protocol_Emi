// server/sim/content/relics.js — 湮灭模拟 · 藏品, battle half.
//
// The match computes each player's relicMods (PlayerRound.battleInput: ally / allyElite / enemy / enemyElite / enemyBoss
// fractions, the counts, and the "rules" code below handles) from data/relics.json + the player's counters. This module
// only applies them through the public Battle API, so the client's re-simulation (the same file is served at /sim/) agrees.
//
// Ally atk/def/hp are percentages (atkPct / defPct / hpPct); enemy stats are *Mul buffs added at spawn; ASPD is additive;
// damage dealt / taken are *Mul.

import { passiveBuff, isElite, playerOps } from './support/index.js';
import { tileKeyOf } from '../targeting.js';

const rankOf = (e) => String((e && e.def && e.def.rank) || 'NORMAL').toUpperCase();
const isRanged = (u) => !!(u && u.def && u.def.position === 'RANGED');

function baseBuffMods(m) {
  const out = {};
  if (m.atk) out.atkPct = m.atk;
  if (m.def) out.defPct = m.def;
  if (m.hp) out.hpPct = m.hp;
  if (m.aspd) out.aspd = m.aspd;
  if (m.resFlat) out.resFlat = m.resFlat;
  if (m.dmgDealt) out.dmgDealtMul = 1 + m.dmgDealt;
  if (m.spRegen) out.spRecoveryMul = Math.max(0, 1 + m.spRegen);
  return out;
}

function enemyBuffMods(e) {
  const out = {};
  if (e.atk) out.atkMul = 1 + e.atk;
  if (e.def) out.defMul = 1 + e.def;
  if (e.hp) out.hpMul = 1 + e.hp;
  if (e.aspd) out.aspd = e.aspd;
  if (e.res) out.resMul = 1 + e.res;
  if (e.move) out.moveMul = 1 + e.move;
  return out;
}

export function install(battle) {
  const entries = [];
  for (const ps of battle.players || []) {
    const mods = ps && ps.input && ps.input.relicMods;
    if (mods) entries.push({ ps, pid: ps.playerId, mods });
  }
  if (!entries.length) return;
  // Team relics are shared: enemy modifiers apply once, ally modifiers per owner.
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    setupPlayer(battle, e.ps, e.pid, e.mods, i === 0);
  }
}

function setupPlayer(battle, ps, pid, mods, enemyEffects) {
  const ally = mods.ally || {};
  const elite = mods.allyElite || {};
  const rules = mods.rules || {};
  const key = (suffix) => 'relic:' + pid + ':' + suffix;
  const base = baseBuffMods(ally);
  const eliteMods = baseBuffMods(elite);
  const hasBase = Object.keys(base).length > 0;
  const hasElite = Object.keys(eliteMods).length > 0;
  const st = { fog: new Map(), ramp: 0, dpHp: false, spStacks: new Map(), initialStun: false };

  const ops = () => playerOps(battle, pid);

  const addBase = (u) => {
    if (!u || u.kind !== 'op' || u.ownerId !== pid) return;
    if (hasBase) passiveBuff(battle, u, key('base'), base);
    if (hasElite && isElite(u)) passiveBuff(battle, u, key('elite'), eliteMods);
    if (st.dpHp) passiveBuff(battle, u, key('dp-hp'), { hpPct: rules.hpIfDp.hp || 1.5 });
    // 迷彩 is a buff FLAG (buffs.js FLAG_KEYS), not a numeric mod: aggregateMods drops a boolean out of `mods`, so it has
    // to go through addBuff's `flags` — otherwise ranged enemies keep selecting the operator regardless (targeting.js
    // canTargetAlly reads s.flags.camou).
    if (rules.camoRanged && isRanged(u)) passiveBuff(battle, u, key('camo'), null, { flags: { camou: true } });
  };

  // 犬植浆: allies inside an operator's attack range get camo + 10% atk, stacking per covering operator
  if (rules.camoAura) {
    const per = Number.isFinite(rules.camoAura.atk) ? rules.camoAura.atk : 0.1;
    const apply = () => {
      const list = (playerOps(battle, pid) || []).filter((x) => x && x.alive && x.deployed);
      for (const x of list) {
        let n = 0;
        for (const v of list) if (v !== x && v.rangeKeySet && v.rangeKeySet.has(tileKeyOf(x))) n++;
        // the stacks are per covering operator: a withdrawn / killed one drops its share (deploy and death re-run this)
        if (n > 0) passiveBuff(battle, x, key('camo-aura'), { atkPct: per * n }, { flags: { camou: true } });
        else battle.removeBuff(x, key('camo-aura'));
      }
    };
    battle.on('deploy', apply);
    battle.on('death', (ctx) => { if (!ctx || !ctx.unit || ctx.unit.side !== 'enemy') apply(); });
    apply();
  }

  const neighborhood = (u) => {
    let n = 0;
    for (const off of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const r = u.tileR + off[0], c = u.tileC + off[1];
      for (const a of battle.allyUnits) if (a && a.alive && a.deployed && a.kind !== 'device' && a.tileR === r && a.tileC === c && a.ownerId === pid) { n++; break; }
    }
    return n;
  };

  const applyAuras = (u) => {
    if (!u || u.kind !== 'op' || u.ownerId !== pid) return;
    const n = neighborhood(u);
    if (Number.isFinite(rules.atkPerNeighbor)) passiveBuff(battle, u, key('neighbor-atk'), { atkPct: rules.atkPerNeighbor * n });
    if (Number.isFinite(rules.aspdPerNeighbor)) passiveBuff(battle, u, key('neighbor-aspd'), { aspd: rules.aspdPerNeighbor * n });
  };

  const syncShelter = (u) => {
    if (!u || u.kind !== 'op' || u.ownerId !== pid || !rules.shelter) return;
    const s = rules.shelter;
    const low = s.low > 0 && u.hp < (u.s.maxHp || 0) * (s.threshold || 0.5);
    passiveBuff(battle, u, key('shelter'), { dmgTakenMul: 1 - (low ? s.low : s.base) });
  };

  battle.on('battleStart', () => {
    for (const u of ops()) {
      addBase(u);
      applyAuras(u);
      syncShelter(u);
    }
    if (rules.survivor) {
      const list = ops().filter((u) => u.alive && u.deployed);
      let best = null;
      for (const u of list) if (!best || (u.s.atk || 0) > (best.s.atk || 0)) best = u;
      if (best) {
        const n = 1 + Math.max(0, rules.survivor.stacks || 0);
        passiveBuff(battle, best, key('survivor'), { atkPct: (rules.survivor.per || 0.2) * n, defPct: (rules.survivor.per || 0.2) * n });
      }
    }
    if (rules.startDebuff) {
      const sb = rules.startDebuff;
      for (const u of ops()) {
        if (!u.alive || !u.deployed) continue;
        const m = {};
        if (sb.atkPct) m.atkMul = 1 + sb.atkPct;
        if (sb.aspd) m.aspd = sb.aspd;
        if (sb.spRegen) m.spRecoveryMul = Math.max(0, 1 + sb.spRegen);
        battle.addBuff(u, { key: key('startdebuff'), mods: m, duration: sb.dur || 10 });
      }
    }
    if (rules.openingDebuff && rules.openingDebuff.count > 0) {
      const list = ops().filter((u) => u.alive && u.deployed);
      const n = Math.min(list.length, rules.openingDebuff.count);
      const picks = battle.rng.shuffle(list.slice()).slice(0, n);
      const kinds = ['stun', 'freeze', 'neural', 'erosion'];
      picks.forEach((u, i) => {
        const k = kinds[i % kinds.length];
        if (k === 'stun') battle.applyStatus(u, 'stun', { duration: 10 });
        else if (k === 'freeze') battle.applyStatus(u, 'freeze', { duration: 10 });
        else battle.dealDamage(null, u, { amount: 1000, type: 'element', element: k, canDodge: false, sourceless: true, tags: ['dot', 'relic'] });
      });
    }
    if (rules.neuralDps > 0) {
      battle.every(1, () => {
        if (battle.finished) return;
        for (const u of ops()) {
          if (!u.alive || !u.deployed) continue;
          battle.dealDamage(null, u, { amount: rules.neuralDps, type: 'element', element: 'neural', canDodge: false, sourceless: true, tags: ['dot', 'periodic', 'relic'] });
        }
      }, { immediate: false });
    }
  }, { priority: -20 });

  battle.on('deploy', (ctx) => {
    const u = ctx && ctx.unit;
    if (!u || u.kind !== 'op' || u.ownerId !== pid) return;
    addBase(u);
    applyAuras(u);
    syncShelter(u);
    if (rules.spOnDeploy && u.skill) u.skill.sp = Math.max(0, (u.skill.sp || 0) + rules.spOnDeploy);
    if (rules.spInit && u.skill) u.skill.sp = Math.max(0, (u.skill.sp || 0) + rules.spInit);
    if (rules.stunOnDeploy) {
      const r = rules.stunOnDeploy;
      if (ctx.initial && !st.initialStun) {
        st.initialStun = true;
        battle.after(1.25, () => {
          if (battle.finished) return;
          const count = Math.max(1, Math.min(r.max || 4, (r.count || 1) + Math.max(0, (battle.round || 1) - (r.fromRound || 1)) * (r.perRound || 0)));
          const all = ops().filter(x => x.alive && x.deployed);
          const room = Math.max(0, count - all.filter(x => x.s.flags?.stun).length);
          const picks = battle.rng.shuffle(all.filter(x => !x.s.flags?.stun)).slice(0, room);
          for (const x of picks) battle.applyStatus(x, 'stun', {duration:r.dur || 10});
        });
      } else if (!ctx.initial && !ctx.move) {
        const seq = u.deploySeq;
        battle.after(1.25, () => {
          if (!battle.finished && u.alive && u.deployed && u.deploySeq === seq)
            battle.applyStatus(u, 'stun', {duration:r.redeployDur ?? 5});
        });
      }
    }
    if (rules.fogOnDeploy) st.fog.set(u.uid, battle.time + (rules.fogOnDeploy.dur || 60));
  }, { priority: 40 });

  battle.every(1, () => {
    if (battle.finished) return;
    if (rules.fogOnDeploy) {
      const ratio = rules.fogOnDeploy.ratio || 0.02;
      for (const u of ops()) {
        const until = st.fog.get(u.uid);
        if (!until || battle.time > until) { if (until) st.fog.delete(u.uid); continue; }
        if (!u.alive || !u.deployed) continue;
        const amount = (u.s.maxHp || 0) * ratio;
        if (amount > 0) battle.dealDamage(null, u, { amount, type: 'true', canDodge: false, sourceless: true, noSp: true, tags: ['dot', 'periodic', 'relic'] });
      }
    }
    if (rules.hpIfDp && !st.dpHp) {
      const pp = battle.getPlayer(pid);
      if (pp && Number(pp.dp) >= (rules.hpIfDp.dp || 50)) {
        st.dpHp = true;
        for (const u of ops()) if (u.alive) passiveBuff(battle, u, key('dp-hp'), { hpPct: rules.hpIfDp.hp || 1.5 });
      }
    }
  }, { immediate: false });

  battle.on('enemySpawn', (ctx) => {
    const e = ctx && ctx.enemy;
    if (!enemyEffects || !e || !e.alive) return;
    const all = mods.enemy || {};
    const rank = rankOf(e);
    const add = (m, suffix) => { const b = enemyBuffMods(m); if (Object.keys(b).length) battle.addBuff(e, { key: key(suffix), mods: b, persist: true, refresh: 'replace' }); };
    add(all, 'enemy');
    if (rank === 'ELITE') add(mods.enemyElite || {}, 'enemy-elite');
    if (rank === 'BOSS') add(mods.enemyBoss || {}, 'enemy-boss');
    if (rules.enemyDmgTaken) passiveBuff(battle, e, key('dmg-taken'), { physTakenMul: 1 - rules.enemyDmgTaken.phys, artsTakenMul: 1 - rules.enemyDmgTaken.arts });
    if (rules.spawnHpChance && battle.rng && battle.rng() < rules.spawnHpChance.p) passiveBuff(battle, e, key('spawn-hp'), { hpMul: 1 + rules.spawnHpChance.extra });
    if (rules.eliteDmgReduce && (rank === 'ELITE' || rank === 'BOSS')) {
      battle.addBuff(e, { key: key('elite-reduce'), mods: { physTakenMul: rules.eliteDmgReduce.mul, artsTakenMul: rules.eliteDmgReduce.mul }, duration: rules.eliteDmgReduce.dur || 30 });
    }
    if (rules.enemyDefShred) passiveBuff(battle, e, key('godu'), { defFlat: rules.enemyDefShred.flat });
    for (let i = 0; i < st.ramp; i++) battle.addBuff(e, { key: key('ramp' + i), mods: { atkMul: 1 + rules.enemyRamp.step, hpMul: 1 + rules.enemyRamp.step, defMul: 1 + rules.enemyRamp.step, resMul: 1 + rules.enemyRamp.step }, persist: true });
  }, { priority: 50 });

  battle.on('damaged', (ctx) => {
    const t = ctx && ctx.target;
    if (!t) return;
    if (t.side === 'ally' && t.kind === 'op' && t.ownerId === pid && rules.shelter) syncShelter(t);
    if (enemyEffects && t.side === 'enemy' && ctx.amount > 0 && rules.enemyDefShred) {
      const mem = t.mem || (t.mem = {});
      const n = Math.min(rules.enemyDefShred.max, (mem.relicGoduHits || 0) + 1);
      if (n !== mem.relicGoduHits) {
        mem.relicGoduHits = n;
        const left = Math.max(0, rules.enemyDefShred.flat + rules.enemyDefShred.perHit * n);
        passiveBuff(battle, t, key('godu'), { defFlat: left });
      }
    }
  }, { priority: 60 });

  if (enemyEffects && rules.enemyRamp) {
    battle.every(rules.enemyRamp.every || 10, () => {
      if (battle.finished) return;
      if (st.ramp >= (rules.enemyRamp.max || 0.5) / (rules.enemyRamp.step || 0.1)) return;
      st.ramp++;
      for (const e of battle.enemies) {
        if (!e || !e.alive) continue;
        battle.addBuff(e, { key: key('ramp' + (st.ramp - 1)), mods: { atkMul: 1 + rules.enemyRamp.step, hpMul: 1 + rules.enemyRamp.step, defMul: 1 + rules.enemyRamp.step, resMul: 1 + rules.enemyRamp.step }, persist: true });
      }
    }, { immediate: false });
  }

  if (rules.atkAfterSkill) {
    battle.on('skillStart', (ctx) => {
      const u = ctx && ctx.unit;
      if (!u || u.kind !== 'op' || u.ownerId !== pid) return;
      battle.addBuff(u, { key: key('skill-atk'), mods: { atkPct: (rules.atkAfterSkill.mul || 1.04) - 1 }, duration: rules.atkAfterSkill.window || 1, refresh: 'replace' });
    });
  }

  if (rules.spRegenStack) {
    battle.on('skillStart', (ctx) => {
      const u = ctx && ctx.unit;
      if (!u || u.kind !== 'op' || u.ownerId !== pid) return;
      const n = Math.min(rules.spRegenStack.max || 5, (st.spStacks.get(u.uid) || 0) + 1);
      st.spStacks.set(u.uid, n);
      passiveBuff(battle, u, key('sp-stack'), { spRecoveryFlat: (rules.spRegenStack.per || 0.4) * n });
    });
  }

  if (rules.statusDuration) {
    battle.on('beforeStatus', (ctx) => {
      if (!ctx || !ctx.target || ctx.target.side !== 'enemy') return;
      const src = ctx.source;
      if (!src || src.ownerId !== pid) return;
      if (['stun', 'cold', 'freeze', 'sleep', 'fear', 'levitate'].indexOf(ctx.status) < 0) return;
      if (Number.isFinite(ctx.duration)) ctx.duration *= 1 + rules.statusDuration;
    });
  }

  if (rules.shelterOnDebuff) {
    let fired = false;
    battle.on('statusApplied', (ctx) => {
      if (fired || !ctx || ctx.target.side !== 'ally' || ctx.target.ownerId !== pid) return;
      if (['stun', 'freeze', 'cold', 'sleep', 'fear', 'silence', 'disarm'].indexOf(ctx.status) < 0) return;
      fired = true;
      const m = { dmgTakenMul: 1 - rules.shelterOnDebuff.mul, resIgnorePct: rules.shelterOnDebuff.ignore, defIgnorePct: rules.shelterOnDebuff.ignore };
      for (const u of ops()) passiveBuff(battle, u, key('gene-shelter'), m);
    });
  }
}

// ---- prep side: income / prices / counters (registered as global:annihilation_relics; the match sets ps.relics) ----

export function registerMeta(registry) {
  registry.global('annihilation_relics', {
    onIncome(ctx, ev) {
      const state = ctx.relics ? ctx.relics() : null;
      const d = ctx.data && ctx.data.relics;
      if (!state || !d || !ev) return;
      let add = 0;
      for (const id of state.owned || []) {
        const def = d.relics[id];
        if (def && def.fx && Number.isFinite(def.fx.income)) add += def.fx.income;
        if (def?.fx?.rule?.id === 'kingCrystal' && Number.isFinite(def.fx.rule.income)) add += def.fx.rule.income;
      }
      if (add) ev.income = Math.max(0, (Number(ev.income) || 0) + add);
    },
    // 无限续杯瓶 / 迷幻的藏宝图: 完成一次决策（选择一张卡）时资金额外 +1 / +2
    onChoicePick(ctx, ev) {
      const state = ctx.relics ? ctx.relics() : null;
      const d = ctx.data && ctx.data.relics;
      if (!state || !d) return;
      let add = 0;
      for (const id of state.owned || []) {
        const def = d.relics[id];
        if (def && def.fx && Number.isFinite(def.fx.choiceIncome)) add += def.fx.choiceIncome;
        if (!ev?.forTeammate && def?.fx?.rule?.id === 'choiceFunds' && Number.isFinite(def.fx.rule.n)) add += def.fx.rule.n;
      }
      if (add) ctx.addFunds(add, 'relic-choice');
    },
    onRefresh(ctx, ev) {
      const state = ctx.relics ? ctx.relics() : null;
      if (state && ev && ev.free !== true) state.counters.paidRefreshes = (state.counters.paidRefreshes || 0) + 1;
    },
    onBuy(ctx, ev) {
      const state = ctx.relics ? ctx.relics() : null;
      if (!state || !ev || !ev.slot) return;
      const rec = ev.slot.kind === 'chess' ? ctx.gd.chess(ev.slot.id) : null;
      if (rec) state.counters.chessBuys = (state.counters.chessBuys || 0) + 1;
      if (ev.slot.kind === 'item' && ev.piece) {
        ev.piece.meta.annihilationPaid = (Number(ev.piece.meta.annihilationPaid) || 0) + Math.max(0, Number(ev.price) || 0);
      }
      if (rec && Number.isInteger(rec.tier) && rec.tier >= 4) {
        state.counters.tier4Buys = (state.counters.tier4Buys || 0) + 1;
        if (state.owned.includes('p36') && !rec.isGolden && ctx.gd.chess(ev.piece?.id)?.isGolden)
          state.counters.eliteMerges = Math.min(4, (state.counters.eliteMerges || 0) + 1);
      }
    },
    onBattleResult(ctx, ev) {
      const state = ctx.relics ? ctx.relics() : null;
      if (!state) return;
      const waves = ev?.uniteResults || (ev?.unite ? [ev.unite] : []);
      const bountyKills = Math.max(0, Number(ev?.result?.bountyKills) || 0) + waves.reduce((sum, wave) => sum + Math.max(0, Number(wave.perPlayer?.[ctx.playerId]?.bountyKills) || 0), 0);
      state.counters.bountyDone = (state.counters.bountyDone || 0) + bountyKills;
      state.counters.bountyKills = (state.counters.bountyKills || 0) + bountyKills;
      if (bountyKills > 0 && state.owned.includes('p34')) state.counters.atkRoundStacks = Math.min(10, (state.counters.atkRoundStacks || 0) + 1);
      if (ev && ev.perfect) {
        state.counters.perfects = (state.counters.perfects || 0) + 1;
      }
      if (!ev?.boss && !ev?.result?.synthetic && state.owned.includes('p12')) state.counters.survivorStacks = (state.counters.survivorStacks || 0) + 1;
    },
  });
}
