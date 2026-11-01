// Official-data Mizuki combat subset: Stronghold preparation and automatic duo fields.
// Exploration uses original visible rules and explicit cooperative-mode drop parameters.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ERR, EMOTES, EMOTE_COOLDOWN_MS, layerGainRoom, canStackBond, clearNonStackingBondLayers } from '../../../shared/constants.js';
import { MIZUKI_VARIANT, MIZUKI_MODE_ID, MIZUKI_PHASES as PHASE, MIZUKI_TITLE } from '../../../shared/mizuki-constants.js';
import { RealScheduler } from '../../match/scheduler.js';
import { markSend } from '../../sendMetadata.js';
import { GAME_SPEED, INTERVAL_MS, maxTicksPerInterval } from '../../match/fields.js';
import { TICK } from '../../sim/constants.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { MizukiAutoCombat } from './Combat.js';
import { mizukiBattleDamageRows } from './BattleHud.js';
import { createMizukiAutoplay } from './Autoplay.js';
import { mizukiInitialSupplyOptions, mizukiInitialSupplyReward } from './InitialSupply.js';
import { createMizukiCatalog, MIZUKI_RECRUIT_RULES, MIZUKI_PROFESSIONS } from './catalog.js';
import { createMizukiExplorationState, restoreMizukiExplorationState, mizukiExplorationView,
  mizukiExplorationChoices, mizukiRouteChoiceView, completeMizukiExplorationNode, normalizeMizukiDungeon } from './exploration.js';
import { MIZUKI_SQUADS, MIZUKI_SQUAD_TIERS, MIZUKI_RECRUIT_GROUPS } from '../../../shared/mizuki-squads.js';
import { normalizeCognition, cognitionEffects, resolvedSquad, mizukiExplorationScoreBreakdown, MIZUKI_COGNITION_MAX_SCORE } from './Cognition.js';
import { GameData } from '../../match/gamedata.js';
import { computeBonds, pieceBonds } from '../../match/bondsMeta.js';
import { SharedPool } from '../../match/pool.js';
import { MatchSpDraft } from '../../match/match/spDraft.js';
import { getDefaultRegistry } from '../../match/effectsMeta.js';
import { officialMizukiStageOptions, createOfficialMizukiStage } from './official-stages.js';
import { Grid } from '../../sim/grid.js';
import { generateMizukiDungeon, applyMizukiEndingRoute, generateMizukiPortalZone,
  MIZUKI_ROUTE_GENERATOR, MIZUKI_ROUTE_SOURCE_LABEL } from './RouteGeneration.js';
import { enterMizukiPortalExploration, leaveMizukiPortalExploration } from './exploration.js';
import { MIZUKI_ENDING_IDS, MIZUKI_ENDING_RELICS, createMizukiEndingProgress, mizukiEndingRoute,
  mizukiCompletedEnding, mizukiEndingUnlocksAfter, recordMizukiEndingChoice, recordMizukiEndingBattle, restoreMizukiEndingProgress,
  installMizukiEndingRelics } from './EndingProgression.js';
import { createMizukiRouteEvent, planMizukiRouteEventChoice, validMizukiRouteEvent, createMizukiRouteShop,
  refreshMizukiRouteShop, validMizukiRouteShop, createMizukiDriftingCache, planMizukiDriftingCache,
  MIZUKI_UNIQUE_ROUTE_EVENTS, createMizukiRouteEventLedger, validMizukiRouteEventLedger, mizukiUniqueRouteEventForChoice } from './RouteEvents.js';
import { mizukiCollectibleSpec, mizukiCollectibleImmediateRewards, drawMizukiCollectible } from './Collectibles.js';
import { mizukiBattleBaseReward, mizukiBattleNativeDrops, mizukiBattleRelicDrops, mizukiBattleFieldDrops, mizukiBattleDriftingCacheDrop } from './BattleRewards.js';
import { syncMizukiPrep, mizukiPrepView, mizukiPrepInput, moveMizukiPrep, validMizukiPrep, mizukiOperatorPiece, mizukiPrepFacilityBlocks } from './Prep.js';
import { pairPlayers } from '../../match/finalAssault.js';
import { MizukiTeamExpedition } from './TeamExpedition.js';
import { planUnite, uniteBattleOpts, uniteRemainingLeaks } from '../../match/unite.js';
import { uniteLpExempt } from '../../../shared/uniteBilling.js';
import { dismissMizukiOperator, preserveMizukiEquipment, canDismissMizukiOperator,
  validMizukiRosterProgression } from './RosterProgression.js';
import { createMizukiRecruitTicket, validMizukiRecruitTicket, openMizukiRecruitTicket,
  mizukiRecruitOfferId, mizukiRecruitRefreshId, mizukiRecruitSkipId, planMizukiRecruitment,
  applyMizukiRecruitProgress, consumeMizukiRecruitTicket, refreshMizukiRecruitTicket,
  skipMizukiRecruitTicket, validMizukiRecruitProgress, grantMizukiRecruitRefreshes, mizukiInitialRecruitTicketSpecs } from './Recruitment.js';
import { planMizukiDirectPromotion, planMizukiOperatorGain, materializeMizukiRecruitCopies } from './Recruitment.js';
import { dispatchMizukiRecruitRefresh, dispatchMizukiRecruitPromotion } from './RecruitmentMeta.js';
import { grantMizukiEconomicHope, validMizukiEconomy } from './Economy.js';
import { grantMizukiEquipment, equipMizukiEquipment, dispatchMizukiEquipmentMeta,
  grantMizukiBattleEquipment, validMizukiEquipmentState, mizukiEquipmentDeployLimit, mizukiEquipmentItemView } from './Equipment.js';
import { dispatchMizukiNativeMeta } from './NativeMeta.js';
import { mizukiDifficultyOptions, mizukiDifficultyInitial, mizukiDifficultyLight, validMizukiDifficulty,
  mizukiDifficultyHopeDelta, mizukiDifficultyDeployDelta, mizukiDifficultyCursePool, mizukiCollectibleEffects, MIZUKI_INITIAL_DICE,
  mizukiCommanderProgress, validMizukiCommander, mizukiCommanderNextExp, mizukiCommanderLevelRewards } from './Difficulty.js';
import { validMizukiMutation, mizukiMutationPool, createMizukiMutationState, validMizukiMutationState,
  createMizukiSanCheck, validMizukiSanCheck, commitMizukiSanCheck, rerollMizukiSanCheck } from './NativeMutations.js';
import { applyMizukiEvolutionReward } from './NativeInfection.js';
import { mizukiVirtueSpec } from './NativeBlessings.js';
import { applyMizukiRunLoadout, validMizukiRunLoadout, mizukiRunLoadoutView } from './RunLoadout.js';
import { validMizukiRouteInventory } from './ActiveTools.js';
import { mizukiBankAccount, mizukiBankView, planMizukiBankTransaction } from './Bank.js';
import { updateMizukiRouteShopBank } from './RouteShop.js';
import { createMizukiRouteMissions, acceptMizukiRouteMission, advanceMizukiRouteMissions, mizukiRouteMissionViews,
  mizukiRouteMissionBattle, installMizukiRouteMissionBattle, createMizukiMissionRewardEvent, planMizukiMissionReward,
  validMizukiRouteMissions } from './RouteMissions.js';
import { MIZUKI_VARIATION_IDS, mizukiVariationSpec } from './Variations.js';
import { mizukiStrategyStartingLife, mizukiStrategyReserveSlots, mizukiStrategyRouteHook, mizukiStrategyDeferredPrepRound } from './StrategyAdaptation.js';

const OK = Object.freeze({ ok: true });
const OFFICIAL = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8'));
const RECRUIT_GROUP_PROFESSIONS = Object.freeze({
  recruit_group_1: ['PIONEER', 'SNIPER', 'SPECIAL'],
  recruit_group_2: ['TANK', 'CASTER', 'SNIPER'],
  recruit_group_3: ['WARRIOR', 'SUPPORT', 'MEDIC'],
});
const effectValues = (effect) => Object.fromEntries((effect.blackboard || []).map((entry) => [entry.key, entry.valueStr ?? entry.value]));
const MIZUKI_STRATEGY_DESCRIPTIONS = Object.freeze({
  band_pepe: '【博学多通】指挥等级每提升1级，获得1次特殊刷新；下一次手动刷新招募券时优先出现萨尔贡干员。',
  band_cathy: '【定向投放】指挥等级每提升1级，免费选择1件装备。',
  band_kirara: '【通关奖励】消耗希望按1希望=3资金计入累计；累计达到20资金，获得1名不高于当前调度中心等级的随机干员。',
  band_paganini: '【定制铳械】消耗希望按1希望=3资金计入累计；累计达到55资金，获得1名4阶及以上随机精锐拉特兰干员。',
  band_sciurus: '【雪域礼赠】每回合首次招募谢拉格干员时消耗1点希望。',
});
const BATTLE_MS = INTERVAL_MS;
const SAFE_PHASES = new Set([...Object.values(PHASE).filter((phase) => phase !== PHASE.COMBAT), 'MIZUKI_WAITING']);
const NODE_TYPES = new Set(['combat', 'elite', 'boss', 'event', 'shop', 'recruit']);
const EVENT_BATTLE_STAGES = new Set(['ro2_ev_1', 'ro2_ev_2', 'ro2_ev_3', 'ro2_t_1', 'ro2_t_2', 'ro2_t_3', 'ro2_t_4', 'ro2_t_5',
  'ro2_e_1_1', 'ro2_e_1_2', 'ro2_e_1_3', 'ro2_e_1_4']);
const merchantBattleNode = node => node?.type === 'shop' && ['ro2_ev_4', 'ro2_ev_5'].includes(node.eventBattleStageId);
const eventBattleNode = node => node?.type === 'event' && EVENT_BATTLE_STAGES.has(node.eventBattleStageId) || merchantBattleNode(node);
const LOADOUT_PHASES = new Set([PHASE.PREP, PHASE.ROUTE, PHASE.REWARD, PHASE.EVENT, PHASE.SHOP, PHASE.RECRUIT]);
const copy = (value) => structuredClone(value);
const hopeCapacityOf = player => Math.max(player.hope || 0, player.hopeCapacity ?? player.hope ?? 0);
const grantHope = (player, count) => {
  const capacity = hopeCapacityOf(player);
  player.hope = Math.max(0, Math.min(9999, player.hope + count));
  player.hopeCapacity = Math.max(player.hope, Math.min(9999, capacity + Math.max(0, count)));
};
const currentNodeView = (node) => node ? mizukiRouteChoiceView({ ...node, detailsRevealed: true }) : null;
const fail = (error, detail) => ({ error, detail });
const int = (value, min = 0, max = 99999) => Number.isInteger(value) && value >= min && value <= max;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const ownsRecruitTicket = (ticketId, seat) => typeof ticketId === 'string'
  && (new RegExp('^mz[0-9]+p' + seat + 't[A-Za-z0-9_-]+$').test(ticketId)
    || new RegExp('^mz(?:source|event|mission):[0-9]+:' + seat + '$').test(ticketId));
const validBattleOutcome = (outcome, maxLevel = 11) => outcome == null || outcome && typeof outcome === 'object' && !Array.isArray(outcome)
  && ['id', 'nodeId', 'battleId'].every(key => typeof outcome[key] === 'string' && outcome[key].length > 0 && outcome[key].length <= 512)
  && ['perfect', 'cleared'].every(key => typeof outcome[key] === 'boolean')
  && ['lpLoss', 'leaked', 'through'].every(key => Number.isFinite(outcome[key]) && outcome[key] >= 0)
  && (!outcome.rewards || ['exp', 'gold'].every(key => int(outcome.rewards[key], 0, 999999999))
    && validMizukiCommander(outcome.rewards.commanderBefore, maxLevel) && validMizukiCommander(outcome.rewards.commanderAfter, maxLevel)
    && Array.isArray(outcome.rewards.levelRewards) && outcome.rewards.levelRewards.length <= 20
    && outcome.rewards.levelRewards.every(reward => ['level', 'populationUp', 'squadCapacityUp', 'maxHpUp'].every(key => int(reward[key], 0, 9999))))
  && (!outcome.autoGranted || Array.isArray(outcome.autoGranted) && outcome.autoGranted.length <= 32
    && outcome.autoGranted.every(reward => typeof reward.itemId === 'string' && int(reward.count, 0, 999999999) && reward.autoGranted === true));
const validEconomyRuntime = (player) => validMizukiEconomy(player)
  && (player.economicBattleCoins === undefined || player.economicBattleCoins && typeof player.economicBattleCoins === 'object'
    && !Array.isArray(player.economicBattleCoins) && Object.entries(player.economicBattleCoins).length <= 8192
    && Object.entries(player.economicBattleCoins).every(([key, value]) => key.length > 0 && key.length < 512 && Number.isSafeInteger(value) && value >= 0))
  && (player.nativeHookIds === undefined || Array.isArray(player.nativeHookIds) && player.nativeHookIds.length <= 32768
    && player.nativeHookIds.every((id) => typeof id === 'string' && id.length > 0 && id.length < 512)
    && new Set(player.nativeHookIds).size === player.nativeHookIds.length);
const validGiftOutbox = (player, players, gd) => player.equipmentGiftOutbox === undefined
  || Array.isArray(player.equipmentGiftOutbox) && player.equipmentGiftOutbox.length <= 4096
    && new Set(player.equipmentGiftOutbox.map((gift) => gift?.id)).size === player.equipmentGiftOutbox.length
    && player.equipmentGiftOutbox.every((gift) => typeof gift?.id === 'string' && /^gift:\d+$/.test(gift.id)
      && players.some((target) => target.playerId === gift.toPlayerId && target.playerId !== player.playerId)
      && !!gd.chess(gift.chessId) && Array.isArray(gift.bonds) && gift.bonds.every((id) => !!gd.bond(id)));
const NATIVE_ITEMS = ['rogue_2_pill', 'rogue_2_bigpill'];
const emptyNativeItems = () => Object.fromEntries(NATIVE_ITEMS.map((id) => [id, 0]));
const driftingCacheEvent = (cache, context) => ({ ...createMizukiDriftingCache({ ...context, id: cache.id, contents: cache.contents }),
  driftingCache: true, ownerId: cache.ownerId, rewardId: cache.rewardId, sceneId: 'rogue_2_treasure:' + cache.id,
  state: { revision: 0 }, votes: copy(cache.votes || {}) });
const validDriftingCache = (event, context, players) => {
  const owner = players.find(player => player.playerId === event?.ownerId);
  const reward = owner?.rewards?.find(value => value.id === event.rewardId && value.type === 'driftingCache' && !value.selected);
  if (!event?.driftingCache || !reward || event.id !== reward.id || !Array.isArray(event.contents) || event.contents.length !== 1
    || event.contents.some(id => !mizukiCollectibleSpec(id)) || JSON.stringify(event.contents) !== JSON.stringify(reward.contents)) return false;
  return JSON.stringify(driftingCacheEvent(event, context)) === JSON.stringify(event);
};
const validNativeItems = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === NATIVE_ITEMS.length
  && NATIVE_ITEMS.every((id) => int(value[id], 0, 9999));
const noopLog = { info() {}, warn() {}, error() {} };
const PARTY_KEYS = ['phase', 'round', 'completedNodes', 'route', 'votes', 'event', 'currentNode',
  'explorationState', 'archiveMode', 'continuation', 'battleStage', 'lastResults', 'unitePlan', 'safePlayers', 'facilityPlacements'];
const teamPhase = (phase) => ({ [PHASE.ROUTE]: 'ROUTE', [PHASE.PREP]: 'PREP', [PHASE.COMBAT]: 'COMBAT',
  [PHASE.REWARD]: 'REWARD', [PHASE.RECRUIT]: 'RECRUIT', [PHASE.EVENT]: 'EVENT', [PHASE.SHOP]: 'SHOP', MIZUKI_WAITING: 'WAITING' })[phase] || 'ROUTE';
const validRecruitContinuation = (state) => ['route', 'node', 'battle', 'event', 'shop'].includes(state.continuation)
  && (state.phase !== PHASE.RECRUIT || (state.continuation === 'route' ? state.currentNode === null
    : state.continuation === 'event' ? state.currentNode?.type === 'event'
      : state.continuation === 'shop' ? state.currentNode?.type === 'shop'
    : state.continuation === 'node' ? state.currentNode?.type === 'recruit'
      : ['combat', 'elite', 'boss'].includes(state.currentNode?.type) || eventBattleNode(state.currentNode)));
const validFacilityPlacements = (value, players) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length <= 4 && Object.entries(value).every(([field, places]) => typeof field === 'string'
    && field.length < 200 && Array.isArray(places) && places.length <= 10 && places.every((place) => place?.key === 'trap_001_crate'
      && players.some((player) => player.playerId === place.playerId) && int(place.row, 0, 63) && int(place.col, 0, 63)
      && ['UP', 'DOWN', 'LEFT', 'RIGHT'].includes(place.dir))
    && new Set(places.map((place) => place.row + ',' + place.col)).size === places.length);
const validFloorState = (value, players, grade, collectibles) => {
  if (!value || value.version !== 1 || !Array.isArray(value.enteredZones) || value.enteredZones.length > 32
    || value.enteredZones.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(id))
    || new Set(value.enteredZones).size !== value.enteredZones.length || !validMizukiMutationState(value.mutations)
    || (value.curse !== null && (!mizukiDifficultyCursePool().includes(value.curse) || !collectibles.includes(value.curse)))
    || !Array.isArray(value.virtues) || value.virtues.length > 7 || value.virtues.some((virtue) => !own(OFFICIAL.rawTopic.squadBuffData, virtue.id)
      || !value.enteredZones.includes(virtue.zoneId) || typeof virtue.used !== 'boolean')) return false;
  if (!validMizukiRouteEventLedger(value.eventLedger)) return false;
  const variations = value.variations;
  if (variations !== undefined && (!variations || typeof variations !== 'object' || Array.isArray(variations)
    || Object.keys(variations).length > 32 || Object.entries(variations).some(([zoneKey, record]) => !/^[A-Za-z0-9_-]{1,48}$/.test(zoneKey)
      || !record || !MIZUKI_VARIATION_IDS.includes(record.id) || typeof record.wishGranted !== 'boolean'
      || typeof record.exited !== 'boolean' || !Array.isArray(record.battleEntryNodeIds) || record.battleEntryNodeIds.length > 512
      || new Set(record.battleEntryNodeIds).size !== record.battleEntryNodeIds.length
      || record.battleEntryNodeIds.some(id => typeof id !== 'string' || id.length < 1 || id.length > 512)
      || !Array.isArray(record.nonBattleNodeIds) || record.nonBattleNodeIds.length > 512
      || new Set(record.nonBattleNodeIds).size !== record.nonBattleNodeIds.length
      || record.nonBattleNodeIds.some(id => typeof id !== 'string' || id.length < 1 || id.length > 512)
      || !record.goldEarnedByPlayer || typeof record.goldEarnedByPlayer !== 'object' || Array.isArray(record.goldEarnedByPlayer)
      || Object.entries(record.goldEarnedByPlayer).some(([playerId, amount]) => !players.some(player => player.playerId === playerId)
        || !int(amount, 1, 999999) || amount > players.find(player => player.playerId === playerId).gold)
      || record.exited && Object.keys(record.goldEarnedByPlayer).length > 0))) return false;
  if (!value.mutations.checks.every((check) => check.grade === grade && value.enteredZones.includes(check.zoneId)
    && check.targets.every((target) => players.some((player) => player.playerId === target.playerId)))) return false;
  const pending = value.pending;
  if (pending === null) return true;
  return pending && validMizukiSanCheck(pending.check) && pending.check.grade === grade
    && value.enteredZones.includes(pending.check.zoneId) && !value.mutations.checkedZones.includes(pending.check.zoneId)
    && int(pending.rerolls, 0, 9999) && pending.id === 'mzsan:' + pending.check.zoneId + ':r' + pending.rerolls
    && Array.isArray(pending.memberIds) && pending.memberIds.length > 0 && pending.memberIds.length <= 4
    && new Set(pending.memberIds).size === pending.memberIds.length && pending.memberIds.every((id) => players.some((player) => player.playerId === id))
    && pending.votes && typeof pending.votes === 'object' && !Array.isArray(pending.votes)
    && Object.entries(pending.votes).every(([id, vote]) => pending.memberIds.includes(id) && ['accept', 'reroll'].includes(vote))
    && (pending.check.kind === 'virtue' ? own(OFFICIAL.rawTopic.squadBuffData, pending.virtueId) : pending.virtueId === null)
    && pending.check.targets.every((target) => pending.memberIds.includes(target.playerId)
      && players.find((player) => player.playerId === target.playerId)?.roster?.some((unit) => unit.uid === target.uid && !unit.mutationId));
};

export class MizukiMatch {
  constructor(opts = {}) {
    if (!Array.isArray(opts.seats) || opts.seats.length < 1 || opts.seats.length > 4) throw new TypeError('Mizuki requires one to four human seats');
    if (opts.seats.some((seat) => seat.isBot)) throw new TypeError('Mizuki exploration does not support bots');
    if (opts.seats.some((seat) => !int(seat.seat, 0, 3) || typeof seat.playerId !== 'string')
      || new Set(opts.seats.map((seat) => seat.seat)).size !== opts.seats.length
      || new Set(opts.seats.map((seat) => seat.playerId)).size !== opts.seats.length) throw new TypeError('Invalid Mizuki seats');
    if (['send', 'broadcast', 'onEnd'].some((key) => typeof opts[key] !== 'function')) throw new TypeError('Mizuki requires platform callbacks');
    this.opts = opts;
    this.roomCode = opts.roomCode || '----';
    this.mode = 'coop';
    this.variant = MIZUKI_VARIANT;
    this.modeId = MIZUKI_MODE_ID;
    this.isMizuki = true;
    this.difficulty = 'NORMAL';
    this.difficultyGrade = opts.mizukiDifficultyGrade === undefined ? 0 : opts.mizukiDifficultyGrade;
    if (!validMizukiDifficulty(this.difficultyGrade)) throw new TypeError('Invalid Mizuki difficulty grade');
    const initial = mizukiDifficultyInitial(this.difficultyGrade);
    this.ranked = false;
    this.clientCombat = false;
    this.seed = (Number(opts.seed) >>> 0) || 1;
    this.matchNo = Math.max(1, Number(opts.matchNo) || 1);
    this.matchId = opts.matchId || `mizuki-${this.seed.toString(36)}-${this.matchNo}`;
    // Transport identities are deliberately fresh after restoring a PREP checkpoint.
    // Gameplay randomness still depends only on seed/node/field, never on this nonce.
    this.battleEpoch = randomBytes(5).toString('hex');
    this.prepGeneration = 0;
    this.authoritativeSeats = new Map(opts.seats.map((seat) => [seat.playerId, { hasLeft: own(seat, 'left'), left: seat.left === true }]));
    this.log = opts.log || noopLog;
    this.sched = opts.scheduler || new RealScheduler({ now: opts.now || Date.now, onError: (error) => this.log.error('[mizuki] timer', error) });
    this.ownsScheduler = !opts.scheduler;
    this.startedAt = this.now();
    this.data = opts.data || {};
    this.fullCatalog = createMizukiCatalog(this.data);
    this.ds = this.fullCatalog.source;
    this.gd = new GameData(this.ds.raw, MIZUKI_MODE_ID);
    this.stageOptions = officialMizukiStageOptions({ data: this.ds });
    this.endingUnlocks = [...new Set(['ro2_ending_1', ...(Array.isArray(opts.endingUnlocks) ? opts.endingUnlocks : [])])]
      .filter((id) => MIZUKI_ENDING_IDS.includes(id));
    this.endingProgress = createMizukiEndingProgress();
    // New runs start with the complete tree. Explicit snapshots remain usable
    // for older runs; profile scores and cells keep their real earned values.
    this.cognition = normalizeCognition(opts.cognition ?? { totalScore: MIZUKI_COGNITION_MAX_SCORE });
    this.cognitionMods = cognitionEffects(this.cognition);
    this.cognitionLegacy = false;
    this.explorationScores = {};
    this.sanRerollsUsed = 0;
    this.explorationState = opts.dungeon
      ? createMizukiExplorationState(opts.dungeon, { sourceLabel: opts.dungeonSourceLabel })
      : createMizukiExplorationState(generateMizukiDungeon({ seed: this.seed, stageOptions: this.stageOptions, cognition: this.cognitionMods }),
        { sourceLabel: MIZUKI_ROUTE_SOURCE_LABEL, generator: { id: MIZUKI_ROUTE_GENERATOR, version: 1, seed: this.seed } });
    this.archiveMode = !this.explorationState;
    this.CombatClass = opts.CombatClass || MizukiAutoCombat;
    this.catalog = this.fullCatalog.operators.map((operator) => operator.operatorId);
    if (this.catalog.length < 3) throw new TypeError('Mizuki operator content is unavailable');
    this.players = new Map();
    this.order = [...opts.seats].sort((a, b) => a.seat - b.seat).map((seat) => {
      const player = { playerId: seat.playerId, seat: seat.seat, name: String(seat.name || seat.playerId),
        isBot: false, autoplay: false, connected: seat.connected !== false && seat.left !== true, left: seat.left === true, alive: seat.left !== true,
        fieldId: `n:${seat.playerId}`, gold: initial.initialGold + this.cognitionMods.initialGold, hope: initial.initialPopulation, hopeCapacity: initial.initialPopulation,
        life: initial.initialHp + this.cognitionMods.initialMaxLife, maxLife: initial.initialMaxHp + this.cognitionMods.initialMaxLife, shield: initial.initialShield,
        bandId: null, strategyReady: false, initialSupplyId: null, initialSupplyReady: false,
        recruitGroupId: null, recruitGroupReady: false,
        ready: false, lastEmoteAt: null, roster: [], lineup: [], tickets: [], layers: {}, metaCounters: {}, metaMessages: [], gainedChess: 0,
        uidSeq: 0, recruitRefreshes: 0, recruit: null, shop: null, rewards: [], equipmentInventory: [],
        economicCoinTotal: 0, economicCoinRemainder: 0, economicHopePending: 0, economicBattleCoins: {},
        nativeHookIds: [], routeInventory: {}, equipmentSeq: 0, equipmentBattlesCompleted: 0, equipmentBattleIds: [],
        equipmentRequestIds: [], equipmentHookIds: [], equipmentEffects: [], equipmentPendingFunds: 0,
        equipmentOffers: [], equipmentOfferSeq: 0, equipmentGiftOutbox: [], equipmentDeployCapMin: 0, equipmentDeployCapBonus: 0,
        selectedReward: null, loadout: copy(seat.loadout || {}) };
      this.players.set(player.playerId, player);
      return player;
    });
    this.hostId = this.players.has(opts.hostId) ? opts.hostId : this.order[0].playerId;
    // Bank balances come from trusted persistent profiles and never from a run checkpoint.
    this.bankAccounts = new Map(this.order.map(player => [player.playerId,
      mizukiBankAccount(opts.bankAccounts instanceof Map ? opts.bankAccounts.get(player.playerId) : opts.bankAccounts?.[player.playerId])]));
    this.expedition = new MizukiTeamExpedition({ players: this.order.map(({ playerId, seat }) => ({ playerId, seat })), leaderId: this.hostId });
    this.partyStates = new Map();
    this._scopeParty = null;
    this.revision = 0;
    this.phase = PHASE.SQUAD;
    this.round = 1;
    this.completedNodes = 0;
    this.squadCapacity = initial.initialSquadCapacity + this.cognitionMods.squadCapacity;
    this.key = initial.initialKey + this.cognitionMods.initialKey;
    this.squadVotes = {};
    this.selectedSquad = null;
    this.baseSquadId = null;
    this.squadMods = { atkPct: this.cognitionMods.atkPct, defPct: this.cognitionMods.defPct, hpPct: this.cognitionMods.hpPct };
    this.diceId = null;
    this.dice = MIZUKI_INITIAL_DICE.initialDice + MIZUKI_INITIAL_DICE.bonusDice + this.cognitionMods.initialDice;
    this.battleDiceSpent = {};
    this.collectibles = this.difficultyGrade >= 16 ? ['rogue_2_relic_fight_159'] : [];
    this.collectibleLayers = {};
    this.routeMissions = createMizukiRouteMissions();
    this.nativeItems = emptyNativeItems();
    this.commander = mizukiCommanderProgress();
    this.floorState = { version: 1, enteredZones: [], curse: null, mutations: createMizukiMutationState(), pending: null, virtues: [], eventLedger: createMizukiRouteEventLedger() };
    this.facilityPlacements = {};
    this.strategyOptions = Object.values(this.ds.raw?.bands || this.data.bands || {}).sort((a, b) => a.sortId - b.sortId)
      .map((band) => ({ bandId: band.bandId, name: band.name,
        description: MIZUKI_STRATEGY_DESCRIPTIONS[band.bandId] || band.desc, iconId: band.iconId }));
    this.light = mizukiDifficultyLight(this.difficultyGrade);
    this.route = [];
    this.votes = {};
    this.event = null;
    this.currentNode = null;
    this.continuation = 'route';
    this.offerSeq = 0;
    this.fields = new Map();
    this.observers = new Set();
    this.started = false;
    this.ended = false;
    this.disposed = false;
    this.paused = false;
    this.manualPaused = false;
    this.manualPausedAt = null;
    this.autoPausedAt = null;
    this.resultSummary = null;
    this.battleTimer = null;
    this.battleTicks = 0;
    this._safeCheckpoint = null;
    this.autoplayController = createMizukiAutoplay(this);
  }

  now() { return this.sched.now(); }

  start() {
    if (this.started || this.disposed || this.ended) return;
    this.started = true;
    this.phase = PHASE.SQUAD;
    this._commit();
  }

  _captureParty() { return Object.fromEntries(PARTY_KEYS.map((key) => [key, this[key] ?? null])); }

  _partyState(party) {
    if (!party) return null;
    if (!this.partyStates.has(party.id)) {
      const state = this._captureParty();
      for (const key of PARTY_KEYS) if (!['lastResults', 'unitePlan'].includes(key)) state[key] = copy(state[key]);
      state.lastResults = new Map(); state.unitePlan = null;
      this.partyStates.set(party.id, state);
    }
    return this.partyStates.get(party.id);
  }

  _syncPartyAggregate() {
    for (const id of this.partyStates.keys()) if (!this.expedition.parties.has(id)) this.partyStates.delete(id);
    for (const [id, field] of this.fields) if (field.partyId && !this.expedition.parties.has(field.partyId)) {
      field.engine.dispose?.(); this.fields.delete(id);
    }
    if (!this.partyStates.size) return;
    const host = this.expedition.partyFor(this.hostId) || [...this.expedition.parties.values()][0];
    const state = this.partyStates.get(host?.id);
    if (state) for (const key of PARTY_KEYS) this[key] = state[key];
    if ([...this.partyStates.values()].some((value) => value.phase === PHASE.COMBAT)) this.phase = PHASE.COMBAT;
    this.completedNodes = Math.max(0, ...[...this.partyStates.values()].map((value) => value.completedNodes || 0));
  }

  _withParty(party, fn, { settle = true } = {}) {
    if (!party || this._scopeParty === party) return fn();
    if (this._scopeParty) throw new Error('Nested Mizuki party scope');
    const saved = this._captureParty(), state = this._partyState(party);
    for (const key of PARTY_KEYS) this[key] = state[key];
    this._scopeParty = party; this._scopeCommit = false;
    let changed;
    try { return fn(); }
    finally {
      for (const key of PARTY_KEYS) state[key] = this[key];
      if (this.expedition.parties.has(party.id)) {
        party.phase = this.battleStage === 'unite' && this.phase === PHASE.COMBAT ? 'UNITE' : teamPhase(this.phase);
        party.votes = { ...this.votes }; party.nodeId = this.currentNode?.id || null;
      }
      changed = this._scopeCommit; this._scopeParty = null; this._scopeCommit = false;
      for (const key of PARTY_KEYS) this[key] = saved[key];
      if (settle || changed) changed = this._resolveRecalls() || changed;
      this._syncPartyAggregate();
      if (settle || changed) this._resumeRendezvous();
      if (this.ended) this.phase = PHASE.RESULT;
      if (changed) this._commit();
    }
  }

  _resumeRendezvous() {
    const barrier = this.expedition.barrier, parties = [...this.expedition.parties.values()];
    if (this._scopeParty || this.ended || !barrier || !parties.length || !parties.every((party) =>
      party.phase === 'WAITING' && party.rendezvous?.kind === barrier.kind && party.rendezvous?.key === barrier.key)) return;
    // Losing the last member of a branch must release teammates already at
    // the floor/Boss rendezvous through the same route-state merge as arrival.
    this._withParty(parties[0], () => this._arriveParty(barrier.kind, barrier.key));
  }

  _resolveRecalls() {
    if (this._scopeParty) throw new Error('Cannot resolve Mizuki recalls inside party scope');
    const result = this.expedition.resolveRecalls();
    for (const { partyId, sourcePartyId } of result.created) {
      const source = this.partyStates.get(sourcePartyId);
      if (!source) throw new TypeError('Missing recalled branch route state');
      const state = copy({ ...source, lastResults: null, unitePlan: null, safePlayers: null });
      state.lastResults = new Map(); state.votes = {};
      this.partyStates.set(partyId, state);
      for (const id of this.expedition.parties.get(partyId).memberIds) {
        const player = this.players.get(id);
        if (player) { player.fieldId = 'n:' + id; player.ready = false; }
      }
    }
    for (const { playerId } of result.moved) {
      const player = this.players.get(playerId);
      if (player) { player.fieldId = 'n:' + playerId; player.ready = false; }
    }
    for (const id of result.removedPartyIds) this.partyStates.delete(id);
    for (const party of this.expedition.parties.values()) {
      const state = this.partyStates.get(party.id);
      if (state) state.votes = { ...party.votes };
    }
    return result.changed;
  }

  _partyViews() {
    const view = this.expedition.view();
    return { ...view, barrier: view.barrier ? { kind: view.barrier.kind } : null, parties: view.parties.map((party) => {
      const state = this.partyStates.get(party.id);
      return { ...party, rendezvous: party.rendezvous ? { kind: party.rendezvous.kind } : null,
        phase: state?.phase || party.phase, currentNode: currentNodeView(state?.currentNode || null),
        route: (state?.route || []).map(mizukiRouteChoiceView), exploration: this._explorationView(state?.explorationState || null,
          { votes: party.votes, currentNodeId: state?.currentNode?.graphNodeId || null }) };
    }) };
  }

  _departure() {
    let departed = 0;
    for (const party of [...this.expedition.parties.values()]) {
      if (!this.expedition.parties.has(party.id) || party.phase !== 'ROUTE') continue;
      const state = this._partyState(party), online = this.order.filter((player) => player.connected && player.alive && !player.left).map((player) => player.playerId);
      const id = this.expedition.choice(party.id, online), node = state.route.find((value) => value.id === id);
      if (!node) continue;
      this._withParty(party, () => {
        const bossRendezvous = !this.explorationState?.portalReturn;
        if (bossRendezvous && node.type === 'boss' && this.expedition.parties.size > 1) {
          state.pendingNode = copy(node);
          if (this._arriveParty('boss', `${this.explorationState?.zoneKey || 'archive'}:${node.stageId}`).ok) departed++;
        } else {
          const started = this.expedition.startNode(party.id, node, { phase: 'PREP', onlineIds: online, bossRendezvous });
          if (started.ok) { this._enterNode(node); departed++; }
        }
      });
    }
    return departed;
  }

  _departReadyAtRendezvous() {
    // The leader has no departure button while waiting at a floor/Boss
    // rendezvous. A trailing branch must still be able to finish its route.
    if (this._scopeParty || this.ended || this.floorState.pending
      || this.expedition.partyFor(this.expedition.leaderId)?.phase !== 'WAITING') return 0;
    let departed = this._departure();
    // The last arriving branch may have merged everyone at a Boss boundary.
    if ([...this.expedition.parties.values()].some(party => party.phase === 'ROUTE'
      && this.partyStates.get(party.id)?.pendingNode)) departed += this._departure();
    return departed;
  }

  _arriveParty(kind, key) {
    const party = this._scopeParty;
    this.expedition.setContext(party.id, this.explorationState);
    const result = this.expedition.arrive(party.id, { kind, key });
    if (!result.ok) return result;
    this.phase = 'MIZUKI_WAITING';
    if (!result.merged) return result;
    const merged = this.expedition.parties.get(result.partyId);
    const anchorId = result.previousPartyIds.find((id) => this.partyStates.get(id)?.currentNode?.id === this.currentNode?.id) || result.previousPartyIds[0];
    // The active party has not been written back by _withParty yet.
    const storedAnchor = this.partyStates.get(anchorId);
    const anchor = anchorId === party.id ? { ...storedAnchor, ...this._captureParty() }
      : storedAnchor || this._captureParty();
    const state = { ...anchor, phase: PHASE.ROUTE, votes: {}, currentNode: null, event: null,
      lastResults: new Map(), unitePlan: null, battleStage: null, explorationState: copy(merged.context) };
    if (state.explorationState) {
      const zones = { ...state.explorationState.dungeon.zones };
      for (const id of result.previousPartyIds) {
        const saved = id === party.id ? this._captureParty() : this.partyStates.get(id);
        for (const [zoneKey, zone] of Object.entries(saved?.explorationState?.dungeon?.zones || {}))
          if (zone.id === 'zone_7' && zoneKey.startsWith('portal_')) zones[zoneKey] ||= copy(zone);
      }
      state.explorationState = { ...state.explorationState, dungeon: { ...state.explorationState.dungeon, zones } };
    }
    let generatedRouteComplete = false;
    if (kind === 'floor' && state.explorationState) {
      this._leaveVariationZone(state.explorationState.zoneKey);
      state.explorationState = this._endingExploration(state.explorationState);
      if (state.explorationState.portalReturn) {
        state.explorationState = leaveMizukiPortalExploration(state.explorationState);
      } else {
      const floors = normalizeMizukiDungeon(state.explorationState.dungeon, { sourceLabel: state.explorationState.sourceLabel }).floors;
      const current = floors.findIndex((floor) => floor.key === state.explorationState.zoneKey);
      const next = floors.slice(current + 1).find((floor) => !floor.isExtraRegion);
      if (next) state.explorationState = { ...state.explorationState, zoneKey: next.key, cursor: null, trace: [] };
      else generatedRouteComplete = state.explorationState.generator?.id === MIZUKI_ROUTE_GENERATOR;
      }
    }
    this.expedition.setContext(merged.id, state.explorationState);
    if (kind === 'floor') this._enterArea(state.explorationState, merged.memberIds);
    state.route = this._routeOptions(state.explorationState, state.archiveMode, { reserve: true });
    this.partyStates.set(merged.id, state);
    for (const id of result.previousPartyIds) this.partyStates.delete(id);
    if (kind === 'boss') {
      const pending = anchor.pendingNode || this.partyStates.get(party.id)?.pendingNode;
      if (pending && state.route.some((node) => node.id === pending.id)) {
        merged.votes = Object.fromEntries(merged.memberIds.map((id) => [id, pending.id]));
        state.votes = { ...merged.votes }; state.pendingNode = copy(pending);
      }
    }
    if (generatedRouteComplete) { state.phase = PHASE.RESULT; this._finish(true, 'generated_route_complete'); }
    this._scopeCommit = true;
    return result;
  }

  _giveMutation(count, members, salt) {
    const rng = this._rng(salt), pool = mizukiMutationPool(this.difficultyGrade);
    const candidates = members.flatMap((player) => player.roster.filter((unit) => !unit.mutationId));
    const mutationId = rng.pick(pool);
    while (count-- > 0 && candidates.length) {
      const unit = rng.pick(candidates); candidates.splice(candidates.indexOf(unit), 1); unit.mutationId = mutationId;
    }
  }

  _enterArea(exploration, memberIds = this._active().map((player) => player.playerId)) {
    if (!exploration) return;
    const floor = normalizeMizukiDungeon(exploration.dungeon, { sourceLabel: exploration.sourceLabel }).floors
      .find((entry) => entry.key === exploration.zoneKey);
    if (!floor || this.floorState.enteredZones.includes(floor.key)) return;
    const members = memberIds.map((id) => this.players.get(id)).filter((player) => player?.alive && !player.left);
    this.floorState.enteredZones.push(floor.key); this.floorState.virtues = [];
    if (floor.variation) this._variationRecord(floor.key, floor.variation);
    if (floor.zoneType === 'NORMAL') for (const effect of [...(this.selectedSquad?.effects || []), ...mizukiCollectibleEffects(this.collectibles)]) {
      if (effect.key === 'zone_into_reward') {
        const values = effect.values || effectValues(effect);
        this._collectibleResource(values.id, Math.trunc(values.count || 0), members);
      }
    }
    // Existing zone-entry relics resolve before a newly granted third-floor relic.
    for (const effect of mizukiCollectibleEffects(this.collectibles)) if (effect.key === 'zone_into_mutation') {
      this._giveMutation(effect.values.count, members, 'zone-mutation:' + floor.key);
    }
    if (this.difficultyGrade >= 2 && !this.floorState.curse && floor.zoneType === 'NORMAL' && floor.ordinaryFloor === 3) {
      const id = this._rng('third-floor-curse').pick(mizukiDifficultyCursePool());
      this.floorState.curse = id; this.collectibles.push(id);
      for (const effect of mizukiCollectibleEffects([id])) if (effect.key === 'immediate_mutation') {
        this._giveMutation(effect.values.count, members, 'curse:' + floor.key);
      }
    }
    // NORMAL / SP controls gameplay. A hidden ending region, including a
    // zone_7 used as ordinary sixth floor, still receives its original SAN roll.
    if (floor.zoneType !== 'NORMAL' || floor.ordinaryFloor < 2 || floor.ordinaryFloor > 6) return;
    const check = createMizukiSanCheck({ light: this.light, diceId: this.diceId || 'rogue_2_dice_1',
      grade: this.difficultyGrade, rng: this._rng('san:' + floor.key), players: members, zoneId: floor.key });
    this.floorState.pending = this._pendingSan(check, memberIds, 0);
    this._routeMissionProgress({ diceUsed: 1, diceRoll: check.roll }, { memberIds });
  }

  _pendingSan(check, memberIds, rerolls) {
    const pool = Object.keys(OFFICIAL.rawTopic.squadBuffData).filter((id) => Number(id.split('_').at(-1)) <= 7);
    return { id: 'mzsan:' + check.zoneId + ':r' + rerolls, check, memberIds: [...memberIds], votes: {}, rerolls,
      virtueId: check.kind === 'virtue' ? this._rng('virtue:' + check.zoneId + ':' + rerolls).pick(pool) : null };
  }

  _rerollSan(pending) {
    const members = pending.memberIds.map((id) => this.players.get(id)).filter(Boolean);
    if (!this._canSanReroll()) { pending.votes = {}; return fail(ERR.NO_FUNDS, '当前检定不能重投或骰子不足。'); }
    const result = rerollMizukiSanCheck({ check: pending.check, dice: this.dice,
      rng: this._rng('san:' + pending.check.zoneId + ':' + (pending.rerolls + 1)), players: members });
    if (!result.ok) {
      pending.votes = {};
      return fail(result.error, '检定重投失败，表决已重置，请重新选择。');
    }
    this.dice = result.dice; this.sanRerollsUsed++; this.floorState.pending = this._pendingSan(result.check, pending.memberIds, pending.rerolls + 1);
    this._collectibleDiceSpent?.(1);
    this._routeMissionProgress({ diceUsed: 1, diceRoll: result.check.roll, diceSpent: 1 }, { memberIds: pending.memberIds });
    return OK;
  }

  _resolveSanIfReady() {
    const pending = this.floorState.pending;
    if (!pending) return false;
    if (this._scopeParty && this.partyStates.size && pending.memberIds.some((id) => {
      const player = this.players.get(id);
      return player?.alive && !player.left && !this._scopeParty.memberIds.includes(id);
    })) return false;
    const actors = this.order.filter((player) => pending.memberIds.includes(player.playerId) && player.alive && player.connected && !player.left);
    if (!actors.length || !actors.every((player) => own(pending.votes, player.playerId))) return false;
    const accepts = actors.filter((player) => pending.votes[player.playerId] === 'accept').length;
    const rerolls = actors.length - accepts;
    const leader = actors.find((player) => player.playerId === this.hostId) || actors[0];
    const choice = accepts === rerolls ? pending.votes[leader.playerId] : accepts > rerolls ? 'accept' : 'reroll';
    const members = pending.memberIds.map((id) => this.players.get(id)).filter(Boolean);
    if (choice === 'reroll') {
      return this._rerollSan(pending);
    } else {
      const result = commitMizukiSanCheck({ state: this.floorState.mutations, check: pending.check, players: members });
      if (!result.ok) {
        pending.votes = {};
        return fail(result.error, '检定目标已失效，表决已重置，请重新选择。');
      }
      const ticketIds = new Map();
      if (pending.virtueId) {
        const virtue = { id: pending.virtueId, zoneId: pending.check.zoneId, used: false };
        this.floorState.virtues = [virtue]; this._applyVirtueRewards(virtue, ticketIds);
      }
      this.floorState.pending = null;
      this._settleRouteExpeditions(pending.check.zoneId, pending.memberIds);
      this._beginRouteRecruit(ticketIds, 'route');
    }
    return true;
  }

  _sanVote(playerId, message) {
    const party = this.expedition.partyFor(playerId);
    if (party && !this._scopeParty && this.partyStates.get(party.id)?.event?.state?.pendingWish)
      return this._withParty(party, () => this._wishVote(playerId, message));
    if (this.event?.state?.pendingWish) return this._wishVote(playerId, message);
    const pending = this.floorState.pending;
    if (!pending || message.id !== pending.id || !pending.memberIds.includes(playerId)
      || !['accept', 'reroll'].includes(message.choice)) return fail(ERR.BAD_TARGET, '层间检定已失效。');
    if (message.choice === 'reroll' && (!pending.check.canReroll || this.dice < 1 || !this._canSanReroll())) return fail(ERR.NO_FUNDS, '当前检定不能重投或骰子不足。');
    if (message.choice === 'reroll') {
      const result = this._rerollSan(pending);
      this._commit();
      return result;
    }
    pending.votes[playerId] = message.choice;
    const result = this._resolveSanIfReady();
    this._commit();
    return result?.error ? result : OK;
  }

  _sanPublicView() {
    const wish = this._wishPublicView(); if (wish) return wish;
    const pending = copy(this.floorState.pending); if (!pending) return null;
    pending.check.canReroll = pending.check.canReroll && this._canSanReroll();
    const event = OFFICIAL.modules.dice.diceEvents[pending.check.diceEventId];
    pending.check.resultDescription = event?.resultDesc || '';
    pending.check.sound = event?.sound || null;
    pending.check.targets = pending.check.targets.map((target) => {
      const player = this.players.get(target.playerId), unit = player?.roster.find((entry) => entry.uid === target.uid);
      const data = OFFICIAL.rawTopic.charBuffData[target.mutationId];
      return { ...target, playerName: player?.name || target.playerId, operatorName: unit?.name || '',
        mutationName: data?.outerName || '', mutationDescription: data?.functionDesc || '', mutationIcon: data?.iconId || null };
    });
    if (pending.virtueId) {
      const value = OFFICIAL.rawTopic.squadBuffData[pending.virtueId];
      pending.virtue = { id: value.id, name: value.outerName, description: value.functionDesc, iconId: value.iconId };
    }
    return pending;
  }

  _canSanReroll() { return this.cognitionLegacy || this.cognitionMods.sanRerollEnabled && this.sanRerollsUsed === 0; }

  _wishPublicView(event = this.event, memberIds = this._active().map(player => player.playerId)) {
    const pending = event?.state?.pendingWish;
    if (!pending) return null;
    return { id: 'mzwish:' + event.id + ':' + event.state.revision, memberIds: [...memberIds], votes: copy(pending.votes),
      check: { kind: 'wish', roll: 1, light: this.light, canReroll: this.cognitionMods.wishRerollEnabled && this.dice >= 1,
        resultDescription: event.description, targets: [] } };
  }

  _wishVote(playerId, message) {
    const view = this._wishPublicView(), pending = this.event?.state?.pendingWish;
    if (!view || message.id !== view.id || !view.memberIds.includes(playerId) || !['accept', 'reroll'].includes(message.choice)) return fail(ERR.BAD_TARGET, '层间检定已失效。');
    if (message.choice === 'reroll' && !view.check.canReroll) return fail(ERR.NO_FUNDS, '当前检定不能重投或骰子不足。');
    if (message.choice === 'reroll') {
      this.votes = Object.fromEntries(this._actors().map(player => [player.playerId, pending.choiceId]));
      this._resolveVoteIfReady(true, 'reroll');
      this._commit();
      return OK;
    }
    pending.votes[playerId] = message.choice;
    this._resolveWishIfReady(); this._commit(); return OK;
  }

  _resolveWishIfReady() {
    const pending = this.event?.state?.pendingWish; if (!pending) return false;
    const actors = this._actors();
    if (!actors.length || actors.some(player => !own(pending.votes, player.playerId))) return false;
    const accepts = actors.filter(player => pending.votes[player.playerId] === 'accept').length;
    const host = actors.find(player => player.playerId === this.hostId) || actors[0];
    const choice = accepts * 2 === actors.length ? pending.votes[host.playerId] : accepts * 2 > actors.length ? 'accept' : 'reroll';
    if (choice === 'reroll' && this.dice < 1) { pending.votes = {}; return false; }
    this.votes = Object.fromEntries(actors.map(player => [player.playerId, pending.choiceId]));
    this._resolveVoteIfReady(true, choice); return true;
  }

  _enterDriftingCache(player, reward) {
    this.event = driftingCacheEvent({ id: reward.id, ownerId: player.playerId, rewardId: reward.id, contents: reward.contents }, this._routeEventContext());
    this.votes = {}; this.phase = PHASE.EVENT;
  }

  _resolveDriftingCache(choiceId) {
    const cache = this.event, owner = this.players.get(cache.ownerId);
    const reward = owner?.rewards.find(value => value.id === cache.rewardId && value.type === 'driftingCache' && !value.selected);
    if (!reward) return;
    const plan = planMizukiDriftingCache({ ...this._routeEventContext(), choiceId, contents: cache.contents,
      rng: this._rng('cache-open:' + cache.id) });
    if (!plan.ok) { this.votes = {}; this.event.votes = {}; return; }
    this.key -= plan.keyCost; this.dice -= plan.diceCost; this._collectibleDiceSpent(plan.diceCost);
    this._routeMissionProgress({ diceSpent: plan.diceCost, keysSpent: plan.keyCost, diceUsed: plan.roll ? 1 : 0, diceRoll: plan.roll || 0 });
    if (plan.effects.gold) this._grantRouteItem(owner, 'rogue_2_gold', plan.effects.gold);
    const ticketIds = new Map();
    for (const id of plan.relics) this._grantRouteCollectible(id, ticketIds);
    // Keep immediate relic vouchers in the existing reward transaction until
    // every member has finished choosing; battle recruitment consumes them.
    for (const [playerId, ids] of ticketIds) {
      const player = this.players.get(playerId);
      for (const id of ids) {
        const ticket = player.tickets.find(value => value.id === id);
        const item = OFFICIAL.rawTopic.items[ticket.sourceItemId];
        player.rewards.push({ id: 'ticket:' + id, type: 'recruitTicket', group: 'cacheTicket:' + id, selected: true,
          ticketId: id, title: ticket.name, itemId: ticket.sourceItemId, iconId: ticket.iconId, profession: ticket.profession,
          description: item?.usage || item?.description || '' });
      }
    }
    reward.selected = true; owner.selectedReward = reward.id;
    owner.ready = owner.rewards.every(value => owner.rewards.some(selected => selected.group === value.group && selected.selected));
    this.event = null; this.votes = {}; this.phase = PHASE.REWARD;
    if (this._allReady()) this._enterRecruit('battle');
  }

  _virtueViews() {
    return this.floorState.virtues.map((virtue) => {
      const spec = mizukiVirtueSpec(virtue.id);
      return { ...copy(virtue), name: spec.name, description: spec.description, iconId: spec.iconId,
        effectStatus: virtue.used ? 'used' : 'active',
        ...(spec.rewards.length ? { rewardPools: copy(spec.rewards), rewardedCollectibles: copy(virtue.rewardedCollectibles || []) } : {}) };
    });
  }

  _active() { return this.order.filter((player) => player.alive && !player.left && (!this._scopeParty || this._scopeParty.memberIds.includes(player.playerId))); }

  _settleRouteExpeditions(zoneKey, memberIds) {
    for (const player of this.order.filter(value => memberIds.includes(value.playerId))) {
      const returning = player.roster.filter(unit => unit.expedition && unit.expedition.zoneKey !== zoneKey);
      for (const previous of returning) {
        const plan = planMizukiDirectPromotion({ catalog: this.fullCatalog, unit: previous });
        if (plan.ok) this._addOperator(player, plan.operatorId, { ...plan, plan, missionPromotion: false });
        const unit = player.roster.find(value => value.uid === previous.uid);
        if (unit) { unit.mutationId = null; delete unit.expedition; }
        player.metaMessages.push((this.fullCatalog.byId.get(previous.operatorId)?.name || previous.operatorId) + '已归队，完成进阶并抑制排异反应。');
      }
    }
  }
  _actors() { return this._active().filter((player) => player.connected); }
  _allReady() { const actors = this._actors(); return actors.length > 0 && actors.every((player) => player.ready); }
  _resetReady() { for (const player of this._active()) { player.ready = false; player.selectedReward = null; } }
  _rng(salt) { return createRng(deriveSeed(this.seed, `${this.completedNodes}:${this.offerSeq}:${salt}`)); }

  // Only committed server-owned rewards may add shared gene stock.
  _grantNativeItem(itemId, count = 1) {
    if (!NATIVE_ITEMS.includes(itemId) || !int(count, 1, 9999) || this.nativeItems[itemId] + count > 9999) return false;
    this.nativeItems[itemId] += count; return true;
  }

  _gainCommandExperience(count) {
    if (!int(count, 0, 999999999 - this.commander.totalExp)) throw new TypeError('Invalid Mizuki command experience reward');
    const next = mizukiCommanderProgress(this.commander.totalExp + count, this._commanderMaxLevel());
    for (const reward of mizukiCommanderLevelRewards(this.commander.level, next.level)) {
      for (const player of this.order) if (player.alive && !player.left) {
        grantHope(player, reward.populationUp);
        player.maxLife = Math.min(9999, player.maxLife + reward.maxHpUp);
        this._nativeHook(player, 'onLevelUp', { level: reward.level, mizukiCommanderLevelUp: true }, 'commander-level:' + reward.level);
      }
      // A different branch can still be fighting when this shared commander
      // level commits. Its battle rewind must retain this external reward.
      for (const [id, saved] of this.partyStates) {
        const state = this._scopeParty?.id === id ? this : saved;
        if (state.phase !== PHASE.COMBAT) continue;
        for (const previous of state.safePlayers || []) if (this.players.get(previous.playerId)?.alive
          && !this.players.get(previous.playerId).left) {
          grantHope(previous, reward.populationUp);
          previous.maxLife = Math.min(9999, previous.maxLife + reward.maxHpUp);
        }
      }
      this.squadCapacity = Math.min(9999, this.squadCapacity + reward.squadCapacityUp);
      // maxHpUp certifies the capacity increase. No extra current-HP recovery
      // is fabricated without the original server's corresponding HP reward.
    }
    this.commander = next; return { count, ...copy(next) };
  }

  _settleBattleVirtues() {
    let count = 0;
    for (const virtue of this.floorState.virtues) {
      const spec = mizukiVirtueSpec(virtue.id);
      if (virtue.used || !spec?.extraExp || spec.extraExp.limit < 1) continue;
      this._gainCommandExperience(spec.extraExp.count); count += spec.extraExp.count; virtue.used = true;
    }
    return count;
  }

  _applyVirtueRewards(virtue, ticketIds = new Map()) {
    const spec = mizukiVirtueSpec(virtue.id);
    if (virtue.used || !spec?.rewards?.length) return ticketIds;
    const rng = this._rng('virtue-rewards:' + virtue.zoneId + ':' + virtue.id);
    virtue.rewardedCollectibles = [];
    for (const reward of spec.rewards) for (let count = 0; count < reward.count; count++) {
      const id = drawMizukiCollectible({ rng, owned: this.collectibles,
        cognition: this.cognitionLegacy ? undefined : this.cognitionMods,
        bankRecord: Math.max(0, ...this._active().map(player => this.bankAccounts.get(player.playerId)?.record || 0)) });
      if (!id) continue;
      this._grantRouteCollectible(id, ticketIds); virtue.rewardedCollectibles.push(id);
    }
    virtue.used = true; return ticketIds;
  }

  _useNativeItem(itemId) {
    if (this.floorState.pending || this.phase === PHASE.COMBAT
      || [...this.partyStates.values()].some((state) => state.phase === PHASE.COMBAT)) return fail(ERR.WRONG_PHASE, '请在作战和层间检定结束后使用改良基因。');
    if (!NATIVE_ITEMS.includes(itemId)) return fail(ERR.BAD_TARGET, '不存在此基因道具。');
    if (this.nativeItems[itemId] < 1) return fail(ERR.NO_FUNDS, '没有此基因道具。');
    const result = applyMizukiEvolutionReward(this.order.filter((player) => player.alive && !player.left), itemId,
      this._rng('gene:' + itemId + ':' + this.nativeItems[itemId]));
    if (!result.ok) return fail(result.error, '没有受到排异反应的可进化干员，未消耗道具。');
    this.nativeItems[itemId]--;
    // A PREP field owns immutable input cards; rebuild it so evolution applies
    // in the upcoming battle as well as in the persistent roster/checkpoint.
    if (this.partyStates.size) {
      for (const party of this.expedition.parties.values()) if (this.partyStates.get(party.id)?.phase === PHASE.PREP) {
        this._withParty(party, () => { this._resetReady(); this._prepareFields(); });
      }
    } else if (this.phase === PHASE.PREP) { this._resetReady(); this._prepareFields(); }
    this._commit(); return result;
  }

  _resolveSquadIfReady() {
    const actors = this._actors();
    if (!actors.length || !actors.every((player) => own(this.squadVotes, player.playerId))) return;
    const counts = new Map();
    for (const player of actors) { const id = this.squadVotes[player.playerId]; counts.set(id, (counts.get(id) || 0) + 1); }
    const maximum = Math.max(...counts.values());
    const tied = [...counts].filter(([, count]) => count === maximum).map(([id]) => id);
    const host = actors.find((player) => player.playerId === this.hostId) || actors[0];
    const chosen = tied.includes(this.squadVotes[host.playerId]) ? this.squadVotes[host.playerId] : tied[0];
    this.baseSquadId = chosen;
    this.selectedSquad = this.cognitionLegacy ? MIZUKI_SQUADS.find((squad) => squad.id === chosen) : resolvedSquad(chosen, this.cognition);
    this._applySquad();
    this.phase = PHASE.STRATEGY;
    this._resetReady();
  }

  _applySquad() {
    for (const effect of this.selectedSquad?.effects || []) {
      const values = effectValues(effect);
      if (effect.key === 'immediate_reward') {
        if (values.id === 'rogue_2_gold') for (const player of this._active()) player.gold += values.count;
        if (values.id === 'rogue_2_population') for (const player of this._active()) grantHope(player, values.count);
        if (values.id === 'rogue_2_hpmax') for (const player of this._active()) { player.maxLife += values.count; player.life += values.count; }
        if (values.id === 'rogue_2_squad_capacity') this.squadCapacity += values.count;
        if (values.id === 'rogue_2_shield') for (const player of this._active()) player.shield += values.count;
        if (NATIVE_ITEMS.includes(values.id)) this._grantNativeItem(values.id, values.count);
        if (OFFICIAL.rawTopic.items[values.id]?.type === 'RELIC') this._grantRouteCollectible(values.id);
      }
      if (effect.key === 'item_cover_set' && values.id === 'rogue_2_hp') for (const player of this._active()) player.life = Math.min(player.maxLife, values.count);
      if (effect.key === 'char_attribute_mul') { this.squadMods.atkPct = (this.cognitionMods.atkPct || 0) + (values.atk || 0); this.squadMods.hpPct = (this.cognitionMods.hpPct || 0) + (values.max_hp || 0); }
      if (effect.key === 'set_dice') this.diceId = values.id;
    }
  }

  _recruitGroupOptions() {
    return MIZUKI_RECRUIT_GROUPS.map((group) => ({ ...group,
      tickets: group.id === 'recruit_group_random'
        ? [{ profession: 'ANY', kind: 'normal' }, { profession: 'ANY', kind: 'normal' }, { profession: 'ANY', kind: 'sixstar_free', freeRecruit: true }]
        : (RECRUIT_GROUP_PROFESSIONS[group.id] || []).map((profession) => ({ profession, kind: 'normal' })) }));
  }

  _squadOptions() {
    if (this._squadOptionCache?.cognition === this.cognition && this._squadOptionCache.legacy === this.cognitionLegacy) return copy(this._squadOptionCache.options);
    const options = MIZUKI_SQUADS.map((base) => { const squad = this.cognitionLegacy ? base : resolvedSquad(base.id, this.cognition); return { ...copy(squad), id: base.id, effectSupport: squad.effects.map((effect) => ({
      key: effect.key, implemented: true,
    })) }; });
    this._squadOptionCache = { cognition: this.cognition, legacy: this.cognitionLegacy, options };
    return copy(options);
  }

  _commanderMaxLevel() {
    return this.cognitionLegacy ? 11 : 10 + (this.selectedSquad?.effects || []).filter(effect => effect.key === 'level_limitation_up')
      .reduce((sum, effect) => sum + (effectValues(effect).up || 0), 0);
  }

  _scoreFor(playerId) {
    return this.explorationScores[playerId] ||= { floorsPassed: 0, stepsPassed: 0, normalBattles: 0, eliteBattles: 0, bossBattles: 0, recruits: 0, itemsGained: 0, completedNodeIds: [], completedZoneIds: [] };
  }

  _scoreResult(playerId) {
    const breakdown = mizukiExplorationScoreBreakdown(this._scoreFor(playerId), this.difficultyGrade);
    return { explorationScore: breakdown.total, cellPoints: Math.floor(breakdown.total * this.cognitionMods.livingCellMultiplier),
      cellMultiplier: this.cognitionMods.livingCellMultiplier, counters: breakdown.counters, breakdown };
  }

  _resolveInitialSupplyIfReady() {
    const actors = this._active();
    if (!actors.length || !actors.every(player => player.initialSupplyReady)) return;
    // Personal resources belong to their chooser; a held relic is shared once
    // by the expedition, matching the rest of the run's collection rules.
    for (const player of actors) {
      const reward = mizukiInitialSupplyReward(player.initialSupplyId);
      if (reward?.hope) this._grantRouteItem(player, 'rogue_2_population', reward.hope);
      if (reward?.gold) this._grantRouteItem(player, 'rogue_2_gold', reward.gold);
      if (reward?.collectibleId) this._grantRouteCollectible(reward.collectibleId);
    }
    this.phase = PHASE.RECRUIT_GROUP;
    this._resetReady();
  }

  _hopeCost(operator, upgrade = false, player = null) {
    let cost = upgrade ? operator.upgradeHopeCost : operator.hopeCost;
    if (!upgrade) cost += mizukiDifficultyHopeDelta(this.difficultyGrade, operator.rarity);
    for (const effect of [...(this.selectedSquad?.effects || []), ...mizukiCollectibleEffects(this.collectibles)]) if (effect.key === (upgrade ? 'upgrade_cost' : 'recruit_cost')) {
      const values = effect.values || effectValues(effect);
      if (String(values.rarity).split(',').includes(`TIER_${operator.rarity}`)
        && String(values.profession).split(',').includes(operator.profession)) cost += values.delta;
    }
    if (player?.bandId === 'band_sciurus' && operator.bonds.includes('kjeragShip')
      && player.metaCounters?.['band:sciurus:r'] !== this.round) cost = Math.min(cost, 1);
    return Math.max(0, cost);
  }

  _spendHope(player, amount) {
    if (!int(amount, 0, 9999) || player.hope < amount) return false;
    if (!amount) { this._grantEconomicHope(player, 0); return true; }
    player.hope -= amount;
    this._grantEconomicHope(player, 0);
    this._nativeHook(player, 'onSpend', { amount: amount * 3, currency: 'hope', hopeAmount: amount });
    return true;
  }

  _prepPieces(player) {
    const prep = mizukiPrepView(player, { source: this.ds });
    return [...prep.hand.filter(Boolean).map((piece) => ({ ...piece, area: 'hand' })),
      ...prep.temp.filter(Boolean).map((piece) => ({ ...piece, area: 'temp' })),
      ...prep.board.map((piece) => ({ ...piece, area: 'board' }))];
  }

  _prepBonds(player) {
    const pieces = this._prepPieces(player);
    return computeBonds(this.gd, { board: new Map(pieces.filter((piece) => piece.area === 'board').map((piece) => [`${piece.row},${piece.col}`, piece])),
      hand: pieces.filter((piece) => piece.area === 'hand'), layers: player.layers });
  }

  _equipmentStage(player) {
    const state = this._scopeParty ? this : this.partyStates.get(this.expedition.partyFor(player.playerId)?.id) || this;
    return Math.min(6, state.explorationState && !state.archiveMode ? this._difficultyAreaCount(state.explorationState)
      : 1 + Math.floor((player.equipmentBattlesCompleted || 0) / 2));
  }

  _allocateEquipmentUid(player) {
    player.equipmentSeq = (player.equipmentSeq || 0) + 1;
    if (player.equipmentSeq > 999999) throw new RangeError('Equipment identity limit');
    return (player.seat + 1) * 100000000 + player.equipmentSeq;
  }

  _grantEconomicHope(player, amount) {
    const capacity = hopeCapacityOf(player);
    const reward = grantMizukiEconomicHope(player, amount);
    player.hopeCapacity = Math.min(9999, capacity + reward.hopeGranted);
    // Committed rewards from this battle must survive the PREP rewind used by
    // checkpoint recovery. The per-battle high-water ledger prevents replay pay.
    if (this.players.get(player.playerId) === player) for (const [id, stored] of this.partyStates) {
      const state = this._scopeParty?.id === id ? this : stored;
      if (state.phase !== PHASE.COMBAT) continue;
      const previous = state.safePlayers?.find((value) => value.playerId === player.playerId);
      if (!previous) continue;
      grantHope(previous, reward.hopeGranted);
      for (const key of ['economicCoinTotal', 'economicCoinRemainder', 'economicHopePending', 'economicBattleCoins']) previous[key] = copy(player[key]);
      for (const key of ['bondaddon:visi:paid', 'bondaddon:mira:paid']) if (own(player.metaCounters, key)) previous.metaCounters[key] = player.metaCounters[key];
    }
    return reward;
  }

  _equipmentOptions(player) {
    return { gd: this.gd, phase: this.phase, actorId: player.playerId, stage: this._equipmentStage(player),
      allocateUid: (draft) => this._allocateEquipmentUid(draft),
      onMerge: (draft, event) => this._nativeHook(draft, 'onMerge', event),
      contextFactory: (source, draft, hook) => this._metaContext(draft, source, null, hook),
      grantEconomicHope: (draft, amount) => this._grantEconomicHope(draft, amount) };
  }

  _strategyRouteHook(player, hook) {
    if (!mizukiStrategyRouteHook(this.gd.band(player.bandId), hook)) return false;
    player.nativeHookIds ||= [];
    const id = 'strategy:' + player.bandId + ':' + hook + ':round:' + this.round;
    if (player.nativeHookIds.includes(id)) return true;
    const legacy = player.nativeHookIds.some(key => key.startsWith(hook + ':' + (this.round - 1) + ':'));
    player.nativeHookIds.push(id);
    if (legacy) return true;
    const event = { round: this.round, income: 0, pending: 0 };
    dispatchMizukiNativeMeta({ player, gd: this.gd, hook, event, onlyBand: true, includeEquipment: false,
      contextFactory: source => this._metaContext(player, source, null, hook) });
    if (hook === 'onIncome') this._grantEconomicHope(player, Math.max(0, Math.trunc(event.income || 0))
      + Math.max(0, Math.trunc(event.pending || 0)));
    return true;
  }

  _strategyPrepHook(player) {
    const round = mizukiStrategyDeferredPrepRound(this.gd.band(player.bandId));
    if (round === null) return false;
    if (this.round < round) return true;
    player.nativeHookIds ||= [];
    const id = 'strategy:' + player.bandId + ':deferredPrep:' + round;
    if (player.nativeHookIds.includes(id)) return true;
    // Older checkpoints already ran the board effect during round-eight prep.
    const legacy = player.nativeHookIds.some(key => key.startsWith('onRoundStart:' + (round - 1) + ':'));
    player.nativeHookIds.push(id);
    if (!legacy) dispatchMizukiNativeMeta({ player, gd: this.gd, hook: 'onRoundStart', event: { round }, onlyBand: true, includeEquipment: false,
      contextFactory: source => ({ ...this._metaContext(player, source, null, 'onRoundStart'), round }) });
    return true;
  }

  _nativeHook(player, hook, event = {}, executionId = null, { skipBand = false } = {}) {
    player.nativeHookIds ||= [];
    const id = executionId === null ? null : hook + ':' + executionId;
    if (id && player.nativeHookIds.includes(id)) return event;
    if (id) player.nativeHookIds.push(id);
    dispatchMizukiNativeMeta({ player, gd: this.gd, hook, event, includeEquipment: false, skipBand,
      contextFactory: (source) => this._metaContext(player, source, null, hook) });
    if (['onRoundStart', 'onPrepEnd', 'onBattleResult', 'onSold', 'onGain', 'onMerge', 'onBattleStart'].includes(hook)) {
      const result = dispatchMizukiEquipmentMeta(player, { ...this._equipmentOptions(player), hook, event, executionId });
      if (!result.ok) player.metaMessages.push(result.detail);
      else if (this.players.get(player.playerId) === player) this._flushEquipmentGifts(player);
    }
    return event;
  }

  _flushEquipmentGifts(sender) {
    const consume = (id) => {
      sender.equipmentGiftOutbox = sender.equipmentGiftOutbox.filter((value) => value.id !== id);
      for (const [partyId, saved] of this.partyStates) {
        const state = this._scopeParty?.id === partyId ? this : saved;
        if (state.phase !== PHASE.COMBAT) continue;
        const previous = state.safePlayers?.find((player) => player.playerId === sender.playerId);
        if (previous) previous.equipmentGiftOutbox = (previous.equipmentGiftOutbox || []).filter((gift) => gift.id !== id);
      }
    };
    for (const gift of [...(sender.equipmentGiftOutbox || [])]) {
      let target = this.players.get(gift.toPlayerId);
      if (!target?.alive || target.left) target = this.order.filter((player) => player.playerId !== sender.playerId && player.alive && !player.left)
        .sort((a, b) => gift.bonds.reduce((n, id) => n + (this._prepBonds(b)[id]?.count || 0) - (this._prepBonds(a)[id]?.count || 0), 0) || a.seat - b.seat)[0];
      if (!target) { consume(gift.id); continue; }
      const party = this.expedition.partyFor(target.playerId);
      const state = this._scopeParty?.id === party?.id ? this : this.partyStates.get(party?.id);
      // A recipient still fighting receives the already committed gift at its
      // next safe preparation. Never mutate a live battle's immutable roster.
      if (state?.phase === PHASE.COMBAT) continue;
      const draft = copy(target), granted = this._grantMetaChess(draft, gift.chessId);
      if (!granted || !validMizukiEquipmentState(draft, { gd: this.gd }) || !validMizukiEconomy(draft)) continue;
      Object.assign(target, draft);
      if (state?.phase === PHASE.PREP) target.ready = false;
      target.metaMessages.push(sender.name + '赠送了' + (this.gd.chess(gift.chessId)?.name || gift.chessId));
      consume(gift.id);
    }
  }

  _grantMetaChess(player, chessId) {
    const canonical = this.gd.baseIdOf(chessId);
    const operator = this.fullCatalog.byId.get(chessId) || this.fullCatalog.byId.get(canonical)
      || this.fullCatalog.operators.find((value) => value.canonicalChessId === canonical);
    if (!operator) return null;
    const plan = planMizukiOperatorGain({ operatorId:operator.operatorId, catalog:this.fullCatalog,
      roster:player.roster, directPromotion:this.gd.isGolden(chessId) });
    if (!plan.ok) return null;
    const consumed = player.roster.filter(unit => plan.consumedUids.includes(unit.uid)).map(mizukiOperatorPiece);
    const unit = this._addOperator(player, operator.operatorId, { ...plan, plan, resultUnit:true });
    if (!unit) return null;
    const piece = mizukiOperatorPiece(unit);
    if (plan.promotion) dispatchMizukiRecruitPromotion({ player, ticket: this._activeTicket(player), catalog: this.fullCatalog, gd: this.gd,
      contextFactory: (source) => this._metaContext(player, source), callbacks: this._recruitMetaCallbacks(player),
      event: { kind: 'chess', piece, baseId: operator.operatorId, consumed, area: 'hand' } });
    return piece;
  }

  _metaContext(player, source = null, liveBonds = null, hook = null) {
    const states = () => liveBonds || this._prepBonds(player);
    const pieces = () => this._prepPieces(player);
    const note = (message) => {
      player.metaMessages.push(String(message));
      if (player.metaMessages.length > 20) player.metaMessages.shift();
    };
    const rng = this._rng('meta:' + player.playerId + ':' + this.completedNodes + ':' + hook + ':' + player.gainedChess + ':' + player.recruitRefreshes + ':' + (source?.piece?.uid || ''));
    const rollChess = (options = {}) => {
      const eligible = this.fullCatalog.operators.filter((operator) => (!Number.isInteger(options.tier) || operator.tier === options.tier)
        && (!Number.isInteger(options.maxTier) || operator.tier <= options.maxTier)
        && (!options.bond || operator.bonds.includes(options.bond)) && (!options.filter || options.filter(operator.operatorId))
        && !player.roster.some((unit) => unit.operatorId === operator.operatorId && (unit.promotion || !operator.promotionChessId)));
      return rng.weighted(eligible, (operator) => options.ignoreCounts ? 1 : this.gd.poolCopies(operator.operatorId))?.operatorId || null;
    };
    const grantItem = (id) => {
      const result = grantMizukiEquipment(player, id, this._equipmentOptions(player));
      return result.ok ? result.item : null;
    };
    const offer = (kind, ids, options = {}) => {
      const choices = [...new Set(ids)].filter((id) => kind === 'chess' ? this.fullCatalog.byId.has(id) : !!this.gd.item(id));
      if (!choices.length || (player.equipmentOffers?.length || 0) >= 64) return false;
      player.equipmentOffers ||= []; player.equipmentOfferSeq = (player.equipmentOfferSeq || 0) + 1;
      player.equipmentOffers.push({ id: 'mzeo:' + player.seat + ':' + player.equipmentOfferSeq, kind, choices,
        source: options.source?.includes(':') ? options.source : source?.key || 'item:mizuki', createdRound: this.round, pick: 1, grantOpts: {} });
      return true;
    };
    const mate = (target) => ({ playerId: target.playerId, name: target.name, alive: target.alive, bandId: () => target.bandId,
      bondCount: (id) => this._prepBonds(target)[id]?.count || 0,
      grantChess: (id) => {
        if (hook !== 'onRoundStart' || source?.ref?.key !== 'effect:builtin_gift') return null;
        player.equipmentGiftOutbox ||= [];
        if (!player.equipmentGiftOutbox.some((gift) => gift.id === source.ref.id)) player.equipmentGiftOutbox.push({
          id: source.ref.id, toPlayerId: target.playerId, chessId: id, bonds: copy(source.ref.params?.bonds || []) });
        return true;
      }, giftTicker: () => {} });
    const currentTicket = () => this._activeTicket(player);
    let localSlots = null;
    const slots = () => localSlots || (localSlots = currentTicket()?.candidates?.length
      ? currentTicket().candidates.map(id => ({ id, kind: 'chess', sold: false, basePrice: 0 }))
      : mizukiStrategyReserveSlots({ player, rollChess, stage: this._equipmentStage(player) }));
    let pool = null;
    const rollItem = (options = {}) => MatchSpDraft.prototype.rollItemId.call({ gd: this.gd, rngMeta: rng,
      itemPool: { canGain: () => true, pick: (random, ids, weights) => (weights ? random.weighted(ids, (id) => weights.get(id) || 0) : random.pick(ids)) || null } },
    { shopLevel: this._equipmentStage(player), ...options });
    return { data: this.ds.raw, gd: this.gd, phase: this.phase, round: this.round, source, hook, playerId: player.playerId, name: player.name, seat: player.seat, rng,
      counter: (key) => player.metaCounters[key] || 0,
      setCounter: (key, value) => { player.metaCounters[key] = value; return value; },
      incCounter: (key, amount = 1) => { player.metaCounters[key] = (player.metaCounters[key] || 0) + amount; return player.metaCounters[key]; },
      hand: () => pieces().filter((piece) => piece.area === 'hand'), board: () => pieces().filter((piece) => piece.area === 'board'),
      temp: () => pieces().filter((piece) => piece.area === 'temp'), piece: (uid) => pieces().find((piece) => piece.uid === uid) || null,
      chessRecord: (id) => this.ds.rawChess(id), pieceBonds: (uid, fallback) => {
        const piece = pieces().find((entry) => entry.uid === uid) || fallback;
        return piece ? pieceBonds(this.gd, piece) : [];
      },
      bond: (id) => states()[id], bonds: states, bondActive: (id) => states()[id]?.active === true,
      layers: (id) => canStackBond(id) ? player.layers[id] || 0 : 0,
      addLayers: (id, amount, { requireActive = true } = {}) => {
        const bond = this.gd.bond(id);
        if (!bond || !canStackBond(id) || bond.noStack || (requireActive && !states()[id]?.active)) return 0;
        const add = layerGainRoom(player.layers[id] || 0, amount);
        player.layers[id] = (player.layers[id] || 0) + add;
        return add;
      },
      funds: () => (player.economicCoinRemainder || 0) + (player.economicHopePending || 0) * 5,
      addFunds: (amount) => { const n = Math.max(0, Math.trunc(amount)); this._grantEconomicHope(player, n); return n; },
      addPendingFunds: (amount) => { const n = Math.max(0, Math.trunc(amount)); player.equipmentPendingFunds = (player.equipmentPendingFunds || 0) + n; return n; },
      roundStats: () => ({ gainedChess: player.gainedChess, spent: 0, refreshes: player.recruitRefreshes, buys: 0 }),
      bandId: () => player.bandId, teammates: () => this.order.filter((target) => target.playerId !== player.playerId && target.alive && !target.left).map(mate),
      teamMedicGranted: () => this.order.some(target => target.bandId === 'band_amedic'),
      player: (id) => { const target = this.players.get(id); return hook === 'onRoundStart' && target?.alive && !target.left && target !== player ? mate(target) : null; },
      shopLevel: () => this._equipmentStage(player), shopSlots: slots,
      setShopSlot: (index, slot) => {
        if (!int(index, 0, slots().length - 1) || slot != null && !this.fullCatalog.byId.has(slot.id)) return false;
        slots()[index] = slot;
        const ticket = currentTicket();
        if (ticket) ticket.candidates = slots().filter(Boolean).map((entry) => entry.id);
        return true;
      },
      grantItem, rollItem, rollChess,
      grantFreeRefresh: (amount = 1) => grantMizukiRecruitRefreshes(this._activeTicket(player), amount),
      rollPool: (id, options = {}) => MatchSpDraft.prototype.rollPool.call({ gd: this.gd, rngMeta: rng, bannedChess: [],
        poolFor: () => pool || (pool = new SharedPool(this.gd)), rollItemId: rollItem }, id, { shopLevel: this._equipmentStage(player), ...options }),
      grantChess: (id) => this._grantMetaChess(player, id), offerChess: (ids, options) => offer('chess', ids, options),
      offerItems: (ids, options) => offer('item', ids, options),
      promote: (uid) => {
        const unit = player.roster.find((entry) => entry.uid === uid), plan = planMizukiDirectPromotion({ catalog: this.fullCatalog, unit });
        return plan.ok && this._addOperator(player, plan.operatorId, { ...plan, plan, missionPromotion: false });
      },
      addEffect: (ref) => {
        if (!ref?.id || !ref.key) return null;
        player.equipmentEffects ||= [];
        const existing = player.equipmentEffects.find((entry) => entry.id === ref.id);
        if (existing) Object.assign(existing, copy(ref)); else player.equipmentEffects.push(copy(ref));
        return existing || player.equipmentEffects.at(-1);
      },
      effects: () => copy(player.equipmentEffects || []),
      removeEffect: (id) => {
        const index = player.equipmentEffects?.findIndex((entry) => entry.id === id) ?? -1;
        if (index < 0) return false;
        player.equipmentEffects.splice(index, 1); return true;
      },
      addDeployCap: (amount) => { player.equipmentDeployCapBonus = Math.min(12, (player.equipmentDeployCapBonus || 0) + Math.max(0, Math.trunc(amount))); return amount; },
      setDeployCapAtLeast: (amount) => { player.equipmentDeployCapMin = Math.max(player.equipmentDeployCapMin || 0, Math.min(12, Math.max(0, Math.trunc(amount)))); return player.equipmentDeployCapMin; },
      transform: (uid, id) => {
        const unit = player.roster.find((entry) => entry.uid === uid);
        if (!unit || !this.fullCatalog.byId.has(id)) return null;
        const result = dismissMizukiOperator(player, uid, { hopeRefund: 0 });
        return result.ok ? this._grantMetaChess(player, id) : null;
      },
      garrisonsOf: (uid) => (pieces().find((entry) => entry.uid === uid)?.garrisonIds || []).map((id) => this.gd.garrison(id)).filter(Boolean),
      triggerGarrisons: (uid, eventType) => {
        const piece = pieces().find((entry) => entry.uid === uid);
        if (!piece || eventType !== 'SERVER_GAIN') return 0;
        player.metaCounters['mizuki:garrisonTrigger'] = (player.metaCounters['mizuki:garrisonTrigger'] || 0) + 1;
        return this._gainGarrisons(player, player.roster.find((unit) => unit.uid === uid), {
          executionId: 'gain-trigger:' + this.round + ':' + player.metaCounters['mizuki:garrisonTrigger'] + ':' + uid });
      },
      toast: note, reportError: (label, error) => note(label + ': ' + error.message),
    };
  }

  _settleEconomicBonds(player, liveBonds = null) {
    const registry = getDefaultRegistry();
    for (const id of ['visiShip', 'miraShip']) {
      const handler = registry.get('bond:' + id);
      if (handler?.onLayers) handler.onLayers(this._metaContext(player, null, liveBonds), { bondId: id });
    }
  }

  _gainGarrisons(player, unit, { executionId = null } = {}) {
    if (!unit) return 0;
    const piece = this._prepPieces(player).find((value) => value.uid === unit.uid) || mizukiOperatorPiece(unit);
    const result = dispatchMizukiNativeMeta({ player, gd: this.gd, hook: 'onGain', event: { piece }, includeEquipment: false,
      contextFactory: (source) => this._metaContext(player, source, null, 'onGain') });
    const equipment = dispatchMizukiEquipmentMeta(player, { ...this._equipmentOptions(player), hook: 'onGain',
      event: { kind: 'chess', piece }, executionId: executionId || 'gain:' + player.gainedChess + ':' + unit.uid });
    if (!equipment.ok) player.metaMessages.push(equipment.detail);
    this._settleEconomicBonds(player);
    return result.dispatched + (equipment.dispatched || 0);
  }

  _addOperator(player, operatorId, { promotion = 0, existingUid = null, recruitCopies = null, plan = null, missionPromotion = true, resultUnit = false } = {}) {
    const operator = this.fullCatalog.byId.get(operatorId);
    const existingIndex = existingUid == null ? -1 : player.roster.findIndex((unit) => unit.uid === existingUid && unit.operatorId === operatorId);
    if (!operator || existingUid != null && existingIndex < 0
      || existingIndex < 0 && (player.roster.length >= 1024 || player.uidSeq >= 9999)) return false;
    const consumedIds = new Set(plan?.consumedUids || []);
    const consumed = player.roster.filter(unit => consumedIds.has(unit.uid));
    if (consumedIds.has(existingUid) || consumed.length !== consumedIds.size
      || consumed.some(unit => unit.operatorId !== operatorId || unit.promotion)) return false;
    const returnedItems = consumed.flatMap(unit => copy(unit.items || []));
    if ((player.equipmentInventory?.length || 0) + returnedItems.length > 4096) return false;
    const promoted = promotion ? this.fullCatalog.promotions.get(operatorId) : null;
    if (promotion && !promoted) return false;
    const chessId = promoted?.chessId || operatorId;
    const previous = existingIndex >= 0 ? player.roster[existingIndex] : null;
    const loadout = player.loadout?.[operatorId] || player.loadout?.[operator.canonicalChessId] || player.loadout?.[operator.charId];
    const wantedSkill = previous?.runLoadout?.skillIndex ?? (int(loadout?.skill, 0, 9) ? loadout.skill : operator.skillIndex);
    const def = this.ds.getChess(chessId, { skillIndex: wantedSkill, moduleId: previous?.runLoadout?.moduleId ?? loadout?.module ?? operator.moduleId });
    if (!def) return false;
    const raw = def.raw;
    const skillIndex = def.loadout?.skillIndex ?? raw.skill?.index ?? operator.skillIndex;
    const skill = raw.skills?.find((value) => value.index === skillIndex) || raw.skill || {};
    const uid = existingUid ?? (player.seat + 1) * 10000 + player.uidSeq + 1;
    let unit = { uid, operatorId, chessId, canonicalChessId: promoted?.canonicalChessId || operator.canonicalChessId, source: operator.source,
      mutationId: player.roster[existingIndex]?.mutationId ?? null,
      promotion, recruitCopies: recruitCopies ?? player.roster[existingIndex]?.recruitCopies ?? 1, formStatus: copy(raw.status || null),
      charId: raw?.charId || def.charId || chessId, name: raw?.name || def.name || chessId,
      rarity: raw?.rarity || def.rarity || 4, profession: raw?.profession || def.profession || '',
      position: raw?.position || def.position || 'MELEE', cost: raw?.stats?.cost ?? def.cost ?? 10,
      skillIndex, skillName: skill.name || '', skillType: skill.skillType || skill.type || '',
      moduleId: def.loadout?.moduleId || raw.module?.id || 'none', avatar: raw?.assets?.avatar || raw?.charId || chessId,
      bonds: copy(raw.bonds || []), garrisonIds: copy(raw.garrisonIds || []), skills: (raw.skills || []).map((value) => ({
        index: value.index ?? 0, skillId: value.skillId, name: value.name, description: value.desc || '',
        skillType: value.skillType, spCost: value.spCost, duration: value.duration, iconId: value.iconId,
      })) };
    unit = plan ? applyMizukiRecruitProgress(previous, unit, plan) : preserveMizukiEquipment(previous, unit);
    if (previous?.runLoadout) unit = applyMizukiRunLoadout(this.ds, unit, previous.runLoadout) || unit;
    if (existingIndex >= 0) player.roster[existingIndex] = unit; else player.roster.push(unit);
    if (existingIndex < 0) player.uidSeq++;
    if (consumedIds.size) {
      player.roster = player.roster.filter(entry => !consumedIds.has(entry.uid));
      player.lineup = player.lineup.filter(uid => !consumedIds.has(uid));
      player.equipmentInventory = [...(player.equipmentInventory || []), ...returnedItems];
      if (player.prep) {
        const removed = new Set([...consumedIds, ...player.prep.tokens.filter(token => consumedIds.has(token.ownerUid)).map(token => token.uid)]);
        player.prep = { ...player.prep,
          hand:player.prep.hand.map(uid => removed.has(uid) ? null : uid),
          temp:player.prep.temp.map(uid => removed.has(uid) ? null : uid),
          board:player.prep.board.filter(piece => !removed.has(piece.uid)),
          tokens:player.prep.tokens.filter(token => !removed.has(token.uid)) };
      }
    }
    if (!player.lineup.includes(uid) && player.lineup.length < this.squadCapacity) player.lineup.push(uid);
    if (existingIndex < 0) { player.gainedChess++; this._gainGarrisons(player, unit);
      this._routeMissionProgress({ newOperators: 1 }, { memberIds: [player.playerId] }); }
    else if (missionPromotion && !previous.promotion && unit.promotion)
      this._routeMissionProgress({ promotions: 1 }, { memberIds: [player.playerId] });
    return resultUnit ? unit : true;
  }

  _recruitMetaCallbacks(player) {
    return { grantChess: (chessId) => this._grantMetaChess(player, chessId) };
  }

  _currentTickets(player) { return (player.tickets || []).filter((ticket) => player.recruit?.ticketIds?.includes(ticket.id)); }

  _recruitContext(player, ticket) {
    return { catalog: this.fullCatalog, gd: this.gd, roster: player.roster,
      rng: this._rng('recruit:' + player.playerId + ':' + ticket.id + ':' + ticket.revision) };
  }

  _replaceTicket(player, ticket) {
    const index = player.tickets.findIndex((value) => value.id === ticket.id);
    if (index < 0) throw new TypeError('Missing Mizuki recruitment ticket');
    player.tickets[index] = ticket;
  }

  _newTicket(player, index = 0, { profession, kind = 'normal' } = {}) {
    profession ||= this._rng(player.playerId + ':ticket:' + index).pick(Object.keys(MIZUKI_PROFESSIONS).filter((id) => id !== 'ANY'));
    const ticket = createMizukiRecruitTicket({ id: 'mz' + this.offerSeq + 'p' + player.seat + 't' + index,
      profession, kind, name: kind === 'sixstar_free' ? '免费六星调度券' : kind === 'advanced' ? '高级干员调度券' : MIZUKI_PROFESSIONS[profession],
      iconId: profession === 'ANY' ? null : 'rogue_2_recruit_ticket_' + profession.toLowerCase() });
    player.tickets.push(ticket);
    return ticket;
  }

  _activeTicket(player) {
    const tickets = this._currentTickets(player).filter((ticket) => ticket.count > 0 && ticket.status === 'available');
    return tickets.find((ticket) => ticket.id === player.recruit?.activeTicketId) || tickets[0] || null;
  }

  _refreshRecruit(player) {
    let ticket = this._activeTicket(player);
    if (ticket) {
      const opened = openMizukiRecruitTicket(ticket, this._recruitContext(player, ticket));
      if (!opened.ok) throw new TypeError('Invalid Mizuki recruitment ticket');
      ticket = opened.ticket; this._replaceTicket(player, ticket);
    }
    player.recruit.activeTicketId = ticket?.id || null;
    player.recruit.ticketId = ticket?.id || null;
    player.recruit.selectedTicketId = ticket?.id || null;
    player.ready = !ticket;
  }

  _recruitView(player) {
    if (!player.recruit) return null;
    const ticket = this._activeTicket(player);
    const choices = ticket ? ticket.candidates.map((operatorId, index) => {
      const { skills: _skills, ...operator } = this.fullCatalog.byId.get(operatorId);
      const offerId = mizukiRecruitOfferId(ticket, operatorId, index);
      const plan = this._routeRecruitPromotion(planMizukiRecruitment({ ticket, offerId, catalog: this.fullCatalog, roster: player.roster }), ticket);
      const hopeCost = plan.ok && !plan.freeRecruit ? this._hopeCost(operator, plan.upgradeCost, player) : 0;
      const disabledReason = !plan.ok ? plan.detail : player.hope < hopeCost ? '希望不足' : null;
      const detail = this.fullCatalog.details?.[plan.ok && plan.promotion === 1 && operator.promotionChessId ? operator.promotionChessId : operator.operatorId] || null;
      return { ...operator, detail, hopeCost, offerId, owned: plan.hasOwned ?? !!plan.owned, canUpgrade: plan.promotion === 1, directUpgrade:!!plan.directUpgrade,
        action: plan.action, recruitCopies: plan.recruitCopies, available: !disabledReason, disabledReason };
    }) : [];
    return { ...copy(player.recruit), ticket: copy(ticket), tickets: copy(this._currentTickets(player)), choices,
      emptyReason: ticket && !choices.length ? '本券可招募的干员均已进阶，可放弃本券继续探索。' : null,
      refreshToken: ticket ? mizukiRecruitRefreshId(ticket) : null, skipToken: ticket ? mizukiRecruitSkipId(ticket) : null,
      freeRefreshes: ticket?.freeRefreshes || 0, refreshCount: ticket?.refreshCount || 0,
      remaining: this._currentTickets(player).reduce((sum, value) => sum + value.count, 0), usedCapacity: player.roster.length };
  }

  _routeRecruitPromotion(plan, ticket) {
    if (!plan.ok || plan.promotion || !plan.operator.promotionChessId) return plan;
    const eligible = [...(this.selectedSquad?.effects || []), ...mizukiCollectibleEffects(this.collectibles)]
      .filter(effect => effect.key === 'direct_upgrade').map(effect => effect.values || effectValues(effect))
      .filter(values => Number(values.rarity) === Number(plan.operator.rarity)
        && String(values.profession).split(',').includes(plan.operator.profession));
    const probability = Math.max(0, ...eligible.map(values => Number(values.pr) || 0));
    const candidateIds = ticket.candidates.filter(id => {
      const operator = this.fullCatalog.byId.get(id);
      return operator?.rarity === plan.operator.rarity && eligible.some(values => String(values.profession).split(',').includes(operator.profession));
    }).sort();
    const count = eligible.reduce((sum, values) => sum + Math.max(0, Math.trunc(values.count || 0)), 0);
    const pageRng = createRng(deriveSeed(this.seed, ticket.id + ':' + ticket.revision + ':' + plan.operator.rarity + ':direct-upgrade-candidates'));
    if (!pageRng.shuffle(candidateIds).slice(0, count).includes(plan.operatorId)) return plan;
    const rng = createRng(deriveSeed(this.seed, ticket.id + ':' + ticket.revision + ':' + plan.operatorId + ':direct-upgrade'));
    return rng.chance(probability) ? { ...plan, promotion: 1, action: 'promote', directUpgrade: true } : plan;
  }

  _enterRecruit(continuation) {
    this._clearFields();
    this.phase = PHASE.RECRUIT;
    this.continuation = continuation;
    this.offerSeq++;
    this._resetReady();
    const rewardTickets = new Map();
    if (continuation === 'battle') {
      for (const player of this._active()) {
        rewardTickets.set(player.playerId, []);
        const grouped = player.rewards.some(reward => reward.group);
        if (grouped && !player.connected) for (const group of new Set(player.rewards.map(reward => reward.group))) {
          if (!player.rewards.some(reward => reward.group === group && reward.selected)) {
            const choice = player.rewards.find(reward => reward.group === group); if (choice) choice.selected = true;
          }
        }
        for (const reward of player.rewards) {
          const chosen = grouped ? reward.selected === true : reward.id === 'continue' || reward.id === player.selectedReward;
          if (reward.type === 'recruitTicket') {
            if (chosen) rewardTickets.get(player.playerId).push(reward.ticketId);
            else {
              let ticket = player.tickets.find(value => value.id === reward.ticketId);
              if (ticket?.status !== 'available') continue;
              if (!ticket.revision) ticket = openMizukiRecruitTicket(ticket, this._recruitContext(player, ticket)).ticket;
              const skipped = skipMizukiRecruitTicket(ticket, { token: mizukiRecruitSkipId(ticket), catalog: this.fullCatalog });
              if (skipped.ok) this._replaceTicket(player, skipped.ticket);
            }
          }
        }
      }
      for (const player of this._active()) for (const reward of player.rewards)
        if (reward.type === 'collectible' && reward.selected) this._grantRouteCollectible(reward.itemId, rewardTickets);
    }
    for (const player of this._active()) {
      const battleTicketIds = rewardTickets.get(player.playerId) || [];
      if (!merchantBattleNode(this.currentNode)) player.shop = null;
      player.rewards = [];
      player.recruit = { ticketIds: [], activeTicketId: null, canSkip: true, squadCapacity: this.squadCapacity };
      if (continuation === 'battle') {
        player.recruit.ticketIds = battleTicketIds;
        this._refreshRecruit(player);
        continue;
      }
      const initial = continuation === 'route' && this.completedNodes === 0 && !this.currentNode;
      const initialTickets = initial ? mizukiInitialRecruitTicketSpecs(player.recruitGroupId, this._rng('initial-ticket:' + player.playerId)) : null;
      const count = initial ? initialTickets.length : 1;
      for (let index = 0; index < count; index++) {
        const ticket = this._newTicket(player, index, initial ? initialTickets[index] : {});
        player.recruit.ticketIds.push(ticket.id);
      }
      if (initial) for (const effect of this.selectedSquad?.effects || []) if (effect.key === 'initial_recruit_reward') {
        const values = effectValues(effect);
        if (values.id !== 'pool_init_recruit_random_vip') continue;
        const pool = Object.keys(OFFICIAL.rawTopic.recruitTickets).filter(id => /_vip$/.test(id));
        const rng = this._rng('initial-vip:' + player.playerId);
        for (let index = 0; index < values.count && pool.length; index++)
          player.recruit.ticketIds.push(...this._grantRouteItem(player, rng.pick(pool)));
      }
      this._refreshRecruit(player);
    }
  }

  _finishRecruit() {
    if (!this._allReady()) return;
    // Offline members do not block online decisions or leave orphaned available tickets.
    for (const player of this._active().filter((member) => !member.connected)) {
      for (let ticket of this._currentTickets(player).filter((value) => value.status === 'available')) {
        if (!ticket.revision) {
          const opened = openMizukiRecruitTicket(ticket, this._recruitContext(player, ticket));
          if (!opened.ok) throw new TypeError('Invalid unopened offline recruitment ticket');
          ticket = opened.ticket;
        }
        const skipped = skipMizukiRecruitTicket(ticket, { token: mizukiRecruitSkipId(ticket), catalog: this.fullCatalog });
        if (!skipped.ok) throw new TypeError('Invalid offline recruitment ticket');
        this._replaceTicket(player, skipped.ticket);
      }
      this._refreshRecruit(player);
    }
    if (this.continuation === 'event') {
      if (this.event) { this.phase = PHASE.EVENT; this._resetReady(); this.votes = {}; this.event = { ...createMizukiRouteEvent(this.currentNode, this._routeEventContext()), votes: {} }; }
      else this._completeNode();
    } else if (this.continuation === 'shop') { this.phase = PHASE.SHOP; this._resetReady(); }
    else if (this.continuation === 'battle' && merchantBattleNode(this.currentNode)) this._resumeMerchantShop();
    else if (['node', 'battle'].includes(this.continuation)) this._completeNode(); else this._enterRoute();
  }

  _enterRoute() {
    this._clearFields();
    for (const player of this._active()) player.fieldId = `n:${player.playerId}`;
    this.phase = PHASE.ROUTE;
    this.round = this.completedNodes + 1;
    this.currentNode = null; this.event = null; this.votes = {};
    this._resetReady();
    for (const player of this._active()) { player.recruit = null; player.shop = null; player.rewards = []; }
    this._enterArea(this.archiveMode ? null : this.explorationState);
    this.route = this._routeOptions(this.explorationState, this.archiveMode, { reserve: true });
    for (const player of this._active()) {
      this._strategyRouteHook(player, 'onRoundStart');
      this._strategyRouteHook(player, 'onIncome');
    }
    if (!this._scopeParty && !this.partyStates.size) {
      const party = this.expedition.partyFor(this.hostId);
      this.partyStates.set(party.id, this._captureParty());
      this.expedition.setContext(party.id, this.explorationState);
    }
  }

  _currentVariationId() {
    const zoneKey = this.explorationState?.zoneKey;
    return zoneKey ? this.explorationState?.dungeon?.zones?.[zoneKey]?.variation || null : null;
  }

  _variationRecord(zoneKey = this.explorationState?.zoneKey, variationId = this._currentVariationId()) {
    if (!zoneKey || !variationId) return null;
    if (!MIZUKI_VARIATION_IDS.includes(variationId)) throw new TypeError('Invalid current Mizuki variation');
    this.floorState.variations ||= {};
    let record = this.floorState.variations[zoneKey];
    if (!record) record = this.floorState.variations[zoneKey] = {
      id: variationId, goldEarnedByPlayer: {}, nonBattleNodeIds: [], battleEntryNodeIds: [], wishGranted: false, exited: false,
    };
    if (record.id !== variationId) throw new TypeError('Mizuki zone variation changed during a run');
    return record;
  }

  _changeLight(change, { scaleLoss = true } = {}) {
    if (!Number.isFinite(change)) throw new TypeError('Invalid Mizuki light change');
    const multiplier = mizukiVariationSpec(this._currentVariationId())?.effects.lightLossMultiplier || 1;
    if (change < 0 && scaleLoss) change *= multiplier;
    const previous = this.light;
    this.light = Math.max(0, Math.min(100, this.light + change));
    this._routeMissionProgress?.({ lightGained: Math.max(0, this.light - previous) });
  }

  _leaveVariationZone(zoneKey, memberIds = null) {
    const id = this.explorationState?.dungeon?.zones?.[zoneKey]?.variation || this.floorState.variations?.[zoneKey]?.id;
    const record = this._variationRecord(zoneKey, id);
    if (!record || record.exited) return;
    if (record.id === 'rogue_2_variation_3') for (const [playerId, earned] of Object.entries(record.goldEarnedByPlayer)) {
      if (memberIds && !memberIds.includes(playerId)) continue;
      const player = this.players.get(playerId);
      if (player) player.gold = Math.max(0, player.gold - earned);
      delete record.goldEarnedByPlayer[playerId];
    }
    record.exited = Object.keys(record.goldEarnedByPlayer).length === 0;
  }

  _enterVariationNode(node, ticketIds = new Map()) {
    const effects = mizukiVariationSpec(this._currentVariationId())?.effects;
    if (!effects) return;
    const record = this._variationRecord();
    const nodeId = node.graphNodeId || node.id;
    if (effects.nonBattleGold && !['combat', 'elite', 'boss'].includes(node.type) && !eventBattleNode(node)) {
      for (const player of this._active()) {
        const entryId = JSON.stringify([nodeId, player.playerId]);
        if (record.nonBattleNodeIds.includes(entryId) || record.nonBattleNodeIds.includes(nodeId)) continue;
        record.nonBattleNodeIds.push(entryId);
        const before = player.gold;
        player.gold = Math.min(9999, player.gold + effects.nonBattleGold);
        const gained = player.gold - before;
        if (gained) this._recordVariationGold(player.playerId, gained);
      }
    }
    if (effects.firstWishCollectible && node.graphType === 'WISH' && !record.wishGranted) {
      record.wishGranted = true;
      const id = drawMizukiCollectible({ rng: this._rng('variation-wish:' + this.explorationState.zoneKey),
        cognition: this.cognitionLegacy ? undefined : this.cognitionMods,
        owned: this.collectibles,
        bankRecord: Math.max(0, ...this._active().map(player => this.bankAccounts.get(player.playerId)?.record || 0)) });
      if (id) this._grantRouteCollectible(id, ticketIds);
    }
  }

  _recordVariationGold(playerId, amount) {
    if (!Number.isFinite(amount) || Math.trunc(amount) === 0) return;
    const current = this._currentVariationId() === 'rogue_2_variation_3' ? this._variationRecord() : null;
    if (amount > 0) {
      if (current) {
        current.goldEarnedByPlayer[playerId] = Math.min(999999, (current.goldEarnedByPlayer[playerId] || 0) + Math.trunc(amount));
        current.exited = false;
      }
      return;
    }
    // A portal temporarily suspends its source region. Spending there must
    // also consume any unspent source-region earnings before the old balance.
    let spent = Math.abs(Math.trunc(amount));
    const records = [current, ...Object.values(this.floorState.variations || {}).reverse().filter(record => record !== current)];
    for (const record of records) {
      if (!record || record.id !== 'rogue_2_variation_3' || !spent) continue;
      const earned = record.goldEarnedByPlayer[playerId] || 0, used = Math.min(earned, spent);
      if (earned > used) record.goldEarnedByPlayer[playerId] = earned - used;
      else delete record.goldEarnedByPlayer[playerId];
      spent -= used;
    }
  }

  _applyVariationBattleEntry() {
    const loss = mizukiVariationSpec(this._currentVariationId())?.effects.battleEntryLifeLoss || 0;
    if (!loss || !this.currentNode) return;
    const record = this._variationRecord(), nodeId = this.currentNode.graphNodeId || this.currentNode.id;
    for (const player of this._active()) {
      const entryId = JSON.stringify([nodeId, player.playerId]);
      if (record.battleEntryNodeIds.includes(entryId) || record.battleEntryNodeIds.includes(nodeId)) continue;
      record.battleEntryNodeIds.push(entryId);
      player.life = Math.max(1, player.life - loss);
    }
  }

  _routeOptions(exploration = this.explorationState, archive = this.archiveMode, { reserve = false, ledger = this.floorState.eventLedger } = {}) {
    const choices = exploration && !archive ? mizukiExplorationChoices(exploration, this.stageOptions) : [];
    if (reserve) {
      ledger ||= this.floorState.eventLedger = createMizukiRouteEventLedger();
      for (const node of choices.slice().sort((a, b) => a.id.localeCompare(b.id))) {
        if (!['INCIDENT', 'UNKNOWN', 'ENTERTAINMENT', 'MISSION'].includes(node.graphType) || ledger.nodes[node.id]) continue;
        const event = createMizukiRouteEvent(node, this._routeEventContext(exploration, { event: null, eventLedger: ledger }));
        ledger.nodes[node.id] = event.state.eventKey;
        if (MIZUKI_UNIQUE_ROUTE_EVENTS.includes(event.state.eventKey)) ledger.claims[event.state.eventKey] = { nodeId: node.id, partyId: null };
      }
    }
    return choices.map(node => node.graphType === 'MISSION' && ledger?.claims?.prts_ro2_event_53
      && ledger.claims.prts_ro2_event_53.nodeId !== node.id ? { ...node, graphType: 'INCIDENT' } : node);
  }

  _endingContext(exploration = this.explorationState, overrides = {}) {
    return { seed: this.seed, floor: this._difficultyAreaCount(exploration), light: this.light,
      collectibles: this.collectibles, endingProgress: this.endingProgress, endingUnlocks: this.endingUnlocks,
      ...overrides };
  }

  _collectibleCombatContext() {
    return { light: this.light, players: Object.fromEntries(this._active().map((player) => [player.playerId,
      { gold: player.gold, life: player.life, maxLife: player.maxLife }])), layers: copy(this.collectibleLayers) };
  }

  _routeMissionProgress(event, options = {}) {
    if (!this.routeMissions) return;
    const shared = {}, personal = {};
    for (const [key, value] of Object.entries(event)) (['lightGained', 'keysSpent', 'diceSpent', 'diceUsed', 'diceRoll'].includes(key) ? shared : personal)[key] = value;
    advanceMizukiRouteMissions(this.routeMissions, shared, { memberIds: null });
    advanceMizukiRouteMissions(this.routeMissions, personal, { memberIds: this._active().map(player => player.playerId), ...options });
  }

  _acceptRouteMission(taskId) {
    if (this.routeMissions.missions.length) return null;
    return acceptMizukiRouteMission(this.routeMissions, { taskId, nodeId: this.currentNode.id,
      memberIds: this._active().map(player => player.playerId), seed: this.seed,
      extraReward: /band_(12|13|14)$/.test(this.selectedSquad?.id || '') });
  }

  _claimRouteMission(player, missionId) {
    if (this.phase !== PHASE.ROUTE || this.floorState.pending || this.expedition.barrier)
      return fail(ERR.WRONG_PHASE, '当前无法提交委托，请在空闲时领取。');
    const mission = this.routeMissions.missions.find(value => value.id === missionId && value.status === 'complete'
      && !value.claimPartyId && value.memberIds.includes(player.playerId));
    if (!mission) return fail(ERR.BAD_TARGET, '委托尚未完成或奖励已领取。');
    mission.status = 'rewarding'; mission.claimPartyId = this._scopeParty?.id || this.expedition.partyFor(player.playerId)?.id || null;
    this.phase = PHASE.EVENT; this.currentNode = null; this.votes = {}; this._resetReady();
    this.event = createMizukiMissionRewardEvent(mission, { owned: this.collectibles }); this._commit(); return OK;
  }

  _resolveRouteMissionReward(choiceId) {
    const mission = this.routeMissions.missions.find(value => value.id === this.event?.missionId
      && value.status === 'rewarding' && value.claimPartyId === this._scopeParty?.id);
    if (!mission) return;
    const plan = planMizukiMissionReward(mission, choiceId, { seed: this.seed, owned: this.collectibles });
    if (!plan.ok) return;
    this.votes = {};
    if (mission.extraReward && mission.picks.length === 0) {
      mission.picks.push(choiceId);
      this.event = createMizukiMissionRewardEvent(mission, { owned: this.collectibles });
      this._commit(); return;
    }
    const rewardPicks = [...mission.picks, choiceId];
    const tickets = new Map();
    for (let index = 0; index < rewardPicks.length; index++) {
      const reward = planMizukiMissionReward({ ...mission, picks: rewardPicks.slice(0, index) }, rewardPicks[index],
        { seed: this.seed, owned: this.collectibles });
      if (!reward.ok) continue;
      const effects = reward.effects;
      for (const player of this._active()) {
        const maxLife = Math.min(9999, player.maxLife + (effects.lifeMax || 0));
        player.life = Math.min(maxLife, player.life + maxLife - player.maxLife); player.maxLife = maxLife;
        for (const key of ['gold', 'shield']) {
          const previous = player[key]; player[key] = Math.min(9999, player[key] + (effects[key] || 0));
          if (key === 'gold') this._recordVariationGold(player.playerId, player.gold - previous);
        }
        grantHope(player, effects.hope || 0);
        const ids = reward.items.flatMap(item => this._grantRouteItem(player, item.id, item.count));
        if (reward.recruitProfessions) {
          const ticket = createMizukiRecruitTicket({ id: 'mz' + (++this.offerSeq) + 'p' + player.seat + 'tmission',
            profession: reward.recruitProfessions[0], kind: 'normal', name: '联合职业调度券' });
          ticket.preferredProfessions = reward.recruitProfessions; player.tickets.push(ticket); ids.push(ticket.id);
        }
        tickets.set(player.playerId, [...(tickets.get(player.playerId) || []), ...ids]);
      }
      this.key = Math.min(9999, this.key + (effects.key || 0)); this.dice = Math.min(9999, this.dice + (effects.dice || 0));
      for (const id of reward.relics) this._grantRouteCollectible(id, tickets);
    }
    mission.picks.push(choiceId); mission.status = 'claimed'; this.event = null;
    if (!this._beginRouteRecruit(tickets, 'route')) this._enterRoute();
    this._commit();
  }

  _endingExploration(exploration, { endingProgress = this.endingProgress, collectibles = this.collectibles, seed = this.seed } = {}) {
    if (!exploration || exploration.generator?.id !== MIZUKI_ROUTE_GENERATOR) return exploration;
    return { ...exploration, dungeon: applyMizukiEndingRoute(exploration.dungeon,
      mizukiEndingRoute(endingProgress, collectibles), { stageOptions: this.stageOptions, seed }) };
  }

  _syncEndingRoutes() {
    // Ending history is shared by the whole expedition. Apply it to every
    // branch, including a leader already waiting for another branch's event.
    const syncRoute = (state, party) => {
      if (![PHASE.ROUTE, 'MIZUKI_WAITING'].includes(state.phase)) return;
      state.route = this._routeOptions(state.explorationState, state.archiveMode, { reserve: true });
      if (state.phase === PHASE.ROUTE) {
        state.votes = Object.fromEntries(Object.entries(state.votes || {}).filter(([, id]) => state.route.some((node) => node.id === id)));
        if (party) party.votes = { ...state.votes };
      }
      if (!state.pendingNode) return;
      const pending = state.route.find((node) => node.id === state.pendingNode.id);
      if (!pending) return;
      state.pendingNode = copy(pending);
      if (party?.rendezvous?.kind !== 'boss' || this.expedition.barrier?.kind !== 'boss') return;
      const previous = party.rendezvous.key;
      const key = `${state.explorationState?.zoneKey || 'archive'}:${pending.stageId}`;
      party.rendezvous = { kind: 'boss', key };
      if (this.expedition.barrier.key === previous) this.expedition.barrier = { kind: 'boss', key };
    };
    this.explorationState = this._endingExploration(this.explorationState);
    syncRoute(this, this._scopeParty);
    for (const party of this.expedition.parties.values()) {
      const state = this.partyStates.get(party.id);
      if (party === this._scopeParty) {
        // pendingNode belongs to the stored rendezvous, not PARTY_KEYS.
        if (state?.pendingNode) {
          state.route = this.route; state.explorationState = this.explorationState; state.phase = this.phase;
          syncRoute(state, party);
        }
        this.expedition.setContext(party.id, this.explorationState); continue;
      }
      if (!state) continue;
      state.explorationState = this._endingExploration(state.explorationState);
      syncRoute(state, party);
      this.expedition.setContext(party.id, state.explorationState);
    }
  }

  _enterNode(node) {
    this.currentNode = copy(node); this.votes = {}; this.event = null;
    this._resetReady();
    const ticketIds = new Map();
    this._enterVariationNode(this.currentNode, ticketIds);
    this._routeMissionProgress({ combatNodesEntered: ['combat', 'elite', 'boss'].includes(node.type) ? 1 : 0,
      incidentsEntered: ['INCIDENT', 'UNKNOWN'].includes(node.graphType) ? 1 : 0, restNodesEntered: node.graphType === 'REST' ? 1 : 0 });
    if (['combat', 'elite', 'boss'].includes(node.type)) this._enterPrep();
    else if (node.type === 'recruit') this._enterRecruit('node');
    else if (node.type === 'shop') this._enterShop();
    else { this._enterEvent(); this._beginRouteRecruit(ticketIds, 'event'); }
  }

  _enterEvent() {
    this.phase = PHASE.EVENT;
    this.event = { ...createMizukiRouteEvent(this.currentNode, this._routeEventContext()), votes: {} };
    const key = this.event.state.eventKey;
    if (MIZUKI_UNIQUE_ROUTE_EVENTS.includes(key)) {
      const ledger = this.floorState.eventLedger ||= createMizukiRouteEventLedger();
      ledger.nodes[this.currentNode.id] = key;
      const claim = ledger.claims[key] ||= { nodeId: this.currentNode.id, partyId: null };
      claim.partyId ||= this._scopeParty?.id || this.expedition.partyFor(this.hostId)?.id || null;
    }
  }

  _restoreRouteEventLedger() {
    const ledger = this.floorState.eventLedger ||= createMizukiRouteEventLedger();
    const remember = (nodeId, key, partyId = null) => {
      if (!nodeId || !key) return;
      ledger.nodes[nodeId] ||= key;
      if (MIZUKI_UNIQUE_ROUTE_EVENTS.includes(key)) ledger.claims[key] ||= { nodeId, partyId };
    };
    // Old saves keep all accepted commissions and already granted rewards.
    // Their existing receipts consume the one entrance without replaying it.
    for (const mission of this.routeMissions.missions) remember(mission.nodeId, 'prts_ro2_event_53');
    for (const receipt of this.endingProgress.choices) remember(receipt.nodeId, mizukiUniqueRouteEventForChoice(receipt.choiceId));
    for (const [id, state] of this.partyStates) remember(state.currentNode?.id, state.event?.state?.eventKey, id);
    remember(this.currentNode?.id, this.event?.state?.eventKey, this.expedition.partyFor(this.hostId)?.id || null);
    const normalizeNode = node => node?.graphType === 'MISSION' && ledger.claims.prts_ro2_event_53
      && ledger.claims.prts_ro2_event_53.nodeId !== node.id ? { ...node, graphType: 'INCIDENT' } : node;
    for (const state of [this, ...this.partyStates.values()]) {
      state.route = state.route.map(normalizeNode);
      if (state.event?.state?.eventKey !== 'prts_ro2_event_53') state.currentNode = normalizeNode(state.currentNode);
    }
    for (const state of this.partyStates.values()) if (state.phase === PHASE.ROUTE)
      state.route = this._routeOptions(state.explorationState, state.archiveMode, { reserve: true });
    if (this.phase === PHASE.ROUTE) this.route = this._routeOptions(this.explorationState, this.archiveMode, { reserve: true });
  }

  _enterShop() {
    this.phase = PHASE.SHOP;
    for (const player of this._active()) {
      player.shop = createMizukiRouteShop(this.currentNode, this._shopContext(player));
      if (this._merchantDefeated()) Object.assign(player.shop, { closed: true, offers: [], canRefresh: false, canBattle: false,
        description: '坎诺特已经离开，本次探索不再营业。' });
    }
  }

  _merchantDefeated() {
    return this.endingProgress.battles.some(battle => battle.cleared && ['ro2_ev_4', 'ro2_ev_5'].includes(battle.stageId));
  }

  _startMerchantBattle(player) {
    if (this.phase !== PHASE.SHOP || player.ready || !player.shop || player.shop.closed || player.shop.looted
      || player.shop.battleAttempted || this._merchantDefeated()) return fail(ERR.WRONG_PHASE, '当前不能挑战坎诺特。');
    if ((this.bankAccounts.get(player.playerId)?.record || 0) < 100)
      return fail(ERR.BAD_TARGET, '历史最高投资余额达到100后解锁。');
    const stageId = this._difficultyAreaCount() < 4 ? 'ro2_ev_4' : 'ro2_ev_5';
    if (!this.stageOptions.some(stage => stage.stageId === stageId && stage.available))
      return fail(ERR.BAD_TARGET, '商店作战的原始关卡数据无法载入。');
    for (const member of this._active()) member.shop.battleAttempted = true;
    this.currentNode.eventBattleStageId = stageId;
    this._enterPrep(); this._commit(); return OK;
  }

  _resumeMerchantShop() {
    this._clearFields(); this.phase = PHASE.SHOP; this._resetReady();
    const victory = this.endingProgress.battles.some(battle => battle.nodeId === this.currentNode.id
      && battle.cleared && ['ro2_ev_4', 'ro2_ev_5'].includes(battle.stageId));
    for (const player of this._active()) {
      if (!player.shop) player.shop = createMizukiRouteShop(this.currentNode, this._shopContext(player));
      player.shop.battleAttempted = true; player.shop.canBattle = false;
      if (!victory) continue;
      player.shop.looted = true; player.shop.canRefresh = false;
      player.shop.description = '坎诺特已经离开，可以免费拿走店内剩余商品。';
      for (const offer of player.shop.offers) if (!offer.sold) { offer.price = 0; offer.basePrice = 0; }
    }
  }

  _shopContext(player) {
    return { ...this._routeEventContext(), gold: player.gold,
      bankAccount: mizukiBankAccount(this.bankAccounts.get(player.playerId)) };
  }

  _shopView(player) {
    if (!player.shop) return null;
    const shop = copy(player.shop);
    if (this._merchantDefeated() && !shop.looted) Object.assign(shop, { closed: true, offers: [], canRefresh: false,
      description: '坎诺特已经离开，本次探索不再营业。' });
    shop.bank = mizukiBankView(this.bankAccounts.get(player.playerId), { gold: player.gold, key: this.key,
      available: !player.ready && !shop.looted && !shop.closed });
    shop.canBattle = shop.bank.canBattle && !shop.battleAttempted && !this._merchantDefeated();
    return shop;
  }

  _bankTransaction(player, message) {
    if (this.phase !== PHASE.SHOP || player.ready || !player.shop || player.shop.closed || player.shop.looted || this._merchantDefeated())
      return fail(ERR.WRONG_PHASE, '仅在诡意行商营业且未准备离店时可以办理投资。');
    const result = planMizukiBankTransaction(this.bankAccounts.get(player.playerId), {
      action: message.action, count: message.count ?? 1, gold: player.gold, key: this.key });
    if (!result.ok) return fail(ERR.BAD_TARGET, message.action === 'withdraw'
      ? '提款需历史最高余额达到25、持有1把钥匙，且提取数额应为余额内的1至8。'
      : '每次投入1源石锭，且储备余额不能超过999。');
    // The profile callback synchronously persists its retry job before returning
    // a completion promise. Do not spend run resources if that durable enqueue fails.
    try {
      const pending = this.opts.onBankAccountUpdate?.(player.playerId, copy(result.account));
      if (pending === false) throw new Error('投资档案未接受此笔交易。');
      pending?.catch?.(error => this.log.error('[mizuki] bank persistence', error));
    } catch (error) {
      this.log.error('[mizuki] bank persistence', error);
      return fail(ERR.INTERNAL, '投资档案暂时无法保存，本次未扣除源石锭或钥匙，请稍后重试。');
    }
    this.bankAccounts.set(player.playerId, result.account);
    player.gold += result.goldDelta;
    this._recordVariationGold(player.playerId, result.goldDelta);
    this.key += result.keyDelta;
    this._routeMissionProgress?.({ goldSpent: Math.max(0, -result.goldDelta), keysSpent: Math.max(0, -result.keyDelta) });
    player.shop = updateMizukiRouteShopBank(player.shop, this.currentNode, this._shopContext(player));
    this._commit(); return OK;
  }

  _routeEventContext(exploration = this.explorationState, overrides = {}) {
    const squadId = this.selectedSquad?.id || '';
    return { ...this._endingContext(exploration, overrides), dice: this.dice, diceId: this.diceId, key: this.key,
      bankRecord: Math.max(0, ...this._active().map(player => this.bankAccounts.get(player.playerId)?.record || 0)),
      activeMissionIds: this.routeMissions.missions.filter(mission => mission.status === 'active').map(mission => mission.taskId),
      players: this._active().map(player => ({ playerId: player.playerId, life: player.life, maxLife: player.maxLife, gold: player.gold, hope: player.hope, hopeCapacity: hopeCapacityOf(player),
        routeConsumables: copy(player.routeConsumables || {}),
        roster: player.roster.map(unit => ({ ...unit, name: this.fullCatalog.byId.get(unit.operatorId)?.name || unit.operatorId })) })),
      event: this.event, eventLedger: this.floorState.eventLedger, partyId: this._scopeParty?.id || this.expedition.partyFor(this.hostId)?.id || null,
      shopPriceFactor: this._collectibleShopMultiplier(),
      cognition: this.cognitionLegacy ? undefined : this.cognitionMods, shopDiscount: this.cognitionMods.shopDiscount,
      extraWishChoice: /band_1[5-8]$/.test(squadId),
      extraWishChoices: mizukiCollectibleEffects(this.collectibles).filter(effect => effect.key === 'battle_extra_relic').reduce((sum, effect) => sum + (effect.values.count || 0), 0),
      extraRestChoice: (this.cognitionLegacy ? /band_(19|20|21|22)$/ : /band_(20|21|22)$/).test(squadId), ...overrides };
  }

  _routeEventView(event = this.event, node = this.currentNode, exploration = this.explorationState,
    memberIds = this._scopeParty?.memberIds || this.expedition.partyFor(this.hostId)?.memberIds || this._active().map(player => player.playerId)) {
    if (!event || event.missionReward || event.driftingCache) return copy(event);
    const members = this.order.filter(player => memberIds.includes(player.playerId) && player.alive && !player.left);
    const context = this._routeEventContext(exploration, { event,
      bankRecord: Math.max(0, ...members.map(player => this.bankAccounts.get(player.playerId)?.record || 0)),
      players: members.map(player => ({ playerId: player.playerId, life: player.life, maxLife: player.maxLife, gold: player.gold,
        hope: player.hope, hopeCapacity: hopeCapacityOf(player), routeConsumables: copy(player.routeConsumables || {}),
        roster: player.roster.map(unit => ({ ...unit, name: this.fullCatalog.byId.get(unit.operatorId)?.name || unit.operatorId })) })) });
    // Another party can spend or grant team resources while this scene is open.
    // Rebuild only its presentation; the stored scene, roll and votes stay authoritative.
    const view = { ...createMizukiRouteEvent(node, context), votes: copy(event.votes || {}) };
    if (view.state.eventKey === 'prts_ro2_event_53' && this.routeMissions.missions.length)
      view.choices = view.choices.map(choice => choice.taskId ? { ...choice, available: false } : choice);
    return view;
  }

  _grantRouteItem(player, itemId, count = 1) {
    const type = OFFICIAL.rawTopic.items[itemId]?.type;
    if (!type || !Number.isInteger(count) || count < 1) return [];
    const personal = { rogue_2_hp: 'life', rogue_2_hpmax: 'maxLife', rogue_2_gold: 'gold', rogue_2_population: 'hope', rogue_2_shield: 'shield' }[itemId];
    if (personal) {
      if (personal === 'hope') { grantHope(player, count); return []; }
      const previous = player[personal]; player[personal] = Math.min(9999, player[personal] + count);
      if (personal === 'gold') this._recordVariationGold(player.playerId, player.gold - previous);
      if (personal === 'maxLife') player.life = Math.min(player.maxLife, player.life + player.maxLife - previous);
      if (personal === 'life') player.life = Math.min(player.maxLife, player.life);
      return [];
    }
    if (['rogue_2_dice', 'rogue_2_key', 'rogue_2_san', 'rogue_2_squad_capacity', 'rogue_2_exp'].includes(itemId)) {
      this._collectibleResource(itemId, count); return [];
    }
    if (type === 'RELIC') { this._grantRouteCollectible(itemId); return []; }
    if (type === 'DICE_TYPE') { this.diceId = itemId; return []; }
    if (['RECRUIT_TICKET', 'UPGRADE_TICKET'].includes(type)) {
      const definition = OFFICIAL.rawTopic[type === 'UPGRADE_TICKET' ? 'upgradeTickets' : 'recruitTickets'][itemId];
      const ids = [];
      for (let i = 0; i < count; i++) {
        const professions = definition?.professionList || [];
        const fullRoster = Object.keys(MIZUKI_PROFESSIONS).filter(value => value !== 'ANY').every(value => professions.includes(value));
        const kind = type === 'UPGRADE_TICKET' || fullRoster ? 'advanced' : 'normal';
        const profession = kind === 'normal' ? professions[0] || 'ANY' : 'ANY';
        const ticket = createMizukiRecruitTicket({ id: 'mz' + (++this.offerSeq) + 'p' + player.seat + 'tsource', profession,
          kind, name: OFFICIAL.rawTopic.items[itemId].name, iconId: OFFICIAL.rawTopic.items[itemId].iconId });
        ticket.sourceItemId = itemId; ticket.promotionOnly = type === 'UPGRADE_TICKET';
        if (ticket.promotionOnly) { ticket.recruitLimit = 1; ticket.count = 1; }
        ticket.freeHope = ticket.promotionOnly || OFFICIAL.rawTopic.items[itemId].subType === 'TEMP_TICKET';
        ticket.preferredProfessions = kind === 'normal' ? professions : [];
        if (ticket.promotionOnly) ticket.allowedProfessions = professions;
        ticket.allowedRarities = (definition?.rarityList || []).map(value => Number(value.replace('TIER_', '')));
        ticket.extraFreeRarities = (definition?.extraFreeRarity || []).map(value => Number(value.replace('TIER_', '')));
        ticket.extraEliteNum = Math.max(0, definition?.extraEliteNum || 0);
        if (OFFICIAL.rawTopic.items[itemId].subType === 'TEMP_TICKET') {
          ticket.randomCandidateCount = 1; ticket.directPromotion = true; ticket.recruitLimit = 1; ticket.count = 1;
        }
        player.tickets.push(ticket); ids.push(ticket.id);
      }
      return ids;
    }
    if (NATIVE_ITEMS.includes(itemId)) { this._grantNativeItem(itemId, count); return []; }
    if (type === 'ACTIVE_TOOL') {
      for (let n = 0; n < count; n++) this._scoreFor(player.playerId).itemsGained++;
      // A support tool occupies the single held-tool slot, including another copy of the same tool.
      player.routeInventory = { [itemId]: 1 };
      return [];
    }
    if (type !== 'CUSTOM_TICKET') return [];
    player.routeConsumables ||= {};
    player.routeConsumables[itemId] = Math.min(9999, (player.routeConsumables[itemId] || 0) + count);
    return [];
  }

  _grantRouteCollectible(id, ticketIds = new Map()) {
    const spec = mizukiCollectibleSpec(id);
    if (!spec || !spec.stackable && this.collectibles.includes(id)) return;
    this.collectibles.push(id);
    for (const player of this.order) if (player.alive && !player.left) this._scoreFor(player.playerId).itemsGained++;
    for (const effect of mizukiCollectibleEffects([id])) {
      const values = effect.values;
      if (effect.key === 'immediate_mutation') this._giveMutation(Math.max(0, Math.trunc(values.count || 0)), this._active(), 'route-relic:' + id + ':' + this.collectibles.length);
      if (effect.key === 'immediate_cost') this._collectibleResource(values.id, -Math.max(0, values.count || 0));
      if (effect.key === 'set_dice' && OFFICIAL.modules.dice.dice[values.id]) this.diceId = values.id;
      if (effect.key === 'upgrade_dice') {
        const next = OFFICIAL.modules.dice.dice[this.diceId]?.upgradeDiceId;
        if (next && OFFICIAL.modules.dice.dice[next]) this.diceId = next;
      }
      if (effect.key === 'immediate_virtue') {
        const base = value => 1 + (Number(value.split('_').at(-1)) - 1) % 7;
        const ids = Object.keys(OFFICIAL.rawTopic.squadBuffData).filter(value => Number(value.split('_').at(-1)) <= 7
          && !this.floorState.virtues.some(virtue => base(virtue.id) === base(value) && !virtue.used));
        for (const virtueId of this._rng('relic-virtue:' + id).shuffle(ids).slice(0, Math.max(0, values.count || 0))) {
          const virtue = { id: virtueId, zoneId: this.explorationState?.zoneKey || '', used: false };
          const index = this.floorState.virtues.findIndex(value => base(value.id) === base(virtueId));
          if (index < 0) this.floorState.virtues.push(virtue); else this.floorState.virtues[index] = virtue;
          this._applyVirtueRewards(virtue, ticketIds);
        }
      }
      if (effect.key === 'count_a_to_b') for (const player of this._active()) {
        if (values.id_a === 'rogue_2_hp' && values.id_b === 'rogue_2_shield') {
          player.shield = Math.min(9999, player.shield + player.life); player.life = Math.min(1, player.life);
        }
      }
    }
    for (const reward of mizukiCollectibleImmediateRewards(id)) {
      const shared = { rogue_2_squad_capacity: 'squadCapacity', rogue_2_dice: 'dice', rogue_2_key: 'key', rogue_2_san: 'light' }[reward.id];
      if (NATIVE_ITEMS.includes(reward.id)) { this._grantNativeItem(reward.id, reward.count); continue; }
      if (shared) {
        if (shared === 'light') this._changeLight(reward.count);
        else this[shared] = Math.min(9999, this[shared] + reward.count);
      }
      else for (const player of this._active()) {
        const ids = this._grantRouteItem(player, reward.id, reward.count);
        ticketIds.set(player.playerId, [...(ticketIds.get(player.playerId) || []), ...ids]);
      }
    }
    if (mizukiCollectibleEffects([id]).some(effect => effect.key === 'shop_discount')) for (const player of this.order)
      for (const offer of player.shop?.offers || []) if (!offer.sold) offer.price = Math.max(0, Math.floor(offer.basePrice * (offer.discount || 1) * this._collectibleShopMultiplier()));
  }

  _collectibleResource(itemId, count, members = this._active(), { protectLife = false } = {}) {
    const shared = { rogue_2_dice: 'dice', rogue_2_key: 'key', rogue_2_san: 'light', rogue_2_squad_capacity: 'squadCapacity' }[itemId];
    if (shared) {
      if (shared === 'light') this._changeLight(count);
      else this[shared] = Math.max(shared === 'squadCapacity' ? 1 : 0, Math.min(9999, this[shared] + count));
      return;
    }
    if (itemId === 'rogue_2_exp' && count > 0) { this._gainCommandExperience(Math.trunc(count)); return; }
    const key = { rogue_2_hp: 'life', rogue_2_hpmax: 'maxLife', rogue_2_gold: 'gold', rogue_2_population: 'hope', rogue_2_shield: 'shield' }[itemId];
    if (!key) return;
    for (const player of members) {
      if (key === 'hope') { grantHope(player, count); continue; }
      const min = key === 'maxLife' || key === 'life' && protectLife ? 1 : 0;
      const previous = player[key];
      player[key] = Math.max(min, Math.min(key === 'life' ? player.maxLife : 9999, player[key] + count));
      if (key === 'gold') this._recordVariationGold(player.playerId, player.gold - previous);
      if (key === 'maxLife') player.life = Math.min(player.life, player.maxLife);
    }
  }

  _collectibleShopMultiplier() {
    return mizukiCollectibleEffects(this.collectibles).filter(effect => effect.key === 'shop_discount')
      .reduce((scale, effect) => scale * Math.max(0, 1 + Number(effect.values.up || 0)), 1);
  }

  _collectibleDiceSpent(count) {
    if (!(count > 0)) return;
    for (const effect of mizukiCollectibleEffects(this.collectibles)) if (effect.key === 'gain_on_dice_roll')
      this._collectibleResource(effect.values.id, effect.values.count * count);
  }

  _beginRouteRecruit(ticketIds, continuation) {
    if (![...ticketIds.values()].some(ids => ids.length)) return false;
    this.phase = PHASE.RECRUIT; this.continuation = continuation; this._resetReady();
    for (const player of this._active()) {
      player.recruit = { ticketIds: ticketIds.get(player.playerId) || [], activeTicketId: null, canSkip: true, squadCapacity: this.squadCapacity };
      this._refreshRecruit(player);
    }
    return true;
  }

  _enterPrep() {
    this._applyVariationBattleEntry();
    this.facilityPlacements = {};
    this.phase = PHASE.PREP;
    this._resetReady();
    const id = this.completedNodes + ':' + this.currentNode.id;
    for (const sender of this.order) this._flushEquipmentGifts(sender);
    for (const sender of this.order.filter((player) => !player.alive && player.equipmentEffects?.some((ref) => ref.key === 'effect:builtin_gift'))) {
      const result = dispatchMizukiEquipmentMeta(sender, { ...this._equipmentOptions(sender), hook: 'onRoundStart', executionId: 'eliminated:' + id });
      if (result.ok) this._flushEquipmentGifts(sender);
    }
    for (const player of this._active()) {
      const routeRound = this._strategyRouteHook(player, 'onRoundStart');
      const routeIncome = this._strategyRouteHook(player, 'onIncome');
      const deferredPrep = this._strategyPrepHook(player);
      this._nativeHook(player, 'onRoundStart', { round: this.round }, id, { skipBand: routeRound || deferredPrep });
      const event = this._nativeHook(player, 'onIncome', { round: this.round, income: 0, pending: 0 }, id, { skipBand: routeIncome });
      const key = 'incomePaid:' + id;
      if (!player.nativeHookIds.includes(key)) {
        player.nativeHookIds.push(key);
        this._grantEconomicHope(player, Math.max(0, Math.trunc(event.income || 0)) + Math.max(0, Math.trunc(event.pending || 0)));
      }
      this._nativeHook(player, 'onPrepStart', { round: this.round }, id);
    }
    this._prepareFields();
  }

  _prepareFields({ battleStart = false } = {}) {
    this._clearFields();
    this.prepGeneration++;
    const stageId = this.currentNode?.eventBattleStageId || this.currentNode?.stageId;
    if (!stageId || !this.stageOptions.some((stage) => stage.stageId === stageId && stage.available)) {
      throw new TypeError('The selected official Mizuki stage is unavailable');
    }
    const extraDeploy = (this.selectedSquad?.effects || []).filter((effect) => effect.key === 'level_char_limit_add')
      .reduce((sum, effect) => sum + (effectValues(effect).value || 0), this.cognitionMods.deployLimit || 0);
    // The ending knight's +1 is installed separately below. All other owned
    // relics use the same original deployment-limit blackboard as squads.
    const collectibleDeploy = this.collectibles.filter(id => id !== MIZUKI_ENDING_RELICS.knight)
      .flatMap(id => mizukiCollectibleSpec(id)?.buffs || [])
      .filter(effect => effect.key === 'level_char_limit_add')
      .reduce((sum, effect) => sum + (effectValues(effect).value || 0), 0);
    const groups = this.currentNode.type === 'boss' ? pairPlayers(this._active()) : this._active().map((player) => [player]);
    for (const members of groups) {
      const fieldId = this.currentNode.type === 'boss' ? `b:${members.map((player) => player.playerId).join(':')}` : `n:${members[0].playerId}`;
      for (const player of members) player.fieldId = fieldId;
      const fieldSeed = deriveSeed(this.seed, this.completedNodes + ':' + fieldId);
      const official = createOfficialMizukiStage(stageId, { data: this.ds, seed: fieldSeed, balance: this.opts.stageBalance || {} });
      const knight = this._difficultyAreaCount() < 5 && !this.endingProgress.knightDeaths.length
        && this.endingProgress.choices.some((choice) => choice.relicId === MIZUKI_ENDING_RELICS.knight)
        && this.collectibles.includes(MIZUKI_ENDING_RELICS.knight) && !this.collectibles.includes(MIZUKI_ENDING_RELICS.deadKnight);
      const floor = this.explorationState ? normalizeMizukiDungeon(this.explorationState.dungeon).floors
        .find((entry) => entry.key === this.explorationState.zoneKey) : null;
      if (knight && !floor?.isExtraRegion) official.officialWaveOptions = { ...official.officialWaveOptions,
        enabledHiddenGroups: [...new Set([...(official.officialWaveOptions?.enabledHiddenGroups || []), 'allydonq'])] };
      const grid = new Grid(official.stage, official.rect), occupied = new Set();
      const facilityBlocked = mizukiPrepFacilityBlocks(official.officialLevel);
      for (const place of this.facilityPlacements[fieldId] || []) facilityBlocked.add(place.row + ',' + place.col);
      const missionOptions = mizukiRouteMissionBattle(this.routeMissions, members.map(player => player.playerId));
      // Each doctor has an independent eight-slot field allowance; neither
      // the original stage limit nor carried lineup size supplies that base.
      const baseLimit = Math.max(1, 8 + extraDeploy + collectibleDeploy + mizukiDifficultyDeployDelta(this.difficultyGrade) + missionOptions.deployDelta
        + (this.collectibles.includes(MIZUKI_ENDING_RELICS.knight) ? 1 : 0));
      const deployLimits = Object.fromEntries(members.map(player => [player.playerId, mizukiEquipmentDeployLimit(player, { gd: this.gd, baseLimit })]));
      const deployLimit = Math.max(...Object.values(deployLimits));
      const players = members.map((player) => {
        syncMizukiPrep(player, { source: this.ds, grid, occupied, facilityBlocked, collectibles: this.collectibles, deployLimit: deployLimits[player.playerId] });
        const input = { playerId: player.playerId, seat: player.seat, units: mizukiPrepInput(player, { source: this.ds, grid, collectibles: this.collectibles }),
          bonds: copy(this._prepBonds(player)), layers: copy(player.layers || {}), progression: { layers: copy(player.layers || {}) },
          bandId: player.bandId, squadMods: copy(this.squadMods), effects: copy(player.equipmentEffects || []) };
        getDefaultRegistry().get('global:contentb_info')?.onBattleStart(this._metaContext(player), { input, kind: this.currentNode.type === 'boss' ? 'boss' : 'normal' });
        if (battleStart) this._nativeHook(player, 'onBattleStart', { input, kind: this.currentNode.type === 'boss' ? 'boss' : 'normal' }, this.completedNodes + ':' + this.currentNode.id);
        return input;
      });
      const battleId = [this.seed.toString(36), this.matchNo, this.completedNodes, this.battleEpoch, this.prepGeneration, fieldId].join('.');
      const kind = this.currentNode.type === 'boss' ? 'boss' : 'normal';
      const battleDiceKey = JSON.stringify([this.currentNode.id, fieldId]);
      const engine = new this.CombatClass({ ...official, battleId, fieldId, seed: fieldSeed, players, kind,
        battleDice: this._battleDiceOptions(battleDiceKey, members.map(player => player.playerId)),
        difficultyGrade: this.difficultyGrade, difficultyAreaCount: this._difficultyAreaCount(), collectibles: copy(this.collectibles), virtues: copy(this.floorState.virtues),
        variation: this._currentVariationId(),
        collectibleContext: this._collectibleCombatContext(),
        flags: { ...official.flags, layerGainsEnabled: kind === 'normal' },
        teamHp: null, deployLimit, deployLimits, content: 'full' });
      const hookBattle = engine.battle?.allyUnits && engine.battle?.enemies && typeof engine.battle.on === 'function'
        ? engine.battle : null;
      if (hookBattle) installMizukiEndingRelics(hookBattle, this.collectibles);
      const missionStats = hookBattle ? installMizukiRouteMissionBattle(hookBattle, missionOptions) : null;
      for (const place of this.facilityPlacements[fieldId] || []) {
        const result = engine.command(place.playerId, { type: 'deployFacility', ...place });
        if (!result.ok) throw new TypeError('Original facility card placement could not be restored');
      }
      this.fields.set(fieldId, { fieldId, battleId, battleDiceKey, engine, kind, partyId: this._scopeParty?.id || null,
        players: members.map((player) => player.playerId), setup: official, missionStats, chargedLeaks: 0, stageInfo: copy(official.stageInfo) });
    }
  }

  _battleDiceOptions(key, memberIds) {
    const maxDiceUses = Math.max(1, ...(this.selectedSquad?.effects || []).filter(effect => effect.key === 'battle_dice_up')
      .map(effect => effectValues(effect).count || 1));
    const canSpend = () => this.dice >= 1 && (this.battleDiceSpent[key] || 0) < maxDiceUses;
    return { id: this.diceId || 'rogue_2_dice_1', maxDiceUses, usedDiceUses: this.battleDiceSpent[key] || 0, canSpend,
      spend: () => {
        if (!canSpend()) return false;
        this.dice--; this.battleDiceSpent[key] = (this.battleDiceSpent[key] || 0) + 1;
        this._collectibleDiceSpent(1);
        try { this.opts.onCheckpoint?.(this); } catch (error) { this.log.warn('[mizuki] checkpoint', error); }
        return true;
      },
      onRoll: result => this._routeMissionProgress({ diceUsed: 1, diceSpent: 1, diceRoll: result.roll }, { memberIds }) };
  }

  _difficultyAreaCount(exploration = this.explorationState) {
    if (!exploration) return 1;
    this._difficultyFloorCache ||= new WeakMap();
    let floors = this._difficultyFloorCache.get(exploration.dungeon);
    if (!floors) {
      floors = normalizeMizukiDungeon(exploration.dungeon, { sourceLabel: exploration.sourceLabel }).floors;
      this._difficultyFloorCache.set(exploration.dungeon, floors);
    }
    return Math.max(1, floors.find((floor) => floor.key === exploration.zoneKey)?.ordinaryFloor || 1);
  }

  _explorationView(state, { votes = {}, currentNodeId = null } = {}) {
    if (!state) return mizukiExplorationView(state, this.stageOptions, { votes, currentNodeId });
    this._explorationViews ||= new WeakMap();
    const missionNodeId = this.floorState.eventLedger?.claims?.prts_ro2_event_53?.nodeId;
    const signature = JSON.stringify([this.revision, state.zoneKey, state.cursor, state.trace, votes, currentNodeId, missionNodeId]);
    const cached = this._explorationViews.get(state);
    if (cached?.signature === signature) return copy(cached.view);
    const view = mizukiExplorationView(state, this.stageOptions, { votes, currentNodeId });
    if (missionNodeId) for (const node of view.nodes) if (node.type === 'MISSION' && node.id !== missionNodeId) {
      node.type = 'INCIDENT'; node.title = '不期而遇'; node.description = '';
    }
    this._explorationViews.set(state, { signature, view });
    return copy(view);
  }

  _prepContext(player) {
    const field = this.fields.get(player.fieldId), members = this._active().filter((unit) => unit.fieldId === player.fieldId);
    const facilityBlocked = mizukiPrepFacilityBlocks(field?.setup?.officialLevel);
    for (const place of this.facilityPlacements[player.fieldId] || []) facilityBlocked.add(place.row + ',' + place.col);
    return { source: this.ds, grid: field?.engine.battle?.grid,
      deployLimit: field?.engine.deployLimitFor?.(player.playerId) ?? field?.engine.deployLimit ?? 8,
      collectibles: [...this.collectibles],
      facilityBlocked,
      fieldDeployCount: (player.prep?.board || []).filter(place => player.roster.some(unit => unit.uid === place.uid)).length,
      otherOccupied: new Set(members.filter((member) => member !== player).flatMap((member) => member.prep?.board || [])
        .map((place) => `${place.row},${place.col}`)) };
  }

  _prepPublicView() {
    return { controlMode: 'automatic', shopDisabled: true, fields: [...this.fields.values()].map((field) => ({
      fieldId: field.fieldId, deployLimit: field.engine.deployLimit, boards: this._active().filter((player) => player.fieldId === field.fieldId)
        .map((player) => ({ playerId: player.playerId, deployCap: field.engine.deployLimitFor?.(player.playerId) ?? field.engine.deployLimit,
          board: mizukiPrepView(player, { source: this.ds }).board })) })) };
  }

  _startBattle() {
    for (const player of this._active()) delete player.battleOutcome;
    for (const player of this._active()) this._nativeHook(player, 'onPrepEnd', { round: this.round }, this.completedNodes + ':' + this.currentNode.id);
    this._prepareFields({ battleStart: true });
    this.safePlayers = this._active().map((player) => ({ ...copy(player), ready: false }));
    this.phase = PHASE.COMBAT;
    this.battleStage = this.currentNode.type === 'boss' ? 'boss' : 'normal';
    if (!this.battleTimer) {
      this.battleTicks = 0; this.battleAccumulator = 0; this.battleLastAt = this.now();
      this.battleTimer = this.sched.setInterval(() => this._tickBattle(), BATTLE_MS);
    }
  }

  _tickBattle() {
    if (this.disposed || this.ended) return;
    const now = this.now(), elapsed = Math.max(0, now - this.battleLastAt);
    this.battleLastAt = now;
    if (this.manualPaused) return;
    this.battleAccumulator += elapsed / 1000 * GAME_SPEED;
    const cap = maxTicksPerInterval(GAME_SPEED);
    let ticks = Math.floor(this.battleAccumulator / TICK + 1e-9);
    if (ticks > cap) { ticks = cap; this.battleAccumulator = 0; }
    else this.battleAccumulator -= ticks * TICK;
    try {
      for (let tick = 0; tick < ticks && !this.ended; tick++) {
        const running = [...this.expedition.parties.values()].filter((party) => this.partyStates.get(party.id)?.phase === PHASE.COMBAT);
        if (!running.length) { this._stopBattle(); return; }
        for (const party of running) {
          if (this.ended) return;
          if (!this.expedition.parties.has(party.id)) continue;
          this._withParty(party, () => this._tickPartyBattle(), { settle: false });
        }
        this.battleTicks++;
        const finished = ![...this.partyStates.values()].some((state) => state.phase === PHASE.COMBAT);
        if (this.battleTicks % 3 === 0 || finished) {
          // Keep battle animation, effects and objective-health snapshots at
          // 20 Hz. Route/roster/private panels only need a 5 Hz idle refresh;
          // commands and phase transitions still publish immediately in _commit.
          const snapshots = this._fieldViews({ stream: true });
          // Existing open pages negotiate stream v1 and still need full
          // metadata in their periodic frames. Build that fallback only when
          // one such recipient actually exists, once for this source frame.
          let legacyFields;
          const legacyFieldViews = () => legacyFields ||= this._fieldViews().map(value => ({
            ...value, ...snapshots.find(snapshot => snapshot.fieldId === value.fieldId),
          }));
          for (const snapshot of snapshots) {
            const field = this.fields.get(snapshot.fieldId);
            // Simulation already caps this stream at twenty Hz. A short
            // transport floor avoids dropping the next source frame merely
            // because another room delayed the previous actual write.
            const events = field.engine.drainEvents?.() || [];
            if (events.length) this._broadcast({ t: 'b.ev', battleId: field.battleId, fieldId: field.fieldId, events });
            let legacySnapshot;
            this._broadcast(markSend({ ...snapshot, time: snapshot.t, t: 'b.snap' }, { cadenceMs: 10,
              legacyMessage: () => legacySnapshot ||= markSend({
                ...legacyFieldViews().find(value => value.fieldId === snapshot.fieldId), time: snapshot.t, t: 'b.snap',
              }, { cadenceMs: 10 }) }));
          }
          if (finished) this._emit();
          else {
            if (this.battleTicks % 12 === 0) {
              let legacyPublic;
              this._broadcast(markSend(this.publicView({ fields: snapshots }),
                { priority: 'medium', periodic: true, cadenceMs: 200,
                  legacyMessage: () => legacyPublic ||= markSend(this.publicView({ fields: legacyFieldViews() }),
                    { priority: 'medium', periodic: true, cadenceMs: 200 }) }));
            }
            // Spread the same five updates/second/player over four battle
            // frames instead of building all four private rosters at once.
            const player = this.order[Math.floor(this.battleTicks / 3) % 4];
            if (player && !player.left && player.connected) this._sendCombatPrivate(player.playerId);
          }
        }
        if (finished) { this._stopBattle(); break; }
      }
    } catch (error) { this.log.error('[mizuki] combat failed', error); this._finish(false, 'engine_error'); }
  }

  _tickPartyBattle() {
    if (!this._actors().length) return;
    const fields = [...this.fields.values()].filter((field) => field.partyId === this._scopeParty.id && field.active !== false);
    for (const field of fields) {
      if (!field.engine.result()) field.engine.step();
      this._creditCombatEconomy(field);
      // Progression/economic settlement must run every simulation tick, but it
      // does not need geometry, units, waves, effects or roster UI snapshots.
      const livePlayers = field.engine.battle?.players;
      const liveCovenants = typeof field.engine.covenants?.progression === 'function' && Array.isArray(livePlayers);
      const snap = liveCovenants ? { progression: field.engine.covenants.progression() } : field.engine.snapshot();
      if (snap.progression?.version === 1) for (const [playerId, state] of Object.entries(snap.progression.players || {})) {
        const player = this.players.get(playerId);
        if (!player || !field.players.includes(playerId) || !state?.layers || Array.isArray(state.layers)
          || Object.entries(state.layers).some(([id, layers]) => !own(this.ds.raw.bonds || {}, id) || !int(layers, 0, 999999))) {
          throw new TypeError('Invalid Mizuki permanent progression snapshot');
        }
        player.layers = clearNonStackingBondLayers(copy(state.layers));
      }
      if (liveCovenants) for (const state of livePlayers) {
        const player = this.players.get(state.playerId);
        if (player) this._settleEconomicBonds(player, state.bonds || {});
      }
      else for (const [playerId, bonds] of Object.entries(snap.covenants || {})) {
        const player = this.players.get(playerId);
        if (snap.progression?.version !== 1 && player && Array.isArray(bonds)) for (const bond of bonds) {
          if (typeof bond.id === 'string' && canStackBond(bond.id) && int(bond.layers, 0, 999999)) player.layers[bond.id] = bond.layers;
        }
        if (player && Array.isArray(bonds)) this._settleEconomicBonds(player, Object.fromEntries(bonds.map((bond) => [bond.id, bond])));
      }
      const result = field.engine.result();
      if (result && !['victory', 'timeout'].includes(result.outcome)) {
        this._finish(false, result.outcome === 'defeat' ? 'field_defeat' : 'combat_aborted'); return;
      }
    }
    if (fields.length && fields.every((field) => field.engine.result())) this._afterPartyCombat(fields);
  }

  _sendCombatPrivate(playerId) {
    const message = this.privateView(playerId), encoded = JSON.stringify(message);
    this._lastCombatPrivate ||= new Map();
    if (this._lastCombatPrivate.get(playerId) === encoded) return;
    // Same idle-panel deduplication as ordinary Match._sendPrivate. Reuse the
    // exact JSON here instead of encoding the large roster a second time.
    const sent = this._send(playerId, markSend(message,
      { priority: 'medium', periodic: true, cadenceMs: 200, encoded }));
    if (sent !== false) this._lastCombatPrivate.set(playerId, encoded);
    else this._lastCombatPrivate.delete(playerId);
  }

  _creditCombatEconomy(field) {
    const ledgerId = this.completedNodes + ':' + this.currentNode.id + ':' + field.kind;
    for (const [id, total] of Object.entries(field.engine.economicCoins || {})) {
      const player = this.players.get(id);
      if (!field.players.includes(id) || !player || !Number.isSafeInteger(total) || total < 0) throw new TypeError('Invalid Mizuki battle coin attribution');
      if (!player.alive || player.left) continue;
      player.economicBattleCoins ||= {};
      const charged = player.economicBattleCoins[ledgerId] || 0;
      if (total <= charged) continue;
      player.economicBattleCoins[ledgerId] = total;
      this._grantEconomicHope(player, total - charged);
    }
  }

  _afterPartyCombat(fields) {
    const damage = new Map(), directDamage = new Map();
    const add = (playerId, amount) => {
      if (!this.players.has(playerId) || !(Number.isFinite(amount) && amount >= 0)) throw new TypeError('Invalid personal Mizuki objective loss');
      damage.set(playerId, (damage.get(playerId) ?? 0) + amount);
    };
    const nativeLoss = (field) => {
      const result = field.engine.result();
      const losses = result.nativeLifeLossByPlayer ?? Object.fromEntries(Object.entries(result.perPlayer || {})
        .map(([id, player]) => [id, player.leaderLpLoss || 0]));
      for (const [id, amount] of Object.entries(losses)) {
        add(id, amount); directDamage.set(id, (directDamage.get(id) || 0) + amount);
      }
    };
    if (this.battleStage === 'unite') {
      const result = fields[0].engine.result(), remaining = uniteRemainingLeaks(this.unitePlan, result);
      for (const leak of remaining) add(leak.sourcePlayerId, Math.max(0, Number(leak.lpr) || 0));
      for (const [id, amount] of this.unitePlan.notReentered) add(id, amount);
      for (const field of this.fields.values()) if (!this._scopeParty || field.partyId === this._scopeParty.id) nativeLoss(field);
      this._settlePartyBattle(damage, directDamage); return;
    }
    this.lastResults = new Map(fields.flatMap((field) => field.players.map((playerId) => [playerId, field.engine.result().perPlayer?.[playerId]])).filter(([, value]) => value));
    if (this.battleStage !== 'boss' && this._active().length > 1 && this.lastResults.size === this._active().length) {
      const facade = this._uniteFacade(fields), plan = planUnite(facade, this.lastResults);
      if (plan) {
        // The shared Stronghold planner counts unsupported enemies as one LP.
        // Mizuki keeps each original enemy's actual objective damage instead.
        for (const id of plan.notReentered.keys()) plan.notReentered.set(id, (this.lastResults.get(id)?.leaked || [])
          .filter((leak) => leak.counted !== false && !uniteLpExempt(leak) && !facade.gd.enemy(leak.enemyKey))
          .reduce((sum, leak) => sum + Math.max(0, Number(leak.lpr ?? 1) || 0), 0));
        this._startUnite(plan, facade, fields); return;
      }
    }
    for (const field of fields) {
      for (const [id, player] of Object.entries(field.engine.result().perPlayer || {})) {
        for (const leak of player.leaked || []) if (leak.counted !== false) add(leak.sourcePlayerId || id, Math.max(0, Number(leak.lpr ?? 1) || 0));
      }
      nativeLoss(field);
    }
    this._settlePartyBattle(damage, directDamage);
  }

  _uniteFacade(fields) {
    const data = fields[0].engine.battle?.data || fields[0].setup.data, gd = Object.create(this.gd);
    const definitions = new Map([...this.lastResults.values()].flatMap((result) => (result.leaked || [])
      .filter((leak) => leak.nativeSpawn?.def).map((leak) => [leak.enemyKey, leak.nativeSpawn.def])));
    gd.enemy = (id) => data.getEnemy(id)?.raw || definitions.get(id) || this.gd.enemy(id);
    Object.defineProperty(gd, 'unite', { value: { ...this.gd.unite, maxHelpers: 1 } });
    const members = this._active().map((player) => {
      const prep = mizukiPrepView(player, { source: this.ds });
      return { ...player, bounties: [], pendingLayerGains: {}, bonds: this._prepBonds(player),
        deployCount: prep.board.filter((piece) => piece.kind === 'chess').length,
        board: new Map(prep.board.map((piece) => [`${piece.row},${piece.col}`, piece])),
        battleInput: ({ carry }) => ({ playerId: player.playerId, seat: player.seat, coords: 'field',
          units: mizukiPrepInput(player, { source: this.ds }).map((unit) => ({ ...unit, ...(carry.has(unit.uid) ? { carryState: carry.get(unit.uid) } : {}) })),
          bonds: this._prepBonds(player), layers: copy(player.layers), progression: { layers: copy(player.layers) },
          bandId: player.bandId, squadMods: copy(this.squadMods) }) };
    });
    return { gd, isSolo: members.length === 1, alivePlayers: () => members, round: this.round, lastResults: this.lastResults, dispatch() {} };
  }

  _startUnite(plan, facade, normalFields) {
    const sourceField = normalFields.find((field) => field.players.includes(plan.helpers[0].playerId));
    const setup = sourceField.setup, limit = sourceField.engine.battle?.timeLimit || setup.timeLimit;
    const { wave, players } = uniteBattleOpts(facade, plan, limit);
    const original = new Map();
    for (const leaker of plan.leakers) for (const leak of this.lastResults.get(leaker.playerId).leaked || []) {
      if (leak.counted === false) continue;
      const key = `${leaker.playerId}:${leak.enemyKey}`;
      if (!original.has(key)) original.set(key, []); original.get(key).push(leak);
    }
    const balance = { hpMul: 0.75, atkMul: 0.75, ...(this.opts.uniteBalance || {}) };
    if (![balance.hpMul, balance.atkMul].every((value) => Number.isFinite(value) && value > 0)) throw new TypeError('Invalid Mizuki unite balance');
    const spawns = wave.spawns.map((spawn) => {
      const leak = original.get(`${spawn.sourcePlayerId}:${spawn.enemyKey}`)?.shift();
      if (!leak?.nativeSpawn?.route) throw new Error('Native Mizuki leak route is missing');
      const saved = leak.nativeSpawn;
      return { ...spawn, route: copy(saved.route), ...(saved.pos ? { pos: [...saved.pos] } : {}),
        ...(saved.def ? { def: copy(saved.def) } : {}), tag: saved.tag, countInTotal: leak.counted,
        mods: { ...saved.mods, hpMul: (saved.mods.hpMul ?? 1) * balance.hpMul, atkMul: (saved.mods.atkMul ?? 1) * balance.atkMul } };
    });
    for (const field of normalFields) field.active = false;
    const fieldId = `u:${this._scopeParty.id}`, battleId = `${sourceField.battleId}.unite`;
    const engine = new this.CombatClass({ stage: setup.stage, nativeStage: setup.nativeStage, stageId: setup.stageId, rect: setup.rect,
      data: setup.data, officialStageLevel: setup.officialLevel, officialRunes: setup.officialRunes,
      nativeEnemyBehaviors: true, routes: setup.routes, spawns, battleId, fieldId, seed: deriveSeed(this.seed, battleId),
      timeLimit: limit, kind: 'unite', players, flags: { ...setup.flags, layerGainsEnabled: false },
      battleDice: this._battleDiceOptions(sourceField.battleDiceKey, players.map(player => player.playerId)),
      difficultyGrade: this.difficultyGrade, difficultyAreaCount: this._difficultyAreaCount(), collectibles: copy(this.collectibles), virtues: copy(this.floorState.virtues),
      variation: this._currentVariationId(),
      collectibleContext: this._collectibleCombatContext(),
      deployLimit: sourceField.engine.deployLimit, deployLimits: Object.fromEntries(players.map(player =>
        [player.playerId, sourceField.engine.deployLimits?.[player.playerId] ?? sourceField.engine.deployLimit])), teamHp: null, content: 'full' });
    const hookBattle = engine.battle?.allyUnits && engine.battle?.enemies && typeof engine.battle.on === 'function'
      ? engine.battle : null;
    if (hookBattle) installMizukiEndingRelics(hookBattle, this.collectibles);
    const missionStats = hookBattle ? installMizukiRouteMissionBattle(hookBattle,
      mizukiRouteMissionBattle(this.routeMissions, players.map(player => player.playerId))) : null;
    for (const player of this._active()) player.fieldId = fieldId;
    this.fields.set(fieldId, { fieldId, battleId, engine, kind: 'unite', partyId: this._scopeParty.id,
      players: players.map((player) => player.playerId), setup, missionStats, active: true, balance });
    this.unitePlan = plan; this.battleStage = 'unite'; this._commit();
  }

  _settlePartyBattle(damage, directDamage = new Map()) {
    if (!(damage instanceof Map)) throw new TypeError('Mizuki life damage requires personal attribution');
    const members = this._active();
    const variationEffects = mizukiVariationSpec(this._currentVariationId())?.effects || {};
    const lifeLossMultiplier = variationEffects.lifeLossMultiplier || 1;
    if (variationEffects.battleMaxLife) for (const player of members)
      player.maxLife = Math.min(9999, player.maxLife + variationEffects.battleMaxLife);
    const completedFields = [...this.fields.values()].filter((field) => !this._scopeParty || field.partyId === this._scopeParty.id);
    const activeFields = completedFields.filter(field => field.active !== false);
    const cleared = activeFields.length > 0 && activeFields.every(field => field.engine.result()?.outcome === 'victory');
    for (const player of members) {
      const field = completedFields.find(value => value.players.includes(player.playerId) && value.kind !== 'unite')
        || activeFields.find(value => value.players.includes(player.playerId));
      const original = this.lastResults.get(player.playerId) || field?.engine.result()?.perPlayer?.[player.playerId] || {};
      const leaked = (original.leaked || []).filter(leak => leak.counted !== false).length;
      const through = this.battleStage === 'unite' ? activeFields.reduce((count, value) => count
        + Object.entries(value.engine.result()?.perPlayer || {}).reduce((sum, [id, result]) => sum
          + (result.leaked || []).filter(leak => leak.counted !== false && (leak.sourcePlayerId || id) === player.playerId).length, 0), 0)
        + (original.leaked || []).filter(leak => leak.counted !== false && !uniteLpExempt(leak)
          && !(field?.engine.battle?.data || field?.setup?.data)?.getEnemy(leak.enemyKey)).length : leaked;
      const lpLoss = (damage.get(player.playerId) || 0) * lifeLossMultiplier;
      const battleId = field?.battleId || `${this._scopeParty?.id || 'team'}:${this.round}:${this.currentNode.id}`;
      player.battleOutcome = { id: battleId + ':' + player.playerId, nodeId: this.currentNode.id, battleId,
        perfect: cleared && lpLoss === 0, lpLoss, cleared, leaked, through };
    }
    const missionFields = completedFields.map(field => field.missionStats).filter(Boolean);
    const missionIds = [...new Set(missionFields.flatMap(stats => stats.missionIds))];
    this._routeMissionProgress({ battlesPassed: completedFields.filter(field => field.active !== false)
      .every(field => field.engine.result()?.outcome === 'victory') ? 1 : 0,
      kills: missionFields.reduce((sum, stats) => sum + stats.kills, 0), seaKills: missionFields.reduce((sum, stats) => sum + stats.seaKills, 0),
      professions: [...new Set(missionFields.flatMap(stats => stats.professions))] }, { missionIds });
    const layerGains = completedFields.map((field) => field.engine.collectibles?.layerGains || {});
    const killRelic = 'rogue_2_relic_fight_131', battleRelic = 'rogue_2_relic_fight_158';
    const kills = layerGains.reduce((sum, gains) => sum + Math.max(0, Math.trunc(gains[killRelic] || 0)), 0);
    const battles = Math.max(0, ...layerGains.map((gains) => Math.max(0, Math.trunc(gains[battleRelic] || 0))));
    if (kills && this.collectibles.includes(killRelic)) this.collectibleLayers[killRelic] = Math.min(99, (this.collectibleLayers[killRelic] || 0) + kills);
    if (battles && this.collectibles.includes(battleRelic)) this.collectibleLayers[battleRelic] = Math.min(98, (this.collectibleLayers[battleRelic] || 0) + battles);
    const knightKilled = completedFields.some((field) => (field.engine.result()?.officialFacilities?.logs?.killed || 0) > 0);
    const floor = this.explorationState ? normalizeMizukiDungeon(this.explorationState.dungeon).floors
      .find((entry) => entry.key === this.explorationState.zoneKey) : null;
    if (floor && (!floor.isExtraRegion || merchantBattleNode(this.currentNode))) this.endingProgress = recordMizukiEndingBattle(this.endingProgress, { nodeId: this.currentNode.id,
      stageId: this.currentNode.eventBattleStageId || this.currentNode.stageId, eventBattle: !!this.currentNode.eventBattleStageId,
      floor: floor.ordinaryFloor, knightKilled,
      cleared: completedFields.filter((field) => field.active !== false).every((field) => field.engine.result()?.outcome === 'victory') });
    if (knightKilled && !this.collectibles.includes(MIZUKI_ENDING_RELICS.deadKnight))
      this.collectibles.push(MIZUKI_ENDING_RELICS.deadKnight);
    this._syncEndingRoutes();
    for (const [id, amount] of damage) {
      const known = this.players.get(id);
      if (known && (known.left || !known.alive)) continue;
      const player = members.find((member) => member.playerId === id);
      if (!player || !Number.isFinite(amount) || amount < 0) throw new TypeError('Mizuki life loss belongs to another party');
      const adjustedAmount = amount * lifeLossMultiplier;
      const leakDamage = Math.max(0, amount - (directDamage.get(id) || 0)) * lifeLossMultiplier;
      const protectedDamage = Math.min(player.shield, leakDamage);
      player.shield -= protectedDamage;
      player.life = Math.max(0, player.life - (adjustedAmount - protectedDamage));
    }
    const protectionId = 'rogue_2_relic_fight_119';
    const native = floor?.nodes.find(node => node.id === this.currentNode.id);
    const futureIds = [...(native?.next || [])], seenFuture = new Set();
    let hasFutureBattle = !floor;
    while (futureIds.length) {
      const id = futureIds.shift(); if (seenFuture.has(id)) continue; seenFuture.add(id);
      const node = floor.nodes.find(value => value.id === id); if (!node) continue;
      if (['BATTLE_NORMAL', 'BATTLE_ELITE', 'BATTLE_BOSS'].includes(node.type)) hasFutureBattle = true;
      futureIds.push(...node.next);
    }
    const protectedFailure = this.currentNode.type !== 'boss' && hasFutureBattle && this.collectibles.includes(protectionId)
      && members.some(player => player.life <= 0);
    if (protectedFailure) {
      for (const player of members) if (player.life <= 0) {
        player.life = 1; player.metaMessages.push('“时光之末”已生效：目标生命恢复为1，继续探索。');
      }
      this.collectibles.splice(this.collectibles.indexOf(protectionId), 1);
    }
    const leaked = [...this.fields.values()].some((field) => (!this._scopeParty || field.partyId === this._scopeParty.id)
      && (field.engine.snapshot().leakedCount > 0 || field.engine.result()?.leakedCount > 0 || field.engine.result()?.nativeLifeLoss > 0));
    const lightEffects = mizukiCollectibleEffects(this.collectibles);
    const lightLossScale = Math.max(0, 1 + lightEffects.filter(effect => effect.key === 'battle_san_scale')
      .reduce((sum, effect) => sum + effect.values.scale, 0));
    const lightLoss = ((leaked ? -5 : 0) + (members.some((player) => player.life * 2 < player.maxLife) ? -5 : 0)) * lightLossScale;
    const lightLossMultiplier = variationEffects.lightLossMultiplier || 1;
    let lightReward = 0;
    for (const effect of lightEffects) {
      if ((effect.key === 'battle_extra_reward' || !leaked && effect.key === 'gain_on_perfect') && effect.values.id === 'rogue_2_san')
        lightReward += effect.values.count * (effect.values.count < 0 ? lightLossMultiplier : 1);
    }
    // Scale losses independently from recoveries, then clamp this settlement once.
    this._changeLight(lightLoss * lightLossMultiplier + lightReward, { scaleLoss: false });
    for (const player of members) if (player.life <= 0) {
      player.alive = false; player.ready = false; player.rewards = []; player.recruit = null; player.shop = null;
      player.fieldId = 'n:' + player.playerId;
      this.expedition.removeMember(player.playerId);
      delete this.votes[player.playerId];
    }
    this.hostId = this.expedition.leaderId || this.hostId;
    if (!this.order.some((player) => player.alive && !player.left)) { this._finish(false, 'life_exhausted'); return; }
    if (!this._active().length) { this.phase = 'MIZUKI_WAITING'; this._commit(); return; }
    if (protectedFailure) { this._completeNode({ battleCleared: false }); this._commit(); return; }
    for (const effect of mizukiCollectibleEffects(this.collectibles)) if (effect.key === 'battle_extra_reward' && effect.values.id !== 'rogue_2_san')
      this._collectibleResource(effect.values.id, effect.values.count, this._active(), { protectLife: true });
    for (const player of this._active()) {
      const battleId = this.completedNodes + ':' + this.currentNode.id + ':' + player.playerId;
      this._nativeHook(player, 'onBattleResult', { result: this.lastResults?.get(player.playerId) || {},
        lpLoss: damage.get(player.playerId) || 0, perfect: !(damage.get(player.playerId) > 0), boss: this.currentNode.type === 'boss' }, battleId);
      player.lastEquipmentDrop = null;
    }
    const ending = cleared && mizukiCompletedEnding(this.endingProgress, this.collectibles);
    const finalBattle = !!ending && ending.stageId === (this.currentNode.eventBattleStageId || this.currentNode.stageId);
    this._enterReward({ finalBattle });
    if (finalBattle) this._completeNode();
    this._commit();
  }
  _enterReward({ finalBattle = false } = {}) {
    this.phase = PHASE.REWARD; this._resetReady();
    this.offerSeq++;
    const floor = this.explorationState ? normalizeMizukiDungeon(this.explorationState.dungeon).floors
      .find(entry => entry.key === this.explorationState.zoneKey) : null;
    const base = mizukiBattleBaseReward({ node: this.currentNode, floor: floor?.ordinaryFloor || 1, extraRegion: !!floor?.isExtraRegion });
    const variationEffects = mizukiVariationSpec(this._currentVariationId())?.effects || {};
    let expMultiplier = (variationEffects.commanderExpMultiplier || 1) * this.cognitionMods.commanderExpMultiplier;
    const effects = [...(this.selectedSquad?.effects || []), ...mizukiCollectibleEffects(this.collectibles)];
    for (const effect of effects) if (effect.key === 'up_reward') {
      const values = effect.values || effectValues(effect);
      if (values.id === 'rogue_2_exp' && String(values.mask).split(',').includes('battle')) expMultiplier *= 1 + Number(values.up || 0);
    }
    const commandBefore = copy(this.commander), baseExp = Math.floor(base.exp * expMultiplier);
    const exp = baseExp + this._settleBattleVirtues();
    this._gainCommandExperience(baseExp);
    const commandAfter = copy(this.commander);
    const levelRewards = mizukiCommanderLevelRewards(commandBefore.level, commandAfter.level).map(({ level, populationUp, squadCapacityUp, maxHpUp }) =>
      ({ level, populationUp, squadCapacityUp, maxHpUp }));
    const battleGold = Math.floor(base.gold * (variationEffects.battleGoldMultiplier || 1));
    this._collectibleResource('rogue_2_gold', battleGold);
    const nativeDrops = mizukiBattleNativeDrops({ node: this.currentNode, floor: floor?.ordinaryFloor || 1,
      extraRegion: !!floor?.isExtraRegion, grade: this.difficultyGrade, rng: this._rng('battle-native-drops') })
      .filter(reward => this._grantNativeItem(reward.id, reward.count));
    for (const effect of this.selectedSquad?.effects || []) if (effect.key === 'battle_extra_reward') {
      const values = effectValues(effect);
      if (values.id === 'rogue_2_hp') for (const player of this._active()) player.life = Math.min(player.maxLife, player.life + values.count);
    }
    if (this.cognitionMods.perfectShieldLifeThreshold !== null) for (const player of this._active()) {
      if (player.battleOutcome?.perfect && player.life > this.cognitionMods.perfectShieldLifeThreshold)
        player.shield = Math.min(9999, player.shield + 1);
    }
    const extraTickets = effects.filter(effect => effect.key === 'battle_extra_recruit_ticket')
      .reduce((sum, effect) => sum + Math.max(0, Math.trunc((effect.values || effectValues(effect)).count || 0)), 0);
    const extraRelics = effects.filter(effect => effect.key === 'battle_extra_relic')
      .reduce((sum, effect) => sum + Math.max(0, Math.trunc((effect.values || effectValues(effect)).count || 0)), 0);
    const relicGroups = mizukiBattleRelicDrops({ node: this.currentNode, squadEffects: this.selectedSquad?.effects || [], rng: this._rng('battle-relic-drops') });
    const offeredRelics = [...this.collectibles];
    for (const player of this._active()) {
      const equipment = grantMizukiBattleEquipment(player, { ...this._equipmentOptions(player),
        battleId: player.battleOutcome?.id || `${this.completedNodes}:${this.currentNode.id}:${player.playerId}`,
        rng: this._rng('equipment-drop:' + player.playerId) });
      if (equipment.ok) player.lastEquipmentDrop = equipment.dropped ? equipment.item : null;
      else player.metaMessages.push(equipment.detail);
      // Rescue reuses the stage's facilities. Only the original field earns
      // treasure; rebuilding it for unite must not duplicate a reward.
      const originalResults = [...this.fields.values()].filter(field => field.kind !== 'unite'
        && (!this._scopeParty || field.partyId === this._scopeParty.id) && field.players.includes(player.playerId))
        .map(field => field.engine.result());
      const fieldDrops = mizukiBattleFieldDrops(originalResults);
      const treasureGold = Math.floor(fieldDrops.gold * (variationEffects.battleGoldMultiplier || 1));
      if (treasureGold > 0) this._grantRouteItem(player, 'rogue_2_gold', treasureGold);
      const gold = battleGold + treasureGold;
      if (player.battleOutcome) {
        player.battleOutcome.rewards = { exp, gold, baseGold: battleGold, treasureGold,
          commanderBefore: commandBefore, commanderAfter: commandAfter, levelRewards };
        player.battleOutcome.autoGranted = [
          { itemId: 'rogue_2_exp', type: 'resource', count: exp, autoGranted: true },
          { itemId: 'rogue_2_gold', type: 'resource', count: gold, autoGranted: true,
            sourceTitle: treasureGold ? `作战奖励 ${battleGold} · 无主的财富 ${treasureGold}` : '作战奖励' },
          ...nativeDrops.map(reward => ({ itemId: reward.id, type: 'resource', count: reward.count,
            autoGranted: true, ownership: 'team', sourceTitle: '高难度作战额外掉落' })),
        ];
      }
      player.rewards = [];
      // Preserve automatic XP/resource settlement and the battle receipt, but
      // final ending battles have no next-node recruitment/relic selection.
      if (finalBattle) { player.recruit = null; continue; }
      const ticketProfessions = this._rng('battle-ticket-options:' + player.playerId)
        .shuffle(Object.keys(MIZUKI_PROFESSIONS).filter(id => id !== 'ANY'));
      for (let index = 0; index < 2 + extraTickets; index++) {
        const ticket = this._newTicket(player, index, { profession: ticketProfessions[index % ticketProfessions.length] });
        player.rewards.push({ id: 'ticket:' + ticket.id, type: 'recruitTicket', group: 'recruitTicket', selected: false,
          title: ticket.name, ticketId: ticket.id, itemId: ticket.iconId, iconId: ticket.iconId, profession: ticket.profession,
          description: '从本组选择一张个人招募券，每券可招募一名干员，并有三次免费刷新。' });
      }
      if (variationEffects.recruitTicketChance && this._rng('variation-ticket:' + player.playerId).chance(variationEffects.recruitTicketChance)) {
        const ticket = this._newTicket(player, 'variation', { profession: 'ANY' });
        player.rewards.push({ id: 'variation-ticket:' + ticket.id, type: 'recruitTicket', group: 'variationTicket', selected: false,
          title: ticket.name, ticketId: ticket.id, itemId: ticket.iconId, iconId: ticket.iconId, profession: ticket.profession,
          description: '从本组选择一张个人招募券，每券可招募一名干员，并有三次免费刷新。' });
      }
      const rng = this._rng('battle-relic-options:' + player.playerId);
      for (let group = 0; group < relicGroups + fieldDrops.bonusRelics; group++) for (let index = 0; index < 2 + extraRelics; index++) {
        const id = drawMizukiCollectible({ rng, owned: offeredRelics, bankRecord: this.bankAccounts.get(player.playerId)?.record || 0, cognition: this.cognitionLegacy ? undefined : this.cognitionMods }); if (!id) break;
        offeredRelics.push(id); const spec = mizukiCollectibleSpec(id);
        player.rewards.push({ id: 'relic:' + this.offerSeq + ':' + group + ':' + index, type: 'collectible', group: 'collectible:' + group,
          itemId: id, iconId: spec.iconId, rarity: spec.rarity, selected: false, title: spec.name, description: spec.description });
      }
      if (mizukiBattleDriftingCacheDrop({ node: this.currentNode, cognition: this.cognitionMods, rng: this._rng('drifting-cache:' + player.playerId) })) {
        const item = OFFICIAL.rawTopic.items.rogue_2_treasure;
        const cache = createMizukiDriftingCache({ id: 'mzcache:' + this.offerSeq + ':' + player.seat,
          rng: this._rng('drifting-cache-contents:' + player.playerId), ...this._routeEventContext() });
        player.rewards.push({ id: cache.id, type: 'driftingCache', group: 'driftingCache', selected: false,
          itemId: item.id, iconId: item.iconId, title: item.name, description: item.usage, contents: cache.contents });
      }
    }
  }

  _completeNode({ teleport = false, battleCleared = true } = {}) {
    if (this.currentNode) {
      const floor = this.explorationState && normalizeMizukiDungeon(this.explorationState.dungeon).floors.find(entry => entry.key === this.explorationState.zoneKey);
      const nodeKey = (floor?.key || 'archive') + ':' + this.currentNode.id;
      const native = floor?.nodes.find(node => node.id === this.currentNode.id);
      for (const player of this._active()) {
        const score = this._scoreFor(player.playerId);
        if (!score.completedNodeIds.includes(nodeKey)) {
          score.completedNodeIds.push(nodeKey); score.stepsPassed++;
          const kind = this.currentNode.eventBattleStageId ? 'elite' : this.currentNode.type;
          const key = { combat: 'normalBattles', elite: 'eliteBattles', boss: 'bossBattles' }[kind];
          if (key && battleCleared) score[key]++;
        }
        if (floor && native && !native.next.length && !score.completedZoneIds.includes(floor.key)) {
          score.completedZoneIds.push(floor.key); score.floorsPassed = Math.min(7, score.completedZoneIds.length);
        }
      }
    }
    if (this.currentNode?.graphNodeId) this.explorationState = completeMizukiExplorationNode(this.explorationState, this.currentNode.id, this.stageOptions);
    if (teleport && this.currentNode?.graphType === 'PORTAL') {
      const zone = generateMizukiPortalZone({ seed: deriveSeed(this.seed, this.currentNode.id), stageOptions: this.stageOptions,
        returnZoneKey: this.explorationState.zoneKey });
      this.explorationState = enterMizukiPortalExploration(this.explorationState, zone);
    }
    this._syncEndingRoutes();
    this.completedNodes++;
    for (const player of this._active()) player.recruitRefreshes = 0;
    if (this._scopeParty) this.expedition.completeNode(this._scopeParty.id, { context: this.explorationState });
    this._enterRoute();
    if (this.explorationState?.portalReturn && !this.route.length) {
      this._leaveVariationZone(this.explorationState.zoneKey, this._active().map(player => player.playerId));
      this.explorationState = leaveMizukiPortalExploration(this.explorationState);
      this._enterRoute();
      if (this._scopeParty) this.expedition.setContext(this._scopeParty.id, this.explorationState);
    }
    if (this._scopeParty && this.explorationState && !this.archiveMode && !this.route.length) this._arriveParty('floor', this.explorationState.zoneKey);
  }

  _vote(player, id, event = false) {
    if (event && this.event?.state?.pendingWish) return fail(ERR.WRONG_PHASE, '请先完成层间骰子检定。');
    const choices = event ? this._routeEventView()?.choices : this.route;
    if (!choices?.some((choice) => choice.id === id && !choice.disabled && choice.available !== false)) return fail(ERR.BAD_TARGET, '该选项已失效或原版机制尚未适配。');
    if (this.votes[player.playerId] === id) return OK;
    if (!event && this._scopeParty) {
      const result = this.expedition.vote(player.playerId, id, choices.map((choice) => choice.id));
      if (!result.ok) return fail(ERR.WRONG_PHASE, '请先处理归队确认或等待召回集合。');
    }
    this.votes[player.playerId] = id;
    if (event) this.event.votes = { ...this.votes };
    if (event || !this._scopeParty) this._resolveVoteIfReady(event);
    this._commit();
    return OK;
  }

  _resolveVoteIfReady(event = this.phase === PHASE.EVENT, decision = null) {
    if (this.event?.state?.pendingWish && !decision) return;
    const actors = this._actors();
    if (!actors.length || !actors.every((player) => own(this.votes, player.playerId))) return;
    const counts = new Map();
    for (const player of actors) { const id = this.votes[player.playerId]; counts.set(id, (counts.get(id) || 0) + 1); }
    const top = Math.max(...counts.values());
    const tied = [...counts].filter(([, count]) => count === top).map(([id]) => id);
    const host = actors.find((player) => player.playerId === this.hostId) || actors[0];
    const chosen = tied.includes(this.votes[host.playerId]) ? this.votes[host.playerId] : tied[0];
    if (!event) { this._enterNode(this.route.find((node) => node.id === chosen)); return; }
    if (this.event?.missionReward) { this._resolveRouteMissionReward(chosen); return; }
    if (this.event?.driftingCache) { this._resolveDriftingCache(chosen); return; }
    const before = this._routeEventContext(), collectiblesBefore = [...this.collectibles];
    const plan = planMizukiRouteEventChoice(this.currentNode, { ...before, choiceId: decision ? this.event.state.pendingWish.choiceId : chosen, wishDecision: decision });
    if (!plan.ok) { this.votes = {}; this.event = { ...createMizukiRouteEvent(this.currentNode, this._routeEventContext()), votes: {} }; return; }
    if (plan.pendingWish) {
      this.event.state.pendingWish = copy(plan.pendingWish); this.votes = {}; this.event.votes = {}; return;
    }
    if (plan.diceCost) {
      if (this.dice < plan.diceCost) return;
      this.dice -= plan.diceCost; this._collectibleDiceSpent(plan.diceCost);
      this._routeMissionProgress({ diceSpent: plan.diceCost }, { memberIds: this._active().map(player => player.playerId) });
    }
    const effects = plan.effects, ticketIds = new Map(), eventPlayers = this._active();
    let goldSpent = 0;
    const teamDiceBefore = this.dice, teamKeyBefore = this.key;
    for (const player of eventPlayers) {
      const maxLife = Math.max(1, Math.min(9999, player.maxLife + (effects.lifeMax || 0)));
      player.life = Math.max(0, Math.min(maxLife, player.life + (maxLife - player.maxLife) + (effects.life || 0)));
      player.maxLife = maxLife;
      player.hopeCapacity = hopeCapacityOf(player);
      if (effects.hope < 0) this._spendHope(player, -effects.hope);
      else grantHope(player, effects.hope || 0);
      player.hopeCapacity = Math.max(player.hope, Math.min(9999, player.hopeCapacity + (effects.hopeCapacity || 0)));
      const goldBefore = player.gold;
      player.gold = effects.allGold ? 0 : Math.max(0, Math.min(9999, player.gold + (effects.gold || 0)));
      const goldDelta = player.gold - goldBefore;
      this._recordVariationGold(player.playerId, goldDelta);
      goldSpent += Math.max(0, -goldDelta);
      player.shield = Math.max(0, Math.min(9999, player.shield + (effects.shield || 0)));
      if (!player.life) { player.alive = false; player.ready = false; }
      const ids = (plan.items || []).flatMap(item => this._grantRouteItem(player, item.id, item.count));
      if (plan.recruitProfessions?.length) {
        const ticket = createMizukiRecruitTicket({ id: 'mz' + (++this.offerSeq) + 'p' + player.seat + 'tevent',
          profession: plan.recruitProfessions[0], kind: 'normal', name: '联合职业调度券' });
        ticket.preferredProfessions = plan.recruitProfessions; player.tickets.push(ticket); ids.push(ticket.id);
      }
      ticketIds.set(player.playerId, ids);
    }
    goldSpent = Math.max(goldSpent, plan.goldSpent || 0);
    this.dice = Math.max(0, Math.min(9999, this.dice + (effects.dice || 0)));
    this.key = Math.max(0, Math.min(9999, this.key + (effects.key || 0)));
    this._changeLight(effects.light || 0);
    this._routeMissionProgress?.({ diceSpent: Math.max(0, teamDiceBefore - this.dice), keysSpent: Math.max(0, teamKeyBefore - this.key),
      diceUsed: plan.roll ? 1 : 0, diceRoll: plan.roll || 0,
      goldSpent }, { memberIds: eventPlayers.map(player => player.playerId) });
    this._collectibleDiceSpent(Math.max(0, teamDiceBefore - this.dice));
    this.squadCapacity = Math.min(9999, this.squadCapacity + (effects.squadCapacity || 0));
    if (plan.removeRelics) for (const id of plan.removeRelics) { const index = this.collectibles.indexOf(id); if (index >= 0) this.collectibles.splice(index, 1); }
    for (const id of plan.relics || []) this._grantRouteCollectible(id, ticketIds);
    this.endingProgress = recordMizukiEndingChoice(this.endingProgress, { choiceId: plan.choiceId, nodeId: this.currentNode.id,
      floor: before.floor, light: before.light, collectiblesBefore, collectibles: this.collectibles, endingUnlocks: this.endingUnlocks });
    this._syncEndingRoutes();
    if (plan.taskId) this._acceptRouteMission(plan.taskId);
    if (plan.purify) {
      if (plan.purify.skip) for (const player of this._active()) { if (player.routeConsumables) player.routeConsumables.rogue_2_custom_ticket_purify = 0; }
      else {
        const owner = this.players.get(plan.purify.playerId), unit = owner?.roster.find(value => value.uid === plan.purify.uid);
        if (unit && owner.routeConsumables?.rogue_2_custom_ticket_purify > 0) {
          unit.mutationId = null; owner.routeConsumables.rogue_2_custom_ticket_purify--;
        }
      }
    }
    if (plan.expedition) {
      const unit = this.players.get(plan.expedition.playerId)?.roster.find(value => value.uid === plan.expedition.uid);
      if (unit) unit.expedition = { zoneKey: this.explorationState.zoneKey, nodeId: this.currentNode.id };
    }
    this.votes = {};
    this.event = plan.event ? { ...createMizukiRouteEvent(this.currentNode, { ...this._routeEventContext(), event: plan.event }), votes: {} } : null;
    const needsPurify = this._active().some(player => player.routeConsumables?.rogue_2_custom_ticket_purify > 0
      && player.roster.some(unit => unit.mutationId));
    if (needsPurify) this.event = { ...createMizukiRouteEvent(this.currentNode, { ...this._routeEventContext(),
      event: { state: { ...before.event.state, purifyPending: true, resumeState: this.event?.state || null } } }), votes: {} };
    if (!this._active().length) { this._finish(false, 'life_depleted'); return; }
    if (plan.battleStageId) { this.currentNode.eventBattleStageId = plan.battleStageId; this._enterPrep(); return; }
    if (this._beginRouteRecruit(ticketIds, 'event')) return;
    if (this.event) this.phase = PHASE.EVENT;
    else this._completeNode({ teleport: !!plan.teleport });
  }

  handle(playerId, message) {
    if (this.disposed || this.ended || !this.started) return fail(ERR.WRONG_PHASE, '本次探索已结束或尚未开始。');
    const player = this.players.get(playerId);
    if (!player || player.left) return fail(ERR.ELIMINATED, '你已退出探索。');
    if (!player.connected) return fail(ERR.BAD_TARGET, '连接尚未恢复。');
    const type = message?.t;
    if (type === 'g.watch') {
      const field = this.fields.get(message.fieldId);
      if (!field) return fail(ERR.BAD_TARGET, '所选战场当前不可观看。');
      const snapshot = this._fieldViews().find(value => value.fieldId === field.fieldId);
      this._send(playerId, { t: 'm.field', ...field.engine.fieldMeta(), battleId: field.battleId });
      this._send(playerId, { ...snapshot, time: snapshot.t, t: 'b.snap', droppable: false });
      return OK;
    }
    if (type === 'g.emote') {
      if (!EMOTES.includes(message.id)) return fail(ERR.BAD_MSG, 'unknown emote');
      const now = this.now();
      if (Number.isFinite(player.lastEmoteAt) && now - player.lastEmoteAt < EMOTE_COOLDOWN_MS) return fail(ERR.RATE);
      player.lastEmoteAt = now;
      this._broadcast({ t: 'm.emote', playerId, id: message.id });
      return OK;
    }
    if (!player.alive) return fail(ERR.ELIMINATED, '生命耗尽后仍可交流并观看队友探索。');
    if (type === 'g.autoplay') {
      if (typeof message.on !== 'boolean') return fail(ERR.BAD_MSG, 'autoplay.on 必须是布尔值。');
      if (player.autoplay === message.on) return OK;
      player.autoplay = message.on;
      this._commit();
      return OK;
    }
    if (type === 'g.pause') {
      if (typeof message.on !== 'boolean') return fail(ERR.BAD_MSG, 'pause.on 必须是布尔值。');
      if (this.order.length !== 1) return fail(ERR.WRONG_PHASE, '多人探索不能手动暂停。');
      if (message.on && (this.phase !== PHASE.COMBAT || ![...this.fields.values()].some((field) => !field.engine.result()))) {
        return fail(ERR.WRONG_PHASE, '当前没有正在进行的作战。');
      }
      if (this.manualPaused === message.on) return OK;
      this.manualPaused = message.on;
      this.manualPausedAt = message.on ? this.now() : null;
      this.battleLastAt = this.now();
      this._commit();
      return OK;
    }
    if (type === 'g.mizuki.useItem') return this._useNativeItem(message.itemId);
    if (type === 'g.mizuki.sanVote') return this._sanVote(playerId, message);
    if (this.floorState.pending && ['g.mizuki.routeStart', 'g.mizuki.splitRequest', 'g.mizuki.splitDecide', 'g.mizuki.route', 'g.mizuki.lineup', 'g.mizuki.loadout', 'g.mizuki.importDungeon', 'g.mizuki.archive', 'g.mizuki.dismiss', 'g.mizuki.equip', 'g.mizuki.equipmentPick', 'g.mizuki.recallPropose', 'g.mizuki.recallVote', 'g.mizuki.recallRespond'].includes(type)) {
      return fail(ERR.WRONG_PHASE, '请先完成层间骰子检定。');
    }
    if (type === 'g.mizuki.difficulty') {
      if (this.phase !== PHASE.SQUAD) return fail(ERR.WRONG_PHASE, '分队确定后难度已锁定。');
      if (playerId !== this.hostId) return fail(ERR.BAD_TARGET, '仅房主可以选择难度。');
      if (!validMizukiDifficulty(message.grade)) return fail(ERR.BAD_TARGET, '请选择N0至N18。');
      this.difficultyGrade = message.grade;
      const initial = mizukiDifficultyInitial(message.grade);
      this.squadCapacity = initial.initialSquadCapacity + this.cognitionMods.squadCapacity; this.key = initial.initialKey + this.cognitionMods.initialKey;
      this.light = mizukiDifficultyLight(message.grade);
      this.collectibles = this.collectibles.filter((id) => id !== 'rogue_2_relic_fight_159');
      if (message.grade >= 16) this.collectibles.push('rogue_2_relic_fight_159');
      for (const member of this._active()) {
        member.hope = initial.initialPopulation; member.hopeCapacity = initial.initialPopulation; member.gold = initial.initialGold + this.cognitionMods.initialGold;
        member.life = initial.initialHp + this.cognitionMods.initialMaxLife; member.maxLife = initial.initialMaxHp + this.cognitionMods.initialMaxLife; member.shield = initial.initialShield;
      }
      this._commit(); return OK;
    }
    if (!this._scopeParty && ['g.mizuki.recallPropose', 'g.mizuki.recallVote', 'g.mizuki.recallRespond'].includes(type)) {
      if (!this.partyStates.size) return fail(ERR.WRONG_PHASE, '请在探索开始后预约召回。');
      const result = type === 'g.mizuki.recallPropose' ? this.expedition.proposeRecall(playerId, message.targetIds)
        : type === 'g.mizuki.recallVote' ? this.expedition.voteRecall(playerId, message.requestId, message.agree)
          : this.expedition.respondRecall(playerId, message.requestId, message.accept);
      if (result.ok) { this._resolveRecalls(); this._syncPartyAggregate(); this._commit(); }
      return !result.ok && type === 'g.mizuki.recallRespond' && result.error === 'WRONG_PHASE'
        ? fail(ERR.WRONG_PHASE, '请完成当前小节点并返回路线后，再决定是否归队。') : result;
    }
    if (this.partyStates.size && !this._scopeParty) {
      if (type === 'g.mizuki.routeStart') {
        if (playerId !== this.expedition.leaderId) return fail(ERR.BAD_TARGET, '仅领队可以确认出发。');
        if (this.expedition.requests.some((request) => request.status === 'pending')) return fail(ERR.BAD_TARGET, '请先处理单独行动申请。');
        const count = this._departure();
        // A completed Boss rendezvous creates a new merged party in ROUTE.
        const mergedBoss = [...this.expedition.parties.values()].find((party) => party.phase === 'ROUTE' && this.partyStates.get(party.id)?.pendingNode);
        if (mergedBoss) this._departure();
        this._commit(); return count || mergedBoss ? OK : fail(ERR.BAD_TARGET, '队员尚未全部投票。');
      }
      if (type === 'g.mizuki.splitRequest') {
        const party = this.expedition.partyFor(playerId), state = this._partyState(party);
        const result = this.expedition.requestSplit(playerId, message.nodeId, (state?.route || []).map((node) => node.id));
        if (result.ok) { state.votes = { ...party.votes }; this._commit(); }
        return result;
      }
      if (type === 'g.mizuki.splitDecide') {
        const request = this.expedition.requests.find((value) => value.id === message.requestId), source = this.expedition.parties.get(request?.partyId);
        const original = source && this._partyState(source);
        const result = this.expedition.decideSplit(playerId, message.requestId, message.approve, (original?.route || []).map((node) => node.id));
        if (result.ok) {
          if (source) original.votes = { ...source.votes };
          if (result.approved && !this.partyStates.has(result.partyId)) this.partyStates.set(result.partyId,
            { ...copy({ ...original, lastResults: null, unitePlan: null }), votes: { ...this.expedition.parties.get(result.partyId).votes }, lastResults: new Map() });
          this._syncPartyAggregate(); this._commit();
        }
        return result;
      }
      const party = this.expedition.partyFor(playerId);
      const result = this._withParty(party, () => this.handle(playerId, message));
      if (type === 'g.mizuki.route' && result.ok && this._departReadyAtRendezvous()) this._commit();
      return result;
    }
    if (type === 'g.mizuki.facility') {
      if (![PHASE.PREP, PHASE.COMBAT].includes(this.phase)) return fail(ERR.WRONG_PHASE, '装置卡只能在备战或作战时摆放。');
      const field = this.fields.get(player.fieldId);
      if (!field || message.battleId !== field.battleId) return fail(ERR.BAD_TARGET, '战斗标识已失效。');
      if (this.phase === PHASE.PREP && this._active().filter((member) => member.fieldId === player.fieldId).some((member) =>
        (member.prep?.board || []).some((place) => place.row === message.row && place.col === message.col))) return fail(ERR.BAD_TILE, '此格已有备战棋子。');
      const result = field.engine.command(playerId, { type: 'deployFacility', key: message.key, row: message.row, col: message.col, dir: message.dir,
        inCombat: this.phase === PHASE.COMBAT });
      if (result.ok) {
        if (this.phase === PHASE.PREP) {
          (this.facilityPlacements[player.fieldId] ||= []).push({ playerId, key: message.key, row: message.row, col: message.col, dir: message.dir });
          this._resetReady();
        }
        this._commit();
      }
      return result;
    }
    if (type === 'g.mizuki.loadout') {
      if (!LOADOUT_PHASES.has(this.phase) || player.ready) return fail(ERR.WRONG_PHASE, '请在未准备的整备阶段调整本局技能与模组。');
      const index = player.roster.findIndex((unit) => unit.uid === message.uid);
      const unit = index >= 0 ? player.roster[index] : null;
      const next = unit && applyMizukiRunLoadout(this.ds, unit, { skillIndex: message.skillIndex, moduleId: message.moduleId });
      if (!next) return fail(ERR.BAD_TARGET, '只能为本局已招募的干员选择当前精英阶段可用的技能与模组。');
      player.roster[index] = next;
      if (this.phase === PHASE.PREP) { this._resetReady(); this._prepareFields(); }
      this._commit(); return OK;
    }
    if (type === 'g.mizuki.equip') {
      if (player.ready) return fail(ERR.WRONG_PHASE, '请先取消准备。');
      const result = equipMizukiEquipment(player, message, this._equipmentOptions(player));
      if (result.ok) { this._settleEconomicBonds(player); if (this.phase === PHASE.PREP) this._prepareFields(); this._commit(); }
      return result;
    }
    if (type === 'g.mizuki.equipmentPick') {
      if (player.ready || ![PHASE.PREP, PHASE.ROUTE, PHASE.RECRUIT, PHASE.REWARD, PHASE.EVENT, PHASE.SHOP].includes(this.phase)) return fail(ERR.WRONG_PHASE, '请在未准备的整备阶段选择道具奖励。');
      const offer = player.equipmentOffers?.find((entry) => entry.id === message.offerId);
      const selected = offer?.kind === 'item' ? message.itemId : message.operatorId;
      if (!offer || !offer.choices.includes(selected) || message.requestId && player.equipmentRequestIds.includes(message.requestId)) return fail(ERR.BAD_TARGET, '奖励选择已经失效。');
      const draft = copy(player);
      const granted = offer.kind === 'item' ? grantMizukiEquipment(draft, selected, this._equipmentOptions(draft)).ok
        : !!this._grantMetaChess(draft, selected);
      if (!granted) return fail(ERR.BAD_TARGET, '所选奖励当前无法获得，选择已保留。');
      if (offer.kind === 'item' && offer.source === 'band:band_cathy' && selected === 'chess_item_5_08_e_a') {
        draft.metaCounters['band:cathy:cellTaken'] = 1;
        // Several commander levels can queue choices before any is taken.
        // The allowance applies to receiving the item, including those old offers.
        for (const pending of draft.equipmentOffers) if (pending.id !== offer.id && pending.source === offer.source)
          pending.choices = pending.choices.filter(id => id !== selected);
        draft.equipmentOffers = draft.equipmentOffers.filter(pending => pending.choices.length);
      }
      draft.equipmentOffers = draft.equipmentOffers.filter((entry) => entry.id !== offer.id);
      if (message.requestId) draft.equipmentRequestIds.push(message.requestId);
      if (!validMizukiEquipmentState(draft, { gd: this.gd })) return fail(ERR.BAD_TARGET, '奖励状态校验失败。');
      Object.assign(player, draft);
      if (this.phase === PHASE.PREP) this._prepareFields(); this._commit(); return OK;
    }
    if (type === 'g.mizuki.dismiss') {
      if (!canDismissMizukiOperator({ phase: this.phase, completedNodes: this.completedNodes })) return fail(ERR.WRONG_PHASE, '请在战后整备或路线节点间遣散干员。');
      const previous = player.roster.find((unit) => unit.uid === message.uid);
      const result = dismissMizukiOperator(player, message.uid, { phase: this.phase, completedNodes: this.completedNodes, actorId: playerId, requestId: message.requestId });
      if (result.ok) {
        player.hopeCapacity = hopeCapacityOf(player);
        const sold = this._nativeHook(player, 'onSold', { kind: 'chess', piece: mizukiOperatorPiece(previous), price: 0,
          hopeRefund: result.hopeRefund, gain: result.hopeRefund });
        if (sold.gain === 0 && result.hopeRefund > 0) player.hope = Math.max(0, player.hope - result.hopeRefund);
        if (this.phase === PHASE.PREP) this._prepareFields(); this._commit();
      }
      return result;
    }
    if (['g.mizuki.importDungeon', 'g.mizuki.archive'].includes(type)) {
      if (playerId !== this.hostId) return fail(ERR.BAD_TARGET, '仅房主可以导入路线或切换关卡档案。');
      if (![PHASE.SQUAD, PHASE.ROUTE].includes(this.phase)) return fail(ERR.WRONG_PHASE, '请在分队选择或路线阶段操作。');
      if (this.expedition.parties.size !== 1 || this.expedition.barrier) return fail(ERR.WRONG_PHASE, '请在分队选择或路线阶段操作。');
      if (this.expedition.requests.some(request => request.status === 'pending')) return fail(ERR.BAD_TARGET, '请先处理单独行动申请。');
      if (type === 'g.mizuki.importDungeon') {
        // Topology replacement is an opening action. Once a node has paid out,
        // its exploration history cannot safely be attached to a different map.
        if (this.completedNodes || this.currentNode || this.explorationState?.trace?.length) return fail(ERR.WRONG_PHASE, '请在分队选择或路线阶段操作。');
        let imported;
        try { imported = createMizukiExplorationState(message.dungeon, { sourceLabel: message.sourceLabel }); }
        catch (error) { return fail(ERR.BAD_TARGET, error.message); }
        const entered = this.floorState.enteredZones.includes(this.explorationState?.zoneKey);
        this.explorationState = imported; this.archiveMode = false;
        // Carry the already-settled opening area across the replacement without
        // issuing its entry rewards again. Variation ledgers belong to the old
        // topology; no node has been entered, so they have no earned balance.
        this.floorState.enteredZones = entered ? [imported.zoneKey] : [];
        this.floorState.variations = {};
        if (entered) {
          const variation = imported.dungeon.zones[imported.zoneKey].variation;
          if (variation) this._variationRecord(imported.zoneKey, variation);
        } else if (this.phase === PHASE.ROUTE) this._enterArea(imported);
        const party = this._scopeParty || this.expedition.partyFor(playerId);
        if (this.phase === PHASE.ROUTE && party) this.expedition.setContext(party.id, imported);
      } else {
        if (typeof message.on !== 'boolean' || (!message.on && !this.explorationState)) return fail(ERR.BAD_TARGET, '尚未导入原始路线节点图。');
        this.archiveMode = message.on;
      }
      this.votes = {};
      if (this.phase === PHASE.ROUTE) this.route = this._routeOptions(this.explorationState, this.archiveMode, { reserve: true });
      this._commit(); return OK;
    }
    if (type === 'g.mizuki.lineup' && [PHASE.PREP, PHASE.ROUTE, PHASE.REWARD, PHASE.EVENT, PHASE.SHOP, PHASE.RECRUIT].includes(this.phase)) {
      if (player.ready) return fail(ERR.WRONG_PHASE, '请先取消准备。');
      const uids = message.uids;
      if (!Array.isArray(uids) || uids.length > this.squadCapacity || new Set(uids).size !== uids.length
        || uids.some((uid) => !player.roster.some((unit) => unit.uid === uid))) return fail(ERR.BAD_TARGET, '携带阵容必须为已招募干员，且不能超过编队容量。');
      player.lineup = [...uids];
      if (this.phase === PHASE.PREP) { this._resetReady(); this._prepareFields(); }
      this._commit(); return OK;
    }
    if (['g.mizuki.move', 'g.move'].includes(type)) {
      if (this.phase !== PHASE.PREP || player.ready) return fail(ERR.WRONG_PHASE, '仅未准备的备战阶段可以摆位。');
      const context = this._prepContext(player);
      if (!context.grid) return fail(ERR.BAD_TARGET, '当前备战棋盘未就绪。');
      const result = moveMizukiPrep(player, message.uid, message.to, message.dir, context);
      if (!result.ok) return result;
      this._prepareFields(); this._commit(); return OK;
    }
    if (type === 'g.mizuki.squad' && this.phase === PHASE.SQUAD) {
      if (!MIZUKI_SQUADS.some((squad) => squad.id === message.squadId)) return fail(ERR.BAD_TARGET, '分队不存在。');
      this.squadVotes[playerId] = message.squadId; this._resolveSquadIfReady(); this._commit(); return OK;
    }
    if (type === 'g.mizuki.strategy' && this.phase === PHASE.STRATEGY) {
      if (player.strategyReady) return fail(ERR.ALREADY, '策略已经确认。');
      if (!this.strategyOptions.some((band) => band.bandId === message.bandId)) return fail(ERR.BAD_TARGET, '策略不存在。');
      if (this._active().some((member) => member.playerId !== playerId && member.bandId === message.bandId)) return fail(ERR.ALREADY, '该策略已被队友选择。');
      player.bandId = message.bandId; player.strategyReady = true; player.ready = true;
      mizukiStrategyStartingLife(player, this.gd.band(player.bandId), mizukiDifficultyInitial(this.difficultyGrade));
      this._advanceOnlineActors(); this._commit(); return OK;
    }
    if (type === 'g.mizuki.initialSupply' && this.phase === PHASE.INITIAL_SUPPLY) {
      if (player.initialSupplyReady) return fail(ERR.ALREADY, '初始补给已经确认。');
      if (!mizukiInitialSupplyReward(message.choiceId)) return fail(ERR.BAD_TARGET, '初始补给不存在。');
      player.initialSupplyId = message.choiceId; player.initialSupplyReady = true; player.ready = true;
      this._resolveInitialSupplyIfReady(); this._commit(); return OK;
    }
    if (type === 'g.mizuki.recruitGroup' && this.phase === PHASE.RECRUIT_GROUP) {
      if (player.recruitGroupReady) return fail(ERR.ALREADY, '招募组合已经确认。');
      const group = this._recruitGroupOptions().find((entry) => entry.id === message.groupId);
      if (!group || group.disabled) return fail(ERR.BAD_TARGET, group?.unavailableReason || '招募组合不存在。');
      player.recruitGroupId = group.id; player.recruitGroupReady = true; player.ready = true;
      this._advanceOnlineActors(); this._commit(); return OK;
    }
    if (type === 'g.mizuki.route' && this.phase === PHASE.ROUTE) return this._vote(player, message.nodeId);
    if (type === 'g.mizuki.missionClaim') return this._claimRouteMission(player, message.missionId);
    if (type === 'g.mizuki.event' && this.phase === PHASE.EVENT) return this._vote(player, message.choiceId, true);
    if (type === 'g.mizuki.recruit' && this.phase === PHASE.RECRUIT) {
      this._refreshRecruit(player);
      const ticket = this._activeTicket(player);
      if (player.ready || !ticket) return fail(ERR.ALREADY, '本批招募券已经处理。');
      if (typeof message.offerId === 'string' && message.offerId.startsWith('ticket:')) {
        const selected = this._currentTickets(player).find((value) => value.id === message.offerId.slice(7) && value.count > 0 && value.status === 'available');
        if (!selected) return fail(ERR.BAD_TARGET, '招募券已失效。');
        player.recruit.activeTicketId = selected.id; this._refreshRecruit(player); this._commit(); return OK;
      }
      const context = { ...this._recruitContext(player, ticket), requestId: message.requestId };
      let result;
      if (message.offerId === mizukiRecruitRefreshId(ticket)) {
        result = refreshMizukiRecruitTicket(ticket, { ...context, token: message.offerId });
        if (result.ok) player.recruitRefreshes++;
      } else if (message.offerId === mizukiRecruitSkipId(ticket)) {
        result = skipMizukiRecruitTicket(ticket, { ...context, token: message.offerId });
      } else {
        const plan = this._routeRecruitPromotion(planMizukiRecruitment({ ticket, offerId: message.offerId, catalog: this.fullCatalog, roster: player.roster }), ticket);
        if (!plan.ok) return fail(plan.error, plan.detail);
        const hopeCost = plan.freeRecruit ? 0 : this._hopeCost(plan.operator, plan.upgradeCost, player);
        if (player.hope < hopeCost) return fail(ERR.NO_FUNDS, '希望不足。');
        // Plan the immutable ticket transaction before granting or charging.
        // _refreshRecruit reconciles its next page against the committed roster.
        result = consumeMizukiRecruitTicket(ticket, { ...context, offerId: message.offerId, operatorId: plan.operatorId });
        if (!result.ok) return fail(result.error, result.detail);
        const consumed = player.roster.filter(unit => (plan.consumedUids || []).includes(unit.uid)).map(mizukiOperatorPiece);
        const unit = this._addOperator(player, plan.operatorId, { ...plan, plan, resultUnit:true });
        if (!unit) return fail(ERR.BAD_TARGET, '干员数据无法载入或装备区已满，干员与招募券均已保留。');
        if (!this._spendHope(player, hopeCost)) return fail(ERR.NO_FUNDS, '希望不足。');
        if (!ticket.promotionOnly) this._scoreFor(player.playerId).recruits++;
        this._nativeHook(player, 'onBuy', { kind: 'chess', slot: { kind: 'chess', id: plan.operatorId },
          piece: mizukiOperatorPiece(unit), price: 0, hopeCost });
        if (plan.promotion) dispatchMizukiRecruitPromotion({ player, ticket: result.ticket, catalog: this.fullCatalog, gd: this.gd,
          contextFactory: (source) => this._metaContext(player, source), callbacks: this._recruitMetaCallbacks(player),
          event: { kind: 'chess', piece: mizukiOperatorPiece(unit), baseId: plan.operatorId, consumed, area: 'hand' } });
      }
      if (!result.ok) return fail(result.error, result.detail);
      this._replaceTicket(player, result.ticket);
      if (result.effects.manualRefresh) dispatchMizukiRecruitRefresh({ player, ticket: result.ticket, catalog: this.fullCatalog, gd: this.gd,
        contextFactory: (source) => this._metaContext(player, source), callbacks: this._recruitMetaCallbacks(player), effects: result.effects });
      this._refreshRecruit(player);
      this._finishRecruit();
      this._commit(); return OK;
    }

    if (type === 'g.mizuki.bank') return this._bankTransaction(player, message);
    if (type === 'g.mizuki.shopBattle') return this._startMerchantBattle(player);
    if (type === 'g.mizuki.buy') {
      if (this.phase !== PHASE.SHOP || player.ready) return fail(ERR.WRONG_PHASE, '仅未准备离店时可以购买。');
      if (player.shop?.closed || this._merchantDefeated() && !player.shop?.looted) return fail(ERR.WRONG_PHASE, '坎诺特已经离开。');
      const offer = player.shop?.offers.find(value => value.id === message.offerId && !value.sold);
      if (!offer) return fail(ERR.BAD_TARGET, '商品已售出或已刷新。');
      if (player.gold < offer.price) return fail(ERR.NO_FUNDS, '源石锭不足。');
      const spec = mizukiCollectibleSpec(offer.itemId);
      if (spec && !spec.stackable && this.collectibles.includes(offer.itemId)) return fail(ERR.ALREADY, '队伍已拥有此收藏品。');
      const tickets = new Map();
      player.gold -= offer.price;
      this._recordVariationGold(player.playerId, -offer.price);
      offer.sold = true;
      this._routeMissionProgress?.({ goldSpent: offer.price });
      if (spec) this._grantRouteCollectible(offer.itemId, tickets);
      else tickets.set(player.playerId, this._grantRouteItem(player, offer.itemId, offer.count));
      this._beginRouteRecruit(tickets, 'shop');
      this._commit(); return OK;
    }
    if (type === 'g.mizuki.shopRefresh') {
      if (this.phase !== PHASE.SHOP || player.ready) return fail(ERR.WRONG_PHASE, '仅未准备离店时可以刷新商品。');
      if (player.shop?.closed || player.shop?.looted || this._merchantDefeated()) return fail(ERR.WRONG_PHASE, '坎诺特已经离开。');
      const result = refreshMizukiRouteShop(player.shop, this.currentNode, this._shopContext(player));
      if (!result.ok) return fail(ERR.NO_FUNDS, '没有可用的掷骰次数。');
      this.dice -= result.diceCost; player.shop = result.shop;
      this._routeMissionProgress?.({ diceSpent: result.diceCost, diceUsed: 1, diceRoll: result.roll });
      this._collectibleDiceSpent(result.diceCost);
      this._commit(); return OK;
    }
    if (['g.buy', 'g.refresh', 'g.freeze', 'g.levelUp'].includes(type)) return fail(ERR.BAD_TARGET, '请使用诡意行商节点购买物资，干员由招募券和希望获得。');
    if (type === 'g.mizuki.reward' && this.phase === PHASE.REWARD) {
      if (player.ready) return fail(ERR.ALREADY, '奖励已经领取。');
      const reward = player.rewards.find(value => value.id === message.rewardId);
      if (!reward) return fail(ERR.BAD_TARGET, '奖励已失效。');
      if (reward.group && player.rewards.some(value => value.group === reward.group && value.selected)) return fail(ERR.ALREADY, '本组奖励已经选择。');
      if (reward.type === 'driftingCache') { this._enterDriftingCache(player, reward); this._commit(); return OK; }
      if (reward.type === 'collectible') {
        const spec = mizukiCollectibleSpec(reward.itemId);
        if (!spec || !spec.stackable && this.collectibles.includes(reward.itemId)) {
          const next = drawMizukiCollectible({ rng: this._rng('reward-replace:' + reward.id),
            cognition: this.cognitionLegacy ? undefined : this.cognitionMods,
            bankRecord: this.bankAccounts.get(player.playerId)?.record || 0,
            owned: [...this.collectibles, ...player.rewards.filter(value => value.type === 'collectible').map(value => value.itemId)] });
          if (next) {
            const item = mizukiCollectibleSpec(next);
            Object.assign(reward, { itemId: next, iconId: item.iconId, rarity: item.rarity, title: item.name, description: item.description });
          } else player.rewards = player.rewards.filter(value => value.group !== reward.group);
          player.ready = player.rewards.every(value => player.rewards.some(choice => choice.group === value.group && choice.selected));
          if (this._allReady()) this._enterRecruit('battle');
          this._commit(); return fail(ERR.BAD_TARGET, '该藏品已由队伍获得，奖励选项已更新。');
        }
      }
      reward.selected = true; player.selectedReward = message.rewardId;
      player.ready = !reward.group || player.rewards.every(value => player.rewards.some(choice => choice.group === value.group && choice.selected));
      if (this._allReady()) this._enterRecruit('battle');
      this._commit(); return OK;
    }
    if (['g.mizuki.ready', 'g.ready'].includes(type) && [PHASE.PREP, PHASE.SHOP].includes(this.phase)) {
      const on = type === 'g.ready' ? message.ready : message.on;
      if (typeof on !== 'boolean') return fail(ERR.BAD_MSG, 'ready.on 必须是布尔值。');
      if (on && this.phase === PHASE.PREP && mizukiPrepView(player, { source: this.ds }).temp.some(piece => piece && !piece.toolId)) return fail(ERR.HAND_FULL, '请先处理临时整备区。');
      if (on && player.equipmentOffers?.length) return fail(ERR.BAD_TARGET, '请先选择个人道具奖励。');
      player.ready = on;
      if (this._allReady()) { if (this.phase === PHASE.PREP) this._startBattle(); else this._completeNode(); }
      this._commit(); return OK;
    }
    if (['g.mizuki.deploy', 'g.mizuki.retreat', 'g.mizuki.skill'].includes(type)) {
      const field = this.fields.get(player.fieldId);
      if (type === 'g.mizuki.deploy' && this.phase === PHASE.COMBAT && field && field.battleId === message.battleId
        && field.engine.activeTools?.handles(playerId, message.uid)) {
        const result = field.engine.command(playerId, { type: 'deploy', uid: message.uid, row: message.row, col: message.col, dir: message.dir });
        if (!result?.ok) return fail(ERR.BAD_TARGET, result?.error || '支援道具当前无法部署。');
        this.revision++; this._emit(); return OK;
      }
      return fail(ERR.WRONG_PHASE, '水月战斗沿用卫戍自动操作，请在备战阶段完成摆位。');
      /* Legacy manually controlled transport is intentionally unreachable.
      if (this.phase !== PHASE.COMBAT) return fail(ERR.WRONG_PHASE, '只有作战中可以部署、撤退或开启技能。');
      const field = this.fields.get(player.fieldId);
      if (!field || message.battleId !== field.battleId) return fail(ERR.BAD_TARGET, '战斗标识已失效。');
      if (!field.engine.snapshot().rosters?.[playerId]?.some((unit) => unit.uid === message.uid)) return fail(ERR.BAD_TARGET, '只能操作自己的干员或召唤物。');
      const result = field.engine.command(playerId, { type: type.slice('g.mizuki.'.length), uid: message.uid,
        row: message.row, col: message.col, dir: message.dir });
      if (!result?.ok) {
        const errors = { NO_DP: ERR.NO_FUNDS, BAD_TILE: ERR.BAD_TILE, WRONG_PHASE: ERR.WRONG_PHASE, DEPLOY_LIMIT: ERR.BOARD_FULL };
        const detail = { NO_DP: '部署费用不足。', NOT_OWNER: '只能操作自己的干员。', OCCUPIED: '格子已被占用。',
          BAD_TILE: '该干员不能部署在此格。', COOLDOWN: '干员尚在再部署冷却中。', NOT_READY: '技能尚未就绪。',
          DEPLOY_LIMIT: '该战场的部署人数已满。' };
        return fail(errors[result?.error] || ERR.BAD_TARGET, detail[result?.error] || `操作被服务器拒绝：${result?.error || 'UNKNOWN'}`);
      }
      this.revision++; this._emit(); return OK; */
    }
    return fail(ERR.WRONG_PHASE, '当前阶段不接受该操作。');
  }

  _stopBattle() {
    if (this.battleTimer) this.sched.clearInterval(this.battleTimer);
    this.battleTimer = null; this.manualPaused = false; this.manualPausedAt = null;
    this.battleAccumulator = 0; this.battleLastAt = null;
  }
  _clearFields() {
    if (!this._scopeParty) { this._stopBattle(); for (const field of this.fields.values()) field.engine.dispose?.(); this.fields.clear(); return; }
    for (const [id, field] of this.fields) if (field.partyId === this._scopeParty.id
      || (!field.partyId && (field.players || []).some((pid) => this._scopeParty.memberIds.includes(pid)))) {
      field.engine.dispose?.(); this.fields.delete(id);
    }
  }
  _fieldViews({ stream = false } = {}) { return [...this.fields.values()].map((field) => {
    const plan = this.partyStates.get(field.partyId)?.unitePlan || this.unitePlan;
    const snapshot = field.engine.snapshot({ stream });
    if (stream) {
      const metadata = field.engine.streamFieldMeta?.();
      if (metadata) this._broadcast({ ...metadata, t: 'm.field', battleId: field.battleId });
    }
    return { ...snapshot, partyId: field.partyId, kind: field.kind, active: field.active !== false,
      players: [...field.players],
      ...(field.kind === 'unite' ? { objectiveUnrescuedByPlayer: Object.fromEntries(plan?.notReentered || []) } : {}),
      damageRows: mizukiBattleDamageRows(field.engine.battle, { battleId: field.battleId }),
      ...(!stream ? { meta: snapshot.meta || field.engine.fieldMeta() } : {}) };
  }); }

  _pauseView() {
    const automatic = !this.order.some((player) => player.alive && !player.left && player.connected);
    return { paused: this.manualPaused || automatic,
      pausedAt: this.manualPaused ? this.manualPausedAt : automatic ? this.autoPausedAt : null,
      pauseReason: this.manualPaused ? 'manual' : automatic ? 'no_connected_players' : null,
      pauseAvailable: this.order.length === 1 && this.phase === PHASE.COMBAT
        && [...this.fields.values()].some((field) => !field.engine.result()) };
  }

  _effectsView(player) {
    const effects = [], band = this.gd.band(player.bandId);
    if (band) effects.push({ id: band.effectId || band.bandId, name: band.effectName || band.name,
      desc: band.desc || '', iconKind: 'band', iconId: band.iconId || band.bandId });
    for (const ref of player.equipmentEffects || []) {
      if (ref.hidden) continue;
      const record = this.gd.effect(ref.data?.effectId || ref.id);
      effects.push({ id: ref.id, name: ref.name || record?.name || ref.id, desc: ref.desc || record?.desc || '',
        iconKind: ref.iconKind || 'choice', iconId: ref.iconId || record?.iconId || ref.id,
        ...(ref.counter != null ? { counter: ref.counter } : {}), ...(ref.counterText != null ? { counterText: ref.counterText } : {}) });
    }
    const squad = this.selectedSquad;
    if (squad) effects.push({ id: squad.id, name: squad.name,
      desc: squad.description || '',
      iconKind: 'team', iconId: 'icon_team_buff', source: 'mizuki_squad',
      effects: copy(squad.effects || []) });
    return effects;
  }

  _nextEnemies(player) {
    if (!player.alive || player.left) return [];
    const field = this.fields.get(player.fieldId), battle = field?.engine.battle;
    if (!battle?.data || !battle.rect || !field?.setup) return [];
    const waves = field.engine.officialWaves;
    const specs = waves ? waves.waves.flatMap((wave) => wave.fragments.flatMap((fragment) => fragment.actions))
      .filter((entry) => entry.pending.some((pending) => pending.counted))
      .map((entry) => ({ enemyKey: entry.action.key, count: entry.pending.filter((pending) => pending.counted).length,
        time: entry.times?.[0] ?? entry.action.preDelay, routeIndex: entry.action.routeIndex }))
      : (battle.opts.spawns || []).filter((spawn) => spawn.countInTotal !== false && spawn.tag !== 'part'
        && !(spawn.def || battle.data.getEnemy(spawn.enemyKey))?.notCountInTotal);
    return specs.filter((spec) => battle.data.getEnemy(spec.enemyKey) || spec.def).map((spec) => {
      const enemy = spec.def || battle.data.getEnemy(spec.enemyKey), rank = enemy.rank || enemy.raw?.rank;
      const route = spec.route || field.setup?.routes?.[spec.routeIndex ?? 0], start = route?.start;
      return { enemyKey: spec.enemyKey, count: Math.max(1, Math.trunc(Number(spec.count) || 1)),
        gate: Array.isArray(start) && start[0] > (battle.rect.r0 + battle.rect.r1) / 2 ? 'upper' : 'lower',
        t: Number.isFinite(spec.time) && spec.time >= 0 ? spec.time : 0,
        fly: enemy.motion === 'FLY' || enemy.stats?.motion === 'FLY', elite: rank === 'ELITE' || rank === 'BOSS',
        boss: rank === 'BOSS', source: 'wave', tag: rank === 'BOSS' ? 'boss' : null,
        ...(rank === 'BOSS' && Array.isArray(start) ? { start: [...start] } : {}) };
    });
  }

  publicView({ fields } = {}) {
    const pause = this._pauseView();
    return { t: 'm.public', mode: this.mode, variant: this.variant, modeId: this.modeId, difficulty: this.difficulty,
      ranked: false, round: this.round, phase: this.phase, combatMode: 'server', gameSpeed: 2, serverNow: this.now(), ...pause,
      players: this.order.map((player) => ({ playerId: player.playerId, name: player.name, seat: player.seat,
        isBot: false, autoplay: player.autoplay === true, connected: player.connected && !player.left, left: player.left, alive: player.alive,
        lp: player.life, life: player.life, maxLife: player.maxLife, shield: player.shield,
        fieldId: player.fieldId, ready: player.ready, bandId: player.bandId,
        partyId: this.expedition.partyFor(player.playerId)?.id || null,
        phase: !player.alive && !this.ended ? 'MIZUKI_WAITING' : this.partyStates.get(this.expedition.partyFor(player.playerId)?.id)?.phase || this.phase,
        status: player.left ? 'left' : !player.alive ? 'eliminated' : !player.connected ? 'disconnected' : player.ready ? 'ready' : 'deciding' })),
      mizuki: { implementation: this.explorationState?.generator ? 'server_generated_routes_official_stages' : 'official_stage_subset',
        completeExploration: this.resultSummary?.completeExploration === true, title: MIZUKI_TITLE,
        notice: '探索路线、节点事件与诡意行商由服务端同步；干员采用卫戍实战规则。',
        exploration: this._explorationView(this.explorationState, {
          votes: this.archiveMode ? {} : this.votes, currentNodeId: this.currentNode?.graphNodeId || null }),
        archiveMode: this.archiveMode, hostId: this.hostId, expedition: this._partyViews(),
        // Stage cards are never a substitute for the native dungeon graph;
        // route metadata is exposed only through revealed graph nodes.
        stageArchive: [],
        floor: null, nodeIndex: this.completedNodes, completedNodes: this.completedNodes,
        totalNodes: null, light: this.light, ...pause,
        squadCapacity: this.squadCapacity, squads: this._squadOptions(), squadVotes: { ...this.squadVotes },
        selectedSquad: this._squadOptions().find((squad) => squad.id === (this.baseSquadId || this.selectedSquad?.id)) || null,
        strategyOptions: copy(this.strategyOptions), strategySelections: Object.fromEntries(this.order.filter((player) => player.bandId).map((player) => [player.playerId, player.bandId])),
        initialSupplyOptions: mizukiInitialSupplyOptions(), initialSupplySelections: Object.fromEntries(this.order.filter(player => player.initialSupplyId).map(player => [player.playerId, player.initialSupplyId])),
        recruitGroups: this._recruitGroupOptions(), recruitGroupSelections: Object.fromEntries(this.order.filter((player) => player.recruitGroupId).map((player) => [player.playerId, player.recruitGroupId])),
        difficultyGrade: this.difficultyGrade, difficultyOptions: mizukiDifficultyOptions(),
        missions: mizukiRouteMissionViews(this.routeMissions),
        endingUnlocks: [...this.endingUnlocks], endingRoute: mizukiEndingRoute(this.endingProgress, this.collectibles),
        dice: { id: this.diceId, count: this.dice }, collectibles: copy(this.collectibles),
        nativeItems: copy(this.nativeItems),
        commander: { ...copy(this.commander), nextLevelExp: mizukiCommanderNextExp(this.commander.level, this._commanderMaxLevel()) },
        resourceOwnership: { dice: 'team', light: 'team', collectibles: 'team', hope: 'player', gold: 'player', tickets: 'player', life: 'player', maxLife: 'player', shield: 'player' },
        lightEffect: '未完美作战团队灯火-5；本次作战有人个人生命低于自身上限一半再-5，每次结算仅一次。普通第二至第六层进入时按原灯火骰子表检定。',
        sanCheck: this._sanPublicView(), virtues: this._virtueViews(),
        battleRule: '生命、生命上限与护盾归个人；普通漏怪及联防幸存漏怪扣来源玩家生命，Boss同场按座位顺序轮流承担每次漏怪。各自作战后由本队一名完美作战队员联防，敌人保留原路线，生命和攻击力为原值75%。',
        unsupportedStages: [],
        unsupportedNodes: [],
        route: this.route.map((node) => ({ ...mizukiRouteChoiceView(node), chosenBy: Object.keys(this.votes).filter((id) => this.votes[id] === node.id) })),
        currentNode: currentNodeView(this.currentNode), votes: { ...this.votes }, voteRule: '全体在线队员投票；平票时优先房主选择。',
        event: this._routeEventView(), fields: fields || this._fieldViews(), prep: this._prepPublicView(), controlMode: 'automatic', shopDisabled: false,
        reward: this.phase === PHASE.REWARD ? { title: '战利品分配', readyPlayers: this.order.filter((player) => player.ready).map((player) => player.playerId) } : null,
        result: this.resultSummary ? { victory: this.resultSummary.victory, reason: this.resultSummary.reason,
          endingId: this.resultSummary.endingId, ending: copy(this.resultSummary.ending),
          completedNodes: this.completedNodes, light: this.light, players: copy(this.resultSummary.players) } : null } };
  }

  privateView(playerId) {
    const player = this.players.get(playerId);
    if (!player) return null;
    const party = this.expedition.partyFor(playerId), state = this.partyStates.get(party?.id);
    const loadoutEditable = LOADOUT_PHASES.has(state?.phase || this.phase) && !player.ready && !this.floorState.pending
      && player.alive && !player.left && player.connected;
    const loadoutDisabledReason = loadoutEditable ? null : this.floorState.pending ? '请先完成层间骰子检定。'
      : player.ready ? '请先取消准备。' : '请在本人的整备阶段调整本局技能与模组。';
    const fieldUnits = [PHASE.PREP, PHASE.COMBAT].includes(state?.phase || this.phase)
      ? this.fields.get(player.fieldId)?.engine?.battle?.getPlayer?.(playerId)?.units || [] : [];
    const effects = this._effectsView(player), nextEnemies = this._nextEnemies(player);
    return { t: 'm.private', playerId, bandId: player.bandId, effects, nextEnemies, autoplay: player.autoplay === true,
      mizuki: { bandId: player.bandId, effects, nextEnemies, gold: player.gold, hope: player.hope, hopeCapacity: hopeCapacityOf(player), fieldId: player.fieldId, autoplay: player.autoplay === true,
      life: player.life, maxLife: player.maxLife, shield: player.shield, alive: player.alive, eliminated: !player.alive && !player.left,
      routeInventory: copy(player.routeInventory || {}),
      phase: !player.alive && !this.ended ? 'MIZUKI_WAITING' : state?.phase || this.phase, partyId: party?.id || null, completedNodes: state?.completedNodes ?? this.completedNodes,
      recallPrompt: !this.ended && player.alive && !player.left ? this.expedition.recallPrompt(playerId) : null,
      round: state?.round || this.round, archiveMode: state?.archiveMode ?? this.archiveMode,
      event: this._routeEventView(state ? state.event : this.event, state ? state.currentNode : this.currentNode,
        state?.explorationState || this.explorationState, party?.memberIds || this._active().map(member => member.playerId)),
      sanCheck: this._wishPublicView(state ? state.event : this.event, party?.memberIds || this._active().map(member => member.playerId)) || (this.floorState.pending ? this._sanPublicView() : null),
      reward: (state?.phase || this.phase) === PHASE.REWARD ? { title: '战利品分配', readyPlayers: (party?.memberIds || []).filter((id) => this.players.get(id)?.ready) } : null,
      currentNode: currentNodeView(state ? state.currentNode : this.currentNode), route: (state?.route || this.route).map(mizukiRouteChoiceView),
      votes: copy(party?.votes || this.votes), exploration: this._explorationView(state?.explorationState || this.explorationState,
        { votes: party?.votes || this.votes, currentNodeId: state?.currentNode?.graphNodeId || null }),
      routeConsumables: copy(player.routeConsumables || {}),
      equipment: { inventory: (player.equipmentInventory || []).map((item) => mizukiEquipmentItemView(item, { gd: this.gd })),
        equipped: player.roster.map((unit) => ({ uid: unit.uid, items: (unit.items || []).map((item) => mizukiEquipmentItemView(item, { gd: this.gd })) })) },
      equipmentRules: { enabled: player.alive && !player.left, equipPerChess: this.gd.equipPerChess || 2, dropsEveryBattles: null,
        battlesCompleted: player.equipmentBattlesCompleted || 0, nextDropIn: null, stage: this._equipmentStage(player),
        boardDeployLimitMax: 9, lineupLimit: this.squadCapacity },
      equipmentOffers: (player.equipmentOffers || []).map((offer) => ({ ...copy(offer), choices: offer.choices.map((id) => offer.kind === 'chess'
        ? copy(this.fullCatalog.byId.get(id)) : { ...copy(this.gd.item(id)), itemId: id }) })),
      economy: { coinRemainder: player.economicCoinRemainder || 0, coinsPerHope: 5,
        totalConvertedHope: Math.floor((player.economicCoinTotal || 0) / 5) - (player.economicHopePending || 0), hopePending: player.economicHopePending || 0 },
      dismissal: { enabled: player.alive && canDismissMizukiOperator({ phase: state?.phase || this.phase, completedNodes: state?.completedNodes ?? this.completedNodes }), hopeRefund: 1 },
      roster: player.roster.map((unit) => ({ ...copy(unit), detail: this.fullCatalog.details?.[unit.chessId] || null, loadout: mizukiRunLoadoutView(this.ds, unit,
        { editable: loadoutEditable, disabledReason: loadoutDisabledReason, runtimeUnit: fieldUnits.find((value) => value.uid === unit.uid),
          getItem: (id) => this.gd.item(id) }) })),
      lineup: [...player.lineup], recruit: this._recruitView(player), shop: this._shopView(player), rewards: copy(player.rewards),
      prep: mizukiPrepView(player, this._prepContext(player)),
      tickets: copy(player.tickets), catalogueReport: copy(this.fullCatalog.report), recruitmentRules: copy(MIZUKI_RECRUIT_RULES),
      trainingSource: copy(this.fullCatalog.trainingSource), trainingReport: copy(this.fullCatalog.trainingReport),
      prepCovenants: copy(this._prepBonds(player)), metaMessages: [...player.metaMessages],
      strategy: { options: copy(this.strategyOptions), selected: player.bandId, done: player.strategyReady },
      initialSupply: { options: mizukiInitialSupplyOptions(), selected: player.initialSupplyId, done: player.initialSupplyReady },
      battleOutcome: copy(player.battleOutcome || null),
      recruitGroup: { options: this._recruitGroupOptions(), selected: player.recruitGroupId, done: player.recruitGroupReady },
      ready: player.ready, selectedReward: player.selectedReward, maxRoster: null, squadCapacity: this.squadCapacity, usedCapacity: player.roster.length } };
  }

  _send(playerId, message) { try { return this.opts.send(playerId, message); } catch (error) { this.log.warn('[mizuki] send', error); return false; } }
  _broadcast(message) {
    try { this.opts.broadcast(message); } catch (error) { this.log.warn('[mizuki] broadcast', error); }
    for (const observer of this.observers) this._send(observer, message);
  }
  _emit(options) {
    if (this.disposed) return;
    this._lastCombatPrivate?.clear();
    this._broadcast(this.publicView(options));
    for (const player of this.order) if (!player.left && player.connected) this._send(player.playerId, this.privateView(player.playerId));
  }
  _commit() {
    if (this._scopeParty) { this._scopeCommit = true; return; }
    this.revision++;
    const automatic = !this.order.some((player) => player.alive && !player.left && player.connected);
    if (!automatic) this.autoPausedAt = null;
    else if (this.autoPausedAt === null) this.autoPausedAt = this.now();
    this.paused = this.manualPaused || automatic;
    if (!this.ended && this.phase !== PHASE.COMBAT && ![...this.partyStates.values()].some((state) => state.phase === PHASE.COMBAT)) {
      this._safeCheckpoint = this._checkpointDoc();
      try { this.opts.onCheckpoint?.(this); } catch (error) { this.log.warn('[mizuki] checkpoint', error); }
    }
    this._emit();
    this.autoplayController?.sync();
  }

  _finish(victory, reason) {
    if (this.ended || this.disposed) return;
    this._stopBattle();
    for (const field of this.fields.values()) if (!field.engine.result()) field.engine.forceEnd?.('forced');
    this.ended = true; this.phase = PHASE.RESULT; this.revision++;
    this.autoplayController?.dispose();
    const ending = victory && reason === 'generated_route_complete' ? mizukiCompletedEnding(this.endingProgress, this.collectibles) : null;
    if (reason === 'generated_route_complete' && !ending) { victory = false; reason = 'ending_not_cleared'; }
    this.resultSummary = { mode: this.mode, variant: this.variant, modeId: this.modeId, difficulty: this.difficulty,
      difficultyGrade: this.difficultyGrade, ending, endingId: ending?.id || null,
      endingUnlocksAwarded: ending ? mizukiEndingUnlocksAfter(this.endingUnlocks, ending.id, this.difficultyGrade)
        .filter((id) => !this.endingUnlocks.includes(id)) : [],
      ranked: false, unofficial: true, completeExploration: !!ending,
      explorationSource: this.explorationState?.generator ? MIZUKI_ROUTE_SOURCE_LABEL : null,
      matchId: this.matchId, victory: !!victory, reason,
      roundsPassed: this.completedNodes, light: this.light,
      mizuki: this._scoreResult(this.hostId),
      players: this.order.map((player) => ({ playerId: player.playerId, name: player.name, seat: player.seat,
        victory: !!victory && player.alive && !player.left, roundsPassed: this.completedNodes, left: player.left,
        alive: player.alive, life: player.life, maxLife: player.maxLife, shield: player.shield,
        gold: player.gold, hope: player.hope, hopeCapacity: hopeCapacityOf(player), rosterCount: player.roster.length, fieldId: player.fieldId,
        mizuki: this._scoreResult(player.playerId) })) };
    this._emit();
    for (const player of this.order) this._send(player.playerId, { t: 'm.result', ...copy(this.resultSummary), playerId: player.playerId });
    try { this.opts.onEnd(copy(this.resultSummary)); } catch (error) { this.log.error('[mizuki] onEnd', error); }
  }

  onDisconnect(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.left || this.disposed) return;
    player.connected = false;
    if (!this.ended) this._advanceOnlineActors();
    this._commit();
  }

  onReconnect(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.left || this.disposed) return;
    player.connected = true; this.autoPausedAt = null; this.paused = this.manualPaused; this.revision++;
    this._departReadyAtRendezvous();
    this._send(playerId, this.publicView()); this._send(playerId, this.privateView(playerId));
    for (const snapshot of this._fieldViews()) {
      this._send(playerId, { t: 'm.field', ...snapshot.meta, battleId: snapshot.battleId });
      this._send(playerId, { ...snapshot, time: snapshot.t, t: 'b.snap', droppable: false });
    }
    this._commit();
  }

  onLeave(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.left || this.disposed || this.ended) return;
    player.left = true; player.alive = false; player.connected = false; player.ready = false; player.autoplay = false;
    player.fieldId = `n:${player.playerId}`;
    this.expedition.removeMember(playerId);
    this._resolveRecalls();
    for (const [id, field] of this.fields) if (field.partyId && !this.expedition.parties.has(field.partyId)) {
      field.engine.forceEnd?.(); field.engine.dispose?.(); this.fields.delete(id);
    }
    this._syncPartyAggregate();
    this.hostId = this.expedition.leaderId || this.hostId;
    if (!this._active().length) { this._finish(false, 'abandoned'); return; }
    this._resumeRendezvous();
    this._advanceOnlineActors();
    this._commit();
  }

  _advanceOnlineActors() {
    if (this.partyStates.size && !this._scopeParty) {
      for (const party of this.expedition.parties.values()) this._withParty(party, () => this._advanceOnlineActors());
      this._departReadyAtRendezvous();
      return;
    }
    this._resolveSanIfReady();
    this._resolveWishIfReady();
    if (this.phase === PHASE.SQUAD) this._resolveSquadIfReady();
    else if (this.phase === PHASE.STRATEGY && this._active().length && this._active().every((player) => player.strategyReady)) { this.phase = PHASE.INITIAL_SUPPLY; this._resetReady(); }
    else if (this.phase === PHASE.INITIAL_SUPPLY) this._resolveInitialSupplyIfReady();
    else if (this.phase === PHASE.RECRUIT_GROUP && this._active().length && this._active().every((player) => player.recruitGroupReady)) this._enterRecruit('route');
    else if (this.phase === PHASE.EVENT || (this.phase === PHASE.ROUTE && !this._scopeParty)) this._resolveVoteIfReady();
    else if (this._allReady()) {
      if (this.phase === PHASE.PREP) this._startBattle();
      else if (this.phase === PHASE.SHOP) this._completeNode();
      else if (this.phase === PHASE.REWARD) this._enterRecruit('battle');
      else if (this.phase === PHASE.RECRUIT) this._finishRecruit();
    }
  }

  addObserver(playerId) { this.observers.add(playerId); this._send(playerId, this.publicView()); return OK; }
  watchObserver(playerId, fieldId) {
    if (!this.observers.has(playerId)) return fail(ERR.SPECTATOR, '观战会话不存在。');
    this._send(playerId, this.publicView());
    if (fieldId != null) {
      const field = this.fields.get(fieldId);
      if (!field) return fail(ERR.BAD_TARGET, '所选战场当前不可观看。');
      const snapshot = this._fieldViews().find(value => value.fieldId === fieldId);
      this._send(playerId, { t: 'm.field', ...field.engine.fieldMeta(), battleId: field.battleId });
      this._send(playerId, { ...snapshot, time: snapshot.t, t: 'b.snap', droppable: false });
    }
    return OK;
  }
  removeObserver(playerId) { this.observers.delete(playerId); }

  _checkpointDoc(phase = this.phase) {
    const states = [...this.partyStates].map(([id, saved]) => {
      const value = this._scopeParty?.id === id ? this._captureParty() : saved;
      const { lastResults: _results, unitePlan: _plan, safePlayers: _players, ...state } = value;
      return [id, { ...copy(state), pendingNode: copy(saved.pendingNode || null),
        phase: value.phase === PHASE.COMBAT ? PHASE.PREP : value.phase, battleStage: null }];
    });
    const stateMap = new Map(states), hostParty = this.expedition.partyFor(this.hostId);
    const hostState = stateMap.get(hostParty?.id);
    const players = copy(this.order);
    for (const [id, stored] of this.partyStates) {
      const saved = this._scopeParty?.id === id ? this._captureParty() : stored;
      if (saved.phase !== PHASE.COMBAT) continue;
      for (const previous of saved.safePlayers || []) {
        const index = players.findIndex((player) => player.playerId === previous.playerId);
        if (index >= 0) players[index] = { ...copy(previous), connected: players[index].connected,
          left: players[index].left, alive: players[index].alive, autoplay: players[index].autoplay === true, lastEmoteAt: players[index].lastEmoteAt, ready: false };
      }
    }
    const expedition = this.expedition.checkpoint();
    for (const party of expedition.parties) {
      const saved = stateMap.get(party.id);
      if (saved) { party.phase = teamPhase(saved.phase); party.votes = copy(saved.votes || {}); party.nodeId = saved.currentNode?.id || null; }
    }
    const output = hostState || this;
    return { v: 1, engine: 'mizuki', roomCode: this.roomCode, mode: this.mode, variant: this.variant,
      modeId: this.modeId, difficulty: this.difficulty, seed: this.seed, matchId: this.matchId, matchNo: this.matchNo,
      phase: hostState?.phase || phase, round: output.round, startedAt: this.startedAt, revision: this.revision, players,
      mizuki: { recruitmentVersion: 4, personalHealthVersion: 1, equipmentVersion: 1, initialSupplyVersion: 1, manualPaused: this.manualPaused, manualPausedAt: this.manualPausedAt,
        cognitionVersion: this.cognitionLegacy ? undefined : 1, cognition: this.cognitionLegacy ? undefined : copy(this.cognition),
        baseSquadId: this.baseSquadId, explorationScores: copy(this.explorationScores), sanRerollsUsed: this.sanRerollsUsed,
        difficultyGrade: this.difficultyGrade, floorState: copy(this.floorState), facilityPlacements: copy(output.facilityPlacements || {}), partyRuntimeVersion: 1, expedition, partyStates: states, completedNodes: output.completedNodes, light: this.light,
        nativeItems: copy(this.nativeItems), endingProgress: copy(this.endingProgress), collectibleLayers: copy(this.collectibleLayers),
        routeMissions: copy(this.routeMissions),
        commander: copy(this.commander),
        squadId: this.selectedSquad?.id || null, squadVotes: { ...this.squadVotes }, squadCapacity: this.squadCapacity, key: this.key, diceId: this.diceId, dice: this.dice, battleDiceSpent: copy(this.battleDiceSpent), collectibles: copy(this.collectibles),
        route: copy(output.route), votes: { ...output.votes }, event: copy(output.event), currentNode: copy(output.currentNode),
        exploration: copy(output.explorationState), archiveMode: output.archiveMode,
        continuation: output.continuation, offerSeq: this.offerSeq, hostId: this.hostId } };
  }

  exportCheckpoint() {
    if (this.disposed || this.ended) return null;
    return this._checkpointDoc();
  }

  restoreCheckpoint(doc) {
    if (this.disposed || this.ended || this.started || !doc || doc.v !== 1 || doc.engine !== 'mizuki'
      || doc.variant !== MIZUKI_VARIANT || doc.mode !== 'coop' || doc.modeId !== MIZUKI_MODE_ID || doc.difficulty !== 'NORMAL'
      || doc.roomCode !== this.roomCode || !SAFE_PHASES.has(doc.phase) || doc.phase === PHASE.RESULT
      || !int(doc.seed, 1, 0xffffffff) || !int(doc.matchNo, 1) || typeof doc.matchId !== 'string'
      || !Array.isArray(doc.players) || doc.players.length !== this.order.length
      || doc.players.some((player) => !player || typeof player !== 'object' || !Array.isArray(player.roster)
        || (player.autoplay !== undefined && typeof player.autoplay !== 'boolean')
        || (player.prep != null && (!Array.isArray(player.prep.tokens) || !Array.isArray(player.prep.board))))) return false;
    const state = doc.mizuki;
    const cognitionLegacy = state?.cognitionVersion === undefined;
    const cognition = normalizeCognition(state?.cognition);
    const cognitionMods = cognitionEffects(cognition);
    const baseSquadId = state?.baseSquadId ?? state?.squadId;
    const restoredSquad = cognitionLegacy ? MIZUKI_SQUADS.find(squad => squad.id === state?.squadId)
      : resolvedSquad(baseSquadId, cognition);
    const commanderMaxLevel = cognitionLegacy ? 11 : 10 + (restoredSquad?.effects || []).filter(effect => effect.key === 'level_limitation_up')
      .reduce((sum, effect) => sum + (effectValues(effect).up || 0), 0);
    const diceLimit = Math.max(1, ...(restoredSquad?.effects || []).filter(effect => effect.key === 'battle_dice_up')
      .map(effect => effectValues(effect).count || 1));
    const explorationScores = state?.explorationScores || {};
    const nativeItems = state?.nativeItems === undefined ? emptyNativeItems() : state.nativeItems;
    const collectibleLayers = state?.collectibleLayers === undefined ? {} : state.collectibleLayers;
    const routeMissions = state?.routeMissions === undefined ? createMizukiRouteMissions() : state.routeMissions;
    const commander = state?.commander === undefined ? mizukiCommanderProgress() : state.commander;
    const battleDiceSpent = state?.battleDiceSpent === undefined ? {} : state.battleDiceSpent;
    if (!state || state.recruitmentVersion !== 4 || state.personalHealthVersion !== 1 || state.equipmentVersion !== undefined && state.equipmentVersion !== 1
      || state.initialSupplyVersion !== undefined && state.initialSupplyVersion !== 1
      || !cognitionLegacy && (state.cognitionVersion !== 1 || JSON.stringify(state.cognition) !== JSON.stringify(cognition)
        || (state.squadId !== null && restoredSquad?.id !== state.squadId))
      || state.sanRerollsUsed !== undefined && !int(state.sanRerollsUsed, 0, cognitionLegacy ? 9999 : 1)
      || !explorationScores || typeof explorationScores !== 'object' || Array.isArray(explorationScores)
      || Object.entries(explorationScores).some(([id, score]) => !this.players.has(id) || !score
        || !['floorsPassed', 'stepsPassed', 'normalBattles', 'eliteBattles', 'bossBattles', 'recruits', 'itemsGained'].every(key => int(score[key], 0, key === 'floorsPassed' ? 7 : 9999999))
        || !['completedNodeIds', 'completedZoneIds'].every(key => Array.isArray(score[key]) && score[key].length <= 8192
          && score[key].every(value => typeof value === 'string' && value.length > 0 && value.length <= 1024)
          && new Set(score[key]).size === score[key].length))
      || (state.manualPaused !== undefined && typeof state.manualPaused !== 'boolean')
      || (state.manualPausedAt != null && (!Number.isFinite(state.manualPausedAt) || state.manualPausedAt < 0))
      || (state.manualPaused && (this.order.length !== 1 || state.manualPausedAt == null))
      || !int(state.difficultyGrade, 0, 18) || !int(state.completedNodes, 0, 999999)
      || ['life', 'maxLife', 'shield'].some((key) => own(state, key))
      || !validNativeItems(nativeItems)
      || !battleDiceSpent || typeof battleDiceSpent !== 'object' || Array.isArray(battleDiceSpent)
      || Object.keys(battleDiceSpent).length > 4096 || Object.entries(battleDiceSpent).some(([key, count]) => key.length > 1024 || !int(count, 1, diceLimit))
      || !collectibleLayers || typeof collectibleLayers !== 'object' || Array.isArray(collectibleLayers)
      || Object.entries(collectibleLayers).some(([id, count]) => !['rogue_2_relic_fight_131', 'rogue_2_relic_fight_158'].includes(id)
        || !int(count, 0, id === 'rogue_2_relic_fight_131' ? 99 : 98) || !state.collectibles?.includes(id))
      || !validMizukiCommander(commander, commanderMaxLevel)
      || !validMizukiRouteMissions(routeMissions, { players: doc.players.map(player => player.playerId), seed: doc.seed })
      || routeMissions.missions.some(mission => mission.extraReward !== /band_(12|13|14)$/.test(state.squadId || ''))
      || !int(state.squadCapacity, 1, 9999) || !int(state.key, 0, 9999) || !int(state.dice, 0, 9999)
      || (state.squadId !== null && !MIZUKI_SQUAD_TIERS.some((squad) => squad.id === state.squadId))
      || (doc.phase === PHASE.SQUAD ? state.squadId !== null : state.squadId === null)
      || (state.diceId !== null && !own(OFFICIAL.modules.dice.dice, state.diceId))
      || !state.squadVotes || typeof state.squadVotes !== 'object' || Array.isArray(state.squadVotes)
      || Object.entries(state.squadVotes).some(([pid, id]) => !this.players.has(pid) || !MIZUKI_SQUADS.some((squad) => squad.id === id))
      || !int(state.light, 0, 100) || !int(state.offerSeq) || !validRecruitContinuation({ ...state, phase: doc.phase })
      || !Array.isArray(state.collectibles) || state.collectibles.length > 4096
      || state.collectibles.some((id) => typeof id !== 'string' || !own(OFFICIAL.rawTopic.relics, id))
      || !validFloorState(state.floorState, doc.players, state.difficultyGrade, state.collectibles)
      || !validFacilityPlacements(state.facilityPlacements, doc.players)
      || !Array.isArray(state.route) || state.route.length > 256 || !state.route.every((node) => NODE_TYPES.has(node?.type) && typeof node.id === 'string')
      || (doc.phase === PHASE.PREP && !['combat', 'elite', 'boss'].includes(state.currentNode?.type) && !eventBattleNode(state.currentNode))) return false;
    let exploration = null;
    try { if (state.exploration != null) exploration = restoreMizukiExplorationState(state.exploration); } catch { return false; }
    const variationSources = [exploration, ...(state.partyStates || []).map(([, party]) => party?.explorationState)]
      .map(value => value?.dungeon?.zones || {});
    if (Object.entries(state.floorState.variations || {}).some(([zoneKey, record]) =>
      !variationSources.some(zones => zones[zoneKey]?.variation === record.id))) return false;
    try {
      const missionNodes = new Set(exploration ? normalizeMizukiDungeon(exploration.dungeon).floors
        .flatMap(floor => floor.nodes.filter(node => node.type === 'MISSION').map(node => node.id)) : []);
      if (routeMissions.missions.some(mission => !missionNodes.has(mission.nodeId))) return false;
    } catch { return false; }
    const archiveMode = state.archiveMode ?? true;
    if (typeof archiveMode !== 'boolean' || (!archiveMode && !exploration)) return false;
    let candidateEndingProgress;
    try {
      candidateEndingProgress = restoreMizukiEndingProgress(state.endingProgress, { collectibles: state.collectibles,
        endingUnlocks: this.endingUnlocks, dungeon: exploration?.dungeon });
    } catch { return false; }
    const endingRestoreOptions = { endingProgress: candidateEndingProgress, collectibles: state.collectibles,
      light: state.light, seed: doc.seed };
    const missionRewardFor = (event, partyId = null) => {
      const mission = routeMissions.missions.find(value => value.id === event?.missionId && value.status === 'rewarding'
        && (!partyId || value.claimPartyId === partyId));
      if (!mission || !event?.missionReward) return null;
      return createMizukiMissionRewardEvent(mission, { owned: state.collectibles });
    };
    const validMissionReward = (event, partyId = null) => {
      const canonical = missionRewardFor(event, partyId);
      return !!canonical && JSON.stringify({ ...canonical, votes: event.votes }) === JSON.stringify(event);
    };
    const routeRestoreContext = (native, members, event) => this._routeEventContext(native, { ...endingRestoreOptions,
      event, eventLedger: state.floorState.eventLedger, partyId: restoredExpedition?.partyFor(members?.[0])?.id || null,
      dice: state.dice, diceId: state.diceId, key: state.key,
      activeMissionIds: routeMissions.missions.filter(mission => mission.status === 'active').map(mission => mission.taskId),
      cognition: cognitionLegacy ? undefined : cognitionMods, shopDiscount: cognitionMods.shopDiscount,
      extraWishChoice: /band_1[5-8]$/.test(state.squadId || ''), extraRestChoice: (cognitionLegacy ? /band_(19|20|21|22)$/ : /band_(20|21|22)$/).test(state.squadId || ''),
      players: doc.players.filter(player => !members || members.includes(player.playerId)).map(player => ({ ...player,
        roster: player.roster.map(unit => ({ ...unit, name: this.fullCatalog.byId.get(unit.operatorId)?.name || unit.operatorId })) })) });
    const validEndingDungeon = (native) => {
      if (!native || native.generator?.id !== MIZUKI_ROUTE_GENERATOR) return true;
      const canonical = this._endingExploration(native, endingRestoreOptions);
      return JSON.stringify(normalizeMizukiDungeon(native.dungeon).dungeon)
        === JSON.stringify(normalizeMizukiDungeon(canonical.dungeon).dungeon);
    };
    try { if (!validEndingDungeon(exploration)) return false; } catch { return false; }
    const legacyChoice = (choice, saved) => !state.floorState.eventLedger && choice.graphType === 'MISSION'
      && [...saved.route, saved.currentNode].some(node => node?.id === choice.id && node.graphType === 'INCIDENT')
      ? { ...choice, graphType: 'INCIDENT' } : choice;
    const canonicalChoices = this._routeOptions(exploration, archiveMode, { ledger: state.floorState.eventLedger }).map(choice => legacyChoice(choice, state));
    let restoredExpedition = null, restoredParties = new Map();
    if (state.partyRuntimeVersion != null) {
      try {
        if (state.partyRuntimeVersion !== 1 || !Array.isArray(state.partyStates)) return false;
        restoredExpedition = MizukiTeamExpedition.restore(state.expedition);
        if (restoredExpedition.players.some((member) => !doc.players.some((player) => player.playerId === member.playerId && player.seat === member.seat && player.alive && !player.left))
          || doc.players.some((player) => player.alive && !player.left && !restoredExpedition.partyFor(player.playerId))) return false;
        for (const [id, value] of state.partyStates) {
          const party = restoredExpedition.parties.get(id);
          if (!party || restoredParties.has(id) || !value || !SAFE_PHASES.has(value.phase) || value.phase === PHASE.RESULT
            || !int(value.completedNodes, 0, 999999) || !int(value.round, 1, 999999) || value.round !== value.completedNodes + 1
            || typeof value.archiveMode !== 'boolean' || !Array.isArray(value.route) || !value.votes || Array.isArray(value.votes)
            || !validRecruitContinuation(value) || !validFacilityPlacements(value.facilityPlacements, doc.players)) return false;
          const native = value.explorationState == null ? null : restoreMizukiExplorationState(value.explorationState);
          if (!value.archiveMode && !native || !validEndingDungeon(native)) return false;
          const choices = this._routeOptions(native, value.archiveMode, { ledger: state.floorState.eventLedger }).map(choice => legacyChoice(choice, value));
          const valid = (node) => choices.some((choice) => choice.id === node?.id && choice.stageId === node?.stageId
            && choice.type === node?.type && (choice.graphType === node?.graphType
              || !state.floorState.eventLedger && choice.graphType === 'MISSION' && node?.graphType === 'INCIDENT'));
          const current = choices.find((choice) => choice.id === value.currentNode?.id);
          const routeContext = routeRestoreContext(native, party.memberIds, value.event);
          const missionReward = value.event?.missionReward === true;
          const cacheReward = value.event?.driftingCache === true;
          const eventIds = value.phase === PHASE.EVENT && (missionReward ? validMissionReward(value.event, id)
            : cacheReward ? validDriftingCache(value.event, routeContext, doc.players.filter(player => party.memberIds.includes(player.playerId)))
              : validMizukiRouteEvent(value.event, current, routeContext))
            ? value.event.choices.map((choice) => choice.id) : null;
          const voteIds = value.phase === PHASE.EVENT ? eventIds : value.route.map((node) => node.id);
          if (value.route.some((node) => !valid(node)) || (value.currentNode != null && !valid(value.currentNode))
            || !voteIds || Object.entries(value.votes).some(([pid, nodeId]) => !party.memberIds.includes(pid) || !voteIds.includes(nodeId))
            || (value.phase === PHASE.EVENT && (missionReward ? value.currentNode !== null : cacheReward ? !current : current?.type !== 'event'))
            || (value.phase === PHASE.SHOP && current?.type !== 'shop')
            || (value.phase === PHASE.PREP && !['combat', 'elite', 'boss'].includes(value.currentNode?.type) && !eventBattleNode(value.currentNode))
            || (value.currentNode?.eventBattleStageId !== undefined && !eventBattleNode(value.currentNode))) return false;
          restoredParties.set(id, { ...copy(value), explorationState: native,
            route: value.route.map((node) => copy(choices.find((choice) => choice.id === node.id))),
            currentNode: current ? { ...copy(current), ...(value.currentNode.eventBattleStageId ? { eventBattleStageId: value.currentNode.eventBattleStageId } : {}) } : null,
            event: value.event && [PHASE.EVENT, PHASE.RECRUIT].includes(value.phase)
              ? { ...(missionReward ? missionRewardFor(value.event, id) : cacheReward ? driftingCacheEvent(value.event, routeContext) : createMizukiRouteEvent(current, routeContext)), votes: { ...value.votes } } : null,
            lastResults: new Map(), unitePlan: null, safePlayers: null });
        }
        if (restoredParties.size && restoredParties.size !== restoredExpedition.parties.size) return false;
        if (routeMissions.missions.some(mission => mission.status === 'rewarding'
          && (restoredParties.get(mission.claimPartyId)?.phase !== PHASE.EVENT
            || restoredParties.get(mission.claimPartyId)?.event?.missionId !== mission.id))) return false;
      } catch { return false; }
    }
    const uids = new Set();
    const reservedUids = new Set(doc.players.flatMap((player) => [...(player.roster || []).map((unit) => unit?.uid), ...(player.prep?.tokens || []).map((token) => token?.uid)]));
    const seenItemUids = new Set();
    for (const player of doc.players) {
      const current = this.players.get(player.playerId);
      const identity = this.authoritativeSeats.get(player.playerId);
      const party = restoredExpedition?.partyFor(player.playerId);
      const fieldOwnerIds = typeof player.fieldId === 'string' ? player.fieldId.split(':') : [];
      const ownsField = player.fieldId === `n:${player.playerId}`
        || (fieldOwnerIds[0] === 'b' && fieldOwnerIds.length >= 2 && fieldOwnerIds.length <= 3
          && fieldOwnerIds.slice(1).includes(player.playerId) && new Set(fieldOwnerIds.slice(1)).size === fieldOwnerIds.length - 1
          && fieldOwnerIds.slice(1).every((id) => this.players.has(id)
            && (!party || party.memberIds.includes(id) || doc.players.some((member) => member.playerId === id && !member.alive))))
        || (party && player.fieldId === `u:${party.id}`);
      if (!current || player.seat !== current.seat || !ownsField || player.isBot
        || typeof player.connected !== 'boolean' || typeof player.left !== 'boolean' || typeof player.ready !== 'boolean'
        || (player.lastEmoteAt != null && (!Number.isFinite(player.lastEmoteAt) || player.lastEmoteAt < 0))
        || !int(player.maxLife, 1, 9999) || !int(player.life, 0, player.maxLife) || !int(player.shield, 0, 9999)
        || typeof player.alive !== 'boolean' || player.alive !== (!player.left && player.life > 0)
        || (!player.alive && player.ready)
        || (current.left && !player.left) || (identity?.hasLeft && player.left !== identity.left)
        || !int(player.gold, 0, 9999) || !int(player.hope, 0, 9999) || !int(player.uidSeq, 0, 9999)
        || player.hopeCapacity !== undefined && !int(player.hopeCapacity, player.hope, 9999)
        || player.routeConsumables !== undefined && (!player.routeConsumables || typeof player.routeConsumables !== 'object'
          || Array.isArray(player.routeConsumables) || Object.entries(player.routeConsumables).some(([id, count]) =>
            OFFICIAL.rawTopic.items[id]?.type !== 'CUSTOM_TICKET' || !int(count, 0, 9999)))
        || !Array.isArray(player.roster) || player.roster.length > 1024
        || !Array.isArray(player.lineup) || player.lineup.length > state.squadCapacity || new Set(player.lineup).size !== player.lineup.length
        || player.lineup.some((uid) => !player.roster.some((unit) => unit.uid === uid))
        || !validMizukiPrep(player.prep, player)
        || !validMizukiRosterProgression(player, { itemExists: (id) => !!this.gd.item(id), seenItemUids, reservedUids })
        || !validEconomyRuntime(player) || !validMizukiEquipmentState(player, { gd: this.gd }) || !validGiftOutbox(player, doc.players, this.gd)
        || !validMizukiRouteInventory(player.routeInventory || {})
        || (player.equipmentOffers || []).some((offer) => offer.choices.some((id) => offer.kind === 'chess' ? !this.fullCatalog.byId.has(id) : !this.gd.item(id)))
        || typeof player.strategyReady !== 'boolean' || typeof player.recruitGroupReady !== 'boolean'
        || !validBattleOutcome(player.battleOutcome, commanderMaxLevel)
        || (state.initialSupplyVersion === 1 && (typeof player.initialSupplyReady !== 'boolean'
          || (player.initialSupplyId !== null && !mizukiInitialSupplyReward(player.initialSupplyId))
          || player.initialSupplyReady !== (player.initialSupplyId !== null)))
        || (player.bandId !== null && !this.strategyOptions.some((band) => band.bandId === player.bandId))
        || (player.recruitGroupId !== null && !MIZUKI_RECRUIT_GROUPS.some((group) => group.id === player.recruitGroupId))
        || (player.strategyReady !== (player.bandId !== null)) || (player.recruitGroupReady !== (player.recruitGroupId !== null))
        || !int(player.recruitRefreshes, 0, 99999)
        || !Array.isArray(player.tickets) || player.tickets.length > 4096
        || new Set(player.tickets.map((ticket) => ticket?.id)).size !== player.tickets.length
        || player.tickets.some((ticket) => !validMizukiRecruitTicket(ticket, { catalog: this.fullCatalog })
          || !ownsRecruitTicket(ticket.id, player.seat))
        || !player.layers || typeof player.layers !== 'object' || Array.isArray(player.layers)
        || !player.metaCounters || typeof player.metaCounters !== 'object' || Array.isArray(player.metaCounters)
        || Object.values(player.metaCounters).some((value) => !Number.isFinite(value))
        || !Array.isArray(player.metaMessages) || player.metaMessages.some((message) => typeof message !== 'string')
        || !int(player.gainedChess, 0, 99999)
        || Object.entries(player.layers).some(([id, layers]) => !own(this.ds.raw.bonds || {}, id) || !int(layers, 0, 999999))) return false;
      for (const unit of player.roster) {
        if (!int(unit.uid, (player.seat + 1) * 10000 + 1, (player.seat + 2) * 10000 - 1) || uids.has(unit.uid)
          || unit.uid % 10000 > player.uidSeq || !int(unit.skillIndex, 0, 9)
          || !this.catalog.includes(unit.operatorId) || !validMizukiMutation(unit.mutationId) || !validMizukiRecruitProgress(unit, { catalog: this.fullCatalog })
          || unit.chessId !== (unit.promotion ? this.fullCatalog.promotions.get(unit.operatorId)?.chessId : unit.operatorId)
          || unit.charId !== this.fullCatalog.byId.get(unit.operatorId)?.charId) return false;
        if (!validMizukiRunLoadout(this.ds, unit) || unit.runLoadout !== undefined
          && (!unit.runLoadout || typeof unit.runLoadout !== 'object' || Array.isArray(unit.runLoadout)
            || Object.keys(unit.runLoadout).some((key) => !['skillIndex', 'moduleId'].includes(key))
            || !validMizukiRunLoadout(this.ds, unit, unit.runLoadout)
            || unit.runLoadout.skillIndex !== unit.skillIndex || unit.runLoadout.moduleId !== unit.moduleId)) return false;
        uids.add(unit.uid);
      }
    }
    if (new Set(doc.players.map((player) => player.playerId)).size !== this.order.length) return false;
    if (!doc.players.some((player) => player.alive && !player.left)) return false;
    const validNode = (node) => node && canonicalChoices.some((choice) => choice.id === node.id
      && choice.stageId === node.stageId && choice.type === node.type && (choice.graphType === node.graphType
        || !state.floorState.eventLedger && choice.graphType === 'MISSION' && node.graphType === 'INCIDENT'));
    if (!state.route.every(validNode) || (state.currentNode !== null && !validNode(state.currentNode))) return false;
    const eventNode = canonicalChoices.find((choice) => choice.id === state.currentNode?.id);
    if (doc.phase === PHASE.EVENT && (state.event?.missionReward
      ? state.currentNode !== null || !validMissionReward(state.event)
      : state.event?.driftingCache ? !eventNode || !validDriftingCache(state.event, routeRestoreContext(exploration, null, state.event), doc.players)
        : eventNode?.type !== 'event' || !validMizukiRouteEvent(state.event, eventNode, routeRestoreContext(exploration, null, state.event)))) return false;
    const choiceIds = doc.phase === PHASE.EVENT ? state.event.choices.map((choice) => choice.id) : state.route.map((node) => node.id);
    if (!state.votes || typeof state.votes !== 'object' || Array.isArray(state.votes)
      || Object.entries(state.votes).some(([playerId, id]) => !this.players.has(playerId) || !choiceIds.includes(id))) return false;
    if (doc.phase === PHASE.ROUTE && state.currentNode !== null) return false;
    if (doc.phase === PHASE.ROUTE && (state.route.length !== canonicalChoices.length
      || new Set(state.route.map((node) => node.id)).size !== state.route.length)) return false;
    if (doc.phase === PHASE.SHOP && state.currentNode?.type !== 'shop') return false;
    if (doc.phase === PHASE.REWARD && !['combat', 'elite', 'boss'].includes(state.currentNode?.type) && !eventBattleNode(state.currentNode)) return false;
    if (state.currentNode?.eventBattleStageId !== undefined && !eventBattleNode(state.currentNode)) return false;
    for (const player of doc.players) {
      const playerPhase = restoredParties.get(restoredExpedition?.partyFor(player.playerId)?.id)?.phase || doc.phase;
      const playerContinuation = restoredParties.get(restoredExpedition?.partyFor(player.playerId)?.id)?.continuation || state.continuation;
      if (player.left || !player.alive) continue;
      if (playerPhase === PHASE.RECRUIT) {
        const ids = player.recruit?.ticketIds;
        if (!Array.isArray(ids) || !ids.length && !['event', 'shop'].includes(playerContinuation) || ids.length > 64
          || new Set(ids).size !== ids.length || ids.some((id) => !player.tickets.some((ticket) => ticket.id === id))) return false;
        const pending = player.tickets.filter((ticket) => ids.includes(ticket.id) && ticket.count > 0);
        if (player.ready !== (pending.length === 0)
          || (pending.length ? !pending.some((ticket) => ticket.id === player.recruit.activeTicketId) : player.recruit.activeTicketId !== null)) return false;
      }
      const routeState = restoredParties.get(restoredExpedition?.partyFor(player.playerId)?.id);
      if ((playerPhase === PHASE.SHOP || playerPhase === PHASE.RECRUIT && (routeState?.continuation || state.continuation) === 'shop')
        && !validMizukiRouteShop(player.shop, routeState?.currentNode || state.currentNode)) return false;
      const cachePhase = playerPhase === PHASE.EVENT && (routeState?.event || state.event)?.driftingCache;
      if (playerPhase === PHASE.REWARD || cachePhase) {
        if (!Array.isArray(player.rewards) || !player.rewards.length || player.rewards.length > 64
          || new Set(player.rewards.map(reward => reward.id)).size !== player.rewards.length
          || player.rewards.some(reward => typeof reward.id !== 'string' || !['recruitTicket', 'collectible', 'driftingCache'].includes(reward.type)
            || reward.group !== undefined && (typeof reward.group !== 'string' || reward.group.length > 80)
            || reward.selected !== undefined && typeof reward.selected !== 'boolean'
            || (reward.type === 'collectible' ? !mizukiCollectibleSpec(reward.itemId) || !reward.group
              : reward.type === 'driftingCache' ? reward.itemId !== 'rogue_2_treasure' || reward.group !== 'driftingCache'
                || !Array.isArray(reward.contents) || reward.contents.length !== 1 || reward.contents.some(id => !mizukiCollectibleSpec(id))
              : !player.tickets.some(ticket => ticket.id === reward.ticketId && ticket.status === 'available'
                && ticket.count === (ticket.recruitLimit ?? MIZUKI_RECRUIT_RULES.recruitsPerTicket) && !ticket.revision)))) return false;
        if (player.rewards.some(reward => reward.group)) {
          const groups = [...new Set(player.rewards.map(reward => reward.group))];
          if (groups.some(group => !group || player.rewards.filter(reward => reward.group === group && reward.selected).length > 1)
            || player.ready !== groups.every(group => player.rewards.some(reward => reward.group === group && reward.selected))) return false;
        }
      }
      const pendingIds = playerPhase === PHASE.RECRUIT ? player.recruit.ticketIds
        : playerPhase === PHASE.REWARD || cachePhase ? player.rewards.map((reward) => reward.ticketId).filter(Boolean) : [];
      if (player.tickets.some((ticket) => ticket.status === 'available' && !pendingIds.includes(ticket.id))) return false;
    }
    let recoveredPlayers;
    try {
      recoveredPlayers = doc.players.map(player => materializeMizukiRecruitCopies(player, state.squadCapacity));
      const recoveredUids = recoveredPlayers.flatMap(player => [
        ...player.roster.map(unit => unit.uid), ...(player.prep?.tokens || []).map(token => token.uid),
      ]);
      const recoveredItems = new Set();
      if (new Set(recoveredUids).size !== recoveredUids.length || recoveredPlayers.some(player =>
        !validMizukiRosterProgression(player, { itemExists:id => !!this.gd.item(id),
          seenItemUids:recoveredItems, reservedUids:recoveredUids }))) return false;
    }
    catch { return false; }
    this._clearFields();
    this.order = recoveredPlayers.map((player) => {
      const current = this.players.get(player.playerId);
      const inheritedHopeCapacity = mizukiDifficultyInitial(state.difficultyGrade).initialPopulation
        + mizukiCommanderLevelRewards(1, commander.level).reduce((sum, reward) => sum + reward.populationUp, 0);
      return { autoplay: false, initialSupplyId: null, initialSupplyReady: false, lastEmoteAt: null, economicCoinTotal: 0, economicCoinRemainder: 0, economicHopePending: 0, economicBattleCoins: {}, nativeHookIds: [], routeInventory: {},
        hopeCapacity: Math.max(player.hope, inheritedHopeCapacity),
        equipmentSeq: 0, equipmentBattlesCompleted: 0, equipmentBattleIds: [], equipmentRequestIds: [], equipmentHookIds: [],
        equipmentEffects: [], equipmentPendingFunds: 0, equipmentOffers: [], equipmentOfferSeq: 0, equipmentGiftOutbox: [], equipmentDeployCapMin: 0, equipmentDeployCapBonus: 0,
        ...player, layers: clearNonStackingBondLayers({ ...player.layers }), name: current.name, connected: current.connected && !player.left };
    }).sort((a, b) => a.seat - b.seat);
    this.players = new Map(this.order.map((player) => [player.playerId, player]));
    this.seed = doc.seed; this.matchId = doc.matchId; this.matchNo = doc.matchNo;
    this.startedAt = Number(doc.startedAt) || this.now(); this.revision = Math.max(0, Number(doc.revision) || 0);
    this.phase = doc.phase; this.round = state.completedNodes + 1;
    this.completedNodes = state.completedNodes; this.light = state.light;
    this.cognitionLegacy = cognitionLegacy; this.cognition = cognition; this.cognitionMods = cognitionMods;
    this.baseSquadId = baseSquadId; this.explorationScores = copy(explorationScores); this.sanRerollsUsed = state.sanRerollsUsed || 0;
    this.selectedSquad = restoredSquad || null;
    this.squadVotes = { ...state.squadVotes }; this.squadCapacity = state.squadCapacity;
    this.key = state.key; this.diceId = state.diceId; this.dice = state.dice; this.collectibles = copy(state.collectibles);
    this.battleDiceSpent = copy(battleDiceSpent);
    this.endingProgress = candidateEndingProgress;
    this.nativeItems = copy(nativeItems);
    this.collectibleLayers = copy(collectibleLayers);
    this.routeMissions = copy(routeMissions);
    this.commander = copy(commander);
    this.difficultyGrade = state.difficultyGrade;
    this.floorState = copy(state.floorState); this.facilityPlacements = copy(state.facilityPlacements);
    this.squadMods = { atkPct: cognitionMods.atkPct, defPct: cognitionMods.defPct, hpPct: cognitionMods.hpPct };
    for (const effect of this.selectedSquad?.effects || []) if (effect.key === 'char_attribute_mul') {
      const values = effectValues(effect); this.squadMods = { ...this.squadMods, atkPct: cognitionMods.atkPct + (values.atk || 0), hpPct: cognitionMods.hpPct + (values.max_hp || 0) };
    }
    this.explorationState = exploration; this.archiveMode = archiveMode;
    this.route = state.route.map((node) => copy(canonicalChoices.find((choice) => choice.id === node.id))); this.votes = copy(state.votes || {});
    this.event = state.event && [PHASE.EVENT, PHASE.RECRUIT].includes(doc.phase)
      ? state.event.missionReward ? missionRewardFor(state.event) : state.event.driftingCache ? driftingCacheEvent(state.event, routeRestoreContext(exploration, null, state.event))
        : createMizukiRouteEvent(eventNode, routeRestoreContext(exploration, null, state.event)) : null;
    if (this.event) this.event.votes = { ...this.votes };
    this.currentNode = state.currentNode ? { ...copy(canonicalChoices.find((choice) => choice.id === state.currentNode.id)),
      ...(state.currentNode.eventBattleStageId ? { eventBattleStageId: state.currentNode.eventBattleStageId } : {}) } : null;
    this.continuation = state.continuation; this.offerSeq = state.offerSeq;
    this.hostId = this.players.has(state.hostId) ? state.hostId : this.order[0].playerId;
    this.expedition = restoredExpedition || new MizukiTeamExpedition({ players: this.order.filter((player) => player.alive && !player.left).map(({ playerId, seat }) => ({ playerId, seat })), leaderId: this.hostId });
    this.partyStates = restoredParties;
    // Older local starts had no route at all. Add a seeded map only before any
    // node was entered; caller-supplied maps and existing progress keep their graph.
    if (!this.opts.dungeon && !this.explorationState && this.archiveMode && this.completedNodes === 0
      && !this.currentNode && [...this.partyStates.values()].every((value) =>
        !value.explorationState && value.archiveMode && value.completedNodes === 0 && !value.currentNode)) {
      this.explorationState = createMizukiExplorationState(generateMizukiDungeon({ seed: this.seed, stageOptions: this.stageOptions, cognition: this.cognitionLegacy ? undefined : this.cognitionMods }),
        { sourceLabel: MIZUKI_ROUTE_SOURCE_LABEL, generator: { id: MIZUKI_ROUTE_GENERATOR, version: 1, seed: this.seed } });
      this.archiveMode = false;
      if (this.phase === PHASE.ROUTE) this.route = this._routeOptions();
      for (const party of this.expedition.parties.values()) {
        const value = this.partyStates.get(party.id);
        if (value) {
          value.explorationState = copy(this.explorationState); value.archiveMode = false;
          if (value.phase === PHASE.ROUTE) value.route = this._routeOptions(value.explorationState, false);
          value.votes = {}; party.votes = {};
        }
        this.expedition.setContext(party.id, this.explorationState);
      }
      this.votes = {};
    }
    this._restoreRouteEventLedger();
    this._resolveRecalls();
    if (this.partyStates.size) {
      for (const party of this.expedition.parties.values()) if (this.partyStates.get(party.id).phase === PHASE.PREP) {
        try { this._withParty(party, () => { this._resetReady(); this._prepareFields(); }); }
        catch (error) { this.log.error('[mizuki] restore party content', error); this._clearFields(); return false; }
      }
      this._syncPartyAggregate();
    } else if (this.phase === PHASE.PREP) {
      this._resetReady();
      try { this._prepareFields(); } catch (error) { this.log.error('[mizuki] restore content', error); this._clearFields(); return false; }
    }
    // An old save may contain an opened voucher with an empty or obsolete candidate page.
    for (const player of this.order) if (player.recruit && player.alive && !player.left) this._refreshRecruit(player);
    this.started = true;
    this._departReadyAtRendezvous();
    // Combat checkpoints resume in PREP, so a manual battle pause never locks the restored preparation screen.
    this.manualPaused = false; this.manualPausedAt = null;
    this._commit();
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.autoplayController?.dispose();
    this._clearFields(); this.disposed = true; this.observers.clear();
    if (this.ownsScheduler) this.sched.dispose();
  }
}

export { MizukiMatch as Match };
export default MizukiMatch;
