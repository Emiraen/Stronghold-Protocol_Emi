// Original RO2 field facilities, with data isolated to this mode.
import { readFileSync } from 'node:fs';
import { normalizeSkill } from '../../sim/simdata.js';
import { SkillRuntime } from '../../sim/skills.js';
import { absoluteRangeKeys } from '../../sim/targeting.js';
import { COLS } from '../../sim/constants.js';
import { isDir } from '../../sim/dir.js';
import { installOfficialCreep } from './OfficialCreep.js';
import { installOfficialVolcano, installOfficialBallista } from './OfficialHazards.js';
import { OFFICIAL_ALLY_KNIGHT_KEY, spawnOfficialAllyKnight } from './OfficialAllyKnight.js';
import { installOfficialFacilityTiles } from './OfficialFacilityTiles.js';
import { OFFICIAL_AIR_SUPPORT_KEY, spawnOfficialAirSupport, snapshotOfficialAirSupportEffects } from './OfficialAirSupport.js';
import { OFFICIAL_WEAPON_STATION_KEY, spawnOfficialWeaponStation } from './OfficialWeaponStation.js';
const SOURCE = JSON.parse(readFileSync(new URL('../../../data/mizuki/facilities.json', import.meta.url), 'utf8'));
const bboard = (entries) => Object.fromEntries((entries || []).map((v) => [v.key, v.valueStr || v.value]));
const sourceInstances = (level) => [...(level.predefines?.characterInsts || []), ...(level.predefines?.tokenInsts || [])];
const supported = new Set(['trap_001_crate', 'trap_027_stone', 'trap_024_npcsld',
  'trap_010_frosts', 'trap_005_sensor', 'trap_065_normbox', 'trap_066_rarebox', 'trap_068_badbox', 'trap_061_creep',
  'trap_011_ore', 'trap_008_farm', 'trap_038_dsbell', 'trap_007_ballis', OFFICIAL_ALLY_KNIGHT_KEY, OFFICIAL_AIR_SUPPORT_KEY,
  OFFICIAL_WEAPON_STATION_KEY]);

export function resolveOfficialFacility(instance) {
  const key = instance.inst?.characterKey, raw = SOURCE.facilities[key];
  if (!raw) throw new RangeError('Missing original facility: ' + key);
  const phaseIndex = Number(String(instance.inst?.phase || 'PHASE_0').replace('PHASE_', '')) || 0;
  const phase = raw.phases[phaseIndex];
  if (!phase) throw new RangeError('Missing original facility phase: ' + key);
  const frames = phase.attributesKeyFrames;
  const level = Math.min(phase.maxLevel, Math.max(1, instance.inst?.level || 1));
  const low = [...frames].reverse().find((v) => v.level <= level) || frames[0];
  const high = frames.find((v) => v.level >= level) || frames.at(-1);
  const ratio = high.level > low.level ? (level - low.level) / (high.level - low.level) : 0;
  const stats = Object.fromEntries(Object.entries(low.data).map(([k, v]) => [k, typeof v === 'number'
    && typeof high.data[k] === 'number' ? v + (high.data[k] - v) * ratio : v]));
  const choice = raw.skills[Math.max(0, instance.skillIndex || 0)];
  const skill = choice?.data.levels[Math.max(0, (instance.mainSkillLvl || 1) - 1)] || choice?.data.levels[0];
  const bb = { ...bboard(skill?.blackboard), ...bboard(instance.overrideSkillBlackboard) };
  const rangeId = skill?.rangeId || phase.rangeId;
  const grid = raw.ranges[rangeId]?.grids?.map((p) => [p.row, p.col]) || [[0, 0]];
  const talents = {}, talentBoards = {};
  for (const talent of raw.talents || []) {
    const candidate = [...talent.candidates].reverse().find((v) => v.unlockCondition.level <= level
      && Number(String(v.unlockCondition.phase).replace('PHASE_', '')) <= phaseIndex
      && v.requiredPotentialRank <= (instance.inst?.potentialRank || 0));
    if (candidate) {
      talentBoards[candidate.prefabKey] = bboard(candidate.blackboard);
      Object.assign(talents, talentBoards[candidate.prefabKey]);
    }
  }
  return { key, name: raw.name, raw, stats, skill, bb, grid, talents, talentBoards };
}

/** These original levels use one infection BB per field; native terrain applies it. */
export function officialTerrainConfig(level) {
  const special = {};
  const infection = (level.mapData?.tiles || []).find((v) => v.tileKey === 'tile_infection');
  if (infection) special.infection = { bb: bboard(infection.blackboard) };
  const tide = sourceInstances(level).find((p) => p.inst?.characterKey === 'trap_042_tidectrl');
  if (tide && tide.skillIndex === 2) special.deepsea = { bb: resolveOfficialFacility(tide).bb };
  return special;
}

export function inspectOfficialFacilities(level) {
  const pending = sourceInstances(level).filter((p) => {
    const key = p.inst?.characterKey;
    return !supported.has(key) && !(key === 'trap_042_tidectrl' && p.skillIndex === 2);
  }).map((p) => ({ key: p.inst.characterKey, alias: p.alias || p.inst.characterKey }));
  const cards = [...(level.predefines?.characterCards || []), ...(level.predefines?.tokenCards || [])];
  return { pending, cards: cards.map((p) => p.inst?.characterKey).filter((key) => key && key !== 'trap_001_crate'),
    supportedCards: cards.filter((p) => p.inst?.characterKey === 'trap_001_crate').map((p) => p.inst.characterKey) };
}

export function installOfficialStageMechanics(battle, level) {
  const instances = sourceInstances(level), units = new Map(), shared = new Map();
  const cards = new Map();
  for (const p of [...(level.predefines?.characterCards || []), ...(level.predefines?.tokenCards || [])]) {
    if (p.hidden || p.inst?.characterKey !== 'trap_001_crate') continue;
    const def = resolveOfficialFacility(p), previous = cards.get(def.key);
    const count = Math.max(0, Math.floor(p.initialCnt || 0));
    if (previous) { previous.count += count; previous.initialCount += count; }
    else cards.set(def.key, { key: def.key, name: def.name, count, initialCount: count,
      cost: def.stats.cost, respawnTime: def.stats.respawnTime, instance: p, serial: 0, readyAt: 0 });
  }
  const cardOptions = () => [...cards.values()].map(({ instance: _p, serial: _serial, ...card }) => {
    const remaining = battle.started ? Math.max(0, card.readyAt - battle.time) : 0;
    return { ...card, cooldown: remaining, redeployRemaining: remaining,
      deployable: !battle.finished && card.count > 0 && remaining <= 1e-9 };
  });
  const creep = installOfficialCreep(battle, level);
  const volcano = installOfficialVolcano(battle, level), ballistas = [];
  const effects = new Map();
  const facilityTiles = installOfficialFacilityTiles(battle);
  function effect(unit, key, active = true, { loop = true } = {}) {
    const id = unit.id + ':' + key;
    const previous = effects.get(id);
    if (loop && previous?.active === active) return;
    const state = { id, key, x: unit.x, y: unit.y, dir: unit.dir,
      unitId: unit.id, active, since: battle.time, loop };
    if (loop) effects.set(id, state);
    battle.fx('mizuki:effect', { ...state, phase: active ? 'start' : 'stop' });
  }
  const logs = {}, warnings = [];
  const isAlive = (u) => u.alive && u.deployed && !u.hidden;
  const keyFor = (p) => p.alias || p.inst?.characterKey;
  const inKeys = (u, keys) => keys.has(Math.round(u.y) * COLS + Math.round(u.x));
  const range = (u, def) => new Set(absoluteRangeKeys(def.grid, u.tileR, u.tileC, u.dir));
  const count = (key, addition = 1) => { logs[key] = (logs[key] || 0) + addition; };
  battle.on('mizuki:extraBattleInfo', ({ key, additionValue }) => {
    if (typeof key === 'string' && Number.isFinite(additionValue)) count(key, additionValue);
  });
  // Native bonus enemies grant a collectible on an actual kill. Escapes and
  // cleanup never earn this drop; their objective cost is independent.
  const bonusEnemies = new Set(['enemy_2001_duckmi', 'enemy_2002_bearmi', 'enemy_2034_sythef', 'enemy_2085_skzjxd']);
  battle.on('death', ({ unit, reason }) => {
    if (reason === 'killed' && unit?.side === 'enemy' && bonusEnemies.has(unit.defId)) count('bonusCollectible');
  });
  const supportedBranchKeys = instances.filter((p) => p.inst?.characterKey === 'trap_068_badbox')
    .map((p) => resolveOfficialFacility(p).bb.branch_id).filter((v) => typeof v === 'string' && level.branches?.[v]);

  function skillFor(unit, def, action, { duration = 0, delay = 0 } = {}) {
    const data = def.skill, manual = data.skillType === 'MANUAL';
    unit.base.spRecovery = data.spData?.increment ?? 1;
    unit.markDirty();
    unit.skill = new SkillRuntime(battle, unit, normalizeSkill({ skill: { ...data,
      id: data.prefabId, ...data.spData, spType: data.spData?.spType,
      spCost: data.spData?.spCost, initSp: data.spData?.initSp, rangeGrid: def.grid } }), {
      kind: duration > 0 ? 'duration' : delay > 0 ? 'duration' : 'instant',
      duration: duration || delay, trigger: manual ? 'MANUAL' : 'SP_FULL',
      onStart() {
        const targets = new Set(range(unit, def));
        if (delay > 0) battle.after(delay, () => { if (unit.alive) action(targets); }, { owner: unit });
        else action(targets);
      },
    }, def.bb);
    unit.skill.reset();
  }

  function spawn(p) {
    const alias = keyFor(p);
    if (units.has(alias)) return true;
    const def = resolveOfficialFacility(p);
    if (def.key === 'trap_042_tidectrl' && p.skillIndex === 2) { units.set(alias, null); return true; }
    if (!supported.has(def.key)) { warnings.push({ code: 'facility_behavior', key: def.key, alias }); return false; }
    const r = p.position.row, c = p.position.col;
    const box = ['trap_065_normbox', 'trap_066_rarebox', 'trap_068_badbox'].includes(def.key);
    let unit;
    if (def.key === OFFICIAL_ALLY_KNIGHT_KEY) {
      unit = spawnOfficialAllyKnight(battle, p, def, { log: count });
    } else if (def.key === OFFICIAL_AIR_SUPPORT_KEY) {
      unit = spawnOfficialAirSupport(battle, p, def, { effect });
    } else if (def.key === OFFICIAL_WEAPON_STATION_KEY) {
      unit = spawnOfficialWeaponStation(battle, p, def, { effect, log: count });
    } else if (box) {
      unit = battle.spawnEnemy(def.key, { pos: [r, c], countInTotal: false,
        def: { name: def.name, stats: def.stats, applyWay: 'NONE', notCountInTotal: true,
          lpr: 0, staticBody: true, spine: def.key },
        route: { start: [r, c], end: [r, c], checkpoints: [{ type: 'WAIT', time: Infinity }] },
        tag: 'mizuki:facility:' + alias });
      if (unit) {
        unit.pauseUntil = Infinity;
        unit._officialFacility = true;
        unit._officialDontBlockWave = true;
        if (def.key === 'trap_066_rarebox') battle.on('damaged', (ctx) => {
          if (ctx.target === unit && ctx.source?.alive && ctx.source.side === 'ally' && ctx.amount > 0) {
            battle.dealDamage(null, ctx.source, { type: 'true', amount: ctx.amount * def.talents.atk_scale,
              sourceless: true, canDodge: false, tags: ['reflection'] });
          }
        });
        if (def.key === 'trap_068_badbox') battle.on('damaged', (ctx) => {
          if (ctx.target !== unit || unit.mem.mizukiOpened || !(ctx.amount > 0)) return;
          unit.mem.mizukiOpened = true;
          battle._officialWaves?.triggerBranch(def.bb.branch_id, { random: true,
            notRepeatInOneLoop: false, blockGameFinish: false });
          battle.kill(unit, ctx.source);
        });
        else battle.on('death', ({ unit: dead, reason }) => { if (dead === unit && reason === 'killed') count(def.key); });
      }
    } else {
      const s = def.stats;
      unit = battle.spawnDevice(def.key, r, c, { name: def.name, hp: s.maxHp, atk: s.atk, def: s.def,
        res: s.magicResistance, bat: s.baseAttackTime, aspd: s.attackSpeed, blockCnt: s.blockCnt,
        dir: p.direction || 'RIGHT', obstacle: ['trap_027_stone', 'trap_001_crate'].includes(def.key),
        obstacleKind: 'crate' });
      if (unit) {
        unit.mem.mizukiFacilityAlias = alias;
        unit._mizukiSourceSide = def.raw.originalSide;
        unit._mizukiSourceCategory = def.raw.originalCategory;
        unit.base.tauntLevel = s.tauntLevel;
        if (def.key === 'trap_024_npcsld') {
          // Shared lifecycle intentionally skips device AI. The original shield
          // guard is an attacking ally, occupies zero player slots, and has no
          // player command UID; token AI runs its source melee profile.
          unit.kind = 'token';
          unit.def = { ...unit.def, rangeGrid: def.grid };
          unit.base.tauntLevel += def.bb.taunt_level || 0;
          unit.profile = { attack: 'melee', maxTargets: 1, dmgType: 'phys', atkScale: 1, canHitFly: false };
          battle._refreshRange(unit);
        } else if (def.key === 'trap_007_ballis') {
          effect(unit, 'bolt_buff_01_start');
          ballistas.push(installOfficialBallista(battle, unit, def, skillFor));
        } else if (def.key === 'trap_011_ore') {
          effect(unit, 'curse_buff_02_start');
          battle.addBuff(unit, { key: 'mizuki:official:facility:free',
            flags: { invulnerable: true, untargetable: true }, persist: true });
          skillFor(unit, def, (keys) => {
            battle.fx('mizuki:effect', { key: 'curse_buff_01_start', x: unit.x, y: unit.y, unitId: unit.id, dir: unit.dir });
            for (const target of battle.units) if (isAlive(target)
              && (target.kind !== 'device' || target._mizukiSourceCategory === 1) && inKeys(target, keys)) {
              if (!target.findBuff('ore_immune')) battle.dealDamage(unit, target,
                { type: 'true', amount: def.bb.value, canDodge: false, tags: ['mizuki:ore'] });
              if (target.alive && target.findBuff('ore_listener')) {
                battle.emit('mizuki:orePulse', { source: unit, unit: target, mode: 1 });
              }
            }
          }, { delay: 0.6000000238418579 });
        } else if (def.key === 'trap_008_farm') {
          effect(unit, 'supply_buff_01_start');
          effect(unit, 'supply_buff_01_start_02');
          unit.mem.mizukiSkillCost = def.bb.cost;
          battle.addBuff(unit, { key: 'farm_target_free', flags: { noHeal: true, healFree: true }, persist: true });
          skillFor(unit, def, () => {
            battle.addDp(battle._manualPlayerId, -def.bb.cost);
            unit.mem.mizukiFarmUpgraded = true;
            effect(unit, 'supply_buff_01_start', false);
            effect(unit, 'supply_buff_01_start_02', false);
            effect(unit, 'supply_buff_02_start');
            battle._mizukiDeployLimitBonus = (battle._mizukiDeployLimitBonus || 0) + def.bb.value;
            battle.addBuff(unit, { key: 'farm_s_1', persist: true,
              mods: { defPct: def.bb.def, resFlat: def.bb.magic_resistance, hpRegen: def.bb.hp_recovery_per_sec } });
          });
          const activate = unit.skill.activate.bind(unit.skill);
          unit.skill.activate = (...args) => !unit.mem.mizukiFarmUpgraded
            && battle.getPlayer(battle._manualPlayerId)?.dp >= def.bb.cost && activate(...args);
          unit.uid = -100000 - instances.indexOf(p);
          shared.set(unit.uid, unit);
          battle.on('death', ({ unit: dead }) => {
            if (dead !== unit) return;
            battle._mizukiLeakDamage = (battle._mizukiLeakDamage || 0) - def.talentBoards['1'].value;
            if (unit.mem.mizukiFarmUpgraded) {
              battle._mizukiDeployLimitBonus -= def.bb.value;
              unit.mem.mizukiFarmUpgraded = false;
            }
          });
        } else if (def.key === 'trap_038_dsbell') {
          effect(unit, 'trap_038_dsbell_buff_01');
          battle.addBuff(unit, { key: 'bell_c:invincible', flags: { invulnerable: true, untargetable: true }, persist: true });
          const neighbours = new Set(absoluteRangeKeys([[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0]], r, c, 'RIGHT'));
          const keys = range(unit, def);
          let checkElapsed = 0;
          battle.on('tick', ({ dt }) => {
            if (!isAlive(unit)) return;
            checkElapsed += dt;
            if (checkElapsed + 1e-9 >= 0.30000001192092896) {
              checkElapsed = 0;
              const nearby = battle.units.filter((u) => u !== unit && isAlive(u) && inKeys(u, neighbours));
              const oldMode = unit.mem.mizukiBellMode || 0;
              unit.mem.mizukiBellMode = nearby.some((u) => u.findBuff('bell_active[mark]')) ? 2
                : nearby.some((u) => u.side === 'ally' && u._mizukiSourceSide !== 2 && !u.obstacle) ? 1 : 0;
              if (oldMode !== unit.mem.mizukiBellMode) {
                const keys = ['trap_038_dsbell_buff_01', 'trap_038_dsbell_buff_02', 'trap_038_dsbell_buff_03'];
                effect(unit, keys[oldMode], false);
                effect(unit, keys[unit.mem.mizukiBellMode]);
                if (!unit.mem.mizukiBellMode) battle.fx('mizuki:effect',
                  { key: 'trap_038_dsbell_buff_04', x: unit.x, y: unit.y, unitId: unit.id, duration: 1 });
              }
            }
            const rate = def.talentBoards[String(unit.mem.mizukiBellMode)]?.ep_recovery_per_sec || 0;
            if (rate > 0) for (const ally of battle.allyUnits) if (isAlive(ally)
              && (ally.kind !== 'device' || ally._mizukiSourceCategory === 1) && inKeys(ally, keys)) {
              battle.reduceElement(ally, rate * dt);
            }
          });
        } else if (def.key === 'trap_010_frosts') {
          effect(unit, 'icer_buff_02_start');
          battle.addBuff(unit, { key: 'mizuki:official:facility:free', flags: { invulnerable: true, untargetable: true }, persist: true });
          skillFor(unit, def, (keys) => {
            for (const ally of battle.allyUnits) if (isAlive(ally) && ally.kind !== 'device' && inKeys(ally, keys)) {
              battle.applyStatus(ally, 'cold', { duration: def.bb.freeze, source: unit });
            }
          }, { delay: 0.800000011920929 });
        } else if (def.key === 'trap_061_creep') {
          battle.addBuff(unit, { key: 'mizuki:official:facility:free', flags: { invulnerable: true, untargetable: true }, persist: true });
          creep.bindController(unit, def);
          skillFor(unit, def, () => creep.pulse());
        } else if (def.key === 'trap_005_sensor') {
          skillFor(unit, def, () => {}, { duration: def.skill.duration });
          unit.uid = -100000 - instances.indexOf(p);
          shared.set(unit.uid, unit);
        }
        unit.markDirty();
        battle.on('death', ({ unit: dead }) => {
          if (dead !== unit) return;
          for (const state of effects.values()) if (state.unitId === unit.id && state.active) effect(unit, state.key, false);
        });
      }
    }
    if (!unit) { warnings.push({ code: 'facility_spawn', key: def.key, alias }); return false; }
    for (const tag of def.raw.originalFilterTags || []) unit.tags.add(tag);
    facilityTiles.apply(unit, def, def.skill?.prefabId === 'sktok_wpnsts_2' ? 1 : 0);
    units.set(alias, unit);
    return true;
  }

  battle.on('battleStart', () => { for (const p of instances) if (!p.hidden) spawn(p); }, { priority: 20000 });
  battle.on('tick', () => {
    for (const unit of shared.values()) if (unit.alive && unit.skill?.active) {
      const def = resolveOfficialFacility(instances.find((p) => keyFor(p) === unit.mem.mizukiFacilityAlias));
      const keys = range(unit, def);
      for (const enemy of battle.enemies) if (isAlive(enemy) && inKeys(enemy, keys)) {
        battle.addBuff(enemy, { key: 'mizuki:official:detector:' + unit.id, duration: 0.1,
          flags: { reveal: true }, refresh: 'replace' });
      }
    }
    for (const unit of battle.allyUnits) {
      if (!isAlive(unit) || unit.kind === 'device') continue;
      const tile = battle.grid.tile(unit.tileR, unit.tileC);
      const input = level.mapData?.tiles?.[level.mapData.map[level.mapData.map.length - 1 - unit.tileR]?.[unit.tileC]];
      const bb = bboard(input?.blackboard);
      if (tile.key === 'tile_defup') battle.addBuff(unit, { key: 'mizuki:official:tile:defup',
        duration: 0.1, mods: { defFlat: bb.def }, refresh: 'replace' });
      if (tile.key === 'tile_defbreak' && !unit.findBuff('mizuki:official:tile:defbreak')) {
        battle.addBuff(unit, { key: 'mizuki:official:tile:defbreak', mods: { defMul: bb.def }, duration: Infinity });
      }
      if (tile.key === 'tile_grass') battle.addBuff(unit, { key: 'mizuki:official:tile:grass',
        duration: 0.1, flags: { stealth: true }, refresh: 'replace' });
    }
  });
  function deployCard(key, row, col, dir = 'RIGHT', { playerId } = {}) {
    const fail = (error) => ({ ok: false, error });
    if (battle.finished) return fail('BATTLE_ENDED');
    const card = cards.get(key);
    if (!card) return fail('UNKNOWN_FACILITY_CARD');
    if (!(card.count > 0)) return fail('NO_FACILITY_CARDS');
    if (battle.started && card.readyAt > battle.time + 1e-9) return fail('COOLDOWN');
    if (!Number.isInteger(row) || !Number.isInteger(col) || !battle.grid.inRect(row, col)
      || !battle.grid.canStand(row, col, { ranged: false }) || battle.grid.isObstacle(row, col)) return fail('WRONG_TILE');
    if (!isDir(dir)) return fail('BAD_DIRECTION');
    if (battle.units.some((u) => u.alive && u.deployed && !u.hidden && u.side === 'ally'
      && u.tileR === row && u.tileC === col)) return fail('OCCUPIED');
    const player = battle.getPlayer(playerId);
    if (!player) return fail('NOT_PLAYER');
    if (player.dp + 1e-9 < card.cost) return fail('NO_DP');
    const alias = 'mizuki:card:' + key + ':' + (card.serial + 1);
    const p = { ...card.instance, alias, hidden: false, position: { row, col }, direction: dir };
    // Commit quantity and original deployment points only after real spawn.
    if (!spawn(p)) return fail('FACILITY_SPAWN_FAILED');
    card.count--; card.serial++; card.readyAt = battle.time + Math.max(0, card.respawnTime || 0);
    player.dp = Math.max(0, player.dp - card.cost);
    const unit = units.get(alias); unit.mem.mizukiCardOwnerId = playerId;
    return { ok: true, key, unitId: unit.id, cost: card.cost, count: card.count, dp: player.dp };
  }
  return {
    cardOptions,
    deployCard,
    waveOptions: { activatePredefined: (_key, instance) => spawn(instance), supportedBranchKeys },
    findCommandUnit: (uid) => shared.get(uid) || null,
    commandUnits: () => [...shared.values()],
    snapshot: () => ({ cards: cardOptions(), tiles: facilityTiles.snapshot(), logs: { ...logs }, warnings: [...warnings], creep: creep.snapshot(),
      volcano: volcano.snapshot(), ballistas: ballistas.flatMap((item) => item.snapshot()),
      effects: [...effects.values()].map((state) => ({ ...state })).concat(snapshotOfficialAirSupportEffects(battle)),
      active: [...units].map(([alias, unit]) => ({ alias, id: unit?.id ?? null, alive: unit?.alive ?? true })) }),
  };
}
