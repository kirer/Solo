/**
 * 无头冒烟测试（Node）
 * ------------------------------------------------------------------
 * 运行：node tests/smoke.mjs
 * 不 import 任何 render/* 或 DOM API，纯逻辑验证。
 *
 * 覆盖：
 *  1. 三关数据合法
 *  2. 开局流程 menu → levelIntro → playing
 *  3. 玩家移动生效、边界不可穿越、砖墙不可穿越
 *  4. 射击：可击毁砖墙、不可击毁钢墙、穿草丛
 *  5. 击毁全部敌人 → levelClear → 下一关
 *  6. 基地被毁 → gameOver(reason='base')
 *  7. 命数耗尽 → gameOver(reason='lives')
 *  8. 3 关通关 → allClear
 *  9. 暂停冻结逻辑、重开重置
 * 10. 长时间运行无实体泄漏
 * 11. localStorage 存档（Node 下用内存 mock）
 */

import assert from 'node:assert';

import { createGameState, loadLevel, startNewGame, restartLevel } from '../src/game-core/state.js';
import { updateGame } from '../src/game-core/rules.js';
import { PHASE, TILE, GRID, STEP_SECONDS, INITIAL_LIVES } from '../src/game-core/constants.js';
import { LEVELS, validateLevel } from '../src/levels/index.js';
import { TerrainType, layoutToGrid } from '../src/entities/terrain.js';
import { createBullet } from '../src/entities/bullet.js';
import { getTile, setTile } from '../src/game-core/world.js';
import { emptyInput } from '../src/input/keys.js';

/* ---------- 小型测试框架 ---------- */
let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

/** 构造一个已进入 playing 的状态 */
function freshPlaying(levelIndex = 0) {
  const state = createGameState({ highScore: 0 });
  startNewGame(state, false);
  loadLevel(state, levelIndex);
  state.phase = PHASE.PLAYING;
  state.introTimer = 0;
  state.input = emptyInput();
  return state;
}

/** 推进 n 步，每步使用给定输入 */
function tick(state, n = 1, inputPatch = null) {
  for (let i = 0; i < n; i++) {
    if (inputPatch) state.input = { ...emptyInput(), ...inputPatch };
    updateGame(state, STEP_SECONDS);
  }
}

/** 玩家输入快捷构造 */
function pinput({ up, down, left, right, fire } = {}) {
  const base = emptyInput();
  if (up) base.p1.up = true;
  if (down) base.p1.down = true;
  if (left) base.p1.left = true;
  if (right) base.p1.right = true;
  if (fire) base.p1.fire = true;
  return base;
}

/* ==================================================================
 * 1. 关卡数据
 * ================================================================== */
console.log('\n[1] 关卡数据');
test('三关均通过 validateLevel', () => {
  assert.equal(LEVELS.length, 3);
  for (const lv of LEVELS) {
    const r = validateLevel(lv);
    assert.ok(r.ok, `关卡 ${lv.id} 校验失败: ${r.errors.join(',')}`);
  }
});
test('三关地形互不相同', () => {
  const sig = LEVELS.map((lv) => lv.layout.join('|'));
  assert.equal(new Set(sig).size, 3);
});
test('难度递增：敌人更多、生成更快', () => {
  assert.ok(LEVELS[0].enemyCount < LEVELS[1].enemyCount);
  assert.ok(LEVELS[1].enemyCount < LEVELS[2].enemyCount);
  assert.ok(LEVELS[0].spawnInterval > LEVELS[1].spawnInterval);
  assert.ok(LEVELS[1].spawnInterval > LEVELS[2].spawnInterval);
});
test('layoutToGrid 只产生合法地形值', () => {
  const g = layoutToGrid(LEVELS[0].layout, GRID);
  assert.equal(g.length, GRID * GRID);
  for (const v of g) assert.ok(v >= 0 && v <= 4);
});

/* ==================================================================
 * 2. 开局流程
 * ================================================================== */
console.log('\n[2] 开局流程');
test('菜单 → 开始 → levelIntro → playing', () => {
  const state = createGameState({});
  assert.equal(state.phase, PHASE.MENU);
  state.input = { ...emptyInput(), confirm: true };
  updateGame(state, STEP_SECONDS);
  assert.equal(state.phase, PHASE.LEVEL_INTRO);
  assert.equal(state.levelIndex, 0);
  // 倒计时结束进入 playing
  state.input = emptyInput();
  tick(state, Math.ceil(1.5 / STEP_SECONDS) + 2);
  assert.equal(state.phase, PHASE.PLAYING);
});
test('载入关卡后：玩家在出生点、基地就位、剩余敌人数正确', () => {
  const state = freshPlaying(0);
  assert.equal(state.enemiesRemaining, LEVELS[0].enemyCount);
  const p = state.players[0];
  const spawn = LEVELS[0].playerSpawns[0];
  assert.equal(Math.floor(p.x / TILE), spawn.col);
  assert.equal(Math.floor(p.y / TILE), spawn.row);
  assert.equal(state.base.col, LEVELS[0].base.col);
  assert.equal(state.base.alive, true);
});
test('单人时 P2 不启用', () => {
  const state = freshPlaying(0);
  assert.equal(state.players[1].enabled, false);
});

/* ==================================================================
 * 3. 玩家移动与碰撞
 * ================================================================== */
console.log('\n[3] 玩家移动与碰撞');
test('向右移动生效', () => {
  const state = freshPlaying(0);
  const p = state.players[0];
  const x0 = p.x;
  tick(state, 10, { p1: { up: false, down: false, left: false, right: true, fire: false } });
  assert.ok(p.x > x0, `x 未增加: ${x0} -> ${p.x}`);
  assert.equal(p.dir, 'right');
});
test('不能越出战场左边界', () => {
  const state = freshPlaying(0);
  const p = state.players[0];
  tick(state, 240, { p1: { up: false, down: false, left: true, right: false, fire: false } });
  // 坦克在格内居中，贴左边界时 x = 1（(16-14)/2），可视为“已贴住边界”
  assert.ok(p.x <= 1.5, `x 应贴住左边界，实际 ${p.x}`);
});
test('不能越出战场下边界', () => {
  const state = freshPlaying(0);
  const p = state.players[0];
  tick(state, 240, { p1: { up: false, down: true, left: false, right: false, fire: false } });
  assert.ok(p.y + p.h <= 208, `y+h 越界: ${p.y + p.h}`);
});
test('坦克不能穿越砖墙（第 1 关玩家出生点上方有砖墙通道）', () => {
  const state = freshPlaying(0);
  const p = state.players[0];
  // 手动在玩家正上方放一块砖
  const col = Math.floor((p.x + p.w / 2) / TILE);
  const row = Math.floor((p.y + p.h / 2) / TILE) - 1;
  setTile(state, col, row, TerrainType.BRICK);
  tick(state, 120, { p1: { up: true, down: false, left: false, right: false, fire: false } });
  const curRow = Math.floor((p.y + p.h / 2) / TILE);
  assert.ok(curRow >= row + 1, `坦克穿过了砖墙: 当前行 ${curRow}, 砖墙行 ${row}`);
});

/* ==================================================================
 * 4. 子弹与地形
 * ================================================================== */
console.log('\n[4] 子弹与地形判定');
test('子弹击毁砖墙', () => {
  const state = freshPlaying(0);
  state.players[0].invuln = 999;
  state.enemies = [];
  state.enemiesRemaining = 0;
  state.bullets = [];
  // 玩家正上方两格放砖，玩家向上射击
  const p = state.players[0];
  const col = Math.floor((p.x + p.w / 2) / TILE);
  const row = Math.floor((p.y + p.h / 2) / TILE) - 1;
  setTile(state, col, row, TerrainType.BRICK);
  const before = state.stats.bricksDestroyed;

  state.bullets.push(createBullet({
    x: col * TILE + 6, y: (row + 1) * TILE - 6, dir: 'up', ownerKind: 'player', ownerIndex: 0,
  }));
  tick(state, 40);
  assert.ok(state.stats.bricksDestroyed > before, '砖墙未被击毁');
  assert.equal(getTile(state, col, row), TerrainType.EMPTY, '砖墙未变空');
});
test('子弹不能击毁钢墙', () => {
  const state = freshPlaying(0);
  state.enemies = [];
  state.enemiesRemaining = 0;
  const p = state.players[0];
  const col = Math.floor((p.x + p.w / 2) / TILE);
  const row = Math.floor((p.y + p.h / 2) / TILE) - 1;
  setTile(state, col, row, TerrainType.STEEL);
  state.bullets.push(createBullet({
    x: col * TILE + 6, y: (row + 1) * TILE - 6, dir: 'up', ownerKind: 'player', ownerIndex: 0,
  }));
  tick(state, 40);
  assert.equal(getTile(state, col, row), TerrainType.STEEL, '钢墙被破坏了');
  assert.equal(state.bullets.length, 0, '子弹应已销毁');
});
test('子弹可穿过草丛', () => {
  const state = freshPlaying(0);
  state.enemies = [];
  state.enemiesRemaining = 0;
  const p = state.players[0];
  const col = Math.floor((p.x + p.w / 2) / TILE);
  const row = Math.floor((p.y + p.h / 2) / TILE) - 1;
  setTile(state, col, row, TerrainType.GRASS);
  const b = createBullet({
    x: col * TILE + 6, y: (row + 1) * TILE - 6, dir: 'up', ownerKind: 'player', ownerIndex: 0,
  });
  state.bullets.push(b);
  tick(state, 3);
  assert.ok(!b.dead, '子弹被草丛挡下了');
  assert.equal(getTile(state, col, row), TerrainType.GRASS, '草丛不应被摧毁');
});
test('高速子弹不穿墙（贴墙单步扫掠）', () => {
  const state = freshPlaying(0);
  state.enemies = [];
  state.enemiesRemaining = 99; // 保留剩余敌人，避免触发过关冻结逻辑
  // 在某一整行放满砖，用一颗子弹贴近并跨越
  for (let c = 0; c < GRID; c++) setTile(state, c, 6, TerrainType.BRICK);
  const b = createBullet({ x: 6 * TILE + 6, y: 7 * TILE + 6, dir: 'up', ownerKind: 'player', ownerIndex: 0 });
  state.bullets.push(b);
  tick(state, 30);
  assert.ok(!state.bullets.includes(b), '子弹应被砖墙拦下并销毁');
  // 至少打碎一块砖（说明命中生效且未越过整排）
  assert.ok(state.stats.bricksDestroyed >= 1);
});

/* ==================================================================
 * 5. 过关
 * ================================================================== */
console.log('\n[5] 过关流程');
test('击毁全部敌人 → levelClear', () => {
  const state = freshPlaying(0);
  state.players[0].invuln = 999;
  // 直接清空剩余敌人并进入判定
  state.enemiesRemaining = 0;
  state.enemies = [];
  tick(state, 2);
  assert.equal(state.phase, PHASE.LEVEL_CLEAR);
  assert.ok(state.score > 0, '过关应加分');
});
test('levelClear 后 confirm 进入下一关', () => {
  const state = freshPlaying(0);
  state.enemiesRemaining = 0;
  state.enemies = [];
  tick(state, 2);
  assert.equal(state.phase, PHASE.LEVEL_CLEAR);
  state.input = { ...emptyInput(), confirm: true };
  updateGame(state, STEP_SECONDS);
  assert.equal(state.levelIndex, 1);
  assert.equal(state.phase, PHASE.LEVEL_INTRO);
});

/* ==================================================================
 * 6. 基地被毁
 * ================================================================== */
console.log('\n[6] 基地被毁');
test('敌弹命中基地 → gameOver(base)', () => {
  const state = freshPlaying(0);
  state.players[0].invuln = 999;
  state.enemies = [];
  state.enemiesRemaining = 99;
  const b = state.base;
  // 从基地正上方发射敌弹
  state.bullets.push(createBullet({
    x: b.x + 6, y: b.y - 20, dir: 'down', ownerKind: 'enemy', ownerIndex: -1,
  }));
  tick(state, 30);
  assert.equal(state.phase, PHASE.GAME_OVER);
  assert.equal(state.reason, 'base');
  assert.equal(state.base.alive, false);
});

/* ==================================================================
 * 7. 命数
 * ================================================================== */
console.log('\n[7] 命数与复活');
test('玩家中弹扣命并在出生点复活且无敌', () => {
  const state = freshPlaying(0);
  state.players[0].invuln = 0;
  state.enemies = [];
  state.enemiesRemaining = 99;
  const p = state.players[0];
  const lives0 = state.lives;
  // 从正上方射来一颗敌弹
  state.bullets.push(createBullet({
    x: p.x + 5, y: p.y - 10, dir: 'down', ownerKind: 'enemy', ownerIndex: -1,
  }));
  tick(state, 20);
  assert.equal(state.lives, lives0 - 1, '命数未扣');
  assert.equal(p.alive, true, '应已复活');
  assert.ok(p.invuln > 0, '复活后应有无敌时间');
  const spawn = LEVELS[0].playerSpawns[0];
  assert.equal(Math.floor(p.x / TILE), spawn.col, '未回到出生点');
});
test('命数耗尽 → gameOver(lives)', () => {
  const state = freshPlaying(0);
  state.enemies = [];
  state.enemiesRemaining = 99;
  state.lives = 1;
  const p = state.players[0];
  p.invuln = 0;
  state.bullets.push(createBullet({
    x: p.x + 5, y: p.y - 10, dir: 'down', ownerKind: 'enemy', ownerIndex: -1,
  }));
  tick(state, 20);
  assert.equal(state.phase, PHASE.GAME_OVER);
  assert.equal(state.reason, 'lives');
  assert.equal(state.lives, 0);
});
test('无敌期间不扣命', () => {
  const state = freshPlaying(0);
  state.enemies = [];
  state.enemiesRemaining = 99;
  const p = state.players[0];
  p.invuln = 5;
  const lives0 = state.lives;
  state.bullets.push(createBullet({
    x: p.x + 5, y: p.y - 10, dir: 'down', ownerKind: 'enemy', ownerIndex: -1,
  }));
  tick(state, 10);
  assert.equal(state.lives, lives0, '无敌期不应扣命');
});

/* ==================================================================
 * 8. 全流程通关（快速模拟）
 * ================================================================== */
console.log('\n[8] 3 关通关');
test('依次通过 3 关 → allClear', () => {
  const state = createGameState({});
  startNewGame(state, false);
  for (let i = 0; i < 3; i++) {
    state.phase = PHASE.PLAYING;
    state.players[0].invuln = 999;
    state.enemiesRemaining = 0;
    state.enemies = [];
    state.input = emptyInput();
    updateGame(state, STEP_SECONDS);
    state.input = emptyInput();
    updateGame(state, STEP_SECONDS);
    if (i < 2) {
      assert.equal(state.phase, PHASE.LEVEL_CLEAR, `第 ${i + 1} 关未过关`);
      state.input = { ...emptyInput(), confirm: true };
      updateGame(state, STEP_SECONDS);
      assert.equal(state.levelIndex, i + 1);
    }
  }
  assert.equal(state.phase, PHASE.ALL_CLEAR, `最终应为 allClear，实际 ${state.phase}`);
});

/* ==================================================================
 * 9. 暂停与重开
 * ================================================================== */
console.log('\n[9] 暂停与重开');
test('暂停时逻辑冻结', () => {
  const state = freshPlaying(0);
  state.players[0].invuln = 999;
  state.input = { ...emptyInput(), pause: true };
  updateGame(state, STEP_SECONDS);
  assert.equal(state.phase, PHASE.PAUSED);
  const snapshot = JSON.stringify({
    t: state.time,
    px: state.players[0].x,
    py: state.players[0].y,
    bullets: state.bullets.length,
    enemies: state.enemies.length,
  });
  tick(state, 30);
  const after = JSON.stringify({
    t: state.time,
    px: state.players[0].x,
    py: state.players[0].y,
    bullets: state.bullets.length,
    enemies: state.enemies.length,
  });
  assert.equal(after, snapshot, '暂停期间状态发生了变化');
});
test('暂停后 Esc 恢复', () => {
  const state = freshPlaying(0);
  state.input = { ...emptyInput(), pause: true };
  updateGame(state, STEP_SECONDS);
  assert.equal(state.phase, PHASE.PAUSED);
  state.input = { ...emptyInput(), pause: true };
  updateGame(state, STEP_SECONDS);
  assert.equal(state.phase, PHASE.PLAYING);
});
test('R 重开本局：命数回满、分数清零、仍在当前关', () => {
  const state = freshPlaying(1);
  state.lives = 1;
  state.score = 5000;
  state.input = { ...emptyInput(), restart: true };
  updateGame(state, STEP_SECONDS);
  assert.equal(state.lives, INITIAL_LIVES);
  assert.equal(state.score, 0);
  assert.equal(state.levelIndex, 1);
  assert.equal(state.phase, PHASE.LEVEL_INTRO);
});

/* ==================================================================
 * 10. 长跑无泄漏
 * ================================================================== */
console.log('\n[10] 长跑稳定性');
test('3000 步后实体数量受限（无泄漏）', () => {
  const state = freshPlaying(2);
  state.players[0].invuln = 1e9; // 防止玩家死亡打断
  // 让玩家不停开火 + 随机移动，制造大量子弹/敌人
  let step = 0;
  for (; step < 3000; step++) {
    const t = step % 240;
    const inp = emptyInput();
    if (t < 60) inp.p1.up = true;
    else if (t < 120) inp.p1.right = true;
    else if (t < 180) inp.p1.down = true;
    else inp.p1.left = true;
    inp.p1.fire = step % 10 === 0;
    state.input = inp;
    updateGame(state, STEP_SECONDS);
    if (state.phase === PHASE.GAME_OVER || state.phase === PHASE.ALL_CLEAR) break;
    assert.ok(state.bullets.length <= 40, `子弹数量异常: ${state.bullets.length}`);
    assert.ok(state.enemies.length <= LEVELS[2].maxEnemiesOnField + 1, `敌人数量异常: ${state.enemies.length}`);
  }
  assert.ok(step > 0);
});
test('子弹数不超过玩家上限 × 玩家数', () => {
  const state = freshPlaying(0);
  state.players[0].invuln = 1e9;
  for (let i = 0; i < 600; i++) {
    state.input = pinput({ up: true, fire: true });
    updateGame(state, STEP_SECONDS);
    const playerBullets = state.bullets.filter((b) => b.ownerKind === 'player').length;
    assert.ok(playerBullets <= 2, `玩家子弹超限: ${playerBullets}`);
  }
});

/* ==================================================================
 * 11. 存档（内存 mock localStorage）
 * ================================================================== */
console.log('\n[11] 存档');
test('存档读写与合并', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const { loadSave, saveProgress, SAVE_KEY } = await import('../src/storage/save.js');
  assert.equal(loadSave().highScore, 0);
  saveProgress({ highScore: 800 });
  assert.equal(loadSave().highScore, 800);
  saveProgress({ highScore: 500 }); // 不回退
  assert.equal(loadSave().highScore, 800);
  saveProgress({ clearedLevel: 1 });
  saveProgress({ clearedLevel: 2 });
  saveProgress({ clearedLevel: 2 }); // 去重
  assert.deepEqual(loadSave().cleared, [1, 2]);
  const raw = JSON.parse(store.get(SAVE_KEY));
  assert.equal(raw.version, 1);
  delete globalThis.localStorage;
});
test('localStorage 不可用时不抛错', async () => {
  const { loadSave, saveProgress } = await import('../src/storage/save.js');
  const r = saveProgress({ highScore: 123 });
  assert.equal(r.highScore, 123);
  assert.ok(loadSave().highScore >= 123);
});

/* ==================================================================
 * 12. 主循环健壮性（单帧异常不停摆）
 * ================================================================== */
console.log('\n[12] 主循环健壮性');
test('update/render 抛异常时主循环仍继续排帧（不永久停摆）', async () => {
  const { createLoop } = await import('../src/game-core/loop.js');
  // 用可控的假 rAF：手动调用已排队的回调，模拟帧推进
  const queue = [];
  let scheduled = 0;
  let t = 1000;
  const fakeRaf = (cb) => { scheduled++; queue.push(cb); return scheduled; };
  let updates = 0;
  let renders = 0;
  const loop = createLoop({
    update() { updates++; if (updates === 3) throw new Error('boom-update'); },
    render() { renders++; if (renders === 3) throw new Error('boom-render'); },
    raf: fakeRaf,
    caf: () => {},
    now: () => t,
  });
  loop.start();
  // 推进 6 帧：期间 update/render 各抛一次异常，但循环必须仍在调度
  for (let f = 0; f < 6; f++) {
    t += 16.7;
    const cb = queue.shift();
    assert.ok(cb, `第 ${f} 帧没有排队的回调：主循环已停摆`);
    cb();
  }
  assert.ok(scheduled >= 7, `应持续排帧，实际只排了 ${scheduled} 次`);
  assert.ok(updates > 3 && renders > 3, `update/render 未继续执行 (u=${updates}, r=${renders})`);
  // 单帧异常不应让 accum 无限累积（抛错后应被丢弃）
  loop.stop();
});
test('tickOnce 支持 skipInputSync 时保留注入的 state.input', async () => {
  const { createLoop } = await import('../src/game-core/loop.js');
  let seen = null;
  const loop = createLoop({
    update(dt, opts = {}) { seen = opts; },
    render() {},
    raf: null,
    caf: () => {},
  });
  loop.tickOnce(1 / 60, { skipInputSync: true });
  assert.equal(seen.skipInputSync, true);
});
test('loop 在无 rAF 环境下 start 不抛错', async () => {
  const { createLoop } = await import('../src/game-core/loop.js');
  const loop = createLoop({ update() {}, render() {}, raf: null, caf: null, now: () => 0 });
  loop.start();
  assert.equal(loop.isRunning, true);
  loop.stop();
  assert.equal(loop.isRunning, false);
});

/* ==================================================================
 * 汇总
 * ================================================================== */
console.log('\n----------------------------------------');
if (failures.length === 0) {
  console.log(`SMOKE OK  (${passed} tests passed)`);
  process.exit(0);
} else {
  console.log(`SMOKE FAILED  (${passed} passed, ${failures.length} failed)`);
  for (const f of failures) console.log(` - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
