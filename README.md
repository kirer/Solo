# AI Company — 一人公司

用 `pi-durable` 做运行时、`pi-tui` 做外壳的一人多 agent 组织：老板直连 CEO，下设 CTO / CFO / CPO / COO / CMO / CHRO，每个项目是一个工作空间文件夹，项目内配员工，员工只对接管理层。

## 快速开始

```bash
npm install
npm start        # 打开网页界面
```

默认用本地 Command Code 网关的 `auto/deepseek-v4.1-flash` 模型（`http://127.0.0.1:3425/v1`），启动后自动打开浏览器。
数据落在 `workspace/`（首次启动自动创建，已 gitignore）。

### 启动参数

```bash
node --experimental-strip-types src/server/main.ts \
  --port 7788 --host 127.0.0.1 \
  --db workspace/company.sqlite --workspace workspace --no-open
```

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--port` | `PORT` | `7788` | 监听端口 |
| `--host` | `AI_COMPANY_HOST` | `127.0.0.1` | 监听地址；`0.0.0.0` = 局域网可访问 |
| `--db` | — | `workspace/company.sqlite` | 数据库路径 |
| `--workspace` | — | `workspace/` | 设置 / 附件 / 项目目录的根 |
| `--no-open` | — | 打开浏览器 | 不自动开浏览器 |

launchd 托管的服务脚本同样支持（会写进 plist）：

```bash
AI_COMPANY_HOST=0.0.0.0 ./scripts/ai-company-service.sh restart
```

### 手机 / 同事访问（局域网）

用 `--host 0.0.0.0`（或 `AI_COMPANY_HOST=0.0.0.0`）启动后，启动日志与设置页「访问」
会列出全部非回环 IPv4 地址，例如 `http://192.168.1.71:7788/`。

> ⚠️ 服务**没有鉴权**：能访问端口的人可以读全部对话、以老板身份发消息、改设置。
> 只在可信内网使用，不要做公网端口映射 / 反向代理；远程访问请用 SSH 隧道或
> Tailscale / WireGuard。完整边界见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

### Docker（可选）

```bash
docker compose up -d --build     # http://127.0.0.1:7788/
```

数据在命名卷 `ai-company-workspace`；模型密钥、局域网、安全边界见
[`docs/DEPLOY.md`](docs/DEPLOY.md)。

### 想先看看效果

```bash
node --experimental-strip-types scripts/seed-demo.ts
npm start -- --db workspace/demo.sqlite --workspace workspace/demo
```

会生成一家有 2 个项目、7 名员工、1 条待你拍板的演示公司。

### 网页界面

界面是单页面，三个视图轮流切换：**组织 / 频道 / 看板**。右上角是设置（外观 / 模型 / IM / 成本）。

一屏之内没有第二套聊天 UI——所有对话都在「频道」视图里，右侧不再有常驻对话面板。

- **组织图**：CEO 在最上，6 位高管在下，再下面是项目组。每张卡片的边框颜色就是它的状态——蓝色在跑（带流动光边）、琥珀等你拍板、灰色空闲、玫红已终止
- **点项目卡**：卡片翻面，变成「项目负责人 + 员工」的层级；再点「返回」翻回去
- **频道视图**：左侧是频道列表（公司大群 / 领导层 / 项目群 / 成员私聊），中间是消息流，右侧是成员与本频道任务。点人和人聊天的唯一入口就是这里的私聊
- **点任何人**：切到频道视图并打开对应私聊；组织图主视图不会跳动
- **沟通连线**：成员之间正在或刚发生过派活 / 回报 / 转交时，组织图上会画出流动的光线，指出谁在跟谁说话（演示库已内置几条）
- **角色档案**：频道右上角的人像按钮展开该频道成员的档案（角色预制提示词 / 技能清单），面板与频道同宽内嵌，不悬浮遮挡
- **待你拍板的事**：CEO 卡右上角显示待办数；具体问题**内联在频道消息流里**（带选项卡片与回复框），直接选或写，提交即生效
- **消息内容**：支持 Markdown（标题、列表、表格、代码块、链接）；@ 提及带灰/绿已读点；代码块一键复制
- **手机 / 平板**：组织图变单列，看板三列纵向堆叠，频道变成「列表页 ↔ 会话页」两屏，输入区避开安全区
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
ui/            网页界面（源码直出；`npm run ui:build` 会把 12 个文件合成 3 个到 ui/dist/）
test/          契约 / 单元 / 端到端（54 文件 764 例）
scripts/       验收（ui-check / ui-shot）、演示数据、边界检查、迁移探针
docs/          文档（见下方索引）
openspec/      规格库：10 个能力、62 条需求（openspec CLI 认这个位置，别动）
archive/       归档：9 个验证脚本、系统产出的坦克大战、Pi 源码（不入库）
workspace/     运行时数据（首次启动创建，已 gitignore）
```

三条不可越过的边界，写在 [`docs/DECISIONS.md`](docs/DECISIONS.md)：

1. **只有 `src/runtime` 能导入底层库**（它是 experimental，每个 minor 都有破坏性变更）
2. **员工的能力包里没有任何管理工具**（权限靠工具不存在，不靠提示词）
3. **成本只从用量文档取，不按历史消息求和**（分叉会话会重复计账）

`npm run check` 会强制检查第 1 条。

## 文档

**如果你（或你的 AI agent）要改这个仓库的代码，先读 [`AGENTS.md`](AGENTS.md)。**
它写了三条不可越过的边界、提交前必须跑的四条命令、以及「改了什么就要同步哪份文档」。

完整索引在 [`docs/README.md`](docs/README.md)，常用的几个：

| 想了解 | 看这里 |
|---|---|
| 怎么启动、换模型、备份、升级、排障 | [`docs/RUNBOOK.md`](docs/RUNBOOK.md) |
| 局域网访问、Docker 部署、安全边界、Tauri 评估 | [`docs/DEPLOY.md`](docs/DEPLOY.md) |
| **网页 API 契约**（频道 / 看板 / 设置 / 模型 / 附件 / IM） | [`docs/WEB-API.md`](docs/WEB-API.md) |
| **哪些边界不能碰**（33 条架构决策） | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| 技术选型：为什么是 pi-durable | [`docs/history/PLAN.md`](docs/history/PLAN.md)（已冻结） |
| 七个设计问题的详细回答 | [`docs/history/ANSWERS.md`](docs/history/ANSWERS.md)（已冻结） |
| 做过什么、修过哪些真 bug | [`docs/history/HANDOFF.md`](docs/history/HANDOFF.md)（已冻结） |
| 底层库调研（三份） | [`docs/research/`](docs/research/) |
| **规格**：10 个能力、62 条需求（改代码前必看） | [`openspec/specs/`](openspec/specs/) |
| 归档：验证脚本 / Pi 源码 / 产出的游戏 | [`archive/README.md`](archive/README.md) |

## 开发

```bash
npm run build          # 编译
npm run check          # 类型检查 + 边界检查
npm test               # 全部测试（用 faux provider，不花钱）
npm run test:watch     # 监听模式

# 界面验收（需要本机 Chrome）
npm run ui:shot        # 真实浏览器截图到 .taste-skill/shots/
npm run ui:check       # 点一遍关键交互（63 项断言），给出 PASS / FAIL
                       # 注意：脚本默认连 7789，本机服务在 7788 时要加 --url http://127.0.0.1:7788/
```

真实模型的端到端测试会自动探测本地网关，不可用时跳过。

## 技术栈

- Node ≥ 22.19（ESM only）
- `@earendil-works/pi-durable@1.4.0` — 持久化会话 / 任务 / 文档运行时
- `@earendil-works/pi-ai@1.4.0` — 统一模型接口与 token 统计
- `@earendil-works/pi-tui@1.4.0` — 终端界面
- SQLite（Node 内置 `node:sqlite`，无需原生编译）

> ⚠️ `pi-durable` 标注 experimental，API 会在 minor 版本间不兼容变更。**锁死精确版本，所有调用走 `src/runtime/`。**
