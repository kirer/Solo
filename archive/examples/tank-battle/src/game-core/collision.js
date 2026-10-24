/**
 * 碰撞判定工具
 * ------------------------------------------------------------------
 * 设计规则（对应 docs/architecture.md 第 6 节）：
 *  C1/C2/C3/C4 坦克移动：分轴判定（先 x 后 y），任一轴被阻挡则该轴回退，
 *                另一轴仍生效 → 贴墙滑行手感。
 *  C5 子弹 vs 地形：扫掠判定。子弹 220px/s，单步位移 ~3.67px，
 *                沿路径按 1px 采样，确保不会"跳过"整格墙。
 *  C6/C7 子弹 vs 坦克/基地：同样使用扫掠路径上的采样点判定。
 *  C9 出膛点：若车头格子是实心，直接不发射（防卡墙穿出）。
 */

import { TILE, FIELD_W, FIELD_H, BULLET_SIZE, DIR_VEC } from './constants.js';
import { isRectBlocked, getTile, cellsOfAABB, allTanks } from './world.js';
import { TerrainType, isSolidTile } from '../entities/terrain.js';
import { createBullet } from '../entities/bullet.js';

/** 构造 AABB */
export function aabb(x, y, w, h) {
  return { x, y, w, h };
}

/** 两矩形是否相交（用于子弹 vs 坦克/基地） */
export function overlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x
      && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * 坦克分轴移动（C1~C4）
 * @param {object} state
 * @param {object} tank
 * @param {number} dx 本步 x 位移（px）
 * @param {number} dy 本步 y 位移（px）
 * @returns {{movedX:boolean, movedY:boolean, blocked:boolean}}
 */
export function moveTank(state, tank, dx, dy) {
  let movedX = false;
  let movedY = false;
  let blocked = false;

  // --- X 轴 ---
  if (dx !== 0) {
    const nx = tank.x + dx;
    if (!isRectBlocked(state, aabb(nx, tank.y, tank.w, tank.h), { ignoreTank: tank })) {
      tank.x = nx;
      movedX = true;
    } else {
      blocked = true;
      // 贴墙矫正：逐 px 逼近，消除"停在离墙 1~2px"的视觉缝隙
      tank.x = stepAxis(state, tank, 'x', Math.sign(dx));
    }
  }

  // --- Y 轴 ---
  if (dy !== 0) {
    const ny = tank.y + dy;
    if (!isRectBlocked(state, aabb(tank.x, ny, tank.w, tank.h), { ignoreTank: tank })) {
      tank.y = ny;
      movedY = true;
    } else {
      blocked = true;
      tank.y = stepAxis(state, tank, 'y', Math.sign(dy));
    }
  }

  return { movedX, movedY, blocked };
}

/**
 * 沿单轴按 1px 步进贴近障碍（最多 1 格），返回该轴新坐标。
 * 目的：防止坦克停在离墙 1~2px 处，出现视觉缝隙与"半格"错位。
 */
function stepAxis(state, tank, axis, sign) {
  const limit = Math.ceil(Math.abs(TILE));
  let pos = tank[axis];
  for (let i = 0; i < limit; i++) {
    const next = pos + sign;
    const r = axis === 'x'
      ? aabb(next, tank.y, tank.w, tank.h)
      : aabb(tank.x, next, tank.w, tank.h);
    if (isRectBlocked(state, r, { ignoreTank: tank })) break;
    pos = next;
  }
  return pos;
}

/**
 * 子弹扫掠路径：返回从 prev 位置到当前位路径上的采样矩形序列
 * 采样步长 1px，保证覆盖所有经过的格。
 * @param {object} bullet
 * @param {number} nx 新 x
 * @param {number} ny 新 y
 * @returns {Array<{x:number,y:number,w:number,h:number}>}
 */
export function sweepRects(prevX, prevY, nx, ny, w, h) {
  const dx = nx - prevX;
  const dy = ny - prevY;
  const dist = Math.max(Math.abs(dx), Math.abs(dy));
  const steps = Math.max(1, Math.ceil(dist)); // 每 1px 一个采样点
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    out.push(aabb(prevX + dx * t, prevY + dy * t, w, h));
  }
  return out;
}

/** 扫掠路径上覆盖的所有格（去重） */
export function sweepCells(prevX, prevY, nx, ny, w, h) {
  const seen = new Set();
  const out = [];
  for (const r of sweepRects(prevX, prevY, nx, ny, w, h)) {
    for (const c of cellsOfAABB(r)) {
      const key = c.row * 1000 + c.col;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}

/**
 * 计算子弹出膛位置（车头中心）
 * 规则 C9：若出膛点所在格是实心/基地，返回 null 表示不发射。
 * @param {object} state
 * @param {object} tank
 * @returns {{x:number,y:number,dir:string}|null}
 */
export function muzzlePosition(state, tank) {
  const v = DIR_VEC[tank.dir];
  const cx = tank.x + tank.w / 2;
  const cy = tank.y + tank.h / 2;
  // 从车体中心沿朝向推到车体边缘外一点
  const half = tank.w / 2 + 1;
  let x = cx + v.x * half - BULLET_SIZE / 2;
  let y = cy + v.y * half - BULLET_SIZE / 2;

  // 出膛格判定
  const col = Math.floor((x + BULLET_SIZE / 2) / TILE);
  const row = Math.floor((y + BULLET_SIZE / 2) / TILE);
  const t = getTile(state, col, row);
  if (isSolidTile(t)) return null;
  if (state.base.alive && state.base.col === col && state.base.row === row) return null;
  // 出膛点越界也不发射
  if (x < 0 || y < 0 || x + BULLET_SIZE > FIELD_W || y + BULLET_SIZE > FIELD_H) return null;

  return { x, y, dir: tank.dir };
}

/**
 * 为坦克生成一颗子弹并计入 bulletsInAir
 * @returns {object|null} Bullet
 */
export function spawnBulletFor(state, tank) {
  const m = muzzlePosition(state, tank);
  if (!m) return null;
  const b = createBullet({
    x: m.x,
    y: m.y,
    dir: m.dir,
    ownerKind: tank.kind,
    ownerIndex: tank.ownerIndex,
  });
  // 敌人子弹按个体归属计数（限制每辆敌坦同屏 1 发）
  b.ownerTankId = tank.id;
  state.bullets.push(b);
  tank.bulletsInAir++;
  return b;
}

/**
 * 子弹是否命中任何坦克（C6），返回命中的坦克或 null
 * 规则：己方子弹不伤己方玩家（不误伤自己与队友）；敌人子弹命中玩家。
 */
export function hitTankAt(state, rect, bullet) {
  for (const t of allTanks(state)) {
    if (!t.alive) continue;
    if (!overlap(rect, t)) continue;
    // 玩家子弹不伤玩家（含自己与队友）
    if (bullet.ownerKind === 'player' && t.kind === 'player') continue;
    // 敌人子弹不伤敌人
    if (bullet.ownerKind === 'enemy' && t.kind === 'enemy') continue;
    return t;
  }
  return null;
}

/** 子弹是否命中基地（C7） */
export function hitBaseAt(state, rect) {
  const b = state.base;
  if (!b.alive) return false;
  return overlap(rect, { x: b.x, y: b.y, w: b.w, h: b.h });
}

/** 帧末清理：移除 dead 子弹，并复位坦克在空子弹计数 */
export function cleanupBullets(state) {
  if (state.bullets.some((b) => b.dead)) {
    // 释放 bulletsInAir 计数
    for (const b of state.bullets) {
      if (!b.dead) continue;
      const owner = findBulletOwner(state, b);
      if (owner && owner.bulletsInAir > 0) owner.bulletsInAir--;
    }
    state.bullets = state.bullets.filter((b) => !b.dead);
  }
}

/** 找回子弹归属坦克 */
function findBulletOwner(state, bullet) {
  if (bullet.ownerKind === 'player') {
    const p = state.players[bullet.ownerIndex];
    return p && p.enabled !== false && p.alive ? p : null;
  }
  return null; // 敌人子弹按敌人个体计数，见 rules.updateBullets
}

export { TerrainType, isSolidTile };
