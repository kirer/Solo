/**
 * 游戏状态（纯数据）
 * ------------------------------------------------------------------
 * 重要约束：
 *  - GameState 不持有任何 DOM / Canvas 引用，可在 Node 中直接构造与更新。
 *  - 渲染层只读，不写。
 *  - 所有字段的语义见 docs/architecture.md 3.2。
 */

import {
  PHASE, INITIAL_LIVES, LEVEL_INTRO_SECONDS, PLAYER_SPEED, TILE,
} from './constants.js';
import { LEVELS, getLevel, LEVEL_COUNT } from '../levels/index.js';
import { layoutToGrid, TerrainType } from '../entities/terrain.js';
import { createTank, placeTank } from '../entities/tank.js';
import { createBase } from '../entities/base.js';
import { setTile } from './world.js';
import { defaultRng } from './rng.js';
import { emptyInput } from '../input/keys.js';

/**
 * 创建初始游戏状态（菜单态）
 * @param {object} [opts]
 * @param {number} [opts.highScore]
 * @param {object} [opts.rng]
 * @param {boolean} [opts.twoPlayers] 是否双人（菜单可切换）
 */
export function createGameState({ highScore = 0, rng = defaultRng, twoPlayers = false } = {}) {
  return {
    phase: PHASE.MENU,
    prevPhase: null,
    reason: null,          // gameOver 原因：'base' | 'lives'

    time: 0,               // 逻辑累计秒
    stepCount: 0,          // 逻辑步数
    scale: 3,              // 渲染整数倍（由 renderer 写回，仅表现用）

    levelIndex: 0,
    lives: INITIAL_LIVES,
    score: 0,
    highScore: highScore | 0,
    twoPlayers,

    terrain: new Uint8Array(13 * 13),
    base: createBase({ col: 6, row: 12 }),
    players: [
      makePlayer(0),
      makePlayer(1),
    ],
    bullets: [],
    enemies: [],

    level: null,
    spawnTimer: 0,
    spawnCursor: 0,
    enemiesRemaining: 0,   // 未生成 + 未击毁（= 该关敌人总数 - 已击毁）
    killedEnemies: 0,
    introTimer: 0,

    input: emptyInput(),
    rng,
    timers: { flash: 0 },  // 表现用计时（如过关闪烁），无副作用

    // 统计（调试与验收用）
    stats: { shotsFired: 0, enemiesKilled: 0, bricksDestroyed: 0, deaths: 0 },
  };
}

/** 构造一个玩家坦克占位（enabled 决定是否参与逻辑与渲染） */
function makePlayer(ownerIndex) {
  const t = createTank({ kind: 'player', ownerIndex, col: 4, row: 12, dir: 'up', speed: PLAYER_SPEED });
  t.enabled = ownerIndex === 0; // 默认仅 P1 启用
  return t;
}

/** 切换状态机 phase */
export function enterPhase(state, phase) {
  state.phase = phase;
  if (phase !== PHASE.PAUSED) state.prevPhase = null;
}

/**
 * 载入指定关卡：重置地形/基地/玩家/敌人/子弹与生成器
 * @param {object} state
 * @param {number} levelIndex 0 基
 */
export function loadLevel(state, levelIndex) {
  const level = getLevel(levelIndex);
  if (!level) return false;

  state.levelIndex = levelIndex;
  state.level = { ...level, layout: [...level.layout] };
  state.time = 0;
  state.stepCount = 0;
  state.spawnTimer = 0;
  state.spawnCursor = 0;
  state.killedEnemies = 0;
  state.enemiesRemaining = level.enemyCount;
  state.introTimer = LEVEL_INTRO_SECONDS;
  state.bullets = [];
  state.enemies = [];
  state.reason = null;

  // 地形：layout 字符 → Uint8Array
  state.terrain = layoutToGrid(level.layout, 13);

  // 基地
  state.base = createBase(level.base);

  // 基地占用的格清空，避免基地格上还长着砖（视觉重叠）
  setTile(state, state.base.col, state.base.row, TerrainType.EMPTY);

  // 玩家：P1 必定启用；P2 依 twoPlayers 决定
  state.players.forEach((p, i) => {
    const spawn = level.playerSpawns[i] || level.playerSpawns[0];
    placeTank(p, spawn.col, spawn.row, 'up');
    p.enabled = i === 0 || state.twoPlayers;
    p.alive = true;
    p.invuln = 0;
  });

  return true;
}

/**
 * 重开本局：命数回满、分数清零、重新载入当前关
 * 注意：最高分不回退（持久化于 storage）
 */
export function restartLevel(state) {
  state.lives = INITIAL_LIVES;
  state.score = 0;
  state.stats = { shotsFired: 0, enemiesKilled: 0, bricksDestroyed: 0, deaths: 0 };
  loadLevel(state, state.levelIndex);
  enterPhase(state, PHASE.LEVEL_INTRO);
}

/** 从菜单开始新游戏 */
export function startNewGame(state, twoPlayers = false) {
  state.twoPlayers = twoPlayers;
  state.levelIndex = 0;
  state.lives = INITIAL_LIVES;
  state.score = 0;
  state.stats = { shotsFired: 0, enemiesKilled: 0, bricksDestroyed: 0, deaths: 0 };
  loadLevel(state, 0);
  enterPhase(state, PHASE.LEVEL_INTRO);
}

/** 进入下一关；若无下一关则进入通关结算 */
export function nextLevel(state) {
  const next = state.levelIndex + 1;
  if (next >= LEVEL_COUNT) {
    enterPhase(state, PHASE.ALL_CLEAR);
    return false;
  }
  loadLevel(state, next);
  enterPhase(state, PHASE.LEVEL_INTRO);
  return true;
}

export { PHASE, LEVELS, LEVEL_COUNT, TILE };
