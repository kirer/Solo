/**
 * 装配点（composition root）
 * ------------------------------------------------------------------
 * 唯一把 input / game-core / render / storage 接在一起的地方。
 * 单向数据流：input → state.input → updateGame(state) → renderer.draw(state)
 *
 * UI 交互：
 *  - HUD 上的「暂停」「重开」按钮与键盘 Esc / R 等效（需求：入口必须可见）。
 *  - 窗口尺寸变化 → canvas 整数倍重算。
 *  - 最高分从 localStorage 载入，结算/退出时写回。
 */

import { createGameState } from './game-core/state.js';
import { updateGame } from './game-core/rules.js';
import { createLoop } from './game-core/loop.js';
import { PHASE } from './game-core/constants.js';
import { createKeyboardInput } from './input/keys.js';
import { createRenderer } from './render/renderer.js';
import { loadSave, saveProgress } from './storage/save.js';

/** 把 state 同步到 DOM HUD 上（每帧后调用，低频文本更新） */
function syncHud(state, dom) {
  if (!dom) return;
  dom.level.textContent = String(state.levelIndex + 1);
  dom.lives.textContent = String(state.lives);
  dom.score.textContent = String(state.score);
  dom.highscore.textContent = String(state.highScore);
  const paused = state.phase === PHASE.PAUSED;
  if (dom.pauseBtn) {
    dom.pauseBtn.classList.toggle('active', paused);
    dom.pauseBtn.textContent = paused ? '继续 (Esc)' : '暂停 (Esc)';
  }
}

/**
 * 启动游戏
 * @param {HTMLCanvasElement} canvas
 * @returns {{loop:object, input:object, state:object}}
 */
export function bootstrap(canvas) {
  // ---- 存档 ----
  const save = loadSave();

  // ---- 状态 ----
  const state = createGameState({ highScore: save.highScore });

  // ---- 输入 ----
  const input = createKeyboardInput(window);

  // ---- 渲染 ----
  const renderer = createRenderer(canvas);
  renderer.resize();

  // ---- DOM HUD ----
  const dom = {
    level: document.getElementById('hud-level'),
    lives: document.getElementById('hud-lives'),
    score: document.getElementById('hud-score'),
    highscore: document.getElementById('hud-highscore'),
    pauseBtn: document.getElementById('btn-pause'),
    restartBtn: document.getElementById('btn-restart'),
  };

  /** 上一帧的 phase，用于检测结算迁移以落盘 */
  let lastPhase = state.phase;
  let savedHigh = state.highScore;

  // ---- UI 按钮：与键盘等效（通过合成一次“边沿按键”） ----
  function syntheticInput(kind) {
    const snap = {
      p1: { up: false, down: false, left: false, right: false, fire: false },
      p2: { up: false, down: false, left: false, right: false, fire: false },
      pause: kind === 'pause',
      restart: kind === 'restart',
      confirm: false,
    };
    state.input = snap;
    updateGame(state, 0);
  }

  if (dom.pauseBtn) dom.pauseBtn.addEventListener('click', () => syntheticInput('pause'));
  if (dom.restartBtn) dom.restartBtn.addEventListener('click', () => syntheticInput('restart'));

  // ---- 窗口自适应 ----
  let resizeRaf = 0;
  function onResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      renderer.resize();
    });
  }
  window.addEventListener('resize', onResize);
  if (dom.highscore) dom.highscore.textContent = String(state.highScore);

  // ---- 主循环 ----
  const loop = createLoop({
    update(dt, opts = {}) {
      // 输入快照每帧取一次（边沿键消费后即消失）。
      // 测试/回放时可传 skipInputSync 直接注入 state.input。
      if (!opts.skipInputSync) state.input = input.snapshot();
      updateGame(state, dt);
    },
    render() {
      renderer.draw(state);
      syncHud(state, dom);

      // 结算/过关时落盘最高分与通关进度
      if (state.phase !== lastPhase) {
        if (state.phase === PHASE.LEVEL_CLEAR || state.phase === PHASE.ALL_CLEAR) {
          saveProgress({ highScore: state.highScore, clearedLevel: state.levelIndex + 1 });
        } else if (state.phase === PHASE.GAME_OVER) {
          saveProgress({ highScore: state.highScore });
        }
        lastPhase = state.phase;
      } else if (state.highScore > savedHigh) {
        // 比分刷新时也持续持久化，避免关闭页面丢失
        savedHigh = state.highScore;
        saveProgress({ highScore: state.highScore });
      }
    },
  });

  loop.start();
  syncHud(state, dom);

  // 便于调试：暴露到全局（不影响逻辑）
  if (typeof window !== 'undefined') {
    window.__tankBattle = { state, loop, input, renderer, save };
  }

  return { loop, input, state, renderer };
}

// 页面就绪后自动启动
if (typeof document !== 'undefined') {
  const start = () => {
    const canvas = document.getElementById('game');
    if (canvas) bootstrap(canvas);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}
