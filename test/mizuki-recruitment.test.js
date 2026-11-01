import test from 'node:test';
import assert from 'node:assert/strict';
import { createMizukiRecruitTicket,validMizukiRecruitTicket,mizukiRecruitParameters,
  openMizukiRecruitTicket,rollMizukiRecruitCandidates,mizukiRecruitOfferId,mizukiRecruitRefreshId,mizukiRecruitSkipId,
  planMizukiRecruitment,applyMizukiRecruitProgress,consumeMizukiRecruitTicket,refreshMizukiRecruitTicket,
  skipMizukiRecruitTicket,grantMizukiRecruitRefreshes,validMizukiRecruitProgress,planMizukiDirectPromotion,
  planMizukiOperatorGain } from '../server/modes/mizuki/Recruitment.js';
import { dispatchMizukiRecruitRefresh,dispatchMizukiRecruitPromotion } from '../server/modes/mizuki/RecruitmentMeta.js';
import { getDefaultRegistry,MetaRegistry } from '../server/match/effectsMeta.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
import { getData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { MIZUKI_MODE_ID } from '../shared/mizuki-constants.js';
import { createRng } from '../server/sim/rng.js';

const ops=[['a','WARRIOR',10],['b','MEDIC',10],['c','SNIPER',5],['d','WARRIOR',5],['e','CASTER',10],['f','SPECIAL',1]]
  .map(([operatorId,profession,weight])=>({operatorId,profession,weight,tier:3,canonicalChessId:operatorId,
    promotionChessId:operatorId+'_p',bonds:['test']}));
const catalog={operators:ops,byId:new Map(ops.map(operator=>[operator.operatorId,operator]))};
const gd={maxShopLevel:6,shopSlots:()=>({chess:5}),poolCopies:id=>catalog.byId.get(id).weight};
const context=(extra={})=>({catalog,gd,rng:()=>.3,roster:[],...extra});
function opened(extra={}) {return openMizukiRecruitTicket(createMizukiRecruitTicket({id:'test-ticket',profession:'WARRIOR',...extra}),context()).ticket;}
const roundtrip=value=>JSON.parse(JSON.stringify(value));

test('ticket starts at one recruit and three finite manual refreshes',()=>{
  const ticket=createMizukiRecruitTicket({id:'ticket',profession:'ANY'});
  assert.equal(ticket.count,1);assert.equal(ticket.freeRefreshes,3);assert.equal(ticket.kind,'normal');
  assert.equal(validMizukiRecruitTicket(ticket,{catalog}),true);
  assert.equal(createMizukiRecruitTicket({id:'ticket',profession:'MEDIC',advanced:true}).kind,'advanced');
  assert.throws(()=>createMizukiRecruitTicket({id:'',profession:'ANY'}),TypeError);
  assert.throws(()=>createMizukiRecruitTicket({id:'t',profession:'UNKNOWN'}),TypeError);
});

test('opening is deterministic and subsequent view reads never reroll',()=>{
  const ticket=opened(),before=roundtrip(ticket);
  assert.equal(ticket.candidates.length,2);assert.equal(new Set(ticket.candidates).size,2);
  const result=openMizukiRecruitTicket(ticket,context({rng:()=>{throw Error('view rerolled');}}));
  assert.deepEqual(result.ticket,before);assert.deepEqual(ticket,before);
});

test('profession preference boosts copy weight and preserves the complete pool',()=>{
  assert.equal(rollMizukiRecruitCandidates(context({ticket:createMizukiRecruitTicket({id:'t',profession:'WARRIOR'})}))[0],'a');
  assert.equal(rollMizukiRecruitCandidates(context({ticket:createMizukiRecruitTicket({id:'t',profession:'ANY'})}))[0],'b');
  const selected=new Set();for(let n=0;n<1000;n++)selected.add(rollMizukiRecruitCandidates(context({rng:()=>n/1000,ticket:createMizukiRecruitTicket({id:'t',profession:'WARRIOR'})}))[0]);
  assert.deepEqual([...selected].sort(),ops.map(value=>value.operatorId).sort());
  assert.equal(mizukiRecruitParameters(gd).candidateCount,12);
  assert.equal(mizukiRecruitParameters(gd).candidatesPerRarity,2);
  assert.equal(mizukiRecruitParameters(gd).professionWeightMultiplier,2);
});

test('three manual refreshes have independent revision tokens and do not spend recruits',()=>{
  let ticket=opened();const original=roundtrip(ticket);
  for(let i=0;i<3;i++){
    const token=mizukiRecruitRefreshId(ticket),result=refreshMizukiRecruitTicket(ticket,context({token,requestId:'refresh-'+i}));
    assert.equal(result.ok,true);assert.equal(result.effects.manualRefresh,true);assert.equal(result.effects.price,0);
    assert.equal(result.ticket.count,1);assert.equal(result.ticket.freeRefreshes,2-i);
    assert.equal(refreshMizukiRecruitTicket(result.ticket,context({token})).ok,false);
    ticket=result.ticket;assert.equal(validMizukiRecruitTicket(roundtrip(ticket),{catalog}),true);
  }
  assert.equal(refreshMizukiRecruitTicket(ticket,context({token:mizukiRecruitRefreshId(ticket)})).error,'NO_FUNDS');
  assert.deepEqual(original,opened());
});

test('a successful choice uses up the one-recruit ticket without manual count or refresh effects',()=>{
  let ticket=opened();const stale=mizukiRecruitOfferId(ticket,ticket.candidates[0]);
  for(let i=0;i<1;i++){
    const result=consumeMizukiRecruitTicket(ticket,context({offerId:mizukiRecruitOfferId(ticket,ticket.candidates[0]),requestId:'pick-'+i}));
    assert.equal(result.ok,true);assert.equal(result.ticket.count,0-i);assert.equal(result.ticket.freeRefreshes,3);
    assert.equal(result.effects.manualRefresh,false);assert.equal(result.effects.automaticRedraw,false);
    ticket=result.ticket;assert.equal(validMizukiRecruitTicket(roundtrip(ticket),{catalog}),true);
  }
  assert.equal(ticket.status,'used');assert.deepEqual(ticket.candidates,[]);
  assert.equal(consumeMizukiRecruitTicket(ticket,context({offerId:stale})).ok,false);
});

test('request IDs cannot be reused against a current token and stale offers cannot choose',()=>{
  const ticket=opened(),offerId=mizukiRecruitOfferId(ticket,ticket.candidates[0]);
  const next=consumeMizukiRecruitTicket(ticket,context({offerId,requestId:'same'})).ticket;
  assert.equal(planMizukiRecruitment({ticket:next,offerId,catalog,roster:[]}).ok,false);
  assert.equal(refreshMizukiRecruitTicket(next,context({token:mizukiRecruitRefreshId(next),requestId:'same'})).ok,false);
  assert.equal(consumeMizukiRecruitTicket(next,context({offerId:mizukiRecruitOfferId(next,next.candidates[0]),requestId:'same'})).ok,false);
});

test('skip is ticket and revision specific; null never skips a later ticket',()=>{
  const ticket=opened(),token=mizukiRecruitSkipId(ticket),next=refreshMizukiRecruitTicket(ticket,context({token:mizukiRecruitRefreshId(ticket)})).ticket;
  assert.equal(skipMizukiRecruitTicket(next,{token,catalog}).ok,false);
  assert.equal(skipMizukiRecruitTicket(next,{token:null,catalog}).ok,false);
  const skipped=skipMizukiRecruitTicket(next,{token:mizukiRecruitSkipId(next),catalog,requestId:'skip'});
  assert.equal(skipped.ok,true);assert.equal(skipped.ticket.count,0);assert.equal(skipped.ticket.status,'skipped');
  assert.equal(validMizukiRecruitTicket(roundtrip(skipped.ticket),{catalog}),true);
  const other=opened({id:'other-ticket'});assert.equal(skipMizukiRecruitTicket(other,{token,catalog}).ok,false);
});

test('ordinary second copy is a distinct entity and the third promotes the first in place',()=>{
  const operatorId=ops[0].operatorId,item={uid:40001,id:'item_test',kind:'item',meta:{round:{r:1,n:{used:1}}}};
  let roster=[];
  for(let n=1;n<=3;n++){
    const plan=planMizukiOperatorGain({operatorId,catalog,roster});
    assert.equal(plan.ok,true);assert.equal(plan.promotion,n===3?1:0);
    assert.equal(plan.action,n===1?'recruit':n===2?'copy':'promote');
    if(n===1){roster.push(applyMizukiRecruitProgress(null,{uid:999,operatorId,items:[item]},plan));}
    else if(n===2){
      assert.equal(plan.existingUid,null);assert.deepEqual(plan.consumedUids,[]);
      roster.push(applyMizukiRecruitProgress(null,{uid:1000,operatorId,items:[]},plan));
    }else{
      assert.equal(plan.existingUid,999);assert.deepEqual(plan.consumedUids,[1000]);
      const previous=roster.find(unit=>unit.uid===plan.existingUid);
      const promoted=applyMizukiRecruitProgress(previous,{uid:2000,operatorId,items:[]},plan);
      roster=roster.filter(unit=>!plan.consumedUids.includes(unit.uid));roster[0]=promoted;
    }
    assert.equal(roster.length,n===3?1:n);
    assert.equal(validMizukiRecruitProgress(roster[0],{catalog}),true);
  }
  assert.equal(roster[0].uid,999);assert.equal(roster[0].recruitCopies,3);assert.equal(roster[0].promotion,1);
  assert.deepEqual(roster[0].items,[item]);
  assert.equal(planMizukiOperatorGain({operatorId,catalog,roster}).error,'ALREADY');
});

test('ANY profession alone does not grant direct advancement; advanced permission does',()=>{
  const normal=opened({profession:'ANY'}),operatorId=normal.candidates[0],unit={uid:1,operatorId,promotion:0,recruitCopies:1,items:[]};
  const a=planMizukiRecruitment({ticket:normal,offerId:mizukiRecruitOfferId(normal,operatorId),catalog,roster:[unit]});
  assert.equal(a.action,'copy');assert.equal(a.promotion,0);
  const direct=opened({profession:'MEDIC',kind:'advanced'});
  const b=planMizukiRecruitment({ticket:direct,offerId:mizukiRecruitOfferId(direct,operatorId),catalog,roster:[unit]});
  assert.equal(b.action,'upgrade');assert.equal(b.promotion,1);assert.equal(b.recruitCopies,1);assert.equal(b.upgradeCost,true);
  const plan=planMizukiDirectPromotion({catalog,unit});assert.equal(plan.promotion,1);assert.equal(plan.existingUid,1);
});

test('promoted operators leave the draw while other professions remain eligible',()=>{
  const ticket=opened(),promoted=ticket.candidates[0];
  const candidates=rollMizukiRecruitCandidates(context({ticket,roster:[{operatorId:promoted,promotion:1}]}));
  assert.ok(!candidates.includes(promoted));assert.equal(candidates.length,2);
});

test('checkpoint validation rejects tampered counters IDs tokens and progression',()=>{
  const base=opened();assert.equal(validMizukiRecruitTicket(roundtrip(base),{catalog}),true);
  for(const change of [{count:4},{count:2},{status:'used'},{freeRefreshes:-1},{freeRefreshes:4},{refreshCount:1},{revision:99},
    {lastManualRefreshRevision:1},{metaRefreshRevision:1},{candidates:['unknown']},{requestIds:['same','same']},{recruited:['a']},
    {profession:'unknown'},{kind:'SUPER'},{operatorId:'a'},{schemaVersion:2},{freeRefreshesGranted:Infinity}]){
    assert.equal(validMizukiRecruitTicket({...base,...change},{catalog}),false,JSON.stringify(change));
  }
  for(const unit of [{operatorId:'a',promotion:0,recruitCopies:3},{operatorId:'a',promotion:1,recruitCopies:4},
    {operatorId:'a',promotion:0,recruitCopies:NaN},{operatorId:'unknown',promotion:0,recruitCopies:1}])assert.equal(validMizukiRecruitProgress(unit,{catalog}),false);
});

test('covenant free refresh grants preserve finite allowance accounting',()=>{
  const ticket=opened();assert.equal(grantMizukiRecruitRefreshes(ticket,0),3);
  assert.equal(grantMizukiRecruitRefreshes(ticket,2),5);assert.equal(ticket.freeRefreshesGranted,2);
  assert.equal(validMizukiRecruitTicket(roundtrip(ticket),{catalog}),true);
  assert.equal(grantMizukiRecruitRefreshes(ticket,Infinity),0);assert.equal(ticket.freeRefreshes,5);
});

function metaFixture({registry=getDefaultRegistry(),round=1,pieces=[],active={}}={}){
  const player={playerId:'p1',roster:[],metaCounters:{},layers:{},recruitRefreshes:1};
  const ticket=refreshMizukiRecruitTicket(opened(),context({token:mizukiRecruitRefreshId(opened())})).ticket;
  const localGd={...gd,bondIds:Object.keys(active),band:()=>null,tierOf:id=>catalog.byId.get(id)?.tier||1,
    chess:id=>({bonds:['test'],garrisonIds:[],...catalog.byId.get(id)}),item:()=>null,garrison:()=>null};
  const contextFactory=source=>({source,gd:localGd,data:getData(),round,rng:()=>0,board:()=>[],hand:()=>pieces,temp:()=>[],
    counter:key=>player.metaCounters[key]||0,setCounter:(key,value)=>(player.metaCounters[key]=value),
    incCounter:(key,amount=1)=>(player.metaCounters[key]=(player.metaCounters[key]||0)+amount),
    roundStats:()=>({refreshes:player.recruitRefreshes}),bondActive:id=>!!active[id],bond:id=>active[id],
    bonds:()=>active,layers:id=>player.layers[id]||0,chessRecord:id=>localGd.chess(id),pieceBonds:()=>['test'],
    addLayers:(id,amount)=>player.layers[id]=(player.layers[id]||0)+amount,
    toast:()=>{},reportError:()=>{}});
  return {player,ticket,catalog,gd:localGd,contextFactory,registry,effects:{manualRefresh:true}};
}

test('only committed manual refresh dispatches handlers, once across save restore',()=>{
  const registry=new MetaRegistry();let calls=0;registry.global('audit',{onRefresh:()=>calls++});
  const f=metaFixture({registry});assert.equal(dispatchMizukiRecruitRefresh({...f,effects:{manualRefresh:false}}).dispatched,0);assert.equal(calls,0);
  assert.equal(dispatchMizukiRecruitRefresh(f).dispatched,1);assert.equal(calls,1);
  f.ticket=roundtrip(f.ticket);assert.equal(dispatchMizukiRecruitRefresh(f).dispatched,0);assert.equal(calls,1);
  const next=consumeMizukiRecruitTicket(f.ticket,context({offerId:mizukiRecruitOfferId(f.ticket,f.ticket.candidates[0])})).ticket;
  assert.equal(dispatchMizukiRecruitRefresh({...f,ticket:next}).dispatched,0);assert.equal(calls,1);
});

test('original Lappland refresh trait receives per-piece counters and layer effects',()=>{
  const piece={uid:10001,id:'a',kind:'chess',area:'hand',items:[]};const f=metaFixture({pieces:[piece]});
  f.gd.chess=()=>({garrisonIds:['lappland']});f.gd.garrison=()=>({garrisonId:'lappland',effectKey:'SERVER_GAIN_BOND_LAYER_BY_REFRESH_CNT',
    eventType:'SERVER_REFRESH_SHOP',bb:{refresh_cnt:1,layer:4},bbStr:{bond:'test'},desc:'无需激活'});
  const first=dispatchMizukiRecruitRefresh(f);assert.deepEqual(first.errors,[]);assert.equal(f.player.layers.test,4);
  f.ticket=refreshMizukiRecruitTicket(f.ticket,context({token:mizukiRecruitRefreshId(f.ticket)})).ticket;
  dispatchMizukiRecruitRefresh(f);assert.equal(f.player.layers.test,4);
});

test('original Miracle handler can grant a finite next free refresh',()=>{
  const f=metaFixture({active:{miraShip:{active:true}}});
  let ticket=opened();for(let n=0;n<3;n++)ticket=refreshMizukiRecruitTicket(ticket,context({token:mizukiRecruitRefreshId(ticket)})).ticket;
  f.ticket=ticket;assert.equal(ticket.freeRefreshes,0);
  const result=dispatchMizukiRecruitRefresh(f);assert.deepEqual(result.errors,[]);
  assert.equal(ticket.freeRefreshes,1);assert.equal(ticket.freeRefreshesGranted,1);assert.equal(validMizukiRecruitTicket(roundtrip(ticket),{catalog}),true);
});

test('original highest-tier-copy strategy operates on the private recruit page',()=>{
  const band=Object.values(getData().bands).find(value=>value.buffs?.some(buff=>buff.key==='band_shop_refresh_copy_max_lv_char'));
  assert.ok(band);const f=metaFixture();f.player.bandId=band.bandId;f.gd.band=()=>band;
  const factory=f.contextFactory,rng=createRng(42);f.contextFactory=source=>({...factory(source),rng});
  const candidateCount=f.ticket.candidates.length;
  assert.equal(new Set(f.ticket.candidates).size,candidateCount);
  const result=dispatchMizukiRecruitRefresh(f);assert.deepEqual(result.errors,[]);
  assert.equal(f.ticket.candidates.length,candidateCount);assert.equal(new Set(f.ticket.candidates).size,candidateCount-1);
  const openRng=f.contextFactory().rng;
  const reopened=openMizukiRecruitTicket(f.ticket,{catalog,gd:f.gd,rng:openRng,roster:f.player.roster});
  assert.deepEqual(reopened.ticket.candidates,f.ticket.candidates,'view reconciliation keeps the committed copied offer');
  assert.equal(validMizukiRecruitTicket(roundtrip(f.ticket),{catalog}),true);
});

test('refresh callbacks snapshot owned pieces before any strategy gain',()=>{
  const registry=new MetaRegistry(),first={uid:1,id:'a',kind:'chess',area:'hand',items:[]},pieces=[first];
  registry.global('grant',{onRefresh:()=>pieces.push({uid:2,id:'b',kind:'chess',area:'hand',items:[]})});
  const witnessed=[];registry.garrison('audit',{onRefresh:ctx=>witnessed.push(ctx.source.piece.uid)});
  const f=metaFixture({registry,pieces});f.gd.chess=()=>({garrisonIds:['g']});f.gd.garrison=()=>({effectKey:'audit',eventType:'SERVER_REFRESH_SHOP',bb:{},bbStr:{}});
  dispatchMizukiRecruitRefresh(f);assert.deepEqual(witnessed,[1]);
});

test('promotion dispatch does not invent the vanilla extra operator reward',()=>{
  const registry=new MetaRegistry();let merges=0,grants=0;
  registry.global('audit',{onMerge:()=>merges++});
  const f=metaFixture({registry});f.callbacks={grantChess:()=>grants++};
  const result=dispatchMizukiRecruitPromotion({...f,event:{kind:'chess',piece:{uid:1,id:'a_p'}}});
  assert.equal(result.dispatched,1);assert.equal(merges,1);assert.equal(grants,0);
});

test('actual complete project catalog retains all professions in a recruitment draw',()=>{
  const data=getData(),realCatalog=createMizukiCatalog(data),realGd=new GameData(realCatalog.source.raw,MIZUKI_MODE_ID);
  const ticket=createMizukiRecruitTicket({id:'full-pool',profession:'PIONEER'});
  const parameters=mizukiRecruitParameters(realGd);assert.equal(parameters.candidateCount,12);
  const choices=rollMizukiRecruitCandidates({catalog:realCatalog,gd:realGd,ticket,rng:()=>.75});
  const expected=[1,2,3,4,5,6].reduce((sum,rarity)=>sum+Math.min(parameters.candidatesPerRarity,
    realCatalog.operators.filter(operator=>operator.rarity===rarity).length),0);
  assert.equal(choices.length,expected);assert.ok(choices.every(id=>realCatalog.byId.has(id)));
  assert.ok(choices.some(id=>realCatalog.byId.get(id).profession!=='PIONEER'));
});
