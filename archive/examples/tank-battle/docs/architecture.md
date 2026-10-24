# tank-battle 架构设计（v1）

> 依据 CTO 已定方案落地，不引入任何框架/CDN/外链资源。零构建、零依赖，原生 ES Module（ES2020），双击 index.html 或静态服务器即可运行。

---

## 1. 设计总原则

1. **逻辑与渲染解耦**：`game-core` 只操作纯数据（`GameState`），不 import 任何 `render/*`。`render` 只读 `GameState`，不修改它。
2. **固定步长逻辑**：`requestAnimationFrame` 驱动，累加器（accumulator）以 1/60s 逻辑步推进，逻辑更新与渲染帧率分离，保证不同刷新率下手感一致、碰撞稳定。
3. **确定性**：逻辑更新只接受固定 dt（`STEP_SECONDS`），随机数走注入的 `rng`（可替换种子），便于测试复现。
4. **数据外置**：3 关地形/敌人参数全部是 `levels/*.js` 的纯常量，调参不动逻辑。
5. **零外部资源**：所有图形用 Canvas 2D 几何图形/纯色块绘制，无图片、无字体文件、无 CDN。
6. **无越界跨层调用**：`input → game-core → render` 单向数据流；`main.js` 是唯一装配点（composition root）。

---

## 2. 模块边界

```
index.html          页面骨架：canvas + HUD DOM（暂停/重开按钮、最高分、命数）
style.css           布局与 UI 样式（居中、整数倍缩放容器）
src/main.js         装配点：创建 canvas 上下文、input、renderer、game-core，启动主循环
src/game-core/
  constants.js      全局常量：网格、尺寸、速度、冷却、时间步、分数表
  state.js          GameState 纯数据对象 + 创建/重置/factory（createGameState）
  loop.js           固定步长主循环（accumulator + rAF），暴露 start/stop/tick
  world.js          网格查表与地形查询（格 → 地形类型、可通行/可穿透/可破坏）
  collision.js      AABB、网格区间求交、移动分步判定、子弹出膛与命中判定
  spawner.js        敌人生成调度（按关卡参数、出生点轮转、生成间隔）
  ai.js             敌方坦克简易 AI（朝目标推进 + 遇障换向 + 定时射击）
  rules.js          胜负判定、过关/失败/通关、玩家扣命复活、计分
  rng.js            可替换随机数（默认 Math.random 包装，测试可注入序列）
src/entities/
  tank.js           坦克实体 factory 与移动/朝向/冷却数据结构
  bullet.js         子弹 factory（速度、方向、归属、有效标记）
  terrain.js        地形枚举与网格写入助手（砖/钢/草/空）
  base.js           基地实体（位置、存活标记、占据格）
src/levels/
  level1.js         第 1 关数据常量
  level2.js         第 2 关数据常量
  level3.js         第 3 关数据常量
  index.js          关卡聚合导出 + schema 校验 helper
src/render/
  renderer.js       主绘制入口：清屏 → 地形 → 基地 → 坦克 → 子弹 → 草层覆盖 → 网格整数缩放
  colors.js         调色板常量
  hud.js            画布内文字（关卡号/命数/分数提示、菜单文案）
src/input/
  keys.js           键位映射表 + KeyboardInput（按下集合、边沿触发eat）
src/storage/
  save.js           localStorage 读写（键 tank-battle:v1，最高分 + 已通关进度）
tests/
  smoke.mjs         Node 环境无头冒烟：跑主循环逻辑、移动、射击、过关、失败、存档
```

**依赖方向**：`main.js → input/game-core/render`；`game-core/* → entities, levels, storage(可选)`；`render/* → entities, levels, game-core/constants`；`entities/* → game-core/constants`。**禁止** `game-core → render`。

---

## 3. 数据结构

### 3.1 战场与单位常量（`game-core/constants.js`）

| 名称 | 值 | 说明 |
| --- | --- | --- |
| `GRID` | `13` | 13x13 格 |
| `TILE` | `16` | 每格 16px |
| `FIELD_W/H` | `208` | 逻辑像素（13*16） |
| `DEFAULT_SCALE` | `3` | 默认 3x，成整数倍放大到 624x624 |
| `STEP_SECONDS` | `1/60` | 固定逻辑步长 |
| `MAX_ACCUM` | `0.25` | 累加器上限，切页面回来防螺旋死亡 |
| `PLAYER_SPEED` | `80` px/s | 约 5 格/秒 |
| `ENEMY_SPEED` | `56` px/s | — |
| `BULLET_SPEED` | `220` px/s | 高速，需扫掠判定防穿墙 |
| `PLAYER_FIRE_CD` | `0.35` s | 玩家射速 |
| `ENEMY_FIRE_CD` | `1.2` s | 敌人射速 |
| `PLAYER_MAX_BULLETS` | `2` | 同屏子弹上限（经典规则） |
| `TANK_SIZE` | `14` | 坦克 AABB 边长（略小于 16，便于过一格通道） |
| `BULLET_SIZE` | `4` | 子弹 AABB 边长 |
| `INITIAL_LIVES` | `3` | 玩家命数 |
| `RESPAWN_INVULN` | `2.0` s | 复活无敌秒数 |

### 3.2 游戏状态 `GameState`（`game-core/state.js`）

```js
GameState = {
  phase: 'menu',            // 'menu'|'levelIntro'|'playing'|'paused'|'levelClear'|'gameOver'|'allClear'
  prevPhase: null,          // 暂停前所处 phase，用于恢复
  stepCount: 0,             // 已执行逻辑步数（调试/慢放）
  time: 0,                  // 逻辑累计秒
  scale: 3,                 // 渲染整数倍（由 renderer 计算后写回，不含逻辑依赖）

  levelIndex: 0,            // 0..2
  lives: 3,                 // 玩家总命数（双人共享命池，先扣后复活）
  score: 0,
  highScore: 0,             // 启动从 storage 载入

  terrain: Uint8Array(169), // 13*13 网格，值见 TerrainType
  base: { col, row, alive, hp:1 },
  players: [ PlayerTank, PlayerTank"],   // 长度恒为 2，第 2 位 enabled=false 表示单人
  bullets: [ Bullet, ... ],
  enemies: [ EnemyTank, ... ],

  // 关卡运行时
  level: LevelData,         // 当前关卡副本（含剩余待生成敌人数量）
  spawnTimer: 0,
  spawnCursor: 0,           // 出生点轮转索引
  enemiesRemaining: 0,      // 尚未击毁 + 尚未生成
  killedEnemies: 0,
  introTimer: 0,            // levelIntro 倒计时

  input: InputSnapshot,     // 本步输入快照（由 input 层生成）
  timers: { flash: 0 },     // 表现用计时（纯数据，无副作用）
}
```

#### 坦克实体字段（`entities/tank.js`）

```js
Tank = {
  id: number,
  kind: 'player' | 'enemy',
  ownerIndex: 0|1,      // 玩家：0=P1，1=P2；敌人：-1
  x, y,                 // 逻辑像素左上角（网格对齐）
  w, h,                 // 14x14
  dir: 'up'|'right'|'down'|'left',   // 四方向，决定朝向与出弹位置
  speed: number,        // px/s
  alive: boolean,
  bulletsInAir: number, // 已发射未销毁子弹数（受上限约束）
  fireCd: number,       // 剩余冷却秒数
  invuln: number,       // 玩家复活无敌剩余秒
  hp: number,           // 敌人默认 1，可扩展
  ai: {                 // 仅敌人使用
    fireTimer: number,
    retargetTimer: number,
    stuckTimer: number,  // 撞击累计，超阈值换向
  }
}
```

#### 子弹实体字段（`entities/bullet.js`）

```js
Bullet = {
  id: number,
  x, y, w: 4, h: 4,
  dir: 'up'|...
  vx, vy,               // px/s 分量（由 dir + BULLET_SPEED 推出）
  ownerKind: 'player'|'enemy',
  ownerIndex: number,   // 玩家归属 0/1；敌人 -1
  dead: boolean,        // 命中/越界后置 true，帧末统一清理
  prevX, prevY,         // 上一步位置（扫掠判定用）
}
```

#### 地形枚举（`entities/terrain.js`）

```js
TerrainType = { EMPTY:0, BRICK:1, STEEL:2, GRASS:3, BOUNDARY:4 }
```

### 3.3 关卡数据 schema（`levels/levelN.js`）

```js
LevelData = {
  id: 1,                     // 1..3
  name: '第一关 · 前哨',
  enemyCount: 10,            // 本关敌方坦克总数
  maxEnemiesOnField: 4,      // 场上同时存在上限
  spawnInterval: 2.0,        // 生成间隔（秒），逐关变短
  enemyFireCd: 1.2,          // 敌人射击冷却（秒），逐关变短
  enemySpeed: 56,            // 敌人速度 px/s，逐关变快
  playerLives: 3,            // 本关开始分配命数（仅第 1 关生效，之后沿用）
  /* 地形：13 行字符串数组，每行 13 字符
     使用字符集：'.' 空, 'B' 砖, 'S' 钢, 'G' 草
     基地固定位于底部中央两列（第 6 列），由 base 字段定义，地形上自动清除 */
  layout: [ '.............', ... 13 行 ... ],
  base: { col: 6, row: 12 }, // 基地左上格（实际占 2x2 中的 1x1 主体 + 周边砖墙）
  playerSpawns: [ {col:4,row:12}, {col:8,row:12} ],  // P1 / P2 出生格
  enemySpawns: [ {col:0,row:0}, {col:6,row:0}, {col:12,row:0} ], // 上方出生点轮转
}
```

### 3.4 存档结构（`storage/save.js`）

```js
localStorage['tank-battle:v1'] = JSON.stringify({
  version: 1,
  highScore: number,
  cleared: [1,2,3]  // 已通关关卡号数组（只增量，不重置）
})
```
读写均做 try/catch，隐私模式或损坏数据时降级为内存值，不抛错。

---

## 4. 游戏状态机

```
                 ┌────────────(Esc 暂停)────────────┐
                 v                                  │
 [menu] --Enter/Space--> [levelIntro] --1.5s--> [playing] --全部敌灭且基地存活--> [levelClear]
   ^                        │                      │  │  ↑                          │
   │                        │                      │  └──Esc──> [paused] ──Esc/R──┘（恢复回到原 phase）
   │                        │                      │
   │                        │                      ├──基地被毁 或 命数耗尽--> [gameOver]
   │                        │                      │
   │                        └──R 重开本关-------------------------┘
   │
   └──(R / Enter)────────── [gameOver] / [allClear]
                            [levelClear] --Enter/Space--> 下一关 [levelIntro]；第 3 关后 --> [allClear]
```

| 状态 | 说明 | 允许输入 |
| --- | --- | --- |
| `menu` | 主界面：标题 / 操作说明 / 最高分 / 暂停·重开按钮可见 | Enter/Space 开始 |
| `levelIntro` | 显示「第 N 关」与剩余命数，倒计时 1.5s | 无（R 重开、Esc 无效） |
| `playing` | 正常逻辑更新 | 全部 |
| `paused` | 冻结逻辑，仅渲染 + 遮罩 | Esc 恢复、R 重开 |
| `levelClear` | 本关达成，显示得分，等待继续 | Enter/Space 下一关 |
| `gameOver` | 失败结算：原因（基地被毁 / 命数耗尽）+ 得分 + 最高分 | R/Enter 回 menu 重开 |
| `allClear` | 3 关通关结算 | R/Enter 回 menu |

**状态迁移只发生在 `game-core/rules.js` 的 `transition()` 中**，一次逻辑步内至多一次迁移，避免同帧多重判定。

---

## 5. 主循环伪代码（`game-core/loop.js`）

```text
function createLoop({ update, render, stepSeconds = 1/60, maxAccum = 0.25 }) {
  let last = 0, accum = 0, running = false, rafId = 0

  function frame() {
    if (!running) return
    const now = performance.now()
    let delta = (now - last) / 1000
    last = now
    if (delta > maxAccum) delta = maxAccum      // 切后台回来不补帧
    if (delta < 0) delta = 0
    accum += delta

    rafId = requestAnimationFrame(frame)        // ① 先排下一帧：单帧异常也不停摆

    while (accum >= stepSeconds) {              // 固定步长逻辑推进
      try { update(stepSeconds) }               // 只吃常量 dt → 确定性
      catch (err) { reportError(err); accum = 0; break }
      accum -= stepSeconds
    }

    try { render(accum / stepSeconds) }          // 传插值系数（骨架忽略，后续可用于平滑）
    catch (err) { reportError(err) }
  }

  return {
    start() { if (running) return; running = true; last = performance.now(); rafId = requestAnimationFrame(frame) },
    stop()  { running = false; cancelAnimationFrame(rafId) },
    tickOnce(dt, opts)  { update(dt, opts) },   // 测试/回放：固定步长单步推进
    renderOnce(alpha)   { render(alpha) }       // 测试/调试：手动触发一次渲染
  }
}
```

**健壮性约定（重要）**：`frame()` 必须在最开头就排下一帧，update/render 各自 try/catch。
rAF 回调内的异常会中断后续调度，若不加保护会导致主循环永久停摆（headless 环境实测复现过）。
`update(dt, opts)` 的 `opts.skipInputSync` 为真时不覆盖 `state.input`，供测试直接注入输入。

**装配点 `main.js`**：

```text
const state = createGameState({ highScore: loadSave().highScore })
const input = createKeyboardInput(window)
const renderer = createRenderer(canvas)
const loop = createLoop({
  update(dt) { state.input = input.snapshot(); updateGame(state, dt) },
  render()   { renderer.draw(state) }
})
loop.start()
```
Node 冒烟测试不依赖 rAF：直接循环调用 `updateGame(state, 1/60)`。

---

## 6. 碰撞判定规则表

坐标系：逻辑像素，y 向下。网格坐标 `col = floor(x / 16)`，`row = floor(y / 16)`。

| # | 判定对象 | 方法 | 规则 / 结果 |
| --- | --- | --- | --- |
| C1 | 坦克 vs 边界 | AABB 与 `[0,208)` 视口区间 | 越界则该轴移动回退（分轴判定，允许贴墙滑行） |
| C2 | 坦克 vs 地形 | 分轴移动后取 AABB 覆盖的所有格（`cellsOfAABB` 网格查表） | 命中 `BOUNDARY / BRICK / STEEL / 基地` → 该轴回退；`GRASS / EMPTY` 可通行 |
| C3 | 坦克 vs 坦克 | AABB 相交 | 移动后与任意存活坦克相交 → 该轴回退（不做推开，避免抖动） |
| C4 | 坦克 vs 基地 | 基地占据格视作实体障碍 | 同 C2，坦克不得压过基地 |
| C5 | 子弹 vs 地形 | **扫掠**：按 `prev→cur` 的 AABB 并集逐格检查，并沿运动方向按 `BULLET_SIZE` 步进采样 | 命中 `BRICK` → 销毁该砖格 + 子弹销毁；`STEEL` → 子弹销毁、钢墙保留；`BOUNDARY` → 子弹销毁；`GRASS/EMPTY` → 穿透，不销毁。**扫掠保证 220px/s 子弹不穿墙** |
| C6 | 子弹 vs 坦克 | 扫掠 AABB 与坦克 AABB 相交 | 己方子弹不伤己方玩家；敌方子弹命中玩家：非无敌 → 扣命 + 复活/失败；玩家子弹命中敌人 → 敌人死亡 + 计分。子弹销毁 |
| C7 | 子弹 vs 基地 | 扫掠 AABB 与基地格相交 | 任意子弹（含玩家误伤）命中 → 基地 `alive=false` + 立即 `gameOver` |
| C8 | 子弹 vs 子弹 | AABB 相交 | 双方子弹同时销毁（可选，骨架启用） |
| C9 | 子弹出膛 | 在坦克朝向侧车体中心生成 | 出膛点若已在砖/钢/边界内，直接销毁（防卡在墙里穿出） |
| C10 | 同屏子弹上限 | 计数 `bulletsInAir` | 玩家 2 发、敌人 1 发，超出不发射 |

**分轴移动顺序**：先 x 后 y（或依 dir 决定主轴），保证贴墙滑动手感；每轴独立回退。

---

## 7. 难度 / 参数表（逐关）

| 参数 | 第 1 关 | 第 2 关 | 第 3 关 |
| --- | --- | --- | --- |
| 敌人总数 `enemyCount` | 8 | 12 | 16 |
| 场上同时存在上限 | 3 | 4 | 5 |
| 生成间隔 `spawnInterval` (s) | 2.6 | 2.0 | 1.5 |
| 敌人射速冷却 `enemyFireCd` (s) | 1.6 | 1.2 | 0.9 |
| 敌人速度 `enemySpeed` px/s | 48 | 56 | 64 |
| 玩家初始命数 | 3 | 沿用 | 沿用 |
| 地形特征 | 少量砖墙、无钢墙 | 增加钢墙与草丛 | 砖钢混合走廊 + 大量草丛 |

**计分表**：击毁敌方坦克 `+100`；过关奖励 `+300 * levelId`；命中无分；最高分 = max(旧值, 本局分数)。

**时长核算**：8 敌 × 约 15s ≈ 2 分钟；16 敌 × 约 12s ≈ 3 分钟，落在 1–5 分钟区间。

---

## 8. 键位表（`input/keys.js`）

| 行为 | P1 | P2 | 全局 |
| --- | --- | --- | --- |
| 上 | ArrowUp | KeyW | — |
| 下 | ArrowDown | KeyS | — |
| 左 | ArrowLeft | KeyA | — |
| 右 | ArrowRight | KeyD | — |
| 射击 | Space / KeyJ | KeyF | — |
| 暂停/恢复 | — | — | Esc（Pause 键亦映射到 Esc 行为） |
| 重开本局 | — | — | KeyR |
| 确认/开始 | — | — | Enter / Space（菜单态） |

- 使用 `event.code` 而非 `key`，避免输入法/大小写影响。
- 对方向键、空格调用 `preventDefault()`，防止页面滚动。
- 暂停/重开**同时**在画面内绘制提示文案，并在 DOM 层提供可见按钮（满足「暂停/重开入口必须在 UI 上可见」）。
- 双人模式下 P1/P2 按 `ownerIndex` 隔离输入快照，互不干扰；单人模式仅 P1 生效（P2 实体 `enabled=false`，不更新不绘制）。

---

## 9. 渲染与缩放

- `canvas` 内部分辨率 = `208 * scale`；`scale` 取 `floor(min(容器宽, 容器高) / 208)`，最小 1，默认 3。
- 绘制时 `ctx.setTransform(scale,0,0,scale,0,0)`，全部按逻辑像素坐标绘制，`ctx.imageSmoothingEnabled=false`，保证整数像素锐利。
- 绘制顺序：背景 → 砖/钢/边界 → 基地 → 子弹 → 坦克 → **草丛最后覆盖**（草丛遮蔽坦克，满足「可遮蔽」）→ 淡色网格线（可选，默认关闭）→ HUD 文本。
- 图形全部几何绘制：坦克=车身矩形 + 炮管矩形 + 朝向标记；砖=2x2 小格砖纹；钢=带高光的方块；草=半透明绿块 + 短线；基地=鹰形三角+底座的简化几何；子弹=小方块。

---

## 10. 已知风险与规避

| 风险 | 规避 |
| --- | --- |
| 高速子弹穿墙 | C5 扫掠 + 方向步进采样 |
| 不同刷新率手感差异 | 固定步长 + 累加器 + 累加上限 |
| 双人按键冲突 | `event.code` + ownerIndex 隔离；P2 用 WASD/F 不与方向键重叠 |
| 暂停时定时器继续走 | 暂停在 `updateGame` 入口直接 return，所有计时器都在逻辑步内推进 |
| localStorage 不可用 | try/catch 降级内存值 |
| 切后台回来一秒补几十帧 | `MAX_ACCUM` 截断 |
| 内存增长 | 子弹/敌人每步帧末统一 `filter(dead)`，实体池不需常驻；冒烟脚本带长跑计数 |
| 无构建下模块 404 | 全部相对路径 + `.js` 扩展名；文件清单在 tasks.md 固定 |
