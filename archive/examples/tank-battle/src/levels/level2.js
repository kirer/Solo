/**
 * 第 2 关 · 钢铁回廊
 * ------------------------------------------------------------------
 * 比第 1 关敌人更多、生成更快；引入钢墙形成走廊，草丛更多用于遮蔽突袭。
 */

export default {
  id: 2,
  name: '第二关 · 钢铁回廊',
  enemyCount: 12,
  maxEnemiesOnField: 4,
  spawnInterval: 2.0,
  enemyFireCd: 1.2,
  enemySpeed: 56,
  playerLives: 3,
  layout: [
    '.............',
    '..SSS...SSS..',
    '..B.......B..',
    '..B.GGGGG.B..',
    '....G...G....',
    '..BBB...BBB..',
    '.GGG.....GGG.',
    '..B.......B..',
    '..B.GGGGG.B..',
    '..BBB...BBB..',
    '.............',
    '.....B.B.....',
    '.....B.B.....',
  ],
  base: { col: 6, row: 12 },
  playerSpawns: [ { col: 4, row: 12 }, { col: 8, row: 12 } ],
  enemySpawns: [ { col: 0, row: 0 }, { col: 6, row: 0 }, { col: 12, row: 0 } ],
};
