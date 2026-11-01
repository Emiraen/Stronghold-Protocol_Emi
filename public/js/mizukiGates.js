import { FxLibrary } from './render/vfx/library.js';
import { OfficialFx } from './render/vfx/system.js';
import { createMizukiFxFetch } from './mizukiFx.js';
import { cachedFetch } from './resourceCache.js';

export async function attachMizukiGates(raw, { gateLibrary, gatePlacements }, { fetchFn = cachedFetch } = {}) {
  if (!gateLibrary?.groups || !gatePlacements?.scenes) return null;
  const textures = Object.fromEntries(Object.keys(gateLibrary.groups['fx/tex'] || {}).map(key => {
    const fullres = gateLibrary.groups['fx/tex-fullres']?.[key];
    if (!fullres?.path) throw Error('Original full-resolution lossless gate texture unlisted: ' + key);
    return [key, fullres];
  }));
  const manifest = { ...gateLibrary, groups: { ...gateLibrary.groups, 'fx/tex': textures } };
  const lib = new FxLibrary({ list: manifest, fetch: createMizukiFxFetch(manifest, { fetchFn }) });
  await lib.init();
  const descriptor = lib.descriptor.bind(lib);
  lib.descriptor = async key => {
    const source = await descriptor(key); if (!source) return null;
    // GenerateTileEffect/CreateEffect sets the root world position to the tile.
    // In particular tile_end's authored -1.293 x is not added to that position.
    return { ...source, nodes: source.nodes.map(node => node.id === source.root ? { ...node, pos: [0,0,0] } : node) };
  };
  const layer = new OfficialFx({ ...raw.debug.ofx.ctx, lib, tier: 'full' });
  // The native gate frame and warning icon must occlude units crossing the
  // entrance/exit. Both authored gate passes belong above the unit layer.
  raw.debug.ctx.layers.vfxOver.addChild(layer.ground, layer.over);
  let stage = null, generation = 0, disposed = false, board = null, loaded = false;
  let placementKey = null, reused = 0;
  const errors = [], placements = [];
  const suppressDuplicate = () => {
    const current = raw.debug.board3d;if(!current || current === board)return;board=current;
    board._buildGates = () => {};
    if(board.stage){board.stageKey=null;board.setStage(board.stage);}
  };
  const setStage = raw.setStage.bind(raw);
  raw.setStage = value => {
    stage=value;
    const result=setStage(value), id=value?.id?.replace(/:mizuki-prep$/,'');
    const shift=value?.id?.endsWith(':mizuki-prep')?2:0;
    const gates=gatePlacements.scenes[gatePlacements.stages[id]]?.gates||[];
    const layout=gates.map(gate=>{
      const row=(value.nativeVisualRows?gate.sceneRow:gate.gridRow)+shift,col=gate.gridCol;
      return {gate,row,col,z:raw.debug.tiles.heightAt(row,col)||0};
    });
    // Deployments and facility snapshots can submit the same stage again.
    // Keep the running gate instances and their animation time in that case.
    const key=JSON.stringify([id,shift,layout.map(({gate,row,col,z})=>[gate.effect,row,col,z])]);
    if(key===placementKey){reused++;return result;}
    placementKey=key;loaded=false;const token=++generation;layer.clear();placements.length=0;
    lib.preload([...new Set(gates.map(gate=>gate.effect))]).then(()=>{
      if(disposed||token!==generation)return;
      for(const {gate,row,col,z} of layout){
        const handle=layer.spawn(gate.effect,{pos:[col-10,row-9,-z],groundZ:-z},{loop:true,important:true});
        if(!handle){errors.push('Original gate unavailable: '+gate.effect);continue;}
        placements.push({effect:gate.effect,row,col,sourceNode:gate.node,sourceRow:gate.sceneRow,sourceCol:gate.sceneCol,rootPositionOverridden:true,rotation:'original-prefab'});
      }loaded=true;
    }).catch(error=>{if(!disposed&&token===generation){placementKey=null;errors.push(error.message);}});
    return result;
  };
  const tick=()=>{if(disposed)return;suppressDuplicate();layer.setGround((r,c)=>raw.debug.tiles.heightAt(r,c),stage);layer.frameStats();layer.update(document.hidden?0:Math.min(.1,(raw.debug.app.ticker.elapsedMS||0)/1000));};
  raw.debug.app.ticker.add(tick,null,-21);
  const destroy=raw.destroy.bind(raw);raw.destroy=()=>{if(disposed)return;disposed=true;generation++;raw.debug.app.ticker.remove(tick);layer.destroy();lib.destroy();destroy();};
  const api={stats:()=>({loaded,revision:generation,reused,placements:[...placements],errors:[...errors],fullResolution:true,aboveUnits:layer.ground.parent===raw.debug.ctx.layers.vfxOver&&layer.over.parent===raw.debug.ctx.layers.vfxOver,renderer:layer.stats()})};raw.debug.mizukiGates=api;return api;
}
