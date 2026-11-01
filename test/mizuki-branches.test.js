import test from 'node:test';
import assert from 'node:assert/strict';
import { MizukiCombat } from '../server/modes/mizuki/Combat.js';
const route = (col) => ({ motion: 'WALK', start: [9, col], end: [9, 3],
  checkpoints: [{ type: 'WAIT', time: 100, pos: [9, col] }] });
const action = (routeIndex, count = 1) => ({ actionType: 'SPAWN', key: 'enemy_1007_slime',
  routeIndex, count, interval: .2, preDelay: .1 });
const wave = (count = 1) => ({ preDelay: 0, postDelay: 0, maxTimeWaitingForNextWave: -1,
  fragments: [{ preDelay: 0, actions: [action(0, count)] }] });
const create = (extra = {}) => new MizukiCombat({ seed: 12, stageId: 'act1autochess_m02', content: 'none',
  rect: { r0: 9, r1: 12, c0: 2, c1: 10 }, players: [{ playerId: 'p1', units: [] }],
  officialLevel: { routes: [route(9)], extraRoutes: [route(5), route(6)], waves: [wave()],
    branches: { box: { phases: [{ preDelay: .2, actions: [action(0)] }, { preDelay: .2, actions: [action(1, 2)] }] } } },
  officialWaveOptions: { supportedBranchKeys: ['box'] }, ...extra });
const step = (c, t) => { while (!c.done && c.time < t) c.step(); };

test('explicit branch chooses one original phase and uses extraRoutes and native delays', () => {
  const c=create();c.step();
  const result=c.officialWaves.triggerBranch('box',{phaseIndex:1,blockGameFinish:true});
  assert.equal(result.ok,true);assert.equal(result.scheduledCount,2);
  assert.equal(c.officialWaves.snapshot().unsupported.length,0);
  step(c,.31);assert.equal(c.battle.enemies.filter((e)=>e.tag?.startsWith('mizuki:branch:')).length,0);
  step(c,.56);const children=c.battle.enemies.filter((e)=>e.tag?.startsWith('mizuki:branch:'));
  assert.equal(children.length,2);assert.ok(children.every((e)=>e.x===6));
  assert.equal(c.battle.total,3);assert.equal(c.battle.errorCount,0);
});

test('native random branch phase has no repetition inside one loop and is deterministic', () => {
  const a=create(),b=create();a.step();b.step();
  const pick=(c)=>c.officialWaves.triggerBranch('box',{random:true,notRepeatInOneLoop:true}).phaseIndex;
  const first=Array.from({length:8},()=>pick(a));const second=Array.from({length:8},()=>pick(b));
  assert.deepEqual(first,second);
  for(let i=0;i<8;i+=2)assert.deepEqual(new Set(first.slice(i,i+2)),new Set([0,1]));
  assert.equal(a.officialWaves.triggerBranch('missing').error,'BRANCH_MISSING');
  assert.equal(a.officialWaves.triggerBranch('box',{phaseIndex:9}).error,'BRANCH_PHASE_MISSING');
});

test('nonblocking branch timers do not hold a cleared battle and blocking branch timers do', () => {
  const a=create();a.step();
  a.officialWaves.triggerBranch('box',{phaseIndex:0,blockGameFinish:false});
  step(a,.15);for(const e of a.battle.enemies)a.battle.kill(e);
  step(a,.2);assert.equal(a.done,true);assert.equal(a.battle.enemies.filter((e)=>e.tag?.startsWith('mizuki:branch:')).length,0);
  const b=create();b.step();b.officialWaves.triggerBranch('box',{phaseIndex:0,blockGameFinish:true});
  step(b,.15);for(const e of b.battle.enemies)b.battle.kill(e);
  step(b,.2);assert.equal(b.done,false);step(b,.4);
  assert.equal(b.battle.enemies.filter((e)=>e.alive).length,1);
});

test('finishCurrentWave releases original living-enemy gate without killing or deleting native waves', () => {
  const c=create({officialLevel:{routes:[route(9)],waves:[wave(),wave()]}});
  step(c,.2);assert.equal(c.officialWaves.waveIndex,0);
  const first=c.battle.enemies[0];
  assert.equal(c.officialWaves.finishCurrentWave({source:first}).ok,true);
  step(c,.4);assert.equal(c.officialWaves.waveIndex,1);assert.equal(first.alive,true);
  assert.equal(c.battle.enemies.length,2);assert.equal(c.battle.total,2);
  assert.equal(c.officialWaves.snapshot().waveReleases[0].sourceId,first.id);
  assert.equal(c.battle.errorCount,0);
});
