/**
 * 伪随机数封装
 * ------------------------------------------------------------------
 * 逻辑更新只通过注入的 rng 取随机，便于测试用固定序列复现。
 * 默认使用 Math.random；提供 createRng(seed) 用于确定性序列。
 */

/** 默认 rng：直接包装 Math.random */
export const defaultRng = {
  next: () => Math.random(),
  int: (n) => Math.floor(Math.random() * n),
  pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
};

/**
 * 可播种 rng（mulberry32），同种子同序列
 * @param {number} seed
 */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

/**
 * 固定序列 rng（测试用）：按序吐出给定值，耗尽后循环
 * @param {number[]} values 0..1 之间
 */
export function createSequenceRng(values) {
  if (!values || values.length === 0) return defaultRng;
  let i = 0;
  const next = () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}
