// Generate docs from this project's own definitions. No network, hashes or gameplay mutations.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { operationCatalog } from '../public/js/ai/control.js';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const guide = 'docs/AI-CONTROL.md';
const marker = '<!-- generated-player-operations -->';
const original = fs.readFileSync(guide, 'utf8').split(marker)[0].trimEnd();
const table = '| 命令 | 必填字段 | 可省略字段 |\n|---|---|---|\n' + operationCatalog().map(x => '| ' + x.type + ' | ' + (x.required.join(', ') || '—') + ' | ' + (x.optional.join(', ') || '—') + ' |').join('\n');
fs.writeFileSync(guide, original + '\n\n' + marker + '\n\n' + table + '\n');
const chess = JSON.parse(fs.readFileSync('data/chess.json', 'utf8'));
const rows = Object.values(chess).filter(c => c.visible !== false && !c.isHidden && !c.isDiy && c.chessId).sort((a, b) => (a.tier - b.tier) || String(a.baseId).localeCompare(String(b.baseId)) || Number(a.isGolden) - Number(b.isGolden));
const safe = s => String(s ?? '—').replaceAll('|', '/').replaceAll('\n', ' ');
let out = '# 干员基础属性参考\n\n生成日期：2026-10-25。唯一来源：本项目 data/chess.json，不取网络推测值。仅列可见、非隐藏、非 DIY 棋子，含普通/精锐。\n\n这是静态基础表，不是实战最终值。潜能、练度、装备、盟约、策略、技能、地形和插件均可改变属性。实时值用 unit；休整期有效值用 g.unitStats；当前内容集完整定义用 library。\n\n合计 ' + rows.length + ' 条定义。tier 是本作商店阶；费用为部署费用 stats.cost，不是商店资金；bat、再部署单位为秒。技能 index 保留数据原值。天赋、完整技能说明、攻击格、bb 和模组请按定义 ID 查询 library。\n\n| 名称 | 形态 | 阶 | 定义 ID | 分支 | HP | ATK | DEF | RES | bat | aspd | 阻挡 | 费用 | 再部署 | 默认技能 index |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
for (const c of rows) { const s = c.stats || {}; out += '| ' + [c.name, c.isGolden ? '精锐' : '普通', c.tier, c.chessId, c.subProfessionName || c.profession, s.maxHp, s.atk, s.def, s.res, s.bat, s.aspd, s.blockCnt, s.cost, s.respawnTime, c.defaultSkillIndex ?? c.skill?.index].map(safe).join(' | ') + ' |\n'; }
fs.writeFileSync('docs/AI-OPERATORS.md', out);
console.log(JSON.stringify({ operatorRecords: rows.length, operations: operationCatalog().length }));
