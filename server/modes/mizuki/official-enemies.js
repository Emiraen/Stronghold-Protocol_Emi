// Only the Mizuki mode installs these original level enemies. The shared enemy
// registry and every existing automatic mode retain their previous behavior.
import { ensureInstalled, abOf, attach, nthOf, T, KITS } from '../../sim/content/enemies.js';
import { nthAttackStatus } from '../../sim/content/enemies/archetypes.js';
import { MIZUKI_ORDINARY_KITS } from './ordinary-enemies.js';
import { MIZUKI_SEA_KITS } from './native-sea-enemies.js';
import { MIZUKI_BASIC_KITS } from './native-basic-enemies.js';
import { MIZUKI_FACTION_KITS } from './native-faction-enemies.js';
import { MIZUKI_BOSS_KITS } from './boss-enemies.js';
import { MIZUKI_REACTION_KITS } from './native-reaction-enemies.js';
import { MIZUKI_SPECIAL_KITS } from './native-special-enemies.js';
import { MIZUKI_CREEP_KITS } from './native-creep-enemies.js';
import { MIZUKI_VISIBILITY_KITS } from './native-visibility-enemies.js';
import { MIZUKI_BLOODSUCKER_KITS } from './native-bloodsucker-enemies.js';
import { MIZUKI_SURVIVAL_KITS } from './native-survival-enemies.js';
import { MIZUKI_BUILDING_KITS } from './native-building-enemies.js';
import { MIZUKI_AIR_DEFENSE_KITS } from './native-air-defense-enemies.js';
import { MIZUKI_EVENT_KITS } from './native-event-enemies.js';
import { MIZUKI_LEGACY_BOSS_KITS } from './native-legacy-boss-enemies.js';
import { MIZUKI_LATERANO_KITS } from './native-laterano-enemies.js';
import { MIZUKI_FROST_BOSS_KITS } from './native-frost-boss.js';
import { MIZUKI_LEITHANIEN_KITS } from './native-leithanien-enemies.js';
import { MIZUKI_GUN_KITS } from './native-gun-enemies.js';
import { MIZUKI_TRUTH_KITS } from './native-truth-enemies.js';
import { MIZUKI_EVENT_FIRE_KITS } from './native-event-fire-enemies.js';
import { createOfficialAirSupportCommand, createOfficialAttackDroneAbilities } from './OfficialAirSupport.js';

export const MIZUKI_ENEMY_IDS = new Set(['enemy_1004_mslime', 'enemy_1047_sagent', 'enemy_1159_swfmob']);
export const supportsMizukiEnemy = (id) => MIZUKI_ENEMY_IDS.has(id);

const kits = {
  ...MIZUKI_ORDINARY_KITS,
  ...MIZUKI_SEA_KITS,
  ...MIZUKI_BASIC_KITS,
  ...MIZUKI_FACTION_KITS,
  ...MIZUKI_BOSS_KITS,
  ...MIZUKI_REACTION_KITS,
  ...MIZUKI_SPECIAL_KITS,
  ...MIZUKI_CREEP_KITS,
  ...MIZUKI_VISIBILITY_KITS,
  ...MIZUKI_BLOODSUCKER_KITS,
  ...MIZUKI_SURVIVAL_KITS,
  ...MIZUKI_BUILDING_KITS,
  ...MIZUKI_AIR_DEFENSE_KITS,
  ...MIZUKI_EVENT_KITS,
  ...MIZUKI_LEGACY_BOSS_KITS,
  ...MIZUKI_LATERANO_KITS,
  ...MIZUKI_FROST_BOSS_KITS,
  ...MIZUKI_LEITHANIEN_KITS,
  ...MIZUKI_GUN_KITS,
  ...MIZUKI_TRUTH_KITS,
  ...MIZUKI_EVENT_FIRE_KITS,
  enemy_1141_merbow_2: createOfficialAirSupportCommand,
  enemy_1145_atkspd_2: createOfficialAttackDroneAbilities,
  enemy_1004_mslime: () => [{
    sil: true,
    dealt(c, battle, enemy, _ability, ab) {
      if (!c.target?.alive) return;
      const key = 'mizuki:official:mslime:defdown';
      const previous = c.target.findBuff(key)?.mods?.defFlat ?? 0;
      battle.addBuff(c.target, { key, source: enemy, duration: Infinity,
        mods: { defFlat: previous + (T(ab, 'defdown.def') ?? 0) }, refresh: 'replace', visible: true });
    },
  }],
  enemy_1047_sagent: (ab) => {
    const skill = ab.sk.stunattack;
    return skill ? [nthAttackStatus(nthOf(skill), 'stun', skill.bb.stun ?? 0, true, skill)] : [];
  },
  enemy_1159_swfmob: () => [{
    // Re-read before every incoming hit, so blocking and silence take effect
    // immediately rather than one periodic tick after the state changes.
    hitIn(_c, battle, enemy, _ability, ab) {
      battle.addBuff(enemy, { key: 'mizuki:official:swfmob:evade',
        mods: { dodgePhys: !enemy.blockedBy && !enemy.s.flags.silence ? T(ab, 'Evade.prob') ?? 0 : 0 },
        refresh: 'replace' });
    },
  }],
};
for (const id of Object.keys(kits)) MIZUKI_ENEMY_IDS.add(id);

// Original normal/elite variants share these behavior families; each ability
// reads this level's own official blackboard, never its sibling's statistics.
const originalVariants = {
  enemy_1004_mslime_2: 'enemy_1004_mslime',
  enemy_1047_sagent_2: 'enemy_1047_sagent',
  enemy_1159_swfmob_2: 'enemy_1159_swfmob',
  enemy_1021_bslime_2: 'enemy_1021_bslime',
  enemy_1040_bombd_2: 'enemy_1040_bombd',
  enemy_1023_jmage_2: 'enemy_1023_jmage',
  enemy_1072_dlancer_2: 'enemy_1072_dlancer',
  enemy_1062_rager: 'enemy_1062_rager_2',
  enemy_1069_icebrk: 'enemy_1069_icebrk_2',
  enemy_1095_ccripr_2: 'enemy_1004_mslime',
};
for (const [id, original] of Object.entries(originalVariants)) {
  const kit = kits[original] ?? KITS[original];
  if (typeof kit !== 'function') throw new TypeError('Missing original enemy family: ' + original);
  kits[id] = kit;
  MIZUKI_ENEMY_IDS.add(id);
}

export function installMizukiEnemyBehaviors(battle) {
  if (battle._mizukiEnemyBehaviorsInstalled) return;
  battle._mizukiEnemyBehaviorsInstalled = true;
  ensureInstalled(battle);
  battle.on('enemySpawn', ({ enemy }) => {
    const kit = kits[enemy.defId];
    if (!kit || enemy.mem._mizukiOfficialKit) return;
    enemy.mem._mizukiOfficialKit = true;
    attach(battle, enemy, kit(abOf(battle, enemy), enemy, battle));
  }, { priority: 90 });
}
