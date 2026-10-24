# AI Company — 一人公司

用 `pi-durable` 做运行时、`pi-tui` 做外壳的一人多 agent 组织：老板直连 CEO，下设 CTO / CFO / CPO / COO / CMO / CHRO，每个项目是一个工作空间文件夹，项目内配员工，员工只对接管理层。

## 快速开始

```bash
npm install
npm start        # 打开网页界面
```

默认用本地 Command Code 网关的 `auto/deepseek-v4.1-flash` 模型（`http://127.0.0.1:3425/v1`），启动后自动打开浏览器。
数据落在 `workspace/`（首次启动自动创建，已 gitignore）。

### 想先看看效果

```bash
node --experimental-strip-types scripts/seed-demo.ts
npm start -- --db workspace/demo.sqlite --workspace workspace/demo
```

会生成一家有 2 个项目、7 名员工、1 条待你拍板的演示公司。

### 网页界面

界面是单页面：顶栏 + 组织架构 + 右侧常驻对话。右上角是设置（外观 / 模型 / 成本），待办直接出现在对话面板顶部。

- **组织图**：CEO 在最上，6 位高管在下，再下面是项目组。每张卡片的边框颜色就是它的状态——蓝色在跑（带流动光边）、琥珀等你拍板、灰色空闲、玫红已终止
- **点项目卡**：卡片翻面，变成「项目负责人 + 员工」的层级；再点「返回」翻回去
- **点任何人**：右侧对话立刻切换，主视图不会跳动；对话面板可以拖动左边框调宽，双击复位，也能整块收起
- **沟通连线**：成员之间正在或刚发生过派活 / 回报 / 转交时，组织图上会画出流动的光线，指出谁在跟谁说话（演示库已内置几条）
- **待你拍板的事**：CEO 卡右上角显示待办数，具体问题出现在对话面板顶部（不在页面里另开待办区），直接输入决定，回车提交
- **对话内容**：支持 Markdown（标题、列表、表格、代码块、链接）；思考与工具调用默认折叠，点开才看参数和输出；输出可以一键复制；消息排队时显示「已排队」和「立即处理」
- **手机 / 平板**：组织图变单列，对话变成可下拉关闭的底部抽屉；输入区避开安全区
- **外观**：右上角设置里切换深色 / 浅色 / 跟随系统，选择会记住；也可以用 `?theme=light` / `?theme=dark` 临时预览

### 终止一个项目

跟 CEO 说就行，两步：

1. **「终止坦克大战项目，理由是……」** → CEO 停掉该项目所有在跑的活、归档员工，并问你：要不要彻底删除？
2. **「删掉」** → CEO 才真正删除：项目记录、员工名册、工作空间里的全部产物文件。

不回复就停在「已终止」——数据与产物都还在，可以反悔。这个两步是强制的：删除接口会校验项目必须已终止，一句话删不掉正在跑的项目。

> 会话与对话历史受底层限制无法物理删除，会保留在存储里但不再显示。

### 如果 CEO 正在忙

你发的消息会显示成「已排队 · 本轮工具结束后处理」，不会石沉大海。急事点消息右边的「立即处理」，会打断 CEO 当前的工作、立刻处理你这句话。

### 终端界面（可选）

```bash
npm run tui
```

终端版的按键：

| 按键 | 作用 |
|---|---|
| `↑` `↓` | 在组织树里移动 |
| `Enter` | 进入选中会话 / 发送输入 |
| `Tab` | 在组织树与输入框之间切换 |
| `Esc` | 中断当前会话的工作 |
| `f` | 在最新一条助手消息处开分支 |
| `a` | 回复「等你拍板」的问题 |
| `o` | 展开/折叠工具输出 |
| `PgUp` / `PgDn` | 翻看历史 |
| `R` | 重试受阻任务 |
| `q` / `Ctrl+C` | 退出 |

两个界面共享同一份数据，可以同时开。退出时未完成的工作会保留，下次启动自动恢复。

## 现在能做什么

对 CEO 说：

> 做一个网页坦克大战。CPO 建项目出需求，CHRO 按 slug 配四人，CTO 派活给开发实现，测试验收。全部自动推进。

真实跑一次的结果（`archive/examples/tank-battle/`，由系统自己产出）：

- CPO 立项并写出 `PROJECT.md`、`PLAN.md`
- CHRO 配了四个员工，按角色给不同工具（开发能跑命令，产品只能读写）
- 开发产出 **2603 行模块化代码**：`src/{game-core,entities,render,input,levels,storage}`
- 测试产出 32 个冒烟测试，全部通过
- 浏览器里零错误，canvas 与 HUD 正常渲染

员工遇到超出权限的事（技术选型、超预算）会逐级上报到 CTO → CEO → 你，你不在线也不丢。

**自己看一遍**：`open archive/examples/tank-battle/index.html`

## 目录

```
src/runtime/   防腐层：唯一 import pi-durable / pi-ai / chord 的地方
src/company/   业务层：文档、角色、工具、任务、组织操作、成本、留痕
src/server/    网页服务：HTTP + SSE、组织快照、会话流
src/tui/       终端界面
ui/            网页界面（纯静态，无构建步骤）
test/          契约 / 单元 / 端到端
scripts/       演示数据、边界检查
docs/          文档（见下方索引）
openspec/      规格库：9 个能力、54 条需求（openspec CLI 认这个位置，别动）
archive/       归档：验证脚本、Pi 源码、系统产出的游戏
workspace/     运行时数据（首次启动创建，已 gitignore）
```

三条不可越过的边界，写在 [`docs/design/DECISIONS.md`](docs/design/DECISIONS.md)：

1. **只有 `src/runtime` 能导入底层库**（它是 experimental，每个 minor 都有破坏性变更）
2. **员工的能力包里没有任何管理工具**（权限靠工具不存在，不靠提示词）
3. **成本只从用量文档取，不按历史消息求和**（分叉会话会重复计账）

`npm run check` 会强制检查第 1 条。

## 文档

完整索引在 [`docs/README.md`](docs/README.md)，常用的几个：

| 想了解 | 看这里 |
|---|---|
| 网页界面的设计令牌 / 模块边界 / 并行改界面时的契约 | [`docs/design/WEB-UI-CONTRACT.md`](docs/design/WEB-UI-CONTRACT.md) |
| 怎么启动、换模型、备份、升级、排障 | [`docs/RUNBOOK.md`](docs/RUNBOOK.md) |
| **哪些边界不能碰**（24 条架构决策） | [`docs/design/DECISIONS.md`](docs/design/DECISIONS.md) |
| 技术选型：为什么是 pi-durable | [`docs/design/PLAN.md`](docs/design/PLAN.md) |
| 七个设计问题的详细回答 | [`docs/design/ANSWERS.md`](docs/design/ANSWERS.md) |
| 做了什么、修过哪些真 bug | [`docs/HANDOFF.md`](docs/HANDOFF.md) |
| 底层库调研（三份） | [`docs/research/`](docs/research/) |
| **规格**：9 个能力、54 条需求（改代码前必看） | [`openspec/specs/`](openspec/specs/) |
| 归档：验证脚本 / Pi 源码 / 产出的游戏 | [`archive/README.md`](archive/README.md) |

## 开发

```bash
npm run build          # 编译
npm run check          # 类型检查 + 边界检查
npm test               # 全部测试（用 faux provider，不花钱）
npm run test:watch     # 监听模式

# 界面验收（需要本机 Chrome）
npm run ui:shot        # 真实浏览器截图到 .taste-skill/shots/
npm run ui:check       # 点一遍关键交互，给出 PASS / FAIL
```

真实模型的端到端测试会自动探测本地网关，不可用时跳过。

## 技术栈

- Node ≥ 22.19（ESM only）
- `@earendil-works/pi-durable@1.4.0` — 持久化会话 / 任务 / 文档运行时
- `@earendil-works/pi-ai@1.4.0` — 统一模型接口与 token 统计
- `@earendil-works/pi-tui@1.4.0` — 终端界面
- SQLite（Node 内置 `node:sqlite`，无需原生编译）

> ⚠️ `pi-durable` 标注 experimental，API 会在 minor 版本间不兼容变更。**锁死精确版本，所有调用走 `src/runtime/`。**
