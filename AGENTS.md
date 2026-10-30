# AGENTS.md

> **任何 AI agent（Claude Code / Codex / Cursor / pi / 别的）在本仓库工作前先读这一份。**
> 它只写三件事：**这是什么**、**改代码前后必须做什么**、**要动某处该读哪份文档**。
> 文档地图见 [`docs/README.md`](docs/README.md)。**改完行为必须同步改本文档 §3.3 的表**，这是硬要求。

---

## 1. 这是什么

「一人公司」：我 + 一个 AI 团队的多人 agent 运行时。

**组织不是代码里的岗位枚举，而是磁盘上的一堆文件夹。**

```
workspace/
  agents/<slug>/identity.md   ← 一个人。YAML 头 4 个字段 + 正文
  agents/<slug>/memory.md     ← 他的长期记忆
  agents/<slug>/skills/<n>/   ← 他会的手艺（个人层，覆盖公司同名）
  teams/<slug>/README.md      ← 一个团队：目标 / 验收 / 不做什么 / 当前进展 / 团队管理员
  teams/<slug>/memory.md      ← 团队记忆
  skills/<n>/SKILL.md         ← 公司层手艺，人人可读
  rules.md                    ← 全员规矩（每轮都进提示词）
  core.sqlite                 ← 频道消息、会话、名册、沉淀游标
```

加一个人 = 建一个目录。改一个人的职责 = 改一个 md 文件，**下一条消息就生效**（提示词每次
发送前重新读盘渲染）。这是整个设计的核心取舍：**语义写在文档里，代码只做机械的事**。

技术地基：`@earendil-works/pi-durable@1.4.0`（experimental，每个 minor 都可能破坏性变更）。
界面是 `ui/app/` 的 React + TypeScript，Vite 构建到 `ui/web/`（**改完界面必须 `npm run ui:build`**）。

---

## 2. 目录与五层边界

```
src/core/
  runtime/        防腐层：唯一能 import pi-durable / pi-ai / chord 的地方（含 models/compaction）
  agent/          一个人：身份 / 提示词（8 段）/ 记忆 / 技能 / 名册
  team/           一个团队：README.md / memory.md / 自动沉淀
  channel/        说话：纯规则 / 投递 / 写一条 / 11 个工具 / 附件
  ── 以上四层是 domain（业务事实）──────────────────────────────
  app/            用例：snapshot / read / chat / people / files / uploads / diag
  view/           投影纯函数（index.ts）+ 界面 DTO 的唯一权威（dto.ts），零 IO
  interface/http/ 唯一 import node:http 的地方：routes / server / hub / sse / guard
  shell/          装配与启动：assemble / serve / main / rescue / seed
ui/app/           界面源码（React + TS + Vite，ADR-079）
ui/web/           构建产物（服务端发这个目录，别手改）
seed/             播种技能与规矩文案
scripts/          三个脚本：check-boundaries（边界）、core-live（真模型）、repair（改名迁移）
test/             59 文件 / 511 例
  ├ test/core/    47 文件 / 447 例（纯函数 + 装配）
  └ test/ui/      11 文件 / 56 例（界面纯函数与源码约定）
workspace/        运行时数据（gitignore）
```

（`src/core` 共 52 个 ts / 10340 行；行数会漂，以 `docs/CODE.md` 的文件表为准。）

**依赖只朝一个方向**：`interface → app → domain`；`view/` 谁都不依赖（大家都能用它）；
`shell/` 是唯一可以同时 import 全部的装配层（ADR-082）。

**三条老边界**（一开始就有，`npm run check` 机械化检查，违反即失败）：

1. **只有 `src/core/runtime/` 能 import 底层库**（pi-durable / pi-ai / chord）。
2. **内核（domain）不得反向 import 上层**：`agent|team|channel|runtime` 不许碰
   `shell/` / `interface/` / `app/` / `view/`。
3. **每条路由必须在前端有消费者**（`src/core/interface/http/routes.ts` 的 `pattern` ×
   `ui/app/src`；白名单只有 `/api/org`，Docker 健康检查用）。加路由没人用 → 要么接上界面、
   要么删掉、要么改白名单并写清理由。

**分层后又收紧了三条**（脚本自己的编号是「六条规定」，`LAYER_RULES` 落成四组：域 / view /
app / interface）：

- **`view/` 零 IO**：不许 import `node:*`，不许碰 `runtime/`。
- **`app/` 不许 `node:http`**：用例要能脱离网络直接测。
- **`interface/` 只经 `app/` 与 `view/` 说话**（不许 import 领域内部实现，否则业务会再长回
  handler 里）。

另外三条容易踩的：

4. **`channel/state.ts` 是纯函数**，不做 IO。写消息、投递在 `post.ts` / `deliver.ts`。
5. **提示词必须确定性**：同一份文件内容渲染出的字符串要逐字节相同，否则打穿 prompt cache
   （ADR-005）。不许在提示词里塞时间戳、随机数、`Object.keys` 的顺序。
6. **不画后端没有的东西**（ADR-016）。界面上每个字段都必须有真实数据来源；没有就留空，
   不要造 `tasks: []` 这种空壳字段假装有功能。

---

## 3. 改代码的固定动作

### 3.1 开工前

```bash
cat docs/CODE.md          # "我想改 X → 动这里" 对照表
cat docs/DECISIONS.md     # 你改的地方碰不碰不可轻易动的约定
```

- 要碰某条 ADR 的边界 → **不要偷偷改**，追加一条新 ADR 写清原因（`DECISIONS.md` 只追加，
  不改旧条目，觉得旧条错了就新增一条「取代 ADR-0xx」）。
- 你的改动让某条现有行为不再成立 → 同步删掉文档里的那段，别让文档描述一个不存在的东西。

### 3.2 提交前（缺一不可）

```bash
npm run check     # tsc --noEmit + 边界检查
npm test          # 59 文件 511 例，<3s，必须全绿
npm run live      # 改了 agent 行为就必须跑：真实模型端到端 12 项，会花 token
```

- **`npm run live` 不能省。** 五百多个单测全绿而 `live` 只过 4 项的情况**真实发生过**：
  两个 bug 叠在一起（我发消息时漏记「他在哪个频道被叫到」+ 记的时机在一轮已经开跑之后），
  症状是「我在公司频道问，对方在私聊里答」，单测完全看不见。单测测的是纯函数和装配，
  **只有真模型能测出「沟通会不会跑偏」**。
- **改了界面不用跑任何构建**，但要看一眼：起服务刷新，或截图。
- 端口被占先 `lsof -nP -iTCP:7788 -sTCP:LISTEN`：被杀的 node 进程会继续占端口回 404，
  症状是「服务起来了但所有接口 404」。
- 真实模型测试**不要在会话里前台跑**（几十秒到几分钟），用 `nohup ... &` 后台跑再看日志。

### 3.3 改了行为 → 同步这几处（硬要求）

| 你改了什么 | 必须同步 |
|---|---|
| 一个不显然的取舍 | `docs/DECISIONS.md` 追加一条 ADR |
| 改架构分层（新目录 / 依赖方向 / 边界规则） | `docs/DECISIONS.md`（ADR-082）+ `docs/CODE.md` §1 + 本文件 §2 + `scripts/check-boundaries.mjs` |
| 接一个 pi 能力 / 绕一个 pi 做不到的事 | ADR-083 类的新 ADR + `docs/CONCESSIONS.md`（绕路就追加一行，处理完标「已处理 + 日期」） |
| 文件/模块的位置、职责 | `docs/CODE.md` 的文件表与「改 X 动这里」表 |
| 概念（组织怎么表示、提示词怎么来、记忆怎么进） | `docs/CORE.md` |
| HTTP 接口字段 | `docs/WEB-API.md`（**先改文档，再改代码**） |
| 启动参数 / 部署方式 / 模型接入 | `docs/DEPLOY.md` |
| 消息 `kind` 新增（`chat` / `say` / `question` / `decision` / `report` / `note`） | `docs/CORE.md` §4 + §9 + `docs/WEB-API.md` 的消息 `kind` 说明 |
| 术语改名（项目→团队、`owner` 只在内部保留） | `docs/CORE.md` + `docs/CODE.md` 的路径 + `docs/WEB-API.md` 的字段名 + 本文件；词表见 ADR-080（我 / 助理 / 团队 / 成员 / 团队管理员） |
| 删掉界面上看得见的东西（过程投影 / 占位 / 「正在说」草稿） | `docs/CORE.md` §9 + `docs/WEB-API.md` 的消息字段与 SSE 事件表 + `docs/DECISIONS.md`（ADR-081） |
| 撞上 pi-durable 做不到的事、或为它写了绕路代码 | `docs/CONCESSIONS.md` 追加一行（只追加；处理完写「已处理 + 日期」） |
| 本文件的表 | `AGENTS.md` |

**文档里的行号会漂。** 优先写**名字**（函数名、文件名、ADR 号），少写行号；非要写行号，
交付前 `grep -n` 核一遍。

---

## 4. 文档的组织规矩

**一份事实只有一个家。**

| 家 | 装什么 |
|---|---|
| `docs/CORE.md` | 概念：为什么这么设计 |
| `docs/CODE.md` | 代码在哪、谁负责什么 |
| `docs/DECISIONS.md` | 哪些约定不能轻易碰、为什么 |
| `docs/CONCESSIONS.md` | 底座（pi-durable）做不到什么、我们怎么绕的、升级后能不能删 |
| `docs/WEB-API.md` | 接口字段 |
| `docs/DEPLOY.md` | 怎么跑起来、怎么排障 |
| `docs/research/` | 底层库的原始调研（可能落后于依赖版本） |

**不要新增一次性文档**（「XX 轮施工说明」「临时契约」）。一次性的写提交信息；跨迭代有效的
进 ADR。

**截图不入库。** 需要留证的图放 `workspace/`（已 gitignore）。

---

## 5. 常见任务 → 读哪份

| 我要… | 先读 | 再动 |
|---|---|---|
| 加一个工具（能力） | `docs/CODE.md` §3 | `src/core/channel/tools.ts` 的 `createCoreTools`（11 个；同一件事加 `action`，别开新名字，ADR-084） |
| 教 agent 一套做法 | `docs/DECISIONS.md` ADR-007 | **写 `seed/skills/<名字>/SKILL.md`，不要写代码** |
| 改提示词 | `docs/CODE.md` §3 + ADR-005 + ADR-083 | `src/core/agent/prompt.ts` 的 `renderAgentPrompt` / `PROMPT_SEGMENTS`（8 段，逐字节不变） |
| 加身份字段 | `docs/CORE.md` §1 | `src/core/agent/identity.ts` 的 `IdentityHeader` |
| 改谁能被 @ 到 / 谁被叫醒 | `docs/CORE.md` §4 | `src/core/channel/state.ts` 的 `recipientsOf` |
| 改「这条会话算私聊还是群聊」 | `docs/CORE.md` §4 | `src/core/channel/state.ts` 的 `chatKind`（只看成员表） |
| 改频道成员怎么来 | ADR-012 | `src/core/shell/assemble.ts` 的 `joinTeamChannel` / `syncTeamChannel` |
| 加一条 HTTP 路由 | `docs/WEB-API.md` | `src/core/interface/http/routes.ts` 的 `routes` 表 + `app/` 一个用例 + `ui/app/src/api/client.ts` 的消费者 |
| 改界面 | `docs/WEB-API.md` + `docs/CORE.md` §9 + ADR-079 | `ui/app/`，改完 `npm run ui:build`；后端字段先改 `src/core/view/dto.ts` |
| 改记忆沉淀 | ADR-033 | `src/core/team/settle.ts` + `team/memory.ts` |
| 换 / 升级 pi-durable | `docs/research/02-pi-durable` | `src/core/runtime/` + `test/core/` |
| 部署 / 排障 | `docs/DEPLOY.md` | — |

---

## 6. 上手三条命令

```bash
npm install
npm start                          # http://127.0.0.1:7788
npm run check && npm test          # 改完必跑
```

`workspace/` 是真实数据，做实验前先用 `--workspace /tmp/xxx` 另起一个。
