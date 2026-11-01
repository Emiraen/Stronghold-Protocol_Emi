import { findOfficialPredefined } from './OfficialPredefines.js';
// Original RO2 battle data. This adapter does not fabricate an exploration graph,
// item/drop pools or event transactions from client-only display tables.
import { readFileSync } from 'node:fs';
import { flattenBlackboard, normalizeEnemy, normalizeStage, toDataSource } from '../../sim/simdata.js';
import { ROWS, COLS } from '../../sim/constants.js';
import { KITS, STATS_ONLY } from '../../sim/content/enemies.js';
import { BOSS_KITS } from '../../sim/content/bosses.js';
import { supportsMizukiEnemy } from './official-enemies.js';
import { MIZUKI_BOSS_BRANCH_KEYS } from './boss-enemies.js';
import { compileOfficialRunes, applyOfficialEnemyRunes, applyOfficialLevelRunes } from './OfficialRunes.js';
import { officialTerrainConfig, inspectOfficialFacilities, resolveOfficialFacility } from './OfficialStageMechanics.js';
const OFFICIAL = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8'));
const INDEX = JSON.parse(readFileSync(new URL('../../../data/mizuki/levels/index.json', import.meta.url), 'utf8'));
const DATABASE = JSON.parse(readFileSync(new URL('../../../data/mizuki/enemy-database.json', import.meta.url), 'utf8'));

const levels = new Map();
const clone = (v) => structuredClone(v);
// These original variants have no talent/skill behavior; only their source
// database stats differ from the existing engine's basic physical attackers.
const BASIC_ENEMIES = new Set(['enemy_1007_slime_2', 'enemy_1007_slime_3', 'enemy_1100_scorpn']);
const known = (id) => Object.hasOwn(KITS, id) || Object.hasOwn(STATS_ONLY, id)
  || BASIC_ENEMIES.has(id) || supportsMizukiEnemy(id);
const sourceStage = (id) => OFFICIAL.rawTopic.stages[id];
const sourceEntry = (id) => INDEX.stagesById[id];

function loadLevel(stageId) {
  const entry = sourceEntry(stageId);
  if (!entry || !sourceStage(stageId)) throw new RangeError('Unknown original Mizuki stage: ' + stageId);
  if (!levels.has(entry.file)) levels.set(entry.file, JSON.parse(readFileSync(
    new URL('../../../data/mizuki/levels/' + entry.file, import.meta.url), 'utf8')));
  return levels.get(entry.file);
}

/** m_defined:false is inheritance, even when m_value contains a nonzero default. */
export function mergeOfficialEnemyData(base, overlay) {
  const result = clone(base || {});
  for (const [key, value] of Object.entries(overlay || {})) {
    const itemKey = key === 'skills' ? 'prefabKey'
      : key === 'talentBlackboard' || key === 'blackboard' ? 'key' : null;
    if (itemKey && Array.isArray(value) && value.length && Array.isArray(result[key])) {
      const merged = new Map(result[key].map((v) => [v[itemKey], clone(v)]));
      for (const v of value) merged.set(v[itemKey], mergeOfficialEnemyData(merged.get(v[itemKey]), v));
      result[key] = [...merged.values()];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.hasOwn(value, 'm_defined')) {
        if (value.m_defined) result[key] = clone(value.m_value);
      } else result[key] = mergeOfficialEnemyData(result[key], value);
    } else if (value != null) result[key] = clone(value);
  }
  return result;
}

export function resolveOfficialEnemy(ref, database = DATABASE.enemies) {
  let result = {};
  if (ref.useDb !== false) {
    const entries = database[ref.id];
    if (!Array.isArray(entries) || !entries.some((e) => e.level === (ref.level || 0))) {
      throw new RangeError('Original enemy database level is missing: ' + ref.id + '/' + (ref.level || 0));
    }
    for (const entry of [...entries].sort((a, b) => a.level - b.level)) {
      if (entry.level <= (ref.level || 0)) result = mergeOfficialEnemyData(result, entry.enemyData);
    }
  }
  result = mergeOfficialEnemyData(result, ref.overwrittenData);
  if (!(result.attributes?.maxHp > 0)) throw new RangeError('Original enemy HP is missing: ' + ref.id);
  return result;
}

function blackboards(entries) {
  const bb = {}; const bbStr = {};
  for (const entry of entries || []) {
    if (typeof entry.value === 'number') bb[entry.key] = entry.value;
    if (entry.valueStr != null) bbStr[entry.key] = entry.valueStr;
  }
  return { bb, bbStr };
}

function enemyRecord(ref, resolved, source) {
  const inherited = source.getEnemy(ref.id)?.raw || {};
  const a = resolved.attributes;
  const stats = { ...inherited.stats, ...a, res: a.magicResistance, aspd: a.attackSpeed, bat: a.baseAttackTime,
    rangeRadius: resolved.rangeRadius || 0, motion: resolved.motion,
    lpr: resolved.lifePointReduce ?? 1,
    immunities: Object.fromEntries(Object.entries(a).filter(([key]) => key.endsWith('Immune'))) };
  const skills = (resolved.skills || []).map((skill) => ({ ...skill,
    cd: skill.cooldown, icd: skill.initCooldown, sp: skill.spCost, ...blackboards(skill.blackboard) }));
  return { ...inherited, key: ref.id, name: resolved.name || ref.id,
    rank: resolved.levelType || inherited.rank || 'NORMAL',
    applyWay: resolved.applyWay || inherited.applyWay || 'NONE',
    notCountInTotal: !!resolved.notCountInTotal, stats, skills,
    talents: blackboards(resolved.talentBlackboard), spine: resolved.prefabKey || ref.id,
    officialData: resolved, officialLevel: ref.level || 0 };
}

/** Preserve original checkpoint types: fragment-relative waits need the scheduler. */
export function translateOfficialRoute(route) {
  return { ...clone(route), motion: route.motionMode === 'FLY' ? 'FLY' : 'WALK',
    start: [route.startPosition.row, route.startPosition.col],
    end: [route.endPosition.row, route.endPosition.col],
    checkpoints: (route.checkpoints || []).map((cp) => ({ ...clone(cp),
      pos: [cp.position.row, cp.position.col], originalType: cp.type,
      ...(cp.reachOffset && (cp.reachOffset.x || cp.reachOffset.y)
        ? { offset: [cp.reachOffset.y, cp.reachOffset.x] } : {}) })) };
}

export function translateOfficialMap(id, level, info) {
  const map = level.mapData?.map; const tiles = level.mapData?.tiles;
  if (!map?.length || !tiles?.length || map.length > ROWS || !map[0].length || map[0].length > COLS
      || map.some((row) => row.length !== map[0].length)) throw new RangeError('Unsupported original map dimensions: ' + id);
  const glyph = (n) => String.fromCharCode(0xe000 + n);
  const legend = Object.fromEntries(tiles.map((tile, n) => [glyph(n), clone(tile)]));
  const rows = [...map].reverse().map((row) => row.map((n) => {
    if (!Number.isInteger(n) || !tiles[n]) throw new RangeError('Missing original tile index: ' + n);
    return glyph(n);
  }).join(''));
  const rect = { r0: 0, c0: 0, r1: map.length - 1, c1: map[0].length - 1 };
  // The existing garrison renderer consumes data/stages.json's `tiles`, not
  // the simulation's `legend`. A private Unicode glyph without this mapping
  // becomes an ordinary road and makes high ground/water render incorrectly.
  const nativeTiles = Object.fromEntries(Object.entries(legend).map(([key, tile]) => [key, {
    tileKey: tile.tileKey, height: /HIGH/i.test(tile.heightType) ? 'HIGH' : 'LOW',
    buildable: tile.tileKey === 'tile_deepsea' ? 'NONE' : tile.buildableType,
    passable: tile.passableMask, groundPassable: tile.passableMask === 'ALL',
    flyPassable: tile.passableMask !== 'NONE',
    special: { tile_start: 'start', tile_end: 'end', tile_telin: 'telin', tile_telout: 'telout' }[tile.tileKey] || null,
    bb: flattenBlackboard(tile.blackboard),
    ...(tile.originalFacilityHeight != null ? { originalFacilityHeight: tile.originalFacilityHeight } : {}),
  }]));
  nativeTiles.X = { tileKey: 'tile_forbidden', height: 'HIGH', buildable: 'NONE',
    passable: 'NONE', groundPassable: false, flyPassable: false, special: null, bb: {} };
  const nativeRows = Array.from({ length: ROWS }, (_, r) => (rows[r] || '').padEnd(COLS, 'X'));
  const fieldRect = '((' + rect.r0 + ',' + rect.c0 + '),(' + rect.r1 + ',' + rect.c1 + '))';
  const nativeStage = { id, name: info.name, size: [ROWS, COLS], rows: nativeRows,
    tiles: nativeTiles, devices: [], config: { leftNormal: fieldRect, rightNormal: fieldRect,
      leftBoss: fieldRect, rightBoss: fieldRect }, originalSize: [map.length, map[0].length] };
  return { stage: normalizeStage(id, { id, name: info.name, rows, legend, devices: [],
    special: officialTerrainConfig(level) }), rect, nativeStage };
}

/** All possible eligible alternatives, including branches with real triggers.
 * Inspection must not depend on which random box happens to roll for one seed.
 * Dormant hidden predefines do not make their unused branches reachable. */
export function inspectOfficialActionDependencies(level, hidden = []) {
  const enabled = new Set(hidden), ids = new Set(), branches = new Set(), activated = new Set();
  const instances = [...(level.predefines?.characterInsts || []), ...(level.predefines?.tokenInsts || [])];
  const actions = (level.waves || []).flatMap((w) => (w.fragments || []).flatMap((f) => f.actions || []));
  const addBranch = (key) => {
    if (!key || branches.has(key) || !level.branches?.[key]) return;
    branches.add(key);
    actions.push(...(level.branches[key].phases || []).flatMap((p) => p.actions || []));
  };
  const activate = (p) => {
    if (!p || activated.has(p)) return;
    activated.add(p);
    if (p.inst?.characterKey === 'trap_068_badbox') addBranch(resolveOfficialFacility(p).bb.branch_id);
  };
  for (const p of instances) if (!p.hidden) activate(p);
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!a.key || (a.hiddenGroup && !enabled.has(a.hiddenGroup)) || a.managedByScheduler === false
        || (a.count != null && !(a.count > 0)) || (a.randomSpawnGroupKey && !(a.weight > 0))) continue;
    if (a.actionType === 'ACTIVATE_PREDEFINED') activate(findOfficialPredefined(level, a.key));
    if (a.actionType === 'SPAWN') {
      ids.add(a.key);
      if (a.key === 'enemy_2042_syboss' && supportsMizukiEnemy(a.key)) {
        for (const key of MIZUKI_BOSS_BRANCH_KEYS) addBranch(key);
      }
      if (a.key === 'enemy_2007_flwitch' && supportsMizukiEnemy(a.key)) addBranch('frosts');
    }
  }
  return { ids, supportedBranchKeys: [...branches] };
}

function summonedEnemyIds(record) {
  const source = record?.officialData;
  const bb = [...(source?.talentBlackboard || []), ...(source?.skills || []).flatMap((s) => s.blackboard || [])];
  // AirSupportAtk serializes this exact ID in its prefab, not in a BB string.
  // Still resolve original DB level zero and level runes in the caller.
  const prefab = { enemy_1141_merbow_2: ['enemy_1145_atkspd_2'],
    enemy_1142_mershd_2: ['enemy_1146_defspd_2'],
    enemy_1144_merlgd_2: ['enemy_1145_atkspd_2', 'enemy_1146_defspd_2'] }[record?.key] || [];
  return [...new Set([...prefab, ...bb.flatMap((v) => typeof v.valueStr === 'string'
    ? v.valueStr.match(/enemy_[A-Za-z0-9_]+/g) || [] : [])])];
}

function inspectLevel(stageId, source) {
  const info = sourceStage(stageId); const original = loadLevel(stageId);
  const difficulty = info.difficulty === 'FOUR_STAR' ? 'FOUR_STAR' : 'NORMAL';
  const config = compileOfficialRunes(original, difficulty);
  const level = applyOfficialLevelRunes(original, config);
  const { ids, supportedBranchKeys } = inspectOfficialActionDependencies(level, config.hidden);
  const unsupported = [...config.unsupported];
  const records = new Map();
  for (const ref of level.enemyDbRefs || []) {
    try { records.set(ref.id, enemyRecord(ref, applyOfficialEnemyRunes(ref.id, resolveOfficialEnemy(ref), config), source)); }
    catch (error) { if (ids.has(ref.id)) unsupported.push({ code: 'enemy_data', key: ref.id, detail: error.message }); }
  }
  // Dynamic summons can be absent from enemyDbRefs (e.g. 塑路者's 分形).
  // A missing level override means the original DB's level zero, never a
  // generic unit or an unrelated old-mode definition. Follow only real BB IDs.
  const pending = [...ids];
  for (let at = 0; at < pending.length; at++) for (const child of summonedEnemyIds(records.get(pending[at]))) {
    if (!ids.has(child)) { ids.add(child); pending.push(child); }
    if (records.has(child)) continue;
    try {
      const ref = { id: child, useDb: true, level: 0 };
      records.set(child, enemyRecord(ref, applyOfficialEnemyRunes(child, resolveOfficialEnemy(ref), config), source));
    } catch (error) { unsupported.push({ code: 'enemy_data', key: child, detail: error.message }); }
  }
  for (const id of ids) {
    if (!records.has(id) && !unsupported.some((v) => v.key === id)) unsupported.push({ code: 'enemy_data', key: id });
    if ((Object.hasOwn(BOSS_KITS, id) && !supportsMizukiEnemy(id)) || !known(id)) unsupported.push({ code: 'enemy_behavior', key: id,
      detail: '原关卡特殊敌人行为尚未适配，不以普通攻击替代。' });
  }
  const facilityStatus = inspectOfficialFacilities(level);
  const predefinedIds = facilityStatus.pending.map((p) => p.key);
  const limitations = [];
  if (predefinedIds.length) limitations.push({ code: 'predefined_devices', keys: [...new Set(predefinedIds)],
    detail: '这些预设装置机制尚未适配；原配置保留，战斗试运行不发放替代奖励。' });
  if (facilityStatus.cards.length) limitations.push({ code: 'predefined_cards', keys: [...new Set(facilityStatus.cards)],
    detail: '原始关卡包含未识别的装置卡类型。' });
  for (const key of new Set(predefinedIds)) unsupported.push({ code: 'facility_behavior', key,
    detail: '原预设设施尚未完整适配，不能省略后放行关卡。' });
  for (const key of new Set(facilityStatus.cards)) unsupported.push({ code: 'facility_card', key,
    detail: '未知原装置卡类型，无法解析其部署规则。' });
  // The original flking encounter retains an unused frosts branch copied from
  // the flwitch map: no ice-crystal instance and no owner with SummonFrosts.
  // Preserve that dormant source entry without fabricating a new ice hazard.
  const dormantBranchKeys = stageId === 'ro2_b_10' && ids.has('enemy_2008_flking')
    && !ids.has('enemy_2007_flwitch')
    && ![...(level.predefines?.characterInsts || []), ...(level.predefines?.tokenInsts || [])]
      .some((p) => p.inst?.characterKey === 'trap_010_frosts') ? ['frosts'] : [];
  const pendingBranches = Object.keys(level.branches || {})
    .filter((key) => !supportedBranchKeys.includes(key) && !dormantBranchKeys.includes(key));
  if (pendingBranches.length) limitations.push({ code: 'branches', keys: pendingBranches,
    detail: '关卡条件分支尚未连接原触发条件。' });
  for (const key of pendingBranches) unsupported.push({ code: 'branch_trigger', key,
    detail: '原分支触发条件尚未核实并连接，不以不执行分支的战斗冒充完整关卡。' });
  if (level.globalBuffs?.length) unsupported.push({ code: 'global_buffs', detail: '原全局效果尚未适配。' });
  return { info, level, config, records, unsupported, limitations, supportedBranchKeys, dormantBranchKeys };
}

/** Original battle selector, explicitly a combat trial while exploration is pending. */
export function officialMizukiStageOptions({ data } = {}) {
  const source = toDataSource(data);
  return Object.entries(OFFICIAL.rawTopic.stages).filter(([id]) => sourceEntry(id)).map(([id]) => {
    const result = inspectLevel(id, source);
    const { info, unsupported, limitations } = result;
    return { id, stageId: id, title: info.name, name: info.name, description: info.description,
      type: info.isBoss ? 'boss' : info.isElite ? 'elite' : 'combat',
      difficulty: info.difficulty, levelId: info.levelId, available: !unsupported.length,
      disabled: !!unsupported.length, unavailableReason: unsupported.length
        ? '原关卡机制待适配：' + [...new Set(unsupported.map((v) => v.key || v.code))].join('、') : null,
      unsupported, limitations, source: sourceEntry(id), trial: true };
  });
}

/** balance only changes enemy numerical values; default 1 keeps original stats. */
export function createOfficialMizukiStage(stageId, { data, seed = 1, balance = {} } = {}) {
  const source = toDataSource(data);
  const inspected = inspectLevel(stageId, source);
  if (inspected.unsupported.length) throw new RangeError('Original Mizuki stage is not ready: '
    + stageId + ' (' + inspected.unsupported.map((v) => v.key || v.code).join(', ') + ')');
  const { info, level, records, config, limitations, supportedBranchKeys, dormantBranchKeys } = inspected;
  const accepted = new Set(['maxHp', 'atk', 'def', 'res', 'moveSpeed', 'attackSpeed']);
  for (const [key, value] of Object.entries(balance)) if (!accepted.has(key) || !Number.isFinite(value) || value <= 0) {
    throw new RangeError('Invalid explicit Mizuki balance multiplier: ' + key);
  }
  const enemies = new Map();
  for (const [id, record] of records) {
    for (const key of accepted) if (record.stats[key] != null) {
      record.stats[key] *= balance[key] ?? 1;
      if (key === 'attackSpeed') record.stats.aspd = record.stats[key];
    }
    enemies.set(id, Object.freeze(normalizeEnemy(id, record)));
  }
  const { stage, rect, nativeStage } = translateOfficialMap(stageId, level, info);
  const wrapped = Object.create(source);
  // Only exact source-level enemy definitions are resolved here. No old-stage
  // enemy or fallback chess wave may silently substitute a missing RO2 enemy.
  wrapped.getEnemy = (id) => enemies.get(id) || null;
  wrapped.getStage = (id) => id === stageId ? stage : source.getStage(id);
  const routes = (level.routes || []).map(translateOfficialRoute);
  const officialLevel = { ...clone(level), routes,
    extraRoutes: (level.extraRoutes || []).map(translateOfficialRoute) };
  const o = level.options;
  return { stage, nativeStage, stageId, rect, data: wrapped, routes, spawns: [],
    deployLimit: o.characterLimit, timeLimit: o.maxPlayTime > 0 ? o.maxPlayTime : Infinity,
    flags: { dpInit: o.initialCost, dpMax: o.maxCost, dpPerSec: o.costIncreaseTime > 0 ? config.costRecovery / o.costIncreaseTime : 0 },
    officialRunes: config,
    officialLevel, officialWaveOptions: { enabledHiddenGroups: config.hidden, waveSeed: seed, supportedBranchKeys, dormantBranchKeys },
    stageInfo: { id: stageId, name: info.name, difficulty: info.difficulty, source: sourceEntry(stageId),
      trial: true, balance: { ...balance }, limitations },
    unsupported: [], limitations };
}
