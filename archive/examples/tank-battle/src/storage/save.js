/**
 * 本地存档（localStorage）
 * ------------------------------------------------------------------
 * 只保存两项：最高分、已通关关卡号。键名固定 'tank-battle:v1'。
 * 规则：
 *  - 读写全部 try/catch；隐私模式/配额满/JSON 损坏 → 降级为内存值，绝不抛错。
 *  - 已通关进度只增不减。
 */

export const SAVE_KEY = 'tank-battle:v1';
export const SAVE_VERSION = 1;

/** 默认存档 */
function defaultSave() {
  return { version: SAVE_VERSION, highScore: 0, cleared: [] };
}

/** 安全获取 localStorage（可能不存在或被禁用） */
function getStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 内存中的降级存档 */
let memorySave = defaultSave();

/**
 * 读取存档
 * @returns {{version:number, highScore:number, cleared:number[]}}
 */
export function loadSave() {
  const storage = getStorage();
  if (!storage) return { ...memorySave, cleared: [...memorySave.cleared] };
  try {
    const raw = storage.getItem(SAVE_KEY);
    if (!raw) return defaultSave();
    const data = JSON.parse(raw);
    return normalize(data);
  } catch {
    return defaultSave();
  }
}

/**
 * 写入存档（合并式）
 * @param {object} patch
 * @param {number} [patch.highScore] 取 max
 * @param {number} [patch.clearedLevel] 追加通关关卡号
 */
export function saveProgress(patch = {}) {
  const cur = loadSave();
  const next = {
    version: SAVE_VERSION,
    highScore: Math.max(cur.highScore | 0, patch.highScore | 0),
    cleared: [...cur.cleared],
  };
  if (Number.isInteger(patch.clearedLevel) && !next.cleared.includes(patch.clearedLevel)) {
    next.cleared.push(patch.clearedLevel);
    next.cleared.sort((a, b) => a - b);
  }

  const storage = getStorage();
  if (!storage) {
    memorySave = next;
    return next;
  }
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(next));
  } catch {
    memorySave = next; // 写失败（配额/隐私模式）→ 降级内存
  }
  return next;
}

/** 清空存档（调试用，不在游戏流程中调用） */
export function clearSave() {
  memorySave = defaultSave();
  const storage = getStorage();
  if (!storage) return;
  try { storage.removeItem(SAVE_KEY); } catch { /* 忽略 */ }
}

/** 校验并规范化外部数据 */
function normalize(data) {
  if (!data || typeof data !== 'object') return defaultSave();
  const highScore = Number.isFinite(data.highScore) && data.highScore >= 0 ? Math.floor(data.highScore) : 0;
  const cleared = Array.isArray(data.cleared)
    ? data.cleared.filter((n) => Number.isInteger(n) && n >= 1 && n <= 3)
    : [];
  return { version: SAVE_VERSION, highScore, cleared: [...new Set(cleared)].sort((a, b) => a - b) };
}
