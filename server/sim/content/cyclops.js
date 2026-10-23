import { hypot } from '../detmath.js';
// 舟铲铲馈赠：只消费显式 cyclops 玩家输入，全部事件按玩家隔离。
import * as S from './support/index.js';

const BONDS = { victoria: 'victoriaShip', sargon: 'sargonShip', yan: 'yanShip', kjerag: 'kjeragShip', laterano: 'lateranoShip', egir: 'egirShip', siracusa: 'siracusaShip', kazimierz: 'kazimierzShip' };
const normal = d => d && !d.tags?.includes('cyclops') && !d.tags?.includes('hpLoss') && d.type !== 'element';
const onField = u => u?.alive && u.deployed && !u.removed;
const rank = u => String(u?.def?.rank || (u?.isBoss ? 'BOSS' : 'NORMAL')).toUpperCase();
const special = u => rank(u) === 'ELITE' || rank(u) === 'BOSS' || u?.isBoss;
// Normal and elite equipment share a baseId; each basic item has one distinct gift effect.
const hasBaseItem = (u, baseId) => S.itemsOf(u).some(id => (S.itemRecord(id)?.baseId || id) === baseId);

export function install(b) {
  for (const ps of b.players) S.isolateContentCallback(b, () => {
    if (!ps.input?.cyclops) return;
    const pid = ps.playerId;
    const refs = [];
    for (const e of ps.playerEffects) S.isolateContentCallback(b, () => {
      if (e.data?.tacticKind === 'cyclops') refs.push(e);
    }, 'cyclops:reference');
    if (!refs.length) return;
    const installedSiracusa = [];
    const ops = () => b.allyUnits.filter(u => u.ownerId === pid && u.kind === 'op');
    const enemies = () => b.enemies.filter(e => onField(e) && (e.ownerId === pid || b.players.length === 1));
    const own = u => u?.side === 'ally' && u.ownerId === pid;
    const member = (u, fam) => own(u) && u.kind === 'op' && S.isMember(b, u, BONDS[fam]);
    const hurt = (u, t, amount, type = 'true') => {
      if (onField(t) && t.hp > 0 && amount > 0) b.dealDamage(u, t, { amount, type, canDodge: false, tags: ['cyclops', 'addition'] });
    };
    const save = (id, delta = 1) => {
      const pp = b._pp(pid);
      pp.cyclopsKills ||= {};
      pp.cyclopsKills[id] = (pp.cyclopsKills[id] || 0) + delta;
    };
    for (const ref of refs) S.isolateContentCallback(b, () => {
      const fam = ref.data.family, q = ref.data.quality;
      const gold = q === 'gold', prism = q === 'prismatic', silver = q === 'silver';
      const p = ref.params || (ref.params = {});
      const bond = BONDS[fam];
      const L = () => bond ? S.bondLayers(b, pid, bond) : 0;
      // Only gift scaling is capped; the original bond and its unlock thresholds use real layers.
      const N = () => Math.min(silver ? 40 : gold ? 80 : 120, Math.max(0, L()));
      const key = `hex:${ref.id}`;
      let kills = Math.min(fam === 'egir' ? 15 : 12, Math.max(0, p.kills || 0)), deaths = 0;
      let skillLayers = 0, teamSpAt = -Infinity, bountyCoins = 0;
      const killSpAt = new Map(), savedUnits = new Set(), bountyVictims = new Set();
      const members = () => {
        const out = [];
        for (const u of ops()) S.isolateContentCallback(b, () => { if (member(u, fam)) out.push(u); }, 'cyclops:member', u);
        return out;
      };
      const casterOf = () => members().find(u => onField(u) && u.hp > 0);
      const sync = () => {
        const n = N();
        for (const u of (fam === 'yan' ? ops() : members())) S.isolateContentCallback(b, () => {
          const mods = {};
          if (fam === 'victoria') {
            const boost = silver && S.itemsOf(u).length ? 1.5 : 1;
            mods.atkPct = n * (silver ? 0.012 * boost : gold ? 0.015 : 0.03);
            mods.aspd = Math.min(180, n * (silver ? 1 * boost : gold ? 1.2 : 2.5));
          } else if (fam === 'sargon') {
            mods.atkPct = n * (silver ? 0.01 : gold ? 0.012 : 0.025);
            mods.aspd = Math.min(180, n * (silver ? 1.5 : gold ? 1.8 : 3.5));
          } else if (fam === 'laterano') {
            mods.spRecoveryMul = silver ? 1 + n * 0.012 : 1;
          } else if (fam === 'egir') {
            mods.atkPct = n * (silver ? 0.015 : gold ? 0.018 : 0.04) + (gold ? kills * 0.015 : 0) + (prism ? deaths * 0.05 : 0);
            if (gold) mods.hpPct = n * 0.012;
          } else if (fam === 'siracusa') {
            if (!silver) mods.atkPct = prism ? n * 0.035 : 0;
            if (gold) mods.aspd = n * 1.2;
            if (prism) { mods.aspd = kills * 6; mods.moveMul = 1 + Math.min(0.6, Math.min(0.3, n * 0.0025) + kills * 0.025); }
          } else if (fam === 'kazimierz') {
            mods.dmgTakenMul = 1 - Math.min(silver ? 0.4 : gold ? 0.55 : 0.7, n * (silver ? 0.01 : gold ? 0.015 : 0.03));
            if (!silver) mods.hpPct = n * (gold ? 0.015 : 0.05);
            if (gold) { mods.defFlat = Math.min(160, n * 2); mods.resFlat = Math.min(30, n * 2); }
          }
          b.addBuff(u, { key, mods, allowDead: true, persist: true });
          if (u.skill) {
            let factor = 1;
            if (fam === 'sargon' && gold && L() >= 180) factor = 0.8;
            if (fam === 'laterano' && gold) factor = 0.75;
            u.mem.hexCd ||= {};
            const old = u.mem.hexCd[key] || 1;
            if (old !== factor) { u.skill.spCostMul = u.skill.spCostMul / old * factor; u.mem.hexCd[key] = factor; }
          }
        }, 'cyclops:sync', u);
        if (fam === 'egir' && prism && deaths) for (const u of ops()) S.isolateContentCallback(b, () => {
          if (!member(u, fam)) b.addBuff(u, { key, mods: { atkPct: deaths * 0.05 }, allowDead: true, persist: true });
        }, 'cyclops:egir:sync', u);
      };
      if (bond) {
        sync();
        b.on('deploy', ({ unit }) => { if (own(unit)) sync(); });
        b.on('layerGain', c => { if (c.playerId === pid && c.bondId === bond) b.after(0, sync); });
      }
      if (fam === 'universal') {
        b.on('layerGain', c => {
          if (c.playerId !== pid || c.bondId !== p.bondId) return;
          const remainderKey = `remainder:${p.bondId}`;
          const extra = c.n * ((p.layerMultiplier || 1) - 1) + (p[remainderKey] || 0);
          const add = Math.floor(extra + 1e-9); p[remainderKey] = extra - add; c.n += add;
        }, { priority: 100 });
      }
      if (fam === 'streak' && prism) {
        const n = Math.min(5, Math.max(0, p.winStacks || 0));
        const apply = u => { if (own(u) && u.kind === 'op') b.addBuff(u, { key, persist: true, allowDead: true, mods: { atkPct: n * 0.03, hpPct: n * 0.03, defPct: n * 0.03, aspd: n * 3, resFlat: n * 0.03 * u.base.res, spRecoveryMul: 1 + n * 0.03, moveMul: 1 + n * 0.03 } }); };
        for (const u of ops()) S.isolateContentCallback(b, () => apply(u), 'cyclops:streak:sync', u);
        b.on('deploy', ({ unit }) => apply(unit));
      }
      if (fam === 'kazimierz') {
        const shield = u => {
          if (!member(u, fam)) return;
          const n = N();
          const ratio = silver ? Math.min(0.6, n * 0.03) : gold ? 0 : Math.min(1.2, n * 0.05);
          if (ratio) b.addBuff(u, { key: `${key}:shield`, shield: u.s.maxHp * ratio });
        };
        b.on('deploy', ({ unit }) => shield(unit), { priority: -200 });
        if (prism) b.on('fatal', c => {
          if (c.prevented || c.dmg?.tags?.includes('hpLoss') || !c.unit?.alive || c.unit.hp > 0 || !own(c.unit)
              || savedUnits.has(c.unit) || !casterOf()) return;
          // This battle's charge belongs to the unit, so retreat and redeployment do not replenish it.
          savedUnits.add(c.unit);
          c.unit.hp = 1; c.prevented = true;
          b.addBuff(c.unit, { key: `${key}:saved`, duration: 2, flags: { invulnerable: true }, visible: true });
        }, { priority: -200 });
      }
      if (fam === 'sargon' && silver) b.on('skillStart', ({ unit }) => {
        if (member(unit, fam) && skillLayers < 10) {
          const gain = Math.min(2, 10 - skillLayers); skillLayers += gain;
          b.addLayers(pid, bond, gain, 'cyclops', { source: unit });
        }
      });
      if (fam === 'kjerag') {
        b.on('beforeStatus', c => {
          if (c.target.side !== 'enemy' || !(c.target.ownerId === pid || b.players.length === 1)) return;
          if (gold && c.status === 'freeze') c.duration += Math.min(2, N() * 0.12);
          if (silver && c.status === 'slow') {
            const base = c.value ?? 0.5;
            c.value = Math.max(base, Math.min(0.75, base + N() * 0.012));
          }
        });
        if (gold) b.every(3, () => {
          const caster = casterOf();
          if (caster) for (const e of enemies()) S.isolateContentCallback(b, () => b.applyStatus(e, 'cold', { duration: 2, source: caster }), 'cyclops:cold', e);
        });
        if (prism) b.on('statusApplied', c => {
          if (c.status !== 'freeze' || !c.entered || !enemies().includes(c.target)) return;
          const frozen = c.target.findBuff('freeze');
          if (!frozen) return;
          const expire = frozen.onExpire;
          frozen.onExpire = ev => {
            expire?.(ev);
            const caster = casterOf();
            if (caster) hurt(caster, c.target, Math.min(c.target.s.maxHp * 0.05, caster.s.atk * 3));
          };
        });
      }
      if (fam === 'yan') b.every(1, () => {
        const n = N(), caster = casterOf();
        if (!caster) return;
        // Snapshot before spreading: newly ignited enemies wait for the next tick and inherit the old expiry.
        const targets = enemies();
        const burning = targets.map(e => [e, e.mem.hexBurn?.[pid] || 0]).filter(([, until]) => until > b.time);
        for (const [e, until] of burning) S.isolateContentCallback(b, () => {
          if (!onField(e) || !(e.hp > 0)) return;
          if (prism && rank(e) !== 'BOSS' && !e.isBoss && e.hp / e.s.maxHp < 0.05) { b.kill(e, caster); return; }
          const ratio = Math.min(silver ? 0.01 : gold ? 0.015 : 0.02, n * (silver ? 0.004 : gold ? 0.008 : 0.006));
          hurt(caster, e, Math.min(e.s.maxHp * ratio, caster.s.atk * (silver ? 1 : gold ? 1.5 : 2)), 'arts');
          if (gold) for (const other of targets) S.isolateContentCallback(b, () => {
            if (onField(other) && hypot(other.x - e.x, other.y - e.y) <= 1.01) {
              other.mem.hexBurn ||= {};
              other.mem.hexBurn[pid] = Math.max(other.mem.hexBurn[pid] || 0, until);
            }
          }, 'cyclops:burn:spread', other);
        }, 'cyclops:burn', e);
      });
      // 伤害前：暴击、法术强度、技能增伤与针对冻结的伤害。
      b.on('hit', c => {
        if (!normal(c.dmg) || !own(c.source) || c.target.side !== 'enemy') return;
        const u = c.source, n = N(), frozen = c.target.s.flags.freeze;
        if (fam === 'yan' && (c.dmg.type === 'arts' || c.dmg.isSkill)) c.dmg.mul *= 1 + Math.min(silver ? 0.4 : gold ? 0.75 : 1.2, n * (silver ? 0.01 : gold ? 0.015 : 0.035));
        if (fam === 'laterano' && member(u, fam)) {
          const arts = c.dmg.type === 'arts' ? 1 + n * (silver ? 0.015 : prism ? 0.04 : 0) : 1;
          const skill = c.dmg.isSkill ? 1 + n * (gold ? 0.02 : prism ? 0.035 : 0) : 1;
          c.dmg.mul *= Math.max(arts, skill) * (prism && c.dmg.isSkill ? 1 + kills * 0.03 : 1);
        }
        if (fam === 'kjerag' && member(u, fam) && frozen) {
          if (silver) c.dmg.mul *= 1 + n * 0.018;
          if ((gold && b.rng() < Math.min(1, n * 0.015)) || prism) c.dmg.mul *= Math.min(3, 1.5 + n * (gold ? 0.025 : 0.05));
        }
        if (fam === 'siracusa' && member(u, fam)) {
          // Each quality is selected independently: gold must grant its own stated attack bonus.
          if (gold && c.dmg.isAttack && !c.dmg.isSkill) c.dmg.mul *= 1 + n * 0.03;
          const chance = installedSiracusa.filter(quality => quality === 'silver').reduce(sum => sum + Math.min(40, L()) * 0.012, 0);
          if (prism || (silver && b.rng() < Math.min(1, chance))) {
            const critBonus = installedSiracusa.reduce((sum, quality) => sum + Math.min(quality === 'silver' ? 40 : quality === 'gold' ? 80 : 120, L()) * (quality === 'silver' ? 0.02 : quality === 'prismatic' ? 0.06 : 0), 0);
            if (!c.dmg.cyclopsCrit) c.dmg.mul *= Math.min(3, 1.5 + critBonus);
            c.dmg.cyclopsCrit = true;
          }
        }
      });
      // 伤害后：吸血、真伤、连锁和基础装备附加效果；附加伤害不递归触发自己。
      b.on('damaged', c => {
        if (!normal(c.dmg) || !(c.amount > 0)) return;
        const u = c.source, t = c.target, n = N();
        if (fam === 'morph' && silver && own(t) && u?.side === 'enemy') {
          if (hasBaseItem(t, 'chess_item_1_02_e_a')) hurt(t, u, c.amount * 0.05);
        }
        if (!own(u) || t.side !== 'enemy') return;
        const isMember = bond && member(u, fam);
        let leech = 0;
        if (isMember && fam === 'victoria') { if (gold && c.dmg.isAttack) leech = n * 0.003; if (prism && c.dmg.isAttack) hurt(u, t, c.amount * Math.min(0.3, n * 0.006)); }
        if (isMember && fam === 'egir') { leech = silver ? Math.min(0.3, n * 0.008) : prism ? Math.min(0.5, n * 0.02) : 0; if (prism) hurt(u, t, c.amount * Math.min(0.3, n * 0.006)); }
        if (isMember && fam === 'laterano') {
          if (c.dmg.type === 'arts' || c.dmg.isSkill) leech = Math.min(0.5, n * (gold ? 0.006 : prism ? 0.015 : 0));
          if (prism && c.dmg.isSkill) {
            const visited = new Set([t]); let from = t;
            for (let i = 0; i < 3; i++) {
              const next = enemies().filter(e => !visited.has(e) && hypot(e.x - from.x, e.y - from.y) <= 3).sort((a, z) => hypot(a.x - from.x, a.y - from.y) - hypot(z.x - from.x, z.y - from.y))[0];
              if (!next) break;
              visited.add(next); hurt(u, next, c.amount * [0.5, 0.3, 0.2][i], c.dmg.type); from = next;
            }
          }
        }
        if (leech) b.heal(u, u, c.amount * leech, { self: true });
        if (isMember && fam === 'sargon' && c.dmg.isAttack) {
          if (gold) hurt(u, t, u.s.aspd * 0.008);
          if (prism) hurt(u, t, c.amount * Math.min(0.3, n * 0.005));
        }
        if (isMember && fam === 'kjerag' && prism && t.s.flags.freeze) hurt(u, t, c.amount * Math.min(0.3, n * 0.01));
        if (fam === 'yan' && member(u, fam)) { t.mem.hexBurn ||= {}; t.mem.hexBurn[pid] = b.time + 4; }
        if (fam === 'morph' && silver && c.dmg.isAttack) {
          if (hasBaseItem(u, 'chess_item_1_01_e_a')) for (const other of enemies()) S.isolateContentCallback(b, () => {
            if (other !== t && hypot(other.x - t.x, other.y - t.y) <= 1.01) hurt(u, other, c.amount * 0.05, c.dmg.type);
          }, 'cyclops:morph:damage', other);
        }
      });
      if (fam === 'morph' && silver) b.every(1, () => {
        for (const u of ops().filter(onField)) S.isolateContentCallback(b, () => {
          if (hasBaseItem(u, 'chess_item_1_05_e_a')) b.heal(u, u, u.s.maxHp * 0.01, { self: true });
        }, 'cyclops:morph:heal', u);
      });
      if (fam === 'siracusa' && gold) b.on('beforeAttack', c => {
        if (!member(c.attacker, fam) || c.profile?.heal) return;
        const targets = b.enemiesInKeys(c.attacker.rangeKeys, c.attacker, c.profile).filter(onField);
        targets.sort((a, z) => hypot(z.x - c.attacker.x, z.y - c.attacker.y) - hypot(a.x - c.attacker.x, a.y - c.attacker.y));
        if (targets.length) c.targets = targets.slice(0, Math.max(1, c.targets.length));
      });
      if (fam === 'sargon' && prism) b.on('beforeAttack', c => {
        if (!member(c.attacker, fam) || c.profile?.heal || !c.targets.length) return;
        const u = c.attacker, first = c.targets[0];
        const dx = first.x - u.x, dy = first.y - u.y, len = hypot(dx, dy) || 1;
        const original = c.targets.slice(), seen = new Set(original);
        const extra = b.enemiesInKeys(u.rangeKeys, u, c.profile).filter(e => {
          if (!onField(e) || seen.has(e)) return false;
          const x = e.x - u.x, y = e.y - u.y;
          if (x * dx + y * dy < 0 || Math.abs(x * dy - y * dx) / len > 0.5) return false;
          seen.add(e);
          return true;
        }).sort((a, z) => hypot(a.x - u.x, a.y - u.y) - hypot(z.x - u.x, z.y - u.y)).slice(0, 2);
        c.targets = [...original, ...extra];
      });
      b.on('kill', ({ killer, victim }) => {
        if (victim.side !== 'enemy') return;
        if (fam === 'bounty' && victim.waveScheduled && victim.counted && victim.tag !== 'part'
            && !bountyVictims.has(victim) && (victim.ownerId === pid || (own(killer) && b.players.length === 1))) {
          bountyVictims.add(victim);
          // The gold gift settles later, using only these scheduled, counted and distinct victims.
          if (gold) save('cyc_bounty');
          const cap = silver ? 5 : prism ? 15 : 0;
          if (bountyCoins < cap) {
            const coins = silver && special(victim) ? 1
              : p.killChance > 0 && b.rng() < p.killChance ? prism && special(victim) ? 2 : 1 : 0;
            const paid = Math.min(coins, cap - bountyCoins);
            if (paid > 0) { bountyCoins += paid; b.addCoins(pid, paid); }
          }
        }
        if (!member(killer, fam)) return;
        if (fam === 'sargon' && prism && b.time >= teamSpAt) {
          teamSpAt = b.time + 2;
          for (const u of members()) S.isolateContentCallback(b, () => {
            if (onField(u) && u.skill) u.skill.gainSp(u.skill.spCost * 0.25, 'cyclops');
          }, 'cyclops:teamSp', u);
        }
        if (fam === 'laterano' && gold && killer.skill && b.time >= (killSpAt.get(killer) ?? -Infinity)) {
          killSpAt.set(killer, b.time + 2);
          killer.skill.gainSp(killer.skill.spCost * 0.25, 'cyclops');
        }
        if ((fam === 'egir' && gold) || (fam === 'laterano' && prism) || (fam === 'siracusa' && prism)) {
          const cap = fam === 'egir' ? 15 : 12;
          if (kills < cap) { kills++; save(ref.data.effectId); sync(); }
        }
      });
      if (fam === 'egir' && prism) b.on('death', ({ unit, reason }) => {
        if (own(unit) && unit.kind === 'op' && reason === 'killed' && deaths < 6) { deaths++; sync(); }
      });
      if (fam === 'siracusa') installedSiracusa.push(q);
    }, 'cyclops:gift');
  }, 'cyclops:player');
}
