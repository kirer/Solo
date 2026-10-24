/**
 * 全局常量（逻辑像素与时间单位）
 * ------------------------------------------------------------------
 * 战场固定 13x13 格，每格 16px，因此逻辑尺寸恒为 208x208。
 * Canvas 不改变逻辑坐标，只在绘制时按整数倍 scale 放大，
 * 保证所有实体坐标始终 16px 网格对齐、像素风锐利。
 */

/** 战场列数 / 行数 */
export const GRID = 13;

/** 每格逻辑像素 */
export const TILE = 16;

/** 战场逻辑宽高（px） */
export const FIELD_W = GRID * TILE; // 208
export const FIELD_H = GRID * TILE; // 208

/** 默认整数倍缩放（624x624），实际由 renderer 根据窗口自适应 */
export const DEFAULT_SCALE = 3;
export const MIN_SCALE = 1;
export const MAX_SCALE = 6;

/** 固定逻辑步长：60Hz */
export const STEP_SECONDS = 1 / 60;

/** 累加器上限（秒）：切后台回来不补帧，防“螺旋死亡” */
export const MAX_ACCUM = 0.25;

/* ===== 速度（px / 秒） ===== */
/** 玩家坦克速度（约 5 格/秒） */
export const PLAYER_SPEED = 80;
/** 敌人坦克基础速度（关卡可覆盖） */
export const ENEMY_SPEED = 56;
/** 子弹速度（高速，必须用扫掠判定防穿墙） */
export const BULLET_SPEED = 220;

/* ===== 射击 ===== */
/** 玩家射击冷却（秒） */
export const PLAYER_FIRE_CD = 0.35;
/** 敌人射击冷却默认值（秒，关卡可覆盖） */
export const ENEMY_FIRE_CD = 1.2;
/** 玩家同屏子弹上限（经典规则） */
export const PLAYER_MAX_BULLETS = 2;
/** 敌人同屏子弹上限 */
export const ENEMY_MAX_BULLETS = 1;

/* ===== 尺寸 ===== */
/** 坦克 AABB 边长：略小于一格（14），保证能穿过一格宽通道 */
export const TANK_SIZE = 14;
/** 子弹 AABB 边长 */
export const BULLET_SIZE = 4;

/* ===== 玩家 ===== */
/** 初始命数（双人共享命池） */
export const INITIAL_LIVES = 3;
/** 复活后的无敌秒数 */
export const RESPAWN_INVULN = 2.0;
/** 关卡开始提示停留秒数 */
export const LEVEL_INTRO_SECONDS = 1.5;

/* ===== 计分 ===== */
/** 击毁一辆敌方坦克得分 */
export const SCORE_KILL = 100;
/** 过关奖励基数（实际 = 基数 * 关卡号） */
export const SCORE_CLEAR_BASE = 300;

/** 四方向枚举与单位向量（顺序固定，AI 换向依赖该顺序） */
export const DIRS = ['up', 'right', 'down', 'left'];

/** 方向 → 单位向量，y 轴向下 */
export const DIR_VEC = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/** 方向 → 反向 */
export const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

/** 游戏状态机全部 phase 枚举 */
export const PHASE = {
  MENU: 'menu',
  LEVEL_INTRO: 'levelIntro',
  PLAYING: 'playing',
  PAUSED: 'paused',
  LEVEL_CLEAR: 'levelClear',
  GAME_OVER: 'gameOver',
  ALL_CLEAR: 'allClear',
};
