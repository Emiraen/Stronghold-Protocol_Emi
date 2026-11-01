import assert from 'node:assert/strict';
import { MIZUKI_PHASES as PHASE } from '../../shared/mizuki-constants.js';

// Read each revision's authoritative token; a successful choice changes the
// page and may change the active voucher, invalidating all previous tokens.
export function skipMizukiRecruit(match, playerIds = match.order
  .filter((player) => player.connected && !player.left).map((player) => player.playerId)) {
  for (let turn = 0; turn < 64; turn++) {
    let acted = false;
    for (const playerId of playerIds) {
      const state = match.privateView(playerId).mizuki;
      if (state.phase !== PHASE.RECRUIT || state.ready) continue;
      assert.ok(state.recruit?.skipToken, 'pending recruitment exposes a current skip token');
      assert.deepEqual(match.handle(playerId, { t: 'g.mizuki.recruit', offerId: state.recruit.skipToken }), { ok: true });
      acted = true;
    }
    if (!acted) return;
  }
  assert.fail('recruitment voucher queue did not converge');
}
