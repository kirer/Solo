/**
 * 关卡聚合与校验
 * ------------------------------------------------------------------
 * 关卡数据是纯常量，调参（敌人数量/生成间隔/地形布局）只改 levelN.js。
 * 这里提供 validateLevel 用于开发期自检与无头冒烟测试。
 */

import level1 from './level1.js';
import level2 from './level2.js';
import level3 from './level3.js';

/** 全部关卡（顺序即游玩顺序） */
export const LEVELS = [level1, level2, level3];

/** 关卡总数 */
export const LEVEL_COUNT = LEVELS.length;

/**
 * 校验关卡数据完整性
 * @param {object} level
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateLevel(level) {
  const errors = [];
  if (!level || typeof level !== 'object') return { ok: false, errors: ['level 为空'] };

  if (!Number.isInteger(level.id) || level.id < 1) errors.push('id 非法');
  if (typeof level.name !== 'string' || !level.name) errors.push('name 缺失');

  // 敌人参数
  if (!Number.isInteger(level.enemyCount) || level.enemyCount <= 0) errors.push('enemyCount 非法');
  if (!Number.isInteger(level.maxEnemiesOnField) || level.maxEnemiesOnField <= 0) errors.push('maxEnemiesOnField 非法');
  if (typeof level.spawnInterval !== 'number' || level.spawnInterval <= 0) errors.push('spawnInterval 非法');
  if (typeof level.enemyFireCd !== 'number' || level.enemyFireCd <= 0) errors.push('enemyFireCd 非法');
  if (typeof level.enemySpeed !== 'number' || level.enemySpeed <= 0) errors.push('enemySpeed 非法');

  // 地形：必须 13 行 x 13 字符，字符集受限
  if (!Array.isArray(level.layout) || level.layout.length !== 13) {
    errors.push('layout 必须 13 行');
  } else {
    level.layout.forEach((line, i) => {
      if (typeof line !== 'string' || line.length !== 13) errors.push(`layout 第 ${i} 行长度不是 13`);
      else if (/[^.BSG]/.test(line)) errors.push(`layout 第 ${i} 行含非法字符`);
    });
  }

  // 基地 / 出生点必须在场内
  const inField = (p) => p && Number.isInteger(p.col) && Number.isInteger(p.row)
    && p.col >= 0 && p.col < 13 && p.row >= 0 && p.row < 13;

  if (!inField(level.base)) errors.push('base 越界');
  if (!Array.isArray(level.playerSpawns) || level.playerSpawns.length < 1) errors.push('playerSpawns 缺失');
  else if (!level.playerSpawns.every(inField)) errors.push('playerSpawns 越界');
  if (!Array.isArray(level.enemySpawns) || level.enemySpawns.length < 1) errors.push('enemySpawns 缺失');
  else if (!level.enemySpawns.every(inField)) errors.push('enemySpawns 越界');

  return { ok: errors.length === 0, errors };
}

/**
 * 取指定关卡（0 基索引），越界返回 null
 * @param {number} index
 */
export function getLevel(index) {
  return LEVELS[index] ?? null;
}
