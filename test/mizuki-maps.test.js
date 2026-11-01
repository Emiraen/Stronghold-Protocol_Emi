import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mizukiMapChunks, mizukiNativeSceneMaterial, mizukiNativeRenderState } from '../public/js/mizukiMaps.js';
import { sceneMaterial } from '../public/js/render/board3d/materials.js';

const node = (id, parent, extra = {}) => ({ id, parent, active:true, pos:[0,0,0], rot:[0,0,0,1], scale:[1,1,1], ...extra });
const source = () => ({ key:'original', materials:{0:{shader:'Torappu/Scene/Standard',textures:{}}}, nodes:[
  node(1,null,{name:'BATTLE',pos:[10,20,3]}),
  node(2,1,{name:'MapGraphic',behaviours:[{class:'MapGraphic'}]}),
  node(3,2,{name:'Tiles',sourceTransformPathId:'300'}),
  node(4,3,{behaviours:[{class:'Tile'}]}),
  node(5,3,{pos:[0,2,0],behaviours:[{class:'Tile'}]}),
  node(6,2,{pos:[100,100,100],meshFilter:'combined',meshRenderer:{materials:[0],native:{m_StaticBatchRoot:{m_PathID:'300'},m_StaticBatchInfo:{firstSubMesh:1,subMeshCount:1},m_LightmapIndex:0,m_LightmapTilingOffset:{x:.5,y:.25,z:.1,w:.2}}}}),
] });
const meshes = { combined:{positions:[2,0,0,3,0,0,2,1,0,9,9,9],normals:[0,0,-1,0,0,-1,0,0,-1,0,0,-1],uv0:[0,0,1,0,0,1,1,1],uv1:[.2,.4,.6,.8,1,1,0,0],submeshes:[[3,3,3],[0,1,2]]} };

test('original scene transforms preserve source rows and selected static-batch submesh and baked UV', () => {
  const built=mizukiMapChunks(THREE,source(),meshes,{shift:2,lightmaps:[{index:0}]});
  assert.equal(built.rowCount,3);assert.equal(built.chunks.length,1);
  const chunk=built.chunks[0];
  assert.deepEqual([...chunk.index],[0,2,1]);assert.equal(chunk.sourceWindingReversed,true);
  assert.deepEqual([...chunk.position.slice(0,9)],[2,2,0,3,2,0,2,3,0]);
  assert.equal(chunk.sourceSubmesh,1);assert.equal(chunk.lightmap,0);
  assert.ok(Math.abs(chunk.uv1[0]-.2)<1e-6);assert.ok(Math.abs(chunk.uv1[1]-.4)<1e-6);
  assert.deepEqual([...chunk.normal.slice(0,3)],[0,0,127]);
});

test('world-space static batch does not apply the original object scale or baked lightmap ST twice', () => {
  const descriptor=source(),renderer=descriptor.nodes.at(-1);
  descriptor.nodes[0].pos=[0,0,0];renderer.scale=[.01,.01,.01];
  renderer.meshRenderer.native.m_StaticBatchRoot={m_PathID:'0'};
  const chunk=mizukiMapChunks(THREE,descriptor,meshes,{shift:2,lightmaps:[{index:0}]}).chunks[0];
  assert.deepEqual([...chunk.position.slice(0,9)],[2,2,0,3,2,0,2,3,0]);
  assert.ok(Math.abs(chunk.uv1[1]-.4)<1e-6);
});

test('disabled original renderers and inactive ancestors stay hidden', () => {
  const disabled=source();disabled.nodes.at(-1).meshRenderer.native.m_Enabled=0;
  assert.equal(mizukiMapChunks(THREE,disabled,meshes).chunks.length,0);
  const inactive=source();inactive.nodes[1].active=false;
  assert.equal(mizukiMapChunks(THREE,inactive,meshes).chunks.length,0);
  const shadowsOnly=source();shadowsOnly.nodes.at(-1).meshRenderer.native.m_CastShadows=3;
  assert.equal(mizukiMapChunks(THREE,shadowsOnly,meshes).chunks.length,0);
});

test('each submesh keeps only referenced vertices without losing authored vertex RGBA or triangles', () => {
  const native=structuredClone(meshes);native.combined.colors=[1,0,.5,1,.25,.5,1,.5,0,1,0,0,1,1,1,1];
  const chunk=mizukiMapChunks(THREE,source(),native).chunks[0];
  assert.equal(chunk.position.length,9);assert.equal(chunk.index.length,3);
  assert.deepEqual([...chunk.color],[255,0,128,255,64,128,255,128,0,255,0,0]);
});

test('original additive map light beam stays transparent and uses original pass and vertex colour', () => {
  const info={shader:'Legacy Shaders/Particles/Additive',passes:[{blend:['SrcAlpha','One','SrcAlpha','One'],blendOp:'Add',zWrite:false,zTest:'LessEqual',cull:'Off',colorMask:14}],colors:{_TintColor:[.052,.057,.073,.897]},textures:{_MainTex:{st:[1,1,0,0]}}};
  const material=sceneMaterial(THREE,{info,map:{}},{});
  mizukiNativeRenderState(THREE,material,info);
  assert.equal(material.transparent,true);assert.equal(material.depthWrite,false);
  assert.equal(material.blendSrc,THREE.SrcAlphaFactor);assert.equal(material.blendDst,THREE.OneFactor);
  assert.equal(material.side,THREE.DoubleSide);assert.equal(material.colorWrite,true);
  assert.deepEqual(material.uniforms.uColor.value.toArray(),info.colors._TintColor);
  assert.match(material.vertexShader,/vMizukiColor = aColor/);
  assert.match(material.fragmentShader,/vMizukiColor \* uColor/);
  assert.equal(material.userData.mizukiNativeParticle,true);
  material.dispose();
});

test('raw RGBM alpha remains an illumination multiplier and separate shadowmask owns shadow', () => {
  const original='light += lm.rgb * uLmScale; shade = lm.a;\nvec3 nt = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;';
  const material={fragmentShader:original,uniforms:{uLm:{value:{}},uNormal:{value:{}}},userData:{}};
  const shadow={source:'native shadowmask'};
  assert.equal(mizukiNativeSceneMaterial(material,{shader:'Torappu/Scene/Standard'},shadow),true);
  assert.match(material.fragmentShader,/5\.0 \* lm\.a \* lm\.rgb/);
  assert.match(material.fragmentShader,/shade = texture2D\(uMizukiShadowMask, vLm\)\.r/);
  assert.match(material.fragmentShader,/packedNormal\.r \* packedNormal\.a/);
  assert.equal(material.uniforms.uMizukiShadowMask.value,shadow);
  assert.equal(mizukiNativeSceneMaterial(material,{shader:'Torappu/Scene/Standard'},shadow),false);
  const water={fragmentShader:original,uniforms:{},userData:{}};
  assert.equal(mizukiNativeSceneMaterial(water,{shader:'Torappu/Scene/StandardWater'}),false);
  assert.equal(water.fragmentShader,original);
});

test('bloom and snow materials use native RGBM instead of the decoded lightmap compatibility path', () => {
  for (const shader of ['Torappu/Scene/StandardBloom', 'Standard']) {
    const info = { shader, colors:{_Color:[1,1,1,1]}, floats:{}, keywords:[] };
    const material = sceneMaterial(THREE, { info, map:{}, lightMap:{}, normalMap:{}, env:{}, lightEncoding:'gamma', lightRange:5 }, {});
    const basis = new THREE.Matrix3().set(1,0,0,0,1,0,0,0,-1);
    assert.equal(mizukiNativeSceneMaterial(material, info, null, basis), true, shader);
    assert.match(material.fragmentShader, /5\.0 \* lm\.a \* lm\.rgb/);
    assert.match(material.fragmentShader, /packedNormal\.r \* packedNormal\.a/);
    assert.match(material.fragmentShader, /uMizukiEnvWorldFromBoard \* rd/);
    assert.equal(material.uniforms.uMizukiEnvWorldFromBoard.value, basis);
    material.dispose();
  }
});
