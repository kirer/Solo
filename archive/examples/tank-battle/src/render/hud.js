/**
 * HUD 画布内文字（menu / levelIntro / paused / levelClear / gameOver / allClear）
 * ------------------------------------------------------------------
 * 只做文字与遮罩绘制；所有文案使用 Canvas fillText，不依赖任何字体文件。
 */

import { COLORS } from './colors.js';
import { FIELD_W, FIELD_H, PHASE } from '../game-core/constants.js';

/** 半透明遮罩 */
export function drawOverlay(ctx) {
  ctx.fillStyle = COLORS.overlay;
  ctx.fillRect(0, 0, FIELD_W, FIELD_H);
}

/** 居中文本 */
export function drawCenteredText(ctx, text, y, { size = 12, color = COLORS.text, bold = false, family = 'monospace' } = {}) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px ${family}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, FIELD_W / 2, y);
}

/**
 * 按 phase 绘制界面层（在实体绘制之后调用）
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} state
 */
export function drawPhaseUi(ctx, state) {
  const levelNo = state.levelIndex + 1;

  switch (state.phase) {
    case PHASE.MENU:
      drawOverlay(ctx);
      drawCenteredText(ctx, '坦 克 大 战', 52, { size: 22, color: COLORS.accent, bold: true });
      drawCenteredText(ctx, 'TANK BATTLE · v1', 74, { size: 9, color: COLORS.textDim });
      drawCenteredText(ctx, 'P1  方向键 + 空格/J', 100, { size: 10, color: COLORS.player1 });
      drawCenteredText(ctx, 'P2  WASD + F', 116, { size: 10, color: COLORS.player2 });
      drawCenteredText(ctx, 'Esc 暂停   R 重开', 132, { size: 10, color: COLORS.textDim });
      drawCenteredText(ctx, '最高分 ' + state.highScore, 152, { size: 10, color: COLORS.ok });
      drawCenteredText(ctx, '按 Enter / 空格 开始', 178, { size: 11, color: COLORS.text, bold: true });
      break;

    case PHASE.LEVEL_INTRO: {
      drawOverlay(ctx);
      drawCenteredText(ctx, `第 ${levelNo} 关`, 84, { size: 22, color: COLORS.accent, bold: true });
      drawCenteredText(ctx, state.level ? state.level.name : '', 106, { size: 9, color: COLORS.textDim });
      drawCenteredText(ctx, `剩余命数  ${state.lives}`, 130, { size: 13, color: COLORS.ok, bold: true });
      drawCenteredText(ctx, `敌方坦克  ${state.level ? state.level.enemyCount : 0}`, 148, { size: 10, color: COLORS.bad });
      break;
    }

    case PHASE.PAUSED:
      drawOverlay(ctx);
      drawCenteredText(ctx, '暂 停', 96, { size: 22, color: COLORS.accent, bold: true });
      drawCenteredText(ctx, 'Esc 继续   ·   R 重开本局', 126, { size: 10, color: COLORS.text });
      break;

    case PHASE.LEVEL_CLEAR:
      drawOverlay(ctx);
      drawCenteredText(ctx, `第 ${levelNo} 关 通过`, 84, { size: 20, color: COLORS.ok, bold: true });
      drawCenteredText(ctx, `得分  ${state.score}`, 112, { size: 12, color: COLORS.text });
      drawCenteredText(ctx, `最高分  ${state.highScore}`, 130, { size: 10, color: COLORS.textDim });
      drawCenteredText(ctx, '按 Enter / 空格 进入下一关', 158, { size: 10, color: COLORS.accent });
      break;

    case PHASE.GAME_OVER:
      drawOverlay(ctx);
      drawCenteredText(ctx, '游 戏 结 束', 76, { size: 20, color: COLORS.bad, bold: true });
      drawCenteredText(ctx, state.reason === 'base' ? '基地被击毁' : '命数耗尽',
        102, { size: 12, color: COLORS.text });
      drawCenteredText(ctx, `得分  ${state.score}`, 124, { size: 11, color: COLORS.text });
      drawCenteredText(ctx, `最高分  ${state.highScore}`, 140, { size: 10, color: COLORS.ok });
      drawCenteredText(ctx, 'R 回主菜单   ·   Enter 回主菜单', 164, { size: 9, color: COLORS.textDim });
      break;

    case PHASE.ALL_CLEAR:
      drawOverlay(ctx);
      drawCenteredText(ctx, '通 关 !', 72, { size: 24, color: COLORS.accent, bold: true });
      drawCenteredText(ctx, '3 关全部完成', 98, { size: 11, color: COLORS.ok });
      drawCenteredText(ctx, `总得分  ${state.score}`, 122, { size: 13, color: COLORS.text, bold: true });
      drawCenteredText(ctx, `最高分  ${state.highScore}`, 142, { size: 10, color: COLORS.ok });
      drawCenteredText(ctx, 'R / Enter 回主菜单', 168, { size: 9, color: COLORS.textDim });
      break;

    default:
      break;
  }
}
