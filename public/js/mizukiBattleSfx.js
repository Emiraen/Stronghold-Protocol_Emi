// The native renderer owns visuals and prep landings. Real combat events use the shared audio manager.
import { UF } from '../../shared/constants.js';

const list = value => Array.isArray(value) ? value : [];
const same = (left, right) => left != null && right != null && String(left) === String(right);
const scopes = new WeakMap();

/** A new token marks a viewed battle; pending mode-local SFX can discard an older scope after loading. */
export const mizukiBattleSfxScope = audio => scopes.get(audio) || null;

export function createMizukiBattleSfx(audio) {
  let field = null, scope = null, context = null, packets = new WeakSet();
  let metadata = null, tupleSource = null, tuples = null;
  const units = new Map();

  function snapshotTuple(id) {
    if (tupleSource !== field?.units || !tuples) {
      tupleSource = field?.units;
      tuples = new Map(list(tupleSource).filter(Array.isArray).map(tuple => [String(tuple[0]), tuple]));
    }
    return tuples.get(String(id));
  }

  function remember(info) {
    if (!info || typeof info !== 'object' || info.id == null) return null;
    const tuple = snapshotTuple(info.id);
    // UnitInfo.spine is the sound-bank model id; defId may be a custom operator slot.
    const unit = { ...info, spine: info.spine || info.charId || info.defId,
      skillActive: typeof info.skillActive === 'boolean' ? info.skillActive : !!(tuple?.[7] & UF.SKILL) };
    units.set(info.id, unit);
    return unit;
  }

  function reset() {
    if (scope && scopes.get(audio) === scope) {
      scopes.delete(audio);
      // Also stops the previous field's voice and clears pending skills / impact ownership.
      audio.setFieldUnits([]);
    }
    field = null; scope = null; context = null; packets = new WeakSet(); units.clear();
    metadata = null; tupleSource = null; tuples = null;
  }

  function seed() {
    audio.setFieldUnits([...units.values()]);
    context = audio.ctx;
  }

  function refreshContext() {
    if (context === audio.ctx) return;
    // A spawn received before the first browser gesture was intentionally silent; register its metadata on unlock.
    for (const info of list(field?.meta?.units)) remember(info);
    seed();
  }

  return {
    setField(next, { phase = 'COMBAT', finishing = false } = {}) {
      if (!next || next.fieldId == null || phase !== 'COMBAT' || finishing) { reset(); return; }
      const changed = !scope || !same(next.fieldId, field?.fieldId)
        || (next.battleId ?? null) !== (field?.battleId ?? null);
      if (changed) {
        reset(); field = next;
        scope = { fieldId: next.fieldId, battleId: next.battleId ?? null };
        scopes.set(audio, scope);
        for (const info of list(next.meta?.units)) remember(info);
        metadata = next.meta?.units;
        seed();
        return;
      }
      field = next;
      refreshContext();
      // Reliable unit metadata is immutable; compact twenty-Hz HP/SP frames
      // keep the same list until a spawn or field update changes it.
      if (metadata === next.meta?.units) return;
      metadata = next.meta?.units;
      const fresh = [];
      for (const info of list(next.meta?.units)) if (info?.id != null && !units.has(info.id)) {
        const unit = remember(info);
        if (unit) fresh.push(['spawn', unit]);
      }
      // Metadata updates must not reset active skills, replay deployment sounds or play historical attacks.
      if (fresh.length) audio.handleBattleEvents(fresh);
    },

    pushEvents(packet) {
      if (!scope || scopes.get(audio) !== scope || !packet || typeof packet !== 'object'
        || !same(packet.fieldId, field.fieldId)
        || packet.battleId != null && !same(packet.battleId, field.battleId)) return false;
      const events = Array.isArray(packet.ev) ? packet.ev : list(packet.events);
      if (!events.length || packets.has(packet)) return false;
      packets.add(packet);
      refreshContext();
      // Spawn metadata often precedes the next public field frame. Keep it even while audio is locked.
      for (const event of events) if (Array.isArray(event) && event[0] === 'spawn') remember(event[1]);
      for (const event of events) if (event?.[0] === 'fx' && event[1] === 'mizuki:dice-roll') {
        audio.sfx?.('mizuki:ui.ON_ROGUELIKE_DICE' + (event[4]?.tier >= 2 ? 'GREAT' : 'NORMAL'));
      }
      audio.handleBattleEvents(events);
      return true;
    },

    dispose: reset,
  };
}
