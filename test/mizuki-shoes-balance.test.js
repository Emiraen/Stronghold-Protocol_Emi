import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drawMizukiCollectible, mizukiCollectiblePool, mizukiCollectibleSpec } from '../server/modes/mizuki/Collectibles.js';
import { createMizukiRouteShop } from '../server/modes/mizuki/RouteShop.js';

const shoes = ['rogue_2_relic_fight_43', 'rogue_2_relic_fight_44'];
test('both dance shoes have exactly five times the draw weight of a normal collectible', () => {
  const regular = mizukiCollectiblePool({ rarity: 1 }).find(id => !shoes.includes(id));
  const ids = [...shoes, regular], counts = Object.fromEntries(ids.map(id => [id, 0]));
  for (let i = 0; i < 1100; i++) counts[drawMizukiCollectible({ ids, rng: () => (i + 0.5) / 1100 })]++;
  assert.deepEqual(counts, { [shoes[0]]: 500, [shoes[1]]: 500, [regular]: 100 });
  assert.equal(drawMizukiCollectible({ ids, owned: shoes, rng: () => 0 }), regular);
  assert.equal(drawMizukiCollectible({ ids: shoes, owned: shoes, rng: () => 0 }), null);
  assert.ok(shoes.every(id => !mizukiCollectiblePool({ rarity: 2 }).includes(id)));
  assert.equal(drawMizukiCollectible({ ids: [regular], rng: () => 0.9 }), regular);
});

test('both dance shoes cost 10 ingots in merchant stock and keep existing discounts', () => {
  const source = JSON.parse(readFileSync(new URL('../data/mizuki/route-event-source.json', import.meta.url), 'utf8'));
  for (const id of shoes) {
    assert.equal(source.relics[id].price, 12, 'extracted original data is preserved');
    assert.equal(mizukiCollectibleSpec(id).price, 10);
  }
  const collectibles = mizukiCollectiblePool({ shop: true }).filter(id => !shoes.includes(id));
  for (const factor of [1, 0.8]) {
    const shop = createMizukiRouteShop({ id: 'shoes-test', graphType: 'BATTLE_SHOP' },
      { seed: 31, floor: 1, collectibles, shopPriceFactor: factor });
    const offers = shop.offers.filter(offer => shoes.includes(offer.itemId));
    assert.equal(offers.length, 2);
    assert.equal(new Set(offers.map(offer => offer.itemId)).size, 2);
    for (const offer of offers) {
      assert.equal(offer.originalPrice, 10);
      assert.equal(offer.price, Math.floor(10 * factor));
    }
  }
});
