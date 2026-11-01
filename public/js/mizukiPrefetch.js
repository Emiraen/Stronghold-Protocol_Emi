import { collectMatchResourceUrls } from './assets.js';
import { mizukiSpineEntry } from './mizukiSpine.js';

const list = value => Array.isArray(value) ? value : [];

/** Only resource identities affect prefetch; twenty-Hz HP/SP changes do not. */
export function mizukiResourceKey(match) {
  const priv = match?.private?.mizuki || {}, fields = list(match?.public?.mizuki?.fields);
  return JSON.stringify([list(priv.roster).map(unit => [unit.chessId, unit.skin]),
    list(priv.nextEnemies || match?.private?.nextEnemies).map(enemy => enemy.enemyKey),
    fields.map(field => [field.fieldId, field.battleId, field.stage?.id || field.meta?.stageId])]);
}

/** Adapt current mode records into the ordinary match's required-file collector. */
export function collectMizukiResourceUrls(base, source, match, runtime) {
  const priv = match?.private?.mizuki || {}, fields = list(match?.public?.mizuki?.fields);
  const assets = Object.create(base);
  assets.spineEntry = (id, options) => mizukiSpineEntry(id, base.spineEntry(id, options)
    || runtime.assetsLibrary?.spines?.[id] || runtime.facilityLibrary?.spines?.[id] || null);
  const data = { get: name => name === 'chess' ? runtime.chess : name === 'tokens' ? runtime.tokens : source.get(name),
    lookup: (name, id) => (name === 'chess' ? runtime.chess?.[id] : name === 'tokens' ? runtime.tokens?.[id] : null) || source.lookup(name, id) };
  const hand = list(priv.roster).map(unit => ({ ...unit, id: unit.chessId, kind: 'chess' }));
  const field = fields.find(value => value.fieldId === priv.fieldId) || fields.find(value => value.meta);
  // Include opening monsters/facilities as well as ordinary wave previews.
  const units = [...list(field?.meta?.units), ...list(field?.prepEnemies)];
  return collectMatchResourceUrls(assets, data, {
    private: { hand, nextEnemies: priv.nextEnemies || match?.private?.nextEnemies },
    field: { units },
  }, { localBoard: false });
}
