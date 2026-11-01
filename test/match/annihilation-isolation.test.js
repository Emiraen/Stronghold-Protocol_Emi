import test from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../../server/match/Match.js';
import { GameData } from '../../server/match/gamedata.js';
import { AnnihilationGameData } from '../../server/match/annihilationGamedata.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { getData } from '../../server/data.js';
import { ANNIHILATION_VARIANT } from '../../shared/annihilation-constants.js';
import { DIFFICULTIES, PHASE, ENDLESS_VARIANT } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { relicState, pickRelic, autoPickRelic, finishRelicDrafts, grantRelic, relicModsFor } from '../../server/match/relics.js';
import { install as installBattleRelics } from '../../server/sim/content/relics.js';
import { createRng } from '../../server/sim/rng.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { Room } from '../../server/lobby.js';
import { roomDoc } from '../../server/persist.js';
import { restoreLobbyRooms } from '../../server/matchRestore.js';
import { roomServer } from '../../server/regions.js';
import { generateDraft } from '../../server/match/choices.js';

const data = getData({ log: { warn() {}, error() {} } });
function make({ variant = ANNIHILATION_VARIANT, erosion = 2, mode = 'coop', humans = 2, bots = 0, difficulty, ranked = false } = {}) {
  const seats = Array.from({ length: humans + bots }, (_, seat) => ({ seat, playerId: seat < humans ? `p${seat}` : `ai_${seat}`, name: `P${seat}`, connected: true, isBot: seat >= humans }));
  const m = new Match({ roomCode: 'TEST', seed: 17, matchId: 'ann-isolation', mode, variant, erosion,
    difficulty: difficulty || (variant === ANNIHILATION_VARIANT ? 'ANNIHILATION' : 'NORMAL'), ranked, data, seats,
    scheduler: new VirtualScheduler(), botRehearsal: 0, send() { return true; }, broadcast() {}, onEnd() {},
    log: { warn() {}, error() {}, info() {}, debug() {} } });
  return m;
}
function prep(m, round = 1) { m.startRound(round); m.setDeadline(0); m.enterPrep(); return m; }

test('annihilation remains an isolated entertainment mode; ordinary difficulty list stays unchanged', () => {
  assert.deepEqual(DIFFICULTIES, ['FUNNY', 'NORMAL', 'HARD', 'ABYSS']);
  const ordinary = make({ variant: null, ranked: true, difficulty: 'HARD' });
  const modes = [ordinary, make({ variant: 'entertainment_multi' }), make({ variant: 'entertainment_cyclops' }), make({ variant: ENDLESS_VARIANT })];
  const ann = make();
  try {
    assert.ok(ann.gd instanceof AnnihilationGameData);
    assert.equal(ann.ranked, false);
    assert.equal(ann.modeId, 'mode_multi_annihilation');
    assert.notEqual(ann.registry, ordinary.registry);
    for (const m of modes) {
      assert.equal(m.isAnnihilation, false);
      assert.ok(m.gd instanceof GameData);
      assert.equal(Object.hasOwn(m, 'settle'), false);
      assert.equal(m.order.some(p => Object.hasOwn(p, 'relics')), false);
    }
    assert.equal(ordinary.ranked, true);
    assert.equal(ordinary.registry._h.has('global:annihilation_relics'), false);
    assert.ok(ann.registry._h.has('global:annihilation_relics'));
  } finally { for (const m of [...modes, ann]) m.dispose(); }
});

test('all six erosion levels build normal and boss battle specs without changing ordinary data', () => {
  for (let erosion = 1; erosion <= 6; erosion++) {
    const m = make({ erosion, humans: 1 });
    try {
      prep(m);
      const opts = m._normalOpts(m.order[0]);
      assert.equal(opts.modeId, 'mode_multi_annihilation');
      assert.equal(opts.flags.chaosTargeting, true);
      assert.ok(opts.flags.terrainLethal > 1);
      assert.equal(!!opts.flags.fog, erosion !== 6);
      assert.equal(m.isEndless, erosion === 6);
      assert.equal(m.gd.equipPerChess, erosion === 6 ? Infinity : 2);
      assert.equal(!!m.order[0].relics?.draft, erosion >= 2);
      const b = m.newBattle({ ...opts, recordEvents: false });
      b.start();
      assert.equal(b.errors?.length || 0, 0);
      m.startRound(14);
      if (erosion >= 3) assert.ok(m.bossWaves?.length);
      assert.deepEqual(m.errors, []);
    } finally { m.dispose(); }
  }
});

test('endless annihilation keeps boss/hidden cadence beyond the materialised schedule', () => {
  const gd = new AnnihilationGameData(data, 'mode_multi_annihilation', { erosion: 6 });
  for (const boss of [33, 600, 603, 9999]) {
    assert.equal(gd.isBossRound(boss), true);
    assert.equal(gd.isHiddenRound(boss + 1), true);
    assert.equal(gd.hiddenAfter(boss), boss + 1);
    assert.equal(gd.nextBossRound(boss + 1), boss + 3);
    assert.deepEqual(gd.pairOfRound(boss), { boss, hidden: boss + 1 });
    assert.deepEqual(gd.pairOfRound(boss + 1), { boss, hidden: boss + 1 });
    assert.deepEqual(gd.pairOfRound(boss + 2), { boss: boss + 3, hidden: boss + 4 });
    assert.equal(gd.roundCfg(boss).isBoss, true);
    assert.equal(gd.roundCfg(boss + 1).isHidden, true);
    assert.equal(gd.roundCfg(boss + 2).isBoss, false);
  }
  assert.equal(gd.isHiddenRound(31), false);
  assert.deepEqual(gd.pairOfRound(31), { boss: 33, hidden: 34 });
  assert.equal(gd.isLastHidden(10000), false);
  const finite = new AnnihilationGameData(data, 'mode_multi_annihilation', { erosion: 5 });
  assert.equal(finite.isBossRound(33), false);
  assert.equal(finite.nextBossRound(30), null);
  assert.deepEqual(finite.pairOfRound(31), { boss: 29, hidden: 30 });
});

test('team bot auto-pick never resolves or replaces a human vote; deadline finishes queued drafts', () => {
  const m = prep(make({ humans: 2, bots: 1 }));
  try {
    const draft = m.relicTeam.draft;
    autoPickRelic(m, m.order[2]);
    assert.equal(m.relicTeam.draft, draft);
    assert.equal(m.relicTeam.votes.p0, undefined);
    assert.equal(m.relicTeam.votes.p1, undefined);
    finishRelicDrafts(m);
    assert.equal(m.relicTeam.draft, null);
    assert.equal(m.relicTeam.queue.length, 0);
    for (const ps of m.order) assert.equal(relicState(ps).draft, null);
    assert.ok(relicState(m.order[0]).owned.length >= 2);
    assert.deepEqual(relicState(m.order[0]).owned, relicState(m.order[1]).owned);
  } finally { m.dispose(); }
});

test('annihilation checkpoint restores shared draft identity, votes and erosion without duplicate grants', () => {
  const m = prep(make());
  let restored;
  try {
    const draft = m.relicTeam.draft;
    assert.ok(pickRelic(m, m.order[0], 0).ok);
    const doc = snapshotMatch(m);
    assert.ok(doc?.annihilation);
    restored = make();
    assert.equal(restoreMatch(restored, doc, { createRngFromState }), true);
    assert.equal(restored.phase, PHASE.PREP);
    assert.equal(restored.relicTeam.draft.id, draft.id);
    assert.equal(restored.relicTeam.votes.p0, 0);
    for (const ps of restored.order) assert.equal(relicState(ps).draft, restored.relicTeam.draft);
    assert.ok(pickRelic(restored, restored.order[1], 0).ok);
    finishRelicDrafts(restored);
    assert.equal(new Set(relicState(restored.order[0]).owned).size, relicState(restored.order[0]).owned.length);
    assert.deepEqual(restored.errors, []);
  } finally { m.dispose(); restored?.dispose(); }
});

test('solo annihilation has no team vote and ordinary checkpoints have no relic envelope', () => {
  const ann = prep(make({ mode: 'solo', humans: 1 }));
  const ordinary = prep(make({ variant: null, humans: 1 }));
  try {
    assert.equal(ann.modeId, 'mode_single_annihilation');
    assert.equal(ann.relicTeam, undefined);
    assert.ok(relicState(ann.order[0]).owned.length);
    finishRelicDrafts(ann);
    assert.equal(relicState(ann.order[0]).draft, null);
    const doc = snapshotMatch(ordinary);
    assert.equal(Object.hasOwn(doc, 'annihilation'), false);
    assert.equal(Object.hasOwn(doc.players[0], 'annihilation'), false);
  } finally { ann.dispose(); ordinary.dispose(); }
});

test('annihilation room persistence keeps solo capacity, erosion and non-ranked isolation', () => {
  const room = new Room('ABCD', 'solo', 'ANNIHILATION', 100, false, ANNIHILATION_VARIANT, 1);
  room.erosion = 6; room.hostId = 'p0';
  room.seats[0] = { seat: 0, playerId: 'p0', name: 'P0', connected: true, isBot: false };
  const doc = roomDoc(room);
  const session = { playerId: 'p0', roomCode: 'ABCD', name: 'P0' };
  const lobby = { rooms: new Map(), now: () => 200, serverId: roomServer('ABCD'), vanilla: {},
    registry: { byId: id => id === 'p0' ? session : null, isExpired: () => false, all: () => [session] },
    releaseContent() {}, startGrace() {}, migrateHost(r) { r.hostId = 'p0'; } };
  const stats = restoreLobbyRooms(lobby, [doc], { Room });
  assert.equal(stats.rooms, 1);
  assert.equal(lobby.rooms.get('ABCD').erosion, 6);
  assert.equal(lobby.rooms.get('ABCD').capacity, 1);
  assert.equal(lobby.rooms.get('ABCD').ranked, false);
});

test('wire protocol accepts annihilation actions and keeps ordinary create messages valid', () => {
  const msgs = [
    { t: 'room.create', mode: 'coop', difficulty: 'ANNIHILATION', variant: ANNIHILATION_VARIANT, capacity: 4, erosion: 6, ranked: false },
    { t: 'room.create', mode: 'solo', difficulty: 'NORMAL', ranked: false },
    { t: 'g.relic', idx: 1 }, { t: 'g.relic', start: true }, { t: 'g.relicSeen' },
  ];
  for (const msg of msgs) assert.equal(validateC2S(msg), null, JSON.stringify(msg));
});

test('annihilation normal settlement applies its relic reward exactly once', () => {
  const m = prep(make({ mode: 'solo', humans: 1, erosion: 1 }));
  try {
    const ps = m.order[0];
    ps.lp = m.gd.defaultStartLp;
    grantRelic(m, ps, 'p07');
    const before = ps.pendingFunds;
    m.lastResults.set(ps.playerId, { leaked: [], perfect: true, coins: 0, killed: 0, damageDealt: 0, layerGains: {} });
    m.settle(null, null);
    assert.equal(ps.pendingFunds, before + 1);
    m.settle(null, null);
    assert.equal(ps.pendingFunds, before + 1);
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('annihilation hidden defeat stays defeat while ordinary hidden rules remain untouched', () => {
  const m = make({ humans: 1 });
  let outcome;
  try {
    m.hiddenReached = true;
    m.onEndFn = value => { outcome = value; };
    m.finish({ victory: false, reason: 'defeat' });
    assert.equal(m.outcome.victory, false);
    assert.equal(m.outcome.reason, 'defeat');
    assert.equal(m.outcome.hiddenReached, true);
    assert.ok(outcome || m.ended);
  } finally { m.dispose(); }
});

test('relic hand shrink keeps tail pieces in retained hand or temp and never calls a missing API', () => {
  const m = prep(make({ mode: 'solo', humans: 1, erosion: 1 }));
  try {
    const ps = m.order[0];
    const oldSize = ps.hand.length;
    const itemIds = Object.keys(data.items);
    const pieces = Array.from({ length: oldSize }, (_, i) => ps.newPiece('item', itemIds[i % itemIds.length]));
    ps.hand = pieces.slice();
    grantRelic(m, ps, 'n21');
    assert.equal(ps.hand.length, oldSize - 4);
    assert.deepEqual([...ps.hand, ...ps.temp].filter(Boolean).map(p => p.uid).sort((a, b) => a - b), pieces.map(p => p.uid));
    ps.temp = Array.from({ length: ps.gd.tempSize }, () => ps.newPiece('item', itemIds[0]));
    ps.hand = Array.from({ length: oldSize }, () => ps.newPiece('item', itemIds[0]));
    relicState(ps).owned = [];
    assert.doesNotThrow(() => grantRelic(m, ps, 'n21'));
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('removing temp returns discarded operator copies and preserves pieces when hand has space', () => {
  const m = prep(make({ mode: 'solo', humans: 1, erosion: 1 }));
  try {
    const ps = m.order[0];
    const baseId = [...ps.pool.entries.keys()][0];
    const before = ps.pool.left(baseId);
    const taken = ps.pool.take(baseId, 1);
    const piece = ps.newPiece('chess', baseId, { poolCopies: taken });
    ps.temp[0] = piece;
    grantRelic(m, ps, 'n23');
    assert.equal(ps.temp.length, 0);
    assert.equal(ps.hand.includes(piece), true);
    assert.equal(ps.pool.left(baseId), before - taken);
    assert.equal(ps.stow(ps.newPiece('item', Object.keys(data.items)[0]), { toTemp: true }), null);
  } finally { m.dispose(); }
});

test('relic item surcharges and king crystal income/discount match their own data', () => {
  const m = prep(make({ mode: 'solo', humans: 1, erosion: 1 }));
  try {
    const ps = m.order[0];
    grantRelic(m, ps, 'n28');
    assert.equal(ps.priceOf({ kind: 'item', id: Object.keys(data.items)[0], basePrice: 4 }), 5);
    grantRelic(m, ps, 'p04');
    assert.equal(ps.priceOf({ kind: 'item', id: Object.keys(data.items)[0], basePrice: 4 }), 4);
    grantRelic(m, ps, 'p21');
    const ev = { income: 0, pending: 0 };
    m.dispatch(ps, 'onIncome', ev);
    assert.equal(ev.income, 7);
    const id = m.gd.visibleChess.find(id => m.gd.tierOf(id) < 5);
    assert.equal(ps.priceOf({ kind: 'chess', id, basePrice: 4 }), 3);
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('autoplay humans retain shared relics and disconnect migrates the draw to a connected human', () => {
  const m = make();
  try {
    m.order[0].autoplay = true;
    prep(m);
    finishRelicDrafts(m);
    assert.ok(relicState(m.order[0]).owned.length);
    assert.deepEqual(relicState(m.order[0]).owned, relicState(m.order[1]).owned);
    m.order[0].autoplay = false;
    m.hostId = 'p0';
    m.onDisconnect('p0');
    assert.equal(m.hostId, 'p1');
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('team relic battle effects apply enemy buffs once and keep general and boss modifiers', () => {
  const handlers = new Map(), buffs = [];
  const mods = { enemy: { hp: 0.3 }, enemyBoss: { atk: 0.2 }, rules: { spInit: -10 } };
  const unit = { uid: 1, kind: 'op', ownerId: 'p0', alive: true, deployed: true, skill: { sp: 50 } };
  const battle = {
    players: ['p0', 'p1'].map(playerId => ({ playerId, input: { relicMods: mods } })),
    allyUnits: [unit], rng: createRng(1),
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    every() {}, addBuff(target, buff) { buffs.push({ target, ...buff }); },
  };
  installBattleRelics(battle);
  const emit = (name, ev) => { for (const fn of handlers.get(name) || []) fn(ev); };
  emit('deploy', { unit });
  emit('battleStart', {});
  assert.equal(unit.skill.sp, 40);
  const enemy = { alive: true, side: 'enemy', def: { rank: 'BOSS' } };
  emit('enemySpawn', { enemy });
  assert.equal(buffs.filter(b => b.mods.hpMul === 1.3).length, 1);
  assert.equal(buffs.filter(b => b.mods.atkMul === 1.2).length, 1);
  assert.equal(new Set(buffs.map(b => b.key)).size, buffs.length);
});

test('on-field elite relic can build battle modifiers without a missing counter function', () => {
  const m = prep(make({ mode: 'solo', humans: 1, erosion: 1 }));
  try {
    const ps = m.order[0];
    grantRelic(m, ps, 'p35');
    assert.doesNotThrow(() => relicModsFor(ps));
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('consumable relics refund only the real purchase price after successful use and cap gifts at three', () => {
  const m = prep(make({ mode: 'solo', humans: 1, erosion: 1 }));
  try {
    const ps = m.order[0], id = 'chess_item_2_07_e_a';
    const chess = ps.acquireChess(m.gd.visibleChess.find(id => !m.gd.isGolden(id)));
    grantRelic(m, ps, 'p43'); grantRelic(m, ps, 'p44');
    ps.funds = 100;
    ps.shop.slots = [{ kind: 'item', id, basePrice: 4, sold: false }];
    const price = ps.priceOf(ps.shop.slots[0]);
    assert.equal(ps.buy(0).error, undefined);
    const bought = ps._itemLocations(id)[0].piece;
    assert.equal(bought.meta.annihilationPaid, price);
    assert.ok(ps.equip(bought.uid, -1).error);
    assert.equal(ps.funds, 100 - price);
    assert.equal(relicState(ps).counters.refundRound || 0, 0);
    assert.equal(ps.equip(bought.uid, chess.uid).error, undefined);
    assert.equal(ps.funds, 100);
    assert.equal(relicState(ps).counters.refundRound, 1);
    for (let i = 0; i < 4; i++) {
      const free = ps.newPiece('item', id); ps.stow(free);
      assert.equal(ps.equip(free.uid, chess.uid).error, undefined);
    }
    assert.equal(ps.funds, 100);
    assert.equal(relicState(ps).counters.refundRound, 3);
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('consumable purchase provenance survives item merge and checkpoint restore', () => {
  const m = prep(make({ mode: 'solo', humans: 1, erosion: 1 }));
  let restored;
  try {
    const ps = m.order[0], id = 'chess_item_1_03_e_a';
    ps.funds = 100;
    for (const price of [3, 5]) {
      ps.shop.slots = [{ kind: 'item', id, basePrice: price, sold: false }];
      assert.equal(ps.buy(0).error, undefined);
    }
    const piece = [...ps.hand, ...ps.temp].find(p => p?.kind === 'item' && m.gd.item(p.id)?.isGolden);
    assert.ok(piece); assert.equal(piece.meta.annihilationPaid, 8);
    const doc = snapshotMatch(m);
    restored = make({ mode: 'solo', humans: 1, erosion: 1 });
    assert.equal(restoreMatch(restored, doc, { createRngFromState }), true);
    assert.equal(restored.order[0].find(piece.uid).piece.meta.annihilationPaid, 8);
    assert.deepEqual(m.errors, []); assert.deepEqual(restored.errors, []);
  } finally { m.dispose(); restored?.dispose(); }
});

test('delayed projection refunds when consumed next round, not when equipped', () => {
  const m = prep(make({ mode: 'solo', humans: 1, erosion: 1 }));
  try {
    const ps = m.order[0];
    const id = Object.keys(data.items).find(id => data.items[id].kind === 'consume_on_equip_or_delayed' && !data.items[id].isGolden);
    assert.ok(id);
    const chess = ps.acquireChess(m.gd.visibleChess.find(id => !m.gd.isGolden(id)));
    grantRelic(m, ps, 'p44'); ps.funds = 100;
    ps.shop.slots = [{ kind: 'item', id, basePrice: 6, sold: false }];
    assert.equal(ps.buy(0).error, undefined);
    const item = ps._itemLocations(id)[0].piece;
    assert.equal(ps.equip(item.uid, chess.uid).error, undefined);
    assert.equal(ps.funds, 94);
    assert.equal(ps.find(item.uid).area, 'equipped');
    m.dispatch(ps, 'onRoundStart', { round: 2 });
    assert.equal(ps.find(item.uid), null);
    assert.equal(ps.funds, 100);
    m.dispatch(ps, 'onRoundStart', { round: 2 });
    assert.equal(ps.funds, 100);
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('purchase-only elite relic ignores grant merges and counts shop promotions', () => {
  const m = prep(make({ mode: 'solo', humans: 1, erosion: 1 }));
  try {
    const ps = m.order[0];
    const id = m.gd.visibleChess.find(id => !m.gd.isGolden(id) && m.gd.tierOf(id) >= 4 && m.gd.goldenIdOf(id));
    grantRelic(m, ps, 'p36');
    for (let i = 0; i < m.gd.mergeCount(id); i++) ps.acquireChess(id, { source: 'grant' });
    assert.equal(relicState(ps).counters.eliteMerges || 0, 0);
    for (let i = 0; i < m.gd.mergeCount(id) - 1; i++) ps.acquireChess(id, { source: 'grant' });
    ps.funds = 100; ps.shop.slots = [{ kind: 'chess', id, basePrice: 1, sold: false }];
    assert.equal(ps.buy(0).error, undefined);
    assert.equal(relicState(ps).counters.eliteMerges, 1);
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('a departing voter cannot leave the remaining solo ballot locked indefinitely', () => {
  const m = prep(make({ humans: 2, bots: 1 }));
  try {
    const draft = m.relicTeam.draft;
    assert.equal(pickRelic(m, m.order[0], 0).error, undefined);
    m.onLeave('p1');
    assert.notEqual(m.relicTeam.draft, draft);
    assert.notEqual(relicState(m.order[2]).draft, draft);
    assert.ok(relicState(m.order[0]).owned.includes(draft.cards[0]));
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('hidden leader pool uses current prep LP and endless flags remain consistent', () => {
  const m = make({ erosion: 6, humans: 2 });
  try {
    m.startRound(34); m.setDeadline(0);
    m.order[0].lp = 17; m.order[1].lp = 23; m.teamLp = 90;
    m.clientCombat = true;
    m._startFinalClient = () => {};
    m.startFinalAssault(true);
    assert.equal(m.teamLp, 40);
    assert.deepEqual(m.order.map(ps => ps.lpAtFinal), [17, 23]);
    for (const field of m.fields) assert.equal(field.opts.flags.uncappedBondLayers, true);
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('choice, bounty, income drains and acquisition-based growth use completed events', () => {
  const m = prep(make({ mode: 'solo', humans: 1, erosion: 2 }));
  try {
    finishRelicDrafts(m); const ps = m.order[0], st = relicState(ps);
    st.owned = [];
    grantRelic(m, ps, 'p28'); const before = ps.funds;
    m.dispatch(ps, 'onChoicePick', {});
    assert.equal(ps.funds, before + 8);
    grantRelic(m, ps, 'p34');
    m.dispatch(ps, 'onBattleResult', { result: { bountyKills: 1 }, perfect: true, uniteResults: [{ perPlayer: { p0: { bountyKills: 2 } } }, { perPlayer: { p0: { bountyKills: 3 } } }] });
    assert.equal(st.counters.atkRoundStacks, 1); // the round-start stack is applied at the next start, not twice at settle
    assert.equal(st.counters.bountyDone, 6);
    grantRelic(m, ps, 'n38'); m.round = 10;
    ps.funds = 0; st.flags.fundsDrainLeft = 1;
    ps.startRound(10);
    assert.equal(st.flags.fundsDrainLeft, 0);
    assert.equal(st.counters.probeStacks, 4);
    assert.equal(st.counters.atkRoundStacks, 2);
    assert.deepEqual(m.errors, []);
  } finally { m.dispose(); }
});

test('v3.2 shared relics apply their life and combat effects to AI teammates', () => {
  const m=prep(make({humans:1,bots:3}));
  try {
    finishRelicDrafts(m);
    const owned=relicState(m.order[0]).owned;
    for(const ps of m.order) assert.deepEqual(relicState(ps).owned,owned);
    // Drive the actual shared selection with a known life-granting card.
    const draft={id:'life-draft',cards:['p05'],kind:'positive',team:true};
    m.relicTeam.draft=draft;m.relicTeam.votes={};m.order[0].relics.draft=draft;
    const before=m.order.map(p=>p.lp);pickRelic(m,m.order[0],0);
    for(let i=0;i<m.order.length;i++) {
      assert.ok(relicState(m.order[i]).owned.includes('p05'));
      if(!owned.includes('p05'))assert.ok(m.order[i].lp>before[i]);
      if(m.order[i].isBot)assert.ok(!m.order[i].pendingRelicToast);
    }
  } finally {m.dispose();}
});

test('v3.2 first-chess surcharges survive repeated quotes and item purchases and expire only on chess buys', () => {
  const m=prep(make({mode:'solo',humans:1,erosion:1}));
  try {
    const ps=m.order[0],st=relicState(ps);st.owned=[];grantRelic(m,ps,'n13');grantRelic(m,ps,'n14');ps.funds=100;
    const id=m.gd.visibleChess.find(id=>m.gd.tierOf(id)===1&&!m.gd.isGolden(id));
    const item=Object.values(data.items).find(r=>r.itemType==='EQUIP'&&!r.isGolden);
    const slot={kind:'chess',id,basePrice:4,sold:false};
    const quoted=ps.priceOf(slot);for(let i=0;i<8;i++)assert.equal(ps.priceOf(slot),quoted);
    ps.shop.slots=[{kind:'item',id:item.id,basePrice:1,sold:false}];assert.ok(ps.buy(0).ok);
    assert.equal(ps.priceOf(slot),quoted);
    ps.shop.slots=[{...slot}];assert.ok(ps.buy(0).ok);assert.equal(ps.priceOf(slot),quoted-2);
    for(let i=0;i<2;i++){ps.shop.slots=[{...slot}];assert.ok(ps.buy(0).ok);}
    assert.equal(ps.priceOf(slot),quoted-3);
    assert.equal(st.counters.chessBuys,3);
  } finally {m.dispose();}
});

test('v3.2 decisions always offer bounties and survivor stacks exclude leader results', () => {
  const m=prep(make({mode:'solo',humans:1,erosion:2}));
  try {
    for(const round of [2,4,6,8,12,20])assert.equal(generateDraft(m.gd,createRng(round),round).family,'bounty');
    const ps=m.order[0];grantRelic(m,ps,'p12');const st=relicState(ps);
    m.dispatch(ps,'onBattleResult',{result:{},boss:true});assert.equal(st.counters.survivorStacks||0,0);
    m.dispatch(ps,'onBattleResult',{result:{},unite:{perPlayer:{p0:{}}}});assert.equal(st.counters.survivorStacks,1);
  } finally {m.dispose();}
});

test('v3.2 opening stun picks once and a redeployment stuns only the returning operator', () => {
  const handlers=new Map(),timers=[],applied=[];
  const units=Array.from({length:6},(_,i)=>({uid:i+1,kind:'op',ownerId:'p0',alive:true,deployed:true,deploySeq:i+1,s:{flags:{}}}));
  const battle={round:1,players:[{playerId:'p0',input:{relicMods:{rules:{stunOnDeploy:{count:1,dur:10,redeployDur:5}}}}}],allyUnits:units,rng:createRng(4),
    on(name,fn){if(!handlers.has(name))handlers.set(name,[]);handlers.get(name).push(fn);},every(){},after(t,fn){timers.push(fn);},
    applyStatus(u,status,opts){applied.push({uid:u.uid,status,...opts});},addBuff(){}};
  installBattleRelics(battle);const emit=(name,ev)=>{for(const fn of handlers.get(name)||[])fn(ev);};
  for(const unit of units)emit('deploy',{unit,initial:true});
  for(const fn of timers.splice(0))fn();assert.equal(applied.length,1);assert.equal(applied[0].duration,10);
  emit('deploy',{unit:units[5],initial:false});for(const fn of timers.splice(0))fn();
  assert.equal(applied.length,2);assert.deepEqual(applied[1],{uid:6,status:'stun',duration:5});
});


test('v3.2 stalled AI prep yields after two seconds only while all humans remain ready', () => {
  const m=prep(make({humans:1,bots:1}));
  try {
    finishRelicDrafts(m);for(const ps of m.order){ps.pendingRelicToast=null;ps.pendingRewards=[];ps.choice=null;ps.ready=false;}
    for(const timer of [...m._timers])m.cancel(timer);m._annBotReadyFallback=null;
    let started=0;m.startCombat=()=>{started++;m.phase='COMBAT';};
    m.order[0].ready=true;m.maybeEndPrep();m.sched.advance(1999);assert.equal(started,0);
    m.sched.advance(2);assert.equal(m.order[1].ready,true);assert.equal(started,1);
  } finally {m.dispose();}
});
