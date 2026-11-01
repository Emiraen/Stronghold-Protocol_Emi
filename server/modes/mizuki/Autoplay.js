import { MIZUKI_PHASES as PHASE } from '../../../shared/mizuki-constants.js';
import { MIZUKI_SQUADS } from '../../../shared/mizuki-squads.js';
import { attackRangeGrid } from '../../../shared/loadoutRecord.js';
import { offsetTile } from '../../sim/dir.js';
import { mizukiPrepView } from './Prep.js';

const pointKey = (row, col) => row + ',' + col;
const distance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const readyChoice = choice => choice && !choice.disabled && choice.available !== false;
const command = (t, body = {}) => ({ t, ...body });
const rosterScore = unit => Number(unit.rarity || 0) * 10 + (unit.promotion ? 4 : 0);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function teammateChoice(match, player, choices, votes) {
  const eligible = choices.filter(readyChoice);
  for (const actor of match._actors()) {
    if (actor === player || actor.autoplay) continue;
    const chosen = eligible.find(choice => choice.id === votes?.[actor.playerId]);
    if (chosen) return chosen;
  }
  return null;
}

function pieceDefinition(match, player, piece) {
  const owner = player.roster.find(unit => unit.uid === (piece.kind === 'token' ? piece.ownerUid : piece.uid));
  if (!owner) return null;
  const def = match.ds.getChess(owner.chessId, { skillIndex: owner.skillIndex, moduleId: owner.moduleId });
  return piece.kind === 'token' ? match.ds.getToken(piece.id, owner.chessId, def?.loadout) : def;
}

function placement(match, player, piece, view, context) {
  const occupied = new Set(view.board.map(unit => pointKey(unit.row, unit.col)));
  const tiles = (view.legalTiles[piece.uid] || []).filter(([row, col]) => !occupied.has(pointKey(row, col)));
  if (!tiles.length) return null;
  const grid = context.grid, roads = [], exits = [], starts = [];
  for (let row = grid.rect.r0; row <= grid.rect.r1; row++) for (let col = grid.rect.c0; col <= grid.rect.c1; col++) {
    const tile = grid.tile(row, col);
    if (tile.special === 'end') exits.push([row, col]);
    if (tile.special === 'start') starts.push([row, col]);
    if (tile.pass === 'ALL' && !grid.isObstacle(row, col)) roads.push([row, col]);
  }
  const def = pieceDefinition(match, player, piece), range = attackRangeGrid(def?.raw || def) || def?.rangeGrid || [[0, 1]];
  const healer = /MEDIC|SUPPORT/.test(def?.profession || def?.raw?.profession || '')
    && (/MEDIC/.test(def?.profession || def?.raw?.profession || '') || def?.stats?.atk === 0);
  const melee = def?.position === 'MELEE' || piece.position === 'MELEE';
  let best = null;
  for (const [row, col] of tiles) for (const dir of ['RIGHT', 'UP', 'LEFT', 'DOWN']) {
    const covered = new Set(range.map(([dr, dc]) => offsetTile(row, col, dr, dc, dir)).map(([r, c]) => pointKey(r, c)));
    const nearestExit = exits.length ? Math.min(...exits.map(target => distance([row, col], target))) : 3;
    const nearestStart = starts.length ? Math.min(...starts.map(target => distance([row, col], target))) : 3;
    const allies = view.board.filter(unit => unit.kind === 'chess');
    const inRange = healer ? allies.filter(unit => covered.has(pointKey(unit.row, unit.col))).length * 12
      : roads.filter(([r, c]) => covered.has(pointKey(r, c))).length * 3;
    const proximity = allies.length ? Math.min(...allies.map(unit => distance([row, col], [unit.row, unit.col]))) : 2;
    const score = inRange + (melee ? 10 - Math.abs(nearestExit - 2) * 2 : 6 - Math.min(6, proximity))
      - (nearestStart <= 1 ? 3 : 0) - row * 0.001 - col * 0.00001;
    if (!best || score > best.score) best = { row, col, dir, score };
  }
  return best && command('g.mizuki.move', { uid: piece.uid, to: { area: 'board', row: best.row, col: best.col }, dir: best.dir });
}

function prepare(match, player) {
  if (player.ready) return null;
  const available = player.roster.filter(unit => !unit.expedition);
  if (!player.lineup.length && available.length) return command('g.mizuki.lineup', {
    uids: [...available].sort((a, b) => rosterScore(b) - rosterScore(a)).slice(0, match.squadCapacity).map(unit => unit.uid)
  });
  const context = match._prepContext(player);
  if (!context.grid) return null;
  const view = mizukiPrepView(player, context);
  const candidates = [...view.temp, ...view.hand].filter(piece => piece && !piece.toolId)
    .sort((a, b) => Number(a.kind === 'token') - Number(b.kind === 'token'));
  for (const piece of candidates) {
    if (piece.kind === 'chess' && view.deployCount >= view.deployCap) continue;
    const move = placement(match, player, piece, view, context);
    if (move) return move;
  }
  const temporary = view.temp.find(piece => piece && !piece.toolId);
  if (temporary) {
    const idx = view.hand.findIndex(piece => !piece);
    if (idx >= 0) return command('g.mizuki.move', { uid: temporary.uid, to: { area: 'hand', idx } });
    // Only change this battle's lineup; keep every recruited operator in the roster.
    const uid = temporary.kind === 'token' ? temporary.ownerUid : temporary.uid;
    if (player.lineup.includes(uid)) return command('g.mizuki.lineup', { uids: player.lineup.filter(id => id !== uid) });
    return null;
  }
  return command('g.mizuki.ready', { on: true });
}

function phaseAction(match, player) {
  if (match.floorState.pending) return null;
  if (match.phase === PHASE.EVENT && match.event?.state?.pendingWish) {
    const wish = match._wishPublicView();
    return wish?.memberIds.includes(player.playerId) && !own(wish.votes, player.playerId)
      ? command('g.mizuki.sanVote', { id: wish.id, choice: 'accept' }) : null;
  }
  const equipment = player.equipmentOffers?.[0];
  if (!player.ready && equipment && [PHASE.PREP, PHASE.ROUTE, PHASE.RECRUIT, PHASE.REWARD, PHASE.EVENT, PHASE.SHOP].includes(match.phase)) {
    const value = equipment.choices?.[0];
    if (value) return command('g.mizuki.equipmentPick', { offerId: equipment.id,
      [equipment.kind === 'item' ? 'itemId' : 'operatorId']: value });
  }
  if (match.phase === PHASE.SQUAD && !match.squadVotes[player.playerId]) {
    const vote = teammateChoice(match, player, MIZUKI_SQUADS, match.squadVotes);
    return command('g.mizuki.squad', { squadId: (vote || MIZUKI_SQUADS[0]).id });
  }
  if (match.phase === PHASE.STRATEGY && !player.strategyReady) {
    const choice = match.strategyOptions.find(band => !match._active().some(other => other !== player && other.bandId === band.bandId));
    return choice && command('g.mizuki.strategy', { bandId: choice.bandId });
  }
  if (match.phase === PHASE.INITIAL_SUPPLY && !player.initialSupplyReady)
    return command('g.mizuki.initialSupply', { choiceId: 'choice_ro2_startbuff_2' });
  if (match.phase === PHASE.RECRUIT_GROUP && !player.recruitGroupReady) {
    const choice = match._recruitGroupOptions().find(readyChoice);
    return choice && command('g.mizuki.recruitGroup', { groupId: choice.id });
  }
  if (match.phase === PHASE.RECRUIT && !player.ready) {
    const view = match._recruitView(player);
    const professions = new Set(player.roster.map(unit => unit.profession));
    const choice = view?.choices.filter(readyChoice).sort((a, b) =>
      (rosterScore(b) + (!professions.has(b.profession) ? 5 : 0)) - (rosterScore(a) + (!professions.has(a.profession) ? 5 : 0)))[0];
    const offerId = choice?.offerId || view?.skipToken;
    return offerId && command('g.mizuki.recruit', { offerId });
  }
  if (match.phase === PHASE.REWARD && !player.ready) {
    const selectedGroups = new Set(player.rewards.filter(reward => reward.selected && reward.group).map(reward => reward.group));
    const reward = player.rewards.find(value => readyChoice(value) && !value.selected && (!value.group || !selectedGroups.has(value.group)));
    return reward && command('g.mizuki.reward', { rewardId: reward.id });
  }
  if (match.phase === PHASE.PREP) return prepare(match, player);
  if (match.phase === PHASE.SHOP && !player.ready) return command('g.mizuki.ready', { on: true });
  if (match.phase === PHASE.EVENT && !match.votes[player.playerId]) {
    const choices = (match.event?.choices || []).filter(readyChoice);
    const choice = teammateChoice(match, player, choices, match.votes) || choices.find(value =>
      !/消耗.*目标生命|失去.*目标生命|战斗/.test(value.description || '')) || choices[0];
    return choice && command('g.mizuki.event', { choiceId: choice.id });
  }
  if (match.phase === PHASE.ROUTE) {
    const mission = match.routeMissions.missions.find(value => value.status === 'complete'
      && !value.claimPartyId && value.memberIds.includes(player.playerId));
    if (mission && !match.expedition.barrier) return command('g.mizuki.missionClaim', { missionId: mission.id });
    if (match.votes[player.playerId]) return null;
    const choices = match.route.filter(readyChoice), lifeRatio = player.life / Math.max(1, player.maxLife);
    const score = node => ({ recruit: player.roster.length < 6 ? 8 : 3, shop: player.gold >= 5 ? 5 : 0,
      event: 4, combat: 3, elite: lifeRatio > 0.7 ? 2 : -2, boss: 1 }[node.type] || 0);
    const choice = teammateChoice(match, player, choices, match.votes) || choices.sort((a, b) => score(b) - score(a))[0];
    return choice && command('g.mizuki.route', { nodeId: choice.id });
  }
  return null;
}

function globalAction(match, player) {
  const prompt = match.expedition.recallPrompt(player.playerId);
  if (prompt) return command('g.mizuki.recallRespond', { requestId: prompt.requestId, accept: true });
  const recall = match.expedition.recalls.find(value => value.status === 'voting'
    && value.electorate.includes(player.playerId) && !own(value.votes, player.playerId));
  if (recall) return command('g.mizuki.recallVote', { requestId: recall.id, agree: true });
  const check = match.floorState.pending;
  if (check && check.memberIds.includes(player.playerId) && !own(check.votes, player.playerId)) return command('g.mizuki.sanVote', { id: check.id, choice: 'accept' });
  const party = match.expedition.partyFor(player.playerId);
  if ((match.partyStates.get(party?.id)?.event || (!match.partyStates.size && match.event))?.state?.pendingWish) return null;
  if (player.playerId !== match.expedition.leaderId || check || !match.partyStates.size) return null;
  const split = match.expedition.requests.find(value => value.status === 'pending');
  if (split) return command('g.mizuki.splitDecide', { requestId: split.id, approve: false });
  const online = match.order.filter(actor => actor.connected && actor.alive && !actor.left).map(actor => actor.playerId);
  const ready = [...match.expedition.parties.values()].some(party => {
    const id = match.expedition.choice(party.id, online);
    return id && match.partyStates.get(party.id)?.route.some(node => node.id === id);
  });
  return ready ? command('g.mizuki.routeStart') : null;
}

/** Timed choices use the same authoritative commands and legality as a doctor. */
export function createMizukiAutoplay(match) {
  let timer = null, running = false, stopped = false;
  const actors = () => match.order.filter(player => player.autoplay && player.alive && !player.left && player.connected);
  const stopTimer = () => { if (timer !== null) match.sched.clearTimeout(timer); timer = null; };
  const sync = () => {
    if (stopped || running) return;
    if (match.disposed || match.ended || !match.started || match.manualPaused || !actors().length) { stopTimer(); return; }
    if (timer === null) timer = match.sched.setTimeout(tick, 750);
  };
  const tick = () => {
    timer = null;
    if (stopped || match.disposed || match.ended || !match.started || match.manualPaused) return;
    running = true;
    let changed = false;
    try {
      for (const player of actors()) {
        if (match.disposed || match.ended) break;
        let next = globalAction(match, player);
        if (!next) {
          const party = match.expedition.partyFor(player.playerId);
          next = match.partyStates.size && party ? match._withParty(party, () => phaseAction(match, player)) : phaseAction(match, player);
        }
        if (next) {
          const before = match.revision;
          match.handle(player.playerId, next);
          // A contested reward may replace its candidates and return an error;
          // its committed replacement still needs the next automatic choice.
          changed = changed || match.revision !== before;
        }
      }
    } catch (error) { match.log.warn('[mizuki] autoplay', error); }
    finally { running = false; }
    // A human action or battle transition wakes a waiting seat through _commit.
    if (changed) sync();
  };
  return { sync, dispose() { stopped = true; stopTimer(); } };
}
