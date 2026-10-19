// 涤火杰西卡的盾牌部署范围固定为相邻四格，不随召唤者攻击范围改变。
const ADJACENT = Object.freeze([[0, 1], [1, 0], [0, -1], [-1, 0]].map((p) => Object.freeze(p)));

export function summonPlacementGrid(tokenId) {
  return tokenId === 'token_10032_jesca2_jckshd' ? ADJACENT : null;
}
