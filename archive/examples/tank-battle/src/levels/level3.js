/**
 * 第 3 关 · 终局堡垒
 * ------------------------------------------------------------------
 * 三关中最难：敌人最多、生成最快、射速最快；砖钢混合迷宫 + 大片草丛。
 */

export default {
  id: 3,
  name: '第三关 · 终局堡垒',
  enemyCount: 16,
  maxEnemiesOnField: 5,
  spawnInterval: 1.5,
  enemyFireCd: 0.9,
  enemySpeed: 64,
  playerLives: 3,
  layout: [
    '.............',
    '.SS.BBBBB.SS.',
    '....B...B....',
    'GG..B.G.B..GG',
    'GG..B.G.B..GG',
    '.BB...G...BB.',
    '.BB.GGGGG.BB.',
    '.BB...G...BB.',
    'GG..B.G.B..GG',
    'GG..B.G.B..GG',
    '....B...B....',
    '.SS.B...B.SS.',
    '.....B.B.....',
  ],
  base: { col: 6, row: 12 },
  playerSpawns: [ { col: 4, row: 12 }, { col: 8, row: 12 } ],
  enemySpawns: [ { col: 0, row: 0 }, { col: 6, row: 0 }, { col: 12, row: 0 } ],
};
