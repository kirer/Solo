/**
 * 敌方坦克 AI
 * ------------------------------------------------------------------
 * 目标：不是"静止靶子"，要能主动向玩家/基地推进并射击。
 * 采用极简策略（不做寻路，避免过度设计）：
 *   1. 目标选择：每隔一段时间重算，取最近的活着的玩家；若无玩家则取基地。
 *      并以一定概率直接冲基地（让基地有被威胁的压力）。
 *   2. 移动：优先朝目标的主轴方向（x 差 vs y 差较大的那一个）前进；
 *      若该方向被阻挡，累计 stuckTimer，超过阈值就换一个可通行方向。
 *   3. 射击：fireTimer 到点且冷却完毕即可开火；若与目标在同行/同列且朝向正对，
 *      优先开火（提高威胁感）。
 *   4. 每辆敌坦同屏最多 1 发子弹。
 */

import { DIRS, DIR_VEC, ENEMY_MAX_BULLETS } from './constants.js';
import { moveTank, spawnBulletFor } from './collision.js';
import { isRectBlocked } from './world.js';
import { aabb } from './collision.js';

/** 目标重算间隔（秒） */
const RETARGET_INTERVAL = 1.5;
/** 卡住阈值（秒）：超过则换向 */
const STUCK_THRESHOLD = 0.25;
/** 直接冲基地的概率 */
const BASE_RUSH_CHANCE = 0.35;

/**
 * 更新全部敌人
 * @param {object} state
 * @param {number} dt
 */
export function updateEnemies(state, dt) {
  if (state.enemies.length === 0) return;
  const rng = state.rng;

  for (const e of state.enemies) {
    if (!e.alive) continue;

    // 冷却计时
    if (e.fireCd > 0) e.fireCd = Math.max(0, e.fireCd - dt);

    // ---- 目标选择 ----
    e.ai.retargetTimer -= dt;
    if (e.ai.retargetTimer <= 0 || !e.ai.targetMode) {
      e.ai.retargetTimer = RETARGET_INTERVAL;
      e.ai.targetMode = rng.next() < BASE_RUSH_CHANCE ? 'base' : 'player';
    }

    const target = pickTarget(state, e);
    if (!target) continue;

    // ---- 方向决策 ----
    const wantDir = chooseDir(e, target);
    if (wantDir) e.dir = wantDir;

    // ---- 移动 ----
    const v = DIR_VEC[e.dir];
    const step = e.speed * dt;
    const res = moveTank(state, e, v.x * step, v.y * step);

    if (res.blocked) {
      e.ai.stuckTimer += dt;
      if (e.ai.stuckTimer >= STUCK_THRESHOLD) {
        e.ai.stuckTimer = 0;
        e.dir = pickPassableDir(state, e, rng);
      }
    } else {
      e.ai.stuckTimer = 0;
    }

    // ---- 射击 ----
    e.ai.fireTimer -= dt;
    const aligned = isAligned(e, target);
    const fireReady = e.fireCd <= 0 && e.bulletsInAir < ENEMY_MAX_BULLETS;
    if (fireReady && (aligned || e.ai.fireTimer <= 0)) {
      // 对齐时把朝向修正到目标方向，再做一次出膛判定
      if (aligned) e.dir = alignedDir(e, target);
      const b = spawnBulletFor(state, e);
      if (b) {
        e.fireCd = state.level.enemyFireCd;
        e.ai.fireTimer = state.level.enemyFireCd * (0.8 + rng.next() * 0.6);
      }
    }
  }
}

/** 选择目标：按 targetMode 决定 */
function pickTarget(state, e) {
  if (e.ai.targetMode === 'player') {
    const alive = state.players.filter((p) => p && p.enabled !== false && p.alive);
    if (alive.length > 0) return nearest(e, alive);
    // 没有玩家 → 退回基地
  }
  if (state.base.alive) return state.base;
  const alive = state.players.filter((p) => p && p.enabled !== false && p.alive);
  return alive.length ? nearest(e, alive) : null;
}

/** 取中心点 */
function center(o) {
  return { x: o.x + o.w / 2, y: o.y + o.h / 2 };
}

/** 最近目标 */
function nearest(from, list) {
  const c = center(from);
  let best = null;
  let bestD = Infinity;
  for (const t of list) {
    const tc = center(t);
    const d = (tc.x - c.x) ** 2 + (tc.y - c.y) ** 2;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/** 朝目标的主轴方向 */
function chooseDir(e, target) {
  const c = center(e);
  const tc = center(target);
  const dx = tc.x - c.x;
  const dy = tc.y - c.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  if (Math.abs(dy) > 0) return dy > 0 ? 'down' : 'up';
  return null;
}

/** 挑一个可通行的方向（尽量不原路返回） */
function pickPassableDir(state, e, rng) {
  const candidates = DIRS.filter((d) => {
    const v = DIR_VEC[d];
    const nx = e.x + v.x * 2;
    const ny = e.y + v.y * 2;
    return !isRectBlocked(state, aabb(nx, ny, e.w, e.h), { ignoreTank: e });
  });
  if (candidates.length === 0) {
    // 四面皆堵：随机一个方向（下步仍会判定卡住）
    return rng.pick(DIRS);
  }
  // 排除当前朝向，优先换路
  const others = candidates.filter((d) => d !== e.dir);
  return others.length ? rng.pick(others) : rng.pick(candidates);
}

/** 是否与目标在同一条线上（同行或同列，容差半格） */
function isAligned(e, target) {
  const c = center(e);
  const tc = center(target);
  return Math.abs(c.x - tc.x) < 10 || Math.abs(c.y - tc.y) < 10;
}

/** 对齐时朝向目标的方向 */
function alignedDir(e, target) {
  const c = center(e);
  const tc = center(target);
  if (Math.abs(c.x - tc.x) < Math.abs(c.y - tc.y)) return tc.y > c.y ? 'down' : 'up';
  return tc.x > c.x ? 'right' : 'left';
}
