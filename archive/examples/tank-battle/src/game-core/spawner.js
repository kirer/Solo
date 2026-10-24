/**
 * 敌方坦克生成调度
 * ------------------------------------------------------------------
 * 规则：
 *  - 到达 spawnInterval 且场上敌人 < maxEnemiesOnField 且还有待生成敌人时生成一辆。
 *  - 出生点在 enemySpawns 中轮转（spawnCursor）。
 *  - enemiesRemaining 只表示"尚未生成的数量"，`checkWinLose` 综合场人数判定过关。
 *  - 若轮转到的出生点被占用（坦克/地形），顺延到下一个出生点，最多试一圈。
 */

import { createTank } from '../entities/tank.js';
import { isRectBlocked } from './world.js';
import { aabb } from './collision.js';
import { TILE, TANK_SIZE } from './constants.js';

/**
 * 生成一辆敌人
 * @param {object} state
 * @param {{col:number,row:number}} spawn
 * @returns {object|null} EnemyTank
 */
export function spawnEnemy(state, spawn) {
  const level = state.level;
  const e = createTank({
    kind: 'enemy',
    ownerIndex: -1,
    col: spawn.col,
    row: spawn.row,
    dir: 'down',
    speed: level.enemySpeed,
    fireCd: level.enemyFireCd,
  });
  e.ai.fireTimer = level.enemyFireCd;
  // 出生点被占（例如刚生成的其他坦克尚未离开）→ 放弃本次生成
  if (isRectBlocked(state, aabb(e.x, e.y, e.w, e.h), {})) return null;
  state.enemies.push(e);
  return e;
}

/**
 * 每步调用：按关卡节奏补充敌人
 * @param {object} state
 * @param {number} dt
 */
export function updateSpawner(state, dt) {
  const level = state.level;
  if (!level) return;
  if (state.enemiesRemaining <= 0) return;

  state.spawnTimer += dt;
  if (state.spawnTimer < level.spawnInterval) return;
  if (state.enemies.length >= level.maxEnemiesOnField) return;

  // 尝试轮转出生点，最多试一遍
  const spawns = level.enemySpawns;
  for (let attempt = 0; attempt < spawns.length; attempt++) {
    const spawn = spawns[state.spawnCursor % spawns.length];
    state.spawnCursor++;
    const e = spawnEnemy(state, spawn);
    if (e) {
      state.enemiesRemaining--;
      state.spawnTimer = 0; // 成功生成才重置计时
      return;
    }
  }
  // 全部出生点都被占用：下个逻辑步再试
}

export { TILE, TANK_SIZE };
