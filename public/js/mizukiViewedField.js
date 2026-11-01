const list = value => Array.isArray(value) ? value : [];
const same = (left, right) => left != null && right != null && String(left) === String(right);

/** Only the viewed field contributes pieces; a teammate's bench stays private. */
export function mizukiViewedPrep(privatePrep, { fieldId, ownFieldId, playerId, fields } = {}) {
  const publicBoards = list(list(fields).find(field => same(field.fieldId, fieldId))?.boards);
  if (same(fieldId, ownFieldId)) return {
    prep: privatePrep || { hand: [], temp: [], board: [] },
    peerBoards: publicBoards.filter(owner => !same(owner.playerId, playerId)).flatMap(owner => list(owner.board)),
  };
  return {
    prep: { hand: [], temp: [], supplies: [], board: publicBoards.flatMap(owner => list(owner.board)) },
    peerBoards: [],
  };
}

/** Branches prepare and fight independently, even while their teammates watch. */
export function mizukiViewedPhase(field, expedition, fallback = 'COMBAT') {
  const party = list(expedition?.parties).find(item => same(item.id, field?.partyId));
  const phase = field?.phase || party?.phase;
  return phase === 'PREP' || phase === 'COMBAT' ? phase : field?.done ? 'COMBAT' : fallback;
}

/** A renderer persists across watch switches; late packets cannot enter its new battle. */
export function adaptMizukiFieldScope(raw) {
  let scope = null, combat = false;
  const bind = value => {
    scope = value?.fieldId == null ? null : { fieldId: value.fieldId, battleId: value.battleId ?? null };
  };
  const matches = value => combat && scope && same(value?.fieldId, scope.fieldId)
    && (scope.battleId == null ? value?.battleId == null : same(value?.battleId, scope.battleId));
  const enterBattle = raw.enterBattle?.bind(raw);
  if (enterBattle) raw.enterBattle = meta => { bind(meta); combat = true; return enterBattle(meta); };
  const setPrep = raw.setPrep?.bind(raw);
  if (setPrep) raw.setPrep = (prep, options) => { bind(prep); combat = false; return setPrep(prep, options); };
  for (const name of ['pushSnapshot', 'pushEvents']) {
    const original = raw[name]?.bind(raw);
    if (original) raw[name] = value => matches(value) ? original(value) : false;
  }
  return raw;
}
