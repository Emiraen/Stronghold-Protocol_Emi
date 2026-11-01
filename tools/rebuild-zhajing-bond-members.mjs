// Rebuild display membership from the mode's actual operators, including strategy-only
// grants. Special count modes such as 绝技 keep their rules and have no fixed roster.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function rebuildZhajingBondMembers(bonds, chess) {
  const roster = Object.values(chess).filter(c => c?.zhajing === true
    && !c.isGolden && !c.isHidden && !c.isDiy)
    .sort((a, b) => (a.tier - b.tier) || ((a.shopSortId ?? 0) - (b.shopSortId ?? 0))
      || a.chessId.localeCompare(b.chessId));
  return Object.fromEntries(Object.entries(bonds).map(([id, bond]) => {
    const members = roster.filter(c => c.bonds?.includes(id)).map(c => c.chessId);
    return [id, { ...bond, members, visibleMembers: [...members] }];
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.join(root, 'data/zhajing/bonds.json');
  const before = JSON.parse(await fs.readFile(file, 'utf8'));
  const chess = JSON.parse(await fs.readFile(path.join(root, 'data/zhajing/chess.json'), 'utf8'));
  const after = rebuildZhajingBondMembers(before, chess);
  const changed = Object.keys(after).filter(id => JSON.stringify(before[id]) !== JSON.stringify(after[id]));
  if (changed.length) await fs.writeFile(file, JSON.stringify(after));
  console.log(JSON.stringify({ changed: changed.length, bonds: changed }));
}
