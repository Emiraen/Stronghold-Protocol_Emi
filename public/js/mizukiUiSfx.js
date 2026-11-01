import { useEffect, useRef } from '../vendor/hooks.module.js';
import { audio as sharedAudio } from './audio.js';

// Names come from the original client's soundFXBanks. In particular, the
// server's dice event chooses its sound; the rolled number alone does not.
const BANK = Object.freeze({
  item: 'ui.ON_ROGUELIKE_ITEM',
  collection: 'ui.ON_ROGUELIKE_COLLECTION',
  ticket: 'ui.ON_ROGUELIKE_MAGICCARD',
  investment: 'ui.ON_ROGUELIKE_INVESTMENT',
  floor: 'ui.ON_ROGUELIKE_CROSTAGE',
  shopBattle: 'ui.ON_ROGUELIKE_SHOPBATTLE',
});
const DICE_BANKS = new Set(['ui.ON_ROGUELIKE_DICEGREAT', 'ui.ON_ROGUELIKE_DICENORMAL', 'ui.ON_ROGUELIKE_DICEBAD']);
const BATTLE_PHASES = new Set(['PREP', 'COMBAT']);
const list = value => Array.isArray(value) ? value : [];
const count = value => Math.max(0, Number(value) || 0);
const add = (bag, key, amount = 1) => {
  if (key != null) bag.set(String(key), (bag.get(String(key)) || 0) + count(amount));
};
const gained = (before, after) => [...after].some(([key, amount]) => amount > (before.get(key) || 0));

function snapshot({ model = {}, priv = {}, phase, online, runKey, playerId, enabled = true }) {
  const collections = new Map(), tickets = new Map(), items = new Map();
  for (const item of list(model.collectibles)) add(collections, typeof item === 'string' ? item : item?.itemId || item?.id);
  for (const ticket of list(priv.tickets)) if (ticket.status === 'available') add(tickets, ticket.id, ticket.count ?? 1);
  for (const [id, amount] of Object.entries(priv.routeInventory || {})) add(items, 'inventory:' + id, amount);
  for (const [id, amount] of Object.entries(priv.routeConsumables || {})) add(items, 'consumable:' + id, amount);
  // Count equipped items too: moving an owned item back into the bag is not a reward.
  for (const item of [...list(priv.equipment?.inventory), ...list(priv.equipment?.equipped).flatMap(unit => list(unit.items))]) {
    add(items, 'equipment:' + (item.itemId || item.id || item.uid), item.count ?? 1);
  }
  for (const [id, amount] of Object.entries({ gold: priv.gold, hope: priv.hope, life: priv.life, shield: priv.shield,
    dice: model.dice?.count, key: model.key })) add(items, 'resource:' + id, amount);
  const floor = model.exploration?.floor;
  const san = model.sanCheck;
  const rawSound = san?.check?.sound;
  const diceSound = typeof rawSound === 'string' ? (rawSound.startsWith('ui.') ? rawSound : 'ui.' + rawSound) : null;
  return { identity: String(runKey || '') + ':' + String(playerId || ''), online: !!online, enabled,
    phase, collections, tickets, items,
    floor: floor ? String(floor.key ?? floor.id ?? floor.index) : null,
    diceId: san?.id || null, diceSound: DICE_BANKS.has(diceSound) ? diceSound : null };
}

/** Follow committed gains, so a failed purchase/vote never sounds like a reward. */
export function createMizukiUiSfxController({ audio = sharedAudio } = {}) {
  let previous = null, routeFloor = null;
  const play = bank => { if (bank) audio.sfx('mizuki:' + bank); };
  return {
    update(input) {
      const next = snapshot(input), before = previous;
      previous = next;
      // Initial snapshots and reconnects describe existing possessions. Adopt
      // that state without replaying the run's earlier drops or dice checks.
      if (!next.enabled || !next.online || !before?.enabled || !before.online || before.identity !== next.identity) {
        routeFloor = next.floor;
        return;
      }
      if (next.phase === 'MIZUKI_ROUTE' && next.floor && next.floor !== routeFloor) {
        routeFloor = next.floor;
        play(BANK.floor);
      }
      if (next.diceId && next.diceId !== before.diceId) play(next.diceSound);
      // Battle coin/hope effects run continuously; their UI audio belongs to
      // battle playback, while node gains use the original roguelike sounds.
      if (BATTLE_PHASES.has(next.phase)) return;
      if (gained(before.collections, next.collections)) play(BANK.collection);
      else if (gained(before.tickets, next.tickets)) play(BANK.ticket);
      else if (gained(before.items, next.items)) play(BANK.item);
    },
    success(kind, payload = {}) {
      if (!previous?.enabled || !previous.online) return;
      if (kind === 'bank' && payload.action === 'deposit') play(BANK.investment);
      else if (kind === 'shopBattle') play(BANK.shopBattle);
      else if (kind === 'recruit' && String(payload.offerId || '').startsWith('ticket:')) play(BANK.ticket);
    },
  };
}

export function useMizukiUiSfx(input) {
  const controller = useRef(null);
  if (!controller.current) controller.current = createMizukiUiSfxController();
  useEffect(() => { controller.current.update(input); }, [input.model, input.priv, input.phase, input.online,
    input.runKey, input.playerId, input.enabled]);
  return (kind, payload) => controller.current.success(kind, payload);
}
