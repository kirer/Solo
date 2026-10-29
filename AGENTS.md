# AGENTS.md

> **任何 AI agent（Claude Code / Codex / Cursor / pi / 别的）在本仓库工作前先读这一份。**
> 它只写三件事：**这是什么**、**改代码前后必须做什么**、**要动某处该读哪份文档**。
> 文档地图见 [`docs/README.md`](docs/README.md)。**改完行为必须同步改本文档 §3.3 的表**，这是硬要求。

---

## 1. 这是什么

「一人公司」：一个老板 + 一个 AI 组织的多 agent 运行时。

**组织不是代码里的岗位枚举，而是磁盘上的一堆文件夹。**

```
workspace/
  agents/<slug>/identity.md   ← 一个人。YAML 头 4 个字段 + 正文
  agents/<slug>/memory.md     ← 他的长期记忆
  agents/<slug>/skills/<n>/   ← 他会的手艺（个人层，覆盖公司同名）
  projects/<slug>/README.md   ← 一个项目：目标 / 验收 / 不做什么 / 当前进展 / 负责人
  projects/<slug>/memory.md   ← 项目记忆
  skills/<n>/SKILL.md         ← 公司层手艺，人人可读
  core.sqlite                 ← 频道消息、会话、名册、沉淀游标
```

加一个人 = 建一个目录。改一个人的职责 = 改一个 md 文件，**下一条消息就生效**（提示词每次
发送前重新读盘渲染）。这是整个设计的核心取舍：**语义写在文档里，代码只做机械的事**。

技术地基：`@earendil-works/pi-durable@1.4.0`（experimental，每个 minor 都可能破坏性变更）。
界面是 `ui/web/` 的原生 ES module，**没有构建步骤**。

---

## 2. 目录与三条边界

```
src/core/runtime/   防腐层：唯一能 import pi-durable / pi-ai / chord 的地方
src/core/agent/     一个人：身份 / 提示词 / 记忆 / 技能 / 名册
src/core/project/   一个项目：README.md / memory.md / 自动沉淀
src/core/channel/   说话：纯规则 / 投递 / 写一条 / 16 个工具
src/core/shell/     外壳：装配 / HTTP+SSE / 视图投影 / 启动
ui/web/             界面（无构建）
seed/               播种技能
scripts/            两个脚本：check-boundaries、core-live
test/core/          32 文件 / 277 例
test/ui/            3 文件 / 45 例
workspace/          运行时数据（gitignore）
```

**三条边界**，`npm run check` 机械化检查（`scripts/check-boundaries.mjs`），违反即失败：

1. **只有 `src/core/runtime/` 能 import 底层库**（pi-durable / pi-ai / chord）。
2. **内核（`agent|project|channel`）不得反向 import `shell/`**。依赖方向只能是 `shell → 内核`。
3. **`serve.ts` 的每条路由必须在前端有消费者**（白名单只有 `/api/org`，Docker 健康检查用）。
   加路由没人用 → 要么接上界面、要么删掉、要么改白名单并写清理由。

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
npm test          # 40 文件 384 例，<2s，必须全绿
npm run live      # 改了 agent 行为就必须跑：真实模型端到端 12 项，会花 token
```

- **`npm run live` 不能省。** 323 个单测全绿而 `live` 只过 4 项的情况**真实发生过**：
  两个 bug 叠在一起（老板发消息时漏记「他在哪个频道被叫到」+ 记的时机在一轮已经开跑之后），
  症状是「老板在公司频道问，对方在个人频道答」，单测完全看不见。单测测的是纯函数和装配，
  **只有真模型能测出「沟通会不会跑偏」**。
- **改了界面不用跑任何构建**，但要看一眼：起服务刷新，或截图。
- 端口被占先 `lsof -nP -iTCP:7788 -sTCP:LISTEN`：被杀的 node 进程会继续占端口回 404，
  症状是「服务起来了但所有接口 404」。
- 真实模型测试**不要在会话里前台跑**（几十秒到几分钟），用 `nohup ... &` 后台跑再看日志。

### 3.3 改了行为 → 同步这几处（硬要求）

| 你改了什么 | 必须同步 |
|---|---|
| 一个不显然的取舍 | `docs/DECISIONS.md` 追加一条 ADR |
| 文件/模块的位置、职责 | `docs/CODE.md` 的文件表与「改 X 动这里」表 |
| 概念（组织怎么表示、提示词怎么来、记忆怎么进） | `docs/CORE.md` |
| HTTP 接口字段 | `docs/WEB-API.md`（**先改文档，再改代码**） |
| 启动参数 / 部署方式 / 模型接入 | `docs/DEPLOY.md` |
| 消息 `kind` 新增（`think` / `say` / `tool` 过程投影） | `docs/CORE.md` §9 + `docs/WEB-API.md` 的消息 `kind` 表 |
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
| 加一个工具（能力） | `docs/CODE.md` §3 | `src/core/channel/tools.ts` 的 `createCoreTools` |
| 教 agent 一套做法 | `docs/DECISIONS.md` ADR-007 | **写 `seed/skills/<名字>/SKILL.md`，不要写代码** |
| 改提示词 | `docs/CODE.md` §3 + ADR-005 | `src/core/agent/prompt.ts` 的 `renderAgentPrompt` |
| 加身份字段 | `docs/CORE.md` §2 | `src/core/agent/identity.ts` 的 `IdentityHeader` |
| 改谁能被 @ 到 / 谁被叫醒 | `docs/CORE.md` §5 | `src/core/channel/state.ts` 的 `recipientsOf` |
| 改频道成员怎么来 | ADR-012 | `src/core/shell/assemble.ts` 的 `joinProjectChannel` |
| 加一条 HTTP 路由 | `docs/WEB-API.md` | `src/core/shell/serve.ts` 的 `routes` 表 + 接前端 |
| 改界面 | `docs/WEB-API.md` + `docs/CORE.md` §9 | `ui/web/` |
| 改记忆沉淀 | ADR-013 | `src/core/project/settle.ts` + `project/memory.ts` |
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
