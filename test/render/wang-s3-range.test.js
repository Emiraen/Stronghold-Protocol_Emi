import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FxWiring } from '../../public/js/render/vfx/wiring.js';
import { compileEffect, Effect } from '../../public/js/render/vfx/effect.js';
import { FrameData, cameraBasis } from '../../public/js/render/vfx/geom.js';
import { rotateOffset } from '../../server/sim/dir.js';

const KEY='wang_skill_03_range_start';
const desc=JSON.parse(fs.readFileSync(new URL('../../public/assets/local/fx/prefabs/'+KEY+'.json',import.meta.url)));
const idx=JSON.parse(fs.readFileSync(new URL('../../public/assets/local/fx/index.json',import.meta.url)));
const def=compileEffect(desc);
const camera=cameraBasis(30,[0,-5,-10],900,40*Math.PI/180);
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-4,a+' != '+b);
// The source draws five-tile segments through the outer tile centres. Each
// extends half a tile beyond its corner; do not invent a second art offset.
const sides=[{center:[2,-2],axis:[5,0]},{center:[0,0],axis:[0,5]},
  {center:[2,2],axis:[-5,0]},{center:[4,0],axis:[0,-5]}];

for(const dir of ['RIGHT','UP','LEFT','DOWN']) for(const z of [0,1]) {
  test('Wang S3 square aligns with its 5x5 range facing '+dir+' on height '+z,()=>{
    const owner={id:7,x:5,y:8,z,dir,alive:true,info:{id:7,kind:'op',side:'ally',spine:'char_2027_wang',skillIndex:2}};
    const effects=[];
    const ofx={active:true,time:0,timers:[],ctx:{cam:()=>({tilt:30})},
      lib:{has:k=>k===KEY,def:k=>k===KEY?def:null},ready:k=>k===KEY,
      spawn:(key,place,opts)=>{const effect=new Effect(def,{seed:17});effect.place(place);effect.track=opts.track;
        const h={alive:true,stop(){this.alive=false;}};effects.push({effect,h});return h;}};
    const wiring=new FxWiring(ofx,{view:id=>id===7?owner:null});wiring.idx=idx;
    assert.equal(wiring.skill(owner,true),true);assert.equal(effects.length,1);
    const effect=effects[0].effect;for(let n=0;n<30;n++)effect.update(1/60);
    const border=[];
    for(const [i,node] of [23,24,27,28].entries()) {
      const fd=new FrameData(),g=effect.build({part:'ps',node},camera,fd,0);
      assert.equal(g.count,1);const q=fd.quad;
      const [r,c]=rotateOffset(sides[i].center[1],sides[i].center[0],dir);
      const [ar,ac]=rotateOffset(sides[i].axis[1],sides[i].axis[0],dir);
      near(q[0]+10,owner.x+c);near(q[1]+9,owner.y+r);near(-q[2],z);
      near(q[3],ac);near(q[4],ar);near(q[5],0);
      border.push({x:q[0]+10,y:q[1]+9,ax:q[3],ay:q[4]});
    }
    // Every boundary tile of the actual S3 range lies on a frame segment.
    for(let dr=-2;dr<=2;dr++)for(let dc=0;dc<=4;dc++)if(Math.abs(dr)===2||dc===0||dc===4){
      const [r,c]=rotateOffset(dr,dc,dir),x=owner.x+c,y=owner.y+r;
      assert.ok(border.some(b=>Math.abs((x-b.x)*b.ay-(y-b.y)*b.ax)<1e-4&&Math.hypot(x-b.x,y-b.y)<=2.5+1e-4),'missing range border '+[r,c]);
    }
    // A displaced owner carries the square through the existing shared tracker.
    owner.x+=1;owner.y+=1;effect.update(1/60);
    near(effect.anchor[0],owner.x-10);near(effect.anchor[1],owner.y-9);near(effect.anchor[2],-z);
    // This is the authored cast-start range flash, stopped by the cast timer.
    assert.equal(ofx.timers.length,1);near(ofx.timers[0].at,.6);
    ofx.timers[0].fn();assert.equal(effects[0].h.alive,false);
  });
}
test('range pivot correction preserves authored files and other official prefabs',()=>{
  assert.deepEqual(desc.nodes[23].particleSystemRenderer.m_Pivot,[.4,0,0]);
  const other=compileEffect({...desc,key:'unchanged-other-effect'});
  assert.deepEqual(other.psr[23].pivot,[.4,0,0]);
  assert.deepEqual(def.psr[23].pivot,[-.4,-0,-0]);
});
