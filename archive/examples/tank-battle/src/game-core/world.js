/**
 * 世界查询：网格查表（游戏的核心"地形数据库"）
 * ------------------------------------------------------------------
 * 性能规则：不做逐像素检测，一律把 AABB 换算成覆盖的格集合，O(格数) 查表。
 */

import { GRID, TILE, FIELD_W, FIELD_H } from './constants.js';
import { TerrainType, isSolidTile, blocksBullet } from '../entities/terrain.js';
import { baseAABB } from '../entities/base.js';

/** 线性索引 */
export function idx(col, row) {
  return row * GRID + col;
}

/** 坐标是否在当前战场内（浮点比较用，右/下边界为开区间） */
export function inField(x, y) {
  return x >= 0 && y >= 0 && x < FIELD_W && y < FIELD_H;
}

/**
 * 取某格地形；越界视作 BOUNDARY（永不越界访问数组）
 * @param {object} state
 * @param {number} col
 * @param {number} row
 */
export function getTile(state, col, row) {
  if (col < 0 || col >= GRID || row < 0 || row >= GRID) return TerrainType.BOUNDARY;
  return state.terrain[idx(col, row)];
}

/** 设置某格地形（砖墙被打碎时调用） */
export function setTile(state, col, row, type) {
  if (col < 0 || col >= GRID || row < 0 || row >= GRID) return;
  state.terrain[idx(col, row)] = type;
}

/** 逻辑坐标 → 格坐标 */
export function cellAt(x, y) {
  return { col: Math.floor(x / TILE), row: Math.floor(y / TILE) };
}

/**
 * AABB 覆盖的所有格（右/下边界取 ceil-1，避免恰好贴边时多算一格）
 * @param {{x:number,y:number,w:number,h:number}} r
 * @returns {Array<{col:number,row:number}>}
 */
export function cellsOfAABB(r) {
  const c0 = Math.floor(r.x / TILE);
  const r0 = Math.floor(r.y / TILE);
  const c1 = Math.floor((r.x + r.w - 0.0001) / TILE);
  const r1 = Math.floor((r.y + r.h - 0.0001) / TILE);
  const out = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) out.push({ col, row });
  }
  return out;
}

/** 该格是否被基地占据 */
export function isBaseCell(state, col, row) {
  return state.base.alive && state.base.col === col && state.base.row === row;
}

/**
 * 矩形是否被阻挡（坦克移动用）
 * 规则：
 *  - 越出战场边界 → 阻挡
 *  - 命中 BRICK / STEEL / BOUNDARY → 阻挡
 *  - 命中基地格 → 阻挡
 *  - GRASS / EMPTY → 通行
 *  - 与其他存活坦克相交 → 阻挡（可通过 ignoreTanks 排除自身）
 *
 * @param {object} state
 * @param {{x:number,y:number,w:number,h:number}} r
 * @param {object} [opts]
 * @param {object} [opts.ignoreTank] 忽略的坦克（自身）
 * @param {boolean} [opts.checkBase=true]
 * @returns {boolean} true = 被阻挡
 */
export function isRectBlocked(state, r, { ignoreTank = null, checkBase = true } = {}) {
  // 边界判定
  if (r.x < 0 || r.y < 0 || r.x + r.w > FIELD_W || r.y + r.h > FIELD_H) return true;

  // 地形判定（网格查表）
  for (const cell of cellsOfAABB(r)) {
    const t = getTile(state, cell.col, cell.row);
    if (isSolidTile(t)) return true;
    if (checkBase && isBaseCell(state, cell.col, cell.row)) return true;
  }

  // 坦克互撞（不允许重叠）
  for (const other of allTanks(state)) {
    if (!other.alive || other === ignoreTank) continue;
    if (overlapRect(r, other)) return true;
  }
  return false;
}

/** 所有存活坦克（玩家 + 敌人） */
export function allTanks(state) {
  const out = [];
  for (const p of state.players) if (p && p.enabled !== false) out.push(p);
  for (const e of state.enemies) out.push(e);
  return out;
}

/** 矩形与坦克 AABB 是否相交 */
export function overlapRect(r, tank) {
  return r.x < tank.x + tank.w && r.x + r.w > tank.x
      && r.y < tank.y + tank.h && r.y + r.h > tank.y;
}

/**
 * 子弹在某格上是否会被阻挡
 * @param {object} state
 * @param {number} col
 * @param {number} row
 */
export function tileBlocksBullet(state, col, row) {
  return blocksBullet(getTile(state, col, row));
}

export { TerrainType, isSolidTile, blocksBullet, baseAABB };
