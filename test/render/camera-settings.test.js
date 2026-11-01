import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { presetCamera, syncThreeCamera, pickTile } from '../../public/js/render/projection.js';
import { applyCameraSettings, sanitizeCameraSettings, DEFAULT_CAMERA_SETTINGS } from '../../public/js/render/cameraSettings.js';
import { sanitizeSettings } from '../../public/js/ui/gameLogic/settings.js';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
test('camera preferences default safely, clamp finite inputs and survive normal settings sanitizing', () => {
  assert.deepEqual(sanitizeCameraSettings(), DEFAULT_CAMERA_SETTINGS);
  assert.deepEqual(sanitizeCameraSettings({ cameraOffsetX: 400, cameraOffsetY: -400, cameraZoom: 0 }), { cameraOffsetX: 30, cameraOffsetY: -30, cameraZoom: 50 });
  assert.deepEqual(sanitizeCameraSettings({ cameraOffsetX: NaN, cameraOffsetY: Infinity, cameraZoom: '120' }), DEFAULT_CAMERA_SETTINGS);
  const settings = sanitizeSettings({ cameraOffsetX: 12, cameraOffsetY: -8, cameraZoom: 125 });
  assert.deepEqual(sanitizeCameraSettings(settings), { cameraOffsetX: 12, cameraOffsetY: -8, cameraZoom: 125 });
});
test('default preferences preserve exact camera parameters and user transform is a screen-space pan/zoom', () => {
  const viewport = { width: 1280, height: 720 }, baseline = presetCamera('normal', viewport);
  assert.deepEqual(applyCameraSettings(baseline.clone(), viewport, {}).params(), baseline.params());
  const camera = applyCameraSettings(baseline.clone(), viewport, { cameraOffsetX: 10, cameraOffsetY: -10, cameraZoom: 125 });
  for (const point of [[0,0,0],[3,1,.42],[9,12,0],[15,4,1.2]]) {
    const a=baseline.project(...point), b=camera.project(...point);
    near(b.x, 640+(a.x-640)*1.25+128); near(b.y, 360+(a.y-360)*1.25-72); near(b.s,a.s*1.25);
    const world=camera.unproject(b.x,b.y,point[2]);near(world.x,point[0]);near(world.y,point[1]);
  }
});
test('adjusted 3D, Pixi projection and tile picking agree across zoom and viewport limits', () => {
  for (const viewport of [{width:1440,height:1000},{width:844,height:390}]) for (const cameraZoom of [50,100,200]) {
    const camera=applyCameraSettings(presetCamera('normal',viewport),viewport,{cameraOffsetX:30,cameraOffsetY:-30,cameraZoom});
    const three=syncThreeCamera(camera,new THREE.PerspectiveCamera(),viewport.width,viewport.height);
    for (const [row,col,z] of [[0,3,0],[1,3,.42],[10,5,0]]) {
      const p=camera.project(col,row,z),q=new THREE.Vector3(col,row,z).project(three);
      near((q.x+1)*viewport.width/2,p.x);near((1-q.y)*viewport.height/2,p.y);
      const tile=pickTile(camera,p.x,p.y,()=>z,[z]);
      assert.equal(tile.row,row);assert.equal(tile.col,col);
    }
  }
});
