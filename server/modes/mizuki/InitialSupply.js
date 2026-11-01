import { readFileSync } from 'node:fs';

const topic = JSON.parse(readFileSync(new URL('../../../data/mizuki/rogue2.json', import.meta.url), 'utf8')).rawTopic;

// The three restored opening supplies retain their original choice records and rewards.
export const MIZUKI_INITIAL_SUPPLY_IDS = Object.freeze([
  'choice_ro2_startbuff_2', 'choice_ro2_startbuff_6', 'choice_ro2_startbuff_3',
]);

export function mizukiInitialSupplyOptions() {
  return MIZUKI_INITIAL_SUPPLY_IDS.map(id => {
    const choice = topic.choices[id], itemId = choice.displayData.itemId;
    const item = topic.items[itemId];
    return { id, name: choice.title, description: choice.description,
      itemId, iconId: choice.icon || choice.displayData.funcIconId || item?.iconId,
      iconKind: item?.type === 'RELIC' ? 'relic' : 'ui' };
  });
}

export function mizukiInitialSupplyReward(choiceId) {
  if (choiceId === 'choice_ro2_startbuff_2') return { hope: 2 };
  if (choiceId === 'choice_ro2_startbuff_3') return { gold: 5 };
  if (choiceId === 'choice_ro2_startbuff_6') return { collectibleId: 'rogue_2_relic_grace_21' };
  return null;
}
