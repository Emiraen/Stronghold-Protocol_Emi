// Mode-local bridges for original strategy concepts without a visible shop.
import { readFileSync } from 'node:fs';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { toDataSource } from '../../sim/simdata.js';
import { duckReplace, DUCK_BAND } from '../../sim/content/bands/meta.js';

const RAW_BANDS = JSON.parse(readFileSync(new URL('../../../data/bands.json', import.meta.url), 'utf8'));
const ROUTE_ROUND_GRANTS = new Set([
  'preparation_start_gain_chess_from_round', 'preparation_start_gain_chess_every_n_round',
  'prep_start_gain_chess_from_pool_in_round', 'gain_bond_char_per_round',
  'round_start_gain_char_chess_in_shop_every_n_round', 'preparation_start_add_special_goods_every_n_round',
]);

/** Candidate-changing strategies only create a special page on an explicit refresh. */
export function mizukiStrategySpecialRecruitRefresh(band, player) {
  return !!band?.buffs?.some(buff => buff.key === 'up_shop_next_refresh_must_present_bond_char'
    ? (player.metaCounters?.['band:pepe:special'] || 0) > 0
    : buff.key === 'band_shop_refresh_copy_max_lv_char'
      || buff.key === 'band_first_self_refresh_present_char' && (player.recruitRefreshes || 0) <= 2);
}

// A Mizuki round advances for every completed node, including noncombat nodes.
// Grant-only rules can run when its route opens; board-dependent rules such as
// Lisa and Yu must retain their preparation timing after the player has placed units.
export function mizukiStrategyRouteHook(band, hook) {
  if (hook === 'onRoundStart') return !!band?.buffs?.some(buff => ROUTE_ROUND_GRANTS.has(buff.key));
  return hook === 'onIncome' && !!band?.buffs?.some(buff => buff.key === 'give_coin_in_round');
}

export function mizukiStrategyDeferredPrepRound(band) {
  const buff = band?.buffs?.find(value => value.key === 'round_start_bond_check_gain_layer');
  const round = Number(buff?.bb?.round);
  return Number.isInteger(round) && round > 0 ? round : null;
}

export function mizukiStrategyStartingLife(player, band, initial) {
  if (band?.bandId !== 'band_sarkazb') return;
  // 45 versus the standard 30 LP is a 50% bonus in Mizuki's own LP scale.
  const ratio = Math.max(1, Number(band.totalHp) / 30);
  const bonus = Math.max(0, Math.ceil(initial.initialMaxHp * (ratio - 1)));
  player.maxLife = Math.min(9999, player.maxLife + bonus);
  player.life = Math.min(player.maxLife, player.life + bonus);
}

export function mizukiStrategyReserveSlots({ player, rollChess, stage, count = 5 }) {
  if (!['band_makiri', 'band_vodfox'].includes(player?.bandId)) return [];
  const ids = new Set();
  for (let index = 0; index < count; index++) {
    const id = rollChess({ maxTier: stage, filter: candidate => !ids.has(candidate) });
    if (id) ids.add(id);
  }
  return [...ids].map(id => ({ id, kind: 'chess', sold: false, basePrice: 0 }));
}

/** Rewrite already selected official wave copies, keeping scheduler tags intact. */
export function installMizukiDuckStrategy(battle, waves) {
  if (!waves || !battle?.players?.length) return [];
  const holders = battle.players.filter(player => {
    const info = player.input?.contentInfo;
    return (info?.matchBands || [player.bandId]).includes(DUCK_BAND) && (info?.round || 0) >= 5;
  });
  if (!holders.length) return [];
  const rawBand = RAW_BANDS[DUCK_BAND];
  const buff = rawBand?.buffs?.find(value => value.key === 'round_start_all_player_change_enemy_2');
  if (!buff) return [];
  const params = { ...buff.bb, ...buff.bbStr };
  const ordinary = toDataSource(battle.data.raw), originalEnemy = battle.data.getEnemy.bind(battle.data);
  const duckIds = new Set(String(params.enemylist || '').split(',').filter(id => ordinary.getEnemy(id)));
  const data = Object.create(battle.data);
  data.getEnemy = id => originalEnemy(id) || (duckIds.has(id) ? ordinary.getEnemy(id) : null);
  battle.data = data;
  const pending = waves.waves.flatMap(wave => wave.fragments.flatMap(fragment => fragment.actions.flatMap(entry => entry.pending)));
  const modified = [];
  // Official pair fields share one route network. Distribute the available
  // copies once across players rather than replacing the same body twice.
  const selected = new Set();
  for (const player of holders) {
    const rows = pending.map((spawn, index) => ({ ...spawn, time: index, count: 1, tag: null,
      _sourceIndex: index, ...(selected.has(index) ? { tag: 'already-replaced' } : {}) }));
    const gd = { enemy: id => {
      const def = data.getEnemy(id);
      return def ? { rank: def.rank, notCountInTotal: def.notCountInTotal, stats: { motion: def.motion } } : null;
    } };
    const changed = duckReplace({ gd, rng: createRng(deriveSeed(battle.seed, 'mizuki-duck:' + player.playerId)) }, rows, params, player.playerId);
    for (const row of changed) {
      const target = pending[row._sourceIndex];
      if (!target || selected.has(row._sourceIndex)) continue;
      selected.add(row._sourceIndex);
      target.enemyKey = row.enemyKey;
      target.bounty = row.bounty;
      modified.push({ enemyKey: row.enemyKey, tag: target.tag, bounty: { ...row.bounty } });
    }
  }
  return modified;
}
