import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mizukiCameraProjection } from '../public/js/mizukiCamera.js';
import { Camera } from '../public/js/render/projection.js';
const library=JSON.parse(fs.readFileSync(new URL('../public/assets/mizuki/native-cameras/cameras.json',import.meta.url)));
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
test('all 97 official stages use original camera position, 40-degree optics and unchanged source rotation',()=>{
 let count=0;for(const id of Object.keys(library.stages)){
  const source=library.scenes[library.stages[id]],projection=mizukiCameraProjection(library,{id},{width:1600,height:900}),camera=new Camera(projection.params);
  Object.values(camera.position()).forEach((v,i)=>near(v,source.boardPosition[i]));
  near(camera.threeParams(1600,900).fov,40);near(projection.clip.near,library.camera.near);near(projection.clip.far,library.camera.far);count++;
 }assert.equal(count,97);
});
test('original height/width adaptation adds the Controller offset in source-world axes',()=>{
 const id='ro2_n_4_5',p=mizukiCameraProjection(library,{id},{width:1440,height:1000});
 const t=(1000/1440-9/16)/(3/4-9/16),offset=library.camera.aspectAdaptation._toLocalPosition;
 near(p.source.aspectRatio,t);near(p.source.position[0],4.5);near(p.source.position[1],-2.6+t*offset.y);near(p.source.position[2],9.76-t*offset.z);
 assert.equal(mizukiCameraProjection(library,{id:id+':mizuki-prep'},{width:1440,height:1000}),null);
 assert.throws(()=>mizukiCameraProjection(null,{id},{width:1440,height:1000}),/unavailable/);
});
