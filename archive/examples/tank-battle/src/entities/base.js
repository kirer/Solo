/**
 * 基地实体
 * ------------------------------------------------------------------
 * 己方基地位于战场底部，占 1 格（16x16），被任意子弹击中即摧毁 → 失败。
 * 基地区域对坦克是实体障碍（坦克不能压过基地）。
 */

import { TILE } from '../game-core/constants.js';

/**
 * @param {{col:number,row:number}} opts
 * @returns {{col:number,row:number,x:number,y:number,w:number,h:number,alive:boolean}}
 */
export function createBase({ col, row }) {
  return {
    col,
    row,
    x: col * TILE,
    y: row * TILE,
    w: TILE,
    h: TILE,
    alive: true,
  };
}

/** 基地 AABB */
export function baseAABB(base) {
  return { x: base.x, y: base.y, w: base.w, h: base.h };
}
