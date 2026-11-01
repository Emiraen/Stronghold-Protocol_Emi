import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mizukiCoordinates, adaptMizukiCoordinates, mizukiVerticalDirection } from '../public/js/mizukiCoordinates.js';
import { mizukiPrepStage } from '../public/js/mizukiPrep.js';
import { translateOfficialMap } from '../server/modes/mizuki/official-stages.js';
import { mizukiCameraProjection } from '../public/js/mizukiCamera.js';
import { Camera } from '../public/js/render/projection.js';

const stage={id:'ro2_n_4_5',originalSize:[8,10],rows:Array.from({length:19},(_,i)=>String(i)),tiles:{},sourceId:'original',theme:'CAVE'};

test('native packet adapters preserve frozen authoritative packets without allocating deep copies',()=>{
 const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
 const packet=freeze({units:[[1,2,3,100,100]],meta:{units:[{id:1,dir:'UP',motion:{dy:2}}]},geometry:{tiles:[{row:2,col:3,build:'ALL'}]},events:[['spawn',{id:1,y:2}]]});
 const map=mizukiCoordinates(stage);
 assert.equal(map.snapshot(packet),packet);assert.equal(map.meta(packet.meta),packet.meta);assert.equal(map.events(packet.events),packet.events);
 const calls={},raw={debug:{},setStage:value=>calls.stage=value,pushSnapshot:value=>calls.snapshot=value,pushEvents:value=>calls.events=value};
 adaptMizukiCoordinates(raw);raw.setStage(freeze({...stage,rows:[...stage.rows]}));raw.pushSnapshot(packet);raw.pushEvents(packet.events);
 assert.equal(calls.snapshot,packet);assert.equal(calls.events,packet.events);assert.deepEqual(calls.snapshot.units[0],[1,2,3,100,100]);
});
test('native bottom-up map rows and bench rows keep their source positions',()=>{
 const map=mizukiCoordinates(stage),visual=map.stage(stage);
 assert.equal(map.count,8);assert.equal(visual.rows[0],'0');assert.equal(visual.rows[7],'7');assert.equal(visual.rows[8],'8');
 assert.equal(visual.id,stage.id);assert.equal(visual.sourceId,'original');assert.equal(visual.theme,'CAVE');
 const prep=mizukiCoordinates(mizukiPrepStage(stage,{r0:0,r1:7}));
 for(const r of [0,1,2,3,4,8,9])assert.equal(prep.row(prep.row(r)),r);
 assert.equal(prep.row(0),0);assert.equal(prep.row(1),1);assert.equal(prep.row(2),2);assert.equal(prep.row(9),9);
});
test('meta snapshots terrain facilities vectors and spawn/fx events share one reversible frame',()=>{
 const map=mizukiCoordinates(stage);
 const meta={rect:{r0:0,r1:7,c0:0,c1:9},units:[{id:'token',ownerId:'p0',y:2,dir:'UP',motion:{dy:2,velocity:[1,3]}}]};
 const transformed=map.meta(meta);assert.equal(transformed.units[0].y,2);assert.equal(transformed.units[0].dir,'UP');
 assert.deepEqual(transformed.units[0].motion,{dy:2,velocity:[1,3]});assert.deepEqual(map.meta(transformed),meta);
 const snap={units:[['a',4,1.25,100]],down:[['b',1,2,0,3,4]],meta,officialFacilities:{tiles:[{row:2,col:4,height:.4}],creep:{tiles:[{row:1,col:1}]}}};
 assert.deepEqual(map.snapshot(map.snapshot(snap)),snap);
 const events=[['spawn',meta.units[0]],['fx','displace',4,2,{direction:[0,1],dy:2}],['atk','a','b','none']];
 assert.equal(map.events(events)[1][3],2);assert.deepEqual(map.events(map.events(events)),events);
 assert.equal(mizukiVerticalDirection('LEFT'),'LEFT');assert.equal(mizukiVerticalDirection('RIGHT'),'RIGHT');
});
test('prep peers, legal placement, tileScreen and emitted picks stay in one frame',()=>{
 const calls={},listeners={};
 const raw={debug:{},setStage:v=>calls.stage=v,setCamera:(k,v)=>calls.camera=v,enterBattle:v=>calls.meta=v,pushSnapshot:v=>calls.snap=v,pushEvents:v=>calls.ev=v,
 setPrep:(v,o)=>{calls.prep=v;calls.options=o;},tileScreen:(r,c)=>({row:r,col:c}),holdPiece:(u,t)=>calls.hold=t,setPieceDir:(u,d)=>calls.dir=d,
 highlightTiles:v=>calls.highlight=v,on:(n,fn)=>{listeners[n]=fn;return()=>delete listeners[n];}};
 adaptMizukiCoordinates(raw);raw.setStage(mizukiPrepStage(stage,{r0:0,r1:7}));
 raw.setPrep({hand:[{uid:1}],temp:[{uid:2}],board:[{uid:3,row:2,col:4,dir:'UP'},{uid:4,row:7,col:2}]},{canPlace:(uid,t)=>uid===3&&t.row===2});
 assert.equal(calls.prep.board[0].row,2);assert.equal(calls.prep.board[1].row,7);assert.equal(calls.prep.board[0].dir,'UP');assert.equal(calls.prep.hand[0].uid,1);
 assert.equal(calls.options.canPlace(3,{area:'board',row:2,col:4}),true);assert.deepEqual(raw.tileScreen(2,4),{row:2,col:4});
 raw.highlightTiles([[2,4],[3,4]]);assert.deepEqual(calls.highlight,[[2,4],[3,4]]);
 raw.holdPiece(3,{row:2,col:4});assert.equal(calls.hold.row,2);raw.setPieceDir(3,'UP');assert.equal(calls.dir,'UP');
 let got;raw.on('pieceDrop',v=>got=v);listeners.pieceDrop({uid:3,target:{area:'board',row:2,col:4}});assert.equal(got.target.row,2);
 listeners.pieceDrop({uid:3,target:{area:'hand',idx:2}});assert.deepEqual(got.target,{area:'hand',idx:2});
});

test('original 1-1 enemies start and finish at the native red/blue gates in battle and prep',()=>{
 const read=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
 const level=read('../data/mizuki/levels/level_rogue2_1-1.json');
 const gates=read('../public/assets/mizuki/native-gates/placements.json').scenes['level_rogue2_1-1'].gates;
 const cameras=read('../public/assets/mizuki/native-cameras/cameras.json');
 const {nativeStage}=translateOfficialMap('ro2_n_1_1',level,{name:'symbiosis'});
 // A real route starting in the near-left red gate, and another from the
 // far-right red gate: a mistaken row flip interchanges 1 and 4 on this map.
 for(const routeIndex of [11,13]){
  const route=level.routes[routeIndex];
  for(const [key,tileKey]of [['startPosition','tile_start'],['endPosition','tile_end']]){
   const endpoint=route[key],gate=gates.find(g=>g.sceneRow===endpoint.row&&g.sceneCol===endpoint.col&&g.tileKey===tileKey);
   assert.ok(gate,`${routeIndex} ${key} has an original gate`);
   assert.equal(nativeStage.tiles[nativeStage.rows[endpoint.row][endpoint.col]].tileKey,tileKey);
   for(const shift of [0,2]){
    const input=shift?mizukiPrepStage(nativeStage,{r0:0,r1:5}):nativeStage;
    const map=mizukiCoordinates(input),visual=map.stage(input);
    const rendered=map.meta({units:[{id:'enemy',x:endpoint.col,y:endpoint.row+shift}]}).units[0];
    const gateRow=gate.sceneRow+shift;
    assert.equal(rendered.y,gateRow);
    assert.equal(visual.tiles[visual.rows[gateRow][gate.gridCol]].tileKey,tileKey);
    if(!shift){
     const cam=new Camera(mizukiCameraProjection(cameras,visual,{width:1600,height:900}).params);
     // Gate effects compensate OfficialFx's fixed Unity→board +10,+9
     // conversion; both anchors must reach the same projected pixel.
     const unitPixel=cam.project(rendered.x,rendered.y,0);
     const effectPixel=cam.project((gate.gridCol-10)+10,(gateRow-9)+9,0);
     assert.deepEqual(unitPixel,effectPixel);
    }
   }
  }
 }
});
