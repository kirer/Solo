# game-dev 任务清单（tank-battle）

> 说明：本清单按依赖顺序排列，任务粒度已小到可独立交付、独立验收。**每条任务完成后 self-test 通过才算交付**。
> 基线：架构文档见 `docs/architecture.md`；以下所有路径均为仓库相对路径。
> 所有任务遵守：零依赖、零 CDN、原生 ES Module、纯 Canvas 几何绘制、关键规则写中文注释。

图例：`[ ]` 待办 / `[x]` 已完成。**依赖**列列出必须先完成的任务编号。

---

## T01 项目骨架与装配点

- **涉及文件**：`index.html`、`style.css`、`src/main.js`、`src/game-core/constants.js`、`src/render/colors.js`
- **输入输出契约**
  - `constants.js` 导出全部常量对象（`GRID, TILE, FIELD_W, FIELD_H, DEFAULT_SCALE, STEP_SECONDS, MAX_ACCUM, PLAYER_SPEED, ENEMY_SPEED, BULLET_SPEED, PLAYER_FIRE_CD, ENEMY_FIRE_CD, PLAYER_MAX_BULLETS, ENEMY_MAX_BULLETS, TANK_SIZE, BULLET_SIZE, INITIAL_LIVES, RESPAWN_INVULN, SCORE_KILL, SCORE_CLEAR_BASE）`。
  - `index.html` 含 `<canvas id="game">`、HUD 容器（`#hud` 内 `#hud-highscore`、`#btn-pause`、`#btn-restart`），以 `<script type="module" src="./src/main.js">` 引入。
  - `main.js` 导出 `bootstrap(canvas)` 并自执行装配（创建 state/input/renderer/loop）。
- **验收标准**
  1. 双击 `index.html` 或 `python3 -m http.server` 打开，控制台无 error。
  2. 可见 208*scale 的 canvas（默认 624x624），HUD 上能看见「暂停」「重开」两个按钮。
  3. `constants.js` 数值与架构文档第 3.1 节完全一致。
- **依赖**：无

---

## T02 键盘输入层

- **涉及文件**：`src/input/keys.js`
- **输入输出契约**
  - 导出 `KEYMAP`（常量键位表）、`createKeyboardInput(target)`。
  - `createKeyboardInput` 返回 `{ isDown(code), pressed(code), snapshot(), destroy() }`；`snapshot()` 返回
    `{ p1: {up,down,left,right,fire}, p2: {...}, pause, restart, confirm }`（均为 boolean）。
  - `pressed` 为边沿触发（消费后清除）。
- **验收标准**
  1. 按方向键 → `snapshot().p1.up` 等为 true；WASD → `p2` 对应 true；F → `p2.fire`；空格/J → `p1.fire`。
  2. 方向键与空格触发 `preventDefault`，页面不滚动。
  3. `destroy()` 后监听器全部移除（可用 `getEventListeners` 或断点验证，无内存泄漏）。
- **依赖**：T01

---

## T03 实体工厂与关卡数据

- **涉及文件**：`src/entities/terrain.js`、`src/entities/tank.js`、`src/entities/bullet.js`、`src/entities/base.js`、`src/levels/level1.js`、`src/levels/level2.js`、`src/levels/level3.js`、`src/levels/index.js`
- **输入输出契约**
  - `TerrainType = {EMPTY:0, BRICK:1, STEEL:2, GRASS:3, BOUNDARY:4}`；`layoutToGrid(layout)` → `Uint8Array(169)`；`gridIndex(col,row)`。
  - `createTank({kind, ownerIndex, col, row, dir, speed})` → Tank（字段见架构 3.2）。
  - `createBullet({x,y,dir,ownerKind,ownerIndex})` → Bullet（含 `vx,vy,prevX,prevY,dead`）。
  - `createBase({col,row})` → `{col,row,w:TILE,h:TILE,alive:true}`。
  - 3 个关卡文件各 `export default LevelData`，字段严格符合架构 3.3；`levels/index.js` 导出 `LEVELS` 数组与 `validateLevel(level)`（校验 13 行 × 13 字符、出生点在地图内）。
- **验收标准**
  1. 3 关 `layout` 均为 13 行 × 13 字符，字符只在 `.BSG` 中。
  2. 三关地形互不相同；难度参数严格递增/递减符合架构第 7 节参数表。
  3. `validateLevel` 对任一关卡返回 `true`。
- **依赖**：T01

---

## T04 世界与网格查询 + AABB 碰撞工具

- **涉及文件**：`src/game-core/world.js`、`src/game-core/collision.js`
- **输入输出契约**
  - `world.js`：`getTile(state, col, row)`、`isSolidTile(t)`、`cellAt(x,y)`、`cellsOfAABB(aabb)`、`isRectBlocked(state, aabb, {ignoreBase=false, ignoreTanks=null})`。
  - `collision.js`：`aabb(x,y,w,h)`、`overlap(a,b)`、`moveTank(state, tank, dx, dy)`（分轴判定，返回 `{movedX, movedY}`）、`sweepCells(prevAABB, curAABB)`（返回沿途所有格）、`resolveBulletHits(state)`、`canFire(state, tank)`。
- **验收标准**
  1. 坦克贴砖墙移动不穿墙、可沿墙滑行（分轴）。
  2. 坦克不能越出 208x208；不能压过基地。
  3. `sweepCells` 对高速移动返回完整路径格集合（单元自测：从 x=16 到 x=200 的单步扫掠包含中间所有列）。
- **依赖**：T03

---

## T05 游戏状态与状态机

- **涉及文件**：`src/game-core/state.js`、`src/game-core/rules.js`、`src/game-core/rng.js`
- **输入输出契约**
  - `state.js`：`createGameState({highScore=0, rng})`；`loadLevel(state, levelIndex)`（写 terrain/base/players 位置/重置生成器与子弹）；`enterPhase(state, phase)`。
  - `rules.js`：`updateGame(state, dt)`（总入口，按 phase 分发）、`transition(state, next)`、`checkWinLose(state)`、`killPlayer(state, ownerIndex)`、`addScore(state, n)`。
  - `rng.js`：`createRng(seed?)` → `{ next(), int(n), pick(arr) }`，可注入序列供测试。
- **验收标准**
  1. `menu → levelIntro → playing` 流转正确（`introTimer` 1.5s 后自动进 playing）。
  2. `paused` 期间 `updateGame` 不改任何实体坐标/计时器；恢复后继续。
  3. `loadLevel` 后玩家在 `playerSpawns[0]`、基地按关卡坐标、`enemiesRemaining === level.enemyCount`。
- **依赖**：T03、T04

---

## T06 玩家移动与射击

- **涉及文件**：`src/game-core/rules.js`（玩家部分）、`src/entities/tank.js`（冷却）、`src/game-core/collision.js`（出膛点）
- **输入输出契约**
  - `updatePlayers(state, dt)`：读 `state.input.p1/p2`，四方向择一走（同时按多键取最后有效方向或优先级 上>下>左>右，需注释说明）、`fireCd` 递减、`fire` 且 `bulletsInAir < PLAYER_MAX_BULLETS` 时调用 `spawnPlayerBullet`。
  - `spawnPlayerBullet(state, tank)` → Bullet | null（出膛点在车头中心；出膛即撞实心则返回 null）。
- **验收标准**
  1. 单人：方向键移动、空格/J 射击；双人：P1 与 P2 各自独立移动射击、互不串键。
  2. 连按射击受 `PLAYER_FIRE_CD` 与 `PLAYER_MAX_BULLETS` 双重限制。
  3. 玩家子弹可击毁砖墙、无法击毁钢墙、可穿草丛。
- **依赖**：T05

---

## T07 敌方生成与 AI

- **涉及文件**：`src/game-core/spawner.js`、`src/game-core/ai.js`
- **输入输出契约**
  - `spawner.js`：`updateSpawner(state, dt)`（累计 `spawnTimer`，达到 `level.spawnInterval` 且场上 < `maxEnemiesOnField` 且 `enemiesRemaining > 0` 时在 `enemySpawns[spawnCursor++ % n]` 生成并递减剩余）；`spawnEnemy(state, col, row)` → EnemyTank。
  - `ai.js`：`updateEnemies(state, dt)`（朝「更近目标（玩家或基地）」推进；撞墙/撞坦克累计 `stuckTimer` 超阈值则换向并随机挑一个可通行方向；`fireTimer` 到点射击）。
- **验收标准**
  1. 敌人按 `enemyCount` 与 `spawnInterval` 生成，场上不超上限。
  2. 敌人不是静止靶子：单步 60 帧内位置发生改变，且会朝玩家/基地方向靠近。
  3. 敌人会开火（`bullets.length` 增长）。
  4. 敌人不会卡死在死胡同（`stuckTimer` 换向生效，长跑 30s 后仍全部存活且均有位移）。
- **依赖**：T05、T06

---

## T08 子弹与命中判定

- **涉及文件**：`src/game-core/collision.js`、`src/game-core/rules.js`（`updateBullets`）
- **输入输出契约**
  - `updateBullets(state, dt)`：更新位置 → 扫掠地形判定（C5）→ 坦克判定（C6）→ 基地判定（C7）→ 子弹互撞（C8）→ 帧末清理 `dead` 并同步 `bulletsInAir`。
- **验收标准**
  1. 子弹命中砖墙：该砖格变 `EMPTY`，子弹消失。
  2. 子弹命中钢墙：钢墙保留，子弹消失。
  3. 子弹穿过草丛不消失（仅视觉遮蔽）。
  4. 220px/s 子弹不穿墙（构造贴墙射击用例验证）。
  5. 己方子弹不伤己方玩家；敌方子弹命中玩家扣命。
- **依赖**：T04、T06、T07

---

## T09 基地、扣命复活、胜负判定与计分

- **涉及文件**：`src/game-core/rules.js`
- **输入输出契约**
  - `killPlayer(state, ownerIndex)`：减 `lives`，`lives > 0` 则在该玩家出生点复活并给 `RESPAWN_INVULN` 无敌；否则 `transition(gameOver, reason='lives')`。
  - 基地被毁 → `transition(gameOver, reason='base')`，同一步内不再继续解析其他命中。
  - 过关：`enemiesRemaining === 0 && enemies.length === 0 && base.alive` → `levelClear`，加过关分。
  - 第 3 关 `levelClear` 后进 `allClear`。
  - `addScore` 内同步更新 `highScore` 与 `state.score`。
- **验收标准**
  1. 击毁全部敌人且基地存活 → `levelClear`，可进入下一关。
  2. 基地被击中 → 立即 `gameOver`，`reason='base'`。
  3. 命数为 0 → `gameOver`，`reason='lives'`；命数 > 0 时在出生点复活且 2s 内无敌。
  4. 击毁敌人 +100，过关 +300*关卡号；`allClear` 在第 3 关后到达。
- **依赖**：T08

---

## T10 Canvas 渲染器

- **涉及文件**：`src/render/renderer.js`、`src/render/hud.js`、`src/render/colors.js`
- **输入输出契约**
  - `createRenderer(canvas)` → `{ draw(state), resize(), destroy() }`；`draw` 只读 `state`。
  - 绘制顺序：背景 → 砖/钢/边界 → 基地 → 子弹 → 坦克 → **草丛覆盖层** → HUD 文本。
  - 各 phase 的覆盖层：`menu/levelIntro/paused/levelClear/gameOver/allClear` 文案（关卡号、命数、得分、最高分、「Esc 暂停 / R 重开」始终以 DOM 按钮形式可见）。
- **验收标准**
  1. 空战场可正确渲染 208x208 逻辑像素 × `scale`，无模糊（`imageSmoothingEnabled=false`）。
  2. 四类地形视觉可区分；草丛绘制在坦克之上形成遮蔽。
  3. 基地被毁后视觉标记为「毁坏」（变灰/破碎几何）。
  4. 各 phase 有对应界面文案；`levelIntro` 显示关卡号与剩余命数。
  5. 缩放自适应：窗口变化时 `resize()` 重算整数倍，最小 1x。
- **依赖**：T01、T03

---

## T11 暂停 / 重开 / 主循环接线

- **涉及文件**：`src/game-core/loop.js`、`src/main.js`
- **输入输出契约**
  - `createLoop({update, render, stepSeconds, maxAccum})` → `{start, stop, isRunning, tickOnce(dt, opts), renderOnce(alpha)}`（伪代码见架构第 5 节）。
  - `update(dt, opts)`：`opts.skipInputSync === true` 时不覆盖 `state.input`（供测试/回放注入）。
  - **健壮性要求**：`frame()` 内必须先无条件排下一帧（`raf(frame)`），再用 try/catch 包裹 update/render，
    确保单帧异常不会让主循环永久停摆。
  - `main.js`：`Esc` 在 `playing ↔ paused` 切换（记录 `prevPhase`）；`R` 重开当前关（重置 `loadLevel(state, levelIndex)`，命数重置为 3）；DOM 按钮 `#btn-pause`、`#btn-restart` 绑定同样行为。
- **验收标准**
  1. 固定步长生效：逻辑步长恒为 1/60，`MAX_ACCUM` 截断生效（模拟 1s 卡顿不产生 60 帧补帧）。
  2. Esc 暂停/恢复正确，暂停时画面静止但遮罩可见。
  3. R 重开本局：当前关重置、命数回 3、得分清零（本局内）。
  4. UI 上「暂停」「重开」按钮点击与按键等效。
- **依赖**：T09、T10

---

## T12 localStorage 存档 + HUD 最高分

- **涉及文件**：`src/storage/save.js`、`src/main.js`、`src/render/hud.js`
- **输入输出契约**
  - `loadSave()` → `{highScore, cleared}`（异常时返回默认值）；`saveProgress({highScore, clearedLevel})`；键名固定 `tank-battle:v1`。
  - 启动时 `state.highScore = loadSave().highScore`；`gameOver/allClear` 时写回最高分；通关某关时把关卡号加入 `cleared`。
- **验收标准**
  1. 刷新页面后最高分保留且显示在 HUD。
  2. localStorage 被禁用/写入抛错时不崩溃（降级为内存值）。
  3. 存档 JSON 结构严格符合架构 3.4。
- **依赖**：T09、T11

---

## T13 冒烟测试脚本（逻辑 + 浏览器 + 缩放）

- **涉及文件**：`tests/smoke.mjs`、`tests/browser-smoke.mjs`、`tests/resize-check.mjs`、`tests/README.md`
- **输入输出契约**
  - Node 运行 `node tests/smoke.mjs`，无需额外依赖（用 `globalThis.performance`、`Math.random`；不 import `render/*`）。
  - 覆盖：开局 → 移动生效 → 射击命中砖墙 → 击毁全部敌人进 `levelClear` → 下一关 → 基地被毁进 `gameOver(reason=base)` → 命数耗尽进 `gameOver(reason=lives)` → 3 关通关进 `allClear` → 存档读写。
- **验收标准**
  1. `node tests/smoke.mjs` 全部断言通过，退出码 0，输出 `SMOKE OK (29 tests passed)`。
  2. 长跑 3000 步（约 50s 逻辑）后 `bullets.length <= 40`、`enemies.length <= 6`（无泄漏）。
  3. 逻辑脚本不 import 任何 `src/render/*` 或 DOM API。
  4. `node tests/browser-smoke.mjs` 42 项全通过，输出 `BROWSER SMOKE OK`，并产出 5 张截图。
  5. `node tests/resize-check.mjs` 输出 `RESIZE OK`（整数倍 5x/3x/2x/1x）。
- **依赖**：T12

---

## 完成度汇总

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| T01 骨架与装配点 | [x] | 可打开、HUD 可见 |
| T02 键盘输入层 | [x] | code 映射 + preventDefault |
| T03 实体与关卡数据 | [x] | 3 关数据校验通过 |
| T04 世界与碰撞工具 | [x] | 分轴移动 + 扫掠 |
| T05 状态机 | [x] | 7 态全通 |
| T06 玩家移动射击 | [x] | 单人/双人 |
| T07 敌人生成与 AI | [x] | 会动会打 |
| T08 子弹命中 | [x] | 不穿墙 |
| T09 胜负计分 | [x] | 全路径覆盖 |
| T10 渲染器 | [x] | 纯几何绘制 |
| T11 循环与暂停重开 | [x] | 按钮等效 |
| T12 存档最高分 | [x] | 键 tank-battle:v1 |
| T13 冒烟脚本 | [x] | Node 29 项 + 浏览器 42 项 + 缩放 4 项全通过 |
