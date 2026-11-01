// 频次子怪只参与联防战斗，不参与联防生命损失；普通战斗规则保持不变。
const TIMES_CHILD = /^enemy_(?:1196_msfyin|1198_msfshu|1200_msfjin|1202_msfzhi|1204_msfhu|1208_msfji|1210_msfden)(?:_2)?$/;
export const uniteLpExempt = (entry) => !!entry && (entry.uniteRuntime === true || TIMES_CHILD.test(entry.enemyKey ?? entry.defId ?? ''));
