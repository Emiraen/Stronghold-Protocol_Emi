// Source routes already use the native scene's bottom-up tile coordinates.
// translateOfficialMap reverses the serialized top-down matrix once, so the
// server, scene meshes, gates, camera and renderer now share that same frame.
// Do not mirror rows or directions again here. Preparation has already added
// its two bench rows before reaching this boundary (mizukiPrepRenderState).
export const mizukiVerticalDirection = dir => dir;

export function mizukiCoordinates(stage) {
  const shift = stage?.id?.endsWith(':mizuki-prep') ? 2 : 0;
  const count = Number(stage?.nativeMapRows) || Number(stage?.originalSize?.rows ?? stage?.originalSize?.[0]) || Math.max(1, (stage?.rows?.length || 1) - shift);
  const row = value => value;
  // All boundaries already share native bottom-up coordinates. Consumers read
  // these packets; copying every nested metadata/geometry record at 20 Hz only
  // creates garbage and adds input latency on mobile. The interpolator owns its
  // normalized tuples and never mutates the authoritative source packet.
  const point = value => value;
  const rect = value => {
    if (!value) return value;
    // A PREP camera includes bench + board: its union has the same extents.
    if (shift && value.r0 < shift && value.r1 >= shift) return { ...value };
    const a = row(value.r0), b = row(value.r1);
    return { ...value, r0: Math.min(a,b), r1: Math.max(a,b) };
  };
  const stageView = value => {
    const rows = value.rows.slice();
    return { ...value, rows, nativeMapRows:count, nativeVisualRows:true,
      ...(value.devices ? { devices:point(value.devices) } : {}),
      ...(value.special ? { special:point(value.special) } : {}) };
  };
  const meta = point, event = point, events = point, snapshot = point;
  return { count, shift, row, point, rect, stage:stageView, meta, event, events, snapshot };
}

/** Private reversible adapter; networking and server snapshots stay authoritative. */
export function adaptMizukiCoordinates(raw) {
  let map = mizukiCoordinates(null);
  const wrap = (name, makeArgs) => {
    const original = raw[name]?.bind(raw);
    if (original) raw[name] = (...args) => original(...makeArgs(args));
  };
  wrap('setStage', ([stage]) => { map = mizukiCoordinates(stage); return [map.stage(stage)]; });
  wrap('setCamera', ([kind,options]) => [kind, options ? { ...options, rect:map.rect(options.rect) } : options]);
  wrap('enterBattle', ([meta]) => [map.meta(meta)]);
  wrap('pushSnapshot', ([value]) => [map.snapshot(value)]);
  wrap('pushEvents', ([value]) => [map.events(value)]);
  wrap('setPrep', ([prep,options]) => [{ ...prep, board:map.point(prep.board || []) }, options ? { ...options,
    canPlace:options.canPlace ? (uid,target) => options.canPlace(uid,map.point(target)) : undefined } : options]);
  wrap('highlightTiles', ([tiles,style]) => [tiles?.map(([r,c]) => [map.row(r),c]),style]);
  wrap('tileScreen', ([r,c]) => [map.row(r),c]);
  wrap('holdPiece', ([uid,tile]) => [uid,map.point(tile)]);
  wrap('setPieceDir', ([uid,dir]) => [uid,mizukiVerticalDirection(dir)]);
  const groundTile=raw.debug?.pick?.groundTile?.bind(raw.debug.pick);
  if(groundTile)raw.debug.pick.groundTile=(...args)=>map.point(groundTile(...args));
  const handlers = new Map(), on = raw.on?.bind(raw), off = raw.off?.bind(raw);
  if (on) raw.on = (name, handler) => {
    const listener = value => handler(map.point(value));
    handlers.set(handler, listener);
    const remove = on(name, listener);
    return () => { handlers.delete(handler); remove?.(); };
  };
  if (off) raw.off = (name, handler) => { const listener = handlers.get(handler); handlers.delete(handler); return off(name, listener || handler); };
  raw.debug.mizukiCoordinates = { row:value => map.row(value), stats:() => ({ rows:map.count, benchRows:map.shift, sourceRows:'bottom-up', serverRows:'bottom-up', rendererRows:'bottom-up' }) };
  return raw;
}
