import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIZUKI_PREP_SHIFT, mizukiPrepStage, mizukiPrepRenderState, mizukiPrepTarget, mizukiCanPlace, applyPendingPrepMoves, createMizukiPrepMoveQueue, mizukiPrepMoveCanPredict } from '../public/js/mizukiPrep.js';
import { mizukiSpineEntry, adaptMizukiUnitView } from '../public/js/mizukiSpine.js';
import { getDefaultSource } from '../server/sim/simdata.js';
import { Grid } from '../server/sim/grid.js';
import { mizukiPrepView, moveMizukiPrep } from '../server/modes/mizuki/Prep.js';
test('native bench owns separate rows and original map cells retain a reversible visual shift', () => {
 const stage={id:'source',rows:['rS','fE'],tiles:{r:{height:'LOW'}}},before=JSON.stringify(stage);
 const view=mizukiPrepStage(stage,{r0:0,r1:1,c0:0,c1:1});
 assert.equal(view.rows[0].slice(0,10),'aaaaaaaaaa');assert.equal(view.rows[2],'rS');assert.equal(view.rows[3],'fE');assert.equal(JSON.stringify(stage),before);
 const prep={hand:[{uid:1,id:'a'}],board:[{uid:2,id:'b',row:1,col:1}]};
 const rendered=mizukiPrepRenderState(prep);assert.equal(rendered.hand.length,1);assert.equal(rendered.board[0].row,1+MIZUKI_PREP_SHIFT);assert.equal(prep.board[0].row,1);
 assert.deepEqual(mizukiPrepTarget({area:'board',row:3,col:1}),{area:'board',row:1,col:1});
 const geometry={tiles:[{row:1,col:1,build:'ALL'}]};assert.equal(mizukiCanPlace(prep,geometry,1,{area:'board',row:3,col:1}),true);assert.equal(mizukiCanPlace(prep,geometry,999,{area:'board',row:3,col:1}),false);
 assert.equal(mizukiCanPlace(prep,geometry,1,{area:'board',row:3,col:1},[{row:1,col:1}]),false);
 const legal={...prep,legalTiles:{1:[[1,1]]}};assert.equal(mizukiCanPlace(legal,null,1,{area:'board',row:3,col:1}),true);
 assert.equal(mizukiCanPlace({...prep,legalTiles:{1:[]}},geometry,1,{area:'board',row:3,col:1}),false);
});
test('queued prep previews apply in order and swap an occupied board tile without mutating server state', () => {
 const prep={hand:[1,2,null],temp:[],board:[],supplies:[]};
 const projected=applyPendingPrepMoves(prep,[
  {uid:1,to:{area:'board',row:2,col:3},dir:'RIGHT'},
  {uid:2,to:{area:'board',row:2,col:3},dir:'LEFT'},
 ]);
 assert.deepEqual(projected.hand,[null,1,null]);assert.deepEqual(projected.board,[{uid:2,row:2,col:3,dir:'LEFT'}]);
 assert.deepEqual(prep,{hand:[1,2,null],temp:[],board:[],supplies:[]});
});
test('optimistic moves preserve full Mizuki operator and summon identities before server acknowledgment', () => {
 const operator={uid:11,id:'char_002_amiya',kind:'chess',operatorId:'amiya',avatar:'avatar_amiya',items:[{id:'gear'}]};
 const summon={uid:12,id:'token_amiya',kind:'token',ownerUid:11,avatar:'token_amiya',count:1};
 const prep={hand:[operator,null],temp:[summon],board:[],supplies:[]};
 const projected=applyPendingPrepMoves(prep,[{uid:11,to:{area:'board',row:3,col:4},dir:'LEFT'},{uid:12,to:{area:'board',row:4,col:5}}]);
 assert.deepEqual(projected.board,[{...operator,row:3,col:4,dir:'LEFT'},{...summon,row:4,col:5,dir:'RIGHT'}]);
 assert.equal(projected.hand[0],null);assert.equal(projected.temp[0],null);
 assert.deepEqual(prep.hand,[operator,null]);assert.deepEqual(prep.temp,[summon]);
});
test('server prep view preserves same-model operator identities through board moves, swaps and queued moves', () => {
 const source=getDefaultSource(),rect={r0:9,r1:12,c0:2,c1:10};
 const grid=new Grid({id:'mizuki-private-prep-test',rows:Array(19).fill('r'.repeat(21))},rect);
 const chessId='chess_char_1_02_a';
 const player={playerId:'p1',seat:0,fieldId:'mz-private',roster:[11,12].map(uid=>({uid,chessId,
  operatorId:'same-model',name:'Same model',position:source.getChess(chessId).position,
  avatar:`avatar-${uid}`,items:[{uid:uid+100,id:`item-${uid}`,kind:'item'}]})),lineup:[11,12]};
 const context={source,grid,deployLimit:6,fieldDeployCount:0,otherOccupied:new Set()};
 const put=(uid,row,col)=>moveMizukiPrep(player,uid,{area:'board',row,col},'RIGHT',context);
 assert.equal(put(11,9,4).ok,true);assert.equal(put(12,9,5).ok,true);
 const prep=mizukiPrepView(player,context),before=JSON.stringify(prep),playerBefore=JSON.stringify(player);
 const first=prep.board.find(piece=>piece.uid===11),second=prep.board.find(piece=>piece.uid===12);
 assert.equal(first.id,chessId);assert.equal(second.id,chessId);
 const swapped=applyPendingPrepMoves(prep,[{uid:11,to:{area:'board',row:9,col:5},dir:'LEFT'}]);
 assert.deepEqual(swapped.board.find(piece=>piece.uid===12),{...second,row:9,col:4});
 assert.deepEqual(swapped.board.find(piece=>piece.uid===11),{...first,row:9,col:5,dir:'LEFT'});
 const projected=applyPendingPrepMoves(prep,[
  {uid:11,to:{area:'board',row:9,col:5},dir:'LEFT'},
  {uid:12,to:{area:'board',row:9,col:6},dir:'UP'},
 ]);
 const board=new Map(projected.board.map(piece=>[piece.uid,piece]));
 assert.deepEqual([board.get(11).row,board.get(11).col,board.get(11).dir],[9,5,'LEFT']);
 assert.deepEqual([board.get(12).row,board.get(12).col,board.get(12).dir],[9,6,'UP']);
 for(const uid of [11,12]) {
  const original=prep.board.find(piece=>piece.uid===uid),predicted=board.get(uid);
  for(const key of ['id','kind','operatorId','avatar','position','name']) assert.equal(predicted[key],original[key]);
  assert.deepEqual(predicted.items,original.items);
 }
 assert.equal(JSON.stringify(prep),before);assert.equal(JSON.stringify(player),playerBefore);
});
test('server prep view preserves operator identity across board-to-hand and hand-to-board prediction', () => {
 const source=getDefaultSource(),rect={r0:9,r1:12,c0:2,c1:10};
 const grid=new Grid({id:'mizuki-private-prep-roundtrip',rows:Array(19).fill('r'.repeat(21))},rect);
 const chessId='chess_char_1_02_a';
 const player={playerId:'p1',seat:0,fieldId:'mz-private',roster:[{uid:21,chessId,operatorId:'roundtrip',
  name:'Round trip',position:source.getChess(chessId).position,avatar:'avatar-roundtrip',items:[{id:'item-kept'}]}],lineup:[21]};
 const context={source,grid,deployLimit:6,fieldDeployCount:0,otherOccupied:new Set()};
 assert.equal(moveMizukiPrep(player,21,{area:'board',row:9,col:4},'RIGHT',context).ok,true);
 const prep=mizukiPrepView(player,context),before=JSON.stringify(prep),playerBefore=JSON.stringify(player);
 const returnedToHand=applyPendingPrepMoves(prep,[{uid:21,to:{area:'hand',idx:5}}]);
 assert.equal(returnedToHand.hand[5].uid,21);assert.equal(returnedToHand.hand[5].id,chessId);
 assert.equal(returnedToHand.hand[5].avatar,'avatar-roundtrip');
 assert.equal(Object.hasOwn(returnedToHand.hand[5],'row'),false);assert.equal(Object.hasOwn(returnedToHand.hand[5],'col'),false);
 assert.equal(returnedToHand.bench,returnedToHand.hand);
 const projected=applyPendingPrepMoves(prep,[
  {uid:21,to:{area:'hand',idx:5}},
  {uid:21,to:{area:'board',row:10,col:4},dir:'LEFT'},
 ]);
 const returned=projected.board.find(piece=>piece.uid===21);
 assert.deepEqual([returned.id,returned.kind,returned.operatorId,returned.avatar,returned.name],
  [chessId,'chess','roundtrip','avatar-roundtrip','Round trip']);
 assert.deepEqual(returned.items,[{id:'item-kept'}]);
 assert.equal(projected.hand[5],null);
 assert.equal(JSON.stringify(prep),before);assert.equal(JSON.stringify(player),playerBefore);
});
test('purchased supplies remain dense across repeated placements and hand aliases disappear', () => {
 const first={uid:1000001,id:'trap_first',kind:'token',toolId:'tool_first',count:1,name:'First'};
 const second={uid:1000002,id:'trap_second',kind:'token',toolId:'tool_second',count:1,name:'Second'};
 const prep={hand:[null,null],temp:[],board:[],supplies:[null,first,second]};
 const projected=applyPendingPrepMoves(prep,[
  {uid:first.uid,to:{area:'board',row:1,col:1}},
  {uid:second.uid,to:{area:'board',row:1,col:2}},
 ]);
 assert.deepEqual(projected.supplies,[]);assert.equal(projected.board.length,2);
 assert.deepEqual(projected.board.map(piece=>piece.toolId),['tool_first','tool_second']);
 const aliased=applyPendingPrepMoves({...prep,hand:[first,null],supplies:[first]},[{uid:first.uid,to:{area:'board',row:1,col:1}}]);
 assert.deepEqual(aliased.supplies,[]);assert.equal(aliased.hand[0],null);
 assert.deepEqual(prep.supplies,[null,first,second]);
});
test('server allocated summon stack UIDs and merged returns are never guessed by prediction', () => {
 const source=getDefaultSource(),rect={r0:9,r1:12,c0:2,c1:10};
 const grid=new Grid({id:'mizuki-stack-prediction',rows:Array(19).fill('r'.repeat(21))},rect);
 const chessId='chess_char_4_11_a';
 const player={playerId:'p1',seat:0,fieldId:'mz-private',roster:[{uid:31,chessId,items:[]}],lineup:[31]};
 const context={source,grid,deployLimit:6,fieldDeployCount:0,otherOccupied:new Set()};
 assert.equal(moveMizukiPrep(player,31,{area:'board',row:9,col:4},'RIGHT',context).ok,true);
 const prep=mizukiPrepView(player,context),stack=prep.hand.find(piece=>piece?.kind==='token');
 assert.equal(stack.count,3);
 const move={uid:stack.uid,to:{area:'board',row:9,col:5},dir:'UP'};
 assert.equal(mizukiPrepMoveCanPredict(prep,move),false);
 const predicted=applyPendingPrepMoves(prep,[move]);
 assert.deepEqual(predicted.board,prep.board);assert.deepEqual(predicted.hand,prep.hand);
 assert.equal(moveMizukiPrep(player,move.uid,move.to,move.dir,context).ok,true);
 const after=mizukiPrepView(player,context),placed=after.board.find(piece=>piece.kind==='token');
 assert.notEqual(placed.uid,stack.uid);assert.equal(placed.count,1);
 assert.equal(after.hand.find(piece=>piece?.uid===stack.uid).count,2);
 const back={uid:placed.uid,to:{area:'hand',idx:0}};
 assert.equal(mizukiPrepMoveCanPredict(after,back),false);
 assert.deepEqual(applyPendingPrepMoves(after,[back]).board,after.board);
 assert.equal(moveMizukiPrep(player,back.uid,back.to,'RIGHT',context).ok,true);
 const merged=mizukiPrepView(player,context);
 assert.equal(merged.board.some(piece=>piece.kind==='token'),false);
 assert.equal(merged.hand.find(piece=>piece?.kind==='token').count,3);
});
test('prep move queue is FIFO, bounded, and continues after a rejected request', async () => {
 let rejectFirst, resolveSecond;const sent=[];
 const firstGate=new Promise((_,reject)=>{rejectFirst=reject});
 const secondGate=new Promise(resolve=>{resolveSecond=resolve});
 const queue=createMizukiPrepMoveQueue(2);
 const first=queue.enqueue(()=>{sent.push(1);return firstGate});
 const second=queue.enqueue(()=>{sent.push(2);return secondGate});
 assert.equal(queue.size,2);assert.equal(queue.enqueue(()=>{sent.push(3)}),null);
 await Promise.resolve();assert.deepEqual(sent,[1]);
 rejectFirst(new Error('rejected'));await assert.rejects(first,/rejected/);
 await Promise.resolve();assert.deepEqual(sent,[1,2]);
 resolveSecond('ok');assert.equal(await second,'ok');assert.equal(queue.size,0);
});
test('paranoid bubble uses the extracted first-form animations without changing the shared entry', () => {
 const original = { anims: {} }; const entry = mizukiSpineEntry('enemy_2037_sygirl', original);
 assert.equal(entry.anims.idle, 'C1_Idle'); assert.equal(entry.anims.attack.loop, 'C1_Attack');
 assert.equal(entry.anims.move.loop, 'C1_Move'); assert.deepEqual(original.anims, {});
});

test('nhkodo default attack and devoured forms are local and survive delayed actor creation', () => {
 const original={anims:{}};const entry=mizukiSpineEntry('enemy_1271_nhkodo',original);assert.equal(entry.anims.attack.loop,'Attack_A2');assert.equal(entry.anims.skill.loop,'Attack_A');assert.deepEqual(original.anims,{});
 const view={info:{defId:'enemy_1271_nhkodo'},form:null,_formSpec(){return null},setForm(){throw Error('shared called')}};adaptMizukiUnitView(view);view.setForm('devoured');assert.equal(view._formSpec().roles.idle,'Idle_B');assert.equal(view._formSpec().roles.attack.loop,'Attack_B');
 const calls=[];view.actor={setForm:roles=>calls.push(roles)};view.setForm(null);assert.equal(calls[0],null);assert.equal(view.form,null);
});
