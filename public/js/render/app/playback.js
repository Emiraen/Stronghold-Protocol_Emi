// OfficialFx caps a single update at 0.25s; explicit console stepping retains the full interval.
export function advanceEffectClock(effects, seconds) {
  if (!(seconds > 0) || !Number.isFinite(seconds)) { effects.update(0); return; }
  while (seconds > 0.25) { effects.update(0.25); seconds -= 0.25; }
  effects.update(seconds);
}
