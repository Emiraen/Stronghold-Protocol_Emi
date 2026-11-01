import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Match } from '../server/modes/zhajing/Match.js';
import { VirtualScheduler } from '../server/modes/zhajing/engine/server/match/scheduler.js';
import { createAssets } from '../public/js/assets.js';
import { withRosterAssets } from '../public/js/rosterAssets.js';

test('炸惊 external spectator can switch prep and combat targets through the native observer contract', t => {
  const frames=[];
  const m=new Match({scheduler:new VirtualScheduler(),mode:'coop',seed:18345,seats:[0,1].map(seat=>({seat,playerId:'p'+seat,name:'博士'+seat,connected:true,isBot:false})),send:(id,frame)=>{frames.push({id,frame});return true;},broadcast(){},onEnd(){},botRehearsal:0});
  t.after(()=>m.dispose());m.round=1;m.phase='PREP';m.addObserver('watcher');
  assert.deepEqual(m.watchObserver('watcher','n:p1','p1'),{ok:true});
  assert.ok(frames.some(x=>x.id==='watcher'&&x.frame.t==='m.field'&&x.frame.fieldId==='n:p1'));
  assert.ok(!frames.some(x=>x.id==='watcher'&&x.frame.t==='m.private'));
  assert.equal(m.watchObserver('unknown','n:p1').error,'NOT_IN_ROOM');
  assert.ok(m.watchObserver('watcher','n:missing').error);
  m.clientCombat=true;m.phase='NORMAL';m.fields=[{fieldId:'n:p1',players:['p1'],cc:true,battleId:'test',startAt:0,done:false,spec:{players:[{playerId:'p1',contentInfo:{funds:123,other:true}}]}}];
  assert.deepEqual(m.watchObserver('watcher','n:p1','p1'),{ok:true});
  const start=frames.findLast(x=>x.id==='watcher'&&x.frame.t==='b.start').frame;
  assert.equal(start.authoritative,false);assert.equal(start.watch,true);assert.equal(start.spec.players[0].contentInfo.funds,undefined);
  m.removeObserver('watcher');assert.equal(m.watchObserver('watcher','n:p1').error,'NOT_IN_ROOM');
});

test('mode-only operators and substitutes resolve after normal assets loaded without replacing existing assets', () => {
  const base=withRosterAssets(JSON.parse(fs.readFileSync('data/assets.json'))),mode=JSON.parse(fs.readFileSync('data/zhajing/assets.json'));
  const a=createAssets({manifest:base});let changed=0;a.onChange(()=>changed++);
  const saved=a.spineEntry('char_002_amiya');
  assert.equal(a.spineEntry('char_4217_makoto'),null);
  assert.equal(a.extend(mode),true);
  for(const id of Object.keys(mode.chars).filter(id=>!base.chars[id]))assert.ok(a.spineEntry(id),id);
  for(const id of ['token_makoto_thanatos','token_makoto_orpheus'])assert.ok(a.tokenAvatar(id),id);
  const makoto=a.spineEntry('char_4217_makoto');assert.ok(makoto.animations['Doll_Skill_1_Idle']);assert.ok(makoto.animations['Doll_Skill_2_Loop']);
  assert.deepEqual(a.spineEntry('char_002_amiya'),saved);assert.equal(a.extend(mode),false);assert.equal(changed,1);
});
