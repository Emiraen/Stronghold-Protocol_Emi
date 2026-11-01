// Presentation records for the Mizuki screen only. Never rewrites shared data.
import { readFileSync, writeFileSync } from 'node:fs';
import { getData } from '../server/data.js';
import { createMizukiCatalog } from '../server/modes/mizuki/catalog.js';
const catalog = createMizukiCatalog(getData({ log: { warn() {}, info() {}, error() {} } }));
const ids = new Set(catalog.operators.flatMap((operator) => [operator.operatorId, operator.promotionChessId]).filter(Boolean));
const chess = Object.fromEntries([...ids].map((id) => [id, catalog.source.rawChess(id)]));
const tokens = { ...catalog.source.raw.tokens };
const dice = JSON.parse(readFileSync(new URL('../data/mizuki/battle-dice.json', import.meta.url), 'utf8'));
for (const value of Object.values(dice.dice)) {
  const raw = value.raw, stats = raw.phases[0].attributesKeyFrames[0].data;
  tokens[value.key] = { id: value.key, name: raw.name, type: 'token', position: 'ALL', profession: 'TRAP',
    rarity: 1, tier: 1, placeable: true, toolId: value.itemId, description: raw.description || '',
    stats: { maxHp: stats.maxHp, atk: stats.atk, def: stats.def, res: stats.magicResistance, cost: stats.cost,
      blockCnt: stats.blockCnt, respawnTime: stats.respawnTime, aspd: stats.attackSpeed, bat: stats.baseAttackTime },
    rangeGrid: [[0, 0]], assets: { spine: value.key, avatar: value.itemId }, skills: [] };
}
const output = { schema: 1, mode: 'entertainment_mizuki',
  notice: 'Mode-local presentation records; original shared operator and asset tables are not changed.',
  source: catalog.trainingSource, report: catalog.report, chess, tokens };
writeFileSync(new URL('../data/mizuki/runtime-ui.json', import.meta.url), JSON.stringify(output));
console.log(JSON.stringify({ chessRecords: Object.keys(chess).length, tokens: Object.keys(tokens).length }));
