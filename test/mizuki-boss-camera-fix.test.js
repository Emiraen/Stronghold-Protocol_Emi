import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mizukiPresetCamera } from '../public/js/mizukiProjection.js';
import { presetCamera } from '../public/js/render/projection.js';

const bosses = ['5-1', '5-2', '6-1', '6-2'];
for (const id of bosses) for (const [width, height] of [[1920,1080],[1280,720],[844,390],[667,375],[390,844]]) {
  test('native boss ' + id + ' fits its complete map at ' + width + 'x' + height, () => {
    const level = JSON.parse(fs.readFileSync(new URL('../data/mizuki/levels/level_rogue2_' + id + '.json', import.meta.url)));
    const rect = { r0:0, c0:0, r1:level.mapData.map.length - 1, c1:level.mapData.map[0].length - 1 };
    const viewport = { width, height, padding:{top:height*.16,bottom:height*.19,left:16,right:16} };
    const cam = mizukiPresetCamera('boss', viewport, { rect, side:'L' });
    const right = mizukiPresetCamera('hidden', viewport, { rect, side:'R', half:true });
    for (const x of [rect.c0-.5,rect.c1+.5]) for (const y of [rect.r0-.5,rect.r1+.5]) for (const z of [0,1.5]) {
      const p = cam.project(x,y,z), q = right.project(x,y,z);
      assert.ok(p.x >= 16 && p.x <= width-16, JSON.stringify(p));
      assert.ok(p.y >= height*.16 && p.y <= height*.81, JSON.stringify(p));
      assert.ok(Math.abs(p.x-q.x)<1e-9 && Math.abs(p.y-q.y)<1e-9, 'native map has no split boss halves');
    }
    assert.equal(cam.tx,(rect.c0+rect.c1)/2);
  });
}
test('ordinary Stronghold boss camera is unchanged', () => {
  const v={width:1920,height:1080},r={r0:0,r1:6,c0:0,c1:11};
  const ordinary=presetCamera('boss',v,{rect:r});
  const native=mizukiPresetCamera('boss',v,{rect:r});
  assert.notEqual(ordinary.tx,native.tx);
  assert.equal(native.tx,5.5);
});
