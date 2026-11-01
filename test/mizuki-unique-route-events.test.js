import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiMatch } from '../server/modes/mizuki/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { getData } from '../server/data.js';
import { normalizeCognition } from '../server/modes/mizuki/Cognition.js';
import { generateMizukiDungeon } from '../server/modes/mizuki/RouteGeneration.js';
import { createMizukiRouteEvent, createMizukiRouteEventLedger, MIZUKI_UNIQUE_ROUTE_EVENTS, validMizukiRouteEventLedger } from '../server/modes/mizuki/RouteEvents.js';
import { skipMizukiRecruit } from './helpers/mizukiRecruit.js';
import { normalizeMizukiDungeon } from '../server/modes/mizuki/exploration.js';
const DATA=getData({log:{info(){},warn(){},error(){}}});
const ALL=['ro2_ending_1','ro2_ending_2','ro2_ending_3','ro2_ending_4'];
const dungeon={zones:{first:{id:'zone_1',nodes:[
 ...[0,1].map(y=>({pos:{x:0,y},type:'MISSION',next:[{x:1,y}]})),
 ...[0,1].map(y=>({pos:{x:1,y},type:'MISSION',next:[{x:2,y:0}]})),
 {pos:{x:2,y:0},type:'BATTLE_NORMAL',stage:'ro2_n_1_1',next:[]} ]}}};
function fixture(t,count=2,map=dungeon,seed=619){
 const scheduler=new VirtualScheduler(),errors=[], options={roomCode:'UNIQ',seed,hostId:'p0',data:DATA,scheduler,cognition:normalizeCognition({totalScore:22400}),endingUnlocks:ALL,seats:Array.from({length:count},(_,seat)=>({playerId:'p'+seat,seat,connected:true})),dungeon:structuredClone(map),send(){},broadcast(){},onEnd(){},log:{info(){},warn(){},error:(...args)=>errors.push(args)}};
 const match=new MizukiMatch(options);t.after(()=>{match.dispose();scheduler.dispose();assert.deepEqual(errors,[])});return {match,options};
}
function command(match,id,message){const result=match.handle(id,message);assert.equal(result.ok,true,JSON.stringify({id,message,result}));return result;}
function start(match){match.start();for(const p of match.order)command(match,p.playerId,{t:'g.mizuki.squad',squadId:'rogue_2_band_1'});for(const p of match.order)command(match,p.playerId,{t:'g.mizuki.strategy',bandId:p.playerId==='p0'?'band_amiya':'band_cathy'});for(const p of match.order)command(match,p.playerId,{t:'g.mizuki.initialSupply',choiceId:'choice_ro2_startbuff_3'});for(const p of match.order)command(match,p.playerId,{t:'g.mizuki.recruitGroup',groupId:'recruit_group_1'});skipMizukiRecruit(match);}
function restore(t,options,doc){const scheduler=new VirtualScheduler(),match=new MizukiMatch({...options,scheduler});t.after(()=>{match.dispose();scheduler.dispose()});assert.equal(match.restoreCheckpoint(structuredClone(doc)),true);return match;}

test('generated route reserves at most one regional commission across all five floors',t=>{
 const {match}=fixture(t,1);let seen=0;
 for(let seed=1;seed<=100;seed++){
  const map=generateMizukiDungeon({seed,stageOptions:match.stageOptions,cognition:match.cognitionMods});
  const nodes=Object.values(map.zones).flatMap(zone=>zone.nodes).filter(node=>node.type==='MISSION');
  assert.ok(nodes.length<=1,'seed '+seed+' generated duplicate commission entrances');seen+=nodes.length;
 }
 assert.ok(seen>0,'regional commission remains in the native generation pool');
});

test('same-floor parallel mission candidates reserve one shared entrance before either party enters',t=>{
 const {match:m,options}=fixture(t);start(m);
 const ledger=structuredClone(m.floorState.eventLedger),routes=m.privateView('p0').mizuki.route;
 assert.equal(routes.filter(node=>node.graphType==='MISSION').length,1);
 assert.equal(routes.filter(node=>node.graphType==='INCIDENT').length,1);
 assert.equal(Object.values(ledger.nodes).filter(key=>key==='prts_ro2_event_53').length,1);
 assert.equal(validMizukiRouteEventLedger(ledger),true);
 const mission=routes.find(node=>node.graphType==='MISSION'),other=routes.find(node=>node.graphType==='INCIDENT');
 const split=command(m,'p1',{t:'g.mizuki.splitRequest',nodeId:other.id});command(m,'p0',{t:'g.mizuki.splitDecide',requestId:split.request.id,approve:true});
 command(m,'p0',{t:'g.mizuki.route',nodeId:mission.id});command(m,'p1',{t:'g.mizuki.route',nodeId:other.id});command(m,'p0',{t:'g.mizuki.routeStart'});
 assert.equal(m.privateView('p0').mizuki.event.state.eventKey,'prts_ro2_event_53');
 assert.notEqual(m.privateView('p1').mizuki.event.state.eventKey,'prts_ro2_event_53');
 assert.equal(m._explorationView(m.partyStates.get(m.expedition.partyFor('p1').id).explorationState).nodes.filter(node=>node.type==='MISSION').length,1);
 const doc=m.exportCheckpoint(),loaded=restore(t,options,doc);assert.deepEqual(loaded.floorState.eventLedger,m.floorState.eventLedger);
 const oldOpen=structuredClone(doc);delete oldOpen.mizuki.floorState.eventLedger;
 const currentScene=structuredClone(oldOpen.mizuki.event.state),migratedOpen=restore(t,options,oldOpen);
 assert.deepEqual(migratedOpen.event.state,currentScene,'migration cannot replace an active commission scene or its pending choices');
 const event=loaded.privateView('p0').mizuki.event,task=event.choices.find(choice=>choice.taskId&&choice.available);assert.ok(task);
 command(loaded,'p0',{t:'g.mizuki.event',choiceId:task.id});assert.equal(loaded.routeMissions.missions.length,1);
 assert.equal(loaded._acceptRouteMission('rogue_2_task_004'),null);assert.equal(loaded.routeMissions.missions.length,1);
 const accepted=structuredClone(loaded.routeMissions);const again=restore(t,options,loaded.exportCheckpoint());assert.deepEqual(again.routeMissions,accepted);
 assert.equal(Object.values(again.floorState.eventLedger.nodes).filter(key=>key==='prts_ro2_event_53').length,1);
 const legacy=loaded.exportCheckpoint();delete legacy.mizuki.floorState.eventLedger;
 const migrated=restore(t,options,legacy);assert.deepEqual(migrated.routeMissions,accepted,'legacy migration keeps the actual accepted mission unchanged');
 assert.equal(migrated.floorState.eventLedger.claims.prts_ro2_event_53.nodeId,accepted.missions[0].nodeId);
 for(const state of migrated.partyStates.values())if(state.phase==='MIZUKI_ROUTE')
   assert.equal(state.route.some(node=>node.graphType==='MISSION'&&node.id!==accepted.missions[0].nodeId),false);
});

test('floor and hidden-region graph keys cannot collide at identical native coordinates',()=>{
 const nodes=()=>[{pos:{x:0,y:0},type:'INCIDENT',next:[]}];
 const map={zones:{first:{id:'zone_1',nodes:nodes()},second:{id:'zone_2',nodes:nodes()},
   portal_first_a:{id:'zone_7',zoneType:'SP',returnZoneKey:'first',nodes:nodes()},
   portal_first_b:{id:'zone_7',zoneType:'SP',returnZoneKey:'first',nodes:nodes()}}};
 const ids=normalizeMizukiDungeon(map).floors.flatMap(floor=>floor.nodes.map(node=>node.id));
 assert.equal(ids.length,4);assert.equal(new Set(ids).size,4);
});

test('unique ending events are assigned once globally and each later chain event has its own reservation',t=>{
 const incidentMap={zones:{first:{id:'zone_1',nodes:[...[0,1,2,3].map(y=>({pos:{x:0,y},type:'INCIDENT',next:[{x:1,y:0}]})),{pos:{x:1,y:0},type:'BATTLE_NORMAL',stage:'ro2_n_1_1',next:[]}]}}};
 let selected;
 for(let seed=1;seed<100&&!selected;seed++){
  const f=fixture(t,1,incidentMap,seed);start(f.match);
  if(Object.keys(f.match.floorState.eventLedger.claims).some(key=>key==='prts_ro2_event_40'||key==='prts_ro2_event_42'))selected=f;
 }
 assert.ok(selected);const {match:m,options}=selected,ledger=structuredClone(m.floorState.eventLedger);
 for(const key of MIZUKI_UNIQUE_ROUTE_EVENTS)assert.ok(Object.values(ledger.nodes).filter(value=>value===key).length<=1,key);
 for(let i=0;i<3;i++)m._withParty(m.expedition.partyFor('p0'),()=>m._enterRoute());
 assert.deepEqual(m.floorState.eventLedger,ledger,'route refresh cannot redraw or release an appeared event');
 const loaded=restore(t,options,m.exportCheckpoint());assert.deepEqual(loaded.floorState.eventLedger,ledger);
 const blockedKey=Object.keys(ledger.claims)[0],claim=ledger.claims[blockedKey];claim.partyId='party-1';const base={seed:1,floor:1,light:100,endingUnlocks:ALL,collectibles:[],eventLedger:ledger,partyId:'party-99'};
 const original=createMizukiRouteEvent({id:claim.nodeId,graphType:'INCIDENT'},base);
 assert.notEqual(original.state.eventKey,blockedKey,'another party entering an already claimed unique event cannot replay it');
 const chain=createMizukiRouteEventLedger();chain.nodes.old='prts_ro2_event_40';chain.claims.prts_ro2_event_40={nodeId:'old',partyId:'party-1'};
 const progress={version:1,choices:[{choiceId:'choice_ro2_bossa1_1',relicId:'rogue_2_relic_grace_83',nodeId:'old',floor:1,light:100,order:0}],battles:[],knightDeaths:[]};
 let followup=false;for(let seed=1;seed<500;seed++){
  const event=createMizukiRouteEvent({id:'later:'+seed,graphType:'INCIDENT'},{seed,floor:2,light:100,endingUnlocks:ALL,collectibles:['rogue_2_relic_grace_83'],endingProgress:progress,eventLedger:chain,partyId:'party-1'});
  assert.notEqual(event.state.eventKey,'prts_ro2_event_40');if(event.state.eventKey==='prts_ro2_event_41')followup=true;
 }assert.equal(followup,true,'the next distinct original ending event remains eligible');
});
