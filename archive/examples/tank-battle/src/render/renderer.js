/**
 * Canvas 渲染器（只读 state，不修改任何逻辑数据）
 * ------------------------------------------------------------------
 * 坐标策略：全部按 208x208 逻辑像素绘制，通过 setTransform(scale,...) 整数放大，
 * imageSmoothingEnabled = false 保证像素锐利。
 *
 * 绘制顺序（关键）：
 *   背景 → 砖/钢/边界 → 基地 → 子弹 → 坦克 → 草丛覆盖层 → 界面层
 * 草丛放在坦克之后绘制，实现「草丛遮蔽坦克」的视觉效果（需求第 4 条）。
 *
 * 所有图形均为几何绘制（矩形/三角形/线条），零图片资源。
 */

import { COLORS } from './colors.js';
import {
  GRID, TILE, FIELD_W, FIELD_H, DIR_VEC, MIN_SCALE, MAX_SCALE,
} from '../game-core/constants.js';
import { TerrainType } from '../entities/terrain.js';
import { drawPhaseUi } from './hud.js';

/**
 * 创建渲染器
 * @param {HTMLCanvasElement} canvas
 */
export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('无法获取 Canvas 2D 上下文');
  ctx.imageSmoothingEnabled = false;

  let scale = 3;

  /** 根据可用尺寸计算整数倍缩放 */
  function computeScale(availW, availH) {
    const raw = Math.floor(Math.min(availW / FIELD_W, availH / FIELD_H));
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, raw || MIN_SCALE));
  }

  /** 自适应：按容器尺寸重算整数倍并设置 canvas 内部分辨率 */
  function resize(availW, availH) {
    const host = canvas.parentElement;
    // 容器尺寸不可靠时（display:none / 初始布局尚未完成 / 高度为 0）回退到窗口尺寸
    let w = availW;
    let h = availH;
    if (w == null || h == null) {
      const hostW = host ? host.clientWidth : 0;
      const hostH = host ? host.clientHeight : 0;
      const winW = typeof window !== 'undefined' ? window.innerWidth : 0;
      const winH = typeof window !== 'undefined' ? window.innerHeight : 0;
      w = w ?? (hostW > 40 ? hostW : (winW || FIELD_W * 3));
      h = h ?? (hostH > 40 ? hostH : (winH ? winH - 120 : FIELD_H * 3));
    }
    scale = computeScale(w - 12, h - 12);
    canvas.width = FIELD_W * scale;
    canvas.height = FIELD_H * scale;
    canvas.style.width = `${FIELD_W * scale}px`;
    canvas.style.height = `${FIELD_H * scale}px`;
    ctx.imageSmoothingEnabled = false;
    return scale;
  }

  /* ---------------- 地形 ---------------- */

  function drawBackground() {
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);
  }

  /** 砖墙：2x2 小砖块纹理 */
  function drawBrick(x, y) {
    ctx.fillStyle = COLORS.brick;
    ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = COLORS.brickDark;
    const half = TILE / 2;
    ctx.fillRect(x, y, half - 1, half - 1);
    ctx.fillRect(x + half, y + half, half - 1, half - 1);
    ctx.strokeStyle = COLORS.brickLine;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, half - 1, half - 1);
    ctx.strokeRect(x + half + 0.5, y + half + 0.5, half - 1, half - 1);
  }

  /** 钢墙：浅色块 + 高光边 */
  function drawSteel(x, y) {
    ctx.fillStyle = COLORS.steel;
    ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = COLORS.steelDark;
    ctx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
    ctx.fillStyle = COLORS.steelLight;
    ctx.fillRect(x + 3, y + 3, TILE - 6, 3);
    ctx.fillStyle = COLORS.steel;
    ctx.fillRect(x + 3, y + 7, TILE - 6, 3);
  }

  /** 边界：深色砖纹 */
  function drawBoundary(x, y) {
    ctx.fillStyle = COLORS.boundary;
    ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = COLORS.boundaryLight;
    ctx.fillRect(x, y, TILE, 2);
  }

  /** 草丛（基础层；覆盖层在坦克之后另画一次以实现遮蔽） */
  function drawGrass(x, y) {
    ctx.fillStyle = COLORS.grass;
    ctx.fillRect(x, y, TILE, TILE);
    ctx.strokeStyle = COLORS.grassDark;
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const yy = y + 3 + i * 5;
      ctx.beginPath();
      ctx.moveTo(x + 2, yy);
      ctx.lineTo(x + TILE - 2, yy);
      ctx.stroke();
    }
  }

  function drawTerrain(state, grassLayer) {
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const t = state.terrain[row * GRID + col];
        const x = col * TILE;
        const y = row * TILE;
        if (grassLayer) {
          if (t === TerrainType.GRASS) drawGrass(x, y);
          continue;
        }
        if (t === TerrainType.BRICK) drawBrick(x, y);
        else if (t === TerrainType.STEEL) drawSteel(x, y);
        else if (t === TerrainType.BOUNDARY) drawBoundary(x, y);
      }
    }
  }

  /* ---------------- 实体 ---------------- */

  /** 基地：鹰形/旗形简化几何 */
  function drawBase(state) {
    const b = state.base;
    const x = b.x;
    const y = b.y;
    if (!b.alive) {
      // 毁坏：灰色残骸
      ctx.fillStyle = COLORS.baseDead;
      ctx.fillRect(x + 2, y + TILE - 5, TILE - 4, 4);
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 4);
      ctx.lineTo(x + 8, y + 9);
      ctx.lineTo(x + 13, y + 4);
      ctx.closePath();
      ctx.fill();
      return;
    }
    // 底座
    ctx.fillStyle = COLORS.baseAliveDark;
    ctx.fillRect(x + 2, y + TILE - 5, TILE - 4, 3);
    // 三角旗/鹰身
    ctx.fillStyle = COLORS.baseAlive;
    ctx.beginPath();
    ctx.moveTo(x + TILE / 2, y + 2);
    ctx.lineTo(x + TILE - 3, y + TILE - 6);
    ctx.lineTo(x + 3, y + TILE - 6);
    ctx.closePath();
    ctx.fill();
    // 中央徽记
    ctx.fillStyle = COLORS.baseAliveDark;
    ctx.fillRect(x + TILE / 2 - 1, y + 6, 2, 5);
  }

  /** 子弹：小方块（敌方偏红，玩家偏黄） */
  function drawBullet(b) {
    ctx.fillStyle = b.ownerKind === 'enemy' ? COLORS.bulletEnemy : COLORS.bullet;
    ctx.fillRect(Math.round(b.x), Math.round(b.y), b.w, b.h);
  }

  /** 坦克：车身 + 履带 + 炮管 + 朝向标记 */
  function drawTank(t) {
    const { x, y, w, h, dir } = t;
    const isPlayer = t.kind === 'player';
    let body;
    let dark;
    let track;
    if (isPlayer) {
      if (t.ownerIndex === 1) { body = COLORS.player2; dark = COLORS.player2Dark; track = COLORS.player2Track; }
      else { body = COLORS.player1; dark = COLORS.player1Dark; track = COLORS.player1Track; }
    } else {
      body = COLORS.enemy; dark = COLORS.enemyDark; track = COLORS.enemyTrack;
    }

    // 复活无敌：闪烁（简单闪烁，纯表现）
    const blink = t.invuln > 0 && Math.floor(t.invuln * 12) % 2 === 0;
    ctx.globalAlpha = blink ? 0.45 : 1;

    // 履带（左右两条）
    ctx.fillStyle = track;
    if (dir === 'up' || dir === 'down') {
      ctx.fillRect(x, y, 3, h);
      ctx.fillRect(x + w - 3, y, 3, h);
    } else {
      ctx.fillRect(x, y, w, 3);
      ctx.fillRect(x, y + h - 3, w, 3);
    }

    // 车身
    ctx.fillStyle = body;
    const inset = 3;
    ctx.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);

    // 炮管
    const v = DIR_VEC[dir];
    const cx = x + w / 2;
    const cy = y + h / 2;
    const len = w / 2 + 2;
    const thick = 3;
    ctx.fillStyle = dark;
    if (v.x !== 0) {
      const bx = v.x > 0 ? cx : cx - len;
      ctx.fillRect(bx, cy - thick / 2, len, thick);
    } else {
      const by = v.y > 0 ? cy : cy - len;
      ctx.fillRect(cx - thick / 2, by, thick, len);
    }
    // 炮塔中心
    ctx.fillStyle = track;
    ctx.fillRect(cx - 2, cy - 2, 4, 4);

    ctx.globalAlpha = 1;
  }

  /* ---------------- 主绘制 ---------------- */

  /**
   * 绘制一帧
   * @param {object} state
   */
  function draw(state) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingEnabled = false;

    drawBackground();
    // 1) 非草丛地形
    drawTerrain(state, false);
    // 2) 基地
    drawBase(state);
    // 3) 子弹（在坦克下方，避免遮挡炮塔）
    for (const b of state.bullets) drawBullet(b);
    // 4) 坦克
    for (const p of state.players) {
      if (p && p.enabled !== false && p.alive) drawTank(p);
    }
    for (const e of state.enemies) {
      if (e.alive) drawTank(e);
    }
    // 5) 草丛覆盖层：遮蔽坦克（需求规则）
    drawTerrain(state, true);
    // 6) 界面层
    drawPhaseUi(ctx, state);
  }

  /** 释放（当前无外部资源，保留接口供扩展） */
  function destroy() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  return { draw, resize, destroy, get scale() { return scale; } };
}
