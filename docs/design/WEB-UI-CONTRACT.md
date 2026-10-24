# 网页界面 · 设计契约（Web UI Contract）

> 这份文件是网页界面改版的唯一契约。多个 agent 并行改界面时，先读它，
> 只在划定的文件里写代码。改完必须用真实浏览器截图验收，不能只读代码。

## 1. 方向

**一句话**：一座会呼吸的指挥台——近黑的石墨底，节点用状态色描边，正在运行的人
沿着连线流动；点项目卡片翻面成团队，点人右侧常驻对话。

**这一屏要回答的问题**：谁在干活、谁在等我拍板。

**风格来源**：`design-taste-frontend` 的 app-screen `data-terminal` 方向
（暗色监控台、等宽数字、极细的选择线），加上用户明确要求的
「状态色边框 + 流动效果 + 连线」。凡与本契约冲突的，以本契约和用户原话为准。

- 简洁：没有仪表盘式的 KPI 堆叠、没有图标色块、没有第二套字体。
- 炫酷：只把「动」花在有信息的地方——运行中的节点、正在说话的连线、翻面的项目卡。
- 颜色预算：界面本身是单色的；彩色只出现在状态（在跑 / 待你 / 失败）和人物身份点上。

## 2. 视觉令牌（`ui/css/tokens.css` 已定义，禁止另起一套）

| 角色 | 值 |
| --- | --- |
| 地 | `--bg #08090c`，面板 `--surface #0e1116`，抬起 `--surface-3 #171c23` |
| 线 | `--line #20262f`，弱线 `--line-soft #191e26`，强线 `--line-strong #2c3440` |
| 墨 | `--ink #e8ecf2`，次级 `--ink-2 #c5ccd6`，弱 `--muted #8b94a1`，更弱 `--faint #5d6672` |
| 强调 | `--accent #3fe0c4`（在跑 / 实时）；`--warn #ffb340`（待你拍板）；`--danger #ff6577`（失败 / 已终止）；`--info #79b8ff`（回报） |
| 圆角 | 卡片 `--radius 14px`、控件 `--radius-sm 10px`、小标签 `--radius-xs 7px`、圆点 `999px` |
| 间距 | `--sp-1 4 · --sp-2 8 · --sp-3 13 · --sp-4 21 · --sp-5 34 · --sp-6 55` |
| 字号 | `--fs-2xs 10.5 · --fs-xs 11.5 · --fs-sm 12.5 · --fs-base 13.5 · --fs-md 15 · --fs-lg 20 · --fs-xl 28` |
| 动效 | `--dur-fast 120ms · --dur 200ms · --dur-slow 420ms · --ease-out`、`--ease-spring` |

字体：系统字体（SF Pro / PingFang SC），数字与代码用 `--mono`。**不加载外部字体**。
唯一允许的渐变：背景的一层极弱径向光晕；除此之外不用渐变、不用毛玻璃、不用投影（浮层除外）。

## 3. 状态语义（全站统一）

- `data-status="busy"`：在跑 → 青色边框 + 缓慢流动的光边 + 呼吸圆点。
- `data-status="waiting"`：等你拍板 → 琥珀边框 + 更慢的呼吸；顶部待办卡也是琥珀。
- `data-status="idle"`：空闲 → 中性细边，无动画。
- `data-status="error"` / 已终止项目：玫红。

**性能**：只让「在跑」的卡片跑光边动画；一屏最多 8 个动画节点。`prefers-reduced-motion`
下关掉光边、连线流动、入场动画，保留全部信息。

## 4. 文件所有权（并行开发时只改自己的文件）

| 文件 | 负责人 | 内容 |
| --- | --- | --- |
| `ui/index.html` | Lead | 外壳 DOM、静态图标、CSS/JS 入口 |
| `ui/css/tokens.css` | Lead | 变量、reset、滚动条、焦点、reduced motion |
| `ui/css/shell.css` | Lead | 顶栏、左侧栏、舞台、待办卡、移动端外壳 |
| `ui/css/graph.css` | graph-dev | 组织图、卡片、状态光边、连线、翻转、图内响应式 |
| `ui/css/chat.css` | chat-dev | 对话面板、消息、Markdown、工具折叠、输入区、拖宽、手机抽屉 |
| `ui/js/app.js` | Lead | SSE、选中、发送、拍板、顶栏、左侧栏、dev 钩子 |
| `ui/js/ask.js` | Lead | 待办卡渲染 |
| `ui/js/format.js` | Lead | 转义、token、状态、工具名、人物色相 |
| `ui/js/icons.js` | Lead | 内联 SVG 图标 |
| `ui/js/org.js` | graph-dev | 组织图渲染、增量更新、选中、翻转 |
| `ui/js/edges.js` | graph-dev | SVG 连线几何与流动动画 |
| `ui/js/chat.js` | chat-dev | 对话面板全部交互 |
| `ui/js/markdown.js` | chat-dev | 安全 Markdown 渲染 |
| `scripts/ui-shot.mjs` | Lead | 真实浏览器截图 / 冒烟脚本 |
| `src/server/org-view.ts` | Lead | 给界面补 `links`（沟通连线数据） |

不改别的文件。需要跨文件改动时，发消息给 Lead，不要自己抢文件写。

## 5. DOM 契约（`ui/index.html` 已就位）

```
body[data-chat="open|closed"][data-sheet="open|closed"]
  .app
    header.topbar  #company-name #company-model #conn #total-tokens #ask-count
    .workspace
      nav.rail          [data-rail="top|ask|chat"] #rail-ask #rail-live #rail-running
      main.stage        #stage > .stage-inner
        .stage-head     .stage-title #stage-sub #legend
        #ask-area
        section.org     #graph
        footer.stage-foot #stage-foot-cost
      .chat-resizer     #chat-resizer（role=separator, tabindex=0）
      aside.chat        #chat > .chat-head #chat-body .chat-foot
        .chat-head      #chat-avatar #chat-title #chat-status #chat-status-text #chat-role
                        #chat-fold #chat-collapse
        .chat-body      #chat-body（role=log, aria-live=polite）
        .chat-foot      #composer #input #send #chat-tokens
  .scrim #scrim
```

组织图里节点统一带 `data-conv="<conversationId>"`；项目容器 `.project` 带
`data-project="<slug>"`，翻转时加 `.is-flipped`。

## 6. 模块 API（import / export 必须严格一致）

```js
// ui/js/app.js（Lead，唯一入口）
import { initOrg } from './org.js';   // { update(org), setSelected(id), refreshLayout() }
import { initChat } from './chat.js'; // { setActor(actor), setFeed(feed), setLoading(), clear(),
                                      //   addLocalQueued(text), toggle(), updateOrg(org) }
import { initAsk } from './ask.js';   // { render(pendingItems) }

// ui/js/org.js（graph-dev 实现）
export function initOrg({ onSelect }) -> {
  update(org),          // 增量：结构不变时只打补丁，禁止整块 innerHTML 重绘
  setSelected(id),      // 高亮选中节点
  refreshLayout(),      // 尺寸变化后重算连线
}

// ui/js/edges.js（graph-dev 实现）
export function createEdges(svgElement) -> {
  render(links, anchors, focusId), // anchors: Map<number, Element>
  refresh(),                      // 用上次数据重算（翻转结束 / resize 后调用）
  setFocus(id),                   // 悬停高亮某人的连线
  clear(),
}

// ui/js/chat.js（chat-dev 实现）
export function initChat({ onSend, onInterrupt }) -> {
  setActor(actor),   // actor 含 label/subtitle/status/tokens/awaitingYou/projectName
  setFeed(feed),     // 增量渲染；保留滚动位置与折叠状态
  setLoading(),
  clear(),
  addLocalQueued(text),
  toggle(),          // 桌面：收起 / 展开；手机：开 / 关抽屉
  updateOrg(org),
}

// ui/js/markdown.js（chat-dev 实现）
export function renderMarkdown(text) -> string  // 必须先转义，再生成受控 HTML

// ui/js/format.js（Lead，现成可用）
escapeHtml / escapeAttr / formatTokens / formatCost / statusLabel / statusOf /
relTime / initials / hueFor / toolMeta / parseJsonish / clamp

// ui/js/icons.js（Lead，现成可用）
icon(name, size) -> string   // 支持的 name 见文件头
```

## 7. 数据形状（来自 `src/server/org-view.ts` / `feed.ts`）

```ts
ActorView { conversationId, label, subtitle, kind: "owner"|"role"|"project"|"staff",
            status: "busy"|"waiting"|"idle", tokens, awaitingYou, activity, archived? }
ProjectView { slug, name, status, lead: ActorView, staff: ActorView[], tokens,
              terminated?: { at, by, reason } }
PendingView { key, question, from, level, askedAt, forYou }
OrgView { company:{name,model}, ceo, roles[], projects[], pending[], costs:{
            totalTokens,totalCostUsd,byProject[] }, links: LinkView[] }
LinkView { from:number, to:number, kind:"delegate"|"report"|"escalate"|"decide"|"hire"|"archive",
           at:number, label:string, project?:string }

Feed { conversationId, title, role, kind, items[], streaming?, thinking?, running[], busy,
       queued[{id,text,mode}], tokens, awaitingOwner }
FeedItem =
  | { kind:"user", id, text, at }
  | { kind:"assistant", id, text, at }
  | { kind:"thinking", id, text, at }
  | { kind:"tool", id, name, args, output, state:"running"|"ok"|"error", collapsible, at }
  | { kind:"note", id, text, at }
  | { kind:"alert", id, text, at }
```

**连线规则**：`links` 只保留最近约 2 小时的沟通；界面只画 20 分钟内、首尾都能在图上
找到锚点的边；自己到自己的边（升级链）跳过。边按 `at` 越新越亮，超过 20 分钟不画。

## 8. 动效规则

- 入场：卡片只在首次出现时 stagger 上浮 8px + 淡入，延迟 `index * 22ms`，最多 12 个。
- 状态变化：只过渡边框色 / 背景 / 透明度 180ms，不做缩放弹跳。
- 连线：`stroke-dasharray` 流动，方向 from → to；最近 60 秒的边加一个沿路径移动的光点。
- 翻转：520ms，`transform: rotateX(180deg)`，透视 1400px；高度由 JS 过渡，翻完重算连线。
- 对话切换：旧内容 100ms 淡出，新内容 160ms 淡入上移 4px；**不改变面板宽度**。
- 全部动效在 `prefers-reduced-motion: reduce` 下禁用。

## 9. 布局与移动端

- 桌面（≥ 861px）：顶栏 56px；左侧栏 56px；中间舞台自适应；右侧对话常驻，默认 480px，
  可拖动 `#chat-resizer` 调整（360–760px，双击复位，宽度存 localStorage）。
- 平板（861–1100px）：对话 420px，高管层两列，项目一列或两列。
- 手机（≤ 860px）：左侧栏变成底部三个图标；对话变成底部抽屉（高 82dvh，可下拉关闭）；
  组织图单列；卡片点击区域 ≥ 44px；输入区避开安全区。
- **点击卡片不得让主视图跳动**：对话宽度不因选中而改变；组织图不整块重绘。
- 所有交互有可见焦点；`Esc` 关手机抽屉；`Enter` 发送，`Shift+Enter` 换行。
- 页面禁止横向滚动。

## 10. 验收（必须执行）

```bash
# 演示服务（已在 7789 跑着；改 server 代码后重启）
node scripts/ui-shot.mjs --url http://127.0.0.1:7789/ --out .taste-skill/shots --name desktop
node scripts/ui-shot.mjs --url http://127.0.0.1:7789/ --out .taste-skill/shots --name mobile \
  --sizes 390x844 --mobile
node scripts/ui-shot.mjs --url http://127.0.0.1:7789/ --out .taste-skill/shots --name states \
  --do "click:.project-front" --do "wait:800" --do "shot:flipped" --do "click:[data-conv='7']" --do "wait:900"
```

- 截图必须自己打开看（`read_image`），只看代码不算验收。
- 控制台必须 0 错误；页面不得横向溢出。
- 没有数据时：组织图空状态、对话未选中时的空状态都要成立。
- 每条需求逐条对照：状态边框/流动、翻转、连线、拖宽、MD、折叠、移动端。

## 11. 施工纪律

- 纯静态：没有构建步骤，ES module 直接跑。不引入任何新依赖、不引外部 CDN。
- 所有进入 `innerHTML` 的模型文本必须先 `escapeHtml`；Markdown 渲染器自己保证安全。
- 不用 `!important`；不用内联样式做主题；选择器按组件划分，避免跨文件覆盖。
- 数字用 `font-variant-numeric: tabular-nums`。
- 只改上表里自己的文件；改完在消息里说明改了哪些文件、用什么命令验的、还剩什么问题。
