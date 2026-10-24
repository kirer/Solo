/**
 * 子弹实体工厂
 * ------------------------------------------------------------------
 * 子弹尺寸 4x4，速度 220px/s，一个逻辑步（1/60s）位移约 3.67px。
 * 因此必须使用「扫掠判定」（保存 prevX/prevY 并在运动路径上采样）
 * 才能保证高速子弹不会穿过 16px 的墙或被漏判。
 */

import { BULLET_SIZE, BULLET_SPEED, DIR_VEC } from '../game-core/constants.js';

let NEXT_ID = 1;

/** 重置 ID 发号器（仅测试用） */
export function resetBulletIds() {
  NEXT_ID = 1;
}

/**
 * 创建子弹
 * @param {object} opts
 * @param {number} opts.x 左上角 x（已由调用方按坦克朝向算好）
 * @param {number} opts.y 左上角 y
 * @param {'up'|'right'|'down'|'left'} opts.dir
 * @param {'player'|'enemy'} opts.ownerKind
 * @param {number} [opts.ownerIndex]
 * @returns {object} Bullet
 */
export function createBullet({ x, y, dir, ownerKind, ownerIndex = -1 }) {
  const v = DIR_VEC[dir];
  return {
    id: NEXT_ID++,
    x,
    y,
    w: BULLET_SIZE,
    h: BULLET_SIZE,
    dir,
    vx: v.x * BULLET_SPEED,
    vy: v.y * BULLET_SPEED,
    ownerKind,
    ownerIndex,
    dead: false,
    prevX: x,
    prevY: y,
  };
}

/** 子弹 AABB */
export function bulletAABB(b) {
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}
