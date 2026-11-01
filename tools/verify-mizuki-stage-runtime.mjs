// Empty-roster scheduler smoke: this is not a player victory or balance test.
import { mkdirSync, writeFileSync } from 'node:fs';
import { officialMizukiStageOptions, createOfficialMizukiStage } from '../server/modes/mizuki/official-stages.js';
import { MizukiAutoCombat } from '../server/modes/mizuki/Combat.js';
const seeds = process.argv.slice(2).map(Number);
if (!seeds.length) seeds.push(1, 77, 27127);
if (seeds.some((v) => !Number.isSafeInteger(v) || v < 0)) throw new TypeError('Nonnegative integer seeds required');
const stages = officialMizukiStageOptions();
const runs = [];
for (const stage of stages.filter((v) => v.available)) for (const seed of seeds) {
  const messages = [];
  const log = (...items) => { if (messages.length < 10) messages.push(items.map(String).join(' ')); };
  let combat;
  try {
    const original = createOfficialMizukiStage(stage.id, { seed });
    combat = new MizukiAutoCombat({ ...original, seed, players: [{ playerId: 'scheduler-smoke', units: [] }],
      logger: { warn: log, error: log, info() {}, log() {} } });
    for (let tick = 0; tick < 30 * 1800 && !combat.done; tick++) {
      combat.step();
      if (tick % 300 === 0) combat.drainEvents();
    }
    const waves = combat.officialWaves.snapshot(), facilities = combat.stageMechanics.snapshot();
    runs.push({ id: stage.id, seed, done: combat.done, time: combat.time,
      errors: combat.battle.errorCount, pending: combat.battle._pending.length,
      unsupported: waves.unsupported, facilityWarnings: facilities.warnings, messages });
  } catch (error) { runs.push({ id: stage.id, seed, exception: error.stack }); }
  finally { if (combat && !combat.done) combat.forceEnd(); }
}
const report = { date: '2026-10-27',
  scope: 'Production MizukiAutoCombat empty-roster original-wave scheduler smoke only. Enemies may leak. No victory, player balance, untouched branch, reward or complete-exploration fidelity claim.',
  stageRecords: stages.length, available: stages.filter((v) => v.available).length, seeds,
  runs, issues: runs.filter((v) => v.exception || !v.done || v.errors || v.pending || v.unsupported?.length || v.facilityWarnings?.length) };
mkdirSync(new URL('../.cache/mizuki-native-rules/', import.meta.url), { recursive: true });
writeFileSync(new URL('../.cache/mizuki-native-rules/stage-runtime-verification.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ records: report.stageRecords, available: report.available, runs: runs.length, issues: report.issues }));
if (report.issues.length) process.exitCode = 1;
