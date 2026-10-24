/**
 * 键盘输入层
 * ------------------------------------------------------------------
 * 关键规则：
 * 1. 使用 event.code（物理键位）而非 event.key，避免输入法/大小写/布局影响。
 * 2. 方向键与空格必须 preventDefault，否则页面会滚动，游戏无法操作。
 * 3. 双人同屏：P1 与 P2 的按键集合完全分离，互不串键。
 * 4. 提供两种读取方式：
 *    - isDown(code)：持续按下（移动）
 *    - pressed(code)：边沿触发（暂停/重开/确认），消费一次即清除
 */

/** 键位映射表（全局唯一来源，文档 docs/architecture.md 第 8 节） */
export const KEYMAP = {
  // P1
  p1: {
    up: ['ArrowUp'],
    down: ['ArrowDown'],
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    fire: ['Space', 'KeyJ'],
  },
  // P2（与 P1 无任何重叠，避免双人串键）
  p2: {
    up: ['KeyW'],
    down: ['KeyS'],
    left: ['KeyA'],
    right: ['KeyD'],
    fire: ['KeyF'],
  },
  // 全局
  global: {
    pause: ['Escape'],
    restart: ['KeyR'],
    confirm: ['Enter', 'Space'],
  },
};

/** 需要阻止浏览器默认行为的按键（滚动 / 快捷键） */
const PREVENT_DEFAULT = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Escape',
]);

/**
 * 创建键盘输入控制器
 * @param {Window|EventTarget} target 事件源（浏览器为 window）
 * @returns {{ isDown(code:string):boolean, pressed(code:string):boolean,
 *             snapshot():object, destroy():void, _down:Set<string> }}
 */
export function createKeyboardInput(target) {
  /** 当前按下的物理键码集合 */
  const down = new Set();
  /** 本帧新按下、尚未被消费的键码（边沿触发队列） */
  const edges = new Set();

  function onKeyDown(e) {
    if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
    // 屏蔽长按产生的重复事件，保证 pressed() 只触发一次
    if (e.repeat) return;
    if (!down.has(e.code)) edges.add(e.code);
    down.add(e.code);
  }

  function onKeyUp(e) {
    if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
    down.delete(e.code);
  }

  /** 窗口失焦时清空按键，防止“按键卡住” */
  function onBlur() {
    down.clear();
    edges.clear();
  }

  target.addEventListener('keydown', onKeyDown, { passive: false });
  target.addEventListener('keyup', onKeyUp, { passive: false });
  target.addEventListener('blur', onBlur);

  /** 判断某物理键是否处于按下状态 */
  function isDown(code) {
    return down.has(code);
  }

  /** 边沿触发：该键本帧刚按下则返回 true，并消费掉（只触发一次） */
  function pressed(code) {
    if (edges.has(code)) {
      edges.delete(code);
      return true;
    }
    return false;
  }

  /** 组内任意键按下（持续） */
  function anyDown(codes) {
    for (const c of codes) if (down.has(c)) return true;
    return false;
  }

  /** 组内任意键本帧被按下（边沿，消费） */
  function anyPressed(codes) {
    let hit = false;
    for (const c of codes) {
      if (edges.has(c)) {
        edges.delete(c);
        hit = true;
      }
    }
    return hit;
  }

  /**
   * 生成本步的输入快照（纯数据，game-core 只吃这个对象）
   * @returns {{p1:object, p2:object, pause:boolean, restart:boolean, confirm:boolean}}
   */
  function snapshot() {
    const player = (map) => ({
      up: anyDown(map.up),
      down: anyDown(map.down),
      left: anyDown(map.left),
      right: anyDown(map.right),
      fire: anyDown(map.fire),
    });
    return {
      p1: player(KEYMAP.p1),
      p2: player(KEYMAP.p2),
      // 全局键使用边沿触发，避免长按连续暂停/重开
      pause: anyPressed(KEYMAP.global.pause),
      restart: anyPressed(KEYMAP.global.restart),
      confirm: anyPressed(KEYMAP.global.confirm),
    };
  }

  /** 移除事件监听，防止内存泄漏 */
  function destroy() {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', onBlur);
    down.clear();
    edges.clear();
  }

  return { isDown, pressed, snapshot, destroy, _down: down };
}

/** 空输入快照：用于无头测试或暂停态 */
export function emptyInput() {
  const p = () => ({ up: false, down: false, left: false, right: false, fire: false });
  return { p1: p(), p2: p(), pause: false, restart: false, confirm: false };
}
