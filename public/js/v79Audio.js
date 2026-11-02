// Only the three V79 operators emit these signals. Repeated area refreshes and removals are silent.
export function v79EffectRole(def, kind, extra = {}) {
  if (def === 'char_4247_oxi') {
    if (kind === 'oxiFireField' && extra.on && !extra.refresh) return 'fireField';
    if (kind === 'oxiHeatwave' && extra.on) return 'heatwave';
    if (kind === 'oxiHeatwaveHit') return 'heatwaveHit';
    if (kind === 'oxiCounter') return 'counter';
    if (kind === 'overload' && extra.skill === 'skchr_oxi_3') return 'overload';
  } else if (def === 'char_4244_tocka') {
    if (kind === 'tocka_snow') return 'snow';
    if (kind === 'tocka_trigger') return ({ skchr_tocka_1: 'shield', skchr_tocka_2: 'autoSkill', skchr_tocka_3: 'spring' })[extra.skill] || null;
  } else if (def === 'char_4246_dminon') {
    if (kind === 'dminon_spread' && extra.tiles?.length) return 'expand';
    if (kind === 'dminon_collapse' && extra.tiles?.length) return 'collapse';
  }
  return null;
}
