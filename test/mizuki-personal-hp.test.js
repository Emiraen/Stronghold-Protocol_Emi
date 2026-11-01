import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { Grid } from '../server/sim/grid.js';
import { MIZUKI_PHASES as PHASE } from '../shared/mizuki-constants.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';

const DATA = getData({ log: { info() {}, warn() {}, error() {} } });
const FRAME = 1000 / 30;
const hp = (match) => match.order.map(({ life, maxLife, shield }) => ({ life, maxLife, shield }));
const command = (match, playerId, message) => {
  const result = match.handle(playerId, message); assert.equal(result.ok, true, JSON.stringify(result)); return result;
};

// A controlled result boundary tests accounting without relying on enemies'
// clear times. Real normal/rescue attribution is covered by unite-match and
// difficulty-integration, including a rescue source absent from that field.
class PersonalCombat {
  constructor(options) {
    this.options = options; this.done = false; this.ticks = 0; this.deployLimit = options.deployLimit;
    this.battle = { grid: new Grid(options.stage, options.rect), rect: options.rect, data: options.data,
      allyUnits: [], enemies: [], players: options.players.map(player => ({ playerId: player.playerId, units: [] })),
      opts: { spawns: [] }, on() {} };
    this.rows = Object.fromEntries(options.players.map(({ playerId }) => [playerId,
      { leaked: [], leaderLpLoss: 0, perfect: false }]));
    this.nativeLifeLossByPlayer = {};
  }
  step() { this.ticks++; }
  result() {
    return this.done ? { outcome: 'victory', perPlayer: this.rows, nativeLifeLossByPlayer: this.nativeLifeLossByPlayer,
      nativeLifeLoss: Object.values(this.nativeLifeLossByPlayer).reduce((sum, n) => sum + n, 0),
      leakedCount: Object.values(this.rows).reduce((sum, row) => sum + row.leaked.filter((leak) => leak.counted !== false).length, 0) } : null;
  }
  snapshot() {
    return { battleId: this.options.battleId, fieldId: this.options.fieldId, tick: this.ticks, t: this.ticks / 30,
      units: [], rosters: Object.fromEntries(this.options.players.map(({ playerId }) => [playerId, []])),
      covenants: {}, leakedCount: this.result()?.leakedCount || 0, done: this.done,
      geometry: { rows: 19, cols: 21, rect: this.options.rect, tiles: [] } };
  }
  fieldMeta() { return { fieldId: this.options.fieldId, stageId: this.options.stageId, units: [] }; }
  drainEvents() { return []; }
  dispose() {}
  forceEnd() { this.done = true; }
}

function fixture(t, { count = 4, ...extra } = {}) {
  const scheduler = new VirtualScheduler({ instantCombat: false }), errors = [], frames = [], ended = [];
  const options = { roomCode: 'PERS', seed: 107, hostId: 'p0', data: DATA, scheduler, CombatClass: PersonalCombat,
    seats: Array.from({ length: count }, (_, seat) => ({ playerId: 'p' + seat, seat, connected: true })),
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) },
    send: (playerId, message) => frames.push({ playerId, message }), broadcast() {},
    onEnd: (summary) => ended.push(summary), ...extra };
  const match = new MizukiMatch(options); t.after(() => { match.dispose(); scheduler.dispose(); });
  return { match, scheduler, errors, frames, ended, options };
}
function enterRoute(match, squadId = 'rogue_2_band_3') {
  match.start();
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.squad', squadId });
  // These fixtures isolate LP attribution and elimination. Goliath deliberately
  // increases starting LP, while income strategies can add unrelated rewards.
  const neutral = match.strategyOptions.filter(option => option.bandId !== 'band_sarkazb'
    && DATA.bands[option.bandId]?.buffs?.every(buff => buff.key === 'env_gbuff_new_with_verify'));
  assert.ok(neutral.length >= match.order.length);
  for (const [i, player] of match.order.entries()) command(match, player.playerId, { t: 'g.mizuki.strategy', bandId: neutral[i].bandId });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.initialSupply', choiceId: 'choice_ro2_startbuff_3' });
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.recruitGroup', groupId: 'recruit_group_1' });
  skipMizukiRecruit(match); assert.equal(match.phase, PHASE.ROUTE);
  // Generated region I correctly has one entrance and no immediately selectable
  // Boss. Attribution fixtures explicitly import the native nodes they exercise.
  const boss = match.stageOptions.find(node => node.type === 'boss' && node.available); assert.ok(boss);
  command(match, match.hostId, { t: 'g.mizuki.importDungeon', sourceLabel: 'personal health native-schema fixture', dungeon: { zones: [
    { id: 'zone_1', nodes: [
      { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [{ x: 1, y: 0 }] },
      { pos: { x: 0, y: 1 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [{ x: 1, y: 0 }] },
      { pos: { x: 0, y: 2 }, type: 'BATTLE_BOSS', stage: boss.stageId, next: [{ x: 1, y: 0 }] },
      { pos: { x: 1, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
    ] },
    { id: 'zone_2', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] },
  ] } });
}
function prepare(match, type = 'combat') {
  const node = match.route.find((entry) => entry.available && entry.type === type); assert.ok(node);
  for (const player of match._active()) command(match, player.playerId, { t: 'g.mizuki.route', nodeId: node.id });
  command(match, match.hostId, { t: 'g.mizuki.routeStart' });
}
function launch(match, ids = match._active().map((player) => player.playerId)) {
  for (const id of ids) command(match, id, { t: 'g.mizuki.ready', on: true });
}
function finish(match, scheduler, fieldIds = [...match.fields.keys()]) {
  for (const id of fieldIds) match.fields.get(id).engine.done = true;
  scheduler.advance(FRAME * 2);
}
function damageLeak(engine, ownerId, lpr, extras = {}) {
  engine.rows[ownerId].leaked.push({ enemyKey: 'fixture_counted', sourcePlayerId: ownerId, counted: true, lpr, ...extras });
}
function claimRewards(match, ids) {
  for (let turn = 0; turn < 32; turn++) {
    let acted = false;
    for (const id of ids) {
      const view = match.privateView(id).mizuki;
      if (view.phase !== PHASE.REWARD || view.ready) continue;
      const choices = view.rewards.filter(value => !value.selected
        && !view.rewards.some(selected => selected.group === value.group && selected.selected));
      const reward = choices.find(value => value.type !== 'collectible' || !match.collectibles.includes(value.itemId)) || choices[0];
      assert.ok(reward);
      const result = match.handle(id, { t: 'g.mizuki.reward', rewardId: reward.id });
      assert.ok(result.ok || result.error === 'BAD_TARGET', JSON.stringify(result)); acted = true;
    }
    if (!acted) break;
  }
  for (const id of ids) assert.notEqual(match.privateView(id).mizuki.phase, PHASE.REWARD);
}
function splitSolo(match) {
  const choices = match.route.filter((node) => node.available && node.type === 'combat').slice(0, 2);
  for (const player of match.order) command(match, player.playerId, { t: 'g.mizuki.route', nodeId: choices[player.seat === 3 ? 1 : 0].id });
  const split = command(match, 'p3', { t: 'g.mizuki.splitRequest', nodeId: choices[1].id });
  command(match, 'p0', { t: 'g.mizuki.splitDecide', requestId: split.request.id, approve: true });
  command(match, 'p0', { t: 'g.mizuki.routeStart' });
}

test('personal health is authoritative in public/private/result resources without a shared life aggregate', (t) => {
  const { match, ended } = fixture(t, { count: 2 }); match.start();
  Object.assign(match.players.get('p0'), { life: 1, maxLife: 7, shield: 2 });
  Object.assign(match.players.get('p1'), { life: 4, maxLife: 9, shield: 0 });
  const pub = match.publicView();
  assert.deepEqual(pub.players.map(({ life, maxLife, shield, lp }) => [life, maxLife, shield, lp]), [[1, 7, 2, 1], [4, 9, 0, 4]]);
  for (const key of ['life', 'maxLife', 'shield']) {
    assert.equal(Object.hasOwn(match, key), false); assert.equal(Object.hasOwn(pub.mizuki, key), false);
    assert.equal(pub.mizuki.resourceOwnership[key], 'player');
    assert.equal(match.privateView('p0').mizuki[key], match.players.get('p0')[key]);
    assert.equal(match.privateView('p1').mizuki[key], match.players.get('p1')[key]);
  }
  match._finish(true, 'fixture');
  assert.deepEqual(ended[0].players.map(({ life, maxLife, shield }) => [life, maxLife, shield]), [[1, 7, 2], [4, 9, 0]]);
  assert.equal(Object.hasOwn(ended[0], 'life'), false);
});

test('four normal fields charge each counted leak and direct LP only to its personal owner', (t) => {
  const { match, scheduler, errors } = fixture(t); enterRoute(match); prepare(match); launch(match);
  Object.assign(match.players.get('p0'), { life: 8, maxLife: 8, shield: 1 });
  Object.assign(match.players.get('p1'), { life: 6, maxLife: 9, shield: 3 });
  Object.assign(match.players.get('p2'), { life: 7, maxLife: 7, shield: 0 });
  Object.assign(match.players.get('p3'), { life: 5, maxLife: 5, shield: 2 });
  damageLeak(match.fields.get('n:p0').engine, 'p0', 3);
  damageLeak(match.fields.get('n:p1').engine, 'p1', 2);
  damageLeak(match.fields.get('n:p2').engine, 'p2', 99, { counted: false });
  const native = match.fields.get('n:p3').engine;
  native.nativeLifeLossByPlayer.p3 = 3; native.rows.p3.leaderLpLoss = 3;
  finish(match, scheduler);
  assert.deepEqual(hp(match), [{ life: 6, maxLife: 8, shield: 0 }, { life: 6, maxLife: 9, shield: 1 },
    { life: 7, maxLife: 7, shield: 0 }, { life: 2, maxLife: 5, shield: 2 }]);
  assert.equal(match.phase, PHASE.REWARD);
  const settled = hp(match); scheduler.advance(FRAME * 5); assert.deepEqual(hp(match), settled); assert.deepEqual(errors, []);
});

test('Boss pairs retain four independent health pools and never sum paired player shields', (t) => {
  const { match, scheduler, errors } = fixture(t); enterRoute(match); prepare(match, 'boss'); launch(match);
  assert.deepEqual([...match.fields.values()].map((field) => field.players), [['p0', 'p1'], ['p2', 'p3']]);
  for (const player of match.order) Object.assign(player, { life: 10, maxLife: 10, shield: player.seat });
  const first = match.fields.get('b:p0:p1').engine, second = match.fields.get('b:p2:p3').engine;
  damageLeak(first, 'p0', 2); damageLeak(first, 'p1', 4); damageLeak(second, 'p2', 1);
  finish(match, scheduler);
  assert.deepEqual(hp(match), [{ life: 8, maxLife: 10, shield: 0 }, { life: 7, maxLife: 10, shield: 0 },
    { life: 10, maxLife: 10, shield: 1 }, { life: 10, maxLife: 10, shield: 3 }]);
  assert.equal(match.phase, PHASE.REWARD); assert.deepEqual(errors, []);
});

test('production paired Boss rotates whole leak events by seat including different LP costs', (t) => {
  const { match, scheduler, errors } = fixture(t, { count: 2, CombatClass: undefined });
  enterRoute(match); prepare(match, 'boss');
  for (const player of match.order) Object.assign(player, { life: 10, maxLife: 10, shield: player.seat + 1 });
  launch(match);
  const field = [...match.fields.values()][0], b = field.engine.battle;
  b.start();
  for (const lpr of [1, 3, 2]) {
    const enemy = b.spawnEnemy('enemy_1007_slime', { route: field.setup.routes[0] }); assert.ok(enemy);
    enemy.lpr = lpr; b.leak(enemy);
  }
  b.forceEnd('cleared');
  const rows = field.engine.result().perPlayer;
  assert.deepEqual(rows.p0.leaked.map((entry) => entry.lpr), [1, 2]);
  assert.deepEqual(rows.p1.leaked.map((entry) => entry.lpr), [3]);
  assert.ok(rows.p0.leaked.every((entry) => entry.sourcePlayerId === 'p0'));
  assert.ok(rows.p1.leaked.every((entry) => entry.sourcePlayerId === 'p1'));
  scheduler.advance(FRAME * 2);
  assert.deepEqual(hp(match), [{ life: 8, maxLife: 10, shield: 0 }, { life: 9, maxLife: 10, shield: 0 }]);
  assert.equal(match.phase, PHASE.REWARD); assert.deepEqual(errors, []);
});

test('paired Boss timeout survivors use the same personal leak rotation exactly once', (t) => {
  const { match, scheduler, errors } = fixture(t, { count: 2, CombatClass: undefined });
  enterRoute(match); prepare(match, 'boss');
  for (const player of match.order) Object.assign(player, { life: 10, maxLife: 10, shield: player.seat + 1 });
  launch(match);
  const field = [...match.fields.values()][0], b = field.engine.battle;
  b.start();
  for (const lpr of [1, 2, 4]) {
    const enemy = b.spawnEnemy('enemy_1007_slime', { route: field.setup.routes[0] }); assert.ok(enemy); enemy.lpr = lpr;
  }
  b.forceEnd('timeout');
  assert.deepEqual(field.engine.result().perPlayer.p0.leaked.map((entry) => entry.lpr), [1, 4]);
  assert.deepEqual(field.engine.result().perPlayer.p1.leaked.map((entry) => entry.lpr), [2]);
  scheduler.advance(FRAME * 2);
  assert.deepEqual(hp(match), [{ life: 6, maxLife: 10, shield: 0 }, { life: 10, maxLife: 10, shield: 0 }]);
  const settled = hp(match); scheduler.advance(FRAME * 5); assert.deepEqual(hp(match), settled);
  assert.equal(match.phase, PHASE.REWARD); assert.deepEqual(errors, []);
});

test('a dead leader is removed from votes and preparation while survivors continue and the dead player can reconnect', (t) => {
  const { match, scheduler, frames, errors } = fixture(t, { count: 2 }); enterRoute(match); prepare(match); launch(match);
  damageLeak(match.fields.get('n:p0').engine, 'p0', 4); finish(match, scheduler);
  const dead = match.players.get('p0'), survivor = match.players.get('p1');
  assert.equal(match.ended, false); assert.equal(dead.life, 0); assert.equal(dead.alive, false); assert.equal(dead.left, false);
  assert.equal(survivor.life, 4); assert.equal(survivor.alive, true); assert.equal(match.hostId, 'p1');
  assert.equal(match.expedition.leaderId, 'p1'); assert.equal(match.expedition.partyFor('p0'), null);
  assert.deepEqual(match._active().map((player) => player.playerId), ['p1']);
  assert.deepEqual(dead.rewards, []);
  for (const message of [{ t: 'g.mizuki.reward', rewardId: 'continue' }, { t: 'g.mizuki.useItem', itemId: 'rogue_2_pill' },
    { t: 'g.mizuki.route', nodeId: 'ro2_n_1_1' }, { t: 'g.mizuki.ready', on: true }]) {
    assert.equal(match.handle('p0', message).error, 'ELIMINATED');
  }
  match.onDisconnect('p0'); const count = frames.length; match.onReconnect('p0');
  assert.equal(dead.connected, true); assert.equal(dead.life, 0); assert.equal(dead.alive, false);
  assert.ok(frames.slice(count).some((frame) => frame.playerId === 'p0' && frame.message.t === 'm.private'));
  claimRewards(match, ['p1']); skipMizukiRecruit(match, ['p1']);
  assert.equal(match.privateView('p1').mizuki.phase, PHASE.ROUTE);
  prepare(match); assert.deepEqual([...match.fields.keys()], ['n:p1']);
  command(match, 'p1', { t: 'g.mizuki.ready', on: true });
  assert.equal(match.privateView('p1').mizuki.phase, PHASE.COMBAT); assert.deepEqual(errors, []);
});

test('only exhaustion of every personal life ends the expedition and pays no survivor rewards', (t) => {
  const { match, scheduler, ended } = fixture(t, { count: 2 }); enterRoute(match); prepare(match); launch(match);
  for (const player of match.order) damageLeak(match.fields.get(player.fieldId).engine, player.playerId, 4);
  finish(match, scheduler);
  assert.equal(match.ended, true); assert.equal(match.phase, PHASE.RESULT); assert.equal(ended.length, 1);
  assert.equal(ended[0].reason, 'life_exhausted'); assert.equal(ended[0].victory, false);
  assert.ok(ended[0].players.every((player) => player.life === 0 && player.alive === false));
  assert.ok(match.order.every((player) => !player.rewards.length));
});

test('personal health checkpoint preserves different limits shields and zero-HP connected spectators', (t) => {
  const { match, scheduler } = fixture(t, { count: 2 }); enterRoute(match); prepare(match); launch(match);
  Object.assign(match.players.get('p1'), { life: 3, maxLife: 12, shield: 7 });
  damageLeak(match.fields.get('n:p0').engine, 'p0', 4); finish(match, scheduler);
  const doc = match.exportCheckpoint(); assert.equal(doc.mizuki.personalHealthVersion, 1);
  for (const key of ['life', 'maxLife', 'shield']) assert.equal(Object.hasOwn(doc.mizuki, key), false);
  const restored = fixture(t, { count: 2 }).match; assert.equal(restored.restoreCheckpoint(structuredClone(doc)), true);
  assert.deepEqual(hp(restored), hp(match)); assert.equal(restored.players.get('p0').alive, false);
  assert.equal(restored.players.get('p0').left, false); assert.equal(restored.expedition.partyFor('p0'), null);
  assert.deepEqual(restored._active().map((player) => player.playerId), ['p1']);
  for (const corrupt of [
    (bad) => { delete bad.mizuki.personalHealthVersion; bad.mizuki.life = 4; bad.mizuki.maxLife = 4; bad.mizuki.shield = 0; },
    (bad) => { bad.players[0].life = -1; },
    (bad) => { bad.players[0].alive = true; },
    (bad) => { bad.players[1].maxLife = 0; },
    (bad) => { bad.players[1].shield = -1; },
    (bad) => { bad.players[1].life = 13; },
    (bad) => { delete bad.players[1].life; },
  ]) {
    const bad = structuredClone(doc); corrupt(bad);
    assert.equal(fixture(t, { count: 2 }).match.restoreCheckpoint(bad), false);
  }
});

test('one dead Boss partner does not invalidate the surviving partner historical paired-field checkpoint', (t) => {
  const { match, scheduler } = fixture(t, { count: 2 }); enterRoute(match); prepare(match, 'boss'); launch(match);
  match.players.get('p0').life = 1;
  damageLeak(match.fields.get('b:p0:p1').engine, 'p0', 1); finish(match, scheduler);
  assert.equal(match.players.get('p0').alive, false); assert.equal(match.players.get('p1').alive, true);
  assert.equal(match.players.get('p1').fieldId, 'b:p0:p1');
  const doc = match.exportCheckpoint(), restored = fixture(t, { count: 2 }).match;
  assert.equal(restored.restoreCheckpoint(structuredClone(doc)), true);
  assert.equal(restored.privateView('p1').mizuki.phase, PHASE.REWARD); assert.deepEqual(hp(restored), hp(match));
  assert.equal(restored.expedition.partyFor('p0'), null);
  claimRewards(restored, ['p1']); skipMizukiRecruit(restored, ['p1']);
  assert.equal(restored.privateView('p1').mizuki.phase, PHASE.ROUTE);
});

test('leaving during paired Boss rotation does not bill the surviving teammate for departed-player losses', (t) => {
  const { match, scheduler, errors } = fixture(t, { count: 2, CombatClass: undefined });
  enterRoute(match); prepare(match, 'boss');
  for (const player of match.order) Object.assign(player, { life: 20, maxLife: 20, shield: 0 });
  launch(match);
  const field = [...match.fields.values()][0], b = field.engine.battle; b.start();
  const leak = (lpr) => {
    const enemy = b.spawnEnemy('enemy_1007_slime', { route: field.setup.routes[0] }); assert.ok(enemy);
    enemy.lpr = lpr; b.leak(enemy);
  };
  leak(1); match.onLeave('p0');
  const combatDoc = match.exportCheckpoint();
  assert.equal(combatDoc.players.find((player) => player.playerId === 'p0').alive, false);
  assert.equal(combatDoc.players.find((player) => player.playerId === 'p0').left, true);
  leak(2); leak(3); b.forceEnd('cleared'); scheduler.advance(FRAME * 2);
  assert.equal(match.ended, false); assert.equal(match.players.get('p1').life, 18);
  assert.equal(match.privateView('p1').mizuki.phase, PHASE.REWARD); assert.deepEqual(errors, []);
  const restored = fixture(t, { count: 2, CombatClass: undefined }).match;
  assert.equal(restored.restoreCheckpoint(structuredClone(combatDoc)), true);
  assert.equal(restored.players.get('p0').alive, false); assert.equal(restored.players.get('p0').left, true);
});

test('combat checkpoint rolls back only its branch and keeps all other players personal health', (t) => {
  const { match } = fixture(t); enterRoute(match);
  splitSolo(match);
  for (const player of match.order) Object.assign(player, { life: player.seat + 1, maxLife: player.seat + 6, shield: player.seat });
  const before = hp(match); launch(match, ['p3']);
  Object.assign(match.players.get('p3'), { life: 1, maxLife: 1, shield: 0 });
  const doc = match.exportCheckpoint();
  assert.deepEqual(doc.players.map(({ life, maxLife, shield }) => ({ life, maxLife, shield })), before);
  const restored = fixture(t).match; assert.equal(restored.restoreCheckpoint(structuredClone(doc)), true);
  assert.deepEqual(hp(restored), before); assert.equal(restored.expedition.parties.size, 2);
});

test('a committed commander upgrade survives checkpoint rollback of another branch still in combat', (t) => {
  const { match, scheduler, errors } = fixture(t); enterRoute(match); splitSolo(match); launch(match);
  const before = match.order.map(({ playerId, hope, life, maxLife }) => ({ playerId, hope, life, maxLife }));
  const solo = match.expedition.partyFor('p3'), main = match.expedition.partyFor('p0');
  match.players.get('p0').life = 1;
  match._withParty(solo, () => match._gainCommandExperience(70));
  assert.deepEqual(match.commander, { level: 4, exp: 0, totalExp: 70 });
  assert.deepEqual(match.order.map((player, i) => player.maxLife - before[i].maxLife), [1, 1, 1, 1]);
  assert.deepEqual(match.order.map((player, i) => player.hope - before[i].hope), [13, 13, 13, 13]);
  finish(match, scheduler, ['n:p3']);
  assert.equal(match.privateView('p3').mizuki.phase, PHASE.REWARD);
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.COMBAT);
  const doc = match.exportCheckpoint();
  assert.equal(new Map(doc.mizuki.partyStates).get(main.id).phase, PHASE.PREP);
  for (const previous of before) {
    const player = doc.players.find((entry) => entry.playerId === previous.playerId);
    assert.equal(player.maxLife, previous.maxLife + 1);
    assert.equal(player.hope, previous.hope + 13);
    assert.equal(player.life, previous.life);
  }
  const restored = fixture(t).match; assert.equal(restored.restoreCheckpoint(structuredClone(doc)), true);
  assert.deepEqual(restored.commander, { level: 4, exp: 10, totalExp: 80 }, 'the completed branch also grants its actual 10 battle experience');
  assert.equal(restored.privateView('p3').mizuki.phase, PHASE.REWARD);
  assert.equal(restored.privateView('p0').mizuki.phase, PHASE.PREP);
  assert.deepEqual(hp(restored), doc.players.map(({ life, maxLife, shield }) => ({ life, maxLife, shield })));
  assert.deepEqual(restored.order.map((player, i) => player.hope - before[i].hope), [13, 13, 13, 13]);
  assert.deepEqual(errors, []);
});

for (const damage of [3, 4]) test('solo branch personal damage ' + damage + ' cannot affect or block the three-player branch', (t) => {
  const { match, scheduler, errors } = fixture(t); enterRoute(match); splitSolo(match);
  const soloPartyId = match.expedition.partyFor('p3').id;
  launch(match, ['p3']); damageLeak(match.fields.get('n:p3').engine, 'p3', damage); finish(match, scheduler, ['n:p3']);
  assert.deepEqual(match.order.map((player) => player.life), [4, 4, 4, 4 - damage]);
  assert.equal(match.ended, false);
  for (const id of ['p0', 'p1', 'p2']) assert.equal(match.privateView(id).mizuki.phase, PHASE.PREP);
  if (damage === 4) {
    assert.equal(match.expedition.parties.has(soloPartyId), false);
    assert.equal(match.partyStates.has(soloPartyId), false); assert.equal(match.fields.has('n:p3'), false);
    assert.equal(match.players.get('p3').alive, false); assert.equal(match.players.get('p3').left, false);
  } else assert.equal(match.privateView('p3').mizuki.phase, PHASE.REWARD);
  launch(match, ['p0', 'p1', 'p2']);
  assert.equal(match.privateView('p0').mizuki.phase, PHASE.COMBAT); assert.deepEqual(errors, []);
});

test('a waiting floor party resumes when the sole member of the other branch loses their last personal life', (t) => {
  const { match, scheduler, errors } = fixture(t); enterRoute(match);
  const dungeon = { zones: [
    { id: 'zone_1', nodes: [
      { pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] },
      { pos: { x: 0, y: 1 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_2', next: [] },
    ] },
    { id: 'zone_2', nodes: [{ pos: { x: 0, y: 0 }, type: 'BATTLE_NORMAL', stage: 'ro2_n_1_1', next: [] }] },
  ] };
  command(match, 'p0', { t: 'g.mizuki.importDungeon', dungeon, sourceLabel: 'personal HP floor barrier schema fixture' });
  splitSolo(match); launch(match);
  finish(match, scheduler, ['n:p0', 'n:p1', 'n:p2']);
  claimRewards(match, ['p0', 'p1', 'p2']);
  skipMizukiRecruit(match, ['p0', 'p1', 'p2']);
  assert.equal(match.privateView('p0').mizuki.phase, 'MIZUKI_WAITING');
  assert.equal(match.expedition.barrier.kind, 'floor');
  const removedPartyId = match.expedition.partyFor('p3').id;
  damageLeak(match.fields.get('n:p3').engine, 'p3', 4); finish(match, scheduler, ['n:p3']);
  assert.equal(match.players.get('p3').alive, false); assert.equal(match.ended, false);
  assert.equal(match.expedition.barrier, null); assert.equal(match.expedition.parties.size, 1);
  assert.equal(match.partyStates.has(removedPartyId), false);
  for (const id of ['p0', 'p1', 'p2']) {
    assert.equal(match.privateView(id).mizuki.phase, PHASE.ROUTE);
    const state = match.partyStates.get(match.expedition.partyFor(id).id);
    assert.equal(state.explorationState.zoneKey, '1');
  }
  assert.deepEqual(errors, []);
});

test('commander capacity and command-squad recovery update each living owner within their own maximum', (t) => {
  const { match, scheduler } = fixture(t, { count: 2 }); enterRoute(match, 'rogue_2_band_1');
  assert.deepEqual(hp(match), [{ life: 6, maxLife: 6, shield: 0 }, { life: 6, maxLife: 6, shield: 0 }]);
  prepare(match); launch(match);
  Object.assign(match.players.get('p0'), { life: 2, maxLife: 6, shield: 2 });
  Object.assign(match.players.get('p1'), { life: 6, maxLife: 10, shield: 0 });
  damageLeak(match.fields.get('n:p0').engine, 'p0', 1); finish(match, scheduler);
  assert.deepEqual(hp(match), [{ life: 3, maxLife: 6, shield: 1 }, { life: 7, maxLife: 10, shield: 0 }]);
  const before = hp(match); match._gainCommandExperience(70);
  assert.deepEqual(match.order.map((player, i) => player.maxLife - before[i].maxLife), [1, 1]);
  assert.deepEqual(match.order.map((player) => player.life), [3, 7]);
});

test('shield only pays leaked objective damage and never enters life-dependent relic context', t => {
  const { match, scheduler, errors } = fixture(t, { count: 1 });
  enterRoute(match); prepare(match); launch(match);
  const player = match.players.get('p0');
  Object.assign(player, { life: 5, maxLife: 5, shield: 8 });
  const engine = match.fields.get('n:p0').engine;
  damageLeak(engine, 'p0', 3);
  engine.nativeLifeLossByPlayer.p0 = 2; engine.rows.p0.leaderLpLoss = 2;
  assert.equal(match._collectibleCombatContext().players.p0.life, 5);
  finish(match, scheduler);
  assert.equal(player.life, 3); assert.equal(player.shield, 5);
  player.life = 1;
  assert.equal(match._collectibleCombatContext().players.p0.life, 1);
  assert.equal(match._collectibleCombatContext().players.p0.maxLife, 5);
  assert.deepEqual(errors, []);
});
