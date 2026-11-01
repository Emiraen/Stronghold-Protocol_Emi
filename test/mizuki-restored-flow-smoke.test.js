import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { MizukiAutoCombat } from '../server/modes/mizuki/Combat.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const FRAME_MS = 1000 / 30;
const SUPPLY = ['choice_ro2_startbuff_2', 'choice_ro2_startbuff_6', 'choice_ro2_startbuff_3'];
const DUNGEON = { zones: [{ id: 'zone_1', nodes: [
  { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [{ x: 1, y: 0 }] },
  { pos: { x: 1, y: 0 }, type: 'BATTLE_ELITE', stage: 'ro2_e_1_1', next: [] },
] }] };

function fixture(t, { count = 1, ...extra } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [], messages = [];
  const match = new MizukiMatch({ roomCode: 'SMOK', seed: 619, matchNo: 1, matchId: 'mizuki-restored-flow-smoke',
    hostId: 'p0', seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    data: DATA, scheduler, dungeon: structuredClone(DUNGEON),
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) },
    send: (id, message) => messages.push({ id, message }), broadcast: message => messages.push({ message }), onEnd() {}, ...extra });
  t.after(() => { match.dispose(); scheduler.dispose(); });
  return { match, scheduler, errors, messages };
}
const command = (match, id, message) => {
  const result = match.handle(id, message);
  assert.equal(result.ok, true, JSON.stringify({ message, result }));
  assert.doesNotThrow(() => { match.publicView(); for (const player of match.order) match.privateView(player.playerId); });
  return result;
};
const phase = (match, id = 'p0') => match.privateView(id).mizuki.phase;
function enterSupply(match) {
  match.start();
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_1' });
  assert.equal(phase(match), PHASE.STRATEGY);
  for (const [i, p] of match.order.entries()) command(match, p.playerId, { t: 'g.mizuki.strategy', bandId: match.strategyOptions[i].bandId });
  assert.equal(phase(match), PHASE.INITIAL_SUPPLY);
}
function enterRoute(match) {
  enterSupply(match);
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.initialSupply', choiceId: SUPPLY[0] });
  assert.equal(phase(match), PHASE.RECRUIT_GROUP);
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  assert.equal(phase(match), PHASE.RECRUIT);
  for (const p of match.order) {
    const recruit = match.privateView(p.playerId).mizuki.recruit;
    assert.ok(recruit.choices.length > 0);
    const choice = recruit.choices.find(value => value.available && value.hopeCost === 0) || recruit.choices.find(value => value.available);
    assert.ok(choice, 'initial voucher contains an affordable operator');
    command(match, p.playerId, { t: 'g.mizuki.recruit', offerId: choice.offerId });
  }
  skipMizukiRecruit(match);
  assert.equal(phase(match), PHASE.ROUTE);
}
function enterCombat(match) {
  const node = match.privateView('p0').mizuki.route.find(value => value.available);
  assert.ok(node?.stageName, 'the reachable battle exposes its original stage title');
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.route', nodeId: node.id });
  command(match, 'p0', { t: 'g.mizuki.routeStart' });
  assert.equal(phase(match), PHASE.PREP);
  assert.equal(match.privateView('p0').mizuki.currentNode.stageName, node.stageName);
  for (const p of match.order) command(match, p.playerId, { t: 'g.mizuki.ready', on: true });
  assert.equal(phase(match), PHASE.COMBAT);
  return match.fields.get(match.players.get('p0').fieldId);
}
function settle(match, scheduler) {
  // Use production engines; control only the end condition so this is one short
  // settlement smoke test rather than playing an entire original stage.
  for (const field of match.fields.values()) field.engine.forceEnd('cleared');
  scheduler.advance(FRAME_MS * 2);
  assert.equal(phase(match), PHASE.REWARD);
}

test('restored supply phase awards all three original choices once and preserves shared kettle semantics', t => {
  const { match, scheduler, errors } = fixture(t, { count: 4 });
  enterSupply(match);
  const before = match.order.map(({ hope, gold, maxLife }) => ({ hope, gold, maxLife }));
  assert.equal(match.privateView('p0').mizuki.initialSupply.options.length, 3);
  assert.notEqual(match.handle('p0', { t: 'g.mizuki.initialSupply', choiceId: 'missing' }).ok, true);
  command(match, 'p0', { t: 'g.mizuki.initialSupply', choiceId: SUPPLY[0] });
  assert.notEqual(match.handle('p0', { t: 'g.mizuki.initialSupply', choiceId: SUPPLY[0] }).ok, true);
  assert.equal(phase(match), PHASE.INITIAL_SUPPLY);
  command(match, 'p1', { t: 'g.mizuki.initialSupply', choiceId: SUPPLY[1] });
  command(match, 'p2', { t: 'g.mizuki.initialSupply', choiceId: SUPPLY[2] });
  command(match, 'p3', { t: 'g.mizuki.initialSupply', choiceId: SUPPLY[1] });
  assert.equal(phase(match), PHASE.RECRUIT_GROUP);
  assert.equal(match.collectibles.filter(id => id === 'rogue_2_relic_grace_21').length, 1);
  for (const [i, p] of match.order.entries()) {
    assert.equal(p.hope, before[i].hope + 1 + (i === 0 ? 2 : 0));
    assert.equal(p.gold, before[i].gold + (i === 2 ? 5 : 0));
    assert.equal(p.maxLife, before[i].maxLife + 1);
    assert.equal(p.hopeCapacity, p.hope);
  }
  assert.deepEqual(errors, []); assert.deepEqual(scheduler.errors, []);
  t.diagnostic('hope +2, kettle hope/max-life +1, gold +5; duplicate confirmation and duplicate shared relic do not grant twice');
});

test('production combat advances at 2x and settles original gold, chest gold, experience and level 2 hope', t => {
  const { match, scheduler, errors } = fixture(t);
  enterRoute(match);
  const field = enterCombat(match), engine = field.engine, player = match.players.get('p0');
  assert.ok(engine instanceof MizukiAutoCombat);
  const before = { gold: player.gold, hope: player.hope, hopeCapacity: player.hopeCapacity };
  const initialTick = engine.tick;
  scheduler.advance(500);
  // Like the ordinary FieldRunner, an epoch-based clock can retain a fraction
  // of one tick. Half a second at 2x must simulate 29-30 ticks, never 14-15.
  const advanced = engine.tick - initialTick;
  assert.ok(advanced >= 29 && advanced <= 30, `half a second must advance 29-30 ticks, got ${advanced}`);
  command(match, 'p0', { t: 'g.pause', on: true });
  const pausedAt = engine.tick;
  scheduler.advance(1000);
  assert.equal(engine.tick, pausedAt);
  command(match, 'p0', { t: 'g.pause', on: false });
  scheduler.advance(500);
  const resumed = engine.tick - pausedAt;
  assert.ok(resumed >= 29 && resumed <= 30, `resume must not replay paused wall time, got ${resumed} ticks`);
  const b = engine.battle;
  for (const [i, key] of ['trap_065_normbox', 'trap_066_rarebox'].entries()) {
    const instance = { alias: 'smoke-chest-' + i, inst: { characterKey: key, level: 1, phase: 'PHASE_0' },
      position: { row: b.rect.r0, col: b.rect.c0 + i }, direction: 'RIGHT', mainSkillLvl: 1, skillIndex: 0 };
    assert.equal(engine.stageMechanics.waveOptions.activatePredefined(instance.alias, instance), true);
    const box = b.enemies.find(unit => unit.alive && unit.defId === key);
    assert.ok(box); b.kill(box);
  }
  settle(match, scheduler);
  const outcome = match.privateView('p0').mizuki.battleOutcome;
  assert.equal(player.gold, before.gold + 2 + 2 + 4);
  assert.deepEqual(match.commander, { level: 2, exp: 0, totalExp: 10 });
  assert.equal(player.hope, before.hope + 4);
  assert.equal(player.hopeCapacity, before.hopeCapacity + 4);
  assert.equal(outcome.perfect, true); assert.equal(outcome.lpLoss, 0);
  assert.equal(outcome.rewards.exp, 10); assert.equal(outcome.rewards.gold, 8);
  assert.equal(outcome.rewards.commanderBefore.level, 1); assert.equal(outcome.rewards.commanderAfter.level, 2);
  assert.equal(outcome.autoGranted.find(reward => reward.itemId === 'rogue_2_gold').count, 8);
  assert.equal(engine.battle.errorCount, 0);
  const restored = fixture(t).match;
  assert.equal(restored.restoreCheckpoint(structuredClone(match.exportCheckpoint())), true);
  assert.deepEqual(restored.privateView('p0').mizuki.battleOutcome, outcome);
  assert.equal(restored.players.get('p0').hopeCapacity, player.hopeCapacity);
  assert.equal(restored.players.get('p0').gold, player.gold);
  assert.deepEqual(restored.commander, match.commander);
  assert.deepEqual(errors, []); assert.deepEqual(scheduler.errors, []);
  t.diagnostic('normal battle: +10 EXP, +2 base gold, +2 normal chest gold, +4 spiked chest gold; Lv1 -> Lv2 grants +4 current/cap hope; reward checkpoint preserves actual balances');
});

test('elite graph classification guarantees relic choices and grants chosen relic after all reward groups', t => {
  const { match, scheduler, errors } = fixture(t, { dungeon: { zones: [{ id: 'zone_1', nodes: [
    { pos: { x: 0, y: 0 }, type: 'BATTLE_ELITE', stage: 'ro2_e_1_1', next: [] },
  ] }] } });
  enterRoute(match); enterCombat(match);
  const before = match.players.get('p0').gold;
  settle(match, scheduler);
  assert.equal(match.players.get('p0').gold, before + 3);
  assert.equal(match.commander.totalExp, 12);
  const rewards = match.privateView('p0').mizuki.rewards;
  const ticket = rewards.find(reward => reward.type === 'recruitTicket');
  const relic = rewards.find(reward => reward.type === 'collectible');
  assert.ok(ticket); assert.ok(relic, 'an elite battle always has its collectible choice group');
  command(match, 'p0', { t: 'g.mizuki.reward', rewardId: ticket.id });
  assert.equal(phase(match), PHASE.REWARD, 'picking a voucher leaves the relic group available');
  command(match, 'p0', { t: 'g.mizuki.reward', rewardId: relic.id });
  assert.ok(match.collectibles.includes(relic.itemId), 'selected original relic is committed to the run');
  assert.equal(phase(match), PHASE.RECRUIT);
  assert.deepEqual(errors, []); assert.deepEqual(scheduler.errors, []);
  t.diagnostic('elite battle: +12 EXP, +3 gold, recruitment choice plus a guaranteed original collectible choice; chosen collectible enters inventory');
});

test('killing a bonus enemy grants its own collectible group even when the normal random drop misses', t => {
  const { match, scheduler, errors } = fixture(t);
  enterRoute(match);
  const field = enterCombat(match), b = field.engine.battle;
  scheduler.advance(FRAME_MS);
  const originalRng = match._rng.bind(match);
  match._rng = salt => salt === 'battle-relic-drops' ? () => 0.99 : originalRng(salt);
  const duck = b.spawnEnemy('enemy_2001_duckmi', { pos: [b.rect.r0, b.rect.c0], countInTotal: false,
    def: { key: 'enemy_2001_duckmi', name: '鸭爵', stats: { maxHp: 100, atk: 0, def: 0, res: 0,
      rangeRadius: 0, moveSpeed: 0, baseAttackTime: 99 }, dmgType: 'none', motion: 'WALK' },
    route: { motion: 'WALK', start: [b.rect.r0, b.rect.c0], end: [b.rect.r0, b.rect.c0], checkpoints: [{ type: 'WAIT', time: 9999 }] } });
  assert.ok(duck); b.kill(duck);
  assert.equal(field.engine.stageMechanics.snapshot().logs.bonusCollectible, 1);
  settle(match, scheduler);
  const relics = match.privateView('p0').mizuki.rewards.filter(reward => reward.type === 'collectible');
  assert.equal(new Set(relics.map(reward => reward.group)).size, 1);
  assert.equal(relics.length, 2);
  assert.deepEqual(errors, []); assert.deepEqual(scheduler.errors, []);
  t.diagnostic('actual killed-enemy log grants one independent collectible choice group; the normal random drop was forced to miss');
});

test('all native commander levels apply actual hope, carry capacity and max-life increments', t => {
  const { match } = fixture(t, { count: 2, cognition: { totalScore: 22400 } });
  match.start();
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_19' });
  assert.equal(match.selectedSquad.id, 'rogue_2_band_22', 'fully developed people-oriented squad unlocks native level 11');
  const before = match.order.map(({ hope, hopeCapacity, maxLife, life }) => ({ hope, hopeCapacity, maxLife, life }));
  const carryBefore = match.squadCapacity;
  // Original playerLevelTable rows 2-11: 535 EXP, 69 hope, 5 carry slots,
  // 9 max-life. Keep independent totals so missing a reward row fails here.
  const exp = 535, hope = 69, carry = 5, hp = 9;
  match._gainCommandExperience(exp);
  assert.equal(match.commander.level, 11); assert.equal(match.commander.exp, 0);
  for (const [i, p] of match.order.entries()) {
    assert.equal(p.hope, before[i].hope + hope);
    assert.equal(p.hopeCapacity, before[i].hopeCapacity + hope);
    assert.equal(p.maxLife, before[i].maxLife + hp);
    assert.equal(p.life, before[i].life, 'capacity-only level bonuses do not invent a heal');
  }
  assert.equal(match.squadCapacity, carryBefore + carry);
  t.diagnostic(`native Lv2-Lv11 cumulative bonuses: hope/current-cap +${hope}, carry capacity +${carry}, max-life +${hp}`);
});

test('a new run retains the native level-10 cap and does not grant the locked level-11 reward', t => {
  const { match } = fixture(t, { count: 2 });
  match.start();
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.squad', squadId: 'rogue_2_band_19' });
  assert.equal(match.selectedSquad.id, 'rogue_2_band_19');
  const before = match.order.map(({ hope, hopeCapacity, maxLife, life }) => ({ hope, hopeCapacity, maxLife, life }));
  const carryBefore = match.squadCapacity;
  match._gainCommandExperience(535);
  assert.equal(match.commander.level, 10); assert.equal(match.commander.exp, 80);
  for (const [i, player] of match.order.entries()) {
    assert.equal(player.hope, before[i].hope + 54);
    assert.equal(player.hopeCapacity, before[i].hopeCapacity + 54);
    assert.equal(player.maxLife, before[i].maxLife + 4);
    assert.equal(player.life, before[i].life);
  }
  assert.equal(match.squadCapacity, carryBefore + 3);
});

test('restored frontend modules parse together in the single smoke pass', () => {
  for (const file of ['mizukiProjection.js', 'mizukiRuntime.js', 'mizukiNativeApp.js', 'screens/mizuki.js',
    'screens/mizukiSelect.js', 'screens/mizukiRoute.js', 'screens/mizukiBattle.js', 'screens/mizukiOutcome.js', 'screens/game.js']) {
    assert.doesNotThrow(() => parse(readFileSync(new URL('../public/js/' + file, import.meta.url), 'utf8'),
      { sourceType: 'module', ecmaVersion: 'latest' }), file);
  }
});
