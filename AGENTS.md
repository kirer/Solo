# AGENTS.md

> **任何 AI agent（Claude Code / Codex / Cursor / pi / 别的）在本仓库工作前先读这一份。**
> 它只写三件事：**这是什么**、**改代码前后必须做什么**、**要动某处该读哪份文档**。
> 文档地图见 [`docs/README.md`](docs/README.md)。**改完行为必须同步改本文档 §3.3 的表**，这是硬要求。

---

## 1. 这是什么

「Solo」：我 + 一个 AI 团队的多人 agent 运行时。

**组织不是代码里的身份枚举，而是磁盘上的一堆文件夹。**

```
~/.solo/                        ← 用户根：我的组织（跟着我走）
  members/<slug>/identity.md    ← 一个人。YAML 头 4 个字段 + 正文
  members/<slug>/memory.md      ← 他的长期记忆
  members/<slug>/skills/<n>/    ← 他会的手艺（个人层，覆盖全员同名）
  members/<slug>/workspace/     ← 他干活的地方
  teams/<slug>/README.md      ← 一个团队：目标 / 验收 / 不做什么 / 当前进展 / 团队管理员
  teams/<slug>/memory.md      ← 团队记忆
  teams/<slug>/skills/<n>/    ← 团队层手艺：这个团队的人都会，同名覆盖全员层
  skills/<n>/SKILL.md         ← 全员层手艺，人人可读
  plugins/<slug>/plugin.md    ← 一个插件：清单 + plugin.ts（后端）+ client.js（前端）
  rules.md                    ← 全员规矩（每轮都进提示词）
  logs/                       ← 审计 / 诊断 / 后台命令（跟着组织走，ADR-041）

<appRoot>/                      ← 应用根：这份安装自带的东西（默认 .solo-app/）
  assistant/<slug>/           ← 助理（知言）本人，形状同 members/<slug>/
  prompt/                     ← 提示词模板
  plugins/                    ← 插件（含出厂三个）
  settings.json               ← 模型配置
  core.sqlite                 ← 频道消息、会话、名册、沉淀游标
  uploads/                    ← 附件
```

两个根由 `src/core/layout.ts` 拼出来 —— **拼路径只许在这一处**（ADR-030）。

加一个人 = 建一个目录。改一个人的职责 = 改一个 md 文件，**下一条消息就生效**（提示词每次
发送前重新读盘渲染）。这是整个设计的核心取舍：**语义写在文档里，代码只做机械的事**。

技术地基：`@earendil-works/pi-durable@1.4.0`（experimental，每个 minor 都可能破坏性变更）。
界面是 `ui/app/` 的 React + TypeScript，Vite 构建到 `ui/web/`（**改完界面必须 `npm run ui:build`**）。

---

## 2. 目录与五层边界

```
src/
  core/           ── 内核（domain，业务事实）──────────────────────────────
    fsx.ts          工作区内的相对路径入口（越界抛错）；全项目只有它和 runtime/io.ts 碰 node:fs
    layout.ts       两个根的全部路径（拼路径只在这里）
    naming.ts       名字 → 目录名的唯一规则（agent / 团队 / 技能共用）
    runtime/io.ts   绝对路径的机械 IO（读 / 写 / 建目录 / 列表 / 串行闸 / 日志行）
    md/             文档流水线：doc.ts（markdown + frontmatter）/ text.ts（插槽渲染）/
                    prompt.ts（提示词拼段）/ catalog.ts（`## key` 文案目录）/
                    memory.ts（记忆格式，个人与团队共用）/ oneline.ts（压成一行）
    runtime/        防腐层：唯一能 import pi-durable / pi-ai / chord 的地方（含 models/compaction）
    agent/          一个人：身份 / 提示词装配（9 段，正文在 seed/prompt）/ 记忆 / 技能 / 名册
    team/           一个团队：README.md / memory.md / 自动沉淀
    channel/        说话：频道规则 / 写一条 / 投递与队列 / 唤醒 / 附件 / 后台命令（jobs.ts）/ 7 个工具（tools/）
    plugin/         插件：清单（manifest）/ 四动作 API（api）/ 加载与隔离（load）
  app/            用例：读（快照 / 投影） / 人 / 说话 / 上传 / 后台命令收尾 / 看门狗 / 诊断（不 import node:http）
  view/           契约层：只有 dto.ts，零 import（投影已并进 app/project.ts）
  interface/http/ 唯一 import node:http 的地方：routes / respond（原语）/ route-match（匹配）/
                  origin-guard（来源闸）/ network（网卡）/ static-assets / sse（编解码+hub）
  shell/          装配与启动：assemble / serve / main / seed
ui/app/           界面源码（React + TS + Vite）
ui/web/           构建产物（服务端发这个目录，别手改）
desktop/          Electron 壳（src/：拉起后端 / 开窗 / 更新 / 菜单）+ 图标
electron-builder.yml  桌面端打包（mac dmg+zip / win nsis；不用 asar）
seed/             出厂内容：规矩 / 提示词模板 / 技能 / 助理身份（播种进两个根）
scripts/          九个入口脚本：check-boundaries（边界）、core-live（真模型冒烟）、
                  scenario-live（多 agent 真模型场景）、repair（改名迁移）、
                  prompt-check（提示词黄金渲染）、prompt-fixture（样例插槽表）、
                  update-server（自建更新源：只读静态目录）、update-key（更新签名密钥，跑一次）、
                  update-manifest（清单 + Ed25519 签名）；
                  公共等待器与证据落盘在 live-support.ts
test/             83 文件 / 784 例
  ├ test/core/    71 文件（纯函数 + 装配）
  ├ test/ui/      9 文件（界面纯函数与源码约定）
  └ test/desktop/ 3 文件（更新源、就绪行与更新源地址、清单验签与版本比较）
.solo-app/ ~/.solo/  运行时数据（gitignore）
```

（`src/` 共 88 个 ts：core 58 / app 18 / view 1 / interface 7 / shell 4；行数会漂，以 `docs/CODE.md` 的文件表为准。）

**依赖只朝一个方向**：`interface → app → domain`；`view/` 谁都不依赖（大家都能用它）；
`shell/` 是唯一可以同时 import 全部的装配层。

**三条老边界**（一开始就有，`npm run check` 机械化检查，违反即失败）：

1. **只有 `src/core/runtime/` 能 import 底层库**（pi-durable / pi-ai / chord）。
2. **内核（domain）不得反向 import 上层**：`agent|team|channel|runtime` 不许碰
   `shell/` / `interface/` / `app/` / `view/`。
3. **每条路由必须在前端有消费者**（`src/interface/http/routes.ts` 的 `pattern` ×
   `ui/app/src`；白名单只有 `/api/org`，Docker 健康检查用）。加路由没人用 → 要么接上界面、
   要么删掉、要么改白名单并写清理由。

**分层后又收紧了六条**（脚本自己的编号是「六条规定」，`LAYER_RULES` 落成八组：域 / md /
plugin / 根原语 / view / app / desktop / interface）：

- **`view/` 是契约层**：只有 `dto.ts`，一个 import 都不许有（投影已并进 `app/project.ts`）。
- **`app/` 不许 `node:http`**：用例要能脱离网络直接测。
- **`interface/` 只经 `app/` 与 `view/` 说话**（不许 import 领域内部实现，否则业务会再长回
  handler 里）。
- **`md/` 只能往下看**：可 import `runtime/` 与 `fsx.ts`，不许够 `agent|team|channel|app|view|interface|shell`。
- **根目录两个原语**（`fsx.ts` / `naming.ts`）不许 import `app|view|interface|shell`。
- **`plugin/` 只加东西**（工具 / 提示词 / 路由 / 听消息）：不许 import `agent|team|app|view|interface|shell`，
  产物由 `shell/assemble.ts` 并进注册表。

另外三条容易踩的：

4. **`channel/types.ts` / `mentions.ts` / `rules.ts` 是纯函数**，不做 IO。落盘在 `channel/write.ts`，
   写一条 + 叫醒在 `channel/post.ts`，投递编排在 `channel/dispatch.ts`。
5. **提示词必须确定性**：同一份文件内容渲染出的字符串要逐字节相同，否则打穿 prompt cache。
   不许在提示词里塞时间戳、随机数、`Object.keys` 的顺序。
6. **不画后端没有的东西**。界面上每个字段都必须有真实数据来源；没有就留空，
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
npm run check        # tsc --noEmit + 边界检查
npm test             # 79 文件 769 例，<3s，必须全绿
npm run prompt:check # 提示词黄金渲染：确定性、插槽全填、每段 ≤12 行、模板里零工具名
npm run live         # 改了 agent 行为就必须跑：真实模型端到端 16 项，会花 token；连跑两次都要 16/16
npm run live:scenarios -- --rounds=1 --smoke   # 多 agent 场景脚手架检查，约 5–10 分钟
npm run live:scenarios -- --rounds=3           # 正式场景：硬场景 3/3、行为场景 2/3
```

- **`live` 的门是「两次 16/16 + 收尾（turn）趋势」**：
  `[turn]` = 模型把结论写在正文里、没调 `say`，由结算后的收尾补发；补发的内容/频道/去重
  由单测守；次数记下来，7 个阶段超 4 次就查提示词。
- **`npm run live` 不能省。** 五百多个单测全绿而 `live` 只过 4 项的情况**真实发生过**：
  两个 bug 叠在一起（我发消息时漏记「他在哪个频道被叫到」+ 记的时机在一轮已经开跑之后），
  症状是「我在全员频道问，对方在私聊里答」，单测完全看不见。单测测的是纯函数和装配，
  **只有真模型能测出「沟通会不会跑偏」**。
- **改了界面不用跑任何构建**，但要看一眼：起服务刷新，或截图。
- 端口被占先 `lsof -nP -iTCP:7788 -sTCP:LISTEN`：被杀的 node 进程会继续占端口回 404，
  症状是「服务起来了但所有接口 404」。
- 真实模型测试**不要在会话里前台跑**（几十秒到几分钟），用 `nohup ... &` 后台跑再看日志。

### 3.3 改了行为 → 同步这几处（硬要求）

| 你改了什么 | 必须同步 |
|---|---|
| 一个不显然的取舍 | `docs/DECISIONS.md` 追加一条 ADR |
| 改架构分层（新目录 / 依赖方向 / 边界规则） | `docs/DECISIONS.md` + `docs/CODE.md` §1 + 本文件 §2 + `scripts/check-boundaries.mjs` |
| 接一个 pi 能力（如 hooks）/ 绕一个 pi 做不到的事 | 新 ADR + `docs/CONCESSIONS.md`（绕路就追加一行，处理完标「已处理 + 日期」）；新钩子说明挂在哪个扩展上、为什么不能写在工具里 |
| 文件/模块的位置、职责 | `docs/CODE.md` 的文件表与「改 X 动这里」表 |
| 新增一处文件读写 | 走 `fsx.ts`（工作区相对路径）或 `runtime/io.ts`（绝对路径机械 IO）；markdown 文档再用 `md/doc.ts` 的 `readDocFile` / `writeDocFile`（解析 + 落盘配对）。直接 `node:fs` 只允许 `docs/CODE.md` §1 列的五类例外 |
| 改名字校验（agent / 团队 / 技能的 slug） | `src/core/naming.ts`（唯一一份）；`test/core/naming.test.ts` |
| 改技能的层数 / 查找顺序（全员 / 团队 / 个人谁盖谁） | `docs/CORE.md` §6 + `docs/CODE.md` 的文件表 | `src/core/agent/skills.ts`（`SkillScope` 与 `listSkills` 的合并顺序）；`test/core/skills.test.ts`；界面在 `ui/app/src/panels/RightPanel.tsx` 的 `SkillsTab` / `TeamSkills` |
| 改频道成员投影 / 消息落盘 / 唤醒依赖 / 收件人 | `channel/rules.ts` 的 `projectChannel`、`channel/write.ts` 的 `appendToChannel`、`agent/roster.ts` 的 `directoryWake`、`channel/mentions.ts` 的 `recipientsOf` / `deliveryTargets` |
| 名册（slug ↔ 会话 id）怎么读、怎么落盘 | `docs/CORE.md` §1 | `src/core/agent/roster.ts` 的 `mergeDirectory` / `directoryWake`（`rememberWake` 用内存会话兜底并补映射）+ `src/shell/assemble.ts` 的 `directoryNow` / `saveDirectoryImpl` + `test/core/directory-persist.test.ts`；**读的时候内存优先**，别只信落盘那份 |
| 新进频道的人要不要被叫醒（报到） | `docs/CORE.md` §4 + `docs/DECISIONS.md` ADR-042 | `channel/membership.ts` 的 `syncTeamChannel`（返回新进成员，不含我与助理）+ `shell/assemble.ts` 的 `syncTeamAndAnnounce` 与 `ownerSpeak` 的 `wakeTo`；文案 `seed/text/channel.md` 的 `membership.joined`；`test/core/membership.test.ts` |
| 看门狗（异常报告进频道） | `docs/CORE.md` §12 + `docs/DECISIONS.md` ADR-016 | `app/watch.ts`（`createWatch`）+ `app/diag.ts` 的 `onAbnormal` + `shell/serve.ts` 的 `start()` / `stop()`；只通报不自动救 |
| 我不 @ 人时谁接话 | `docs/CORE.md` §4 + `docs/DECISIONS.md` ADR-015 | `channel/rules.ts` 的 `speakerBefore` + `channel/mentions.ts` 的 `recipientsOf` / `deliveryTargets` + `channel/post.ts` 传线索 + `channel/delivery.ts` 的 `woken` |
| 后台命令（`run` 的 `background`）/ 重启清孤儿 | `docs/CORE.md` §4 + `docs/DECISIONS.md` ADR-013 | `channel/jobs.ts`（起 / 记 / 收 + `sweepRunJobs`）+ `channel/tools/run.ts` 的 background 分支 + `app/runs.ts`（启动清扫）+ `channel/post.ts` 的 `wakeTo`（`note` 要叫醒人只有这一条路） |
| 插件的四个动作 / 前端插槽（`SlotName` 表）/ 装与卸 | `docs/CORE.md` §13 + `docs/DECISIONS.md` ADR-018 / ADR-019 + `docs/WEB-API.md` §13.4 + `docs/DESIGN.md` §2.8 | `src/core/plugin/`（`manifest.ts` 的 `readPluginManifest` / `writePluginEnabled`、`api.ts`、`load.ts`）+ `app/plugins.ts`（清单 + 开关 + 装 / 卸）+ `shell/assemble.ts`（装配 + `reloadPlugins` 热重装，ADR-026）+ `interface/http/routes.ts`（五条接口；插件接口在 `*rest` 兜底里现查）+ `ui/app/src/plugin/`（`registry.ts` 的 `SlotName` / `SLOTS` / `Slot.tsx`）+ 画插槽的六个界面文件（`sidebar/Sidebar.tsx` / `App.tsx` / `stream/Stream.tsx` / `composer/Composer.tsx` / `panels/RightPanel.tsx` / `panels/Overlays.tsx`）+ 插件浮层 `panels/Overlays.tsx` 的 `PluginSheet`（开关 / 装 / 删）与 `sidebar/Sidebar.tsx` 的入口 |
| 一条消息的字数上限（群聊 / 私聊不同） | `docs/CORE.md` §9 | `channel/tools/guards.ts` 的 `sayLimitOf` + `channel/tools/say.ts` |
| 改轨迹（切轮 / 摘要 / 步骤映射 / 接口形状） | `docs/WEB-API.md` §7.2–7.3 + `docs/DESIGN.md` §2.3 / §8.2 + ADR-001 / ADR-003 | `src/app/trace.ts`（纯函数：`groupsOf` 切轮 + `buildTurn` 映射步骤）+ `src/app/read.ts` 的 `turnsOf` + `test/core/trace.test.ts` |
| 聊天里的运行态（`live` 行）/ 后台任务面板 | `docs/DESIGN.md` §2.3 + `docs/DECISIONS.md` ADR-046 + `docs/WEB-API.md` §4.1 / §7.2 | `ui/app/src/stream/model.ts` 的 `buildRows`（`live` 行）+ `stream/LiveRow.tsx` + `panels/TasksPanel.tsx` + `state/store.ts` 的 `runs` / `tasks` + `App.tsx` 顶栏按钮；`ViewTurn.trigger` 在 `src/view/dto.ts` 与 `app/read.ts` 的 `turnsOf`；`test/ui/stream-model.test.ts` |
| 改「插话回哪儿 / 一轮答完自动补发」 | `docs/CORE.md` §4 | `channel/turn/record.ts` 的 `WakeRecord` / `parseWake`、`channel/turn/finish.ts`、`channel/dispatch.ts` 的 `wakeOf` / `finishTurn`；文案在 `seed/prompt/88-task.md` |
| 建频道 / 私聊 / 一个人跑过的轮次 | `docs/CORE.md` §4 + `docs/WEB-API.md` + `docs/DESIGN.md` §2.3 | 建频道只有 `channel/membership.ts` 的 `ensureOwnerDm`（装配 / 招人自动建）+ `POST /api/people/:slug/dm`；一个人的轮次是 `app/read.ts` 的 `readPersonTurns`（`limit`）+ `ui/app/src/panels/TasksPanel.tsx`；聊天流里不画过程 |
| 团队频道的详情 / 团队记忆（`GET /api/teams/:slug`） | `docs/WEB-API.md` §10.1 + `docs/DESIGN.md` §1.2 / §5 | `src/app/teams.ts` + `interface/http/routes.ts` + `ui/app/src/panels/RightPanel.tsx`（`TeamSection` / `TeamMemory`）；团队记忆只读，写入口在 `team/settle.ts` |
| 团队 README 的 `lead` / 建团队权限校验 | `docs/CORE.md` §7 + `docs/CODE.md` §3 | `team/doc.ts` 的 `leadProblem` / `createTeamProblem` + `channel/tools/file.ts` 写分支；校验在落盘之前；开新团队只有助理能做 |
| 「没答上来」的留痕 | `docs/CORE.md` §4「结算即收尾」 | `channel/wake.ts` 的结算回调：`aborted`（合并唤醒）不留痕；`test/core/wake.test.ts` |
| 重启打断的那一轮要不要接着做 | `docs/CORE.md` §4 + `docs/DECISIONS.md` ADR-044 | `runtime/open.ts` 的 `reconcileZombieTasks` 返回值（`CoreRuntime.interrupted`）+ `shell/assemble.ts` 的 `resumeInterrupted`（最后一步）+ `shell/main.ts` 传参；文案 `seed/text/channel.md` 的 `turn.interrupted`；`test/core/resume.test.ts` |
| 新增/修改真模型脚本（`scripts/*-live.ts`、`live-support.ts`） | 本文件 §2 + `docs/CODE.md` 目录与 §3 + `package.json`；等待器只放 `live-support.ts` |
| 改提示词模板 / 加一段 / 加一个插槽 | `docs/design/SEED-CONTRACT.md` §3 插槽表 + `scripts/prompt-fixture.ts` 样例值 + `docs/CODE.md` §2 文件表；跑 `npm run prompt:check` |
| 改工具描述 / 参数说明 / 拒绝话术 / 投递头 / 附件说明 | `docs/DECISIONS.md` ADR-039 + `docs/design/SEED-CONTRACT.md` §1 | **改 `seed/text/*.md`，不改代码**（键名照旧的照旧）；代码里加一处新文案就加一个键；改完**重启**（工具描述装配时定型）；`test/core/no-hardcoded-text.test.ts` 会拦代码里的中文 |
| 改 seed 出厂内容（规矩 / 技能 / 助理身份） | `docs/design/SEED-CONTRACT.md` + `test/core/seed-contract.test.ts`（一条事实一个家、≤15 条、零工具名、技能 ≤4 KB） |
| 概念（组织怎么表示、提示词怎么来、记忆怎么进） | `docs/CORE.md` |
| HTTP 接口字段 | `docs/WEB-API.md`（**先改文档，再改代码**） |
| 头像的画法 / 取景 / 配色 / 尺寸 | `docs/DESIGN.md` §6.5 + `docs/DECISIONS.md`（画风是一条 ADR）+ `docs/WEB-API.md` 的 `/api/avatar/:seed` | `src/app/avatar.ts`（唯一的画法，纯函数）+ `ui/app/src/lib/avatar.ts`（种子与尺寸）+ `test/core/avatar.test.ts` |
| 界面布局 / 行类型 / 轨迹展示 | `docs/DESIGN.md`（决策稿：改之前先说明原决策错在哪）+ 本文件 §2 的「不画后端没有的东西」 |
| 启动参数 / 部署方式 / 模型接入（含给某个人换模型、改配置不用重启） | `docs/DEPLOY.md` §3 + `docs/DECISIONS.md` ADR-023 / ADR-024 / ADR-025 | `src/core/runtime/models.ts`（`setupModels` / `syncModels` / `parseModelRef`）+ `shell/assemble.ts` 的 `modelFor` / `refreshModels` + `app/people.ts` 的 `setPersonModel` + `app/models.ts` 的 `list` + 界面在出厂插件 `seed/plugins/模型管理/`（`rightPanel.detail` 插槽） |
| 桌面壳 / 打包 / 自动更新 / 更新源 | `docs/DEPLOY.md` §9–10 + `docs/DECISIONS.md` ADR-027 / ADR-028 / ADR-029 | `desktop/src/`（`main.ts` / `backend.ts` / `ready-line.ts` / `updates.ts` / `manifest.ts` / `install.ts` / `update-key.ts` / `feed.ts` / `menu.ts`）+ `electron-builder.yml` + `scripts/update-server.ts` / `update-key.ts` / `update-manifest.ts`；壳与后端只靠 `[core] http://…` 一行说话，不 import 内核与界面源码；更新是「清单验签 → zip → 进程外替换」，不是 Squirrel |
| 消息 `kind` 新增（`chat` / `say` / `question` / `decision` / `report` / `note`） | `docs/CORE.md` §4 + §9 + `docs/WEB-API.md` 的消息 `kind` 说明 |
| 术语改名（项目→团队、公司→全员、`owner` 只在内部保留） | `docs/CORE.md` + `docs/CODE.md` 的路径 + `docs/WEB-API.md` 的字段名 + 本文件；词表：我 / 助理 / 团队 / 团队管理员 / 成员 / 全员；项目叫 Solo |
| 删掉界面上看得见的东西（过程投影 / 占位 / 「正在说」草稿 / 系统留痕） | `docs/CORE.md` §9 + `docs/WEB-API.md` 的消息字段与 SSE 事件表 + `docs/DECISIONS.md`；留痕不画见 ADR-047，落在 `ui/app/src/stream/model.ts` 的 `buildRows` + `test/ui/stream-model.test.ts` |
| 撞上 pi-durable 做不到的事、或为它写了绕路代码 | `docs/CONCESSIONS.md` 追加一行（只追加；处理完写「已处理 + 日期」） |
| 两个根（应用私有 / 用户根）/ 加一个要落盘的目录 | `docs/DECISIONS.md` ADR-030 + `docs/CODE.md` §1 | `src/core/layout.ts`（**拼路径只在这里**）+ `scripts/check-boundaries.mjs` 的根原语组 + `test/core/layout.test.ts`；不许在业务模块里 `dirname` 推路径 |
| 加 / 改一个频道给的「工作区」（插件用） | `docs/DECISIONS.md` ADR-036 + `docs/WEB-API.md` §13.4 | `src/core/plugin/api.ts` 的 `PluginScope` / `scope()` + `shell/assemble.ts` 的 `pluginScope`；**路径守卫留在插件里**，核心只给根 |
| 等我选的消息（`options`）/ 输入卡的选项卡 | `docs/CORE.md` §4 + `docs/WEB-API.md` §6 | `channel/tools/say.ts`（2–6 个、去重、强制 `kind=choice` 并 @我）+ `channel/types.ts` / `rules.ts` / `write.ts` / `post.ts` + `ui/app/src/composer/choice.ts`（纯函数）+ `Composer.tsx`；**回答不新增路由**（ADR-035） |
| 附件预览（内联还是下载） | `docs/DECISIONS.md` ADR-037 + `docs/WEB-API.md` §13 | `app/uploads.ts` 的 `read({preview})` + `routes.ts` 的 `?preview=1` + `ui/app/src/stream/AttachmentPreview.tsx`；**按真实 mime 发 `Content-Type`，HTML 永远 `text/plain`** |
| 解散团队 / 开除成员 | `docs/CORE.md` §7 + `docs/DECISIONS.md` ADR-033 | 解散 = 团队 README 的 `status: archived`（`team/doc.ts` + `syncTeam`）；开除 = `hire` 的 `action=fire`（移进 `members/.retired/`，不删）；都不开新工具 |
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
| `docs/DESIGN.md` | 界面长什么样、每个元素的数据来源（决策稿，不是建议） |
| `docs/DECISIONS.md` | 哪些约定不能轻易碰、为什么 |
| `docs/CONCESSIONS.md` | 底座（pi-durable）做不到什么、我们怎么绕的、升级后能不能删 |
| `docs/WEB-API.md` | 接口字段 |
| `docs/DEPLOY.md` | 怎么跑起来、怎么排障 |
| `docs/research/` | 底层库的原始调研（可能落后于依赖版本） |

**不要新增一次性文档**（「XX 轮施工说明」「临时契约」）。一次性的写提交信息；跨迭代有效的
进 ADR。

**截图不入库。** 需要留证的图放 `.solo-app/` 或 `~/.solo/`（已 gitignore / 不在仓库里）。

---

## 5. 常见任务 → 读哪份

| 我要… | 先读 | 再动 |
|---|---|---|
| 加一个工具（能力） | `docs/CODE.md` §3 | `src/core/channel/tools/`：一个工具一个 builder 文件 + 登记进 `index.ts` 的 `createCoreTools`（7 个；同一件事加 `action`，别开新名字） |
| 教 agent 一套做法 | `seed/skills/` 里现成的技能 | **写 `seed/skills/<名字>/SKILL.md`，不要写代码** |
| 改提示词 | `docs/CODE.md` §3 + `docs/design/SEED-CONTRACT.md` | **改文案写 `seed/prompt/NN-段名.md`**（代码只排版，`src/core/md/prompt.ts` 只剩排版）；加插槽要先登记 §3 并在 `scripts/prompt-fixture.ts` 给样例值 |
| 加身份字段 | `docs/CORE.md` §1 | `src/core/agent/identity.ts` 的 `IdentityHeader` |
| 改谁能被 @ 到 / 谁被叫醒 | `docs/CORE.md` §4 | `src/core/channel/mentions.ts` 的 `recipientsOf` / `parseMentions` |
| 改「这条会话算私聊还是群聊」 | `docs/CORE.md` §4 | `src/core/channel/types.ts` 的 `chatKind`（只看成员表） |
| 改频道成员怎么来 | `docs/CORE.md` §4 | `src/core/channel/membership.ts` 的 `joinTeamChannel` / `syncTeamChannel` / `addToAllChannel` |
| 加一条 HTTP 路由 | `docs/WEB-API.md` | `src/interface/http/routes.ts` 的 `routes` 表 + `app/` 一个用例 + `ui/app/src/api/client.ts` 的消费者 |
| 改界面 | `docs/DESIGN.md` + `docs/WEB-API.md` + `docs/CORE.md` §9 | `ui/app/`，改完 `npm run ui:build`；后端字段先改 `src/view/dto.ts`；新元素必须在 DESIGN §8 的数据来源表里指到字段 |
| 改记忆沉淀 | `docs/CORE.md` §8 | 机制在 `src/core/team/settle.ts` + `team/memory.ts`；**判据在 `seed/prompt/95-settle.md`** |
| 换 / 升级 pi-durable | `docs/research/02-pi-durable` | `src/core/runtime/` + `test/core/` |
| 部署 / 排障 | `docs/DEPLOY.md` | — |

---

## 6. 上手三条命令

```bash
npm install
npm start                          # http://127.0.0.1:7788
npm run check && npm test          # 改完必跑
```

`~/.solo` 与 `.solo-app/` 是真实数据，做实验前先用 `--app-root /tmp/x-app --user-root /tmp/x-home` 另起一套。
