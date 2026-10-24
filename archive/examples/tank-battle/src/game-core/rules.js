/**
 * 游戏规则与状态机总入口
 * ------------------------------------------------------------------
 * updateGame(state, dt) 是唯一逻辑入口，按 phase 分发：
 *   menu        → 等待 confirm 开始
 *   levelIntro  → introTimer 倒计时结束进入 playing
 *   playing     → 完整逻辑（玩家/敌人/子弹/生成/胜负）
 *   paused      → 只响应暂停恢复与重开（不推进任何计时器与实体）
 *   levelClear  → 等待 confirm 进入下一关
 *   gameOver    → 等待 restart 回菜单
 *   allClear    → 等待 restart 回菜单
 *
 * 全局按键（任何 phase 都生效）：
 *   pause   → playing ↔ paused
 *   restart → 重开本局（关卡开始前则重开当前关；结算态则回菜单）
 */

import {
  PHASE, PLAYER_SPEED, PLAYER_FIRE_CD, PLAYER_MAX_BULLETS, ENEMY_MAX_BULLETS,
  RESPAWN_INVULN, SCORE_KILL, SCORE_CLEAR_BASE, DIR_VEC, LEVEL_INTRO_SECONDS, TILE,
} from './constants.js';
import { isSolidTile, TerrainType } from '../entities/terrain.js';
import {
  moveTank, spawnBulletFor, hitTankAt, hitBaseAt, sweepRects,
} from './collision.js';
import { getTile, setTile, cellAt } from './world.js';
import { updateSpawner } from './spawner.js';
import { updateEnemies } from './ai.js';
import {
  enterPhase, loadLevel, restartLevel, startNewGame, nextLevel,
} from './state.js';

/* ==================================================================
 * 总入口
 * ================================================================== */

/**
 * 推进游戏一步（固定 dt = 1/60）
 * @param {object} state
 * @param {number} dt 秒
 */
export function updateGame(state, dt) {
  if (state.phase === PHASE.PAUSED) {
    handleGlobalKeys(state);
    return; // 暂停时冻结一切逻辑与计时器
  }

  handleGlobalKeys(state);

  switch (state.phase) {
    case PHASE.MENU:
      if (state.input.confirm) {
        startNewGame(state, state.twoPlayers);
      }
      break;

    case PHASE.LEVEL_INTRO:
      state.introTimer -= dt;
      if (state.introTimer <= 0) {
        state.introTimer = 0;
        enterPhase(state, PHASE.PLAYING);
      }
      break;

    case PHASE.PLAYING:
      stepPlaying(state, dt);
      break;

    case PHASE.LEVEL_CLEAR:
      if (state.input.confirm) {
        nextLevel(state);
      }
      break;

    case PHASE.GAME_OVER:
    case PHASE.ALL_CLEAR:
      if (state.input.restart || state.input.confirm) {
        enterPhase(state, PHASE.MENU);
      }
      break;

    default:
      break;
  }
}

/* ==================================================================
 * 全局按键（暂停 / 重开）
 * ================================================================== */

function handleGlobalKeys(state) {
  const { pause, restart } = state.input;

  // Esc：仅在游戏中与暂停态之间切换
  if (pause) {
    if (state.phase === PHASE.PLAYING) {
      state.prevPhase = PHASE.PLAYING;
      enterPhase(state, PHASE.PAUSED);
    } else if (state.phase === PHASE.PAUSED) {
      enterPhase(state, PHASE.PLAYING);
    }
  }

  // R：重开本局
  if (restart) {
    if (state.phase === PHASE.MENU) {
      // 菜单态 R 无动作（需先开始）
    } else if (state.phase === PHASE.GAME_OVER || state.phase === PHASE.ALL_CLEAR) {
      enterPhase(state, PHASE.MENU);
    } else {
      restartLevel(state);
    }
  }
}

/* ==================================================================
 * playing 主流程
 * ================================================================== */

function stepPlaying(state, dt) {
  state.time += dt;
  state.stepCount++;
  if (state.timers.flash > 0) state.timers.flash = Math.max(0, state.timers.flash - dt);

  updatePlayers(state, dt);
  updateEnemies(state, dt);
  updateBullets(state, dt);
  updateSpawner(state, dt);
  cleanupDead(state);
  checkWinLose(state);
}

/* ------------------------------------------------------------------
 * 玩家
 * ------------------------------------------------------------------ */

/**
 * 读取输入，驱动玩家移动与射击（双人各自独立）
 */
export function updatePlayers(state, dt) {
  state.players.forEach((p, i) => {
    if (!p || p.enabled === false || !p.alive) return;

    const inp = i === 0 ? state.input.p1 : state.input.p2;

    // 无敌计时递减
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
    // 射击冷却递减
    if (p.fireCd > 0) p.fireCd = Math.max(0, p.fireCd - dt);

    // 方向选择：优先级 上 > 下 > 左 > 右（同时按多键时确定性）
    let dir = null;
    if (inp.up) dir = 'up';
    else if (inp.down) dir = 'down';
    else if (inp.left) dir = 'left';
    else if (inp.right) dir = 'right';

    if (dir) {
      p.dir = dir;
      const v = DIR_VEC[dir];
      const step = p.speed * dt;
      moveTank(state, p, v.x * step, v.y * step);
    }

    // 射击
    if (inp.fire && p.fireCd <= 0 && p.bulletsInAir < PLAYER_MAX_BULLETS) {
      const b = spawnBulletFor(state, p);
      if (b) {
        p.fireCd = PLAYER_FIRE_CD;
        state.stats.shotsFired++;
      }
    }
  });
}

/* ------------------------------------------------------------------
 * 子弹推进与命中解析
 * ------------------------------------------------------------------ */

/**
 * 子弹逻辑：
 *  1. 用扫掠采样逐点推进（防穿墙）
 *  2. 地形：砖 → 碎砖+销毁；钢/边界 → 销毁；草/空 → 穿透
 *  3. 基地：命中即 gameOver(reason='base')
 *  4. 坦克：玩家子弹伤敌、敌方子弹伤玩家
 *  5. 子弹互撞：同时销毁
 */
export function updateBullets(state, dt) {
  if (state.bullets.length === 0) return;

  for (const b of state.bullets) {
    if (b.dead) continue;

    const nx = b.x + b.vx * dt;
    const ny = b.y + b.vy * dt;
    const samples = sweepRects(b.x, b.y, nx, ny, b.w, b.h);

    let stopX = nx;
    let stopY = ny;
    let hitSomething = false;

    for (const rect of samples) {
      // ---- 越界 ----
      if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > 208 || rect.y + rect.h > 208) {
        hitSomething = true;
        break;
      }

      // ---- 地形（按采样矩形覆盖的格） ----
      const c0 = Math.floor(rect.x / TILE);
      const r0 = Math.floor(rect.y / TILE);
      const c1 = Math.floor((rect.x + rect.w - 0.001) / TILE);
      const r1 = Math.floor((rect.y + rect.h - 0.001) / TILE);
      let terrainHit = false;
      for (let row = r0; row <= r1 && !terrainHit; row++) {
        for (let col = c0; col <= c1 && !terrainHit; col++) {
          const t = getTile(state, col, row);
          if (t === TerrainType.BRICK) {
            // 砖墙：摧毁该格；双发砖块规则从简——一格即一块
            setTile(state, col, row, TerrainType.EMPTY);
            state.stats.bricksDestroyed++;
            terrainHit = true;
          } else if (t === TerrainType.STEEL || t === TerrainType.BOUNDARY) {
            terrainHit = true; // 钢墙无损
          }
          // GRASS / EMPTY 穿透
        }
      }
      if (terrainHit) {
        stopX = rect.x;
        stopY = rect.y;
        hitSomething = true;
        break;
      }

      // ---- 基地 ----
      if (hitBaseAt(state, rect)) {
        destroyBase(state);
        stopX = rect.x;
        stopY = rect.y;
        hitSomething = true;
        break;
      }

      // ---- 坦克 ----
      const tank = hitTankAt(state, rect, b);
      if (tank) {
        if (tank.kind === 'player') {
          killPlayer(state, tank.ownerIndex);
        } else {
          killEnemy(state, tank);
        }
        stopX = rect.x;
        stopY = rect.y;
        hitSomething = true;
        break;
      }
    }

    // 更新位置（命中则停在命中点）
    b.prevX = b.x;
    b.prevY = b.y;
    b.x = stopX;
    b.y = stopY;
    if (hitSomething) b.dead = true;

    // 基地被毁后立即终止本步其余子弹解析
    if (state.phase === PHASE.GAME_OVER) {
      for (const bb of state.bullets) bb.dead = true;
      break;
    }
  }

  // ---- 子弹互撞（C8）：玩家弹与敌弹相撞同归于尽 ----
  resolveBulletCollisions(state);
}

/** 玩家/敌弹相撞，双方销毁 */
function resolveBulletCollisions(state) {
  const list = state.bullets;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.dead) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (b.dead) continue;
      if (a.ownerKind === b.ownerKind) continue; // 只处理敌对子弹
      const hit = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      if (hit) {
        a.dead = true;
        b.dead = true;
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------
 * 死亡处理
 * ------------------------------------------------------------------ */

/** 击毁敌人：加分、计数、从场上移除 */
export function killEnemy(state, enemy) {
  if (!enemy.alive) return;
  enemy.alive = false;
  state.killedEnemies++;
  state.stats.enemiesKilled++;
  addScore(state, SCORE_KILL);
  if (state.players[enemy.ownerIndex]) {
    // 敌人子弹计数归属（若曾按个体计数）
  }
}

/**
 * 玩家中弹：扣一条命；命数 > 0 则原地板回出生点并给无敌；
 * 命数为 0 → 失败(gameOver, reason='lives')。
 */
export function killPlayer(state, ownerIndex) {
  const p = state.players[ownerIndex];
  if (!p || !p.alive) return;
  if (p.invuln > 0) return; // 无敌保护

  state.lives = Math.max(0, state.lives - 1);
  state.stats.deaths++;
  p.alive = false;
  p.bulletsInAir = 0;

  if (state.lives <= 0) {
    state.reason = 'lives';
    enterPhase(state, PHASE.GAME_OVER);
    return;
  }

  // 复活：回到本关出生点
  const spawn = state.level.playerSpawns[ownerIndex] || state.level.playerSpawns[0];
  p.x = spawn.col * TILE + (TILE - p.w) / 2;
  p.y = spawn.row * TILE + (TILE - p.h) / 2;
  p.dir = 'up';
  p.alive = true;
  p.invuln = RESPAWN_INVULN;
  p.fireCd = 0;
}

/** 基地被毁 → 立即失败 */
export function destroyBase(state) {
  if (!state.base.alive) return;
  state.base.alive = false;
  state.reason = 'base';
  enterPhase(state, PHASE.GAME_OVER);
}

/** 加分并同步最高分 */
export function addScore(state, n) {
  state.score += n;
  if (state.score > state.highScore) state.highScore = state.score;
}

/* ------------------------------------------------------------------
 * 帧末清理 & 胜负判定
 * ------------------------------------------------------------------ */

/** 移除已死亡实体，回收 bulletsInAir 计数 */
function cleanupDead(state) {
  // 玩家子弹计数
  for (const p of state.players) {
    if (!p) continue;
    p.bulletsInAir = state.bullets.filter(
      (b) => !b.dead && b.ownerKind === 'player' && b.ownerIndex === p.ownerIndex,
    ).length;
  }
  // 敌人子弹计数
  for (const e of state.enemies) {
    e.bulletsInAir = state.bullets.filter(
      (b) => !b.dead && b.ownerKind === 'enemy' && b.ownerTankId === e.id,
    ).length;
  }

  // 清理
  if (state.bullets.some((b) => b.dead)) {
    state.bullets = state.bullets.filter((b) => !b.dead);
  }
  if (state.enemies.some((e) => !e.alive)) {
    state.enemies = state.enemies.filter((e) => e.alive);
  }
}

/**
 * 胜负判定：
 *  - 基地不存活 → gameOver(reason='base')
 *  - 命数耗尽 → gameOver(reason='lives')
 *  - 本关敌人全部生成且全部击毁 → levelClear（+过关奖励），第 3 关后 allClear
 */
export function checkWinLose(state) {
  if (state.phase !== PHASE.PLAYING) return;

  if (!state.base.alive) {
    state.reason = 'base';
    enterPhase(state, PHASE.GAME_OVER);
    return;
  }
  if (state.lives <= 0) {
    state.reason = 'lives';
    enterPhase(state, PHASE.GAME_OVER);
    return;
  }

  // 敌人清空：未生成数为 0 且场上无敌人
  if (state.enemiesRemaining <= 0 && state.enemies.length === 0) {
    const bonus = SCORE_CLEAR_BASE * (state.levelIndex + 1);
    addScore(state, bonus);
    if (state.levelIndex + 1 >= 3) {
      enterPhase(state, PHASE.ALL_CLEAR);
    } else {
      enterPhase(state, PHASE.LEVEL_CLEAR);
    }
  }
}

export { PHASE };
