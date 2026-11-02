---
name: superdesign-sync
description: 把 Solo 当前前端的每一屏同步到 Superdesign 画布。跑一遍真实界面、取每屏 DOM、打成自包含 HTML（内嵌 CSS / 头像 / 字体），再以「新版本」推回已有草稿，不花生成额度。用户说「更新到 super-design / 同步画布 / 画布该更新了 / 新提交后同步界面」时使用。
---

# 同步界面到 Superdesign 画布（superdesign-sync）

画布上的 16 屏是**从跑起来的界面里抓的**，不是让模型重画的：取 `document.body.outerHTML`，
内嵌编译后的 CSS、把头像转成 data URI、字体指回已上传的 Brand Asset，包成一份完整 HTML 再
`import-design-draft`。所以画布上是像素级还原，而且**一分额度都不花**。

## 一条命令

```bash
node .claude/skills/superdesign-sync/sync.mjs --push
```

它按顺序做四件事：

1. `npm run ui:build`（`--no-build` 跳过）；
2. 起无头 Chrome 走一遍 `states.mjs` 里的每一屏，DOM 落到 `.superdesign/tmp/dom/`；
3. 打包到 `.superdesign/tmp/drafts/`（每屏一个 150–300 KB 的自包含 HTML）；
4. 已有草稿用 `--into` 推成**新版本**（旧版本留在历史里可回退），没有的建新草稿。

前提：`npm start` 在 7788 上跑着（`--origin` 可改），`.superdesign/sync.json` 里有 `projectId`。

## 常用参数

```bash
node .claude/skills/superdesign-sync/sync.mjs                 # 只抓 + 打包，打印要推的命令
node .claude/skills/superdesign-sync/sync.mjs --push --only 01-group-dark,12-group-light
node .claude/skills/superdesign-sync/sync.mjs --no-build      # 刚构建过
node .claude/skills/superdesign-sync/sync.mjs --origin http://127.0.0.1:7799 --project <id>
```

`--only` 只筛**打包和推送**；抓取仍然走完整流程，因为每一屏都依赖上一步的界面状态。

## 文件

| 文件 | 干什么 |
|---|---|
| `sync.mjs` | 编排：构建 → 抓 → 打包 → 推；读写 `.superdesign/sync.json` |
| `states.mjs` | 画布上有哪几屏、每屏怎么走到（点哪个按钮、切哪个页签、什么主题和视口） |
| `cdp.mjs` | 零依赖 CDP 客户端：Node 22+ 自带的 `WebSocket` 驱动本机 Chrome，不用装 puppeteer |

状态在 `.superdesign/sync.json`（已 gitignore）：`projectId`、每屏的 `draftId` 与 `version`、
`lastCommit`。每次全量推送后记下当时的 commit，下次开跑先打印「上次同步之后界面改了哪几个文件」。

## 加一屏

1. `states.mjs` 的 `SCREENS` 加一行（名字 / 标题 / 主题 / 视口）；
2. 同一文件的 `capture()` 里走到那个状态，`await grab("名字")`；
3. 跑一遍 `--push` —— 新名字没有 `draftId`，会**建一屏新草稿**并记进 `sync.json`。

改名字等于新建一屏（旧草稿会留在画布上），要保留历史就别改名。

## 四个坑（都已经在代码里处理，改的时候别退回去）

- **受控输入框**：直接写 `.value` React 看不见，@ 提人的弹窗不会出来。要用原型上的 setter 再派发
  `input` 事件 —— 见 `states.mjs` 的 `typeAt`。
- **主题挂在 `<html>` 上**，不在 `<body>`：打包时按屏写进 `<html data-theme="…">`，否则浅色那屏
  会和深色一模一样。
- **系统 note 里可能贴着脚本正文**：`${...}` 和花括号会被导入校验当成没解析的模板而拒稿。
  打包时在 `.note-text` 里换成 HTML 实体，渲染出来还是原字符。
- **「等我选」会把输入框整个换掉**：某个频道最后一条消息带 `options` 且我还没答时，
  `#input` 不存在，抓 @ 提人会在 `input.focus()` 上抛错。所以 07-mention 走的是**全员频道**。
  反过来说，01-group-dark 底部出现选项卡是对的 —— 那是这个 workspace 此刻的真实状态。

## 不做的事

- **不摆拍界面上没有的状态**（AGENTS §2 第 6 条）。比如输入框的「等我选」选项卡只在最后一条
  消息带 `options` 时出现，workspace 里没有这样的消息就不做那一屏 —— 要看得见它，就在临时
  workspace（`--workspace /tmp/xxx`）里造一条带选项的消息再抓。
- 不往画布推**截图**：推的是真 DOM，截图只留在 `workspace/`（截图不入库）。
- 不动 `docs/`：这一层是设计稿的镜像，不是设计决策的家；决策写 `docs/DESIGN.md`。
