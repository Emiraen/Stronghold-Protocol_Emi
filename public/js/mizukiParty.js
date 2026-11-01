const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

// Public state contains all parties for observation; only the private party owns
// the local route, node and progression surface. Null is an intentional value.
export function mizukiPartyModel(publicModel = {}, privateModel = {}) {
  const model = { ...publicModel };
  for (const key of ['currentNode', 'route', 'votes', 'exploration', 'completedNodes', 'archiveMode', 'event', 'reward', 'round', 'floor', 'totalNodes', 'sanCheck']) {
    if (own(privateModel, key)) model[key] = privateModel[key];
  }
  if (own(privateModel, 'completedNodes')) model.nodeIndex = privateModel.completedNodes;
  return model;
}

export function mizukiWatchableFields(model = {}, partyId) {
  const parties = model.expedition?.parties || [];
  return (model.fields || []).filter(field => {
    const party = parties.find(value => value.id === field?.partyId);
    return field && !field.done && field.meta && field.stage && field.partyId !== partyId
      && (party ? party.phase === 'COMBAT' || party.phase === 'UNITE' : field.phase !== 'PREP');
  });
}
