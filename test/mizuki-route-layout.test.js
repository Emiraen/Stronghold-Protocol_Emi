import test from 'node:test';
import assert from 'node:assert/strict';
import { mizukiExplorationLayout, mizukiRouteMapBounds, MIZUKI_ROUTE_SCALE } from '../public/js/mizukiRouteLayout.js';

test('many route branches, including negative original rows, fit entirely inside the scroll surface', () => {
  const nodes = Array.from({ length: 20 }, (_, i) => ({ id: i, depth: Math.floor(i / 10), index: i % 10,
    position: { x: Math.floor(i / 10), y: i % 10 - 5 } }));
  const graph = mizukiExplorationLayout({ nodes, edges: nodes.slice(0, 10).map(node => ({ from: node.id, to: node.id + 10 })) });
  const bounds = mizukiRouteMapBounds(graph);
  assert.equal(graph.nodes.length, 20); assert.equal(graph.edges.length, 10);
  assert.ok(bounds.height > 900); assert.ok(bounds.offsetY >= 0);
  for (const node of graph.nodes) {
    assert.ok(node.x >= 150 && node.y >= 96);
    assert.ok((node.y - 54) * MIZUKI_ROUTE_SCALE + bounds.offsetY >= 0);
    assert.ok((node.y + 160) * MIZUKI_ROUTE_SCALE + bounds.offsetY <= bounds.height);
    assert.ok((node.x + 120) * MIZUKI_ROUTE_SCALE <= bounds.width);
  }
  for (const edge of graph.edges) {
    assert.equal(edge.toNode.y, edge.fromNode.y);
    assert.equal(edge.toNode.x - edge.fromNode.x, 400);
  }
});

test('small route retains the existing node spacing and centering without dropping hidden-edge endpoints', () => {
  const graph = mizukiExplorationLayout({ nodes: [
    { id: 'a', depth: 0, index: 0 }, { id: 'b', depth: 1, index: 1 },
  ], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b', hiddenType: 'HIDE' }] });
  assert.deepEqual(graph.nodes.map(({ x, y }) => [x, y]), [[150, 96], [550, 241]]);
  assert.equal(graph.edges.length, 1);
  const bounds = mizukiRouteMapBounds(graph);
  assert.equal(bounds.height, 900); assert.equal(bounds.offsetY, 500 - (96 + 241) / 2 * MIZUKI_ROUTE_SCALE);
});
