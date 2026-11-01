import { createMizukiFxFetch } from './mizukiFx.js';
import { syncThreeCamera } from './render/projection.js';
import { buildBoard } from './render/board3d/layout.js';
import { sceneMaterialKey } from './render/board3d/load.js';
import { assets as sharedAssets } from './assets.js';
import { cachedFetch } from './resourceCache.js';

const ptr = value => String(value?.m_PathID ?? 0);
const sourceId = stage => stage?.id?.replace(/:mizuki-prep$/, '');
const shiftOf = stage => stage?.id?.endsWith(':mizuki-prep') ? 2 : 0;

export function mizukiMapMaterial(material, key) {
  const tex = name => material.textures?.[name]?.tex;
  return { ...material, key, map: tex('_MainTex'), normalMap: tex('_BumpMap'), glossMap: tex('_MetallicGlossMap'), emissionMap: tex('_EmissionMap') };
}

/** The scene includes transparent mesh light beams, not opaque tile materials. */
export function mizukiNativeRenderState(THREE, material, info) {
  if(material.userData.mizukiNativeState)return;
  const pass=info?.passes?.[0];if(!pass)return;
  const factors={Zero:THREE.ZeroFactor,One:THREE.OneFactor,SrcColor:THREE.SrcColorFactor,OneMinusSrcColor:THREE.OneMinusSrcColorFactor,DstColor:THREE.DstColorFactor,OneMinusDstColor:THREE.OneMinusDstColorFactor,SrcAlpha:THREE.SrcAlphaFactor,OneMinusSrcAlpha:THREE.OneMinusSrcAlphaFactor,DstAlpha:THREE.DstAlphaFactor,OneMinusDstAlpha:THREE.OneMinusDstAlphaFactor,SrcAlphaSaturate:THREE.SrcAlphaSaturateFactor};
  if(pass.blend){
    const [src,dst,srcAlpha,dstAlpha]=pass.blend;
    material.transparent=src!=='One'||dst!=='Zero';
    material.blending=material.transparent?THREE.CustomBlending:THREE.NoBlending;
    material.blendSrc=factors[src];material.blendDst=factors[dst];
    material.blendSrcAlpha=factors[srcAlpha]??material.blendSrc;material.blendDstAlpha=factors[dstAlpha]??material.blendDst;
    material.blendEquation={Add:THREE.AddEquation,Subtract:THREE.SubtractEquation,RevSub:THREE.ReverseSubtractEquation,Min:THREE.MinEquation,Max:THREE.MaxEquation}[pass.blendOp]??THREE.AddEquation;
    material.blendEquationAlpha=material.blendEquation;
  }
  material.depthWrite=pass.zWrite===true||pass.zWrite===1;
  material.depthTest=!['Disabled','Always'].includes(pass.zTest);
  material.depthFunc={Never:THREE.NeverDepth,Less:THREE.LessDepth,Equal:THREE.EqualDepth,LessEqual:THREE.LessEqualDepth,Greater:THREE.GreaterDepth,NotEqual:THREE.NotEqualDepth,GreaterEqual:THREE.GreaterEqualDepth,Always:THREE.AlwaysDepth}[pass.zTest]??THREE.LessEqualDepth;
  material.side=pass.cull==='Off'?THREE.DoubleSide:pass.cull==='Front'?THREE.BackSide:THREE.FrontSide;
  material.colorWrite=pass.colorMask!==0;material.needsUpdate=true;
  material.userData.mizukiNativeState={...pass};
  if(!['Legacy Shaders/Particles/Additive','Torappu/Particles/Additive','Torappu/Particles/AlphaBlend'].includes(info.shader))return;
  // The same basic original particle computation used by the existing VFX port:
  // 2 * texture * authored vertex RGBA * _TintColor, with the original pass.
  material.vertexShader='attribute vec4 aColor; varying vec4 vMizukiColor;\n'+material.vertexShader.replace('void main() {','void main() {\n  vMizukiColor = aColor;');
  const tint=info.colors?._TintColor||[1,1,1,1],st=info.textures?._MainTex?.st||[1,1,0,0];
  material.uniforms.uColor.value.set(...tint);material.uniforms.uMizukiMainTexST={value:new THREE.Vector4(...st)};
  material.fragmentShader='varying vec4 vMizukiColor; uniform vec4 uMizukiMainTexST;\n'+material.fragmentShader.slice(0,material.fragmentShader.indexOf('void main() {'))+[
    'void main() {',
    '  vec4 t = texture2D(uMap, vUv * uMizukiMainTexST.xy + uMizukiMainTexST.zw);',
    '  vec4 c = 2.0 * vec4(toDisplay(t.rgb), t.a) * vMizukiColor * uColor;',
    '  gl_FragColor = vec4(toLinear(max(c.rgb, vec3(0.0))) * focusMask(vWorld.xy), clamp(c.a, 0.0, 1.0));',
    '  #include <colorspace_fragment>',
    '}',
  ].join('\n');
  material.userData.mizukiNativeParticle=true;
}

/** Original Standard GLES samples RGBM and DXT5nm before any re-encoding.
 * Keep the lossless source pages on the GPU; shadowmask R is a separate texture.
 * This extension belongs only to the Mizuki BoardScene instance. */
export function mizukiNativeSceneMaterial(material, info, shadowMap = null, envWorldFromBoard = null) {
  if (!/^(?:Standard|Torappu\/Scene\/Standard(?:RealtimeShadow|Bloom)?)$/.test(info?.shader || '') || material.userData.mizukiNativeEncoding) return false;
  let shader = material.fragmentShader;
  if (material.uniforms?.uLm?.value) {
    const token = 'light += lm.rgb * uLmScale; shade = lm.a;';
    if (!shader.includes(token)) throw Error('Original RGBM shader extension unavailable');
    shader = shader.replace(token, 'light += 5.0 * lm.a * lm.rgb; shade = ' + (shadowMap ? 'texture2D(uMizukiShadowMask, vLm).r;' : '1.0;'));
    if (shadowMap) {
      shader = 'uniform sampler2D uMizukiShadowMask;\n' + shader;
      material.uniforms.uMizukiShadowMask = { value: shadowMap };
    }
  }
  if (material.uniforms?.uNormal?.value) {
    const token = 'vec3 nt = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;';
    if (!shader.includes(token)) throw Error('Original packed normal shader extension unavailable');
    shader = shader.replace(token, 'vec4 packedNormal = texture2D(uNormal, vUv);\n        vec2 normalXY = vec2(packedNormal.r * packedNormal.a, packedNormal.g) * 2.0 - 1.0;\n        vec3 nt = vec3(normalXY, sqrt(max(0.0, 1.0 - dot(normalXY, normalXY))));');
  }
  if (material.uniforms?.uEnv?.value && envWorldFromBoard) {
    shader = 'uniform mat3 uMizukiEnvWorldFromBoard;\n' + shader.replace('vec3(rd.x, rd.y, -rd.z)', '(uMizukiEnvWorldFromBoard * rd)');
    material.uniforms.uMizukiEnvWorldFromBoard = { value: envWorldFromBoard };
  }
  material.fragmentShader = shader; material.needsUpdate = true;
  material.userData.mizukiNativeEncoding = { lightmap:'RGBM 5*A*RGB', shadow:shadowMap ? 'original shadowmask R' : 'no source shadowmask', normal:'Unity R*A/G packed normal' };
  return true;
}

/** Original renderer submeshes and TRS → the existing scene pack convention. */
export function mizukiMapChunks(THREE, descriptor, meshes, { shift = 0, lightmaps = [] } = {}) {
  const nodes = new Map(descriptor.nodes.map(node => [node.id, node]));
  const transformNodes = new Map(descriptor.nodes.filter(node => node.sourceTransformPathId).map(node => [String(node.sourceTransformPathId), node]));
  const graphic = descriptor.nodes.find(node => node.behaviours?.some(item => item.class === 'MapGraphic'));
  const tiles = descriptor.nodes.find(node => node.name === 'Tiles');
  if (!graphic || !tiles) return { chunks: [], materials: {}, rowCount: 0 };
  const world = new Map(), active = new Map();
  const matrix = node => {
    if (world.has(node.id)) return world.get(node.id);
    const local = new THREE.Matrix4().compose(new THREE.Vector3(...node.pos), new THREE.Quaternion(...node.rot), new THREE.Vector3(...node.scale));
    const parent = nodes.get(node.parent);
    const value = parent ? matrix(parent).clone().multiply(local) : local;
    world.set(node.id, value); active.set(node.id, node.active !== false && (!parent || active.get(parent.id))); return value;
  };
  descriptor.nodes.forEach(matrix);
  const tileNodes = descriptor.nodes.filter(node => node.behaviours?.some(item => item.class === 'Tile'));
  const rowCount = Math.max(...tileNodes.map(node => Number(node.pos[1]) + 1));
  const convert = new THREE.Matrix4().set(1,0,0,0, 0,1,0,shift, 0,0,-1,0, 0,0,0,1).multiply(matrix(tiles).clone().invert());
  const belowGraphic = node => { for (let next = node; next; next = nodes.get(next.parent)) if (next.id === graphic.id) return true; return false; };
  const chunks = [], materials = {}, seen = new Set();
  for (const node of descriptor.nodes) {
    const renderer = node.meshRenderer, mesh = meshes[node.meshFilter];
    if (!renderer || !mesh || !active.get(node.id) || renderer.m_Enabled === false || renderer.enabled === false || renderer.native?.m_Enabled === false || renderer.native?.m_Enabled === 0 || renderer.native?.m_CastShadows === 3 || !belowGraphic(node)) continue;
    const native = renderer.native || {}, batch = native.m_StaticBatchInfo;
    const count = batch?.subMeshCount > 0 ? batch.subMeshCount : renderer.materials.length;
    const first = batch?.subMeshCount > 0 ? batch.firstSubMesh : 0;
    const batchRoot = transformNodes.get(ptr(native.m_StaticBatchRoot));
    // Unity has already baked each static renderer's object TRS and lightmap ST
    // into the combined mesh. A null StaticBatchRoot means world coordinates.
    const basis = convert.clone().multiply(batch?.subMeshCount > 0 ? (batchRoot ? matrix(batchRoot) : new THREE.Matrix4()) : matrix(node));
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(basis);
    const st = batch?.subMeshCount > 0 ? { x:1, y:1, z:0, w:0 } : native.m_LightmapTilingOffset || { x:1, y:1, z:0, w:0 };
    for (let i=0; i<count; i++) {
      const submesh = first+i, indices = mesh.submeshes[submesh];
      const materialIndex = renderer.materials[Math.min(i,renderer.materials.length-1)], material = descriptor.materials[materialIndex];
      if (!indices?.length || !material) continue;
      const materialKey = descriptor.key+':'+materialIndex; materials[materialKey] = mizukiMapMaterial(material,materialKey);
      const signature = [node.meshFilter,submesh,materialKey, batch?.subMeshCount > 0 ? batchRoot?.id ?? 'world' : node.id].join(':');
      if (seen.has(signature)) continue; seen.add(signature);
      // A combined mesh may contain thousands of other renderers' vertices.
      // Preserve this renderer's full topology, but upload only referenced vertices.
      const remap=new Map(),sourceVertices=[],localIndices=[];
      for(const source of indices){let local=remap.get(source);if(local===undefined){local=sourceVertices.length;remap.set(source,local);sourceVertices.push(source);}localIndices.push(local);}
      const sourceWindingReversed=basis.determinant()<0;
      if(sourceWindingReversed)for(let t=0;t<localIndices.length;t+=3)[localIndices[t+1],localIndices[t+2]]=[localIndices[t+2],localIndices[t+1]];
      const n=sourceVertices.length,position=new Float32Array(n*3),normal=new Int8Array(n*4),color=new Uint8Array(n*4).fill(255),uv=new Float32Array(n*2),uv1=new Float32Array(n*2);
      const vector=new THREE.Vector3();
      for(let local=0;local<n;local++){
        const source=sourceVertices[local];
        vector.fromArray(mesh.positions,source*3).applyMatrix4(basis).toArray(position,local*3);
        vector.fromArray(mesh.normals?.length?mesh.normals:[0,0,-1],mesh.normals?.length?source*3:0).applyNormalMatrix(normalMatrix);
        for(let j=0;j<3;j++)normal[local*4+j]=Math.round(vector.getComponent(j)*127);
        if(mesh.colors?.length>source*4+3)for(let j=0;j<4;j++)color[local*4+j]=Math.round(Math.max(0,Math.min(1,mesh.colors[source*4+j]))*255);
        for(let j=0;j<2;j++){uv[local*2+j]=mesh.uv0?.[source*2+j]||0;uv1[local*2+j]=(mesh.uv1?.[source*2+j]??mesh.uv0?.[source*2+j]??0)*(j?st.y:st.x)+(j?st.w:st.z);}
      }
      const lm = native.m_LightmapIndex;
      const lightmap = Number.isInteger(lm) && lm>=0 && lm<lightmaps.length ? lm : -1;
      chunks.push({ material:materialKey,lightmap,group:'',position,normal,color,uv,uv1,index:n>65535?new Uint32Array(localIndices):new Uint16Array(localIndices), sourceNode:node.id,sourceSubmesh:submesh,sourceWindingReversed });
    }
  }
  return { chunks, materials, rowCount };
}

/** Native scene descriptors adapt to the ordinary board loader's cachedFetch / assets.image IO.
 * Only the two most recently prepared sources are retained; prep and combat share one source. */
export function createMizukiMapLoader(manifest, { fetchFn = cachedFetch, assets = sharedAssets, reflectionManifest = null } = {}) {
  const request = createMizukiFxFetch(manifest, { fetchFn });
  const reflectionRequest = reflectionManifest ? createMizukiFxFetch(reflectionManifest, { fetchFn }) : null;
  const sources = new Map();
  const json = async (path, io = request) => { const response = await io(path); if (!response.ok) throw Error('Original map unavailable: ' + path); return response.json(); };
  const image = async path => {
    // Ordinary assets.image reuses decoded images and required-resource cache, including its lossless WebP transport.
    const value = await assets.image(path, { retry: true });
    if (!value || !(value.width || value.naturalWidth)) throw Error('Original map image unavailable: ' + path);
    return value;
  };
  async function readSource(stageId) {
    const sceneId=manifest.stages[stageId], record=manifest.groups['scene/data'][sceneId];
    if(!record)throw Error('Original map scene not listed: '+stageId);
    const reflectionPromise = reflectionRequest ? (async () => {
      const record = reflectionManifest.scenes[sceneId];
      if (!record) throw Error('Original reflection scene unlisted: ' + sceneId);
      const reflection = await json(record.path, reflectionRequest);
      return { reflection, env: reflection.images?.env ? await image(reflection.images.env) : null };
    })() : Promise.resolve({ reflection: null, env: null });
    // Observe early rejection while scene metadata is loading.
    reflectionPromise.catch(() => {});
    const scene=await json(record.path);
    const descriptors=await Promise.all(scene.roots.map(root=>json(manifest.groups['scene/roots'][root.key].path)));
    const roots=descriptors.filter(root=>root.nodes.some(node=>node.behaviours?.some(item=>item.class==='MapGraphic')));
    const meshKeys=[...new Set(roots.flatMap(root=>root.meshes))], meshes={};
    await Promise.all(meshKeys.map(async key=>meshes[key]=await json(manifest.groups['scene/meshes'][key].path)));
    return { sceneId, scene, roots, meshes, reflection: await reflectionPromise, packs: new WeakMap() };
  }
  function prepare(stageId) {
    stageId = sourceId({ id: stageId });
    if (!stageId) return Promise.resolve(null);
    let promise = sources.get(stageId);
    if (promise) { sources.delete(stageId); sources.set(stageId, promise); return promise; }
    promise = readSource(stageId).catch(error => { if (sources.get(stageId) === promise) sources.delete(stageId); throw error; });
    sources.set(stageId, promise);
    while (sources.size > 2) sources.delete(sources.keys().next().value);
    return promise;
  }
  async function load(stageId, THREE, shift) {
    stageId = sourceId({ id: stageId });
    const source = await prepare(stageId);
    let packs = source.packs.get(THREE);
    if (!packs) { packs = new Map(); source.packs.set(THREE, packs); }
    if (packs.has(shift)) return packs.get(shift);
    // Preparation adds a uniform row offset. Keep the original topology, UVs,
    // materials and decoded images rather than rebuilding every native mesh.
    const work = shift ? load(stageId, THREE, 0).then(pack => ({ ...pack,
      key: 'mizuki-native:' + stageId + ':' + shift,
      chunks: pack.chunks.map(chunk => { const position = chunk.position.slice(); for (let i = 1; i < position.length; i += 3) position[i] += shift; return { ...chunk, position }; }),
      stats: { ...pack.stats, shift }
    })) : build(source, stageId, THREE, 0);
    const pending = work.catch(error => { if (packs.get(shift) === pending) packs.delete(shift); throw error; });
    packs.set(shift, pending);
    return pending;
  }
  async function build({ sceneId, scene, roots, meshes, reflection: reflectionSource }, stageId, THREE, shift) {
    const lightmaps=scene.lightmaps||[], chunks=[], materials={}; let rowCount=0;
    for(const root of roots){const built=mizukiMapChunks(THREE,root,meshes,{shift,lightmaps});chunks.push(...built.chunks);Object.assign(materials,built.materials);rowCount=built.rowCount;}
    if(!chunks.length)throw Error('Original map contains no drawable MapGraphic: '+stageId);
    const textureKeys=[...new Set(Object.values(materials).flatMap(material=>Object.values(material.textures||{}).map(texture=>texture.tex)).filter(Boolean))];
    const images={tex:{},data:{},lm:[]};
    await Promise.all([
    ...textureKeys.map(async key=>{const texture=manifest.groups['scene/texture-fullres']?.[key];if(!texture)throw Error('Original full-resolution lossless map texture unlisted: '+key);const value=await image(texture.path);images.tex[key]=value;images.data[key]=value;}),
    ...lightmaps.map(async lm=>{
      if(!lm.textureKey){images.lm[lm.index]=null;return;}
      const texture=manifest.groups['scene/texture-fullres']?.[lm.textureKey];
      if(!texture)throw Error('Original full-resolution RGBM page unlisted: '+lm.textureKey);
      await Promise.all([image(texture.path).then(value => { images.lm[lm.index]=value; }), (async () => { if(lm.shadowMaskKey){
        const mask=manifest.groups['scene/texture-fullres']?.[lm.shadowMaskKey];
        if(!mask)throw Error('Original full-resolution shadowmask unlisted: '+lm.shadowMaskKey);
        images.data[lm.shadowMaskKey]=await image(mask.path);
      } })()]);
    })]);
    let reflection=reflectionSource.reflection,envWorldFromBoard=null;
    if(reflection){
      if(reflectionSource.env)images.env=reflectionSource.env;
      const world=reflection.coordinateBasis?.tiles?.worldMatrix;
      if(world)envWorldFromBoard=new THREE.Matrix3().set(world[0][0],world[0][1],-world[0][2],world[1][0],world[1][1],-world[1][2],world[2][0],world[2][1],-world[2][2]);
      if(reflection.light?.dir)reflection={...reflection,light:{...reflection.light,dir:reflection.light.dir.map((v,i)=>i===1?-v:v)}};
    }
    const pack={key:'mizuki-native:'+stageId+':'+shift,modeSource:'mizuki-native-maps',stage:stageId,chunks,groups:{},images,doc:{materials,lightEncoding:'gamma',lightRange:5,source:sceneId,...(reflection?{env:reflection.env,light:reflection.light}:{})},original:scene,envWorldFromBoard,stats:{stageId,shift,meshes:chunks.length,textures:textureKeys.length,sourceRowCount:rowCount,lightmaps:images.lm.filter(Boolean).length,lightmapEncoding:'original RGBM GPU decode',shadowmasks:lightmaps.filter(lm=>lm.shadowMaskKey).length,reflection:reflection?.env?{source:reflection.env.source,cubemapKey:reflection.env.cubemapKey,mips:reflection.env.mips,intensityAlreadyApplied:reflection.env.intensityAlreadyApplied}:null,originalMainLight:reflection?.light?.source||null}};
    return pack;
  }
  return { prepare, load };
}

const sharedMapLoaders = new WeakMap();
export function mizukiMapLoader(manifest, { reflectionManifest = null } = {}) {
  if (!manifest?.scenes) return null;
  let cached = sharedMapLoaders.get(manifest);
  if (!cached || cached.reflectionManifest !== reflectionManifest) {
    cached = { reflectionManifest, loader: createMizukiMapLoader(manifest, { reflectionManifest }) };
    sharedMapLoaders.set(manifest, cached);
  }
  return cached.loader;
}

export async function attachMizukiMaps(raw, manifest, options = {}) {
  if (!manifest?.scenes) return null;
  const loader = options.fetchFn || options.assets ? createMizukiMapLoader(manifest, options) : mizukiMapLoader(manifest, options);
  let stage = null, board = null, generation = 0, disposed = false, loading = null;
  const errors = [], known = new Set();
  const stats = { originalScene:null, meshes:0, textures:0, fullResolution:true, sourceRowCount:0, lightmaps:0 };
  const attach = current => {
    board=current; const originalScene=board.setScenePack.bind(board),originalBuild=board._buildScene.bind(board),originalRender=board.render.bind(board);
    board.render=(cam,time)=>{
      if(cam?.mizukiOriginal){syncThreeCamera(cam,board.camera,board.size.w,board.size.h,cam.mizukiOriginal.clip);board.camRef=cam;board.camVersion=cam.version;}
      return originalRender(cam,time);
    };
    board.setScenePack=(id,pack)=>known.has(id)&&pack?.modeSource!=='mizuki-native-maps'?false:originalScene(id,pack);
    board._buildScene=pack=>{
      const ok=originalBuild(pack);
      if(ok&&pack?.modeSource==='mizuki-native-maps'){
        const res=board.sceneRes.get(pack.key);
        for(const chunk of pack.chunks){
          const info=pack.doc.materials[chunk.material],material=res.mats.get(sceneMaterialKey(chunk,info));
          const shadowKey=pack.original.lightmaps?.[chunk.lightmap]?.shadowMaskKey;
          if(material){mizukiNativeRenderState(board.THREE,material,info);mizukiNativeSceneMaterial(material,info,res.data[shadowKey]||null,pack.envWorldFromBoard);}
        }
        for(const [key,mesh]of Object.entries(board.meshes))if(key.startsWith('scene'))mesh.renderOrder=mesh.material.transparent?2:mesh.material.userData.blend==='cutout'?-3:-4;
      }
      if(ok&&board.stage?.id?.endsWith(':mizuki-prep')){
        const bench=buildBoard(board.stage,{uv:board.pack.uv,area:[{r0:0,r1:1,c0:0,c1:20}],platformMesh:false});
        board._mesh(bench.buckets.board,board.mat.board);board._mesh(bench.buckets.glass,board.mat.glass);
      }return ok;
    };
  };
  const tick = () => {
    if(disposed||!stage)return;const current=raw.debug.board3d;if(!current)return;
    if(board!==current){attach(current);loading=null;}
    const key=sourceId(stage)+':'+shiftOf(stage);
    if(loading===key)return;loading=key;const token=++generation,target=stage;
    const promise=loader.load(sourceId(stage),board.THREE,shiftOf(stage));
    promise.then(pack=>{if(disposed||token!==generation||stage!==target)return;known.add(target.id);board.setScenePack(target.id,pack);Object.assign(stats,pack.stats,{originalScene:pack.doc.source});}).catch(error=>{errors.push(error.message);console.error('[mizuki] original map failed',error);});
  };
  const setStage=raw.setStage.bind(raw);raw.setStage=value=>{stage=value;loading=null;generation++;if(stage)loader.prepare(sourceId(stage)).catch(()=>{});const result=setStage(value);tick();return result;};
  raw.debug.app.ticker.add(tick,null,-22);
  const destroy=raw.destroy.bind(raw);raw.destroy=()=>{if(disposed)return;disposed=true;generation++;raw.debug.app.ticker.remove(tick);destroy();};
  const api={stats:()=>({...stats,errors:[...errors]})};raw.debug.mizukiMaps=api;return api;
}
