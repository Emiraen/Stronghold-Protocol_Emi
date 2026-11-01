import { readFileSync } from 'node:fs';
import { offsetTile, isDir } from '../../sim/dir.js';
import { COLS } from '../../sim/constants.js';
import { SkillRuntime } from '../../sim/skills.js';
import { normalizeSkill } from '../../sim/simdata.js';
import { tileKeyOf } from '../../sim/targeting.js';
import { mizukiBattleDiceSpec, applyMizukiBattleDice } from './BattleDice.js';

const SOURCE = JSON.parse(readFileSync(new URL('../../../data/mizuki/active-tools.json', import.meta.url), 'utf8'));
const board = entries => Object.fromEntries((entries || []).map(v => [v.key, v.valueStr ?? v.value]));
const tools = new Map(Object.values(SOURCE.tools).map(value => {
  const phase = value.raw.phases[0], skill = value.skill?.levels[0];
  const talents = Object.assign({}, ...(value.raw.talents || []).map(t => board(t.candidates[0]?.blackboard)));
  const rangeId = skill?.rangeId || phase.rangeId;
  return [value.itemId, { ...value, name: value.raw.name, stats: phase.attributesKeyFrames[0].data,
    skill, bb: board(skill?.blackboard), talents,
    grid: value.ranges[rangeId]?.grids.map(p => [p.row, p.col]) || [[0, 0]] }];
}));

export const mizukiActiveToolSpec = id => tools.get(id) || null;
export function validMizukiRouteInventory(inventory) {
  return inventory != null && typeof inventory === 'object' && !Array.isArray(inventory)
    && Object.entries(inventory).every(([id, count]) => tools.has(id) && Number.isInteger(count) && count >= 1 && count <= 9999);
}
export function mizukiActiveToolSpecs(player) {
  // Older local runs accumulated support items. Preserve their most recently
  // acquired kind, with the native per-battle supply rather than multiplying it.
  const current = Object.entries(player.routeInventory || {}).filter(([id, owned]) => tools.has(id) && owned > 0).at(-1);
  const spec = current ? tools.get(current[0]) : null;
  return spec ? [{ ...spec, count: spec.count, ownerUid: null }] : [];
}

// Tool stock belongs to this battle. Buying the support item grants its full
// supply each subsequent battle; spending a charge never removes the relic.
export function installMizukiActiveTools(battle, players, dice = {}) {
  const stocks = new Map(), placed = [];
  const diceSpec = mizukiBattleDiceSpec(dice.id);
  const maxDiceUses = Number.isSafeInteger(dice.maxDiceUses) && dice.maxDiceUses > 0 ? dice.maxDiceUses : 1;
  const usedDiceUses = Number.isSafeInteger(dice.usedDiceUses) && dice.usedDiceUses >= 0 ? Math.min(maxDiceUses, dice.usedDiceUses) : 0;
  const remainingDiceUses = maxDiceUses - usedDiceUses;
  let diceUses = 0;
  for (const [index, player] of players.entries()) for (const input of [...(player.activeTools || []),
    ...(diceSpec ? [{ toolId: diceSpec.itemId, tokenId: diceSpec.key, uid: 900000000 + index, count: maxDiceUses }] : [])]) {
    const spec = tools.get(input.toolId) || mizukiBattleDiceSpec(input.toolId);
    if (!spec || spec.key !== input.tokenId || !Number.isInteger(input.uid)) continue;
    const stock = { ...input, playerId: player.playerId, spec,
      remaining: spec.battleDice ? remainingDiceUses : Math.max(1, Math.floor(input.count || 1)), readyAt: 0 };
    stocks.set(player.playerId + ':' + input.uid, stock);
    if (Number.isInteger(input.row) && Number.isInteger(input.col)) placed.push(stock);
  }
  const alive = unit => unit.alive && unit.deployed && !unit.hidden;
  const keysFor = (unit, spec) => new Set(spec.grid.map(([dr, dc]) => {
    const [r, c] = offsetTile(unit.tileR, unit.tileC, dr, dc, unit.dir); return r * COLS + c;
  }));
  const inKeys = (unit, keys) => keys.has(tileKeyOf(unit));
  const destroy = unit => { if (unit.alive) battle.retreat(unit, { reason: 'expired', permanent: true }); };
  function setup(unit, spec) {
    const { key, bb, talents } = spec;
    unit.def = { ...unit.def, position: spec.position, rangeGrid: spec.grid };
    unit.base.tauntLevel = spec.stats.tauntLevel || 0;
    unit.mem.mizukiActiveTool = spec.itemId;
    unit.markDirty(); battle._refreshRange(unit);
    if (spec.battleDice) {
      const result = applyMizukiBattleDice(battle, unit, spec);
      dice.onRoll?.(result);
      return result;
    }
    const keys = keysFor(unit, spec);
    if (key === 'trap_083_bunker') {
      // It blocks four enemies without rewriting pathfinding as a crate.
      battle.addBuff(unit, { key: 'mizuki:tool:bunker', persist: true,
        flags: { noHeal: true, stunImmune: true, frozenImmune: true, sleepImmune: true, silenceImmune: true } });
      unit.def = { ...unit.def, immune: new Set(['stun', 'frozen', 'sleep', 'silence']) };
      unit.kind = 'token';
      return;
    }
    if (key === 'trap_012_mine') {
      const data = spec.skill;
      unit.base.spRecovery = data.spData?.increment ?? 1; unit.markDirty();
      unit.skill = new SkillRuntime(battle, unit, normalizeSkill({ skill: { ...data,
        id: data.prefabId, ...data.spData, spType: data.spData?.spType,
        spCost: data.spData?.spCost, initSp: data.spData?.initSp, rangeGrid: spec.grid } }),
      { kind: 'instant', trigger: 'SP_FULL', onStart() { unit.mem.mizukiMineArmed = true; } }, bb);
      unit.skill.reset();
    }
    if (key === 'trap_084_aidkit') battle.addBuff(unit, { key: 'mizuki:tool:aidkit', flags: { invulnerable: true }, persist: true });
    let elapsed = 0, activated = false;
    const off = battle.on('tick', ({ dt }) => {
      if (!alive(unit)) { battle.off(off); return; }
      elapsed += dt;
      if (key === 'trap_009_battery') {
        while (elapsed + 1e-9 >= talents.interval) {
          elapsed -= talents.interval;
          for (const target of battle.allyUnits) if (target !== unit && alive(target) && inKeys(target, keys)) target.skill?.gainSp(talents.sp, 'talent');
          battle.fx('spGift', { x: unit.x, y: unit.y, id: unit.id });
        }
      } else if (key === 'trap_012_mine') {
        if (!unit.mem.mizukiMineArmed) return;
        const enemies = battle.enemies.filter(target => alive(target) && !target.isFlying
          && tileKeyOf(target) === unit.tileR * COLS + unit.tileC);
        if (!enemies.length) return;
        const targets = battle.enemies.filter(target => alive(target) && !target.isFlying
          && (target.x - unit.x) ** 2 + (target.y - unit.y) ** 2 <= .55 ** 2);
        for (const target of targets) {
          battle.addBuff(target, { key: 'mizuki:tool:mine', duration: bb.duration,
            mods: { dmgTakenMul: bb.damage_scale }, refresh: 'extend' });
          battle.dealDamage(unit, target, { type: 'true', amount: bb.damage, canDodge: false, tags: ['mizuki:tool:mine'] });
        }
        battle.fx('explosion', { x: unit.x, y: unit.y }); destroy(unit);
      } else if (key === 'trap_018_bomb') {
        if (elapsed + 1e-9 < (bb['attack@duration'] || 1.5)) return;
        for (const target of battle.enemies) if (alive(target) && inKeys(target, keys)) battle.applyStatus(target, 'stun', { source: unit, duration: bb['attack@stun'] });
        battle.fx('explosion', { x: unit.x, y: unit.y }); destroy(unit);
      } else if (key === 'trap_031_sleep') {
        if (!activated && elapsed + 1e-9 >= 1) {
          activated = true;
          const target = battle.allyUnits.filter(target => target.kind === 'op' && target.ownerId === unit.ownerId
            && alive(target) && !target.s.flags.noRetreat && inKeys(target, keys))
            .sort((a, b) => a.hp / a.s.maxHp - b.hp / b.s.maxHp || a.id - b.id)[0];
          if (target) {
            battle.retreat(target, { reason: 'retreat' });
            target.respawnAt = battle.time + Math.max(0, target.respawnAt - battle.time) * bb.respawn_time;
          }
        }
        if (elapsed + 1e-9 >= 2) destroy(unit);
      } else if (key === 'trap_084_aidkit' && !activated) {
        activated = true;
        const targets = battle.allyUnits.filter(target => target !== unit && alive(target) && !target.isFlying && inKeys(target, keys));
        const knight = targets.find(target => target.defId === 'trap_079_allydonq');
        const target = targets.filter(value => value !== knight && value.kind !== 'device')
          .sort((a, b) => a.hp / a.s.maxHp - b.hp / b.s.maxHp || a.id - b.id)[0];
        for (const ally of [target, knight].filter(Boolean)) battle.after(1, () => {
          if (alive(ally)) battle.heal(unit, ally, bb.value, { ...(ally === knight ? { self: true, ignoreHealFree: true } : {}) });
        });
        destroy(unit);
      }
    });
  }
  function deploy(stock, row, col, dir, { prep = false } = {}) {
    if (!stock || stock.remaining <= 0) return { ok: false, error: 'NO_TOOL_STOCK' };
    if (stock.spec.battleDice && (prep || diceUses >= remainingDiceUses || !dice.canSpend?.())) return { ok: false, error: 'NO_DICE' };
    if (battle.finished || !isDir(dir) || !Number.isInteger(row) || !Number.isInteger(col)
      || !battle.grid.inRect(row, col) || !battle.grid.canStand(row, col, { ranged: stock.spec.position === 'ALL' })
      || battle.grid.isObstacle(row, col)) return { ok: false, error: 'BAD_TILE' };
    if (!prep && stock.readyAt > battle.time + 1e-9) return { ok: false, error: 'COOLDOWN' };
    const player = battle.getPlayer(stock.playerId), s = stock.spec.stats;
    if (!prep && (!player || player.dp + 1e-9 < s.cost)) return { ok: false, error: 'NO_DP' };
    const unit = battle.spawnDevice(stock.spec.key, row, col, { name: stock.spec.name, dir,
      hp: s.maxHp, atk: s.atk, def: s.def, res: s.magicResistance, blockCnt: s.blockCnt,
      bat: s.baseAttackTime, aspd: s.attackSpeed });
    if (!unit) return { ok: false, error: 'OCCUPIED' };
    unit.ownerId = stock.playerId; unit.uid = stock.uid; unit._mizukiToolStockUid = stock.uid;
    if (stock.spec.battleDice) {
      if (dice.spend?.(stock.playerId) !== true) {
        battle.retreat(unit, { reason: 'expired', permanent: true });
        return { ok: false, error: 'NO_DICE' };
      }
      diceUses++;
    }
    if (!prep) player.dp = Math.max(0, player.dp - s.cost);
    stock.remaining--; stock.readyAt = battle.time + s.respawnTime;
    const diceResult = setup(unit, stock.spec);
    return { ok: true, unitId: unit.id, ...(diceResult ? { dice: diceResult } : {}) };
  }
  for (const stock of placed) {
    const result = deploy(stock, stock.row, stock.col, stock.dir || 'RIGHT', { prep: true });
    if (!result.ok) throw new TypeError('Support tool placement conflicts with the field: ' + result.error);
  }
  return {
    handles: (playerId, uid) => stocks.has(playerId + ':' + uid),
    deploy: (playerId, input) => deploy(stocks.get(playerId + ':' + input.uid), input.row, input.col, input.dir),
    snapshot: () => Object.fromEntries(players.map(player => [player.playerId,
      [...stocks.values()].filter(stock => stock.playerId === player.playerId && stock.remaining > 0
        && (!stock.spec.battleDice || diceUses < remainingDiceUses && dice.canSpend?.())).map(stock => ({
        uid: stock.uid, toolId: stock.toolId, tokenId: stock.spec.key, chessId: stock.spec.key, isToken: true,
        name: stock.spec.name, position: stock.spec.position, count: stock.spec.battleDice ? remainingDiceUses - diceUses : stock.remaining, cost: stock.spec.stats.cost,
        deploySlots: 0, deployable: stock.readyAt <= battle.time + 1e-9, deployed: false, removed: false,
        redeployRemaining: Math.max(0, stock.readyAt - battle.time), ownerId: player.playerId,
      }))])),
  };
}
