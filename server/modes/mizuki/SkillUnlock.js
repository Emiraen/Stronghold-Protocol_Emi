// Official skill unlock conditions are retained by the RO2 importer. Both the
// private catalog and per-run selections use the form's real training status.
const phaseIndex = (value) => Number.isInteger(value) ? value
  : /^PHASE_[0-2]$/.test(value || '') ? Number(value.slice(-1)) : null;

export function mizukiSkillUnlocked(skill, status) {
  const condition = skill?.unlockCond;
  if (!condition) return true;
  const requiredPhase = phaseIndex(condition.phase), phase = phaseIndex(status?.phase);
  if (requiredPhase === null || phase === null) return false;
  return phase > requiredPhase || phase === requiredPhase
    && Number.isInteger(status?.level) && status.level >= (condition.level || 1);
}

export function mizukiUnlockedSkills(record) {
  return (record?.skills || (record?.skill ? [record.skill] : []))
    .filter((skill) => mizukiSkillUnlocked(skill, record?.status));
}
