// Reuse original prep/equipment handlers with mode-local IO. Match owns the
// lifecycle boundary and must claim each round/result event before dispatching.
import { getDefaultRegistry, GARRISON_HOOK, HOOKS, MAX_DEPTH } from '../../match/effectsMeta.js';
import { itemKey } from '../../match/gamedata.js';
import { mizukiEquipmentAvailable, mizukiEquipmentEffectAvailable } from './EquipmentPolicy.js';
import { mizukiStrategyAvailable } from './StrategyPolicy.js';

const depths = new WeakMap();
const list = value => Array.isArray(value) ? value : [];
const itemHooks = new Set(['onEquip', 'onArt', 'onDestroy']);
const pieceHooks = new Set(['onRoundStart', 'onPrepEnd', 'onRefresh']);

function ownedPieces(context) {
  const out = new Map();
  for (const area of ['board', 'hand', 'temp']) for (const piece of list(context[area]?.())) {
    if (!piece || piece.kind !== 'chess' || out.has(piece.uid)) continue;
    out.set(piece.uid, { ...piece, area: ['board', 'hand', 'temp'].includes(piece.area) ? piece.area : area });
  }
  return [...out.values()];
}

function investmentRepeat(context, gd) {
  const active = context.bond?.('investShip');
  if (!active?.active) return 1;
  const bond = gd.bond?.('investShip'), bb = bond?.bb || {};
  const base = Number.isInteger(bb.count) && bb.count > 1 ? bb.count : 2;
  const milestone = list(bond?.layerMilestones).find(value => Number(value?.layer) > 0);
  const threshold = milestone ? Number(milestone.layer) : Number.isFinite(bb.layer) && bb.layer > 0 ? bb.layer : 100;
  return active.layers >= threshold ? base + 1 : base;
}

/** No currency is granted here: native handlers use contextFactory's adapters. */
export function dispatchMizukiNativeMeta({ player, gd, contextFactory, hook, event = {}, callbacks = {},
  registry = getDefaultRegistry(), includeEquipment = true, onlyBand = false, skipBand = false } = {}) {
  const output = { event, dispatched: 0, errors: [] };
  if (!player || typeof player !== 'object' || !gd || typeof contextFactory !== 'function'
    || !HOOKS.includes(hook) || !event || typeof event !== 'object') return output;
  const depth = depths.get(player) || 0;
  if (depth >= MAX_DEPTH) {
    output.errors.push({ key: 'native:dispatch', hook, error: 'Mizuki meta dispatch depth limit' });
    return output;
  }
  depths.set(player, depth + 1);
  let base;
  const report = (key, error) => {
    output.errors.push({ key, hook, error: error?.message || String(error) });
    try { base?.reportError?.(key, error); } catch { /* A logger cannot abort other handlers. */ }
  };
  try {
    base = { ...contextFactory(null), ...callbacks };
    const pieces = () => ownedPieces(base);
    const makeContext = source => ({ ...contextFactory(source), ...callbacks, hook, source,
      board: () => pieces().filter(piece => piece.area === 'board'),
      hand: () => pieces().filter(piece => piece.area === 'hand'),
      temp: () => pieces().filter(piece => piece.area === 'temp') });
    const call = (key, handler, source, repeat = 1) => {
      if (source.kind === 'item' && !mizukiEquipmentAvailable(gd, source.piece?.id)
        || source.kind === 'effect' && !mizukiEquipmentEffectAvailable(source.ref)
        || source.kind === 'band' && !mizukiStrategyAvailable(source.bandId)) return;
      const fn = typeof handler?.[hook] === 'function' ? handler[hook]
        : source.kind === 'garrison' && typeof handler?.run === 'function' ? handler.run : null;
      if (!fn) return;
      for (let n = 0; n < repeat; n++) {
        try { fn.call(handler, makeContext(source), event);output.dispatched++; }
        catch (error) { report(key, error); }
      }
    };
    const garrisonPiece = (piece, where) => {
      for (const garrisonId of gd.chess?.(piece.id)?.garrisonIds || []) {
        try {
          const garrison = gd.garrison(garrisonId);
          if (!garrison) continue;
          const key = 'garrison:' + garrison.effectKey, handler = registry.get(key);
          if (!handler) continue;
          let hooks = [GARRISON_HOOK[garrison.eventType]];
          if (typeof handler.garrisonHooks === 'function') {
            try {
              const custom = handler.garrisonHooks(garrison);
              if (Array.isArray(custom) && custom.length) hooks = custom;
            } catch (error) { report(key, error); }
          }
          if (!hooks.includes(hook) || where === 'hand' && garrison.bbStr?.conditionkey === 'character_target_inboard') continue;
          const repeat = hook === 'onGain' ? investmentRepeat(base, gd) : 1;
          call(key, handler, { kind: 'garrison', key, piece, garrisonId, garrison,
            bb: garrison.bb || {}, bbStr: garrison.bbStr || {}, where }, repeat);
        } catch (error) { report('garrison:' + garrisonId, error); }
      }
    };
    const garrisons = () => {
      if (hook === 'onGain' || hook === 'onSold') {
        if (event.piece?.kind === 'chess') garrisonPiece(event.piece, hook === 'onGain' ? 'gained' : 'sold');
      } else if (hook === 'onPrice') {
        if (event.slot?.kind === 'chess') garrisonPiece({ uid: 0, kind: 'chess', id: event.slot.id, items: [] }, 'shop');
      } else if (pieceHooks.has(hook)) {
        const snapshot = pieces().filter(piece => piece.area !== 'temp');
        snapshot.sort((a, b) => (a.area === 'board' ? 0 : 1) - (b.area === 'board' ? 0 : 1)
          || (a.area === 'board' ? (a.row - b.row) || (a.col - b.col) : 0));
        for (const piece of snapshot) garrisonPiece(piece, piece.area);
      }
    };
    // A personal elimination stops its own native income and trait hooks.
    if (player.eliminated === true || player.alive === false) {
      for (const ref of includeEquipment ? list(player.equipmentEffects).slice() : []) {
        const handler = registry.get(ref?.key);
        if (handler?.afterElimination === true) call(ref.key, handler, { kind: 'effect', key: ref.key, ref });
      }
      return output;
    }
    if (onlyBand) {
      if (player.bandId) {
        const key = 'band:' + player.bandId;
        call(key, registry.get(key), { kind: 'band', key, bandId: player.bandId, band: gd.band?.(player.bandId) });
      }
      return output;
    }
    if (hook === 'onPrice') garrisons();
    for (const [key, handler] of registry.globals?.() || []) call(key, handler, { kind: 'global', key });
    if (player.bandId && !skipBand) {
      const key = 'band:' + player.bandId;
      call(key, registry.get(key), { kind: 'band', key, bandId: player.bandId, band: gd.band?.(player.bandId) });
    }
    for (const bondId of gd.bondIds || []) {
      const key = 'bond:' + bondId;
      call(key, registry.get(key), { kind: 'bond', key, bondId, bond: base.bond?.(bondId) || null });
    }
    if (hook !== 'onPrice') garrisons();
    // Item-specific events go only to the one item chosen by Equipment, never
    // to every equipped item. Other hooks snapshot pairs before the first runs.
    if (includeEquipment && !itemHooks.has(hook)) {
      const pairs = pieces().flatMap(holder => list(holder.items).map(item => [holder, item]));
      for (const [holder, item] of pairs) {
        if (!item || typeof item.id !== 'string') continue;
        const fresh = pieces().find(piece => piece.uid === holder.uid && piece.id === holder.id);
        if (!fresh || !list(fresh.items).some(value => value.uid === item.uid && value.id === item.id)) continue;
        const key = 'item:' + itemKey(item.id);
        call(key, registry.get(key), { kind: 'item', key, piece: item, holder: fresh, item: gd.item?.(item.id) });
      }
    }
    for (const ref of includeEquipment ? list(player.equipmentEffects).slice() : []) {
      if (typeof ref?.key !== 'string') continue;
      call(ref.key, registry.get(ref.key), { kind: 'effect', key: ref.key, ref });
    }
  } catch (error) { report('native:dispatch', error); }
  finally {
    if (depth) depths.set(player, depth);else depths.delete(player);
  }
  return output;
}
