// Read-only scene audit: release each scene's geometry before loading the next.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { mizukiMapChunks } from '../public/js/mizukiMaps.js';

const base = new URL('../public/assets/mizuki/native-maps/', import.meta.url);
const read = url => JSON.parse(readFileSync(url, 'utf8'));
const manifest = read(new URL('manifest.json', base));
const loaderFile=new URL('../public/js/mizukiMaps.js',import.meta.url);
const loaderSha256=createHash('sha256').update(readFileSync(loaderFile)).digest('hex');
const issues = [], scenes = [];
const totals = { scenes:0, mapRoots:0, chunks:0, triangles:0, windingReversedChunks:0, disabledRenderers:0, inactiveRenderers:0, staticBatchRenderers:0, lightmappedChunks:0, prepChunks:0, positionArrays:0, finitePositions:0, sourcePositionChecks:0, sourceNormalChecks:0, sourceColoredChunks:0, nonWhiteColorChunks:0, nonWhiteVertices:0 };
const usedTextureKeys = new Set(), materialTextureKeys = new Set();
const bounds = () => ({ min:[Infinity,Infinity,Infinity], max:[-Infinity,-Infinity,-Infinity] });
const grow = (box, array, index) => { for(let axis=0;axis<3;axis++){const value=array[index*3+axis];box.min[axis]=Math.min(box.min[axis],value);box.max[axis]=Math.max(box.max[axis],value);} };
const check = (ok, message, context) => {if(!ok)issues.push({message,...context});};
const finite = values => {for(const value of values)if(!Number.isFinite(value))return false;return true;};
const pngRecord = record => record?.path?.endsWith('.png')&&!record.path.includes('/half/')&&record.w>0&&record.h>0;
const publicFile = path => new URL('../public/'+path.replace(/^\//,''),import.meta.url);

function verifySourceTextures() {
  const originals=manifest.groups['scene/textures'],full=manifest.groups['scene/texture-fullres']||{};
  for(const [key,source]of Object.entries(originals)){
    const record=full[key];check(pngRecord(record),'Original full-resolution PNG missing',{key});
    if(!record)continue;
    check(record.w===source.w&&record.h===source.h,'Source texture dimensions changed',{key});
    const bytes=readFileSync(publicFile(record.path));
    check(createHash('sha256').update(bytes).digest('hex')===record.sha256,'Fullres texture SHA mismatch',{key});
    check(bytes.readUInt32BE(16)===source.w&&bytes.readUInt32BE(20)===source.h,'PNG dimensions mismatch',{key});
  }
  return{originalKeys:Object.keys(originals).length,fullresKeys:Object.keys(full).length};
}

function auditScene(sceneId, entry) {
  const scene=read(new URL(entry.file,base));
  const originalLevel=read(new URL('../data/mizuki/levels/'+sceneId+'.json',import.meta.url));
  const report={scene:sceneId,chunks:0,triangles:0,prepChunks:0,mapRoots:0,rowCount:0,expectedRows:originalLevel.mapData.map.length,lightmapSlots:scene.lightmaps.length,lightmapIndices:[],disabledRenderers:0,inactiveRenderers:0,staticBatchRenderers:0,sourceColoredChunks:0,nonWhiteColorChunks:0,nonWhiteVertices:0,bounds:bounds(),allVertexBounds:bounds(),textures:0,materials:0};
  const lmIndices=new Set(),sceneTextures=new Set(),materialsUsed=new Set();
  for(const rootEntry of scene.roots){
    const descriptor=read(new URL('fx/'+rootEntry.file,base));
    const graphic=descriptor.nodes.find(node=>node.behaviours?.some(item=>item.class==='MapGraphic'));
    if(!graphic)continue;
    report.mapRoots++;
    const nodes=new Map(descriptor.nodes.map(node=>[node.id,node]));
    const transformNodes=new Map(descriptor.nodes.filter(node=>node.sourceTransformPathId).map(node=>[String(node.sourceTransformPathId),node]));
    const world=new Map();
    const matrix=node=>{
      if(world.has(node.id))return world.get(node.id);
      const local=new THREE.Matrix4().compose(new THREE.Vector3(...node.pos),new THREE.Quaternion(...node.rot),new THREE.Vector3(...node.scale));
      const parent=nodes.get(node.parent),value=parent?matrix(parent).clone().multiply(local):local;
      world.set(node.id,value);return value;
    };
    const tiles=descriptor.nodes.find(node=>node.name==='Tiles');
    // The physical scene keeps the original Tile +Y orientation. Logical server
    // top-down row mirroring is confined to Mizuki's input/output adapter.
    const convert=new THREE.Matrix4().set(1,0,0,0,0,1,0,0,0,0,-1,0,0,0,0,1).multiply(matrix(tiles).clone().invert());
    const active=node=>{for(let current=node;current;current=nodes.get(current.parent))if(current.active===false)return false;return true;};
    const below=node=>{for(let current=node;current;current=nodes.get(current.parent))if(current.id===graphic.id)return true;return false;};
    const disabled=node=>node.meshRenderer?.native?.m_Enabled===false||node.meshRenderer?.native?.m_Enabled===0||node.meshRenderer?.m_Enabled===false||node.meshRenderer?.enabled===false;
    const meshes={};
    for(const key of descriptor.meshes)meshes[key]=read(publicFile(manifest.groups['scene/meshes'][key].path));
    for(const node of descriptor.nodes){
      if(!node.meshRenderer||!below(node))continue;
      if(disabled(node))report.disabledRenderers++;
      if(!active(node))report.inactiveRenderers++;
      if(node.meshRenderer.native?.m_StaticBatchInfo?.subMeshCount>0)report.staticBatchRenderers++;
    }
    const built=mizukiMapChunks(THREE,descriptor,meshes,{shift:0,lightmaps:scene.lightmaps});
    const prep=mizukiMapChunks(THREE,descriptor,meshes,{shift:2,lightmaps:scene.lightmaps});
    report.rowCount=built.rowCount;report.prepChunks+=prep.chunks.length;report.chunks+=built.chunks.length;
    check(built.rowCount===report.expectedRows,'Runtime map row count differs from original level',{scene:sceneId,root:descriptor.key,actual:built.rowCount,expected:report.expectedRows});
    check(prep.chunks.length===built.chunks.length,'Prep geometry chunk count differs from combat',{scene:sceneId,root:descriptor.key});
    const arrays=new Set();
    for(let chunkIndex=0;chunkIndex<built.chunks.length;chunkIndex++){
      const chunk=built.chunks[chunkIndex],node=nodes.get(chunk.sourceNode),mesh=meshes[node?.meshFilter],context={scene:sceneId,node:node?.name,nodeId:chunk.sourceNode,submesh:chunk.sourceSubmesh};
      check(Boolean(node&&mesh),'Chunk source node/mesh missing',context);
      if(!node||!mesh)continue;
      check(active(node),'Inactive source node is rendered',context);check(!disabled(node),'Disabled native renderer is rendered',context);check(below(node),'Geometry outside original MapGraphic',context);
      const sourceIndices=mesh.submeshes[chunk.sourceSubmesh],vertexCount=chunk.position.length/3;
      check(Array.isArray(sourceIndices),'Native source submesh missing',context);
      check(Number.isInteger(vertexCount)&&vertexCount>0,'Empty or invalid vertex count',context);
      check(chunk.index.length>0&&chunk.index.length%3===0,'Invalid triangle index count',context);check(chunk.index.length===sourceIndices?.length,'Runtime/source index count mismatch',context);
      const remap=new Map(),sourceVertices=[],sourceLocals=[];
      if(sourceIndices)for(let i=0;i<sourceIndices.length;i++){
        const source=sourceIndices[i];let local=remap.get(source);
        if(local===undefined){local=sourceVertices.length;remap.set(source,local);sourceVertices.push(source);}
        sourceLocals.push(local);
        if(!Number.isInteger(source)||source<0||source>=mesh.positions.length/3||chunk.index[i]>=vertexCount){check(false,'Source topology differs after runtime vertex compaction',{...context,indexOffset:i,source,runtime:chunk.index[i],expected:local,vertexCount});break;}
      }
      check(sourceVertices.length===vertexCount,'Runtime compaction omits or adds referenced vertices',{...context,sourceVertices:sourceVertices.length,vertexCount});
      if(!arrays.has(chunk.position)){arrays.add(chunk.position);totals.positionArrays++;totals.finitePositions+=vertexCount;check(finite(chunk.position),'Non-finite runtime position',context);for(let i=0;i<vertexCount;i++)grow(report.allVertexBounds,chunk.position,i);}
      check(finite(chunk.uv)&&finite(chunk.uv1),'Non-finite UV',context);check(chunk.normal.length===vertexCount*4&&chunk.color.length===vertexCount*4&&chunk.uv.length===vertexCount*2&&chunk.uv1.length===vertexCount*2,'Runtime attribute length mismatch',context);
      for(const index of chunk.index)grow(report.bounds,chunk.position,index);
      const native=node.meshRenderer.native||{},batched=native.m_StaticBatchInfo?.subMeshCount>0;
      const batchRoot=transformNodes.get(String(native.m_StaticBatchRoot?.m_PathID??0));
      const basis=convert.clone().multiply(batched?(batchRoot?matrix(batchRoot):new THREE.Matrix4()):matrix(node));
      const normalBasis=new THREE.Matrix3().getNormalMatrix(basis),expectedPosition=new THREE.Vector3(),expectedNormal=new THREE.Vector3();
      const reversed=basis.determinant()<0;
      check(chunk.sourceWindingReversed===reversed,'Native triangle winding does not match coordinate-basis parity',context);
      if(reversed)totals.windingReversedChunks++;
      for(let index=0;index<chunk.index.length;index++){
        const slot=index%3,offset=index-slot+(reversed?(slot===1?2:slot===2?1:0):slot),expected=sourceLocals[offset];
        if(chunk.index[index]!==expected){check(false,'Original triangle topology differs after parity-preserving winding conversion',{...context,indexOffset:index,expected,actual:chunk.index[index],reversed});break;}
      }
      const st=batched?{x:1,y:1,z:0,w:0}:native.m_LightmapTilingOffset||{x:1,y:1,z:0,w:0};
      let nonWhiteVertices=0;
      if(mesh.colors?.length)report.sourceColoredChunks++;
      for(let local=0;local<vertexCount;local++){
        const source=sourceVertices[local];let nonWhite=false;
        expectedPosition.fromArray(mesh.positions,source*3).applyMatrix4(basis);
        expectedNormal.fromArray(mesh.normals?.length?mesh.normals:[0,0,-1],mesh.normals?.length?source*3:0).applyNormalMatrix(normalBasis);
        totals.sourcePositionChecks++;totals.sourceNormalChecks++;
        for(let axis=0;axis<3;axis++){
          if(Math.abs(chunk.position[local*3+axis]-expectedPosition.getComponent(axis))>1e-4){check(false,'Original position differs in physical +TileY board basis',{...context,vertex:local,sourceVertex:source,axis});break;}
          if(chunk.normal[local*4+axis]!==Math.round(expectedNormal.getComponent(axis)*127)){check(false,'Original normal differs in physical +TileY board basis',{...context,vertex:local,sourceVertex:source,axis});break;}
        }
        for(let component=0;component<4;component++){
          const value=mesh.colors?.length>source*4+3?Math.round(Math.max(0,Math.min(1,mesh.colors[source*4+component]))*255):255;
          if(value!==255)nonWhite=true;
          if(chunk.color[local*4+component]!==value){check(false,'Original vertex color or alpha differs in runtime',{...context,vertex:local,sourceVertex:source,component,expected:value,actual:chunk.color[local*4+component]});break;}
        }
        if(nonWhite)nonWhiteVertices++;
        for(let component=0;component<2;component++){
          const uv0=mesh.uv0?.[source*2+component]||0;
          const uv1=(mesh.uv1?.[source*2+component]??mesh.uv0?.[source*2+component]??0)*(component?st.y:st.x)+(component?st.w:st.z);
          if(Math.abs(chunk.uv[local*2+component]-uv0)>1e-5||Math.abs(chunk.uv1[local*2+component]-uv1)>1e-5){check(false,'Original UV or lightmap ST differs after vertex compaction',{...context,vertex:local,sourceVertex:source,component});break;}
        }
      }
      if(nonWhiteVertices){report.nonWhiteColorChunks++;report.nonWhiteVertices+=nonWhiteVertices;}
      if(batched&&sourceIndices?.length){
        const root=transformNodes.get(String(native.m_StaticBatchRoot?.m_PathID??0));
        const basis=convert.clone().multiply(root?matrix(root):new THREE.Matrix4());
        const vertex=sourceIndices[0],expected=new THREE.Vector3().fromArray(mesh.positions,vertex*3).applyMatrix4(basis);
        const actual=new THREE.Vector3().fromArray(chunk.position,0);
        check(expected.distanceTo(actual)<1e-4,'Static batch receives original renderer transform twice',{...context,expected:expected.toArray(),actual:actual.toArray()});
      }
      check(chunk.lightmap===-1||Number.isInteger(chunk.lightmap)&&chunk.lightmap>=0&&chunk.lightmap<scene.lightmaps.length,'Invalid runtime lightmap index',context);
      if(chunk.lightmap>=0){lmIndices.add(chunk.lightmap);totals.lightmappedChunks++;const slot=scene.lightmaps[chunk.lightmap];check(Boolean(slot?.textureKey&&manifest.groups['scene/texture-fullres'][slot.textureKey]),'Runtime lightmap lacks original fullres texture',context);}
      report.triangles+=chunk.index.length/3;materialsUsed.add(chunk.material);
      const material=built.materials[chunk.material];check(Boolean(material),'Chunk material missing',context);
      if(material){
        for(const key of[material.map,material.normalMap,material.glossMap,material.emissionMap].filter(Boolean)){if(key.startsWith('builtin:'))continue;sceneTextures.add(key);usedTextureKeys.add(key);check(pngRecord(manifest.groups['scene/texture-fullres'][key]),'Runtime material texture lacks original PNG',{...context,key});}
        for(const texture of Object.values(material.textures||{}))if(texture.tex&&!texture.tex.startsWith('builtin:')){materialTextureKeys.add(texture.tex);check(pngRecord(manifest.groups['scene/texture-fullres'][texture.tex]),'Custom shader texture lacks original PNG',{...context,key:texture.tex});}
      }
      const prepChunk=prep.chunks[chunkIndex];
      if(prepChunk)for(const vertex of[0,vertexCount-1])for(let axis=0;axis<3;axis++)check(Math.abs(prepChunk.position[vertex*3+axis]-chunk.position[vertex*3+axis]-(axis===1?2:0))<1e-5,'Prep geometry offset differs from two bench rows',{...context,vertex,axis});
    }
  }
  check(report.mapRoots>0&&report.chunks>0&&report.triangles>0,'Original scene is empty in actual loader',{scene:sceneId});
  check(finite(report.bounds.min)&&finite(report.bounds.max),'Non-finite scene bounds',{scene:sceneId});
  report.lightmapIndices=[...lmIndices].sort((a,b)=>a-b);report.textures=sceneTextures.size;report.materials=materialsUsed.size;
  for(const key of['mapRoots','chunks','triangles','disabledRenderers','inactiveRenderers','staticBatchRenderers','prepChunks','sourceColoredChunks','nonWhiteColorChunks','nonWhiteVertices'])totals[key]+=report[key];
  totals.scenes++;
  return report;
}

const fullresCoverage=verifySourceTextures();
for(const [sceneId,entry]of Object.entries(manifest.scenes)){scenes.push(auditScene(sceneId,entry));globalThis.gc?.();if(scenes.length%10===0)console.log(JSON.stringify({checked:scenes.length,total:Object.keys(manifest.scenes).length,issues:issues.length}));}
check(loaderSha256===createHash('sha256').update(readFileSync(loaderFile)).digest('hex'),'Runtime loader changed while auditing',{loader:loaderFile.pathname});
const result={ok:issues.length===0,loader:'public/js/mizukiMaps.js#mizukiMapChunks',loaderSha256,coordinateBasis:'physical=(Tiles.x,+Tiles.y,-Tiles.z); reverse triangle winding for odd-reflection basis; prep adds two rows; server logical row conversion stays at the Mizuki adapter boundary',three:THREE.REVISION,checkedAt:new Date().toISOString(),totals,fullresCoverage:{...fullresCoverage,runtimeMaterialTextureKeys:usedTextureKeys.size,originalMaterialTextureKeys:materialTextureKeys.size},issues,scenes};
const output=new URL('../.cache/mizuki-native-rules/map-runtime-audit.json',import.meta.url);mkdirSync(new URL('.',output),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({ok:result.ok,...totals,fullresCoverage:result.fullresCoverage,issues:issues.slice(0,12),report:output.pathname}));
if(issues.length)process.exitCode=1;
