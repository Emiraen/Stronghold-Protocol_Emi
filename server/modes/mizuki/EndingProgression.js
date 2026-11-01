// RO2 only. Sources: rogue2.json choices/relics/endings and PRTS 水月肉鸽
// revision 441598, 区域/进入方式. endingDetailList contains inherited RO1 text
// and is deliberately not a source for these routes.
import { readFileSync } from 'node:fs';
import { normalizeMizukiDungeon } from './exploration.js';
const topic = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic;
const copy = value => structuredClone(value);
export const MIZUKI_ENDING_IDS = Object.freeze(Object.keys(topic.endings));
export const MIZUKI_ENDING_RELICS = Object.freeze({
  knight: 'rogue_2_relic_grace_83', deadKnight: 'rogue_2_relic_grace_84', knightBlood: 'rogue_2_relic_grace_86',
  research: 'rogue_2_relic_curse_7', heart: 'rogue_2_relic_curse_8', memory: 'rogue_2_relic_curse_9',
  determination: 'rogue_2_relic_grace_88', wait: 'rogue_2_relic_grace_89', hesitation: 'rogue_2_relic_grace_90',
});
const R = MIZUKI_ENDING_RELICS;
const branches = [R.determination, R.wait, R.hesitation];
const endingChoices = Object.freeze({
  choice_ro2_bossa1_1: R.knight, choice_ro2_bossa1_2: R.knight,
  choice_ro2_bossa2_1: 'rogue_2_relic_grace_85', choice_ro2_bossa2_2: R.knightBlood,
  choice_ro2_bossb1_1: R.research, choice_ro2_bossb1_3: R.memory,
  choice_ro2_bossb2_6: R.heart, choice_ro2_bossb3_1: 'rogue_2_relic_grace_87',
  choice_ro2_bossc2_2: 'rogue_2_relic_curse_10',
  choice_ro2_bossc3_1: R.determination, choice_ro2_bossc3_2: R.wait, choice_ro2_bossc3_3: R.hesitation,
});
const unlockIds = values => [...new Set(['ro2_ending_1', ...(Array.isArray(values) ? values : [])])]
  .filter(id => MIZUKI_ENDING_IDS.includes(id));
export function mizukiEndingUnlocksAfter(known, completedEndingId, grade = 0) {
  const ids = unlockIds(known);
  if (grade >= 0 && MIZUKI_ENDING_IDS.includes(completedEndingId)) {
    ids.push('ro2_ending_4');
    if (completedEndingId === 'ro2_ending_1') ids.push('ro2_ending_2');
    if (completedEndingId === 'ro2_ending_2') ids.push('ro2_ending_3');
  }
  return unlockIds(ids);
}
export const createMizukiEndingProgress = () => ({ version: 1, choices: [], battles: [], knightDeaths: [] });
const gained = (progress, relicId) => progress?.choices?.some(choice => choice.relicId === relicId) === true;
const has = (values, id) => values.includes(id);

/** Choice eligibility uses the run's real event history, not a client ending flag. */
export function mizukiEndingChoiceAllowed(choiceId, { floor = 1, light = 0, collectibles = [],
  endingProgress = createMizukiEndingProgress(), endingUnlocks = ['ro2_ending_1'] } = {}) {
  const id = endingChoices[choiceId];
  if (!id) return true;
  const unlocked = unlockIds(endingUnlocks), aliveKnight = gained(endingProgress, R.knight)
    && !endingProgress.knightDeaths.length && !has(collectibles, R.deadKnight);
  if (gained(endingProgress, id)) return false;
  if (id === R.knight) return floor <= 3 && has(unlocked, 'ro2_ending_2');
  if ([R.knightBlood, 'rogue_2_relic_grace_85'].includes(id)) return floor >= 2 && floor <= 4 && aliveKnight;
  if (id === R.research || id === R.memory) return floor <= 3 && has(unlocked, 'ro2_ending_3')
    && !gained(endingProgress, R.research) && !gained(endingProgress, R.memory)
    && (id !== R.memory || has(unlocked, 'ro2_ending_4'));
  if (id === R.heart) return floor >= 4 && floor <= 5 && light >= 20 && gained(endingProgress, R.research);
  if (id === 'rogue_2_relic_grace_87') return floor === 5 && gained(endingProgress, R.heart);
  if (id === 'rogue_2_relic_curse_10') return floor >= 2 && floor <= 4 && gained(endingProgress, R.memory);
  if (branches.includes(id)) return floor >= 4 && floor <= 5 && gained(endingProgress, R.memory)
    && !branches.some(relicId => gained(endingProgress, relicId))
    && (id !== R.determination || light >= 90) && (id !== R.wait || light >= 50);
  return false;
}

export function recordMizukiEndingChoice(progress, { choiceId, nodeId, floor, light, collectiblesBefore = [],
  collectibles = [], endingUnlocks = ['ro2_ending_1'] } = {}) {
  const relicId = endingChoices[choiceId];
  if (!relicId || !collectibles.includes(relicId) || collectiblesBefore.includes(relicId)) return progress;
  if (!mizukiEndingChoiceAllowed(choiceId, { floor, light, collectibles: collectiblesBefore,
    endingProgress: progress, endingUnlocks })) throw new TypeError('Unavailable original Mizuki ending choice');
  return { ...copy(progress), choices: [...progress.choices, { choiceId, relicId, nodeId, floor, light,
    order: progress.choices.length + progress.battles.length }] };
}

export function recordMizukiEndingBattle(progress, { nodeId, stageId, floor, eventBattle = false, cleared = true, knightKilled = false } = {}) {
  const next = copy(progress);
  if (!next.battles.some(battle => battle.nodeId === nodeId)) next.battles.push({ nodeId, stageId, floor, eventBattle, cleared,
    order: next.choices.length + next.battles.length });
  if (knightKilled && gained(next, R.knight) && !next.knightDeaths.length) next.knightDeaths.push(nodeId);
  return next;
}

export function mizukiEndingRoute(progress, collectibles = []) {
  const knight = gained(progress, R.knight) && has(collectibles, R.knight)
    && !progress.knightDeaths.length && !has(collectibles, R.deadKnight);
  const fourth = gained(progress, R.memory) && has(collectibles, R.memory)
    && branches.some(id => gained(progress, id) && has(collectibles, id));
  const third = gained(progress, R.research) && gained(progress, R.heart) && has(collectibles, R.heart);
  return { fifthBossStageId: knight ? 'ro2_b_5' : 'ro2_b_4',
    sixthBossStageId: fourth ? 'ro2_b_7' : third ? 'ro2_b_6' : null,
    endingId: fourth ? 'ro2_ending_4' : third ? 'ro2_ending_3' : knight ? 'ro2_ending_2' : 'ro2_ending_1' };
}
export function mizukiCompletedEnding(progress, collectibles) {
  const route = mizukiEndingRoute(progress, collectibles), stageId = route.sixthBossStageId || route.fifthBossStageId;
  if (!progress.battles.some(battle => battle.cleared && battle.stageId === stageId && battle.floor === (route.sixthBossStageId ? 6 : 5))) return null;
  const raw = topic.endings[route.endingId];
  return { id: raw.id, name: raw.name, desc: raw.desc, bossIconId: raw.bossIconId, backgroundId: raw.bgId, stageId };
}

/** Restore replays every milestone through the same original conditions. */
export function restoreMizukiEndingProgress(value, { collectibles = [], endingUnlocks, dungeon } = {}) {
  const empty = createMizukiEndingProgress();
  if (value == null) {
    if (Object.values(endingChoices).some(id => collectibles.includes(id)) || collectibles.includes(R.deadKnight))
      throw new TypeError('Ending collectibles require original event history');
    return empty;
  }
  if (value.version !== 1 || !Array.isArray(value.choices) || value.choices.length > 32
    || !Array.isArray(value.battles) || value.battles.length > 1024 || !Array.isArray(value.knightDeaths)
    || value.knightDeaths.length > 1) throw new TypeError('Invalid Mizuki ending progression');
  const floors = dungeon ? normalizeMizukiDungeon(dungeon).floors : [];
  const node = id => floors.flatMap(floor => floor.nodes.map(entry => ({ ...entry, floor: floor.ordinaryFloor,
    extraRegion: floor.isExtraRegion }))).find(entry => entry.id === id);
  let progress = empty; const historyRelics = [];
  const receipts = [...value.choices.map(receipt => ({ receipt, kind: 'choice' })),
    ...value.battles.map(receipt => ({ receipt, kind: 'battle' }))].sort((a, b) => a.receipt.order - b.receipt.order);
  for (let index = 0; index < receipts.length; index++) {
    const { receipt, kind } = receipts[index], source = node(receipt?.nodeId);
    if (receipt?.order !== index || !source || source.floor !== receipt.floor)
      throw new TypeError('Invalid Mizuki ending chronology');
    if (kind === 'choice') {
      if (endingChoices[receipt.choiceId] !== receipt.relicId || source.extraRegion
        || !['INCIDENT', 'UNKNOWN'].includes(source.type) || !Number.isInteger(receipt.light)
        || receipt.light < 0 || receipt.light > 100) throw new TypeError('Invalid Mizuki ending milestone');
      progress = recordMizukiEndingChoice(progress, { ...receipt, collectiblesBefore: historyRelics,
        collectibles: [...historyRelics, receipt.relicId], endingUnlocks });
      historyRelics.push(receipt.relicId);
    } else {
      const eventBattle = receipt.eventBattle === true && ['INCIDENT', 'UNKNOWN', 'BATTLE_SHOP', 'WISH', 'REST', 'EXPEDITION', 'PORTAL'].includes(source.type)
        && (/^ro2_(?:ev_[1-3]|t_[1-5]|e_1_[1-4])$/.test(receipt.stageId)
          || source.type === 'BATTLE_SHOP' && /^ro2_ev_[45]$/.test(receipt.stageId));
      const nativeBattle = ['BATTLE_NORMAL', 'BATTLE_ELITE', 'BATTLE_BOSS'].includes(source.type)
        && !receipt.eventBattle && source.stageId === receipt.stageId;
      if ((!nativeBattle && !eventBattle) || !topic.stages[receipt.stageId] || typeof receipt.cleared !== 'boolean'
        || progress.battles.some(entry => entry.nodeId === receipt.nodeId))
        throw new TypeError('Invalid Mizuki ending battle history');
      const knightKilled = value.knightDeaths.includes(receipt.nodeId);
      if (knightKilled && (!gained(progress, R.knight) || receipt.floor >= 5 || source.extraRegion
        || !collectibles.includes(R.deadKnight))) throw new TypeError('Invalid original knight loss');
      progress = recordMizukiEndingBattle(progress, { ...receipt, knightKilled });
    }
  }
  for (const id of new Set(Object.values(endingChoices))) if (collectibles.includes(id) !== historyRelics.includes(id))
    throw new TypeError('Mizuki ending relic does not match its original event');
  if (collectibles.includes(R.deadKnight) !== !!progress.knightDeaths.length)
    throw new TypeError('Mizuki knight state does not match its original battle');
  if (JSON.stringify(progress.knightDeaths) !== JSON.stringify(value.knightDeaths))
    throw new TypeError('Mizuki knight loss requires a recorded original battle');
  return progress;
}

/** Effects are copied from the original relic BBs and remain mode local. */
export function installMizukiEndingRelics(battle, collectibles = []) {
  const blood = collectibles.includes(R.knightBlood), effects = branches.filter(id => collectibles.includes(id));
  const seen = new WeakSet();
  const apply = unit => {
    if (!unit || seen.has(unit)) return;
    seen.add(unit);
    const key = unit.defId;
    if (blood && (key === 'trap_079_allydonq' || key === 'enemy_2038_sydonq'))
      battle.addBuff(unit, { key: 'mizuki:knight-blood', mods: { defPct: -0.8 }, persist: true, allowDead: true });
    if (unit.side !== 'ally' || unit.kind !== 'op') return;
    for (const id of effects) {
      if (id === R.hesitation) unit.mem.blockCntFloor = Math.max(1, unit.mem.blockCntFloor || 0);
      const mods = id === R.determination ? { blockCnt: 2, hpPct: 1.2, defPct: 1.2, resFlat: 20 }
        : { blockCnt: id === R.wait ? 1 : -1 };
      battle.addBuff(unit, { key: 'mizuki:ending:' + id, mods, persist: true, allowDead: true });
    }
  };
  battle.allyUnits.forEach(apply); battle.enemies.forEach(apply);
  battle.on('deploy', ({ unit }) => apply(unit), { priority: 19000 });
  battle.on('enemySpawn', ({ enemy }) => apply(enemy), { priority: 19000 });
}
