import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../server/index.js';
import {RankedStore} from '../server/rankedStore.js';
import {HistoryStore} from '../server/historyStore.js';
import {PlayerStore} from '../server/playerStore.js';
import {StubMatch} from '../server/match/StubMatch.js';
import {TestClient} from './helpers/wsClient.js';

const fixture=()=>startServer({port:0,host:'127.0.0.1',quiet:true,admin:false,MatchClass:StubMatch,
  ranked:new RankedStore({file:null}),history:new HistoryStore({file:null}),players:new PlayerStore({file:null})});
async function player(srv,name){const c=await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);c.id=(await c.hello(name)).playerId;return c;}
async function list(c){const rid=c.nextRid;assert.equal((await c.request({t:'recruitment.list'})).t,'ok');return(await c.waitFor('recruitment.snapshot',m=>m.rid===rid)).rooms;}

test('recruitment is opt-in and follows live room membership, fullness, start and deletion',async()=>{
 const srv=await fixture(),clients=[];
 try{
 const h=await player(srv,'招募房主'),v=await player(srv,'大厅玩家');clients.push(h,v);
 assert.equal((await h.request({t:'room.create',mode:'coop',difficulty:'NORMAL'})).t,'ok');const room=await h.waitFor('room.state');
 assert.deepEqual(await list(v),[],'uninvited rooms stay private');
 assert.equal((await h.request({t:'chat.invite'})).t,'ok');
 const pushed=await v.waitFor('recruitment.snapshot',m=>m.rooms.some(r=>r.code===room.code));let entry=pushed.rooms[0];
 assert.equal(entry.hostName,'招募房主');assert.equal(entry.capacity,4);assert.equal(entry.occupied,1);assert.equal(entry.missing,3);assert.equal(entry.stage,null);
 assert.equal((await h.request({t:'chat.invite'})).t,'error','rate-limited invite cannot bypass chat');
 assert.equal((await v.request({t:'room.join',code:entry.code})).t,'ok');
 entry=(await v.waitFor('recruitment.snapshot',m=>m.rooms[0]?.occupied===2)).rooms[0];assert.equal(entry.missing,2);
 assert.equal((await h.request({t:'room.addBot'})).t,'ok');assert.equal((await h.request({t:'room.addBot'})).t,'ok');
 await v.waitFor('recruitment.snapshot',m=>!m.rooms.length);assert.deepEqual(await list(v),[]);
 assert.equal((await h.request({t:'room.removeBot',seat:3})).t,'ok');await v.waitFor('recruitment.snapshot',m=>m.rooms[0]?.missing===1);
 assert.equal((await v.request({t:'room.ready',ready:true})).t,'ok');assert.equal((await h.request({t:'room.start'})).t,'ok');
 assert.deepEqual(await list(v),[],'started invitation is removed');assert.equal(srv.lobby.recruitmentRooms.size,0);
 assert.ok(!JSON.stringify(pushed).match(/token|aid|loadout|secret|profileId|cardSkin/),'only public directory fields');
 }finally{await Promise.all(clients.map(c=>c.terminate()));await srv.close();}
});

test('ranked, multiplayer and cyclops invitations retain their actual room settings; delete removes listing',async()=>{
 const srv=await fixture(),clients=[];
 try{const viewer=await player(srv,'招募观察者');clients.push(viewer);
 for(const[ranked,variant,capacity]of[[true,null,4],[false,'entertainment_multi',8],[false,'entertainment_cyclops',6]]){
 const h=await player(srv,`房主${clients.length}`);clients.push(h);
 assert.equal((await h.request({t:'room.create',mode:'coop',difficulty:'HARD',ranked,...(variant?{variant,capacity}:{})})).t,'ok');const room=await h.waitFor('room.state');
 assert.equal((await h.request({t:'chat.invite'})).t,'ok');const found=(await list(viewer)).find(r=>r.code===room.code);
 assert.equal(found.ranked,ranked);assert.equal(found.variant,variant);assert.equal(found.capacity,capacity);assert.equal(found.difficulty,'HARD');assert.equal(found.missing,capacity-1);
 assert.equal((await h.request({t:'room.leave'})).t,'ok');assert.ok(!(await list(viewer)).some(r=>r.code===room.code));
 }
 }finally{await Promise.all(clients.map(c=>c.terminate()));await srv.close();}
});
