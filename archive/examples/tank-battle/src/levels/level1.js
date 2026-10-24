/**
 * 第 1 关 · 前哨
 * ------------------------------------------------------------------
 * layout: 13 行 x 13 字符
 *   '.' 空  'B' 砖墙  'S' 钢墙  'G' 草丛
 * 基地固定底部中央 (col=6,row=12)，其左右与上方用砖墙保护。
 * 玩家出生点：(4,12) 与 (8,12)；敌人出生点：顶部三处。
 */

export default {
  id: 1,
  name: '第一关 · 前哨',
  enemyCount: 8,
  maxEnemiesOnField: 3,
  spawnInterval: 2.6,
  enemyFireCd: 1.6,
  enemySpeed: 48,
  playerLives: 3,
  layout: [
    '.............',
    '..B.......B..',
    '..B..GGG..B..',
    '..B..GGG..B..',
    '.....BBB.....',
    '..SS.....SS..',
    '.............',
    '..B.......B..',
    '..B..GGG..B..',
    '.....BBB.....',
    '.............',
    '.....B.B.....',
    '.....B.B.....',
  ],
  base: { col: 6, row: 12 },
  playerSpawns: [ { col: 4, row: 12 }, { col: 8, row: 12 } ],
  enemySpawns: [ { col: 0, row: 0 }, { col: 6, row: 0 }, { col: 12, row: 0 } ],
};
