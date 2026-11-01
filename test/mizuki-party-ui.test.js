import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mizukiPartyModel, mizukiWatchableFields } from '../public/js/mizukiParty.js';

test('private party explicitly owns route, null node and completed progress', () => {
  const publicModel = { currentNode: { id: 'other' }, route: ['other'], votes: { other: 'x' }, completedNodes: 7, fields: ['shared'] };
  const privateModel = { currentNode: null, route: [], votes: {}, completedNodes: 2, archiveMode: false };
  const model = mizukiPartyModel(publicModel, privateModel);
  assert.equal(model.currentNode, null); assert.deepEqual(model.route, []); assert.deepEqual(model.votes, {});
  assert.equal(model.completedNodes, 2); assert.equal(model.nodeIndex, 2); assert.equal(model.archiveMode, false);
  assert.equal(model.fields, publicModel.fields); assert.equal(publicModel.currentNode.id, 'other');
});

test('completed parties can observe only other unfinished fields', () => {
  const fields = [{ fieldId: 'own', partyId: 'a', stage: {}, meta: {} }, { fieldId: 'slow', partyId: 'b', stage: {}, meta: {} },
    { fieldId: 'done', partyId: 'c', stage: {}, meta: {}, done: true }, { fieldId: 'prep', partyId: 'd', phase: 'PREP', stage: {}, meta: {} }];
  assert.deepEqual(mizukiWatchableFields({ fields }, 'a').map(field => field.fieldId), ['slow']);
});
