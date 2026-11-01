// Native facility models use their own verified library and renderer instance.
// Static MeshAnimator prefabs have no controller/clips: hold their authored pose.
import { DeviceView, UnitView } from './render/units.js';
import { OfficialFx } from './render/vfx/system.js';
import { FxLibrary } from './render/vfx/library.js';
import { Effect } from './render/vfx/effect.js';
import { createMizukiFxFetch } from './mizukiFx.js';
import { cachedFetch } from './resourceCache.js';

export function mizukiFacilityGraphic(facility, theme) {
  if (!facility) return null;
  if (facility.spineKey) return { type: 'spine', key: facility.spineKey };
  const key = facility.themeSkins?.[theme] || facility.defaultSkin;
  const skin = key ? facility.skins?.[key] : facility.root;
  return facility.meshAvailable && skin?.meshes?.length ? { type: 'mesh', key: skin.key, path: skin.path } : { type: 'empty' };
}

export async function attachMizukiFacilities(raw, { facilityLibrary, facilityFxLibrary, mapThemes }, { fetchFn = cachedFetch } = {}) {
  if (!facilityLibrary?.facilities || !facilityFxLibrary?.groups) return null;
  const ctx = raw.debug?.ctx, base = raw.debug?.ofx;
  if (!ctx || !base) return null;
  const lib = new FxLibrary({ list: facilityFxLibrary, fetch: createMizukiFxFetch(facilityFxLibrary, { fetchFn }) });
  await lib.init();
  const layer = new OfficialFx({ ...base.ctx, lib, tier: 'full' });
  ctx.layers.vfxGround.addChild(layer.ground, layer.over);
  const entries = new Set(), missing = new Set(), prepViews = new Map();
  const clearPrep = () => { for (const view of prepViews.values()) view.destroy(); prepViews.clear(); };
  let disposed = false, stage = null, theme = null;
  const position = view => {
    const z = raw.debug.tiles.heightAt(Math.round(view.y), Math.round(view.x)) || 0;
    return { pos: [view.x - 10, view.y - 9, -z], groundZ: -z };
  };
  function create(info) {
    const facility = facilityLibrary.facilities[info.defId];
    if (!facility || info.kind !== 'device') return null;
    const graphic = mizukiFacilityGraphic(facility, theme);
    if (graphic.type === 'spine' && ctx.assets.spineEntry(graphic.key)) {
      return new UnitView(ctx, { ...info, kind: 'token', spine: graphic.key }, { prep: false });
    }
    const view = new DeviceView(ctx, info);
    // Generic crates and their break particles are not an official facility skin.
    view.box?.destroy(); view.box = { update() {}, destroy() {} }; view.turret = false; view.gfx.visible = false;
    view.die = () => { if (view.alive) { view.alive = false; view.dying = .001; } };
    const entry = { view, graphic, effect: null, dead: false }; entries.add(entry);
    if (graphic.type === 'mesh') {
      lib.preload([graphic.key]).then(() => {
        if (disposed || entry.dead || view.destroyed) return;
        const def = lib.def(graphic.key);
        if (!def || !lib.ready(graphic.key, false)) { missing.add(info.defId + ':' + graphic.key); return; }
        const fx = new Effect(def, { lib, seed: 1 });
        fx.place(position(view)); fx.update(0);
        entry.effect = fx; layer.effects.push(fx);
      }).catch(() => missing.add(info.defId + ':' + graphic.key));
    } else if (facility.spineKey || facility.root.scripts.some(name => name.includes('Spine'))) missing.add(info.defId + ':original-spine');
    const update = view.update.bind(view), destroy = view.destroy.bind(view);
    view.update = (...args) => {
      update(...args);
      if (entry.effect) { entry.effect.place(position(view)); entry.effect.hidden = !view.alive || !!view.remove; }
    };
    view.destroy = () => {
      if (entry.dead) return; entry.dead = true;
      entry.effect?.kill(); entries.delete(entry); destroy();
    };
    return view;
  }
  ctx.mizukiFacilityFactory = create;
  const setStage = raw.setStage.bind(raw);
  raw.setStage = value => { clearPrep(); stage = value; theme = mapThemes?.stages?.[value?.id?.replace(/:mizuki-prep$/, '')]?.theme || value?.nativeTheme || value?.theme || null; return setStage(value); };
  const enterBattle = raw.enterBattle.bind(raw);
  raw.enterBattle = meta => { clearPrep(); theme = mapThemes?.stages?.[meta?.stageId || stage?.id]?.theme || meta?.nativeTheme || meta?.theme || stage?.nativeTheme || stage?.theme || null; return enterBattle(meta); };
  const tick = () => {
    if (disposed) return;
    layer.setGround((r, c) => raw.debug.tiles.heightAt(r, c), stage);
    layer.frameStats(); layer.update(0);
  };
  raw.debug.app.ticker.add(tick, null, -23);
  const destroy = raw.destroy.bind(raw);
  raw.destroy = () => {
    if (disposed) return; disposed = true; raw.debug.app.ticker.remove(tick); clearPrep();
    if (ctx.mizukiFacilityFactory === create) delete ctx.mizukiFacilityFactory;
    for (const entry of entries) { entry.dead = true; entry.effect?.kill(); } entries.clear();
    layer.destroy(); lib.destroy(); destroy();
  };
  const api = { setPreparation: (infos) => {
    const live = new Set();
    for (const info of infos || []) {
      if (info.kind !== 'device' || info.hidden || info.alive === false || mizukiFacilityGraphic(facilityLibrary.facilities[info.defId], theme)?.type !== 'mesh') continue;
      live.add(info.id);
      let view = prepViews.get(info.id);
      if (!view) { view = create(info); if (view) prepViews.set(info.id, view); }
      view?.setWorld(info.x, info.y, raw.debug.tiles.heightAt(Math.round(info.y), Math.round(info.x)) || 0);
    }
    for (const [id, view] of prepViews) if (!live.has(id)) { view.destroy(); prepViews.delete(id); }
  }, stats: () => ({ models: [...entries].filter(entry => entry.effect && entry.view.alive).length, prepModels:prepViews.size, missing: [...missing], graphics: [...entries].map(entry => ({ id: entry.view.info.defId, graphic: entry.graphic, alive: entry.view.alive })), renderer: layer.stats() }) };
  raw.debug.mizukiFacilities = api;
  return api;
}
