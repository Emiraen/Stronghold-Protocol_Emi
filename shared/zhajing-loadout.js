// An editor-only view of 炸惊 records. Never changes shop visibility or normal-mode validation.
import { checkLoadout, checkLoadoutOps, cultivationCharIds } from './protocol.js';

export function zhajingEditorChess(chess, defaults = null) {
  const entries = Array.isArray(chess) ? chess.map(c => [c.chessId, c]) : Object.entries(chess || {});
  return Object.fromEntries(entries.map(([id, c]) => {
    if (!c || (!c.zhajing && !(c.isDiy && c.charId))) return [id, c];
    let modules = c.modules;
    const fallback = defaults?.byBaseId?.[c.baseId || id]?.module;
    if (c.zhajing && c.isGolden && fallback && !modules?.some(m => m.isDefault) && !c.module?.active) {
      modules = modules?.map(m => ({ ...m, isDefault: m.uniEquipId === fallback }));
    }
    return [id, { ...c, visible: true, isDiy: false, modules }];
  }));
}

export function checkZhajingLoadout(entries, ops, data) {
  const chess = zhajingEditorChess(data.chess, data.zjDefaultLoadout);
  const checked = checkLoadout(entries, id => chess[id]);
  if (checked.error) return checked;
  const ids = cultivationCharIds(chess, data.backups);
  const settings = checkLoadoutOps(ops || {}, id => ids.has(id));
  return settings.error ? settings : { ...checked, ops: settings.ops };
}
