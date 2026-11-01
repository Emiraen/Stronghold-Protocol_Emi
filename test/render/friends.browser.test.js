import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const enabled = process.env.RENDER_E2E === '1' && fs.existsSync(CHROME);
const sheets = [...fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').matchAll(/<link[^>]*href="([^"]+)"[^>]*>/g)].map(m => m[1]).filter(url => url.endsWith('.css'));
const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${sheets.map(url => '<link rel="stylesheet" href="' + url + '">').join('')}
</head><body><div id="app"></div><script type="module">
import { h,render } from '/vendor/preact.module.js';
import { useState } from '/vendor/hooks.module.js';
import { FriendsHall,FriendInvitationHost } from '/js/ui/friends.js';
import { friendsStore,applyFriends } from '/js/friends.js';
import { store,emptyMatch } from '/js/store.js';
import { net } from '/js/net.js';
import { serversState } from '/js/servers.js';
import { RoomScreen } from '/js/screens/room.js';
import { LobbyScreen } from '/js/screens/lobby.js';
import { data } from '/js/data.js';
const self='1'.repeat(32),friend='2'.repeat(32),applicant='3'.repeat(32),candidate='4'.repeat(32);
const rank={ranked:true,points:2600,globalRank:2,placementPlayed:3,placementMatches:3,wins:8,losses:2,rank:{icon:'immortal_3',label:'神话三 500'},rankPyramid:null};
const person=(id,name,presence={state:'online'})=>({id,name,card:'',cardSkin:'',rank,presence});
window.people=[person(friend,'好友博士',{state:'playing',modeName:'同盟模拟',humans:2,capacity:4,watch:{serverId:'main',code:'ABCD',matchId:'a'.repeat(32)}}),person(applicant,'申请博士'),person(candidate,'推荐博士')];
window.initial={selfId:self,friends:[window.people[0]],requests:[{id:'5'.repeat(32),from:applicant,player:window.people[1]}],outgoing:[],invitations:[]};
window.calls=[];window.pm=window.pm||[];
net.status='online';net.serverId='main';net.request=async(t,fields={})=>{
 window.calls.push({t,...fields});
 if(t==='rank.list')return {items:[{profileId:self,name:'本人博士',points:2700,wins:9,position:1,rank:rank.rank},{profileId:friend,name:'好友博士',points:2600,wins:8,position:2,rank:rank.rank}]};
 if(t==='room.join'){store.set({room:{...window.room,code:fields.code}});return {t:'ok'};}
 if(t==='room.leave'){store.set({room:null,match:emptyMatch()});return {t:'ok'};}
 if(t!=='friends.action')return {t:'ok',items:[]};
 let result={};const state=friendsStore.get();
 if(fields.action==='list') result=state;
 if(fields.action==='message.list')result={items:window.pm.filter(m=>(fields.beforeSeq===undefined||m.seq<fields.beforeSeq)&&(fields.afterSeq===undefined||m.seq>fields.afterSeq)),hasOlder:false,thread:{lastSeq:window.pm.at(-1)?.seq||0}};
 if(fields.action==='message.read'){applyFriends({...state,threads:[{targetId:friend,lastSeq:window.pm.at(-1)?.seq||0,unread:0}]});result={};}
 if(fields.action==='message.send'){const m={seq:(window.pm.at(-1)?.seq||1)+1,id:fields.clientId,clientId:fields.clientId,from:self,text:fields.text,at:Date.now()};window.pm.push(m);result={message:m};}

 if(fields.action==='search')result={items:window.people.filter(p=>p.name.includes(fields.query))};
 if(fields.action==='recommend')result={items:[window.people[2]]};
 if(fields.action==='request'){applyFriends({...state,outgoing:[...state.outgoing,fields.targetId]});result={pending:true};}
 if(fields.action==='accept'){applyFriends({...state,friends:[...state.friends,window.people[1]],requests:[]});result={accepted:true};}
 if(fields.action==='reject'){applyFriends({...state,requests:[]});result={ignored:true};}
 if(fields.action==='remove'){applyFriends({...state,friends:state.friends.filter(player=>player.id!==fields.targetId)});result={removed:true};}
 if(fields.action==='profile')result={player:window.people.find(p=>p.id===fields.targetId),items:[]};
 if(fields.action==='respond'){
  if(fields.accept&&window.reserve){applyFriends({...state,invitations:state.invitations.map(i=>({...i,status:'reserved'}))});result={reserved:true};}
  else if(fields.accept)result={join:{serverId:'main',code:'ABCD'}};
  else{applyFriends({...state,invitations:[]});result={ignored:true};}
 }
 return {t:'friends.result',action:fields.action,result};
};
data.setContent({id:'friends-fixture',values:new Map([['chess',[]],['assets',{}],['backups',{units:{}}],['config',{}]])});
window.room={code:'ABCD',mode:'coop',difficulty:'NORMAL',ranked:true,hostId:'p_self',capacity:4,inMatch:false,
 seats:[{seat:0,playerId:'p_self',profileId:self,name:'本人博士',connected:true,ready:false,rank:rank.rank},{seat:1,playerId:'p_other',profileId:applicant,name:'申请博士',connected:true,ready:false,rank:rank.rank},null,null]};
serversState.set({directory:{current:'main',servers:[{id:'main',name:'华东',origin:location.origin,url:location.origin}]}});
function App({kind}){const [closed,setClosed]=useState(false);return h('div',null,
kind==='room'?h(RoomScreen):kind==='lobby'?h(LobbyScreen):!closed?h(FriendsHall,{onClose:()=>{window.friendsClosed=true;setClosed(true)}}):null,h(FriendInvitationHost));}
window.mount=(kind='friends')=>{render(null,document.getElementById('app'));window.friendsClosed=false;window.calls=[];
store.set({session:{entered:true},connection:{status:'online',ping:30},me:{playerId:'p_self',name:'本人博士'},rank,room:kind==='room'?window.room:null,match:emptyMatch(),spectator:null});
applyFriends({...window.initial});render(h(App,{kind}),document.getElementById('app'));};
window.mount();window.ready=true;
</script></body></html>`;

test('friend UI supports all tabs, persistent dots, rank reuse, room return paths, invite menus and responsive layouts', { skip: enabled ? false : 'set RENDER_E2E=1 with Chrome' }, async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  const server = http.createServer((req,res) => {
    const url = new URL(req.url,'http://localhost').pathname;
    if(url==='/_friends_fixture'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(fixture);}
    const file=path.resolve(ROOT,(url.startsWith('/shared/')||url.startsWith('/data/')?'.':'public/.')+url);
    if(!file.startsWith(ROOT+path.sep)){res.writeHead(403);return res.end();}
    fs.readFile(file,(err,body)=>{if(err){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream'});res.end(body);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const out=path.join(ROOT,'.cache/friends-20261031');fs.mkdirSync(out,{recursive:true});
  const errors=[],evidence=[];let browser;
  try{
    browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox','--disable-background-networking']});
    const page=await browser.newPage();page.on('pageerror',error=>{errors.push(error.message);process.stderr.write(error.message+'\n');});page.setDefaultTimeout(10000);
    await page.setViewport({width:1920,height:1080});
    await page.goto('http://127.0.0.1:'+server.address().port+'/_friends_fixture');await page.waitForFunction(()=>window.ready);
    await page.waitForSelector('.friends-card');
    assert.deepEqual(await page.$$eval('.friends-tabs button',els=>els.map(el=>el.textContent.trim())),['好友列表','添加好友','好友申请','推荐好友']);
    assert.ok((await page.$eval('.friends-card',el=>el.textContent)).includes('同盟模拟（2/4）'));
    assert.equal(await page.$$eval('.friends-card__actions button',els=>els.some(el=>el.textContent==='观战')),true);
    await page.mouse.move(1800,900);
    assert.deepEqual(await page.$eval('.friends-tabs .friends-dot',el=>({opacity:getComputedStyle(el).opacity,visible:getComputedStyle(el).visibility})),{opacity:'1',visible:'visible'});
    await page.click('.friends-card__identity');await page.waitForSelector('.east-ranked');
    assert.equal(await page.$$eval('.east-ranked__start',els=>els.length),0,'friend rank uses the real rank hall without create controls');
    assert.equal(await page.$eval('.rank-history__account b',el=>el.textContent),'好友博士');
    await page.$$eval('.east-ranked__tools button',els=>els.find(el=>el.textContent.includes('全服排行榜')).click());
    await page.waitForSelector('.rank-leaderboard-screen__row.is-self');
    assert.equal(await page.$eval('.rank-leaderboard-screen__row.is-self .rank-leaderboard-screen__name',el=>el.textContent),'好友博士');
    await page.click('.proto-back');await page.waitForSelector('.east-ranked');await page.click('.proto-back');await page.waitForSelector('.friends-hall');
    await page.$$eval('.friends-card__actions button',els=>els.find(el=>el.textContent==='删除好友').click());
    await page.waitForFunction(()=>!document.querySelector('.friends-card'));
    assert.ok(await page.evaluate(()=>window.calls.some(call=>call.action==='remove'&&call.targetId==='2'.repeat(32))));
    assert.equal(await page.$eval('.friends-main__head .num',el=>el.textContent),'0');
    await page.evaluate(()=>window.mount());await page.waitForSelector('.friends-card');
    await page.$$eval('.friends-tabs button',els=>els.find(el=>el.textContent==='添加好友').click());
    await page.type('#friends-search-name','推荐');await page.click('.friends-search button');await page.waitForFunction(()=>document.querySelector('.friends-card__name')?.textContent==='推荐博士');
    await page.click('.friends-card__actions button');await page.waitForFunction(()=>document.querySelector('.friends-card__actions button')?.textContent==='已申请');
    await page.$$eval('.friends-tabs button',els=>els.find(el=>el.textContent==='好友申请').click());
    await page.waitForFunction(()=>document.querySelector('.friends-card__name')?.textContent==='申请博士');
    await page.$$eval('.friends-card__actions button',els=>els.find(el=>el.textContent==='接受').click());
    await page.waitForFunction(()=>document.querySelector('.friends-list')?.textContent.includes('暂无好友申请'));
    assert.equal(await page.$$eval('.friends-tabs .friends-dot',els=>els.length),0);
    await page.$$eval('.friends-tabs button',els=>els.find(el=>el.textContent==='推荐好友').click());
    await page.waitForSelector('.friends-card');assert.equal(await page.$eval('.friends-card__name',el=>el.textContent),'推荐博士');
    for(const viewport of [{width:1920,height:1080,name:'desktop'},{width:844,height:390,name:'mobile-landscape'},{width:375,height:812,name:'mobile-portrait'}]){
      await page.setViewport({width:viewport.width,height:viewport.height});await page.evaluate(()=>window.mount());await page.waitForSelector('.friends-card');
      const layout=await page.evaluate(()=>{const r=document.querySelector('.friends-list').getBoundingClientRect();return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,list:{top:r.top,bottom:r.bottom,height:r.height},dots:[...document.querySelectorAll('.friends-dot')].map(el=>getComputedStyle(el).opacity)};});
      assert.equal(layout.overflow,false,viewport.name+' no horizontal overflow');assert.ok(layout.list.height>80);assert.ok(layout.list.bottom<=viewport.height+1);assert.deepEqual(layout.dots,['1']);
      await page.screenshot({path:path.join(out,'friends-'+viewport.name+'.png')});evidence.push({viewport,layout});
    }
    await page.setViewport({width:1920,height:1080});await page.evaluate(()=>window.mount('room'));await page.waitForSelector('.friends-room-button');
    await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));});
    await page.click('.rseat__invite');await page.waitForSelector('.friends-menu');
    assert.deepEqual(await page.$$eval('.friends-tabs button',els=>els.map(el=>el.textContent)),['好友申请','好友列表']);
    assert.ok(await page.$$eval('.friends-card__actions button',els=>els.some(el=>el.textContent==='观战')));
    assert.ok((await page.$$eval('.friends-card__actions button',els=>els.map(el=>el.textContent))).includes('预约好友'));
    assert.equal(await page.$$eval('.friends-card__actions button',els=>els.some(el=>el.textContent==='删除好友')),false);
    await page.click('.friends-card__identity');await page.waitForSelector('.east-ranked');await page.click('.proto-back');await page.waitForSelector('.friends-menu');
    assert.equal(await page.$$eval('.room-screen',els=>els.length),1,'rank back preserves room screen');
    await page.$$eval('.friends-tabs button',els=>els.find(el=>el.textContent==='好友申请').click());await page.waitForFunction(()=>document.querySelector('.friends-card__name')?.textContent==='申请博士');
    await page.click('.friends-back');await page.waitForFunction(()=>!document.querySelector('.friends-menu'));
    await page.click('.rseat__player-open');await page.waitForSelector('.friends-player-actions');
    assert.deepEqual(await page.$$eval('.friends-player-actions button',els=>els.map(el=>el.textContent)),['添加好友','查看玩家战绩']);
    await page.$$eval('.friends-player-actions button',els=>els.find(el=>el.textContent==='查看玩家战绩').click());await page.waitForSelector('.east-ranked');await page.click('.proto-back');await page.waitForFunction(()=>!document.querySelector('.east-ranked'));
    assert.equal(await page.$$eval('.room-screen',els=>els.length),1);
    for(const viewport of [{width:1920,height:1080,name:'desktop'},{width:844,height:390,name:'mobile-landscape'},{width:667,height:375,name:'small-landscape'}]){
      await page.setViewport({width:viewport.width,height:viewport.height});await page.evaluate(()=>window.mount('room'));await page.waitForSelector('.friends-room-button');
      const layout=await page.evaluate(()=>{const button=document.querySelector('.friends-room-button'),r=button.getBoundingClientRect();const overlap=[...document.querySelectorAll('.rs-tools button,.rs-exit,.rs-key button')].filter(el=>el!==button).filter(el=>{const q=el.getBoundingClientRect();return q.width&&q.height&&r.left<q.right&&r.right>q.left&&r.top<q.bottom&&r.bottom>q.top;}).map(el=>el.getAttribute('aria-label'));return {r:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},overlap};});
      assert.deepEqual(layout.overlap,[],viewport.name+' friends button does not overlap controls');assert.ok(layout.r.left>=0&&layout.r.right<=viewport.width+1);
      await page.evaluate(async()=>{const {friendsStore,applyFriends}=await import('/js/friends.js');applyFriends({...friendsStore.get(),friends:Array.from({length:16},(_,i)=>({...window.people[0],id:(100+i).toString(16).padStart(32,'0'),name:'好友博士'+(i+1),presence:i%3?{state:'online'}:window.people[0].presence}))});});
      await page.click('.friends-room-button');await page.waitForSelector('.friends-menu');
      const menu=await page.$eval('.friends-menu',el=>{const r=el.getBoundingClientRect(),list=el.querySelector('.friends-list');return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,list:list.getBoundingClientRect().height,scrollable:list.scrollHeight>list.clientHeight,avatar:el.querySelector('.avatar').getBoundingClientRect().width,text:getComputedStyle(el.querySelector('.friends-card__name')).fontSize};});
      assert.ok(menu.left>=0&&menu.right<=viewport.width+1&&menu.bottom<=viewport.height+1,viewport.name+' menu fits viewport');assert.ok(menu.list>=80);
      assert.ok(menu.right-menu.left<=320);assert.ok(menu.avatar<=32);assert.equal(menu.text,'12px');assert.equal(menu.scrollable,true,'long friend list can scroll');
      await page.$eval('.friends-list',el=>{el.scrollTop=el.scrollHeight;});
      assert.ok(await page.$eval('.friends-list',el=>{const a=el.lastElementChild.getBoundingClientRect(),b=el.getBoundingClientRect();return a.bottom<=b.bottom+1;}),'last friend remains reachable');
      await page.$eval('.friends-list',el=>{el.scrollTop=0;});
      await page.evaluate(()=>Promise.allSettled([...document.querySelectorAll('img')].map(img=>img.decode())));
      await page.screenshot({path:path.join(out,'room-'+viewport.name+'.png')});evidence.push({viewport,layout,menu});
    }
    await page.setViewport({width:1920,height:1080});await page.evaluate(()=>window.mount('lobby'));await page.waitForSelector('.friends-entry');
    assert.equal(await page.$$eval('.hub-tile',els=>els.some(el=>el.textContent.includes('密钥加入'))),false);
    assert.equal(await page.$$eval('.friends-entry .friends-dot',els=>els.length),1);
    await page.click('.friends-entry');await page.waitForSelector('.friends-hall');
    await page.evaluate(()=>{window.reserve=true;const state=window.initial;window.invite={id:'f'.repeat(32),from:window.people[0],modeName:'同盟模拟',kind:'reservation',status:'pending',expiresAt:Date.now()+120000};import('/js/friends.js').then(m=>m.applyFriends({...state,invitations:[window.invite]}));});
    await page.waitForSelector('.friends-invite-text');assert.equal(await page.$eval('.friends-invite-text',el=>el.textContent),'好友好友博士邀请您加入同盟模拟模式房间');
    await page.$$eval('.modal__actions button',els=>els.find(el=>el.textContent==='确定').click());
    await page.waitForFunction(()=>!document.querySelector('.friends-invite-text'));
    await page.evaluate(async()=>{const {friendsStore,applyFriends}=await import('/js/friends.js');window.reserve=false;applyFriends({...friendsStore.get(),invitations:[{...window.invite,status:'ready'}]});});
    await page.waitForSelector('.friends-invite-text');
    await page.click('.friends-mute input');await page.$$eval('.modal__actions button',els=>els.find(el=>el.textContent==='忽略').click());
    await page.waitForFunction(()=>!document.querySelector('.friends-invite-text'));
    assert.ok(await page.evaluate(()=>window.calls.some(call=>call.action==='respond'&&call.mute===true&&call.accept===false)));
    await page.evaluate(async()=>{window.mount('friends');const cache=await import('/js/friendMessageCache.js');await cache.saveFriendMessages('1'.repeat(32),'2'.repeat(32),[{seq:1,id:'old-local',from:'2'.repeat(32),text:'两天前保存在本机的消息',at:Date.now()-2*86400000}]);});
    await page.waitForSelector('.friends-card');
    await page.$$eval('.friends-card__actions button',els=>els.find(el=>el.textContent.trim()==='私信').click());
    await page.waitForFunction(()=>document.querySelector('.friend-chat__messages')?.textContent.includes('两天前保存在本机的消息'));
    await page.type('.friend-chat textarea','<b>测试私信</b>');await page.click('.friend-chat__compose button');
    await page.waitForFunction(()=>document.querySelector('.friend-chat__messages')?.textContent.includes('<b>测试私信</b>'));
    assert.equal(await page.$$eval('.friend-chat__message p b',els=>els.length),0,'private messages render as plain text');
    await page.setViewport({width:844,height:390});
    await page.screenshot({path:path.join(ROOT,'.cache/friends-pm-20261031/private-mobile.png')});
    assert.equal(await page.$eval('.friend-chat',el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1&&r.right<=innerWidth+1;}),true,'chat fits mobile landscape');
    await page.reload();await page.waitForFunction(()=>window.ready);await page.waitForSelector('.friends-card');
    await page.$$eval('.friends-card__actions button',els=>els.find(el=>el.textContent.trim()==='私信').click());
    await page.waitForFunction(()=>document.querySelector('.friend-chat__messages')?.textContent.includes('两天前保存在本机的消息'));
    assert.equal(await page.evaluate(async()=>(await(await import('/js/friendMessageCache.js')).localFriendMessages('9'.repeat(32),'2'.repeat(32))).items.length),0,'another account cannot read this account local history');
    await page.setViewport({width:1440,height:900});await page.screenshot({path:path.join(ROOT,'.cache/friends-pm-20261031/private-desktop.png')});
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'browser-evidence.json'),JSON.stringify({errors,evidence},null,2));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
