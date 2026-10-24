/**
 * 坦克实体工厂
 * ------------------------------------------------------------------
 * 坦克坐标 (x,y) 为 AABB 左上角逻辑像素，尺寸 TANK_SIZE(14)。
 * 坦克在格内居中：给定格 (col,row) 时 x = col*16 + 1。
 *
 * 字段说明见 docs/architecture.md 3.2。
 */

import { TILE, TANK_SIZE, PLAYER_SPEED, ENEMY_SPEED, ENEMY_FIRE_CD } from '../game-core/constants.js';

let NEXT_ID = 1;

/** 重置 ID 发号器（仅测试用） */
export function resetTankIds() {
  NEXT_ID = 1;
}

/**
 * 创建坦克
 * @param {object} opts
 * @param {'player'|'enemy'} opts.kind
 * @param {number} [opts.ownerIndex] 玩家 0/1；敌人 -1
 * @param {number} [opts.col] 出生格列
 * @param {number} [opts.row] 出生格行
 * @param {'up'|'right'|'down'|'left'} [opts.dir]
 * @param {number} [opts.speed]
 * @param {number} [opts.fireCd]
 * @returns {object} Tank
 */
export function createTank({
  kind,
  ownerIndex = kind === 'player' ? 0 : -1,
  col = 0,
  row = 0,
  dir = kind === 'player' ? 'up' : 'down',
  speed = kind === 'player' ? PLAYER_SPEED : ENEMY_SPEED,
  fireCd = kind === 'player' ? 0 : ENEMY_FIRE_CD,
} = {}) {
  // 坦克在格内居中（16-14）/2 = 1
  const margin = (TILE - TANK_SIZE) / 2;
  return {
    id: NEXT_ID++,
    kind,
    ownerIndex,
    x: col * TILE + margin,
    y: row * TILE + margin,
    w: TANK_SIZE,
    h: TANK_SIZE,
    dir,
    speed,
    alive: true,
    bulletsInAir: 0,
    fireCd,
    invuln: 0,
    hp: 1,
    // 敌人 AI 计时器（玩家不使用）
    ai: {
      fireTimer: fireCd > 0 ? fireCd : ENEMY_FIRE_CD,
      retargetTimer: 0,
      stuckTimer: 0,
      targetMode: null, // 'player' | 'base'
    },
  };
}

/**
 * 把坦克瞬移到指定格并居中（复活/初始化用）
 */
export function placeTank(tank, col, row, dir) {
  const margin = (TILE - TANK_SIZE) / 2;
  tank.x = col * TILE + margin;
  tank.y = row * TILE + margin;
  if (dir) tank.dir = dir;
  tank.alive = true;
  tank.bulletsInAir = 0;
  tank.fireCd = 0;
  return tank;
}

/** 坦克 AABB（供碰撞层使用） */
export function tankAABB(t) {
  return { x: t.x, y: t.y, w: t.w, h: t.h };
}
