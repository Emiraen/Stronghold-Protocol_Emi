import test from 'node:test';import assert from 'node:assert/strict';
import {SPECIAL_GHOSTY_CARD,canUseSpecialNameCard,isSpecialNameCard} from '../shared/nameCards.js';
import {seatPortrait,seatAvatar,GHOSTY_AVATAR,GHOSTY_POSTER,GHOSTY_ANIMATION} from '../public/js/ui/seatArt.js';
import {resourceCache} from '../public/js/resourceCache.js';
import {PlayerStore} from '../server/playerStore.js';import {RankedStore} from '../server/rankedStore.js';import {createAuthority} from '../server/profileService.js';import {defaultPresentation,checkPresentation} from '../shared/protocol.js';
import {hFresh} from '../public/js/ui/components.js';import {CachedImage} from '../public/js/ui/cachedImage.js';
test('Ghosty is available for every player and saves through the real profile authority',async()=>{
 const aid='aaaaaaaaaaaaaaaa';const players=new PlayerStore();players.record(aid,'小幽祟祟测试');const ranked=new RankedStore();const auth=createAuthority({players,ranked,history:{}},{local:true});const value={...defaultPresentation(),card:SPECIAL_GHOSTY_CARD};
 assert.ok(isSpecialNameCard(SPECIAL_GHOSTY_CARD));assert.ok(canUseSpecialNameCard({},SPECIAL_GHOSTY_CARD));assert.equal(checkPresentation(value,()=>null,{}).ok,true);
 await auth.call('presentation',[aid,{v:1,value},false]);assert.equal(players.getPresentation(aid).value.card,SPECIAL_GHOSTY_CARD);
});
test('Ghosty retains native avatar and switches from the completed poster to its cached looping GIF',()=>{
 const old=resourceCache.isCached;const ctx={pool:[],byChar:new Map(),myId:'self',myCard:SPECIAL_GHOSTY_CARD};try{
 resourceCache.isCached=()=>false;assert.equal(seatPortrait({playerId:'self'},ctx),GHOSTY_POSTER);
 resourceCache.isCached=u=>u===GHOSTY_ANIMATION;assert.equal(seatPortrait({playerId:'self'},ctx),GHOSTY_ANIMATION);assert.equal(seatAvatar({playerId:'self'},ctx),GHOSTY_AVATAR);
 assert.equal(hFresh('img',{src:GHOSTY_AVATAR}).type,'img');assert.equal(hFresh('img',{src:GHOSTY_ANIMATION}).type,CachedImage);
 }finally{resourceCache.isCached=old;}
});
