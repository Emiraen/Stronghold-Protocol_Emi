// RO2 regional commissions: rawTopic.taskData / taskreward choices and PRTS
// 水月肉鸽 revision 441598, 地区委托. Rewards use the original three-choice
// category pools; the original server's unpublished pool weights are not claimed.
import { readFileSync } from 'node:fs';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { drawMizukiCollectible, mizukiCollectibleSpec } from './Collectibles.js';

const topic = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic;
const clean = text => String(text || '').replace(/<[^>]*>/g, '');
const tasks = topic.taskData;
const target = [0, 4, 4, 15, 3, 6, 2, 2, 2, 2, 50, 3, 1, 20, 10, 1, 2, 2, 1, 1];
const number = taskId => Number(taskId.split('_').at(-1));
const tier = taskId => ({ NORMAL: 1, RARE: 2, SUPER_RARE: 3 }[tasks[taskId].taskRarity]);
const excludes = { 6: ['TANK', 'WARRIOR'], 7: ['CASTER', 'SNIPER'], 8: ['MEDIC', 'SUPPORT'], 9: ['PIONEER', 'SPECIAL'] };
const relevant = (mission, memberIds) => !memberIds || mission.memberIds.some(id => memberIds.includes(id));
const rngFor = (seed, id, salt) => createRng(deriveSeed(seed, 'mission:' + id + ':' + salt));
export const createMizukiRouteMissions = () => ({ version: 1, sequence: 0, missions: [] });

export function acceptMizukiRouteMission(state, { taskId, nodeId, memberIds, extraReward = false, seed = 1 } = {}) {
  if (!tasks[taskId] || typeof nodeId !== 'string' || !nodeId || !Array.isArray(memberIds) || !memberIds.length
    || state.sequence >= 1024
    || state.missions.some(mission => mission.nodeId === nodeId || mission.taskId === taskId && mission.status === 'active')) return null;
  const id = 'mzmission:' + (++state.sequence), level = tier(taskId);
  const sample = (stage) => {
    const pool = stage === 0 ? [1, 2, 3, 4, 5] : level === 3 ? [8, 9, 10, 11] : [8, 9, 10, 11, 12];
    return rngFor(seed, id, 'rewards:' + stage).shuffle([...pool]).slice(0, 3).map(value => `choice_ro2_taskreward${level}_${value}`);
  };
  const mission = { id, taskId, nodeId, memberIds: [...new Set(memberIds)], progress: 0, status: 'active',
    extraReward: extraReward === true, rewardChoices: [sample(0), sample(1)], picks: [], claimPartyId: null };
  state.missions.push(mission); return mission;
}

export function advanceMizukiRouteMissions(state, event = {}, { memberIds = null, missionIds = null } = {}) {
  for (const mission of state.missions) {
    if (mission.status !== 'active' || !relevant(mission, memberIds) || missionIds && !missionIds.includes(mission.id)) continue;
    const n = number(mission.taskId); let amount = 0;
    if (n === 1 || n === 2) amount = event.battlesPassed || 0;
    if (n === 3) amount = event.lightGained || 0;
    if (n === 4) amount = event.keysSpent || 0;
    if (n === 5) amount = event.diceSpent || 0;
    if (n >= 6 && n <= 9) amount = event.battlesPassed && !excludes[n].some(profession => event.professions?.includes(profession)) ? event.battlesPassed : 0;
    if (n === 10) amount = event.kills || 0;
    if (n === 11) amount = event.promotions || 0;
    if (n === 12) amount = event.diceUsed && event.diceRoll >= 6 ? 1 : 0;
    if (n === 13) amount = event.seaKills || 0;
    if (n === 14) amount = event.goldSpent || 0;
    if (n === 15) amount = event.combatNodesEntered || 0;
    if (n === 16) amount = event.incidentsEntered || 0;
    if (n === 17) amount = event.newOperators || 0;
    if (n === 18) amount = event.restNodesEntered || 0;
    if (n === 19) amount = event.diceUsed || 0;
    mission.progress = Math.min(target[n], mission.progress + Math.max(0, Math.trunc(amount)));
    if (mission.progress >= target[n]) mission.status = 'complete';
  }
  return state;
}

export function mizukiRouteMissionViews(state) {
  return state.missions.map(mission => ({ id: mission.id, taskId: mission.taskId, memberIds: [...mission.memberIds],
    progress: mission.progress, status: mission.status, extraReward: mission.extraReward, name: tasks[mission.taskId].taskName,
    description: clean(tasks[mission.taskId].taskDesc), target: target[number(mission.taskId)], rarity: tasks[mission.taskId].taskRarity }));
}

export function mizukiRouteMissionBattle(state, memberIds = []) {
  const active = state.missions.filter(mission => mission.status === 'active' && relevant(mission, memberIds));
  return { missionIds: active.map(mission => mission.id), deployDelta: active.some(mission => number(mission.taskId) === 1) ? -2 : 0,
    enemyScale: active.some(mission => number(mission.taskId) === 2) ? 1.3 : 1 };
}

export function installMizukiRouteMissionBattle(battle, options) {
  const stats = { missionIds: [...options.missionIds], kills: 0, seaKills: 0,
    professions: [...new Set(battle.players.flatMap(player => player.units.filter(unit => unit.kind === 'op')
      .map(unit => String(unit.def?.profession || unit.def?.raw?.profession || '').toUpperCase())))] };
  const seen = new WeakSet();
  const apply = enemy => {
    if (!enemy || seen.has(enemy)) return; seen.add(enemy);
    if (options.enemyScale !== 1) battle.addBuff(enemy, { key: 'mizuki:mission:002', allowDead: true, persist: true,
      mods: { hpMul: options.enemyScale, atkMul: options.enemyScale } });
  };
  battle.enemies.forEach(apply);
  battle.on('enemySpawn', ({ enemy }) => apply(enemy), { priority: 18500 });
  battle.on('death', ({ unit, reason }) => {
    if (reason !== 'killed' || unit?.side !== 'enemy' || unit.kind !== 'enemy' || unit._officialFacility) return;
    stats.kills++;
    if (unit.def?.raw?.officialData?.enemyTags?.includes('seamonster') || unit.def?.raw?.enemyTags?.includes('seamonster')) stats.seaKills++;
  }, { priority: -19000 });
  return stats;
}

export function createMizukiMissionRewardEvent(mission, { owned = [] } = {}) {
  if (!mission || !['complete', 'rewarding'].includes(mission.status)) throw TypeError('Commission is not ready');
  const level = tier(mission.taskId), sceneId = `scene_ro2_taskreward${level}_${mission.picks.length ? '2' : 'enter'}`;
  const raw = topic.choiceScenes[sceneId];
  return { version: 1, id: mission.id, missionReward: true, missionId: mission.id, title: raw.title,
    sceneId, description: tasks[mission.taskId].taskName + '：' + raw.description,
    backgroundId: raw.background, votes: {}, choices: mission.rewardChoices[mission.picks.length].map(id => {
      const choice = topic.choices[id], relic = choice.displayData?.itemId;
      return { id, title: choice.title, label: choice.title, description: clean(choice.description)
        + (relic && mizukiCollectibleSpec(relic) ? '：' + mizukiCollectibleSpec(relic).name : ''),
      available: !relic || !owned.includes(relic) || mizukiCollectibleSpec(relic)?.stackable === true };
    }) };
}

export function planMizukiMissionReward(mission, choiceId, { seed = 1, owned = [] } = {}) {
  const event = createMizukiMissionRewardEvent(mission, { owned });
  if (!event.choices.some(choice => choice.id === choiceId && choice.available)) return { ok: false };
  const level = tier(mission.taskId), selection = Number(choiceId.split('_').at(-1));
  const category = selection >= 8 ? selection - 7 + (level === 3 && selection >= 9 ? 1 : 0) : selection;
  const result = { ok: true, effects: {}, relics: [], items: [], recruitProfessions: null };
  const rng = rngFor(seed, mission.id, 'grant:' + mission.picks.length);
  if (category === 1) { const id = drawMizukiCollectible({ rng, owned, ...(level === 3 ? { rarity: 2 } : {}) }); if (id) result.relics.push(id); }
  if (level === 1) Object.assign(result.effects, [{}, {}, { dice: 2 }, { shield: 3 }, { gold: 5 }, { key: 1 }][category]);
  if (level === 2) {
    Object.assign(result.effects, [{}, {}, {}, { lifeMax: 4 }, { gold: 7 }, { hope: 3 }][category]);
    if (category === 2) result.recruitProfessions = rng.shuffle(['PIONEER', 'WARRIOR', 'TANK', 'SNIPER', 'CASTER', 'SUPPORT', 'MEDIC', 'SPECIAL']).slice(0, 2);
  }
  if (level === 3) {
    if (category === 2) result.relics.push(topic.choices.choice_ro2_taskreward3_2.displayData.itemId);
    if (category === 3) { result.effects.hope = 3; result.items.push({ id: 'rogue_2_recruit_ticket_all', count: 1 }); }
    if (category === 4) result.effects.shield = 12;
    if (category === 5) Object.assign(result.effects, { gold: 8, key: 2 });
  }
  return result;
}

export function validMizukiRouteMissions(state, { players = [], seed = 1 } = {}) {
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || state.sequence > 1024
    || !Array.isArray(state.missions) || state.missions.length !== state.sequence) return false;
  const nodes = new Set();
  for (let index = 0; index < state.missions.length; index++) {
    const mission = state.missions[index], n = number(mission?.taskId || '');
    if (!tasks[mission?.taskId] || mission.id !== 'mzmission:' + (index + 1) || typeof mission.nodeId !== 'string' || !mission.nodeId || nodes.has(mission.nodeId)
      || !Array.isArray(mission.memberIds) || !mission.memberIds.length || mission.memberIds.length > 4
      || new Set(mission.memberIds).size !== mission.memberIds.length || mission.memberIds.some(id => !players.includes(id))
      || !Number.isInteger(mission.progress) || mission.progress < 0 || mission.progress > target[n]
      || !['active', 'complete', 'rewarding', 'claimed'].includes(mission.status) || typeof mission.extraReward !== 'boolean'
      || (mission.status === 'active') !== (mission.progress < target[n]) || !Array.isArray(mission.picks)
      || mission.picks.length > (mission.extraReward ? 2 : 1) || !Array.isArray(mission.rewardChoices) || mission.rewardChoices.length !== 2
      || mission.claimPartyId !== null && (typeof mission.claimPartyId !== 'string' || !/^party-[1-9][0-9]*$/.test(mission.claimPartyId))) return false;
    if (['active', 'complete'].includes(mission.status) && (mission.picks.length || mission.claimPartyId !== null)
      || mission.status === 'rewarding' && mission.claimPartyId === null) return false;
    const scratch = createMizukiRouteMissions(); scratch.sequence = index;
    const canonical = acceptMizukiRouteMission(scratch, { ...mission, seed });
    if (JSON.stringify(canonical.rewardChoices) !== JSON.stringify(mission.rewardChoices)
      || mission.picks.some((id, pick) => !mission.rewardChoices[pick]?.includes(id))
      || (mission.status === 'claimed') !== (mission.picks.length === (mission.extraReward ? 2 : 1))
      || mission.status === 'complete' && (mission.picks.length || mission.claimPartyId !== null)) return false;
    nodes.add(mission.nodeId);
  }
  return true;
}
