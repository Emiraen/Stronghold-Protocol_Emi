// Mode-local data/art adapters. No global manifest, data store or renderer is patched.
import { useEffect, useState } from '../vendor/hooks.module.js';
import { mizukiAssets as assets } from './mizukiAssets.js';
import { data } from './data.js';
import { audio } from './audio.js';
import { guardView, hudPadding, hudBands, observeFieldGeometry } from './ui/fieldHost.js';
import { settingsStore } from './ui/settings.js';
import { createMizukiSpineCache, mizukiSpineEntry, adaptMizukiUnitView } from './mizukiSpine.js';
import { attachMizukiFx } from './mizukiFx.js';
import { prepareMizukiBoardAssets } from './mizukiBoard.js';
import { attachMizukiFacilities } from './mizukiFacilities.js';
import { attachMizukiMaps, mizukiMapLoader } from './mizukiMaps.js';
import { loadThree } from './render/board3d/load.js';
import { cachedFetch } from './resourceCache.js';
import { adaptMizukiCoordinates } from './mizukiCoordinates.js';
import { attachMizukiGates } from './mizukiGates.js';
import { adaptMizukiFieldScope } from './mizukiViewedField.js';

let pending;
export function loadMizukiRuntime() {
  if (!pending) pending = Promise.all([cachedFetch('/data/mizuki/runtime-ui.json'),
    cachedFetch('/assets/mizuki/library/manifest.json'), cachedFetch('/assets/mizuki/native-board/manifest.json'),
    cachedFetch('/assets/mizuki/native-facilities/manifest.json'), cachedFetch('/assets/mizuki/native-facilities/fx/manifest.json'),
    cachedFetch('/assets/mizuki/native-maps/manifest.json'), cachedFetch('/assets/mizuki/native-maps/themes.json'),
    cachedFetch('/assets/mizuki/native-gates/manifest.json'), cachedFetch('/assets/mizuki/native-gates/placements.json'),
    cachedFetch('/assets/mizuki/native-reflections/manifest.json'), cachedFetch('/assets/mizuki/native-cameras/cameras.json')]).then(async ([records, art, board, facilities, facilityFx, maps, themes, gates, placements, reflections, cameras]) => {
    if (!records.ok || !art.ok) throw new Error('Mizuki runtime data unavailable');
    return { ...await records.json(), assetsLibrary: await art.json(), boardLibrary: board.ok ? await board.json() : null,
      facilityLibrary: facilities.ok ? await facilities.json() : null, facilityFxLibrary: facilityFx.ok ? await facilityFx.json() : null,
      mapLibrary: maps.ok ? await maps.json() : null, mapThemes: themes.ok ? await themes.json() : null,
      gateLibrary: gates.ok ? await gates.json() : null, gatePlacements: placements.ok ? await placements.json() : null,
      reflectionLibrary: reflections.ok ? await reflections.json() : null, cameraLibrary:cameras.ok ? await cameras.json() : null };
  }).catch((error) => { pending = null; throw error; });
  return pending;
}

export function createMizukiLookups(base, runtime) {
  if (!runtime) return base;
  return { ...base,
    chess: (id) => runtime.chess?.[id] || base.chess(id),
    token: (id) => runtime.tokens?.[id] || base.token(id),
    list: (name) => name === 'chess' ? Object.values(runtime.chess || {})
      : name === 'tokens' ? Object.values(runtime.tokens || {}) : base.list(name),
  };
}

export function createMizukiData(base, runtime) {
  return {
    get: (name) => name === 'chess' ? runtime.chess : name === 'tokens' ? runtime.tokens : base.get(name),
    lookup: (name, id) => (name === 'chess' ? runtime.chess?.[id]
      : name === 'tokens' ? runtime.tokens?.[id] : null) || base.lookup(name, id),
  };
}

/** The ordinary board loader/cache warms the selected map before renderer setup. */
export function prepareMizukiStage(runtime, stageId) {
  const maps = mizukiMapLoader(runtime?.mapLibrary, { reflectionManifest: runtime?.reflectionLibrary });
  if (!maps || !stageId) return Promise.resolve(null);
  return Promise.all([maps.prepare(stageId), loadThree()])
    .then(([, THREE]) => THREE ? maps.load(stageId, THREE, 2) : null);
}

/** A private resolver delegates shared caches but does not change their manifest. */
export function createMizukiAssets(base, library) {
  const scoped = Object.create(base);
  const entries = new Map();
  scoped.spineEntry = (id, options) => {
    const entry = base.spineEntry(id, options) || library.spines?.[id] || null;
    if (id !== 'enemy_1271_nhkodo' && id !== 'enemy_2037_sygirl') return entry;
    if (!entries.has(id)) entries.set(id, mizukiSpineEntry(id, entry));
    return entries.get(id);
  };
  if (base.spine) scoped.spine = createMizukiSpineCache(base.spine);
  return scoped;
}

/** Rebuild a private stage from its source; inactive/absent facilities restore it. */
export function mizukiFacilityStage(stage, facilities) {
  if (!stage?.rows || !stage?.tiles) return stage;
  const active = (Array.isArray(facilities) ? facilities : []).filter(tile => tile.active !== false);
  if (!active.length) return stage;
  const rows = [...stage.rows], tiles = { ...stage.tiles };
  for (const tile of active) {
    const { row, col } = tile;
    if (!Number.isInteger(row) || !Number.isInteger(col) || !rows[row] || col < 0 || col >= rows[row].length) continue;
    const glyph = String.fromCharCode(0xf000 + row * 21 + col);
    const original = stage.tiles[stage.rows[row][col]] || {};
    tiles[glyph] = { ...original, buildable: tile.buildable, passable: tile.passable,
      groundPassable: !!tile.obstacleLike || ['ALL', 'WALK_ONLY'].includes(tile.passable),
      flyPassable: ['ALL', 'FLY_ONLY'].includes(tile.passable),
      ...(tile.height ? { height: tile.height } : {}),
      ...(Number.isFinite(tile.originalFacilityHeight) ? { originalFacilityHeight: tile.originalFacilityHeight } : {}) };
    rows[row] = rows[row].slice(0, col) + glyph + rows[row].slice(col + 1);
  }
  return { ...stage, rows, tiles };
}

/** Existing normal-camera bands assume rows 6..13. Adapt this instance only. */
export function adaptMizukiFieldView(raw) {
  let rect = null; let tiles = null; let board = null; let pen = false;
  const views = raw.debug?.views;
  if (views instanceof Map) {
    const insert = views.set.bind(views);
    views.set = (id, view) => insert(id, adaptMizukiUnitView(view));
    for (const view of views.values()) adaptMizukiUnitView(view);
  }
  let sourceStage = null, facilitySignature = '[]';
  const originalStage = raw.setStage?.bind(raw);
  if (originalStage) raw.setStage = stage => {
    sourceStage = stage; facilitySignature = '[]';
    return originalStage(stage);
  };
  const frame = () => {
    if (!rect) return;
    const visibleRect = () => pen ? { r0: 14, r1: 18, c0: 7, c1: 13 } : rect;
    const currentTiles = raw.debug?.tiles;
    if (currentTiles && tiles !== currentTiles) {
      tiles = currentTiles;
      const setView = tiles.setView.bind(tiles);
      tiles.setView = () => { const area = visibleRect(); return setView([area.r0, area.r1], area, [area.r0, area.r1]); };
    }
    const currentBoard = raw.debug?.board3d;
    if (currentBoard && board !== currentBoard) {
      board = currentBoard;
      const setArea = board.setArea.bind(board);
      board.setArea = () => setArea([{ ...visibleRect() }]);
    }
    tiles?.setView(); board?.setArea(); board?.setFocus?.(visibleRect());
  };
  for (const name of ['enterBattle', 'setCamera', 'resize', 'pushSnapshot']) {
    const original = raw[name]?.bind(raw);
    if (!original) continue;
    raw[name] = (...args) => {
      if (name === 'pushSnapshot' && sourceStage && originalStage) {
        const facilities = args[0]?.officialFacilities?.tiles || [];
        const signature = JSON.stringify(facilities);
        if (signature !== facilitySignature) {
          facilitySignature = signature;
          originalStage(mizukiFacilityStage(sourceStage, facilities));
        }
      }
      if (name === 'enterBattle' && args[0]?.rect) rect = { ...args[0].rect };
      if (name === 'setCamera') {
        pen = args[0] === 'pen';
        if (args[1]?.nativeRect || args[1]?.rect) rect = { ...(args[1].nativeRect || args[1].rect) };
      }
      if (name !== 'pushSnapshot') frame();
      const result = original(...args);
      if (name !== 'pushSnapshot') frame();
      return result;
    };
  }
  return raw;
}

/** Use the existing field engine/HUD framing with explicit mode-local inputs. */
export function useMizukiFieldView(hostRef, runtime, stageId = null) {
  const [state, setState] = useState({ view: null, kind: 'loading' });
  useEffect(() => {
    if (!runtime || !hostRef.current) return undefined;
    let dead = false; let mounted = null; let offSettings = null; let boardAssets = null;
    const geometry = observeFieldGeometry(hostRef.current, () => mounted?.resize());
    const controller = new AbortController();
    setState({ view: null, kind: 'loading' });
    const modeAssets = createMizukiAssets(assets, { ...runtime.assetsLibrary, spines: { ...runtime.assetsLibrary?.spines, ...runtime.facilityLibrary?.spines } });
    const opts = { data: createMizukiData(data, runtime), assets: modeAssets, audio,
      settings: settingsStore.get(), padding: hudPadding,
      hud: (kind, size, options) => hudBands(kind, size, { ...options, reserveFoldedShop: true }), signal: controller.signal };
    const mount = async () => {
      // The current map uses the same required-resource IO as ordinary boards.
      // Prepare it while board metadata / renderer / effect libraries initialize.
      void prepareMizukiStage(runtime, stageId).catch(() => {});
      await assets.ready();
      boardAssets = await prepareMizukiBoardAssets(modeAssets, runtime.boardLibrary);
      opts.assets = boardAssets.assets;
      const module = await import('./mizukiNativeApp.js');
      if (dead) { boardAssets.destroy(); return; }
      const raw = await module.createFieldView(hostRef.current, opts);
      if (dead) { raw.destroy(); boardAssets.destroy(); return; }
      await attachMizukiMaps(raw, runtime.mapLibrary, { reflectionManifest: runtime.reflectionLibrary });
      await attachMizukiFx(raw, { settings: settingsStore.get() });
      await attachMizukiFacilities(raw, runtime);
      await attachMizukiGates(raw, runtime);
      if (dead) { raw.destroy(); boardAssets.destroy(); return; }
      mounted = guardView(adaptMizukiCoordinates(adaptMizukiFieldScope(adaptMizukiFieldView(raw))), 'engine');
      offSettings = settingsStore.subscribe((settings) => mounted?.setSettings(settings));
      setState({ view: mounted, kind: 'engine' });
      geometry.refresh();
    };
    mount().catch((error) => {
      if (dead || controller.signal.aborted) return;
      console.error('[mizuki] native field could not mount', error);
      setState({ view: null, kind: 'error' });
    });
    return () => {
      dead = true; controller.abort(); offSettings?.();
      geometry.destroy(); mounted?.destroy(); boardAssets?.destroy();
      modeAssets.spine?.clear();
      // Shared operators follow the ordinary renderer's reference/LRU policy.
      // Clearing it here discarded warm models between every pair of nodes.
    };
  }, [hostRef, runtime]);
  return state;
}
