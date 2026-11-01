const list = value => Array.isArray(value) ? value : [];
export const MIZUKI_ROUTE_SCALE = 1.62;

export function mizukiExplorationLayout(exploration) {
  const nodes = list(exploration?.nodes).filter(node => node && node.id != null
    && Number.isFinite(Number(node.depth)) && Number.isFinite(Number(node.index)));
  const coordinate = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : Number(fallback);
  const placed = nodes.map(node => ({ ...node,
    x: 150 + coordinate(node.position?.x ?? node.depth, node.depth) * 400,
    y: 96 + coordinate(node.position?.y ?? node.index, node.index) * 145,
  }));
  // Original branches may have negative row coordinates. Translate the whole
  // graph together so those nodes and their connectors remain scrollable.
  const dx = Math.max(0, 150 - Math.min(150, ...placed.map(node => node.x)));
  const dy = Math.max(0, 96 - Math.min(96, ...placed.map(node => node.y)));
  for (const node of placed) { node.x += dx; node.y += dy; }
  const byId = new Map(placed.map(node => [String(node.id), node]));
  const edges = list(exploration?.edges).filter(edge => edge.hiddenType !== 'HIDE' && !(edge.hidden && !edge.hiddenType)
    && byId.has(String(edge.from)) && byId.has(String(edge.to)))
    .map(edge => ({ ...edge, fromNode: byId.get(String(edge.from)), toNode: byId.get(String(edge.to)) }));
  return { nodes: placed, edges, width: Math.max(1050, ...placed.map(node => node.x + 160)),
    height: Math.max(445, ...placed.map(node => node.y + 160)) };
}

export function mizukiRouteMapBounds(graph) {
  const ys = graph.nodes.map(node => node.y);
  const midY = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 240;
  const offsetY = Math.max(0, 500 - midY * MIZUKI_ROUTE_SCALE);
  return { offsetY, width: Math.ceil(graph.width * MIZUKI_ROUTE_SCALE + 1100),
    height: Math.max(900, Math.ceil(offsetY + Math.max(0, ...ys.map(y => y + 160)) * MIZUKI_ROUTE_SCALE)) };
}
