// Original registry handlers, isolated recruitment IO. No shared effect or other
// mode is changed. Match calls this only after a successful manual transaction.
import { getDefaultRegistry, GARRISON_HOOK } from '../../match/effectsMeta.js';
import { itemKey } from '../../match/gamedata.js';
import { rollMizukiRecruitOperator, grantMizukiRecruitRefreshes, validMizukiRecruitTicket, enableMizukiSpecialRecruitPool } from './Recruitment.js';
import { mizukiStrategySpecialRecruitRefresh } from './StrategyAdaptation.js';
import { mizukiEquipmentAvailable } from './EquipmentPolicy.js';
import { mizukiStrategyAvailable } from './StrategyPolicy.js';

const PREFIX='mizuki:recruit:piece:';
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object || {},key);
const itemsOf=piece=>Array.isArray(piece?.items)?piece.items:[];

/** Candidates are a shop-shaped view solely for the original strategy callbacks. */
export function dispatchMizukiRecruitMeta({player,ticket,catalog,gd,contextFactory,callbacks={},registry=getDefaultRegistry(),
  hook='onRefresh',effects,event={}}={}) {
  const output={dispatched:0,errors:[]};
  if(!['onRefresh','onMerge'].includes(hook)||typeof contextFactory!=='function'||!player||!gd)return output;
  if(hook==='onRefresh') {
    if(effects?.manualRefresh!==true||!validMizukiRecruitTicket(ticket,{catalog})
      ||ticket.lastManualRefreshRevision!==ticket.revision||ticket.metaRefreshRevision===ticket.revision)return output;
    // Claim before callbacks: a failing or reentrant handler cannot duplicate it.
    ticket.metaRefreshRevision=ticket.revision;
  }
  const specialRefresh = hook === 'onRefresh' && mizukiStrategySpecialRecruitRefresh(gd.band?.(player.bandId), player);
  const candidatesBefore = [...(ticket?.candidates || [])];
  const base=contextFactory(null);
  const pieces=[...(base.board?.()||[]),...(base.hand?.()||[]),...(base.temp?.()||[])];
  const snapshot=[...new Map(pieces.filter(piece=>piece&&piece.kind==='chess').map(piece=>[piece.uid,piece])).values()];
  const round=Number.isSafeInteger(base.round)?base.round:0;
  player.metaCounters ||= {};
  if(player.metaCounters[PREFIX+'round']!==round) {
    for(const key of Object.keys(player.metaCounters))if(key.startsWith(PREFIX))delete player.metaCounters[key];
    player.metaCounters[PREFIX+'round']=round;
  }
  const slots=()=>ticket?.candidates?.map(operatorId=>({kind:'chess',id:operatorId,basePrice:0,sold:false,frozen:false}))||[];
  const rollChess=options=>{
    const opts=options||{};
    if(callbacks.rollChess)return callbacks.rollChess(opts);
    const eligible=catalog.operators.filter(operator=>(!Number.isInteger(opts.tier)||operator.tier===opts.tier)
      &&(!Number.isInteger(opts.maxTier)||operator.tier<=opts.maxTier)
      &&(ticket?.kind!=='sixstar_free'||operator.rarity===6)
      &&(!ticket?.allowedRarities?.length||ticket.allowedRarities.includes(operator.rarity))
      &&(!ticket?.promotionOnly||player.roster?.some(unit=>unit.operatorId===operator.operatorId)
        &&(!ticket.allowedProfessions?.length||ticket.allowedProfessions.includes(operator.profession)))
      &&(!opts.bond||operator.bonds.includes(opts.bond))&&(!opts.filter||opts.filter(operator.operatorId)));
    return rollMizukiRecruitOperator({catalog:{operators:eligible,byId:catalog.byId},gd,
      rng:base.rng,roster:player.roster});
  };
  const makeContext=source=>{
    const ctx={...contextFactory(source),hook,source,
      board:()=>snapshot.filter(piece=>piece.area==='board'),
      hand:()=>snapshot.filter(piece=>piece.area!=='board'&&piece.area!=='temp'),
      temp:()=>snapshot.filter(piece=>piece.area==='temp'),
      shopLevel:()=>gd.maxShopLevel||6,shopSlots:slots,
      setShopSlot:(index,slot)=>{
        if(!ticket||!Number.isInteger(index)||index<0||index>=ticket.candidates.length||slot?.kind==='item'
          ||!catalog.byId.has(slot?.id)
          ||ticket.kind==='sixstar_free'&&catalog.byId.get(slot.id).rarity!==6)return false;
        const next=catalog.byId.get(slot.id);
        if(ticket.allowedRarities?.length&&!ticket.allowedRarities.includes(next.rarity)
          ||ticket.promotionOnly&&(!player.roster?.some(unit=>unit.operatorId===slot.id)
            ||ticket.allowedProfessions?.length&&!ticket.allowedProfessions.includes(next.profession)))return false;
        const owned=player.roster?.find(unit=>unit.operatorId===slot.id);
        if(owned&&(owned.promotion||!next.promotionChessId))return false;
        ticket.candidates[index]=slot.id;return true;
      },
      rollChess,
      grantFreeRefresh:(amount=1)=>grantMizukiRecruitRefreshes(ticket,amount),
      pieceCounter:(uid,key)=>{
        const piece=snapshot.find(value=>value.uid===uid);
        const counter=PREFIX+uid+':'+piece?.id+':'+key;
        return piece&&own(player.metaCounters,counter)?player.metaCounters[counter]:0;
      },
      incPieceCounter:(uid,key,amount=1)=>{
        const piece=snapshot.find(value=>value.uid===uid);
        if(!piece||typeof key!=='string'||!Number.isFinite(amount))return 0;
        const counter=PREFIX+uid+':'+piece.id+':'+key;
        return player.metaCounters[counter]=(own(player.metaCounters,counter)?player.metaCounters[counter]:0)+amount;
      },...callbacks};
    return ctx;
  };
  const payload=hook==='onRefresh'?{...event,slots:slots(),free:true,price:0}:event;
  const call=(key,handler,source,allowRun=true)=>{
    if(source.kind==='item'&&!mizukiEquipmentAvailable(gd,source.piece?.id))return;
    if(source.kind==='band'&&!mizukiStrategyAvailable(source.bandId))return;
    const fn=handler?.[hook]||(allowRun?handler?.run:null);
    if(typeof fn!=='function')return;
    try{fn(makeContext(source),payload);output.dispatched++;}
    catch(error){output.errors.push({key,error:error.message});base.reportError?.(key,error);}
  };
  for(const [key,handler] of registry.globals?.()||[])call(key,handler,{kind:'global',key});
  if(player.bandId)call('band:'+player.bandId,registry.get('band:'+player.bandId),{kind:'band',key:'band:'+player.bandId,bandId:player.bandId,band:gd.band(player.bandId)});
  for(const bondId of gd.bondIds||[])call('bond:'+bondId,registry.get('bond:'+bondId),{kind:'bond',key:'bond:'+bondId,bondId,bond:base.bond?.(bondId)});
  // Snapshot first: a strategy's new operator cannot witness the same refresh.
  if(hook==='onRefresh')for(const piece of snapshot.filter(value=>value.area!=='temp'))for(const garrisonId of gd.chess(piece.id)?.garrisonIds||[]) {
    const garrison=gd.garrison(garrisonId),key='garrison:'+garrison?.effectKey,handler=registry.get(key);
    const hooks=handler?.garrisonHooks?.(garrison)||[GARRISON_HOOK[garrison?.eventType]];
    if(!garrison||!hooks.includes(hook)||piece.area!=='board'&&garrison.bbStr?.conditionkey==='character_target_inboard')continue;
    call(key,handler,{kind:'garrison',key,piece,garrisonId,garrison,bb:garrison.bb||{},bbStr:garrison.bbStr||{},where:piece.area==='board'?'board':'hand'});
  }
  for(const holder of snapshot)for(const item of [...itemsOf(holder)]) {
    const key='item:'+itemKey(item.id);
    call(key,registry.get(key),{kind:'item',key,piece:item,holder,item:gd.item(item.id)});
  }
  if(ticket)ticket.freeCandidateIds=(ticket.freeCandidateIds||[]).filter(id=>ticket.candidates.includes(id));
  if(hook==='onRefresh'&&(specialRefresh||ticket?.candidates?.some((id,index)=>id!==candidatesBefore[index])))
    enableMizukiSpecialRecruitPool(ticket);
  return output;
}

export const dispatchMizukiRecruitRefresh=options=>dispatchMizukiRecruitMeta({...options,hook:'onRefresh'});
export const dispatchMizukiRecruitPromotion=options=>dispatchMizukiRecruitMeta({...options,hook:'onMerge'});
