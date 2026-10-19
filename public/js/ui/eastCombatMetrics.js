// Read-only accounting over East's existing runner. No simulation methods are wrapped or replaced.
const TYPES = ['phys', 'arts', 'true', 'elemental'];
const positive = (n) => Number.isFinite(n) && n > 0 ? n : 0;
const archive = new Map();
let activeRunner = null;
let activeMatch = null;
let installed = null;

function ownerOf(unit) {
  const seen = new Set();
  while (unit?.kind === 'token' && unit.ownerUnit && !seen.has(unit)) {
    seen.add(unit); unit = unit.ownerUnit;
  }
  return unit?.side === 'ally' && unit.ownerId != null ? unit : null;
}

function attach(entry) {
  const battle = entry?.battle;
  if (!battle) return null;
  let rec = archive.get(entry.battleId);
  if (rec?.battle === battle) return rec;
  if (rec?.off) rec.off();
  rec = { battle, marks: new WeakMap(), types: new WeakMap(), snapshot: null, off: null };
  const mark = (u) => {
    if (rec.marks.has(u)) return;
    const split = u.stats?.dmgByType || {};
    const phys = positive(split.phys), arts = positive(split.arts);
    const total = positive(u.stats?.dmg);
    rec.marks.set(u, total);
    rec.types.set(u, { phys, arts, true: Math.max(0, total - phys - arts), elemental: 0 });
  };
  for (const u of battle.allyUnits || []) if (u) mark(u);
  // The existing damage hook runs after its own effective-damage counter is updated. Reading that
  // delta avoids counting overkill, shields, friendly damage and elemental gauge fill as HP damage.
  const hook = battle.on('damaged', ({ source, credit, type }) => {
    const u = credit || source;
    if (!u || u.side !== 'ally' || !ownerOf(u)) return;
    if (!rec.marks.has(u)) {
      rec.marks.set(u, 0);
      rec.types.set(u, Object.fromEntries(TYPES.map((k) => [k, 0])));
    }
    const total = positive(u.stats?.dmg);
    const delta = positive(total - rec.marks.get(u));
    rec.marks.set(u, total);
    const key = type === 'element' || type === 'elemental' ? 'elemental' : TYPES.includes(type) ? type : 'true';
    rec.types.get(u)[key] += delta;
  }, { priority: Number.MAX_VALUE });
  rec.off = () => battle.off(hook);
  archive.set(entry.battleId, rec);
  return rec;
}

function sample(entry) {
  const rec = attach(entry);
  if (!rec) return;
  const rows = new Map();
  for (const u of rec.battle.allyUnits || []) {
    if (!u || (u.kind !== 'op' && u.kind !== 'token')) continue;
    const owner = ownerOf(u);
    if (!owner) continue;
    const key = JSON.stringify([owner.ownerId, owner.kind, owner.name || owner.defId]);
    let row = rows.get(key);
    if (!row) {
      row = { key, ownerId: owner.ownerId, defId: owner.defId, name: owner.name || owner.defId,
        kind: owner.kind, damage: 0, healing: 0, types: Object.fromEntries(TYPES.map((k) => [k, 0])) };
      rows.set(key, row);
    }
    const total = positive(u.stats?.dmg);
    const split = rec.types.get(u) || { phys: positive(u.stats?.dmgByType?.phys), arts: positive(u.stats?.dmgByType?.arts), true: 0, elemental: 0 };
    const counted = TYPES.reduce((n, k) => n + positive(split[k]), 0);
    row.damage += total;
    row.healing += positive(u.stats?.heal);
    for (const k of TYPES) row.types[k] += positive(split[k]);
    row.types.true += Math.max(0, total - counted);
  }
  rec.snapshot = { seconds: positive(rec.battle.time), owners: (rec.battle.players || []).map((p) => p.playerId), rows: [...rows.values()] };
}

function capture() {
  if (!activeRunner?._entries) return;
  for (const entry of activeRunner._entries.values()) sample(entry);
  // Retain just numbers after eviction; release the old simulation and its hook.
  for (const [id, rec] of archive) if (rec.battle && !activeRunner._entries.has(id)) {
    sample({ battleId: id, battle: rec.battle });
    rec.off?.(); rec.off = null; rec.battle = null; rec.marks = null; rec.types = null;
  }
}

export function installEastCombatMetrics(runner, matchId) {
  if (!runner) return () => {};
  if (installed) installed();
  if (activeMatch !== matchId) {
    for (const rec of archive.values()) rec.off?.();
    archive.clear(); activeMatch = matchId;
  }
  activeRunner = runner;
  const sync = () => capture();
  const offState = runner.on('state', sync);
  let last = 0;
  const offSnap = runner.on('snap', () => { const now = Date.now(); if (now - last > 200) { last = now; capture(); } });
  capture();
  const dispose = () => { capture(); offState(); offSnap(); if (installed === dispose) installed = null; };
  installed = dispose;
  return dispose;
}

export const eastCombatMetrics = {
  combatMetrics({ scope = 'match', ownerId = null } = {}) {
    capture();
    const current = activeRunner?.currentBattle()?.battleId;
    const rows = new Map(), elapsed = new Map();
    for (const [id, rec] of archive) {
      if (scope === 'battle' && id !== current) continue;
      const snapshot = rec.snapshot;
      if (!snapshot) continue;
      const owners = new Set(snapshot.owners);
      for (const r of snapshot.rows) {
        if (ownerId != null && r.ownerId !== ownerId) continue;
        owners.add(r.ownerId);
        let row = rows.get(r.key);
        if (!row) { row = { ...r, damage: 0, healing: 0, types: Object.fromEntries(TYPES.map((k) => [k, 0])) }; rows.set(r.key, row); }
        row.damage += r.damage; row.healing += r.healing;
        for (const k of TYPES) row.types[k] += r.types[k];
      }
      for (const id0 of owners) elapsed.set(id0, (elapsed.get(id0) || 0) + snapshot.seconds);
    }
    const list = [...rows.values()].map((r) => {
      const seconds = elapsed.get(r.ownerId) || 0;
      return { ...r, dps: seconds ? r.damage / seconds : 0, hps: seconds ? r.healing / seconds : 0 };
    }).sort((a, b) => b.damage - a.damage || b.healing - a.healing || a.key.localeCompare(b.key));
    return { rows: list, damage: list.reduce((n, r) => n + r.damage, 0), healing: list.reduce((n, r) => n + r.healing, 0) };
  },
};
