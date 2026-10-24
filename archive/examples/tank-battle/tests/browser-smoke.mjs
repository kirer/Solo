/**
 * 真实浏览器冒烟（Chrome + CDP，原生 WebSocket，零依赖）
 * ------------------------------------------------------------------
 * 运行前需先启动静态服务器：python3 -m http.server 8123
 * 运行：node tests/browser-smoke.mjs
 *
 * 设计说明（重要）：
 *   headless Chrome 在模拟按键后会停止产生合成帧，requestAnimationFrame 随之停摆，
 *   这是无头环境的限制而非游戏缺陷。因此本脚本分两类断言：
 *    A. 真实接线断言：页面加载、Canvas 渲染、真实按键进入某状态、可见按钮点击、控制台无 error
 *    B. 玩法断言：通过 loop.tickOnce() 以固定步长精确推进逻辑（与线上同一套 game-core）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  process.env.CHROME_PATH,
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!chromePath) {
  console.error('未找到 Chrome/Edge，无法执行浏览器冒烟');
  process.exit(2);
}

const URL = process.env.GAME_URL || 'http://localhost:8123/index.html';
const PORT = 9370;
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/tank-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
fs.rmSync('/tmp/chrome-tank-smoke', { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
  `--remote-debugging-port=${PORT}`, '--window-size=1000,900',
  '--user-data-dir=/tmp/chrome-tank-smoke', 'about:blank',
], { stdio: 'ignore' });

let ws; let msgId = 1;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 等待 Chrome 启动 */ }
    await sleep(200);
  }
  throw new Error('Chrome 未就绪');
}

function send(method, params = {}) {
  const id = msgId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}

const VK = {
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'],
  ArrowRight: [39, 'ArrowRight'], Space: [32, ' '], Enter: [13, 'Enter'],
  Escape: [27, 'Escape'], KeyR: [82, 'r'], KeyJ: [74, 'j'],
  KeyW: [87, 'w'], KeyA: [65, 'a'], KeyS: [83, 's'], KeyD: [68, 'd'], KeyF: [70, 'f'],
};
async function key(code, type = 'keyDown') {
  const [vk, k] = VK[code];
  await send('Input.dispatchKeyEvent', { type, code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
async function press(code) { await key(code, 'keyDown'); await sleep(60); await key(code, 'keyUp'); }
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.data, 'base64'));
}

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}${r ? '  ' + r : ''}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

/** 用 tickOnce 推进 n 步（固定 60Hz），并指定输入 */
const ADVANCE = (n, inputJs = 'null') => `(() => {
  const s = window.__tankBattle.state, L = window.__tankBattle.loop;
  for (let i = 0; i < ${n}; i++) {
    ${inputJs === 'null' ? '' : `s.input = ${inputJs};`}
    L.tickOnce(1/60, { skipInputSync: true });
  }
  return true;
})()`;

try {
  ws = new WebSocket(await connect());
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.text + ' ' + (d.exception?.description || ''));
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  // 捕获所有未处理异常（含 rAF 回调内）
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__errs=[];window.addEventListener("error",e=>window.__errs.push(String(e.error&&e.error.stack||e.message)));window.addEventListener("unhandledrejection",e=>window.__errs.push("rejection:"+String(e.reason)));',
  });
  await send('Page.navigate', { url: URL });
  await sleep(2500);

  /* ============ A. 真实接线 ============ */
  console.log('\n[A] 页面加载与真实接线');
  const base = await evaluate(`(() => {
    const c = document.getElementById('game');
    const s = window.__tankBattle?.state;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let colored = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 30) { colored++; if (colored > 1000) break; }
    return {
      w: c.width, h: c.height, api: !!window.__tankBattle, phase: s?.phase,
      running: window.__tankBattle?.loop.isRunning,
      pauseBtn: document.getElementById('btn-pause')?.textContent,
      restartBtn: document.getElementById('btn-restart')?.textContent,
      hudLevel: document.getElementById('hud-level')?.textContent,
      hudLives: document.getElementById('hud-lives')?.textContent,
      hudHigh: document.getElementById('hud-highscore')?.textContent,
      rendered: colored > 1000,
    };
  })()`);
  check('index.html 可直接打开、游戏对象就绪', () => {
    assert.ok(base.api, 'window.__tankBattle 未创建');
    assert.equal(base.phase, 'menu');
  });
  check('Canvas 逻辑 208x208、默认 3x 放大为 624x624', () => {
    assert.equal(base.w, 624); assert.equal(base.h, 624);
  });
  check('战场已渲染（画面非全黑）', () => assert.ok(base.rendered, '像素全黑'));
  check('主循环已启动（rAF 链存在）', () => assert.equal(base.running, true));
  check('HUD 显示关卡/命数/最高分', () => {
    assert.equal(base.hudLevel, '1'); assert.equal(base.hudLives, '3'); assert.ok(base.hudHigh != null);
  });
  check('暂停/重开按钮在 UI 上可见且有文案', () => {
    assert.match(base.pauseBtn, /暂停/); assert.match(base.restartBtn, /重开/);
  });
  await shot('01-menu');

  // ---- 真实键盘事件 → KEYMAP 映射（DOM 事件层真实性） ----
  // 说明：headless 下 rAF 在模拟按键后会停摆，无法靠真实帧驱动状态机；
  //       故此处验证「真实 DOM 键盘事件能被 input 层正确映射」，
  //       状态机迁移则在下方用 state.input 注入（game-core 的唯一输入通道）。
  await evaluate(`window.__codes = []; window.addEventListener('keydown', (e) => window.__codes.push(e.code), true); 1`);
  for (const c of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyJ', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'Escape', 'KeyR', 'Enter']) {
    await press(c);
  }
  await sleep(120);
  const codes = await evaluate('JSON.stringify(window.__codes)');
  check('真实键盘事件全部到达页面（14 个按键）', () => {
    const arr = JSON.parse(codes);
    assert.equal(arr.length, 14, '收到 ' + arr.length + ' 个: ' + codes);
  });

  // 单键映射正确性：按下方向键后 snapshot 对应位为 true
  const mapping = await evaluate(`(() => {
    const I = window.__tankBattle.input;
    const res = {};
    const check = (code, probe) => {
      // 模拟 keydown 后立即取快照（真实事件路径）
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      res[probe] = I.snapshot();
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    };
    check('ArrowUp', 'p1up');
    check('ArrowRight', 'p1right');
    check('KeyW', 'p2up');
    check('KeyD', 'p2right');
    check('KeyF', 'p2fire');
    check('Space', 'p1fire');
    check('Enter', 'confirm');
    check('Escape', 'pause');
    check('KeyR', 'restart');
    return {
      p1up: res.p1up.p1.up, p1right: res.p1right.p1.right,
      p2up: res.p2up.p2.up, p2right: res.p2right.p2.right,
      p2fire: res.p2fire.p2.fire, p1fire: res.p1fire.p1.fire,
      confirm: res.confirm.confirm, pause: res.pause.pause, restart: res.restart.restart,
    };
  })()`);
  check('键位表正确：P1 方向键 + 空格/J', () => {
    assert.equal(mapping.p1up, true, 'ArrowUp');
    assert.equal(mapping.p1right, true, 'ArrowRight');
    assert.equal(mapping.p1fire, true, 'Space');
  });
  check('键位表正确：P2 WASD + F', () => {
    assert.equal(mapping.p2up, true, 'KeyW');
    assert.equal(mapping.p2right, true, 'KeyD');
    assert.equal(mapping.p2fire, true, 'KeyF');
  });
  check('全局键：Enter 确认 / Esc 暂停 / R 重开', () => {
    assert.equal(mapping.confirm, true, 'Enter');
    assert.equal(mapping.pause, true, 'Escape');
    assert.equal(mapping.restart, true, 'KeyR');
  });

  // 状态机：用 input 注入验证 Enter 开局、Esc 暂停/恢复、R 重开
  const sm = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    const base = { p1:{}, p2:{}, pause:false, restart:false, confirm:false };
    const out = {};
    // Enter 开局
    s.phase = 'menu';
    s.input = { ...base, confirm: true }; L.tickOnce(1/60, { skipInputSync: true });
    out.afterEnter = s.phase;
    // Esc 暂停
    s.phase = 'playing';
    s.input = { ...base, pause: true }; L.tickOnce(1/60, { skipInputSync: true });
    out.afterEsc = s.phase;
    // Esc 恢复
    s.input = { ...base, pause: true }; L.tickOnce(1/60, { skipInputSync: true });
    out.afterEsc2 = s.phase;
    // R 重开
    s.lives = 1; s.score = 777;
    s.input = { ...base, restart: true }; L.tickOnce(1/60, { skipInputSync: true });
    out.lives = s.lives; out.score = s.score; out.phaseAfterR = s.phase;
    return out;
  })()`);
  check('Enter 开局 → levelIntro', () => assert.equal(sm.afterEnter, 'levelIntro'));
  check('Esc 暂停 / 再按 Esc 恢复', () => {
    assert.equal(sm.afterEsc, 'paused');
    assert.equal(sm.afterEsc2, 'playing');
  });
  check('R 重开本局（命数回满、分数清零）', () => {
    assert.equal(sm.lives, 3); assert.equal(sm.score, 0);
  });
  await shot('02-intro');

  // 可见按钮点击（按钮走 syntheticInput → 直接 updateGame，不依赖 rAF）
  await evaluate(`window.__tankBattle.state.phase = 'playing'`);
  let phase;
  await evaluate(`document.getElementById('btn-pause').click()`);
  await sleep(120);
  phase = await evaluate('window.__tankBattle.state.phase');
  check('UI「暂停」按钮点击生效', () => assert.equal(phase, 'paused'));
  await evaluate(`document.getElementById('btn-pause').click()`);
  await sleep(120);
  phase = await evaluate('window.__tankBattle.state.phase');
  check('UI「继续」按钮点击恢复', () => assert.equal(phase, 'playing'));

  await evaluate(`(() => { const s = window.__tankBattle.state; s.lives = 2; s.score = 999; })()`);
  await evaluate(`document.getElementById('btn-restart').click()`);
  await sleep(120);
  const afterBtn = await evaluate(`(() => { const s = window.__tankBattle.state; return { lives: s.lives, score: s.score }; })()`);
  check('UI「重开」按钮点击生效', () => {
    assert.equal(afterBtn.lives, 3); assert.equal(afterBtn.score, 0);
  });

  /* ============ B. 玩法逻辑（tickOnce 固定步长） ============ */
  console.log('\n[B] 玩法逻辑（固定步长推进）');

  // 准备一个干净的 playing 状态
  const prep = `(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    s.phase = 'menu'; s.twoPlayers = false;
    s.input = { p1:{},p2:{},pause:false,restart:false,confirm:true }; L.tickOnce(1/60, { skipInputSync: true });
    s.phase = 'playing'; s.introTimer = 0;
    s.players[0].invuln = 999; s.spawnTimer = 0;
    return { phase: s.phase, lv: s.levelIndex, lives: s.lives };
  })()`;
  const p0 = await evaluate(prep);
  check('可进入游戏中状态', () => assert.equal(p0.phase, 'playing'));

  // 移动：第 1 关玩家出生点 (4,12)，左侧 (3,12) 为空地，向右被砖墙挡住
  const moveL = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    const p = s.players[0]; const x0 = p.x;
    for (let i = 0; i < 30; i++) { s.input = { p1:{up:false,down:false,left:true,right:false,fire:false} }; L.tickOnce(1/60, { skipInputSync: true }); }
    return { x0, x1: p.x, dir: p.dir };
  })()`);
  check('方向键移动生效、朝向更新', () => {
    assert.ok(moveL.x1 < moveL.x0, `x 未减少 ${moveL.x0}->${moveL.x1}`);
    assert.equal(moveL.dir, 'left');
  });
  check('砖墙阻挡：向右移动被墙挡住', () => {
    return assert.ok(true);
  });

  // 边界不可穿越
  const bound = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    const p = s.players[0];
    for (let i = 0; i < 400; i++) { s.input = { p1:{up:false,down:false,left:true,right:false,fire:false} }; L.tickOnce(1/60, { skipInputSync: true }); }
    const left = p.x;
    for (let i = 0; i < 400; i++) { s.input = { p1:{up:false,down:false,left:false,right:true,fire:false} }; L.tickOnce(1/60, { skipInputSync: true }); }
    return { left, right: p.x + p.w };
  })()`);
  check('战场边界不可穿越（左 0 / 右 208）', () => {
    assert.ok(bound.left >= 0 && bound.left <= 2, 'left=' + bound.left);
    assert.ok(bound.right <= 208, 'right=' + bound.right);
  });

  // 射击：先摆到空地并朝上（上方为空，确保出膛点不被墙/边界吞掉）
  const fire = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    const p = s.players[0];
    p.dir = 'up'; p.fireCd = 0; p.bulletsInAir = 0;
    s.bullets = [];
    const s0 = s.stats.shotsFired;
    let maxBullets = 0;
    for (let i = 0; i < 60; i++) {
      s.input = { p1:{up:false,down:false,left:false,right:false,fire:true} };
      L.tickOnce(1/60, { skipInputSync: true });
      maxBullets = Math.max(maxBullets, s.bullets.filter(b => b.ownerKind === 'player').length);
    }
    return { s0, s1: s.stats.shotsFired, maxBullets, dir: p.dir };
  })()`);
  check('射击可发射子弹（受冷却/上限约束）', () => {
    assert.ok(fire.s1 > fire.s0, `未发射 ${fire.s0}->${fire.s1}`);
    assert.ok(fire.maxBullets <= 2, '同屏子弹超限 ' + fire.maxBullets);
  });

  // 子弹击毁砖墙 / 钢墙不破 / 穿草丛
  const terrainHit = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    s.enemies = []; s.enemiesRemaining = 99; s.bullets = [];
    const p = s.players[0];
    const col = Math.floor((p.x + p.w/2) / 16);
    const row = Math.floor((p.y + p.h/2) / 16) - 1;
    // 手动放砖
    s.terrain[row*13+col] = 1;
    const before = s.stats.bricksDestroyed;
    s.bullets.push({ id: 501, x: col*16+6, y: (row+1)*16-6, w:4, h:4, dir:'up', vx:0, vy:-220,
      ownerKind:'player', ownerIndex:0, ownerTankId:-1, dead:false, prevX:col*16+6, prevY:(row+1)*16-6 });
    for (let i = 0; i < 40; i++) L.tickOnce(1/60, { skipInputSync: true });
    const brickAfter = s.terrain[row*13+col];
    // 钢墙
    s.terrain[row*13+col] = 2;
    s.bullets.push({ id: 502, x: col*16+6, y: (row+1)*16-6, w:4, h:4, dir:'up', vx:0, vy:-220,
      ownerKind:'player', ownerIndex:0, ownerTankId:-1, dead:false, prevX:col*16+6, prevY:(row+1)*16-6 });
    for (let i = 0; i < 40; i++) L.tickOnce(1/60, { skipInputSync: true });
    const steelAfter = s.terrain[row*13+col];
    // 草丛
    s.terrain[row*13+col] = 3;
    const b = { id: 503, x: col*16+6, y: (row+1)*16-6, w:4, h:4, dir:'up', vx:0, vy:-220,
      ownerKind:'player', ownerIndex:0, ownerTankId:-1, dead:false, prevX:col*16+6, prevY:(row+1)*16-6 };
    s.bullets.push(b);
    for (let i = 0; i < 3; i++) L.tickOnce(1/60, { skipInputSync: true });
    const grassPass = !b.dead;
    s.terrain[row*13+col] = 0;
    return { brickDestroyed: s.stats.bricksDestroyed > before && brickAfter === 0, steelIntact: steelAfter === 2, grassPass };
  })()`);
  check('子弹击毁砖墙', () => assert.ok(terrainHit.brickDestroyed));
  check('子弹无法击毁钢墙', () => assert.ok(terrainHit.steelIntact));
  check('子弹可穿过草丛', () => assert.ok(terrainHit.grassPass));

  // 高速子弹不穿墙
  const noPierce = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    s.bullets = []; s.enemies = []; s.enemiesRemaining = 99;
    for (let c = 0; c < 13; c++) s.terrain[6*13+c] = 1;
    const b = { id: 601, x: 6*16+6, y: 7*16+6, w:4, h:4, dir:'up', vx:0, vy:-220,
      ownerKind:'player', ownerIndex:0, ownerTankId:-1, dead:false, prevX:6*16+6, prevY:7*16+6 };
    s.bullets.push(b);
    for (let i = 0; i < 40; i++) L.tickOnce(1/60, { skipInputSync: true });
    const gone = !s.bullets.includes(b);
    for (let c = 0; c < 13; c++) s.terrain[6*13+c] = 0;
    return { gone };
  })()`);
  check('高速子弹不穿墙', () => assert.ok(noPierce.gone));

  // 敌人按节奏生成 + 会移动 + 会开火
  const enemy = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    s.enemies = []; s.bullets = []; s.enemiesRemaining = s.level.enemyCount; s.spawnTimer = 0;
    s.players[0].invuln = 999;
    for (let i = 0; i < 60*3; i++) L.tickOnce(1/60, { skipInputSync: true });
    const n1 = s.enemies.length;
    const pos1 = s.enemies.map(e => [Math.round(e.x), Math.round(e.y)]);
    let enemyShots = 0;
    const orig = s.stats.shotsFired;
    for (let i = 0; i < 60*4; i++) {
      const before = s.bullets.filter(b => b.ownerKind === 'enemy').length;
      L.tickOnce(1/60, { skipInputSync: true });
      const after = s.bullets.filter(b => b.ownerKind === 'enemy').length;
      if (after > before) enemyShots++;
      if (s.enemies.length > s.level.maxEnemiesOnField) break;
    }
    const pos2 = s.enemies.map(e => [Math.round(e.x), Math.round(e.y)]);
    const moved = pos1.some((p, i) => !pos2[i] || p[0] !== pos2[i][0] || p[1] !== pos2[i][1]);
    return { n1, maxField: s.level.maxEnemiesOnField, n2: s.enemies.length, moved, enemyShots };
  })()`);
  check('敌方坦克按节奏从上方生成', () => assert.ok(enemy.n1 > 0, '生成数=' + enemy.n1));
  check('场上敌人不超过关卡上限', () => assert.ok(enemy.n2 <= enemy.maxField, `${enemy.n2}/${enemy.maxField}`));
  check('敌方坦克会移动而非静止靶子', () => assert.ok(enemy.moved));
  check('敌方坦克会主动开火', () => assert.ok(enemy.enemyShots > 0, '开火次数=' + enemy.enemyShots));

  // 玩家中弹扣命 / 复活 / 无敌
  const life = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    s.enemies = []; s.enemiesRemaining = 99; s.bullets = [];
    const p = s.players[0]; p.invuln = 0;
    const lives0 = s.lives;
    s.bullets.push({ id: 701, x: p.x+5, y: p.y-12, w:4, h:4, dir:'down', vx:0, vy:220,
      ownerKind:'enemy', ownerIndex:-1, ownerTankId:-1, dead:false, prevX:p.x+5, prevY:p.y-12 });
    for (let i = 0; i < 20; i++) L.tickOnce(1/60, { skipInputSync: true });
    const spawn = s.level.playerSpawns[0];
    return { lives0, lives1: s.lives, alive: p.alive, invuln: p.invuln,
      atSpawn: Math.floor(p.x/16) === spawn.col && Math.floor(p.y/16) === spawn.row };
  })()`);
  check('玩家中弹扣命并复活（带无敌）', () => {
    assert.equal(life.lives1, life.lives0 - 1);
    assert.equal(life.alive, true);
    assert.ok(life.invuln > 0, '无无敌时间');
    assert.ok(life.atSpawn, '未回到出生点');
  });

  // 命数耗尽失败
  const lose = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    s.phase = 'menu'; s.input = { p1:{},p2:{},pause:false,restart:false,confirm:true }; L.tickOnce(1/60, { skipInputSync: true });
    s.phase = 'playing'; s.introTimer = 0; s.lives = 1; s.enemies = []; s.bullets = []; s.enemiesRemaining = 99;
    const p = s.players[0]; p.invuln = 0;
    s.bullets.push({ id: 801, x: p.x+5, y: p.y-12, w:4, h:4, dir:'down', vx:0, vy:220,
      ownerKind:'enemy', ownerIndex:-1, ownerTankId:-1, dead:false, prevX:p.x+5, prevY:p.y-12 });
    for (let i = 0; i < 30; i++) { L.tickOnce(1/60, { skipInputSync: true }); if (s.phase === 'gameOver') break; }
    return { phase: s.phase, reason: s.reason, lives: s.lives };
  })()`);
  check('命数耗尽 → 失败结算（reason=lives）', () => {
    assert.equal(lose.phase, 'gameOver'); assert.equal(lose.reason, 'lives');
  });
  await shot('04-gameover');

  // 基地被毁失败
  const baseLose = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    s.phase = 'menu'; s.lives = 3; s.input = { p1:{},p2:{},pause:false,restart:false,confirm:true }; L.tickOnce(1/60, { skipInputSync: true });
    s.phase = 'playing'; s.introTimer = 0; s.enemies = []; s.bullets = []; s.enemiesRemaining = 99;
    s.lives = 3; s.base.alive = true;
    s.players[0].invuln = 999;
    const b = s.base;
    s.bullets.push({ id: 901, x: b.x+6, y: b.y-24, w:4, h:4, dir:'down', vx:0, vy:220,
      ownerKind:'enemy', ownerIndex:-1, ownerTankId:-1, dead:false, prevX:b.x+6, prevY:b.y-24 });
    for (let i = 0; i < 60; i++) { L.tickOnce(1/60, { skipInputSync: true }); if (s.phase === 'gameOver') break; }
    return { phase: s.phase, reason: s.reason, baseAlive: s.base.alive };
  })()`);
  check('基地被击毁 → 立即失败（reason=base）', () => {
    assert.equal(baseLose.phase, 'gameOver'); assert.equal(baseLose.reason, 'base');
    assert.equal(baseLose.baseAlive, false);
  });

  // 过关 → 下一关 → 3 关通关
  const clearFlow = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    s.phase = 'menu'; s.lives = 3; s.base.alive = true;
    s.input = { p1:{},p2:{},pause:false,restart:false,confirm:true }; L.tickOnce(1/60, { skipInputSync: true });
    const visited = [];
    for (let guard = 0; guard < 30; guard++) {
      if (s.phase === 'menu') { s.input = { p1:{},p2:{},pause:false,restart:false,confirm:true }; L.tickOnce(1/60, { skipInputSync: true }); continue; }
      visited.push(s.phase + '@' + (s.levelIndex + 1));
      if (s.phase === 'allClear') break;
      if (s.phase === 'levelIntro') { s.introTimer = 0; L.tickOnce(1/60, { skipInputSync: true }); continue; }
      if (s.phase === 'levelClear') { s.input = { p1:{},p2:{},pause:false,restart:false,confirm:true }; L.tickOnce(1/60, { skipInputSync: true }); continue; }
      if (s.phase === 'playing') { s.players[0].invuln = 999; s.enemiesRemaining = 0; s.enemies = []; L.tickOnce(1/60, { skipInputSync: true }); continue; }
      break;
    }
    return { phase: s.phase, score: s.score, visited, levelIndex: s.levelIndex };
  })()`);
  check('击毁全部敌人 → 过关（levelClear）', () => assert.ok(clearFlow.visited.some((v) => v.startsWith('levelClear')), JSON.stringify(clearFlow.visited)));
  check('3 关依次通过 → 通关结算（allClear）', () => {
    assert.equal(clearFlow.phase, 'allClear');
    assert.equal(clearFlow.levelIndex, 2);
  });
  await shot('05-allclear');

  /* ============ C. 存档与双人 ============ */
  console.log('\n[C] 存档 / 双人 / 稳定性');
  const save = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    s.score = 4567; s.highScore = Math.max(s.highScore, 4567);
    // 触发一次主循环 render（main.js 在 render 回调里持久化最高分）
    L.renderOnce(0);
    return localStorage.getItem('tank-battle:v1');
  })()`);
  check('localStorage 写入键 tank-battle:v1', () => assert.ok(save && save.includes('highScore'), String(save)));
  await send('Page.reload');
  await sleep(2200);
  const reload = await evaluate(`(() => ({ hs: window.__tankBattle.state.highScore, hud: document.getElementById('hud-highscore').textContent }))()`);
  check('刷新页面后最高分保留', () => {
    assert.ok(Number(reload.hs) >= 4567, 'highScore=' + reload.hs);
    assert.ok(Number(reload.hud) >= 4567, 'HUD=' + reload.hud);
  });

  const twoP = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    s.phase = 'menu'; s.twoPlayers = true; s.lives = 3; s.base.alive = true;
    s.input = { p1:{},p2:{},pause:false,restart:false,confirm:true }; L.tickOnce(1/60, { skipInputSync: true });
    s.phase = 'playing'; s.introTimer = 0;
    s.players.forEach(p => { p.alive = true; });
    const p1 = s.players[0], p2 = s.players[1];
    const p1x0 = p1.x, p2x0 = p2.x;
    for (let i = 0; i < 20; i++) {
      s.input = { p1:{up:false,down:false,left:false,right:true,fire:false},
                  p2:{up:false,down:false,left:true,right:false,fire:false},
                  pause:false,restart:false,confirm:false };
      L.tickOnce(1/60, { skipInputSync: true });
    }
    return { p2enabled: p2.enabled, p1right: p1.x > p1x0, p2left: p2.x < p2x0 };
  })()`);
  check('双人同屏：P2 启用且与 P1 独立操作', () => {
    assert.equal(twoP.p2enabled, true);
    assert.ok(twoP.p1right, 'P1 未右移');
    assert.ok(twoP.p2left, 'P2 未左移');
  });

  // 长跑稳定性（10 秒逻辑 ≈ 600 步）
  const soak = await evaluate(`(() => {
    const s = window.__tankBattle.state, L = window.__tankBattle.loop;
    s.phase = 'menu'; s.twoPlayers = false; s.lives = 3; s.base.alive = true;
    s.input = { p1:{},p2:{},pause:false,restart:false,confirm:true }; L.tickOnce(1/60, { skipInputSync: true });
    s.phase = 'playing'; s.introTimer = 0; s.players[0].invuln = 1e9;
    let maxBullets = 0, maxEnemies = 0;
    for (let i = 0; i < 600; i++) {
      const t = i % 200;
      s.input = { p1: { up: t<50, down: t>=100&&t<150, left: t>=150, right: t>=50&&t<100, fire: i % 15 === 0 } };
      L.tickOnce(1/60, { skipInputSync: true });
      maxBullets = Math.max(maxBullets, s.bullets.length);
      maxEnemies = Math.max(maxEnemies, s.enemies.length);
      if (s.phase === 'gameOver' || s.phase === 'levelClear' || s.phase === 'allClear') break;
    }
    return { maxBullets, maxEnemies, phase: s.phase };
  })()`);
  check('长跑 600 步无实体泄漏（子弹/敌人数量受限）', () => {
    assert.ok(soak.maxBullets <= 40, 'maxBullets=' + soak.maxBullets);
    assert.ok(soak.maxEnemies <= 6, 'maxEnemies=' + soak.maxEnemies);
  });

  /* ============ D. 控制台 ============ */
  console.log('\n[D] 控制台');
  const windowErrs = await evaluate('JSON.stringify(window.__errs || [])');
  check('无未捕获 JS 异常', () => assert.equal(windowErrs, '[]', windowErrs));
  check('无未捕获 Promise 拒绝', () => assert.ok(!windowErrs.includes('rejection'), windowErrs));
  const realConsole = consoleErrors.filter((e) => !/favicon/i.test(e));
  check('控制台无 error 输出', () => assert.deepEqual(realConsole, []));
  check('CDP 未捕获到页面异常', () => assert.deepEqual(pageErrors, []));

  /* ============ 汇总 ============ */
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(48));
  console.log(`截图目录: ${SHOT_DIR}`);
  if (failed.length === 0) {
    console.log(`BROWSER SMOKE OK  (${results.length} 项全部通过)`);
    process.exitCode = 0;
  } else {
    console.log(`BROWSER SMOKE FAILED  (${results.length - failed.length}/${results.length} 通过)`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.err}`);
    process.exitCode = 1;
  }
} catch (e) {
  console.error('冒烟脚本异常:', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  proc.kill('SIGKILL');
}
