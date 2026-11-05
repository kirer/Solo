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
  members/<slug>/identity.md    ← 一个人。YAML 头 3 个字段 + 正文
  members/<slug>/memory.md      ← 他的长期记忆
  members/<slug>/skills/<n>/    ← 他会的手艺（个人层，覆盖全员同名）
  members/<slug>/workspace/     ← 他干活的地方
  teams/<slug>/README.md      ← 一个团队：目标 / 验收 / 不做什么 / 当前进展 / 成员
  teams/<slug>/memory.md      ← 团队记忆
  teams/<slug>/skills/<n>/    ← 团队层手艺：这个团队的人都会，同名覆盖全员层
  skills/<n>/SKILL.md         ← 全员层手艺，人人可读
  plugins/<slug>/plugin.md    ← 一个插件：清单 + plugin.ts（后端）+ client.js（前端）
  rules.md                    ← 全员规矩（每轮都进提示词）
  logs/                       ← 审计 / 诊断 / 后台命令（跟着组织走，ADR-041）

<appRoot>/                      ← 应用根：这份安装自带的东西（默认 .solo-app/）
  assistant/<slug>/           ← 助理（Solo）本人，形状同 members/<slug>/
  prompt/                     ← 提示词模板
  plugins/                    ← 插件（含出厂两个：模型管理、文件树）
  settings.json               ← 模型配置
  core.sqlite                 ← 频道消息、会话、名册
  uploads/                    ← 附件
```

两个根由 `src/core/layout.ts` 拼出来 —— **拼路径只许在这一处**（ADR-030）。

加一个人 = 建一个目录。改一个人的职责 = 改一个 md 文件，**下一条消息就生效**（提示词每次
发送前重新读盘渲染）。这是整个设计的核心取舍：**语义写在文档里，代码只做机械的事**。

技术地基：`@earendil-works/pi-durable@1.5.0`（experimental，每个 minor 都可能破坏性变更；
1.4→1.5 的改动见 ADR-071）。
界面是 `ui/app/` 的 React + TypeScript，Vite 构建到 `ui/web/`（**改完界面必须 `npm run ui:build`**）。

---

## 2. 目录与五层边界

```
src/
  core/           ── 内核（domain，业务事实）──────────────────────────────
    fsx.ts          工作区内的相对路径入口（越界抛错）；全项目只有它和 runtime/io.ts 碰 node:fs
    layout.ts       两个根的全部路径（拼路径只在这里）
    naming.ts       名字 → 目录名的唯一规则（agent / 团队 / 技能共用）
    secrets.ts      密钥脱敏（渲染出口的最后一道网）；跨层安全工具，不属于任何人的档案
    runtime/io.ts   绝对路径的机械 IO（读 / 写 / 建目录 / 列表 / 串行闸 / 日志行）
    documents/      磁盘上的文档（ADR-082）：
      base/         markdown + frontmatter（doc）/ 插槽（slots）/ 提示词模板（template）/
                    文案目录（catalog）/ 记忆格式（memory）/ 记忆读写机械（memory-store）/ 压一行（oneline）
      member/       一个人：身份（identity）/ 记忆（memory）/ 记忆日志（journal）
      team/         一个团队：README（doc）/ 记忆（memory）
      skills.ts     三层技能；rules.ts 全员规矩；prompt.ts 九段提示词装配（同时认识 member 与 team）
    runtime/        防腐层：唯一能 import pi-durable / pi-ai / pi-schema / chord 的地方
                    （含 models/compaction/工具参数 schema 转发）
    channel/        说话的原语：频道规则 / 写一条 / 投递与队列 / 唤醒 / 名册（roster）/ 附件 / 后台命令（jobs.ts）/ 8 个工具（tools/）
    flow/           一条消息的一生：publish（落盘→算人→扇出→钩子）/ forward（已有消息转交）/
                    settle（答完补发 / 没答上来留痕）/ runner（投递机械）/ store / policies /
                    validate / gates；入口只有 index.ts
    plugin/         插件：清单（manifest）/ 五动作 API（api）/ 加载与隔离（load）
  app/            用例：读（快照 / 投影） / 人 / 说话 / 上传 / 后台命令收尾 / 看门狗 / 诊断 / 重置（不 import node:http）
  view/           契约层：只有 dto.ts，零 import（投影已并进 app/project.ts）
  interface/http/ 唯一 import node:http 的地方：routes / respond（原语）/ route-match（匹配）/
                  origin-guard（来源闸）/ network（网卡）/ static-assets / sse（编解码+hub）
  shell/          装配与启动：assemble（只做组合）/ wire/（七段接线）/ serve / main / seed
ui/app/           界面源码（React + TS + Vite）
ui/web/           构建产物（服务端发这个目录，别手改）
desktop/          Electron 壳（src/：拉起后端 / 开窗 / 标题栏 / 更新 / 菜单 / preload）+ 图标
electron-builder.yml  桌面端打包（mac dmg+zip / win nsis；不用 asar）
seed/             出厂内容：规矩 / 提示词模板 / 技能 / 助理身份（播种进两个根）
scripts/          九个入口脚本：check-boundaries（边界）、core-live（真模型冒烟）、
                  scenario-live（多 agent 真模型场景）、repair（改名迁移）、
                  prompt-check（提示词黄金渲染）、prompt-fixture（样例插槽表）、
                  update-server（自建更新源：只读静态目录）、update-key（更新签名密钥，跑一次）、
                  update-manifest（清单 + Ed25519 签名）；
                  公共等待器与证据落盘在 live-support.ts
test/             101 文件 / 896 例
  ├ test/core/    83 文件（纯函数 + 装配）
  ├ test/ui/      12 文件（界面纯函数与源码约定）
  └ test/desktop/ 6 文件（更新源、就绪行与更新源地址、清单验签与版本比较、安装脚本、窗口标题栏）
.solo-app/ ~/.solo/  运行时数据（gitignore）
```

（`src/` 共 116 个 ts：core 74 / app 21 / view 1 / interface 7 / shell 13；行数会漂，以 `docs/CODE.md` 的文件表为准。）

**依赖只朝一个方向**：`interface → app → domain`；`view/` 谁都不依赖（大家都能用它）；
`shell/` 是唯一可以同时 import 全部的装配层。

**三条老边界**（一开始就有，`npm run check` 机械化检查，违反即失败）：

1. **只有 `src/core/runtime/` 能 import 底层库**（pi-durable / pi-ai / pi-schema / chord）。
2. **内核（domain）不得反向 import 上层**：`documents|channel|flow|runtime` 不许碰
   `shell/` / `interface/` / `app/` / `view/`。
3. **每条路由必须在前端有消费者**（`src/interface/http/routes.ts` 的 `pattern` ×
   `ui/app/src`；白名单只有 `/api/org`，Docker 健康检查用）。加路由没人用 → 要么接上界面、
   要么删掉、要么改白名单并写清理由。

**分层后又收紧了六条**（脚本自己的编号是「六条规定」，`LAYER_RULES` 落成九组：域 / 文档基础 /
文档实现 / plugin / 根原语 / view / app / desktop / interface）：

- **`view/` 是契约层**：只有 `dto.ts`，一个 import 都不许有（投影已并进 `app/project.ts`）。
- **`app/` 不许 `node:http`**：用例要能脱离网络直接测。
- **`interface/` 只经 `app/` 与 `view/` 说话**（不许 import 领域内部实现，否则业务会再长回
  handler 里）。
- **`documents/base/` 只能往下看**：可 import `runtime/` 与 `fsx.ts`，不许够
  `member|team|skills|rules|prompt|channel|flow|plugin|app|view|interface|shell`（实现依赖基础，不是反过来）。
- **根目录原语**（`fsx.ts` / `naming.ts` / `layout.ts` / `secrets.ts`）不许 import `app|view|interface|shell`。
- **`plugin/` 只加东西**（工具 / 提示词 / 路由 / 听消息）：只能用 `documents/base/`，不许 import
  文档实现（`documents/member|team|skills|rules|prompt`）与 `app|view|interface|shell`，
  产物由 `shell/assemble.ts` 并进注册表。

另外三条容易踩的：

4. **`channel/types.ts` / `mentions.ts` / `rules.ts` 是纯函数**，不做 IO。落盘在 `channel/write.ts`；
   写一条、算人、投递编排在 `core/flow/`（主线是 `flow/publish.ts`），`channel/post.ts` 是投递门面（`createChannelFlow`）。
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
npm test             # 101 文件 896 例，<3s，必须全绿
npm run prompt:check # 提示词黄金渲染：确定性、插槽全填、每段 ≤12 行、模板里零工具名
npm run live         # 改了 agent 行为就必须跑：真实模型端到端 13 项，会花 token；连跑两次都要 13/13
npm run live:scenarios -- --rounds=1 --smoke   # 多 agent 场景脚手架检查，约 5–10 分钟
npm run live:scenarios -- --rounds=3           # 正式场景：硬场景 3/3、行为场景 2/3
```

- **`live` 的门是「两次 13/13 + 收尾（turn）趋势」**：
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
| 新增一处文件读写 | 走 `fsx.ts`（工作区相对路径）或 `runtime/io.ts`（绝对路径机械 IO）；markdown 文档再用 `documents/base/doc.ts` 的 `readDocFile` / `writeDocFile`（解析 + 落盘配对）。直接 `node:fs` 只允许 `docs/CODE.md` §1 列的五类例外 |
| 改名字校验（agent / 团队 / 技能的 slug） | `src/core/naming.ts`（唯一一份）；`test/core/naming.test.ts` |
| 改技能的层数 / 查找顺序（全员 / 团队 / 个人谁盖谁） | `docs/CORE.md` §6 + `docs/CODE.md` 的文件表 | `src/core/documents/skills.ts`（`SkillScope` 与 `listSkills` 的合并顺序）；`test/core/skills.test.ts`；界面在 `ui/app/src/panels/RightPanel.tsx` 的 `SkillsTab` / `TeamSkills` |
| 改频道成员投影 / 消息落盘 / 唤醒依赖 / 收件人 | `channel/rules.ts` 的 `projectChannel`、`channel/write.ts` 的 `appendToChannel`、`channel/roster.ts` 的 `directoryWake`、`channel/mentions.ts` 的 `recipientsOf` / `deliveryTargets` |
| 名册（slug ↔ 会话 id）怎么读、怎么落盘 | `docs/CORE.md` §1 | `src/core/channel/roster.ts` 的 `mergeDirectory` / `directoryWake`（`rememberWake` 用内存会话兜底并补映射）+ `src/shell/wire/directory.ts` 的 `now` / `save`（装配层只做调用）+ `test/core/directory-persist.test.ts`；**读的时候内存优先**，别只信落盘那份 |
| 谁是助理 / 团队里有哪些人 | `docs/CORE.md` §1 / §7 + `docs/DECISIONS.md` ADR-058 | `src/core/layout.ts` 的 `isAssistantDir`（**按路径分量判断**：Windows 分隔符是 `\`，写死 `/` 会让助理在 Windows 上消失）+ `src/core/documents/member/identity.ts` 的 `assistantsOf` + `src/core/channel/membership.ts` 的 `teamMembers` / `syncTeamChannel`（成员 = 我 + 助理 + `team:` 指向它的人；`wakeOnAll = 助理`）；**只有一个会话键：slug**（ADR-050 已被 ADR-058 取代） |
| 新进频道的人要不要被叫醒（报到） | `docs/CORE.md` §4 + `docs/DECISIONS.md` ADR-042 | `channel/membership.ts` 的 `syncTeamChannel`（返回新进成员，不含我与助理）+ `shell/wire/teams.ts` 的 `sync` / `announce` 与 `shell/wire/speak.ts` 的 `wakeTo`；文案 `seed/text/channel.md` 的 `membership.joined`；`test/core/membership.test.ts` |
| 看门狗（异常报告进频道） | `docs/CORE.md` §12 + `docs/DECISIONS.md` ADR-016 | `app/watch.ts`（`createWatch`）+ `app/diag.ts` 的 `onAbnormal` + `shell/serve.ts` 的 `start()` / `stop()`；只通报不自动救 |
| 我不 @ 人时谁接话 / 团队频道里 @ 了谁 | `docs/CORE.md` §4 + `docs/DECISIONS.md` ADR-015 / ADR-086 | `channel/rules.ts` 的 `speakerBefore` + `channel/mentions.ts` 的 `recipientsOf` / `deliveryTargets`（**团队频道：有 `@` 只叫被点名的人、助理不插话；没人 `@` 只叫助理**）+ `core/flow/defaults/router.ts` 把两者拼成决定 + `channel/delivery.ts` 的 `woken`；`test/core/mention-alias.test.ts` |
| 后台命令（`run` 的 `background`）/ 重启清孤儿 | `docs/CORE.md` §4 + `docs/DECISIONS.md` ADR-013 | `channel/jobs.ts`（起 / 记 / 收 + `sweepRunJobs`）+ `channel/tools/run.ts` 的 background 分支 + `app/runs.ts`（启动清扫）+ `core/flow/publish.ts` 的 `wakeTo`（`note` 要叫醒人只有这一条路） |
| 插件的五个动作（tool / prompt / route / on / `flow`）/ 前端插槽（`SlotName` 表）/ 装与卸 | `docs/CORE.md` §13 + `docs/DECISIONS.md` ADR-018 / ADR-019 / ADR-080 + `docs/WEB-API.md` §13.4 + `docs/DESIGN.md` §2.8 | `src/core/plugin/`（`manifest.ts` 的 `readPluginManifest` / `writePluginEnabled`、`api.ts` 的 `flow`、`load.ts` 的 `PluginHost.flow` / `brings.policies`）+ `src/core/channel/types.ts` 的策略形状 + `src/core/flow/policies.ts` 的 `policyRouter` / `policySettler` + `shell/wire/plugins.ts`（装 / 重装 + 听消息 + 策略活引用）与 `shell/assemble.ts`（`reloadPlugins` 热重装，ADR-026）+ `app/plugins.ts`（清单 + 开关 + 装 / 卸）+ `interface/http/routes.ts`（五条接口；插件接口在 `*rest` 兜底里现查）+ `ui/app/src/plugin/`（`registry.ts` 的 `SlotName` / `SLOTS` / `Slot.tsx`）+ 画插槽的六个界面文件（`sidebar/Sidebar.tsx` / `App.tsx` / `stream/Stream.tsx` / `composer/Composer.tsx` / `panels/RightPanel.tsx` / `panels/Overlays.tsx`）+ 整屏页 `panels/{SettingsPage,PluginsPage}.tsx`（设置里的「插件」一行进清单，`.nav` 抬头带返回） |
| 一条消息的字数上限（群聊 / 私聊不同） | `docs/CORE.md` §9 | `channel/tools/guards.ts` 的 `sayLimitOf` + `channel/tools/say.ts` |
| 改轨迹（切轮 / 摘要 / 步骤映射 / 接口形状） | `docs/WEB-API.md` §7.2 + `docs/DESIGN.md` §2.3 / §8.2 + ADR-001 / ADR-003 | `src/app/trace.ts`（纯函数：`groupsOf` 切轮 + `buildTurn` 映射步骤）+ `src/app/read.ts` 的 `turnsOf` + `test/core/trace.test.ts` |
| 过程画在哪儿（`live` 行 / 任务面板；聊天流**不画**过程块） | `docs/DESIGN.md` §2.3 + `docs/DECISIONS.md` ADR-046 / ADR-062 | `ui/app/src/stream/model.ts` 的 `buildRows`（不再挂 `turn`）+ `stream/Stream.tsx`（不渲染过程块）+ `stream/LiveRow.tsx` + `panels/TasksPanel.tsx`；`test/ui/stream-model.test.ts` |
| 任意组群（谁能建 / 成员 / 唤醒） | `docs/CORE.md` §4 / §7 + `docs/DECISIONS.md` ADR-063 + `docs/WEB-API.md` §3.1 | `src/core/channel/membership.ts` 的 `createGroup` + `channel/tools/chats.ts` 的 `create` + `src/app/chat.ts` 的 `createGroup` + 路由 `POST /api/channels` + `ui/app/src/{sidebar/Sidebar.tsx,panels/Overlays.tsx,state/store.ts}`；`test/core/membership.test.ts` |
| 团队频道怎么把消息给人（助理后台分发） | `docs/CORE.md` §4 / §7 + `docs/DECISIONS.md` ADR-063 | `channel/tools/route.ts` + `core/flow/forward.ts` + `channel/delivery.ts` 的 `routedBy` + `core/flow/defaults/settle.ts` 的 `saidLast`（认 `route`）+ `seed/{assistant/identity.md,skills/工作规矩/SKILL.md,text/{tools,channel}.md}`；`test/core/route.test.ts` |
| `@` 什么时候用（要回复才 @） | `docs/CORE.md` §4 | `seed/rules.md` + `seed/skills/工作规矩/SKILL.md` + `seed/assistant/identity.md`（机制不动：`parseMentions` / `recipientsOf`） |
| 聊天里的运行态（`live` 行）/ 后台任务（右栏的一态） | `docs/DESIGN.md` §1.1 / §2.3 + `docs/DECISIONS.md` ADR-046 + `docs/WEB-API.md` §4.1 / §7.2 | `ui/app/src/stream/model.ts` 的 `buildRows`（`live` 行）+ `stream/LiveRow.tsx` + `panels/TasksPanel.tsx` + `styles/tasks.css` + `state/store.ts` 的 `runs` / `tasks`（`applyTurn` 不按当前频道过滤）+ `App.tsx` 的 `data-view`；**任务是一整屏**（ADR-084）：`openTasks` 置 `right.open`，`RightPanel` 用 `data-tasks` 换成 `TasksView`，`closeTasks` 收起；`ViewTurn.trigger` 在 `src/view/dto.ts` 与 `app/read.ts` 的 `turnsOf`；`test/ui/stream-model.test.ts` |
| 改「插话回哪儿 / 一轮答完自动补发」 | `docs/CORE.md` §4 + `docs/DECISIONS.md` ADR-049 / ADR-051 / ADR-077 | `channel/turn/record.ts` 的 `WakeRecord` / `parseWake`、`core/flow/defaults/settle.ts`（`spokeAfterWake` / `saidLast` / `turnTarget` 的 `restated` / 补发前的 `duplicate` 判据）、`core/flow/settle.ts`（读答案 → 判重 → 补发，`repost` 闸在这里）、`channel/turn/report.ts`（durable 收尾的输入与任务）、`core/flow/runner.ts` 的 `wakeOf`；**补发是正常发言（要叫醒被 @ 的人）**，且**必须带名册**（`wiring.ts` 的 `roster`）：不带的话 `@我` 会以字面 token 落进 `mentions`，投递靠兜底还能叫人，落盘/接口里的「叫了谁」是错的；文案在 `seed/prompt/88-task.md` |
| 答完写回频道靠什么触发（收尾持久化） | `docs/CORE.md` §4 + `docs/DECISIONS.md` ADR-077 | `channel/turn/report.ts`（`core.turn-report` 任务 + `afterRun` 钩子，挂进 `core-tools`）+ `core/flow/settle.ts`（done 分支：判据 / 同文去重 / 补发）+ `core/flow/defaults/settle.ts`（判断）+ `shell/assemble.ts` 与 `shell/wire/conversations.ts`（挂进 `core-tools`）；`core/flow/runner.ts` 的结算回调只留「没答上来」（走 `settle({kind:"unanswered"})`），**不要再加宿主侧补发**；`channel/queue.ts` 的 `liveConversations` 不算收尾任务与只等收尾的生成（否则紧随其后的消息被当成插话）；`test/core/{turn-report,turn-report-e2e,crash-turn-report}.test.ts` |
| 合并唤醒（谁该让路） | `docs/CORE.md` §8 + `docs/DECISIONS.md` ADR-048 | `channel/queue.ts` 的 `queuedAhead` / `coalesceQueue`（同一会话只留一个未开始项）+ `core/flow/runner.ts` 的 `enqueue` + 签名透传（`publish.ts` / `runner.ts` / `shell/assemble.ts` / `shell/wire/conversations.ts`）；`test/core/queue-jump.test.ts` |
| 同进程的写并发（要不要自己串行 commit） | `docs/DECISIONS.md` ADR-073 + `docs/CONCESSIONS.md` C-010 | 底座 group commit 管同一文档的 commit；`openCore` 直接用裸 harness（**没有** `serializedHarness` 了）。`core/flow/publish.ts` 取 `gate.publish` 保护 commit **之前**的读—算—提交，`core/flow/settle.ts` 取 `gate.repost` 防两次收尾各补一遍（两把闸的进程级默认实现在 `core/flow/gates.ts`），**别顺手删**；`test/core/commit-concurrency.test.ts` |
| 记 wake 与入队要不要原子（唤醒竞态） | `docs/DECISIONS.md` ADR-076 | `channel/roster.ts` 的 `rememberWakeTx` + `channel/wiring.ts` 的 `wakeTogether` + `core/flow/runner.ts` 的 `enqueue`（先写文档、再 `conversation.submit(tx, draft)`，commit 后用 `harness.submission(id)` 取回句柄）；**准入是这次 commit 的第一次表写，之后不能再读表**；`publish.ts` / `turn/finish.ts`（补发）/ `tools/context.ts` / `shell/assemble.ts` 只做透传；`test/core/wake.test.ts` |
| 建频道 / 私聊 / 一个人跑过的轮次 | `docs/CORE.md` §4 + `docs/WEB-API.md` + `docs/DESIGN.md` §2.3 | 建频道只有 `channel/membership.ts` 的 `ensureOwnerDm`（装配 / 招人自动建）+ `POST /api/people/:slug/dm`；一个人的轮次是 `app/read.ts` 的 `readPersonTurns`（`limit`）+ `ui/app/src/panels/TasksPanel.tsx`（右栏资料表最后一行「后台任务」）；聊天流里不画过程 |
| 团队频道的详情 / 团队记忆（`GET /api/teams/:slug`） | `docs/WEB-API.md` §10.1 + `docs/DESIGN.md` §1.2 / §5 | `src/app/teams.ts` + `interface/http/routes.ts` + `ui/app/src/panels/RightPanel.tsx`（`TeamSection` / `TeamMemory`）；团队记忆只读，写入口是 `remember(scope=team)` 与 `file` |
| 建团队权限校验 | `docs/CORE.md` §7 + `docs/CODE.md` §3 | `documents/team/doc.ts` 的 `createTeamProblem` + `channel/tools/file.ts` 写分支；校验在落盘之前；开新团队只有助理能做（ADR-058，没有 `lead`） |
| 「没答上来」的留痕 | `docs/CORE.md` §4「结算即收尾」 | `core/flow/runner.ts` 的 `enqueue` 结算回调（`aborted`（合并唤醒）与 `nothing_to_answer` 不留痕）→ `core/flow/settle.ts` 的 `unanswered` 分支只写一行 `note`、不进 `repost` 闸；`test/core/{wake,flow-settle}.test.ts` |
| 失败可见（`runFailure` / 失败卡 / 原因文案 / 继续按钮） | `docs/CORE.md` §9 + `docs/DESIGN.md` §8 + `docs/WEB-API.md` §2 / §10.4 + `docs/DECISIONS.md` ADR-072 / ADR-075 | `src/core/channel/unanswered.ts`（原因表 + `detail` 裁剪）、`core/flow/runner.ts` 的 `WakeNote` / `noteUnanswered`、`seed/text/channel.md`、`src/app/diag.ts` 的 `reportLabel`、`src/app/read.ts` 的 `liveOf` / `liveMaps`、`src/view/dto.ts` 的 `ViewLastFailure`、`src/interface/http/sse.ts` 的 `orgSignature`、`ui/app/src/panels/TasksPanel.tsx` + `ui/app/src/styles/tasks.css`；「继续」走 `app/people.ts` 的 `continuePerson` + `POST /api/people/:slug/continue` + `ui/app/src/api/client.ts`；`test/core/{unanswered,wake,diag}.test.ts` |
| 重启打断的那一轮要不要接着做 | `docs/CORE.md` §4 + `docs/DECISIONS.md` ADR-044 / ADR-074 | `runtime/open.ts` 的 `inspectStartup` 返回值（`CoreRuntime.interrupted` / `backlog`）+ `shell/wire/teams.ts` 的 `noteInterrupted` 与 `shell/assemble.ts` 的 `harness.resume()` / `continue`（最后一步）+ `shell/main.ts` 传参；文案 `seed/text/channel.md` 的 `turn.interrupted`；`test/core/{resume,reconcile,crash-replay}.test.ts`（后者真 `kill -9`，fixture 在 `test/fixtures/crash-*`） |
| 新增/修改真模型脚本（`scripts/*-live.ts`、`live-support.ts`） | 本文件 §2 + `docs/CODE.md` 目录与 §3 + `package.json`；等待器只放 `live-support.ts` |
| 改提示词模板 / 加一段 / 加一个插槽 | `docs/design/SEED-CONTRACT.md` §3 插槽表 + `scripts/prompt-fixture.ts` 样例值 + `docs/CODE.md` §2 文件表；跑 `npm run prompt:check` |
| 改工具描述 / 参数说明 / 拒绝话术 / 投递头 / 附件说明 | `docs/DECISIONS.md` ADR-039 + `docs/design/SEED-CONTRACT.md` §1 | **改 `seed/text/*.md`，不改代码**（键名照旧的照旧）；代码里加一处新文案就加一个键；改完**重启**（工具描述装配时定型）；`test/core/no-hardcoded-text.test.ts` 会拦代码里的中文 |
| 改 seed 出厂内容（规矩 / 技能 / 助理身份） | `docs/design/SEED-CONTRACT.md` + `test/core/seed-contract.test.ts`（一条事实一个家、≤15 条、零工具名、技能 ≤4 KB） |
| 概念（组织怎么表示、提示词怎么来、记忆怎么进） | `docs/CORE.md` |
| HTTP 接口字段 | `docs/WEB-API.md`（**先改文档，再改代码**） |
| 头像的画法 / 取景 / 配色 / 尺寸 | `docs/DESIGN.md` §6.5 + `docs/DECISIONS.md` ADR-083 + `docs/WEB-API.md` 的 `/api/avatar/:seed` | 插画：`src/app/avatar.ts`（唯一的画法，纯函数）+ `ui/app/src/lib/avatar.ts`（种子与尺寸）+ `test/core/avatar.test.ts`；**助理例外**：`assistant: true` 画 `ui/app/src/lib/brand.ts` 的标识（与 `desktop/icon.svg` 同形），传参在各调用点的 `assistant` 标记；名字在 `seed/assistant/identity.md`，旧安装由 `src/shell/migrate.ts` 只改 `name`（slug 不动） |
| 一列到底的骨架（列表 / 对话 / 资料 / 整屏页） | `docs/DESIGN.md` §13.1 / §13.3 / §13.7 + `docs/DECISIONS.md` ADR-084 | `ui/app/src/App.tsx`（单列 + `body[data-pane]`；助理那屏的门、别的对话的返回 / 资料）+ `panels/RightPanel.tsx`（`.detail` 固定整屏、一张平铺表、`data-tasks` 切 `TasksView`；`rightPanel.tab` / `rightPanel.detail` 插槽宿主）+ `panels/TasksPanel.tsx` + `state/store.ts`（`openTasks` / `closeTasks`；`bootstrap` 首屏开助理私聊）+ `panels/{SettingsPage,PluginsPage}.tsx`（一列卡片 + `.nav`）+ `styles/shell.css`（`.frame` 单列、860 居中、`body[data-pane]`）+ `lib/brand.ts`；`test/ui/{layout,second-screen,plugin,titlebar}.test.ts` |
| 界面布局 / 行类型 / 轨迹展示 / 手机与桌面的摆法 | `docs/DESIGN.md`（决策稿：改之前先说明原决策错在哪；§13 是「一份内容表、两套摆法」与稿子的位置）+ 本文件 §2 的「不画后端没有的东西」 |
| 第一次打开 / 接上模型（稿子 10–12） | `docs/DECISIONS.md` ADR-085 + `docs/WEB-API.md` §13.7 + `docs/DESIGN.md` §13.9 | `src/app/setup.ts`（`check` 只探并回模型清单、`save` 写 `settings.json` 并 `refreshModels`）+ `src/interface/http/routes.ts`（`POST /api/setup`、`/api/setup/probe`）+ `ui/app/src/panels/SetupPage.tsx` + `state/store.ts` 的 `bootstrap` / `setupStep` + `stream/Starters.tsx` + `styles/onboarding.css`；判据只有一个：`GET /api/models` 是空数组 |
| 启动参数 / 部署方式 / 模型接入（含给某个人换模型、改配置不用重启） | `docs/DEPLOY.md` §3 + `docs/DECISIONS.md` ADR-023 / ADR-024 / ADR-025 | `src/core/runtime/models.ts`（`setupModels` / `syncModels` / `parseModelRef`）+ `shell/wire/models.ts` 的 `modelFor` / `refreshModels` + `app/people.ts` 的 `setPersonModel` + `app/models.ts` 的 `list` + 界面在出厂插件 `seed/plugins/模型管理/`（`rightPanel.detail` 插槽） |
| 更新代理（设置 → 更新；只给下载安装包用，模型不走） | `docs/DECISIONS.md` ADR-087 + `docs/WEB-API.md` §13.8 + `docs/DEPLOY.md` §10 | `src/app/preferences.ts` + `core/runtime/settings.ts` 的 `updateProxy` + 路由 `GET/POST /api/preferences` + `ui/app/src/panels/SettingsPage.tsx` 的 `UpdateProxyRow` / `api/client.ts`；桌面 `desktop/src/update-proxy.ts` 的 `readUpdateProxy` + `updates.ts` 的 `fetchUpdate`（独立 `solo-update` 会话）+ `main.ts` 传 `settingsFile`；`test/core/preferences.test.ts`、`test/desktop/update-proxy.test.ts` |
| 桌面壳 / 打包 / 自动更新 / 更新源 | `docs/DEPLOY.md` §9–10 + `docs/DECISIONS.md` ADR-027 / ADR-028 / ADR-029 / ADR-068 / ADR-070 / ADR-087 | `desktop/src/`（`main.ts` / `backend.ts` / `ready-line.ts` / `updates.ts` / `update-proxy.ts` / `manifest.ts` / `install.ts` / `update-key.ts` / `feed.ts` / `menu.ts`）+ `electron-builder.yml` + `scripts/update-server.ts` / `update-key.ts` / `update-manifest.ts`；壳与后端只靠 `[core] http://…` 一行说话，不 import 内核与界面源码；更新是「清单验签 → zip → 进程外替换」，不是 Squirrel；包体积裁剪见 ADR-068（`files` 排除项 / `electronLanguages` / `compression`，`react` / `react-dom` 在 devDependencies） |
| Windows 标题带 / 菜单（自绘） | `docs/DESIGN.md` §1.1 / §9.1 + `docs/DECISIONS.md` ADR-069 + `docs/DEPLOY.md` §10 | `desktop/src/window-chrome.ts`（`hidden` + 40px `titleBarOverlay`；macOS 返回 `{}`，用系统标题栏，ADR-088）+ `desktop/src/preload.cts`（只开 `solo:menu` / `solo:theme`）+ `desktop/src/main.ts` 的 `setupBridge` / `setMenuBarVisibility(false)` + `desktop/src/menu.ts`（原生菜单只留加速键）+ `ui/app/src/titlebar/`（`Titlebar.tsx` / `menu.ts`）+ `ui/app/src/main.tsx` 的 `data-os` + `App.tsx` 的 `windowsShell` 与主题同步 + `styles/shell.css` 末尾；**macOS 用系统标题栏，界面不为红绿灯让位**（`[data-os="darwin"]` 的补偿规则已删，ADR-088）；窗口真机行为要在 Windows 上手工验收 |
| 界面首页 404 / 静态资源目录（`ui/web` 在哪） | `docs/DEPLOY.md` §10 + `docs/CODE.md` §2.3 | `src/shell/serve.ts` 的 `defaultUiDir`（**必须用 `fileURLToPath`**：Windows 上 `URL.pathname` 是 `/C:/…`，`path.join` 之后读不到 `index.html`，窗口里只剩 `{"error":"未找到"}`）+ `test/core/serve.test.ts`；Windows 打包前跑 `npm test` |
| 发版（GitHub Actions）/ 更新源指向 Releases | `docs/DEPLOY.md` §9–10 + `docs/DECISIONS.md` ADR-067 | `.github/workflows/release.yml` + `desktop/src/feed.ts` 的 `DEFAULT_FEED_URL` + `scripts/update-manifest.ts`；标签必须等于 `v<package.json version>`，签名私钥在仓库 secret `SOLO_UPDATE_KEY`；顺序是检查 → 打包 → draft → 二进制 → 清单 → 正式发布；Windows 打包前再跑一遍 `npm test`（`defaultUiDir` 这类平台差异只有 Windows 会露） |
| 消息 `kind`（只有 `chat` / `note`；旧数据的语义标签在投影层归一） | `docs/CORE.md` §4 + §9 + `docs/WEB-API.md` 的消息 `kind` 说明 |
| 术语改名（项目→团队、公司→全员、`owner` 只在内部保留） | `docs/CORE.md` + `docs/CODE.md` 的路径 + `docs/WEB-API.md` 的字段名 + 本文件；词表：我 / 助理 / 团队 / 成员 / 全员；项目叫 Solo |
| 删掉界面上看得见的东西（过程投影 / 占位 / 「正在说」草稿 / 系统留痕） | `docs/CORE.md` §9 + `docs/WEB-API.md` 的消息字段与 SSE 事件表 + `docs/DECISIONS.md`；留痕不画见 ADR-047，落在 `ui/app/src/stream/model.ts` 的 `buildRows` + `test/ui/stream-model.test.ts` |
| 撞上 pi-durable 做不到的事、或为它写了绕路代码 | `docs/CONCESSIONS.md` 追加一行（只追加；处理完写「已处理 + 日期」） |
| 两个根（应用私有 / 用户根）/ 加一个要落盘的目录 | `docs/DECISIONS.md` ADR-030 + `docs/CODE.md` §1 | `src/core/layout.ts`（**拼路径只在这里**）+ `scripts/check-boundaries.mjs` 的根原语组 + `test/core/layout.test.ts`；不许在业务模块里 `dirname` 推路径 |
| 加 / 改一个频道给的「工作区」（插件用） | `docs/DECISIONS.md` ADR-036 + `docs/WEB-API.md` §13.4 | `src/core/plugin/api.ts` 的 `PluginScope` / `scope()` + `shell/wire/plugins.ts` 的 `channelScope`；**路径守卫留在插件里**，核心只给根 |
| 插件要按 token / 成本算账（读审计日志） | `docs/DECISIONS.md` ADR-064 + `docs/CORE.md` §13 + `docs/WEB-API.md` §13.4 | `src/core/plugin/api.ts` 的 `logsRoot` + `load.ts` / `shell/wire/plugins.ts` 传 `layout.logsRoot` + `app/audit.ts` 记齐 `in/out/cache/write/cost`；出厂消费者 `seed/plugins/Token统计/`，`test/core/token-plugin.test.ts` |
| 加一个应用级入口 / 插槽 | `docs/DESIGN.md` §13.3 / §2.8 + `docs/DECISIONS.md` ADR-084 | `ui/app/src/plugin/registry.ts` 的 `SlotName` / `SLOTS` + 宿主 `panels/SettingsPage.tsx`（`rail.item` 在设置页的 `.set-tools` 里画成一行）；出厂「Token 统计」用它（入口 `rail.item`、整屏页 `app.page`）；`test/ui/plugin.test.ts` 会查每个插槽都有宿主 |
| 等我选的消息（`options`）/ 输入卡的选项卡 | `docs/CORE.md` §4 + `docs/WEB-API.md` §6 | `channel/tools/say.ts`（2–6 个、去重、自动 @我）+ `channel/types.ts` / `rules.ts` / `write.ts` / `post.ts` + `ui/app/src/composer/choice.ts`（纯函数）+ `Composer.tsx`；**回答不新增路由**（ADR-035） |
| 附件预览（内联还是下载） | `docs/DECISIONS.md` ADR-037 + `docs/WEB-API.md` §13 | `app/uploads.ts` 的 `read({preview})` + `routes.ts` 的 `?preview=1` + `ui/app/src/stream/AttachmentPreview.tsx`；**按真实 mime 发 `Content-Type`，HTML 永远 `text/plain`** |
| 解散团队 / 开除成员 / 删团队目录 | `docs/CORE.md` §7 + `docs/DECISIONS.md` ADR-033 | 解散 = 团队 README 的 `status: archived`（`documents/team/doc.ts` + `syncTeam`）；团队目录被删 → 启动时 `channel/membership.ts` 的 `archiveGoneTeams` 归档频道，运行时 `shell/serve.ts` 的 `startTeamReconcile` 监听 `teams/` 立刻对账，投影时 `app/project.ts` 的 `withoutGoneTeams` 再按磁盘团队表过滤；开除 = `hire` 的 `action=fire`（移进 `members/.retired/`，不删；私聊归档，重新招回来由 `ensureOwnerDm` 的 `replace` 恢复）；都不开新工具 |
| 一键重置（设置 → 数据）/ 清空历史 | `docs/WEB-API.md` §13.5 + `docs/DESIGN.md` §1.5 + `docs/CODE.md` + `docs/DECISIONS.md` ADR-089（取代 ADR-065） | `src/app/reset.ts` 的 `wipeAll`（**库关掉之后才删**；`settings.json` / `.secrets.json` 也删，重开进引导页）+ `interface/http/routes.ts` 的 `POST /api/reset` + `src/shell/main.ts` 的 `resetAll`（关库 → 删盘 → 退出码 75）+ `desktop/src/backend.ts` 的 `onExit` / `desktop/src/main.ts` 的 `restart` + `ui/app/src/panels/SettingsPage.tsx` 的 `DataSection`；`test/core/reset.test.ts` |
| 装完带前端的插件问要不要重启 | `docs/WEB-API.md` §13.4 / §13.6 + `docs/DESIGN.md` §2.8 + `docs/DECISIONS.md` ADR-066 | `interface/http/routes.ts` 的 `POST /api/restart` + `shell/serve.ts` 的 `onRestart` + `shell/main.ts` 的 `restartApp`（关库 → 退出码 75）+ `ui/app/src/panels/PluginsPage.tsx`（装完按 `client` 决定弹不弹）/ `panels/Overlays.tsx` 的 `RestartSheet` / `state/store.ts` 的 `restartOpen` / `api/client.ts` 的 `restartApp`；桌面壳 `desktop/src/main.ts` 的 `restart`；`test/core/reset.test.ts` |
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
| 加一个工具（能力） | `docs/CODE.md` §3 | `src/core/channel/tools/`：一个工具一个 builder 文件 + 登记进 `index.ts` 的 `createCoreTools`（8 个；同一件事加 `action`，别开新名字） |
| 教 agent 一套做法 | `seed/skills/` 里现成的技能 | **写 `seed/skills/<名字>/SKILL.md`，不要写代码** |
| 改提示词 | `docs/CODE.md` §3 + `docs/design/SEED-CONTRACT.md` | **改文案写 `seed/prompt/NN-段名.md`**（代码只排版，`src/core/documents/base/template.ts` 只剩排版）；加插槽要先登记 §3 并在 `scripts/prompt-fixture.ts` 给样例值 |
| 加身份字段 | `docs/CORE.md` §1 | `src/core/documents/member/identity.ts` 的 `IdentityHeader` |
| 改谁能被 @ 到 / 谁被叫醒 | `docs/CORE.md` §4 | `src/core/channel/mentions.ts` 的 `recipientsOf` / `parseMentions` |
| 改「这条会话算私聊还是群聊」 | `docs/CORE.md` §4 | `src/core/channel/types.ts` 的 `chatKind`（只看成员表） |
| 改频道成员怎么来 | `docs/CORE.md` §4 | `src/core/channel/membership.ts` 的 `joinTeamChannel` / `syncTeamChannel` / `addToAllChannel` |
| 加一条 HTTP 路由 | `docs/WEB-API.md` | `src/interface/http/routes.ts` 的 `routes` 表 + `app/` 一个用例 + `ui/app/src/api/client.ts` 的消费者 |
| 改界面 | `docs/DESIGN.md` + `docs/WEB-API.md` + `docs/CORE.md` §9 | `ui/app/`，改完 `npm run ui:build`；后端字段先改 `src/view/dto.ts`；新元素必须在 DESIGN §8 的数据来源表里指到字段 |
| 改团队记忆 | `docs/CORE.md` §8 | 机制在 `src/core/documents/team/memory.ts`；写入口是 `remember(scope=team)` 与 `file`（**没有自动沉淀了**，ADR-058） |
| 换 / 升级 pi-durable | `docs/research/02-pi-durable` | `src/core/runtime/` + `test/core/` + 一条新 ADR |
| 部署 / 排障 | `docs/DEPLOY.md` | — |

---

## 6. 上手三条命令

```bash
npm install
npm start                          # http://127.0.0.1:7788
npm run check && npm test          # 改完必跑
```

`~/.solo` 与 `.solo-app/` 是真实数据，做实验前先用 `--app-root /tmp/x-app --user-root /tmp/x-home` 另起一套。
