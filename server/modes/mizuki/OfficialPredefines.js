// Resolve original RO2 aliases without rewriting source levels. One native
// deep-cognition box has alias trap_068_badbox2# but its action and its own
// branch_id both use trap_068_badbox#2. Match only that same original key.
export function findOfficialPredefined(level, key) {
  const instances = [...(level.predefines?.characterInsts || []), ...(level.predefines?.tokenInsts || [])];
  const exact = instances.find((p) => (p.alias ?? p.inst?.characterKey) === key);
  if (exact) return exact;
  const sameBox = instances.filter((p) => p.inst?.characterKey === 'trap_068_badbox'
    && p.overrideSkillBlackboard?.some((v) => v.key === 'branch_id' && v.valueStr === key));
  return sameBox.length === 1 ? sameBox[0] : null;
}
