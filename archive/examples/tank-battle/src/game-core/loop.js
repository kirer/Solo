/**
 * 固定步长主循环
 * ------------------------------------------------------------------
 * requestAnimationFrame 驱动 + 累加器：
 *  - 逻辑每步固定 1/60s，与显示器刷新率无关 → 手感与碰撞稳定。
 *  - MAX_ACCUM 截断：切后台回来不会一次性补几百帧（防"螺旋死亡"）。
 *  - render 收到插值系数 (accum / step)，可用于平滑渲染（骨架未用）。
 *
 * 该模块不 import 任何 DOM 以外的东西，便于 Node 环境替换 rAF 做测试。
 */

import { STEP_SECONDS, MAX_ACCUM } from './constants.js';

/** 错误上报：默认打到 console.error，上限 20 条防刷屏 */
let errorCount = 0;
function reportError(err, where) {
  if (errorCount >= 20) return;
  errorCount++;
  if (typeof console !== 'undefined' && console.error) {
    console.error(`[tank-battle] 主循环 ${where} 异常:`, err);
  }
}

/**
 * @param {object} opts
 * @param {(dt:number)=>void} opts.update 逻辑更新
 * @param {(alpha:number)=>void} [opts.render] 渲染
 * @param {number} [opts.stepSeconds]
 * @param {number} [opts.maxAccum]
 * @param {object} [opts.raf] 自定义 requestAnimationFrame（测试注入）
 * @param {object} [opts.caf] 自定义 cancelAnimationFrame
 * @param {()=>number} [opts.now] 自定义时钟（测试注入）
 */
export function createLoop({
  update,
  render = () => {},
  stepSeconds = STEP_SECONDS,
  maxAccum = MAX_ACCUM,
  raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame.bind(globalThis) : null,
  caf = typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame.bind(globalThis) : null,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  let last = 0;
  let accum = 0;
  let running = false;
  let rafId = 0;
  let zeroRender = false; // 是否在无渲染时跳帧（供无头模式）

  function frame() {
    if (!running) return;
    // 【健壮性】先无条件排下一帧，确保即使本帧 update/render 抛异常，
    // 主循环也不会永久停摆（rAF 回调内的异常会中断后续调度）。
    rafId = raf ? raf(frame) : 0;

    const t = now();
    let delta = (t - last) / 1000;
    last = t;

    // 截断：一帧最多补 maxAccum 秒
    if (delta > maxAccum) delta = maxAccum;
    if (delta < 0) delta = 0;
    accum += delta;

    // 固定步长推进
    let steps = 0;
    while (accum >= stepSeconds) {
      try {
        update(stepSeconds);
      } catch (err) {
        // 单帧逻辑错误不致命：记录后丢弃剩余 accumulate，避免刷屏
        reportError(err, 'update');
        accum = 0;
        break;
      }
      accum -= stepSeconds;
      steps++;
      if (steps > 240) { accum = 0; break; } // 兜底保护
    }

    if (!zeroRender) {
      try {
        render(accum / stepSeconds);
      } catch (err) {
        reportError(err, 'render');
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = now();
      accum = 0;
      if (raf) rafId = raf(frame);
    },
    stop() {
      running = false;
      if (rafId && caf) caf(rafId);
      rafId = 0;
    },
    /** 手动推进一步（无头/测试用）。
     *  opts.skipInputSync 为 true 时，main.js 不会用键盘快照覆盖 state.input
     *  （用于测试里直接注入 state.input） */
    tickOnce(dt = stepSeconds, opts = {}) {
      update(dt, opts);
      return true;
    },
    /** 手动执行一次渲染（测试/调试用，会触发 render 内的持久化等副作用） */
    renderOnce(alpha = 0) {
      render(alpha);
      return true;
    },
    /** 关闭渲染回调（无头测试用） */
    disableRender() { zeroRender = true; },
    get isRunning() { return running; },
  };
}
