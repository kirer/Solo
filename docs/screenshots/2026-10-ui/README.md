# 2026-10 界面改版截图

13 项需求的验收截图（真实浏览器、1440×900 与 390×844 两档）。

| 文件 | 对应需求 | 说明 |
|---|---|---|
| `01-org-real.png` | 1、6、7 | 真实数据组织图：星海背景、无沟通时不画线 |
| `02-org-mock-links.png` | 6、7、10 | 假数据：绿（在跑）/黄（等回复）/红（失败）状态连线 + 卡片 3D 倾斜 |
| `03-starfield.png` | 7 | WebGL 星海（`ui-shot.mjs --gl` 才能截到，无头 Chrome 默认无 GPU） |
| `04-board.png` | 9、10 | 任务看板三列（进行中 / 待办 / 最近完成），项目 chip + 状态点 |
| `05-board-mobile.png` | 9 | 移动端 390：三列纵向堆叠 |
| `06-chat-dock.png` | 5、8、11 | 内嵌档案面板（与对话同宽）、@ 提及、待选项卡片、待办卡 |
| `07-settings.png` | 2、12 | 设置：模型清单与添加、IM 连接、局域网地址 |
| `08-light-org.png` | — | 浅色主题下的组织图 |

生成方式：

```bash
node scripts/ui-shot.mjs --url http://127.0.0.1:7788/ --out /tmp/shots --name org
node scripts/ui-shot.mjs --url "http://127.0.0.1:7788/?dev" --gl --out /tmp/shots \
  --do "eval:window.__company.useMock()" --do "wait:2500" --do "shot:starfield"
```
