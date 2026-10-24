/**
 * 地形定义与网格工具
 * ------------------------------------------------------------------
 * 地形四类 + 空 + 边界：
 *   EMPTY    空地，可通行、可穿透
 *   BRICK    砖墙，不可通行；可被子弹摧毁（命中即碎）
 *   STEEL    钢墙，不可通行；不可被摧毁
 *   GRASS    草丛，可通行；子弹可穿透；渲染时覆盖在坦克之上形成遮蔽
 *   BOUNDARY 战场边界，不可通行、子弹撞上即消失
 */

/** 地形枚举（数值写入 Uint8Array 网格） */
export const TerrainType = Object.freeze({
  EMPTY: 0,
  BRICK: 1,
  STEEL: 2,
  GRASS: 3,
  BOUNDARY: 4,
});

/** 关卡 layout 字符 → 地形枚举 */
export const LAYOUT_CHARS = {
  '.': TerrainType.EMPTY,
  'B': TerrainType.BRICK,
  'S': TerrainType.STEEL,
  'G': TerrainType.GRASS,
};

/**
 * 网格线性索引
 * @param {number} col 0..12
 * @param {number} row 0..12
 * @param {number} grid 列数
 */
export function gridIndex(col, row, grid = 13) {
  return row * grid + col;
}

/**
 * 将 13 行字符串 layout 转为 Uint8Array 网格
 * @param {string[]} layout 长度 13 的字符串数组，每行 13 字符
 * @param {number} grid 列数
 * @returns {Uint8Array}
 */
export function layoutToGrid(layout, grid = 13) {
  const cells = new Uint8Array(grid * grid);
  for (let row = 0; row < grid; row++) {
    const line = layout[row] || '';
    for (let col = 0; col < grid; col++) {
      const ch = line[col] || '.';
      cells[gridIndex(col, row, grid)] = LAYOUT_CHARS[ch] ?? TerrainType.EMPTY;
    }
  }
  return cells;
}

/** 该地形是否阻挡坦克移动 */
export function isSolidTile(t) {
  return t === TerrainType.BRICK || t === TerrainType.STEEL || t === TerrainType.BOUNDARY;
}

/** 该地形是否阻挡子弹（草丛不挡） */
export function blocksBullet(t) {
  return t === TerrainType.BRICK || t === TerrainType.STEEL || t === TerrainType.BOUNDARY;
}
