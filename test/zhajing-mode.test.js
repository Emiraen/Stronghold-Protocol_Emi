import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Match, getZhajingData } from '../server/modes/zhajing/Match.js';
import { Match as NormalMatch } from '../server/match/Match.js';
import { getData } from '../server/data.js';
import { VirtualScheduler } from '../server/modes/zhajing/engine/server/match/scheduler.js';
import { createRngFromState } from '../server/sim/rng.js';
import { snapshotMatch, restoreMatch } from '../server/match/snapshot.js';
import { buildResult } from '../server/modes/zhajing/engine/server/match/results.js';
import { applyCard, jibianCard } from '../server/modes/zhajing/engine/server/match/choices.js';
import { validateC2S } from '../shared/protocol.js';
import { ZHAJING_VARIANT } from '../shared/zhajing-constants.js';
import { store } from '../public/js/store.js';
import { benchSlot, handTile, tempTile } from '../public/js/zhajingMode.js';
import { pieceTile, tileSlot } from '../public/js/render/drag.js';
import { buildBattleSpec, createBattleFromSpec } from '../server/modes/zhajing/engine/server/sim/spec.js';
import { DataSource } from '../server/modes/zhajing/engine/server/sim/simdata.js';
import { Lobby, Room } from '../server/lobby.js';
import { roomDoc } from '../server/persist.js';
import { restoreLobbyRooms } from '../server/matchRestore.js';
import { roomServer } from '../server/regions.js';
import { zhajingOrdinaryEquipment, zhajingNeedsEquipmentSlot } from '../shared/zhajing-equipment.js';

function make({ humans = 1, ...options } = {}) {
  const scheduler = new VirtualScheduler(); const frames = [];
  const m = new Match({ scheduler, mode: humans === 1 ? 'solo' : 'coop', seed: 18345,
    seats: Array.from({ length: humans }, (_, seat) => ({ seat, playerId: 'p' + seat, name: '博士' + seat, connected: true, isBot: false })),
    send: (id, frame) => { frames.push({ id, frame }); return true; }, broadcast: frame => frames.push({ frame }),
    onEnd() {}, botRehearsal: 0, ...options });
  return { m, scheduler, frames, ps: m.order[0] };
}
function draft(f) {
  f.m.start();
  for (const p of f.m.order) assert.deepEqual(f.m.handle(p.playerId, { t: 'g.zhajing', intent: { t: 'g.infoReady' } }), { ok: true });
  f.scheduler.runUntil(() => f.m.phase === 'BAND_DRAFT', { maxSteps: 100 });
  while (f.m.phase === 'BAND_DRAFT') {
    const pid = f.m.draftTurn(); const p = f.m.players.get(pid);
    if (!pid) { f.scheduler.runNext(); continue; }
    assert.deepEqual(f.m.handle(pid, { t: 'g.band', bandId: f.m.defaultBand(p) }), { ok: true });
  }
  f.scheduler.runUntil(() => f.m.phase === 'SP_DRAFT', { maxSteps: 100 });
  assert.equal(f.m.phase, 'SP_DRAFT');
}

test('炸惊 mode is isolated from normal data, mode lists, and existing roster', t => {
  const f = make(); t.after(() => f.m.dispose());
  assert.equal(f.m.gd.zhajing, true); assert.equal(f.ps.hand.length, 20);
  assert.equal(f.m.gd.income(1), 9); assert.equal(f.m.gd.leftoverFundsKept, true);
  assert.equal(f.m.gd.bossRound, 14); assert.equal(f.m.gd.hiddenRound, 15);
  assert.equal(f.m.gd.jibian().pool.length, 99);
  assert.equal(f.m.gd.enemyJibian().pool.length, 21);
  assert.equal(getData().config.modes.mode_single_zhajing, undefined);
  const normal = new NormalMatch({ ...f.m.opts, data: getData(), modeId: 'mode_single_normal', difficulty: 'NORMAL', scheduler: new VirtualScheduler() });
  t.after(() => normal.dispose()); assert.equal(normal.order[0].hand.length, 10);
  assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'ZHAJING', variant: ZHAJING_VARIANT, capacity: 4 }), null);
  assert.ok(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'ZHAJING' }));
});

for (const humans of [1, 4]) test(`${humans} human(s): actual briefing, strategy, enemy surprise, personal reroll and pick reach PREP`, t => {
  const f = make({ humans }); t.after(() => f.m.dispose()); draft(f);
  for (const ps of f.m.order) {
    const before = ps.privateView().sp;
    assert.equal(before.cards.length, 3);
    const old = before.cards[0].id;
    assert.deepEqual(f.m.handle(ps.playerId, { t: 'g.zhajing', intent: { t: 'g.spReroll', idx: 0 } }), { ok: true });
    assert.notEqual(ps.privateView().sp.cards[0].id, old);
    assert.ok(f.m.handle(ps.playerId, { t: 'g.spReroll', idx: 0 }).error);
    assert.deepEqual(f.m.handle(ps.playerId, { t: 'g.choice', idx: 0 }), { ok: true });
    assert.ok(ps.effects.some(e => e.jibian));
  }
  f.scheduler.runUntil(() => f.m.phase === 'PREP', { maxSteps: 100 });
  assert.equal(f.m.phase, 'PREP'); assert.equal(f.m.errorCount, 0);
  assert.equal(f.m.enemyJibianCards.length, 1);
});

test('surprise effects apply to layer gains and forge effects change battle input', t => {
  const f = make(); t.after(() => f.m.dispose()); f.m.start();
  for (const [id, bond, expected] of [['jibian_xunjie', 'swiftShip', 80], ['jibian_jingzhun', 'preciShip', 160]]) {
    const spec = f.m.gd.jibian().pool.find(c => c.effectId === id);
    const old = f.ps.layers[bond] || 0; applyCard(f.m, f.ps, jibianCard(f.m.gd, spec));
    // The second card completes the source's 层数厨 combination, doubling gains.
    assert.equal(f.ps.layers[bond] - old, expected);
  }
  assert.equal(f.ps.addLayers('soloShip', 999, { requireActive: false }), 0);
  assert.equal(f.ps.layers.soloShip || 0, 0);
  f.m.phase = 'PREP'; f.ps.grantForge(1); const roll = f.ps.forgeRoll();
  const choice = roll.picks[0]; const funds = f.ps.funds;
  assert.deepEqual(f.ps.forgeTake(choice, roll.rarity), { ok: true });
  assert.equal(f.ps.forge.count, 0); assert.ok(f.ps.forge.forged[choice]);
  if (choice === 'gold') assert.ok(f.ps.funds > funds);
  else assert.ok(f.ps.battleInput().forge);
});

test('every friendly surprise card dispatches its actual acquisition effect without engine errors', t => {
  for (const spec of getZhajingData().config.modes.mode_single_zhajing.jibian.pool) {
    const f = make(); try {
      f.m.start(); f.m.phase = 'PREP'; f.m.round = 1;
      applyCard(f.m, f.ps, jibianCard(f.m.gd, spec));
      assert.equal(f.m.errorCount, 0, spec.effectId);
      assert.equal(f.m.dispatcher.errors, 0, spec.effectId);
    } finally { f.m.dispose(); }
  }
});

test('checkpoint restores personal draft, forge, own pool and enemy cards and remains interactive', t => {
  const f = make(); t.after(() => f.m.dispose()); draft(f);
  f.m.handle('p0', { t: 'g.spReroll', idx: 1 }); f.ps.grantForge(2);
  const doc = snapshotMatch(f.m); assert.ok(doc);
  const next = make(); t.after(() => next.m.dispose());
  assert.equal(restoreMatch(next.m, doc, { createRngFromState }), true);
  assert.equal(next.ps.forge.count, 2);
  assert.deepEqual(next.m.enemyJibianCards, f.m.enemyJibianCards);
  assert.deepEqual(next.ps.privateView().sp.cards, f.ps.privateView().sp.cards);
  assert.ok(next.m.handle('p0', { t: 'g.spReroll', idx: 1 }).error);
  assert.deepEqual(next.m.handle('p0', { t: 'g.choice', idx: 0 }), { ok: true });
  next.scheduler.runUntil(() => next.m.phase === 'PREP', { maxSteps: 100 });
  assert.equal(next.m.phase, 'PREP');
});

test('20 bench slots and 6 temp slots have distinct native draw and pointer coordinates; normal slots stay identical', () => {
  const before = store.get();
  try {
    store.set({ room: { variant: ZHAJING_VARIANT } });
    const used = new Set();
    for (let i = 0; i < 20; i++) {
      const tile = handTile(i); used.add(tile.row + ',' + tile.col);
      assert.deepEqual(pieceTile({ area: 'hand', idx: i }), tile);
      assert.deepEqual(tileSlot(tile), { area: 'hand', idx: i });
    }
    for (let i = 0; i < 6; i++) { const tile = tempTile(i); used.add(tile.row + ',' + tile.col); assert.deepEqual(benchSlot(tile.row, tile.col), { area: 'temp', idx: i }); }
    assert.equal(used.size, 26);
    store.set({ room: { difficulty: 'NORMAL' } });
    assert.deepEqual(pieceTile({ area: 'hand', idx: 9 }), { row: 7, col: 9 });
    assert.deepEqual(pieceTile({ area: 'temp', idx: 4 }), { row: 8, col: 8 });
  } finally { store.set(before); }
});

test('actual source battle runs to completion with source operator and surprise flags and accepts the client report', t => {
  const f = make({ clientCombat: true }); t.after(() => f.m.dispose());draft(f);
  f.m.handle('p0', {t:'g.choice',idx:0});f.scheduler.runUntil(()=>f.m.phase==='PREP',{maxSteps:100});
  const ps=f.ps;ps.funds=100;
  const idx=ps.shop.slots.findIndex(s=>s?.kind==='chess'&&!s.sold);
  assert.ok(idx>=0);assert.deepEqual(f.m.handle('p0',{t:'g.buy',slot:idx}),{ok:true});
  const unit=ps.hand.find(p=>p?.kind==='chess');assert.ok(unit);
  let placed=false;
  for(let row=9;row<=12&&!placed;row++)for(let col=2;col<=10&&!placed;col++)
    placed=!!f.m.handle('p0',{t:'g.move',uid:unit.uid,to:{area:'board',row,col}}).ok;
  assert.ok(placed);
  f.m.startCombat();const start=f.frames.findLast(x=>x.id==='p0'&&x.frame.t==='b.start')?.frame;
  assert.ok(start?.spec);assert.ok(start.spec.flags.enemyJibian.length);
  const b=createBattleFromSpec(start.spec,new DataSource(getZhajingData(),null),{recordEvents:false});b.start();
  for(let i=0;i<20000&&!b.finished;i++)b.step();
  assert.ok(b.finished);assert.equal(b.errors.length,0,JSON.stringify(b.errors));
  const result=b.result();assert.equal(validateC2S({t:'b.result',battleId:start.battleId,result}),null);
  assert.deepEqual(f.m.handle('p0',{t:'b.result',battleId:start.battleId,result}),{ok:true});
});

test('morph slot and stacked hammer slot stay separate in native equipment controls', () => {
  const defs={morph:{canGiveBond:true},a:{id:'a',stackMax:20,stackGroup:'hammer'},b:{id:'b',stackMax:20,stackGroup:'hammer'},normal:{id:'normal'}};
  const get=id=>defs[id],items=[{id:'morph',uid:1},{id:'a',uid:2},{id:'b',uid:3},{id:'normal',uid:4}];
  assert.deepEqual(zhajingOrdinaryEquipment(items,get).map(x=>x.uid),[2,4]);
  assert.equal(zhajingNeedsEquipmentSlot(defs.morph,items,get),false);
  assert.equal(zhajingNeedsEquipmentSlot(defs.a,items,get),false);
  assert.equal(zhajingNeedsEquipmentSlot(defs.normal,items,get),true);
});


test('solo and cooperative 炸惊 rooms survive lobby persistence with native content and unchanged normal modes', () => {
  for (const [mode, capacity] of [['solo', 1], ['coop', 4]]) {
    const room = new Room('ABCD', mode, 'ZHAJING', 100, false, ZHAJING_VARIANT, capacity);
    room.hostId='p0';room.seats[0]={seat:0,playerId:'p0',name:'博士',connected:true,isBot:false};
    const session={playerId:'p0',roomCode:'ABCD',name:'博士'};
    const lobby={rooms:new Map(),now:()=>200,serverId:roomServer('ABCD'),vanilla:{native:true},
      registry:{byId:()=>session,isExpired:()=>false,all:()=>[session]},releaseContent(){},startGrace(){},migrateHost(){}};
    assert.equal(restoreLobbyRooms(lobby,[roomDoc(room)],{Room}).rooms,1);
    const restored=lobby.rooms.get('ABCD');assert.equal(restored.capacity,capacity);assert.equal(restored.ranked,false);
    assert.equal(restored.variant,ZHAJING_VARIANT);assert.equal(restored.content,lobby.vanilla);
  }
});


test('real lobby creates and starts source rules while native friends, history and observer identities remain usable', async t => {
  const sessions=new Map(),frames=[],data=getData();
  const registry={byId:id=>sessions.get(id),all:()=>sessions.values(),isExpired:()=>false};
  const lobby=new Lobby({registry,getData:()=>data,now:()=>1800000000000,seedFn:()=>18345,players:{profiles:new Map()},ranked:{},history:{},
    log:{info(){},warn(){},debug(){},error(...args){throw new Error(args.map(String).join(' '));}}});
  t.after(()=>lobby.shutdown());
  const host={playerId:'p0',name:'博士',aid:'a'.repeat(32),connected:true,profileReady:true,profileBound:true,roomCode:null,
    ws:{readyState:1,bufferedAmount:0,send(raw,cb){frames.push(JSON.parse(raw));cb?.();},terminate(){}}};sessions.set('p0',host);
  assert.ok(lobby.create(host,{mode:'solo',variant:ZHAJING_VARIANT,difficulty:'ZHAJING',capacity:1}).ok);
  const room=lobby.roomOf(host);assert.ok((await lobby.start(host)).ok);assert.ok(room.match instanceof Match);
  assert.equal(room.match.matchId,room.matchCtx.matchId);
  assert.equal(room.match.publicView().variant,ZHAJING_VARIANT);assert.ok(frames.some(f=>f.t==='m.public'));
  room.match.addObserver('watcher');room.match.removeObserver('watcher');
  const result=buildResult(room.match,{victory:false,reason:'test'});assert.equal(result.variant,ZHAJING_VARIANT);assert.equal(result.ranked,false);
});
