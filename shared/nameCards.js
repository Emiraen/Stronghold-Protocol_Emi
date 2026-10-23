/** Reserved presentation.card / room.card.charId; it is not an operator identity. */
export const SPECIAL_GOOD_BOY_CARD = 'special_good_boy';
export const SPECIAL_TRICKSTER_CARD = 'special_trickster';
export const SPECIAL_PAINTBRUSH_TACTICS_CARD = 'special_paintbrush_tactics';
export const SPECIAL_SOFT_AND_DEADLY_CARD = 'special_soft_and_deadly';
export const SPECIAL_HATCHBUDZ_QUACKED_CARD = 'special_hatchbudz_quacked';
export const SPECIAL_COMMANDER_BRUNO_CARD = 'special_commander_bruno';
/** Each rank milestone grants its card and matching avatar permanently. */
export const EVORI_RANK_NAME_CARDS = Object.freeze([
  Object.freeze({ card: 'special_evori_solari', minimumDivision: 'gold', name: '太阳鼠', directory: 'evori-solari', description: '段位纪念' }),
  Object.freeze({ card: 'special_evori_lunari', minimumDivision: 'platinum', name: '露娜猫', directory: 'evori-lunari', description: '段位纪念' }),
  Object.freeze({ card: 'special_evori_amari', minimumDivision: 'diamond', name: '玛玛熊', directory: 'evori-amari', description: '段位纪念' }),
  Object.freeze({ card: 'special_evori_terrari', minimumDivision: 'ascendant', name: '耷拉兔', directory: 'evori-terrari', description: '段位纪念' }),
  Object.freeze({ card: 'special_evori_evori', minimumDivision: 'immortal', name: '艾沃莉', directory: 'evori-evori', description: '段位纪念' }),
]);
const OPEN_SPECIAL_NAME_CARDS = Object.freeze([
  'special_duck_burnard', 'special_duck_flower', 'special_duck_brioche',
  SPECIAL_SOFT_AND_DEADLY_CARD, SPECIAL_HATCHBUDZ_QUACKED_CARD, SPECIAL_COMMANDER_BRUNO_CARD,
]);
export const isSpecialNameCard = (card) => card === SPECIAL_GOOD_BOY_CARD || card === SPECIAL_TRICKSTER_CARD
  || card === SPECIAL_PAINTBRUSH_TACTICS_CARD || OPEN_SPECIAL_NAME_CARDS.includes(card)
  || EVORI_RANK_NAME_CARDS.some((reward) => reward.card === card);
/** The server publishes permanent aid-bound unlocks in rank.me. Viewing needs no entitlement. */
export const canUseSpecialNameCard = (summary, card = SPECIAL_GOOD_BOY_CARD) => OPEN_SPECIAL_NAME_CARDS.includes(card)
  || (isSpecialNameCard(card) && Array.isArray(summary?.unlockedNameCards) && summary.unlockedNameCards.includes(card));
