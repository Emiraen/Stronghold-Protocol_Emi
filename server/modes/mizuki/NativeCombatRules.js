// Original ordinary-battle policies, scoped to Mizuki; the automatic modes do
// not import this module. Values come from local official client prefabs and
// Battle.Consts / Deck.Card / Character.Withdraw (see the source JSON hashes).
import { readFileSync } from 'node:fs';

const RULES = JSON.parse(readFileSync(new URL('../../../data/mizuki/native-combat-rules.json', import.meta.url), 'utf8'));
const nonnegative = (n) => Math.max(0, Number(n) || 0);
const entityId = (unit) => unit.def.charId || unit.def.raw?.charId || unit.defId;
const entityRule = (unit) => RULES.entities[entityId(unit)];
const selectedBlackboards = (unit) => [unit.def.trait?.bb, unit.def.raw?.trait?.bb,
  ...(unit.def.talents ?? []).filter((talent) => talent.fromModule).map((talent) => talent.bb)].filter(Boolean);

export function mizukiDeployCost(unit) {
  if (unit.mem?.indomFreeDeploy) return 0;
  const multiplier = unit.kind === 'op'
    ? Math.min(RULES.respawnCostMaxMultiplier, 1 + (unit._mizukiDeployCount ?? 0) * RULES.respawnCostMultiplier) : 1;
  // Native Card.get_rawCost uses FP.AsInt after multiplying the original cost.
  // Kit-authored cost reductions remain in base.cost and are applied only once.
  return Math.floor(nonnegative(unit.base.cost) * multiplier);
}

export function mizukiDeploySlots(unit) {
  if (unit.kind !== 'op' && unit.kind !== 'token') return 0;
  if (unit.mem?.mizukiNoDeploySlot) return 0;
  if (selectedBlackboards(unit).some((bb) => bb.dont_occupy_deploy_cnt > 0)) return 0;
  const override = RULES.deploySlotOverrides?.[entityId(unit)];
  // Native Ling fusion transfers the absorbed token's volume to the survivor.
  // A withdrawn token returns as its basic form; do not charge its stale flag
  // before the original deploy hook has reset that flag.
  if (unit.alive && unit.deployed && override && unit.mem?.[override.state]) return override.volume;
  return entityRule(unit)?.occupiedRemainingCharacterCnt ?? (unit.kind === 'op' ? 1 : 0);
}

export function mizukiRetreatRefund(unit) {
  // Token.get_allowWithdrawGainCost defaults to false even for token prefabs
  // whose inherited _withdrawCostRecoverRatio still reads 0.5.
  if (unit.kind !== 'op') return 0;
  const rule = entityRule(unit);
  const paid = nonnegative(unit._mizukiPaidCost);
  let ratio = rule?.withdrawCostRecoverRatio ?? 0.5;
  const maxRatio = rule?.maxWithdrawCostRatioOfRawCost ?? 1;
  let limitByDeployUse = false;
  for (const bb of selectedBlackboards(unit)) if (Number.isFinite(bb.withdraw_cost_recover_ratio)) {
    ratio = bb.withdraw_cost_recover_ratio;
    limitByDeployUse = true; // CHG-X / EXE-X: this deployment's cost, not only the original cap.
  }
  // Native Withdraw: floor(current cost * ratio), capped by ceil(raw cost *
  // maxRatio). Charger prefabs set ratio=1; merchant prefabs set ratio=0.
  const rawCap = Math.ceil(nonnegative(unit.base.cost) * maxRatio);
  return Math.max(0, Math.min(Math.floor(Math.fround(paid * Math.fround(ratio))),
    limitByDeployUse ? Math.max(rawCap, paid) : rawCap));
}
