# 【已归档 · 不再维护】

> 这份文档写于某个时间点，记录**当时**的设计推理与施工过程，**内容已冻结**。
> 现状一律以 `docs/SYSTEM.md`、`docs/CODE.md`、`docs/DECISIONS.md`、`openspec/specs/` 为准。
> 保留它只是为了回答「当初为什么这么决定」。里面的行号、文件路径、数量、截图链接都可能已失效。

---

# 网页界面 · 设计契约（Web UI Contract）

> 这份文件是网页界面改版的唯一契约。多个 agent 并行改界面时，先读它，
> 只在划定的文件里写代码。改完必须用真实浏览器截图验收，不能只读代码。
>
> ⚠️ **2026-10 后续：右侧对话面板已被删除。** 老板要求「去掉右侧聊天面板」，
> `ui/js/chat.js`、`ui/js/ask.js`、`ui/css/chat.css` 全部移除，聊天入口只剩频道视图的
> 私聊，待办卡片内联在消息流里（`ui/js/pending.js`）。本文件中凡提到
> `chat.js` / `chat.css` / `#chat*` / 拖宽 / 收起 / 手机对话抽屉的段落**全部作废**，
> 现状以 `ui/index.html` + `ui/js/channels.js` 为准。

> ⚠️ **2026-10-24 第二轮改版已把状态配色与聊天框推翻重做**（绿=运行/思考、
> 黄=等待拍板、红=故障；消息名字 chip；思考/工具去外框；顶部按钮改为角色档案）。
> 那部分的唯一契约是 [`OPTIMIZATION-CONTRACT.md`](OPTIMIZATION-CONTRACT.md)，
> 与本文件第 2/3 节冲突时**以新契约为准**。本文件其余部分（模块边界、DOM 契约、
> 布局、施工纪律）继续有效。

## 1. 方向

**一句话**：一座会呼吸的指挥台——近黑的石墨底，节点用状态色描边，正在运行的人
沿着连线流动；点项目卡片翻面成团队，点人右侧常驻对话。

**这一屏要回答的问题**：谁在干活、谁在等我拍板。

**风格来源**：`design-taste-frontend` 的 app-screen `data-terminal` 方向
（暗色监控台、等宽数字、极细的选择线），加上用户明确要求的
「状态色边框 + 流动效果 + 连线」。凡与本契约冲突的，以本契约和用户原话为准。

- 简洁：没有仪表盘式的 KPI 堆叠、没有图标色块、没有第二套字体。
- 炫酷：只把「动」花在有信息的地方——运行中的节点、正在说话的连线、翻面的项目卡。
- 颜色预算：界面本身是单色的；彩色只出现在状态（在跑 / 待你 / 失败）上。

## 2. 视觉令牌（`ui/css/tokens.css` 已定义，禁止另起一套）

方向：**精密工作台**。冷石墨底 / 纸白底、骨白 / 墨黑、2px 直角、1px 精确边框；颜色只作为状态墨，
不做霓虹光、不做渐变、不做毛玻璃。等宽字体只留给代码 / 命令 / 型号。

**双主题**：`tokens.css` 用 `[data-resolved="light"]` 覆盖浅色令牌；深色是 `:root` 默认。
`<html data-theme="dark|light|system" data-resolved="dark|light">` 由 `index.html` 的内联脚本在首屏前设置，
`app.js` 负责菜单、持久化（`localStorage: ai-company.theme`）与系统配色变化监听。
组件 CSS 一律只用 `var(--token)`，禁止写死颜色 / 圆角 / 阴影，保证两个主题都成立。

| 角色 | 值 |
| --- | --- |
| 地 | 深色 `--bg #0b0c0e` / 浅色 `#f5f5f2`；面板 `#14161a` / `#ffffff`；抬起 `#20232a` / `#eeeEE9` |
| 线 | 深色 `#272b32` / 浅色 `#e2e1db`；弱线 `#1d2026` / `#ecebe6`；强线 `#363b44` / `#96958d` |
| 墨 | 深色 `--ink #e8ebf0` / 浅色 `#1b1d21`；弱 `#9098a4` / `#4f555f`；更弱 `#7b8490` / `#6a707a` |
| 状态 | 在跑 `--accent #5b9cff` / `#2563eb`；待你 `--warn #f2b24c` / `#8a5200`；失败/终止 `--danger #f27272` / `#c24141`；回报 `--info #8fb8e8` / `#2a6f97` |
| 圆角 | **统一 2px**（`--radius` / `--radius-sm` / `--radius-md`）；只有状态点是圆的 |
| 间距 | `--sp-1 4 · --sp-2 8 · --sp-3 13 · --sp-4 21 · --sp-5 34 · --sp-6 55` |
| 字号 | `--fs-2xs 10.5 · --fs-xs 11.5 · --fs-sm 12.5 · --fs-base 13.5 · --fs-md 15 · --fs-lg 19 · --fs-xl 26` |
| 动效 | `--dur-fast 110ms · --dur 180ms · --dur-slow 360ms · --dur-flip 460ms` |

字体：系统字体（SF Pro / PingFang SC），**不加载外部字体**。数字用 `font-variant-numeric: tabular-nums`；
`--mono` 只用于代码块、命令、工具参数、模型型号。禁止用 mono 当界面装饰。

**去 AI 味的硬规则**：
- 没有 glow / 外发光 / drop-shadow / blur / 渐变 / 毛玻璃；阴影只给真正浮起的层。
- 没有脉冲圆点、呼吸边框、彩虹头像、L1/L2 编号、贯穿全宽的细分割线、虚线装饰。
- 没有 KPI 大数字块；CEO 卡不放大数字，待办数用一行小字。
- 颜色预算：界面本身是骨白 + 石墨灰；彩色只出现在状态（在跑/待你/失败/回报）。

## 3. 状态语义（全站统一）

- `data-status="busy"`：在跑 → 1px 蓝色边框 + 2.8s 一圈亮光 + 很薄的外圈同色光；5px 静态方点。
- `data-status="waiting"`：待你 → 1px 琥珀边框 + 6s 一圈较慢的琥珀光 + 很薄外光；5px 方点。
- `data-status="idle"`：空闲 → 1px 中性亮边，无动画。
- `data-status="error"` / 已终止项目：1px 哑玫红。
- 选中态：中性 1px outline（不是 accent），避免空闲卡看起来像在跑。

**性能**：只让「在跑」的卡片跑边框光；一屏最多 8 个动画节点。`prefers-reduced-motion`
下关掉流动、翻面过渡、淡入，保留全部信息。

## 4. 文件所有权（并行开发时只改自己的文件）

| 文件 | 负责人 | 内容 |
| --- | --- | --- |
| `ui/index.html` | Lead | 外壳 DOM、静态图标、CSS/JS 入口 |
| `ui/css/tokens.css` | Lead | 变量、reset、滚动条、焦点、reduced motion |
| `ui/css/shell.css` | Lead | 顶栏、舞台、对话内待办卡、设置浮层、移动端外壳 |
| `ui/css/graph.css` | graph-dev | 组织图、卡片、状态光边、连线、翻转、图内响应式 |
| `ui/css/channels.css` | channels-dev | 频道三栏、消息流、@ 提及、待办卡片、流水、任务面板 |
| `ui/css/markdown.css` | shared | Markdown 正文、代码块与复制（`chat.css` 删除后救活的部分） |
| `ui/css/profile.css` | shared | 角色档案浮层 + `#ch-dock` + `chat-spinner` |
| `ui/css/pending.css` | shared | 待办卡片（`.` + `pend-*`），原属 `chat.css` |
| `ui/css/trace.css` | shared | 工具调用 / 思考的折叠组（`.ch-trace*`） |
| `ui/js/app.js` | Lead | SSE、切视图、主题、dev 钩子 |
| `ui/js/channels.js` | channels-dev | 频道全部交互（消息流、@ 选择器、已读、待办、流水、任务） |
| `ui/js/pending.js` | Lead | 待办卡片渲染与提交（从 `chat.js` 迁出） |
| `ui/js/profile.js` | shared | 角色档案（悬浮层 + 频道内嵌 `#ch-dock` 两个挂载点） |
| `ui/js/markdown.js` | shared | 安全 Markdown 渲染（含图片、引用） |
| `scripts/ui-shot.mjs` | Lead | 真实浏览器截图 / 冒烟脚本 |
| `src/server/org-view.ts` | Lead | 给界面补 `links`（沟通连线数据） |

不改别的文件。需要跨文件改动时，发消息给 Lead，不要自己抢文件写。

## 5. DOM 契约（`ui/index.html` 已就位）

单页面，没有侧边导航；待办卡住在对话面板内。

```
body[data-chat="open|closed"][data-sheet="open|closed"]
  .app
    header.topbar  #stage-sub #conn #chat-toggle #settings-toggle
    .workspace
      main.stage   #stage > .stage-inner > section.org > #graph
      .chat-resizer #chat-resizer（role=separator, tabindex=0）
      aside.chat   #chat
        .chat-head #chat-avatar #chat-title #chat-status #chat-status-text #chat-role
                   #chat-tokens #chat-fold #chat-collapse #chat-close
        .chat-pending #ask-area      ← 待办卡渲染在这里
        .chat-body #chat-body
        .chat-foot #composer #input #send
  .settings #settings（role=dialog）
      #settings-close
      [data-theme-option="dark|light|system"]
      #company-model  #settings-cost
  .scrim #scrim
```

组织图里节点统一带 `data-conv="<conversationId>"`；项目容器 `.project` 带
`data-project="<slug>"`，翻转时加 `.is-flipped`。

## 6. 模块 API（import / export 必须严格一致）

```js
// ui/js/app.js（Lead，唯一入口）
import { initOrg } from './org.js';   // { update(org), setSelected(id), refreshLayout() }
import { initChannels } from './channels.js';   // 见下：频道是唯一聊天入口
import { initPending } from './pending.js';     // { render(container, items) }
import { initProfile } from './profile.js';     // { open(id, actor?), close(), isOpen() }
import { initLightbox } from './lightbox.js';   // 图片放大器（capture 阶段委托）
import { notify } from './toast.js';            // 轻提示

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

// ui/js/channels.js（channels-dev 实现）
export function initChannels({ onToast, fetchProfile }) -> {
  refresh(),              // 重新拉 /api/channels（不改变当前打开的频道）
  reloadCandidates(),     // 重新拉 @ 候选
  open(channelId),        // 打开某个频道（窄屏会切到单栏）
  loadMentionCandidates(),
}

// ui/js/pending.js（Lead 实现）
export function initPending({ onSettled }) -> {
  render(container, items),  // 渲染待办卡片；提交走 POST /api/channels/:id/messages（带 pendingKey）
                             // 处置走 POST /api/pending/dispose
}

// ui/js/toast.js（Lead 实现）
export function notify(text, tone)  // 轻提示：tone = "info" | "warn" | "error"

// ui/js/profile.js（shared 实现）
export function initProfile({ fetchProfile, onToggle, dock, trigger }) -> {
  open(conversationId, actor?),  // 传 dock 则内嵌到该容器，否则用 #profile-layer 悬浮层
  close(),
  isOpen(),
}

// ui/js/markdown.js（shared 实现，含图片与引用）
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
       queued[{id,text,mode,origin:"owner"|"agent",from?}], tokens, awaitingOwner }
FeedItem =
  | { kind:"user", id, text, at }
  | { kind:"assistant", id, text, at }
  | { kind:"thinking", id, text, at }
  | { kind:"tool", id, name, args, output,
      state:"running"|"ok"|"error"|"interrupted", collapsible, callId?, at }
  | { kind:"note", id, text, at }
  | { kind:"alert", id, text, at }
```

`running[]` 只包含**尚未提交**的实时工具调用；已提交的 toolCall 由 `items` 里的卡片展示，
并用 `callId` 对齐，避免同一调用出现两张卡。`state:"interrupted"` 表示工具调用提交了但
永远没有结果（中断/进程退出），界面显示「已中断」而不是永远「运行中」。
`queued[].origin:"agent"` 是别的 agent 派来的任务：界面显示「由 X 派来」，不提供「立即处理」。

**连线规则**：
- 服务端把「历史沟通」（TrailDoc）与「正在进行的派活/转交」（进程内 live registry）合并进 `links`；
  后者在答完后立即转成历史边，所以连线不会在完成的瞬间断掉。
- 界面画 24 小时内、最多 16 条边；按 `at` 越新越亮。自环（旧升级链）跳过。
- 历史边可能指向已经换过/归档的员工会话；这类端点如果带 `project`，聚合到项目卡上，
  不再因为「找不到锚点」整条丢弃。

## 8. 动效规则

- 不做卡片入场：组织图是工作台，不是落地页。唯一的一次编排是项目翻面。
- 状态变化：只过渡边框色 / 背景 / 透明度 180ms，不做缩放弹跳。
- 连线：底层实线 1.8px（按年龄 0.4–0.85 透明度），方向靠一段 4.2–5px 亮色短划沿路径移动，短划带很轻的同色光。
- 翻转：460ms，`transform: rotateX(180deg)`，透视 1400px；高度由 JS 过渡，翻完重算连线。
- 对话切换：120ms 淡入；**不改变面板宽度**。
- 全部动效在 `prefers-reduced-motion: reduce` 下禁用。

## 9. 布局与移动端

- **单页面**：顶栏 + 组织图 + 常驻对话；没有左侧栏、没有独立待办页、没有底部提示条。
- 桌面（≥ 861px）：顶栏 54px；组织图自适应；右侧对话常驻，默认 480px，
  可拖动 `#chat-resizer` 调整（360–760px，双击复位，宽度存 localStorage）。
- 平板（861–1100px）：对话 430px，高管层两列，项目一列。
- 手机（≤ 860px）：顶栏只留品牌图标 / 对话 / 设置；对话变成底部抽屉
  （高 82dvh，可下拉关闭）；组织图单列；卡片点击区域 ≥ 44px；输入区避开安全区。
- **点击卡片不得让主视图跳动**：对话宽度不因选中而改变；组织图不整块重绘。
- 所有交互有可见焦点；`Esc` 关手机抽屉；`Enter` 发送，`Shift+Enter` 换行。
- 页面禁止横向滚动。
- 待办（forYou 的 pending）渲染在 `#ask-area`（对话面板顶部），不进入组织图舞台；
  待办数量只出现在 CEO 卡上（不再在顶栏重复一个入口），点 CEO 卡即可在对话顶部处理。
- 成本不在页脚常驻，放在设置里的「成本」；会话 token 在对话头部。
- 主题：深色 / 浅色 / 跟随系统，右上角设置里切换；`?theme=light|dark` 可临时预览。

## 10. 验收（必须执行）

```bash
# 演示服务（已在 7789 跑着；改 server 代码后重启）
node scripts/ui-shot.mjs --url http://127.0.0.1:7789/ --out .taste-skill/shots --name desktop
node scripts/ui-shot.mjs --url http://127.0.0.1:7789/ --out .taste-skill/shots --name mobile \
  --sizes 390x844 --mobile
node scripts/ui-shot.mjs --url http://127.0.0.1:7789/ --out .taste-skill/shots --name states \
  --do "click:.project-front" --do "wait:800" --do "shot:flipped" --do "click:[data-conv='7']" --do "wait:900"

# 假数据：在跑 / 待你 / 连线 / 思考 / 工具失败 / Markdown / 排队 / 流式
node scripts/ui-shot.mjs --url "http://127.0.0.1:7789/?dev" --out .taste-skill/shots \
  --name mock --sizes 1440x900 --eval "__company.useMock()" --wait 900
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
