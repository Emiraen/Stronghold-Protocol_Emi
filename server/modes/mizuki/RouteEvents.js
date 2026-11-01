import { readFileSync } from 'node:fs';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { mizukiEndingChoiceAllowed } from './EndingProgression.js';
import { drawMizukiCollectible, mizukiCollectibleSpec } from './Collectibles.js';
export { createMizukiRouteShop, refreshMizukiRouteShop, validMizukiRouteShop } from './RouteShop.js';

const OFFICIAL = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8'));
const SOURCE = JSON.parse(readFileSync(new URL('../../../data/mizuki/route-event-source.json', import.meta.url), 'utf8'));
const topic = OFFICIAL.rawTopic, clone = value => structuredClone(value);
const graphTypeOf = node => node?.graphType || node?.type;
const professions = ['PIONEER', 'WARRIOR', 'TANK', 'SNIPER', 'CASTER', 'SUPPORT', 'MEDIC', 'SPECIAL'];
const ordinal = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
const byIndex = index => SOURCE.events.find(event => event.id === 'prts_ro2_event_' + index);
export const MIZUKI_UNIQUE_ROUTE_EVENTS = Object.freeze([40, 41, 42, 43, 44, 45, 46, 53].map(index => 'prts_ro2_event_' + index));
export const createMizukiRouteEventLedger = () => ({ version: 1, nodes: {}, claims: {} });
export function mizukiUniqueRouteEventForChoice(choiceId) {
  return SOURCE.events.find(event => MIZUKI_UNIQUE_ROUTE_EVENTS.includes(event.id)
    && event.scenes.some(scene => scene.choices.some(choice => choice.id === choiceId)))?.id || null;
}
export function validMizukiRouteEventLedger(value) {
  if (value === undefined) return true;
  if (!value || value.version !== 1 || !value.nodes || typeof value.nodes !== 'object' || Array.isArray(value.nodes)
    || !value.claims || typeof value.claims !== 'object' || Array.isArray(value.claims)
    || Object.keys(value.nodes).length > 1024 || Object.keys(value.claims).length > MIZUKI_UNIQUE_ROUTE_EVENTS.length) return false;
  return Object.entries(value.nodes).every(([nodeId, eventKey]) => nodeId.length > 0 && nodeId.length <= 512
    && SOURCE.events.some(event => event.id === eventKey))
    && Object.entries(value.claims).every(([eventKey, claim]) => MIZUKI_UNIQUE_ROUTE_EVENTS.includes(eventKey)
      && claim && typeof claim.nodeId === 'string' && value.nodes[claim.nodeId] === eventKey
      && (claim.partyId === null || typeof claim.partyId === 'string' && /^party-[1-9][0-9]*$/.test(claim.partyId)));
}
const at = event => Number(event.id.split('_').at(-1));
const random = (node, context, salt) => createRng(deriveSeed(context.seed, node.id + ':event:' + salt));
const roll = (node, context, state, salt) => 1 + random(node, context, state.revision + ':' + salt)
  .int(OFFICIAL.modules.dice.dice[context.diceId]?.diceFaceCount || 6);
const specForNumber = number => Object.keys(SOURCE.relics).find(id => SOURCE.relics[id].number === String(number).padStart(3, '0'));
const resources = { '目标生命上限': 'lifeMax', '目标生命': 'life', '源石锭': 'gold', '希望': 'hope',
  '掷骰次数': 'dice', '钥匙': 'key', '灯火': 'light', '护盾值': 'shield', '护盾': 'shield' };
export const MIZUKI_ROUTE_EVENT_SOURCE = Object.freeze({ id: 'ro2_prts_scene_graph_v2', data: 'data/mizuki/route-event-source.json',
  upstream: SOURCE.source.events, rewardData: 'data/mizuki/rogue2.json:rawTopic.items,relics,choices',
  originalSelection: { dreamOptionalChoices: 3,
    source: 'https://arknights.fandom.com/wiki/Mizuki_%26_Caerula_Arbor/Nodes#Meeting_in_a_Dream',
    rule: 'Only three of the first nine options are available in a single Meeting in a Dream instance, which are chosen randomly.' },
  selection: 'Seeded sampling within original floor and chain restrictions; unpublished original pool weights are not claimed.' });

function choiceEffects(choice) {
  if (choice.displayOnlyDescription) return {};
  const effects = {}, text = choice.description || '';
  for (const match of text.matchAll(/(消耗|获得|回复)(\d+)(目标生命上限|目标生命|源石锭|希望|掷骰次数|钥匙|灯火|护盾值|护盾)/g)) {
    const key = resources[match[3]], value = Number(match[2]) * (match[1] === '消耗' ? -1 : 1);
    effects[key] = (effects[key] || 0) + value;
  }
  for (const match of text.matchAll(/消耗(\d+)希望及等量上限/g)) {
    effects.hopeCapacity = (effects.hopeCapacity || 0) - Number(match[1]);
  }
  if (/获得1掷骰次数，4源石锭/.test(text)) effects.gold = 4;
  if (/获得5源石锭、2目标生命上限和2护盾值/.test(text)) Object.assign(effects, { gold: 5, lifeMax: 2, shield: 2 });
  if (/可携带干员\+1/.test(text)) effects.squadCapacity = 1;
  if (/消耗所有源石锭/.test(text)) effects.allGold = true;
  return effects;
}
function choiceCosts(choice) {
  const text = choice.displayOnlyDescription ? '' : choice.description || '';
  const costs = {};
  for (const match of text.matchAll(/消耗(\d+)(目标生命上限|目标生命|源石锭|希望|掷骰次数|钥匙|灯火|护盾值|护盾)/g)) {
    const key = resources[match[2]]; costs[key] = (costs[key] || 0) + Number(match[1]);
  }
  return costs;
}
function requirements(choice, context, effects = choiceEffects(choice)) {
  if (!mizukiEndingChoiceAllowed(choice.rawId || choice.id, context)) return false;
  const cond = choice.condition || '', text = choice.displayOnlyDescription ? '' : choice.description || '', light = Number(context.light) || 0;
  const costs = choiceCosts(choice);
  // Rewards cannot pay an event's up-front entry cost, including a failed wager.
  for (const key of ['light', 'dice', 'key']) if ((Number(context[key]) || 0) < (costs[key] || 0)) return false;
  if (!(context.players || []).every(player => ['gold', 'hope', 'life', 'shield'].every(key => Number(player[key] || 0) >= (costs[key] || 0))
    && (!(costs.lifeMax > 0) || Number(player.maxLife ?? player.life ?? 0) - costs.lifeMax >= 1))) return false;
  if (/灯火值≥50|不低于50|需要50灯火/.test(cond + text) && light < 50) return false;
  if (/灯火值<50/.test(cond) && light >= 50) return false;
  if (/不低于90/.test(cond) && light < 90) return false;
  if (/达里奥的提灯/.test(text) && /需要/.test(text) && !context.collectibles?.includes('rogue_2_relic_grace_76')) return false;
  if (effects.light < 0 && light < -effects.light || effects.dice < 0 && (context.dice || 0) < -effects.dice
    || effects.key < 0 && (context.key || 0) < -effects.key) return false;
  return (context.players || []).every(player => ['gold', 'hope', 'life'].every(key => !(effects[key] < 0) || Number(player[key] || 0) >= -effects[key])
    && (!(effects.hopeCapacity < 0) || Number(player.hopeCapacity ?? player.hope ?? 0) >= -effects.hopeCapacity)
    && (!(effects.lifeMax < 0) || Number(player.maxLife ?? player.life ?? 0) + effects.lifeMax >= 1));
}
function eventEligible(event, context, node) {
  const index = at(event), floor = Math.max(1, Math.min(6, Number(context.floor) || 1));
  const claim = context.eventLedger?.claims?.[event.id];
  if (claim && (claim.nodeId !== node?.id || claim.partyId && claim.partyId !== context.partyId)) return false;
  if (event.floors[0] && !event.floors.includes(ordinal[floor])) return false;
  if (index === 31 && !context.collectibles?.some(id => [specForNumber(195), specForNumber(205)].includes(id))) return false;
  if (index >= 40 && index <= 46) return event.scenes[0].choices.some(choice => {
    const itemId = topic.choices[choice.id]?.displayData?.itemId;
    // Resource/leave alternatives stay usable once this story is encountered,
    // but cannot cause a later story to spawn before its relic/history gate.
    return topic.items[itemId]?.type === 'RELIC' && mizukiEndingChoiceAllowed(choice.id, context);
  });
  return true;
}
function initialDefinition(node, context) {
  const reserved = SOURCE.events.find(event => event.id === context.eventLedger?.nodes?.[node.id]);
  const claim = reserved && context.eventLedger?.claims?.[reserved.id];
  if (reserved && (!claim || !claim.partyId || claim.partyId === context.partyId)) return reserved;
  const replay = !!reserved && !!claim?.partyId && claim.partyId !== context.partyId;
  let type = graphTypeOf(node), fixed = { REST: 47, WISH: 49, SACRIFICE: 50, EXPEDITION: 51, PORTAL: 52, MISSION: 53 }[type];
  if (fixed === 53 && !eventEligible(byIndex(53), context, node)) { type = 'INCIDENT'; fixed = null; }
  if (fixed) return byIndex(fixed);
  const indices = type === 'ENTERTAINMENT' ? [18, 23, 48] : Array.from({ length: 46 }, (_, i) => i + 1).filter(i => ![18, 23].includes(i));
  const pool = indices.map(byIndex).filter(event => event && (!replay || !MIZUKI_UNIQUE_ROUTE_EVENTS.includes(event.id))
    && eventEligible(event, context, node));
  return random(node, context, 'selection').pick(pool.length ? pool : [byIndex(1)]);
}
function stateFor(node, context) {
  if (context.event?.state) return clone(context.event.state);
  const event = initialDefinition(node, context), state = { eventKey: event.id, sceneIndex: 0, revision: 0, history: [], restUsed: [] };
  if (at(event) === 31) state.sceneIndex = context.collectibles?.includes(specForNumber(195)) ? 1 : 2;
  if (at(event) === 18) {
    const choices = event.scenes[0].choices;
    state.dreamChoices = [...choices.filter(choice => choice.item === 'leave').map(choice => choice.id),
      ...random(node, context, 'dream-options').shuffle(choices.filter(choice => choice.item !== 'leave').map(choice => choice.id)).slice(0, 3)];
  }
  if (at(event) === 43) {
    const choices = event.scenes[0].choices, garden = choices.find(choice => choice.label === '搜寻园林');
    state.searchChoices = [garden?.id, ...random(node, context, 'heart-search-options')
      .shuffle(choices.filter(choice => choice !== garden).map(choice => choice.id)).slice(0, 3)].filter(Boolean);
  }
  if (at(event) === 47) state.restChoices = [event.scenes[0].choices[0].id,
    ...random(node, context, 'rest').shuffle(event.scenes[0].choices.slice(1).map(choice => choice.id)).slice(0, 3)];
  if (at(event) === 49) {
    const owned = [...(context.collectibles || [])], rng = random(node, context, 'wish');
    state.wishRelics = Array.from({ length: 3 + (context.extraWishChoice ? 1 : 0) + (context.extraWishChoices || 0) }, (_, i) => {
      const id = drawMizukiCollectible({ rng, owned, bankRecord: context.bankRecord || 0, cognition: context.cognition, ...(i === 0 ? { rarity: 1 } : {}) });
      if (id) owned.push(id); return id;
    }).filter(Boolean);
  }
  if (at(event) === 53) state.missionIds = ['SUPER_RARE', 'RARE', 'NORMAL'].map(rarity =>
    random(node, context, 'mission:' + rarity).pick(Object.values(topic.taskData).filter(task => task.taskRarity === rarity
      && !(context.activeMissionIds || []).includes(task.taskId)))?.taskId);
  return state;
}
function displayChoices(definition, state, node, context) {
  const index = at(definition), scene = definition.scenes[state.sceneIndex];
  if (state.purifyPending) {
    const choices = (context.players || []).flatMap(player => (player.routeConsumables?.rogue_2_custom_ticket_purify || 0) > 0
      ? player.roster.filter(unit => unit.mutationId).map(unit => ({ id: 'purify:' + player.playerId + ':' + unit.uid,
        label: '抑制' + (unit.name || unit.operatorId) + '的排异反应', description: '移除此干员的排异反应。',
        available: true, playerId: player.playerId, uid: unit.uid })) : []);
    return [...choices, { id: 'purify:skip', label: '放弃抑制排异反应', description: '继续探索', available: true }];
  }
  let choices = scene.choices.filter(choice => choice.kind !== 'guide');
  if (index === 18 && state.sceneIndex === 0) choices = choices.filter(choice => !state.dreamChoices || state.dreamChoices.includes(choice.id));
  if (index === 43 && state.sceneIndex === 0) choices = choices.filter(choice => !state.searchChoices || state.searchChoices.includes(choice.id));
  if (index === 47) {
    if (state.sceneIndex === 0) choices = choices.filter(choice => state.restChoices.includes(choice.id) && !state.restUsed.includes(choice.id));
    else choices = choices.filter(choice => choice.id !== 'choice_ro2_rest_7' || context.extraRestChoice && state.restUsed.length === 1);
  }
  if (index === 49 && state.sceneIndex === 0) choices = state.wishRelics.map((id, i) => ({ id: 'choice_ro2_wish_' + (i + 1),
    label: (i >= 3 ? '从桌子底下' : '') + '取走这条贴着许愿条的鳞鱼', description: mizukiCollectibleSpec(id).name + '：'
      + mizukiCollectibleSpec(id).description + '\n投一次骰子，不消耗掷骰次数。', displayOnlyDescription: true,
    rawId: 'choice_ro2_wish_' + (i + 1), relicId: id, dest: '1' }));
  if (index === 50 && state.sceneIndex === 1) choices = (context.collectibles || []).filter(id => mizukiCollectibleSpec(id)?.canSacrifice)
    .map(id => ({ id: 'sacrifice:' + id, label: mizukiCollectibleSpec(id).name, description: '交出这件收藏品，换取一件'
      + (mizukiCollectibleSpec(id).rarity >= 2 ? '高' : '中') + '稀有度收藏品。', relicId: id }));
  if (index === 51 && state.sceneIndex === 0) {
    choices = choices.filter(choice => choice.id !== 'choice_ro2_expedition_1');
    for (const player of context.players || []) for (const unit of player.roster || []) if (!unit.expedition)
      choices.unshift({ id: 'expedition:' + player.playerId + ':' + unit.uid, label: '由' + (unit.name || unit.operatorId) + '运送',
        description: '本层结束后归来并带回物资。', playerId: player.playerId, uid: unit.uid, dest: '1' });
  }
  if (index === 53 && state.sceneIndex === 0) choices = choices.flatMap(choice => {
    const taskIndex = Number(choice.id.split('_').at(-1)) - 1, task = topic.taskData[state.missionIds[taskIndex]];
    if (task) return [{ ...choice, taskId: task.taskId, displayOnlyDescription: true,
      description: task.taskName + '：' + String(task.taskDesc).replace(/<[^>]*>/g, '') }];
    return choice.item === 'leave' ? [choice] : [];
  });
  if (index === 13 && state.sceneIndex === 1) choices = random(node, context, 'files').shuffle([...choices]).slice(0, 2 + random(node, context, 'files-count').int(2));
  if (index === 22) {
    if (state.sceneIndex === 0) choices = choices.filter(choice => choice.id !== (context.light >= 50 ? 'choice_ro2_suit_2' : 'choice_ro2_suit_1'));
    if (state.sceneIndex === 2) choices = choices.filter(choice => choice.id !== ((context.players || []).some(player => player.roster?.some(unit => !unit.promotion)) ? 'choice_ro2_suit_6' : 'choice_ro2_suit_4'));
  }
  if (index === 27 && state.sceneIndex === 0) choices = choices.filter(choice => choice.id !== 'choice_ro2_10_1' || Number(choice.dest) === (context.light >= 50 ? 1 : 3));
  if (index === 26 && state.sceneIndex === 1) {
    const optional = choices.filter(choice => /随机出现/.test(choice.condition));
    const selected = random(node, context, 'faith-options').shuffle([...optional]).slice(0, random(node, context, 'faith-count').int(3));
    choices = [...selected, ...choices.filter(choice => !optional.includes(choice))];
  }
  if (index === 31 && state.sceneIndex === 0) choices = choices.filter(choice => context.collectibles?.includes(specForNumber(choice.id === 'choice_ro2_liar2_1' ? 195 : 205)));
  const unique = new Map();
  for (const choice of choices) if (!unique.has(choice.id)) unique.set(choice.id, { ...choice, available: requirements(choice, context), sourceChoiceId: choice.rawId || choice.id });
  if (!unique.size) unique.set('choice_leave', { id: 'choice_leave', label: '离开', description: '继续探索', available: true, sourceChoiceId: 'choice_leave' });
  return [...unique.values()];
}
export function createMizukiRouteEvent(node, context = {}) {
  if (!node?.id) throw TypeError('A route node is required');
  const state = stateFor(node, context), definition = SOURCE.events.find(event => event.id === state.eventKey);
  if (!definition || !Number.isInteger(state.sceneIndex) || !definition.scenes[state.sceneIndex]) throw TypeError('Invalid RO2 scene');
  const scene = definition.scenes[state.sceneIndex];
  return { version: 2, id: node.id, graphType: graphTypeOf(node), sceneId: scene.id, title: scene.title, description: scene.description,
    backgroundId: scene.backgroundId, state, choices: displayChoices(definition, state, node, context), unsupported: false, limited: false,
    source: { ...clone(MIZUKI_ROUTE_EVENT_SOURCE), eventKey: definition.id, sceneId: scene.id } };
}
function randomRelic(node, context, state, salt, options = {}) {
  return drawMizukiCollectible({ rng: random(node, context, state.revision + ':' + salt), owned: context.collectibles || [],
    bankRecord: context.bankRecord || 0, cognition: context.cognition, ...options });
}

// Native treasure actions and thresholds are exact. The server-only contents
// weights are not shipped; absent saved contents, use the mode's established
// ordinary collectible pool. Persist contents before showing the choice.
export function createMizukiDriftingCache(context = {}) {
  const item = topic.items.rogue_2_treasure;
  const contents = Array.isArray(context.contents) ? [...context.contents]
    : [drawMizukiCollectible({ rng: context.rng, owned: context.collectibles || [],
      bankRecord: context.bankRecord || 0, cognition: context.cognition })].filter(Boolean);
  return { version: 2, id: context.id || item.id, graphType: 'TREASURE', title: item.name,
    description: item.usage, iconId: item.iconId, contents,
    choices: topic.treasures[item.id].map(choice => ({ id: choice.treasureId, label: choice.name, description: choice.usage,
      available: choice.subIndex === 0 ? context.key >= 1 : choice.subIndex === 1 ? context.dice >= 1 : true })) };
}
export function planMizukiDriftingCache(context = {}) {
  const choice = topic.treasures.rogue_2_treasure.find(value => value.treasureId === context.choiceId);
  if (!choice || context.opened || context.cognition && !context.cognition.driftingCacheUnlocked
    || choice.subIndex === 0 && !(context.key >= 1) || choice.subIndex === 1 && !(context.dice >= 1)) return { ok: false };
  const plan = { ok: true, keyCost: choice.subIndex === 0 ? topic.gameConst.chestKeyCnt : 0,
    diceCost: choice.subIndex === 1 ? 1 : 0, relics: [], items: [], effects: {}, complete: true };
  if (choice.subIndex === 2) return plan;
  if (choice.subIndex === 1) {
    const faces = OFFICIAL.modules.dice.dice[context.diceId]?.diceFaceCount || 6;
    plan.roll = 1 + Math.floor(context.rng() * faces);
    if (plan.roll < 5) { plan.effects.gold = 2; return plan; }
  }
  const cache = createMizukiDriftingCache(context);
  if (cache.contents.some(id => !mizukiCollectibleSpec(id))) return { ok: false };
  plan.relics = [...cache.contents];
  return plan;
}
export function planMizukiRouteEventChoice(node, context = {}) {
  let event; try { event = createMizukiRouteEvent(node, context); } catch { return { ok: false }; }
  const choice = event.choices.find(value => value.id === context.choiceId);
  if (!choice || !choice.available) return { ok: false };
  const state = clone(event.state), definition = SOURCE.events.find(value => value.id === state.eventKey), index = at(definition);
  if (context.wishDecision != null && (!['accept', 'reroll'].includes(context.wishDecision) || index !== 49 || state.sceneIndex !== 0)) return { ok: false };
  if (context.wishDecision === 'reroll' && (!context.cognition?.wishRerollEnabled || !(context.dice >= 1) || state.wishRerolled)) return { ok: false };
  if (state.purifyPending) {
    const plan = { ok: true, choiceId: choice.id, effects: {}, relics: [], items: [],
      purify: choice.uid ? { playerId: choice.playerId, uid: choice.uid } : { skip: true } };
    if (state.resumeState) plan.event = createMizukiRouteEvent(node, { ...context, event: { state: state.resumeState } });
    else plan.complete = true;
    return plan;
  }
  const text = choice.displayOnlyDescription ? '' : choice.description || '';
  const effects = choiceEffects(choice), relics = [], items = [], plan = { ok: true, choiceId: choice.rawId || choice.id, effects, relics, items };
  const raw = topic.choices[choice.rawId || choice.id], itemId = raw?.displayData?.itemId;
  const addRelic = id => { if (id && (id !== 'rogue_2_relic_grace_63' || !context.cognition || context.cognition.duckBrickUnlocked)
    && (!context.collectibles?.includes(id) || mizukiCollectibleSpec(id)?.stackable) && !relics.includes(id)) relics.push(id); };
  const addRandom = options => addRelic(randomRelic(node, context, state, choice.id + ':' + relics.length,
    { ...options, owned: [...(context.collectibles || []), ...relics] }));
  if (itemId && topic.items[itemId]?.type === 'RELIC'
    && (itemId !== 'rogue_2_relic_grace_63' || !context.cognition || context.cognition.duckBrickUnlocked)) addRelic(itemId);
  if (choice.kind === 'collection') addRelic(specForNumber(choice.item));
  if (itemId && /^(?:RECRUIT|UPGRADE)_TICKET$/.test(topic.items[itemId]?.type)) items.push({ id: itemId, count: 1 });
  if (choice.kind === 'item' && !items.length) { const item = Object.values(topic.items).find(value => value.name === choice.item);
    if (item && (item.id !== 'rogue_2_treasure' || !context.cognition || context.cognition.driftingCacheUnlocked)) items.push({ id: item.id, count: 1 }); }
  if (/招募一名干员（从随机2个职业中选择）/.test(text)) plan.recruitProfessions = random(node, context, state.revision + ':professions').shuffle([...professions]).slice(0, 2);
  if (/随机收藏品/.test(text) && !/可能|诅咒/.test(text) && !(index === 30 && choice.id === 'choice_ro2_liar1_1')) addRandom();
  if (/随机诅咒收藏品/.test(text)) addRandom({ kind: 'curse' });
  if (/一件随机收藏品和一件随机诅咒收藏品/.test(text)) addRandom();
  let dest = choice.dest === '' || choice.dest == null ? null : Number(choice.dest), complete = choice.id === 'choice_leave';
  if (index === 7 && choice.id === 'choice_ro2_trade3_1') addRandom({ kind: random(node, context, 'scholar').chance(0.5) ? 'normal' : 'curse' });
  if (index === 8 && choice.id === 'choice_ro2_2_1') addRandom({ ids: [specForNumber(81), specForNumber(82)] });
  if (index === 11 && choice.id === 'choice_ro2_1_1') addRandom({ ids: [specForNumber(79), specForNumber(80)] });
  if (index === 3 && choice.id === 'choice_ro2_recruit1_3') { plan.roll = roll(node, context, state, choice.id); if (plan.roll > 5) items.push({ id: 'rogue_2_recruit_ticket_all', count: 1 }); }
  if (index === 23 && [1, 2].includes(state.sceneIndex) && choice.item !== 'leave') {
    const cost = state.sceneIndex === 1 ? 3 : 10, reward = state.sceneIndex === 1 ? 8 : 25;
    effects.gold = -cost + (random(node, context, state.revision + ':work').chance(state.sceneIndex === 1 ? 0.7 : 0.5) ? reward : 0);
  }
  if (index === 25 && choice.id === 'choice_ro2_8_3' && !random(node, context, state.revision + ':feeding').chance(0.5)) dest = 3;
  if (index === 26 && choice.item !== 'leave' && state.sceneIndex <= 1) {
    const threshold = /检定>(\d+)/.exec(choice.description)?.[1] || 5; plan.roll = roll(node, context, state, choice.id);
    if (plan.roll > Number(threshold)) { addRandom({ rarity: 2 }); dest = 7; } else dest = state.sceneIndex === 0 ? 1 : 5;
  }
  if (index === 27 && state.sceneIndex === 1) addRandom({ kind: choice.id === 'choice_ro2_10_4' ? 'fight' : 'grace' });
  if (index === 29 && ['choice_ro2_king_1', 'choice_ro2_king_3'].includes(choice.id)) {
    plan.roll = roll(node, context, state, choice.id); if (plan.roll > 5) { addRandom({ kind: 'king' }); dest = 3; } else dest = 1;
  }
  if (index === 30 && choice.id === 'choice_ro2_liar1_1') { plan.roll = roll(node, context, state, choice.id); addRelic(specForNumber(195)); addRandom({ rarity: plan.roll > 5 ? 2 : 0 }); }
  if (index === 40 && choice.id === 'choice_ro2_bossa1_2') { plan.roll = roll(node, context, state, choice.id); if (plan.roll > 1) { addRelic('rogue_2_relic_grace_83'); dest = 1; } else dest = 3; }
  if (index === 47 && state.sceneIndex === 0) state.restUsed.push(choice.id);
  if (index === 48 && [0, 8].includes(state.sceneIndex) && choice.item !== 'leave') dest = random(node, context, state.revision + ':printer').pick([2, 3, 4, 5, 6, 7]);
  if (index === 48 && [6, 7].includes(dest)) { if (dest === 7) effects.gold = (effects.gold || 0) + 7; dest = dest === 7 ? null : 8; }
  if (index === 49 && state.sceneIndex === 0) {
    const wishRerolled = context.wishRerolled || context.wishDecision === 'reroll';
    const originalRoll = roll(node, context, state, choice.id);
    if (context.wishDecision === 'reroll' && originalRoll !== 1) return { ok: false };
    plan.roll = wishRerolled ? roll(node, context, state, choice.id + ':reroll') : originalRoll;
    if (wishRerolled) { state.wishRerolled = true; plan.diceCost = 1; plan.wishRerolled = true; }
    if (plan.roll === 1) addRandom(); else addRelic(choice.relicId); if (plan.roll >= 6) addRandom();
    if (plan.roll === 1 && !state.wishRerolled && context.cognition?.wishRerollEnabled && context.wishDecision !== 'accept')
      return { ok: true, choiceId: choice.id, effects: {}, relics: [], items: [], roll: 1,
        pendingWish: { choiceId: choice.id, roll: 1, votes: {}, rerolls: 0 } };
    delete state.pendingWish;
  }
  if (index === 50 && choice.id.startsWith('sacrifice:')) { plan.removeRelics = [choice.relicId]; addRandom({ rarity: mizukiCollectibleSpec(choice.relicId).rarity >= 2 ? 2 : 1 }); dest = 4; }
  if (index === 51 && choice.id.startsWith('expedition:')) plan.expedition = { playerId: choice.playerId, uid: choice.uid };
  if (index === 53 && choice.taskId) plan.taskId = choice.taskId;
  plan.goldSpent = effects.allGold
    ? (context.players || []).reduce((total, player) => total + Math.max(0, Number(player.gold) || 0), 0)
    : Math.max(choiceCosts(choice).gold || 0, -(effects.gold || 0)) * (context.players?.length || 1);
  if (raw?.type === 'TELEPORT') plan.teleport = true;
  if (/进入战斗/.test(choice.label)) {
    const stages = { 31: ['ro2_ev_1'], 32: ['ro2_ev_2'], 33: ['ro2_e_1_1', 'ro2_e_1_2', 'ro2_e_1_3', 'ro2_e_1_4'], 34: ['ro2_ev_3'],
      35: ['ro2_t_1'], 36: ['ro2_t_2'], 37: ['ro2_t_3'], 38: ['ro2_t_4'], 39: ['ro2_t_5'] };
    plan.battleStageId = random(node, context, state.revision + ':battle').pick((stages[index] || []).filter(id => topic.stages[id]));
  }
  state.history.push(choice.id); state.revision++;
  if (state.history.length > 512 || dest == null || !definition.scenes[dest]) complete = true;
  else { state.sceneIndex = dest; if (!definition.scenes[dest].choices.length) complete = true; }
  if (complete) plan.complete = true; else plan.event = createMizukiRouteEvent(node, { ...context, event: { state } });
  return plan;
}
export function rerollMizukiRouteWish(node, context = {}) {
  if (!context.cognition?.wishRerollEnabled || !(context.dice >= 1) || context.event?.state?.wishRerolled) return { ok: false };
  const original = planMizukiRouteEventChoice(node, { ...context, wishDecision: undefined });
  if (!original.ok || !original.pendingWish) return { ok: false };
  const plan = planMizukiRouteEventChoice(node, { ...context, wishDecision: 'reroll' });
  if (!plan.ok) return plan;
  return { ...plan, diceCost: 1, pendingWish: null, wishRerolled: true };
}
export function validMizukiRouteEvent(event, node, context = {}) {
  if (!event || !event.state || !Array.isArray(event.state.history) || event.state.history.length > 512 || event.state.revision !== event.state.history.length || event.id !== node?.id) return false;
  const pending = event.state.pendingWish;
  if (pending) {
    if (event.state.eventKey !== 'prts_ro2_event_49' || event.state.sceneIndex !== 0 || event.state.wishRerolled
      || !context.cognition?.wishRerollEnabled || pending.roll !== 1 || pending.rerolls !== 0
      || !pending.votes || typeof pending.votes !== 'object' || Array.isArray(pending.votes)
      || Object.keys(pending).some(key => !['choiceId', 'roll', 'votes', 'rerolls'].includes(key))
      || Object.entries(pending.votes).some(([id, vote]) => !['accept', 'reroll'].includes(vote)
        || !(context.players || []).some(player => player.playerId === id))) return false;
    const original = planMizukiRouteEventChoice(node, { ...context, event, choiceId: pending.choiceId, wishDecision: undefined });
    if (!original.ok || !original.pendingWish) return false;
  }
  try {
    const canonical = createMizukiRouteEvent(node, { ...context, event });
    // Other parties can change shared resources while this scene is open. Restore
    // re-derives current choices rather than trusting stale availability/price text.
    return ['version', 'id', 'graphType', 'sceneId', 'title', 'description', 'backgroundId', 'state'].every(key => JSON.stringify(canonical[key]) === JSON.stringify(event[key]));
  } catch { return false; }
}
