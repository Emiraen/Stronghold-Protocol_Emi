// User-requested multiplayer orchestration. This does not generate native nodes,
// choose battle rules, combine covenant layers, or award exploration rewards.
const copy = value => structuredClone(value);
const fail = error => ({ ok: false, error });
const phases = new Set(['ROUTE', 'PREP', 'COMBAT', 'UNITE', 'REWARD', 'EVENT', 'SHOP', 'RECRUIT', 'WAITING']);
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 192;
const available = (ids, nodeId) => Array.isArray(ids) && ids.includes(nodeId);
const recallStatuses = new Set(['voting', 'scheduled', 'completed', 'rejected', 'cancelled', 'superseded']);
const pendingRecall = request => request.status === 'voting' || request.status === 'scheduled';
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

export class MizukiTeamExpedition {
  constructor({ players, leaderId, context = null } = {}) {
    if (!Array.isArray(players) || players.length < 1 || players.length > 4
      || players.some(p => !validId(p?.playerId) || !Number.isInteger(p.seat) || p.seat < 0 || p.seat > 3)
      || new Set(players.map(p => p.playerId)).size !== players.length
      || new Set(players.map(p => p.seat)).size !== players.length
      || !players.some(p => p.playerId === leaderId)) throw new TypeError('Invalid Mizuki expedition members');
    this.players = copy(players).sort((a, b) => a.seat - b.seat);
    this.leaderId = leaderId;
    this.sequence = 1; this.requestSequence = 0; this.revision = 0;
    this.requests = []; this.barrier = null; this.memberContexts = {};
    this.recallSequence = 0; this.recalls = [];
    const party = this._party('party-1', this.players.map(p => p.playerId), context);
    this.parties = new Map([[party.id, party]]);
  }

  _party(id, memberIds, context, originId = id) {
    return { id, originId, memberIds: [...memberIds], phase: 'ROUTE', votes: {},
      nodeId: null, approvedNodeId: null, completedNodes: 0, context: copy(context), rendezvous: null };
  }
  partyFor(playerId) { return [...this.parties.values()].find(p => p.memberIds.includes(playerId)) || null; }
  _pending(party) { return this.requests.some(r => r.status === 'pending' && r.originId === party.originId); }
  vote(playerId, nodeId, availableIds) {
    const party = this.partyFor(playerId);
    if (!party || party.phase !== 'ROUTE' || party.recallHold || this._awaitingRecall(party)) return fail('WRONG_PHASE');
    if (!available(availableIds, nodeId) || (party.approvedNodeId && nodeId !== party.approvedNodeId)) return fail('BAD_TARGET');
    party.votes[playerId] = nodeId; this.revision++;
    return { ok: true };
  }
  requestSplit(playerId, nodeId, availableIds) {
    const party = this.partyFor(playerId);
    if (!party || party.phase !== 'ROUTE' || party.recallHold || this._awaitingRecall(party) || party.memberIds.length < 2 || party.approvedNodeId) return fail('WRONG_PHASE');
    if (!available(availableIds, nodeId)) return fail('BAD_TARGET');
    if (this.requests.some(r => r.status === 'pending' && r.playerId === playerId)) return fail('ALREADY');
    if (party.memberIds.every(id => party.votes[id] === nodeId)) return fail('SAME_NODE');
    party.votes[playerId] = nodeId;
    const request = { id: 'split-' + ++this.requestSequence, playerId, partyId: party.id, originId: party.originId,
      nodeId, status: 'pending' };
    this.requests.push(request); this.revision++;
    return { ok: true, request: copy(request) };
  }
  decideSplit(leaderId, requestId, approve, availableIds) {
    if (leaderId !== this.leaderId) return fail('NOT_LEADER');
    if (typeof approve !== 'boolean') return fail('BAD_TARGET');
    const request = this.requests.find(r => r.id === requestId && r.status === 'pending');
    if (!request) return fail('BAD_TARGET');
    const source = this.parties.get(request.partyId);
    if (!source || source.phase !== 'ROUTE' || source.recallHold || this._awaitingRecall(source) || !source.memberIds.includes(request.playerId)) return fail('STALE_REQUEST');
    if (!approve) { request.status = 'denied'; this.revision++; return { ok: true, approved: false }; }
    if (!available(availableIds, request.nodeId)) return fail('BAD_TARGET');
    if (source.memberIds.every(id => source.votes[id] === request.nodeId)) return fail('SAME_NODE');
    if (source.memberIds.length < 2) return fail('WRONG_PHASE');
    let target = [...this.parties.values()].find(p => p.id !== source.id && p.originId === source.originId
      && p.phase === 'ROUTE' && p.approvedNodeId === request.nodeId);
    if (!target) {
      target = this._party('party-' + ++this.sequence, [], source.context, source.originId);
      target.completedNodes = source.completedNodes; target.approvedNodeId = request.nodeId;
      this.parties.set(target.id, target);
    }
    source.memberIds = source.memberIds.filter(id => id !== request.playerId);
    delete source.votes[request.playerId];
    target.memberIds.push(request.playerId);
    target.memberIds.sort((a, b) => this.players.findIndex(p => p.playerId === a) - this.players.findIndex(p => p.playerId === b));
    target.votes[request.playerId] = request.nodeId; request.status = 'approved'; request.targetPartyId = target.id;
    this.revision++;
    return { ok: true, approved: true, sourcePartyId: source.id, partyId: target.id };
  }
  choice(partyId, onlineIds = null) {
    const party = this.parties.get(partyId);
    if (!party || party.phase !== 'ROUTE' || party.recallHold || this._awaitingRecall(party) || this._pending(party)) return null;
    if (party.approvedNodeId) return party.approvedNodeId;
    const actors = party.memberIds.filter(id => !onlineIds || onlineIds.includes(id));
    if (!actors.length || actors.some(id => !validId(party.votes[id]))) return null;
    const counts = new Map();
    for (const id of actors) counts.set(party.votes[id], (counts.get(party.votes[id]) || 0) + 1);
    const maximum = Math.max(...counts.values());
    const tied = [...counts].filter(([, n]) => n === maximum).map(([id]) => id);
    const decidingMember = actors.includes(this.leaderId) ? this.leaderId : actors[0];
    return tied.includes(party.votes[decidingMember]) ? party.votes[decidingMember] : tied[0];
  }
  setContext(partyId, context) {
    const party = this.parties.get(partyId);
    if (!party) return fail('BAD_TARGET');
    party.context = copy(context);
    for (const id of party.memberIds) this.memberContexts[id] = copy(context);
    this.revision++; return { ok: true };
  }
  startNode(partyId, node, { phase = 'PREP', onlineIds = null, bossRendezvous = true } = {}) {
    const party = this.parties.get(partyId);
    if (!party || party.phase !== 'ROUTE' || party.recallHold || this._awaitingRecall(party) || this._pending(party)) return fail('WRONG_PHASE');
    if (!validId(node?.id) || !phases.has(phase) || ['ROUTE', 'WAITING'].includes(phase)) return fail('BAD_TARGET');
    if (this.choice(partyId, onlineIds) !== node.id) return fail('NOT_READY');
    if (bossRendezvous && ['boss', 'BATTLE_BOSS'].includes(node.type) && this.parties.size > 1) return fail('RENDEZVOUS_REQUIRED');
    party.phase = phase; party.nodeId = node.id; party.votes = {}; party.approvedNodeId = null;
    this.revision++; return { ok: true };
  }
  setPhase(partyId, phase) {
    const party = this.parties.get(partyId);
    if (!party || !phases.has(phase) || phase === 'WAITING') return fail('BAD_TARGET');
    party.phase = phase; this.revision++; return { ok: true };
  }
  completeNode(partyId, { context } = {}) {
    const party = this.parties.get(partyId);
    if (!party || ['ROUTE', 'WAITING'].includes(party.phase)) return fail('WRONG_PHASE');
    if (context !== undefined) this.setContext(partyId, context);
    party.completedNodes++; party.phase = 'ROUTE'; party.nodeId = null; party.votes = {};
    party.originId = party.id; this.revision++; return { ok: true };
  }

  // A recall is a team ballot plus each invited doctor's explicit consent.
  // Neither a majority nor the leader can force a doctor to change branches.
  proposeRecall(leaderId, targetIds) {
    if (leaderId !== this.leaderId) return fail('NOT_LEADER');
    const leader = this.partyFor(leaderId);
    if (!leader || leader.phase !== 'ROUTE' || leader.recallHold || this.barrier) return fail('WRONG_PHASE');
    if (!Array.isArray(targetIds) || !targetIds.length || targetIds.length > 3
      || new Set(targetIds).size !== targetIds.length
      || targetIds.some(id => !validId(id) || id === leaderId || !this.partyFor(id) || this.partyFor(id) === leader)) return fail('BAD_TARGET');
    if (this.recalls.some(pendingRecall)) return fail('ALREADY');
    if (this.recalls.length >= 4096) return fail('LIMIT');
    const request = { id: 'recall-' + ++this.recallSequence, leaderId,
      targetIds: [...targetIds], electorate: this.players.map(p => p.playerId),
      votes: { [leaderId]: true }, responses: {}, returnedIds: [], status: 'voting',
      // A doctor already on the route answers now; a doctor inside a node
      // answers only after that whole node (including its rewards) is finished.
      due: { leader: leader.completedNodes,
        targets: Object.fromEntries(targetIds.map(id => {
          const party = this.partyFor(id);
          return [id, party.completedNodes + (party.phase === 'ROUTE' ? 0 : 1)];
        })) } };
    this.recalls.push(request); this.revision++;
    this._advanceRecall(request);
    return { ok: true, request: copy(request) };
  }

  _advanceRecall(request) {
    if (!pendingRecall(request)) return;
    if (request.targetIds.every(id => request.responses[id] === false)) { request.status = 'rejected'; return; }
    if (request.status !== 'voting') return;
    const majority = Math.floor(request.electorate.length / 2) + 1;
    const votes = Object.values(request.votes);
    if (votes.filter(v => v === true).length >= majority) request.status = 'scheduled';
    else if (votes.filter(v => v === false).length > request.electorate.length - majority) request.status = 'rejected';
  }

  voteRecall(playerId, requestId, agree) {
    const request = this.recalls.find(r => r.id === requestId);
    if (!request || request.status !== 'voting' || !request.electorate.includes(playerId)
      || typeof agree !== 'boolean') return fail('BAD_TARGET');
    if (Object.hasOwn(request.votes, playerId)) return request.votes[playerId] === agree ? { ok: true } : fail('ALREADY');
    request.votes[playerId] = agree; this._advanceRecall(request); this.revision++;
    return { ok: true, status: request.status };
  }

  recallPrompt(playerId) {
    const party = this.partyFor(playerId);
    if (!party || party.phase !== 'ROUTE' || this.barrier) return null;
    const request = this.recalls.find(r => pendingRecall(r) && r.targetIds.includes(playerId)
      && !Object.hasOwn(r.responses, playerId) && !r.returnedIds.includes(playerId)
      && party.completedNodes >= r.due.targets[playerId]);
    if (!request || this.partyFor(request.leaderId) === party) return null;
    return { requestId: request.id, leaderId: request.leaderId, status: request.status,
      targetIds: [...request.targetIds] };
  }

  _awaitingRecall(party) {
    // Keep a confirmed doctor at the same safe boundary while the remaining
    // team ballots arrive; an unanswered invitation must not be skipped either.
    return party.phase === 'ROUTE' && this.recalls.some(request => pendingRecall(request)
      && party.memberIds.some(id => request.targetIds.includes(id) && request.responses[id] !== false
        && !request.returnedIds.includes(id) && party.completedNodes >= request.due.targets[id]));
  }

  respondRecall(playerId, requestId, accept) {
    const request = this.recalls.find(r => r.id === requestId);
    if (!request || !request.targetIds.includes(playerId)
      || typeof accept !== 'boolean') return fail('BAD_TARGET');
    // A retried acknowledgement after a reconnect must not change the answer
    // or re-apply a completed membership move.
    if (Object.hasOwn(request.responses, playerId)) return request.responses[playerId] === accept
      ? { ok: true, status: request.status } : fail('ALREADY');
    if (!pendingRecall(request)) return fail('BAD_TARGET');
    if (this.recallPrompt(playerId)?.requestId !== requestId) return fail('WRONG_PHASE');
    // The personal confirmation also supplies this doctor's still-missing team
    // ballot, so two-player expeditions do not require a second menu action.
    if (request.status === 'voting' && !Object.hasOwn(request.votes, playerId)) request.votes[playerId] = accept;
    request.responses[playerId] = accept; this._advanceRecall(request); this.revision++;
    return { ok: true, status: request.status };
  }

  _cancelRecalls(status) {
    let changed = false;
    for (const request of this.recalls) if (pendingRecall(request)) { request.status = status; changed = true; }
    for (const party of this.parties.values()) if (party.recallHold) { delete party.recallHold; changed = true; }
    if (changed) this.revision++;
  }

  // Match calls this only outside a party scope, after saving its node state.
  // The returned deltas let it clone a detached member's actual route state.
  resolveRecalls() {
    const result = { ok: true, changed: false, created: [], moved: [], removedPartyIds: [] };
    const before = JSON.stringify({ parties: [...this.parties.values()], recalls: this.recalls });
    for (const party of this.parties.values()) delete party.recallHold;
    if (!this.barrier) for (const request of this.recalls.filter(r => r.status === 'scheduled')) {
      const leader = this.partyFor(request.leaderId);
      if (!leader) { request.status = 'cancelled'; continue; }
      const leaderReady = leader.phase === 'ROUTE' && leader.completedNodes >= request.due.leader;
      for (const id of request.targetIds) {
        if (request.responses[id] !== true || request.returnedIds.includes(id)) continue;
        const source = this.partyFor(id);
        if (!source) { request.status = 'cancelled'; break; }
        if (source === leader) { request.returnedIds.push(id); continue; }
        if (source.phase !== 'ROUTE' || source.completedNodes < request.due.targets[id]) continue;
        if (leaderReady) {
          this.memberContexts[id] = copy(source.context);
          source.memberIds = source.memberIds.filter(member => member !== id); delete source.votes[id];
          leader.memberIds.push(id);
          leader.memberIds.sort((a, b) => this.players.findIndex(p => p.playerId === a) - this.players.findIndex(p => p.playerId === b));
          leader.votes = {}; leader.approvedNodeId = null;
          request.returnedIds.push(id);
          result.moved.push({ playerId: id, fromPartyId: source.id, toPartyId: leader.id });
          if (!source.memberIds.length) { this.parties.delete(source.id); result.removedPartyIds.push(source.id); }
          for (const split of this.requests) if (split.status === 'pending' && split.playerId === id) split.status = 'cancelled';
        } else {
          let waiting = source;
          if (source.memberIds.length > 1) {
            waiting = this._party('party-' + ++this.sequence, [id], source.context);
            waiting.completedNodes = source.completedNodes;
            source.memberIds = source.memberIds.filter(member => member !== id); delete source.votes[id];
            this.parties.set(waiting.id, waiting);
            result.created.push({ partyId: waiting.id, sourcePartyId: source.id });
            for (const split of this.requests) if (split.status === 'pending' && split.playerId === id) split.status = 'cancelled';
          }
          waiting.recallHold = { requestId: request.id, role: 'returning' };
        }
      }
      if (request.status === 'cancelled') continue;
      const acceptedPending = request.targetIds.some(id => request.responses[id] === true && !request.returnedIds.includes(id));
      if (leaderReady && acceptedPending) leader.recallHold = { requestId: request.id, role: 'leader' };
      if (request.targetIds.every(id => request.responses[id] === false || request.returnedIds.includes(id))) request.status = 'completed';
    }
    result.changed = before !== JSON.stringify({ parties: [...this.parties.values()], recalls: this.recalls });
    if (result.changed) this.revision++;
    return result;
  }
  arrive(partyId, { kind, key } = {}) {
    const party = this.parties.get(partyId);
    if (!party || !['ROUTE', 'REWARD', 'WAITING'].includes(party.phase)) return fail('WRONG_PHASE');
    if (!['floor', 'boss'].includes(kind) || !validId(key)) return fail('BAD_TARGET');
    if (this._pending(party)) return fail('NOT_READY');
    if (this.barrier && (this.barrier.kind !== kind || this.barrier.key !== key)) return fail('OTHER_RENDEZVOUS');
    // The mandatory floor/Boss rendezvous supersedes an optional appointment.
    this._cancelRecalls('superseded');
    this.barrier ||= { kind, key };
    party.phase = 'WAITING'; party.rendezvous = { kind, key };
    this.revision++;
    if (![...this.parties.values()].every(p => p.phase === 'WAITING' && p.rendezvous?.kind === kind && p.rendezvous?.key === key)) {
      return { ok: true, waiting: true, merged: false };
    }
    const previous = [...this.parties.values()];
    const anchor = this.partyFor(this.leaderId) || previous[0];
    for (const p of previous) for (const id of p.memberIds) this.memberContexts[id] = copy(p.context);
    const members = this.players.map(p => p.playerId).filter(id => previous.some(p => p.memberIds.includes(id)));
    const merged = this._party('party-' + ++this.sequence, members, anchor.context);
    merged.completedNodes = Math.max(...previous.map(p => p.completedNodes));
    merged.lastRendezvous = { kind, key };
    this.parties = new Map([[merged.id, merged]]); this.barrier = null;
    return { ok: true, waiting: false, merged: true, partyId: merged.id, previousPartyIds: previous.map(p => p.id) };
  }
  canSpectate(playerId, partyId) {
    const own = this.partyFor(playerId), target = this.parties.get(partyId);
    return !!own && !!target && own !== target && ['ROUTE', 'REWARD', 'WAITING'].includes(own.phase)
      && ['PREP', 'COMBAT', 'UNITE'].includes(target.phase);
  }
  removeMember(playerId) {
    const party = this.partyFor(playerId);
    if (!party) return fail('BAD_TARGET');
    this._cancelRecalls('cancelled');
    party.memberIds = party.memberIds.filter(id => id !== playerId); delete party.votes[playerId];
    this.players = this.players.filter(p => p.playerId !== playerId);
    for (const request of this.requests) if (request.playerId === playerId && request.status === 'pending') request.status = 'cancelled';
    if (!party.memberIds.length) this.parties.delete(party.id);
    if (this.leaderId === playerId) this.leaderId = this.players[0]?.playerId ?? null;
    this.revision++; return { ok: true };
  }
  view() {
    return { version: 1, revision: this.revision, leaderId: this.leaderId, barrier: copy(this.barrier),
      parties: [...this.parties.values()].map(p => ({ id: p.id, memberIds: [...p.memberIds], phase: p.phase,
        nodeId: p.nodeId, approvedNodeId: p.approvedNodeId, votes: copy(p.votes), completedNodes: p.completedNodes,
        rendezvous: copy(p.rendezvous), recallHold: copy(p.recallHold || null) })),
      requests: copy(this.requests), recalls: copy(this.recalls) };
  }
  checkpoint() {
    return { version: 1, players: copy(this.players), leaderId: this.leaderId, sequence: this.sequence,
      requestSequence: this.requestSequence, revision: this.revision, barrier: copy(this.barrier),
      parties: copy([...this.parties.values()]), requests: copy(this.requests), memberContexts: copy(this.memberContexts),
      recallSequence: this.recallSequence, recalls: copy(this.recalls) };
  }
  static restore(doc) {
    if (!doc || doc.version !== 1 || !Array.isArray(doc.parties) || !doc.parties.length || doc.parties.length > 4
      || !Array.isArray(doc.requests) || doc.requests.length > 4096
      || ![doc.sequence, doc.requestSequence, doc.revision].every(v => Number.isSafeInteger(v) && v >= 0)) throw new TypeError('Invalid expedition checkpoint');
    const state = new MizukiTeamExpedition({ players: doc.players, leaderId: doc.leaderId });
    const ids = new Set(), members = new Set();
    let maxPartySequence = 0, maxRequestSequence = 0;
    for (const party of doc.parties) {
      if (!validId(party?.id) || ids.has(party.id) || !validId(party.originId) || !phases.has(party.phase)
        || !Array.isArray(party.memberIds) || !party.memberIds.length || party.memberIds.length > 4
        || !party.votes || typeof party.votes !== 'object' || Array.isArray(party.votes)
        || !Number.isSafeInteger(party.completedNodes) || party.completedNodes < 0
        || (party.nodeId != null && !validId(party.nodeId)) || (party.approvedNodeId != null && !validId(party.approvedNodeId))) throw new TypeError('Invalid expedition party');
      if (!/^party-[1-9][0-9]*$/.test(party.id)) throw new TypeError('Invalid party identity');
      maxPartySequence = Math.max(maxPartySequence, Number(party.id.slice(6)));
      ids.add(party.id);
      if (party.phase === 'WAITING' && (!doc.barrier || party.rendezvous?.kind !== doc.barrier.kind
        || party.rendezvous?.key !== doc.barrier.key)) throw new TypeError('Invalid waiting party');
      for (const id of party.memberIds) {
        if (members.has(id) || !state.players.some(p => p.playerId === id)) throw new TypeError('Invalid expedition membership');
        members.add(id);
      }
      if (Object.entries(party.votes).some(([id, nodeId]) => !party.memberIds.includes(id) || !validId(nodeId))) throw new TypeError('Invalid expedition vote');
    }
    if (members.size !== state.players.length) throw new TypeError('Missing expedition member');
    const requestIds = new Set(), pendingPlayers = new Set();
    for (const r of doc.requests) {
      if (!validId(r?.id) || requestIds.has(r.id) || !validId(r.playerId) || !validId(r.partyId) || !validId(r.originId) || !validId(r.nodeId)
        || !['pending', 'approved', 'denied', 'cancelled'].includes(r.status)
        || (r.status === 'pending' && !doc.parties.some(p => p.id === r.partyId && p.memberIds.includes(r.playerId)))) throw new TypeError('Invalid split request');
      requestIds.add(r.id);
      if (!/^split-[1-9][0-9]*$/.test(r.id)) throw new TypeError('Invalid request identity');
      maxRequestSequence = Math.max(maxRequestSequence, Number(r.id.slice(6)));
      if (r.status === 'pending') {
        if (pendingPlayers.has(r.playerId)) throw new TypeError('Duplicate pending application');
        pendingPlayers.add(r.playerId);
      }
    }
    if (doc.sequence < maxPartySequence || doc.requestSequence < maxRequestSequence) throw new TypeError('Invalid expedition identity sequence');
    if (doc.barrier != null && (!['floor', 'boss'].includes(doc.barrier.kind) || !validId(doc.barrier.key))) throw new TypeError('Invalid rendezvous');
    const recalls = doc.recalls ?? [], recallSequence = doc.recallSequence ?? 0;
    if (!Array.isArray(recalls) || recalls.length > 4096 || !nonnegative(recallSequence)) throw new TypeError('Invalid recall checkpoint');
    const recallIds = new Set(); let maximumRecall = 0, activeRecalls = 0;
    for (const r of recalls) {
      if (!r || !/^recall-[1-9][0-9]*$/.test(r.id) || recallIds.has(r.id) || !validId(r.leaderId)
        || !recallStatuses.has(r.status) || !Array.isArray(r.targetIds) || !r.targetIds.length || r.targetIds.length > 3
        || new Set(r.targetIds).size !== r.targetIds.length || r.targetIds.some(id => !validId(id) || id === r.leaderId)
        || !Array.isArray(r.electorate) || r.electorate.length < 2 || r.electorate.length > 4
        || new Set(r.electorate).size !== r.electorate.length || r.electorate.some(id => !validId(id))
        || !r.electorate.includes(r.leaderId) || r.targetIds.some(id => !r.electorate.includes(id))
        || !r.votes || typeof r.votes !== 'object' || Array.isArray(r.votes) || r.votes[r.leaderId] !== true
        || Object.entries(r.votes).some(([id, vote]) => !r.electorate.includes(id) || typeof vote !== 'boolean')
        || !r.responses || typeof r.responses !== 'object' || Array.isArray(r.responses)
        || Object.entries(r.responses).some(([id, accept]) => !r.targetIds.includes(id) || typeof accept !== 'boolean')
        || !Array.isArray(r.returnedIds) || new Set(r.returnedIds).size !== r.returnedIds.length
        || r.returnedIds.some(id => !r.targetIds.includes(id) || r.responses[id] !== true)
        || !r.due || !nonnegative(r.due.leader) || !r.due.targets || typeof r.due.targets !== 'object'
        || Object.keys(r.due.targets).length !== r.targetIds.length || r.targetIds.some(id => !nonnegative(r.due.targets[id]))) throw new TypeError('Invalid recall request');
      recallIds.add(r.id); maximumRecall = Math.max(maximumRecall, Number(r.id.slice(7)));
      if (pendingRecall(r)) {
        activeRecalls++;
        if (doc.barrier || r.leaderId !== doc.leaderId || r.electorate.some(id => !state.players.some(p => p.playerId === id))) throw new TypeError('Invalid active recall');
        const expected = copy(r); state._advanceRecall(expected);
        if (expected.status !== r.status || (r.status === 'scheduled'
          && Object.values(r.votes).filter(Boolean).length < Math.floor(r.electorate.length / 2) + 1)) throw new TypeError('Invalid recall ballot');
      }
    }
    if (activeRecalls > 1 || recallSequence < maximumRecall) throw new TypeError('Invalid recall sequence');
    for (const party of doc.parties) if (party.recallHold != null) {
      const hold = party.recallHold, request = recalls.find(r => r.id === hold.requestId && r.status === 'scheduled');
      if (!request || party.phase !== 'ROUTE' || !['leader', 'returning'].includes(hold.role)
        || (hold.role === 'leader' ? !party.memberIds.includes(request.leaderId) || party.completedNodes < request.due.leader
          : party.memberIds.length !== 1 || request.responses[party.memberIds[0]] !== true
            || request.returnedIds.includes(party.memberIds[0]) || party.completedNodes < request.due.targets[party.memberIds[0]])) throw new TypeError('Invalid recall hold');
    }
    state.parties = new Map(copy(doc.parties).map(p => [p.id, p]));
    state.requests = copy(doc.requests); state.barrier = copy(doc.barrier); state.memberContexts = copy(doc.memberContexts || {});
    state.sequence = doc.sequence; state.requestSequence = doc.requestSequence; state.revision = doc.revision;
    state.recallSequence = recallSequence; state.recalls = copy(recalls);
    return state;
  }
}
