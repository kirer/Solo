# 代码地图

要改某个东西，该动哪个文件。**概念**见 [CORE](CORE.md)，**接口字段**见 [WEB-API](WEB-API.md)。

## 1. 分层与边界

```
src/core/
  fsx.ts          工作区内的相对路径入口（越界抛错）；与 runtime/io.ts 是唯二碰 node:fs 的地方
  naming.ts       名字 → 目录名的唯一规则（agent / 团队 / 技能共用）
  md/             文档流水线：doc.ts（markdown + frontmatter）/ text.ts（插槽渲染）/
                  prompt.ts（提示词拼段）/ oneline.ts（压成一行）
  runtime/io.ts   绝对路径的机械 IO：读 / 写 / 建目录 / 列表 / 串行闸 / 日志行
  runtime/        防腐层：唯一能 import @earendil-works/* 的地方（openCore / models / serialize）
  agent/          一个人：身份 / 提示词 / 记忆 / 技能 / 名册
  team/           一个团队：README.md / memory.md / 自动沉淀
  channel/        说话：频道规则 / 写一条 / 投递与队列 / 唤醒 / 附件 / 7 个工具（tools/）
  plugin/         插件：`workspace/plugins/<slug>/` 的清单、四动作 API、加载与隔离
  app/            用例：读（含投影） / 人 / 说话 / 上传 / 诊断（不 import node:http）
  view/           契约层：只有 `dto.ts`，零 import（投影已并进 `app/project.ts`）
  interface/http/ 唯一 import node:http 的地方：路由表 / 原语 / 匹配 / 来源闸 / 网卡 / 静态资源 / SSE
  shell/          装配与启动：assemble / main / serve / seed
ui/app/           界面源码（React + TS + Vite；构建产物 `ui/web/`）
seed/             出厂内容：`rules.md` / `prompt/`（插槽模板）/ `skills/`（全员层）/
                  `plugins/`（示范插件）/ `agents/assistant/`（助理身份 + 个人技能）
scripts/          六个入口脚本：边界检查、真模型冒烟（core-live）、多 agent 真模型场景
                  （scenario-live）、team 改名迁移、提示词黄金渲染、渲染样例插槽表；
                  真模型共用等待器/证据在 live-support.ts
```

**五个层，依赖只能朝一个方向**：

```
interface  →  app  →  domain（agent | channel | team | runtime）
     ↘         ↓
       view（契约层：只有 dto.ts，零 import）
shell = 装配层，唯一可以同时 import 全部
```

**三条边界**（一开始就有，`scripts/check-boundaries.mjs` 机械化，违反即 `npm run check` 失败）：

1. 只有 `src/core/runtime/` 能 import pi-durable / pi-ai / chord。
2. 内核（`agent|team|channel`）不得反向 import `shell/` —— 依赖只能 `shell → 内核`。
3. `interface/http/routes.ts` 的每条「方法 + 路径」必须在 `ui/app/src` 里有消费者（白名单：
   `GET /api/org`，Docker 健康检查用；`POST /api/people/:slug/dm`，界面入口下一轮接）。
   同路径的 GET 不能替没人调过的 POST 顶包。

**分层重构后同一脚本又收紧了五条**（它文件头自己编号是「六条规定」；`LAYER_RULES` 落成
**七组**：域 / md / plugin / 根原语 / view / app / interface —— 多出来的是把第 2 条扩成「域也不许向上够
`app` / `view` / `interface`」，以及给根目录补的两条）：

4. **`view/` 是契约层**：只有 `dto.ts`，一个 import 都不许有（投影已并进 `app/project.ts`；
   检查脚本第 2 组的目标仍是 `src/core/view/`，合并后目录里只剩这一个文件）。
5. **`app/` 不许 import `node:http`** —— 用例要能脱离网络被直接测试。
6. **`interface/` 是唯一碰 `node:http` 的地方**，但它只许经 `app/` 与 `view/` 说话：
   不许 import `agent|channel|team|runtime` 的内部实现（否则业务会再长回 handler 里）。
7. **`md/` 只能往下看**：可以 import `runtime/` 与 `fsx.ts`，不许 import
   `agent|team|channel|app|view|interface|shell`。
8. **根目录两个原语**（`fsx.ts` / `naming.ts`）不许 import `app|view|interface|shell`。
9. **`plugin/` 只加东西**（工具 / 提示词 / 路由 / 听消息）：不许 import `agent|team|app|view|interface|shell`。
   它的产物由 `shell/assemble.ts` 并进注册表，插件自己不认识装配。

**直接 `node:fs` 只有五类例外**（其余一律走 `fsx.ts` 或 `runtime/io.ts`）：

1. 二进制上传与清理 —— `channel/attachments.ts`
2. 播种时的递归拷贝 —— `shell/seed.ts`
3. 静态资源流式发送 —— `interface/http/static-assets.ts`、`interface/http/routes.ts`
4. 同步读配置 —— `agent/secrets.ts`、`runtime/models.ts`
5. 技能目录复制 —— `agent/skills.ts`

## 2. 全量文件（`src/core` 下 84 个 ts，13161 行；行数会漂，以表里的职责为准）

| 文件 | 行数 | 里面有什么 |
| --- | --- | --- |
| `fsx.ts` | 111 | `createFsx(root)` → `{read / write / list / exists / remove}`，路径一律相对工作区，越界抛 `FsxEscapeError`；`resolveIn` / `resolveInOrUndefined` 是路径闸（工具写盘也用它）；列表用**码点**排序（`localeCompare` 跟机器 locale 变，会打穿 prompt cache）；读不到返回 `undefined`（缺席是常态），写失败才抛 |
| `naming.ts` | 71 | `assertName(value, kind)` / `isSafeName` / `slugifyName` / `skillDirName` —— agent、团队、技能的名字规则只有这一份；`owner` 只对 agent 保留 |
| `md/doc.ts` | 125 | `parseDoc` / `renderFrontmatter` / `frontOf`，以及文件级的一对 `readDocFile` / `writeDocFile`（读文件→解析、头+正文→写盘）—— identity / 团队 README / SKILL / rules / memory 全是 `{path, front, body}`；原 `agent/frontmatter.ts` 已并进来。头只认单行 `key: value`（多行值不解析也不丢）；读入统一换行 |
| `md/text.ts` | 146 | `renderSlots`（返回 `{text, issues}`，装配层要区分两种错）/ `renderTemplate`（只返回文本的便捷壳）/ `slotsIn` / `hasSlot` / `toolSlots`（delivery 段没有注册表可查，`{{tool:say}}` 按后缀自解释——名字写错不报错，靠 seed 侧检查兜）；`unknown`（模板写了、装配没给 = 缺陷）与 `unset`（给了、现在确实是空 = 事实）分开报；`{{x ?? 默认句}}`：空时用模板自带的句子、不报 `unset`（作者已替这个空做过决定）；不二次展开、纯函数 |
| `md/prompt.ts` | 183 | `loadTemplates` / `renderPrompt` / `renderPromptDir` / `promptDirOf`：文件名 `NN-段名.md` 定序（不合法直接抛，顺序是语义）；`skip-empty` 为空则整段消失；`use: delivery` 不进系统提示词；`default:` 是 delivery 片段正文被删空时的兜底句（和正文住同一个文件）；模板缓存只允许落在 async 边界上，不跨轮复用 |
| `md/oneline.ts` | 22 | `oneLine(text, max)` 折成一行 + 超长截断；`excerptOf(text, max)` 取第一行非空再压 —— 频道摘要、投递预览、团队记忆、界面副标题共用 |
| `runtime/index.ts` | 36 | 防腐层再导出：`BACKGROUND_CONTEXT` / `createRegistry` / `defineDoc` / `defineTool` / `openCore` / `setupModels` / `compactionSettings` / `Type` |
| `runtime/open.ts` | 382 | `openCore({databasePath, models, registry, settings?, onReport?}) → {harness, registry, close}`；open 之后先跑 `reconcileZombieTasks()`；`onReport` 把底座的错误出口接成 `RuntimeReport` |
| `runtime/models.ts` | 272 | `setupModels()`：读 `settings.json` 的 `providers` 数组 → `createProvider` → `setProvider`；没有就回落到环境变量，再没有就是**没有模型**（`defaultModel: undefined`，ADR-023，不悄悄兜底本地网关）。`contextWindow` 取自 pi-ai 的模型目录，取不到回落 `FALLBACK_CONTEXT_WINDOW = 128 * 1024`；`compactionPolicyFor` / `compactionSettings` 按窗口算压缩阈值（reserve 15%、keepRecent 10% 底 8192、background 5%），并按 `provider/model` 出 overrides |
| `runtime/io.ts` | 153 | 绝对路径的机械 IO：`readTextOrUndefined`（读不到就是 `undefined`，不抛）/ `writeTextAt`（自动建父目录）/ `writeBytesAt`（二进制，同样建父目录）/ `ensureDir` / `existsAt` / `removeDirAt` / `mtimeOrUndefined` / `stampOf`（`mtimeMs:size` 变更戳）/ `appendJsonLine`（可按大小轮转）/ `listDirSorted` / `compareCodePoints` / `byName`（名字排序比较器）/ `createSerialGate`（同一把串行锁）—— 全仓只有这一份 |
| `runtime/serialize.ts` | 59 | `serializedHarness()` —— 同一进程里所有 `harness.commit` 排队跑（底座的文档代理是按读集覆盖，不排队就会互相吃掉） |
| `agent/identity.ts` | 224 | `parseIdentity` / `renderIdentityFile` / `readIdentity` / `writeIdentity` / `readAllIdentities` / `reportsOf` / `chainUp` / `managerOf` —— 身份的**读与写都在这里**；招人也在：`uniqueSlug` / `createAgent`（写身份交给 `writeIdentity`；没给正文就写空字符串，不合成任何身份文案）/ `nameOf` / `labelsOf`（slug → 显示名）；头字段只四个：`name` / `title` / `manager` / `team`；`OWNER_SLUG = "owner"` |
| `agent/rules.ts` | 41 | `loadRules()` / `renderRulesSection()` —— 读 `<workspace>/rules.md` 并排成「## 规矩」一节；缺文件 = 整段不出现 |
| `agent/sections.ts` | 382 | `agentSections()`（**async**）—— 每段一个 section key（`<slug>-<segment>`、`tag:false`）；`slotsFor()` 只填**这段模板真用到的**插槽（保住按段懒读）；`registeredTools()`（从注册表实拍工具清单）、`renderAgentSection()`（每次重读盘，含 `rules.md`；出口统一 `redact`） |
| `agent/memory.ts` | 295 | `readMemory` / `sectionsOf` / `appendMemory` / `writeMemory` / `memoryDigest` / `memoryTimeline` / `entryProblem`；`MEMORY_FILE="memory.md"`、`DIGEST_LIMIT=12`、`MEMORY_LIMITS={entry:300, main:4_000}`；写入去重 + 串行 + 记一笔 journal |
| `agent/journal.ts` | 49 | `appendJournal()` —— `<agentDir>/.memory-journal.jsonl` 追加一行 JSON（谁、何时、append/replace、before/after 全文）；失败只 warn |
| `agent/secrets.ts` | 100 | `loadSecrets` / `redactor` / `redact` —— 读 `<workspace>/.secrets.json`，把密钥的三种形态（原值 / JSON 转义 / URL 编码）从文本里抹掉 |
| `agent/skills.ts` | 210 | 三层技能（全员 → 团队 → 个人，下层覆盖上层）：`listSkills` / `listTeamSkills` / `readSkill` / `writeSkill` / `writeAllSkill` / `copySkillDir`；`SKILL.md` 的读写走 `readDocFile` / `writeDocFile`，目录名走 `skillDirName` |
| `agent/roster.ts` | 127 | `DirectoryDoc`、`conversationFor` / `slugFor` / `wakeOf` / `labelIn` —— 名册是缓存，不是真相；`plainDirectory` / `directoryWake` 是唤醒依赖的唯一来源 |
| `team/doc.ts` | 232 | `teams/<slug>/README.md` 的读写（走 `readDocFile` / `writeDocFile`）；`TeamDoc{slug,name,lead?,doing?,status,body}`、`membersOfTeam()`、`leadProblem()`（lead 必填 / 必须在名册 / 不能是助理）、`createTeamProblem()`（新团队只有助理能开）、`teamOf` 的名字缺省退回正文 `# 标题`；`assertTeamSlug()` → `assertName(_, "team")`（读宽容、写严格）；`teamSlugOfReadmePath()` 给 `file` 判断「这次写的是不是团队说明」 |
| `team/memory.ts` | 151 | `teams/<slug>/memory.md` + `settleCandidates()`（不按 `kind` 筛，只排除整理者自己）/ `renderSettlePrompt(template, team, candidates)`（**只做排版**：候选排成 `{{candidates}}`、填 `{{team}}` `{{pending}}`，判据在 `seed/prompt/95-settle.md`） |
| `team/settle.ts` | 263 | 自动沉淀：`settleProject` 已改名 `settleTeam` / `settleTarget`；单游标（问完只记 `waiting`，记忆文件 mtime 变了才推进；等待期间来了新消息会重问、投递失败不记 `waiting`、唤醒记 wake）；走 `wake()` 而不是直投；**模板缺了就不问**（warn + 游标不推进，等模板补上下次再问）；失败时往团队频道留一条 `note`（`appendTeamNote`） |
| `channel/types.ts` | 157 | 频道的数据形状：`ChannelDoc`（增量满 64 条压基线，长频道满 16 条）/ `Attachment` / `Message` / `Channel` / `ChannelState` / `emptyChannelState` / `OWNER` / `dmId` / `teamId` / `chatKind`（**只认 `dm:` 前缀 + 恰好 `{我, 一人}`**，其余一律群聊） |
| `channel/mentions.ts` | 159 | `@` 解析与收件人：`parseMentions` 只排除 ASCII 字母数字与邮箱符号（中文紧贴 @ 也认）/ `hasMentionToken` / `recipientsOf`（成员过滤 + 「没 @ 人时第一个成员接」+ `wakeOnAll`）/ `deliveryTargets`（收件人减掉我）/ `MentionRoster` / `mentionRosterOf` / `resolveMention`：别名只认 `slug` / `name` / `我` / `owner` **精确匹配**（`@CEO`、拼音、title、`@老板` 一律丢弃） |
| `channel/rules.ts` | 240 | 频道的**纯规则**：`readMarkOf` / `unreadCount` / `fallbackChannelId`（只找最近活跃的群；一个群都没有就回落 `dm:owner-<slug>`）/ `channelsOf` / `appendMessage` / `projectChannel`（成员投影唯一入口：create / merge / replace）/ `ensureChannel`（= create）/ `upsertChannel`（= merge）/ `markRead` / `tail`。接力上限（原 `relayLimit` / `botHopsSinceOwner`）已删，改由 `rules.md` 第 13 条约束 |
| `channel/write.ts` | 89 | `appendToChannel()` —— **消息落盘**的唯一实现（频道存在性、`nextSeq` 自愈、按路径 push）；`appendNote()` 系统留痕；只落盘，不叫醒人 |
| `channel/post.ts` | 185 | `postMessage()` 写一条 + 唤醒（落库与唤醒必须成对）；串行闸；`PostDeps` / `PostInput`。落盘交给 `write.ts`，逐条投递交给 `dispatch.ts` |
| `channel/dispatch.ts` | 257 | `deliver()`（唯一跨 agent 原语）：逐条投递、两层唤醒记录、合并唤醒、失败通报；`DeliverResult` / `DeliverIssue` / `DeliverOptions` |
| `channel/delivery.ts` | 273 | 投递正文的**排版**：`renderDelivery` / `renderReplyRules` / `digestRows` / `digestNotice` / `deliveryPrompt`（reply / interrupted / settle 三份系统模板 + 八个 delivery 片段；`alone` / `shared` / `colleagues` 带模板自写的 `default:` 兜底句）/ `mergedNotice`。文案全在 `seed/prompt/*.md`，这里只按条件选片段、填名字 |
| `channel/queue.ts` | 94 | 唤醒队列：`queuedAhead`（同会话还没开始的排队项）/ `coalesceQueue`（合并成最多一个）/ `liveConversations` |
| `channel/attachments.ts` | 405 | 附件（原 `uploads.ts` + `attach.ts` 合并）：`putUpload` / `readUploadMeta` / `sweepOrphanUploads`（单文件一份元数据，频道文档里只存 id）/ `kindOfMime` / `mimeOf` / `nameFrom` / `contentDisposition` / `readBounded`（边读边数——先读完再比上限等于没有上限）/ `placeholderOf`（附件 → 模型能看到的那几行） |
| `channel/wiring.ts` | 81 | 频道层的接线：`wireChannel()` 造一次 `ChannelWiring`（`conversationOf` / `rememberWake` / `wakeOf` / `finishTurn` / `promptDir` / `uploadsRoot`），工具、沉淀、我说话共用；`directoryWake` 与收尾器只在这里造 |
| `channel/membership.ts` | 160 | 频道成员从哪来：`addToAllChannel`（merge，只加不删）/ `ensureAllChannel`（播种）/ `ensureOwnerDm`（每个成员一条私聊，`create` 幂等）/ `joinTeamChannel`（按 `identity.md` 的 `team:`）/ `syncTeamChannel`（我 + lead + 汇报线 + 团队成员，`replace` 去幽灵；团队频道任何人说话都叫醒 lead） |
| `channel/wake.ts` | 152 | `wake()` —— **叫醒一个人只有这一条路**：合并排队项、记两层 wake（`reply` / `task`）、提交、结算收尾（没产出留痕 / 正常答完自动补发）；正文用 `bodyOf(merged, busy)` 回调给（要先合并才知道并了几条）。`post()` 与 `team/settle.ts` 都走它 |
| `channel/turn/record.ts` | 56 | 一轮的唤醒目标：`WakeTarget` / `WakeRecord{reply, task}`；`parseWake` 兼容旧的平铺格式（`reply = task`） |
| `channel/turn/finish.ts` | 144 | 一轮的收尾：结算 `done` 后取答案条目，没被 `say` 说出来的最终正文按两层唤醒记录补进频道；`finalTextOf` / `spokeAfterWake` / `turnTarget` / `createTurnFinisher` |
| `channel/turn/index.ts` | 17 | 这一层对外的出口：唤醒记录类型 + 收尾 |
| `channel/jobs.ts` | 200 | 后台命令：`startRunJob()` 起一条 detached 命令（stdout/stderr 收尾巴、30 分钟到点整组杀掉、跑完回调 `onDone`）、`sweepRunJobs()` 启动时清上一轮的遗留（活着的杀掉、记录删掉）。记录 `logs/run/<id>.json`、全文 `logs/run/<id>.log`（ADR-013） |
| `channel/tools/index.ts` | 47 | `createCoreTools` —— 组合下面 7 个 builder，并再导出 `isPass` / `monologueOpener` / `clip` / `resolveInWorkspace` / `CoreToolDeps`。**7 个工具**：`say` / `chats` / `read_history` / `remember` / `hire` / `run` / `file` |
| `channel/tools/context.ts` | 149 | 工具的运行环境：`CoreToolDeps`、`text` / `actionOf` / `selfOf` / `selfOrError` / `mentionRoster` / `readState` / `postDeps`（投递依赖组装） |
| `channel/tools/channel-choice.ts` | 99 | `defaultChannel`（显式 id 或**频道名** → 唤醒记录 `reply` → 群里最近活跃 → 私聊**报错**）/ `othersAwoken`（同一条消息还叫醒了谁）。频道名只在**自己所在的**频道里按全等找，重名报错列 id，不做模糊匹配（ADR-011） |
| `channel/tools/recall.ts` | 59 | `recallText`（翻自己 / 团队记忆，出口脱敏）/ `renderLine`（历史一行） |
| `channel/tools/guards.ts` | 106 | 安全闸与上限：`isPass` / `monologueOpener` / `clip` / `resolveInWorkspace`、`SAY_LIMIT` / `GROUP_SAY_LIMIT` / `sayLimitOf` / `MODEL_LIMIT` |
| `channel/tools/say.ts` `chats.ts` `history.ts` `remember.ts` `hire.ts` `run.ts` `file.ts` | — | 一个工具一个 builder（`createSayTool(deps)` …）。`say` 负责「在哪儿回话、叫醒谁」（**没有 `to`**：私聊只能我开），`defaultChannel` 兜底落到私聊**直接报错**。`me` / `skills` / `teams` / `write_team` 已删——它们是「用 `file` 读写某个固定路径 md」的包装。`file` 写 `teams/<slug>/README.md` 后调 `syncTeam` 重投影频道。`remember` / `hire` / `file` 写、`read_history`、`file` 读都过 `redact`；`.secrets.json` 对工具不开放 |
| `channel/unanswered.ts` | 82 | 「叫了他但他这一轮没答上来」的留痕：`reasonText`（结算原因翻成人话）/ `renderUnanswered` / `watchSettled`（后台等结算，不 await、不抛） |
| `plugin/manifest.ts` | 159 | `readPluginManifest` / `listPluginSlugs` —— `plugins/<slug>/plugin.md` 的头（`name` / `description` / `enabled`）+ 目录里有没有 `plugin.ts`（或 `plugin.js`）与 `client.js`；缺清单是一条**错误**不是异常。`writePluginEnabled` 只改 `enabled` 一行；`installPluginFiles` 把界面选中的整个文件夹（`{path, base64}[]`）校验后原样落盘、`removePluginFolder` 删整个目录（装 / 卸，见 CORE §13） |
| `plugin/api.ts` | 104 | 插件能做的四个动作：`PluginApi`（`tool` / `prompt` / `route` / `on("message")`，外加 `Type` / `text` / `log` / `workspace`）+ `createPluginApi`，每个注册只往 `PluginSinks` 的一个数组里 push |
| `plugin/load.ts` | 126 | `loadPlugins({pluginsRoot, workspace, log})` → `PluginHost{tools, prompt, routes, messages, plugins, errors}`：按目录名序逐个 `import` 后端入口、`apply(api)`；**隔离**在这里（清单坏 / import 炸 / apply 抛都只留一条错误）；`emptyPluginHost` |
| `app/index.ts` | 51 | `createApp(services)` → `{snapshots, read, people, teams, chat, uploads, runs, watch, diag}`；再导出 `OWNER_SLUG` / `AppError` / `CoreServices` / `readBody`（分层规则禁止 interface 层直接 import 领域实现） |
| `app/types.ts` | 94 | `CoreServices` —— 用例层看出去的「装配好的核心」 |
| `app/snapshot.ts` | 86 | `channelSnapshot()`（只读人 + 频道，SSE 增量用它）/ `snapshot()`（再加团队文档推出的两张查表）；团队文档按 `teams/` 目录 mtime + 250ms 窗口缓存 |
| `app/read.ts` | 335 | `createRead` —— 读的入口：每个方法都是「取快照 → 投影（`app/project.ts`）→ 返回 DTO」。另有轨迹四件：`activityMap` / `liveOf`（谁此刻在跑，读 `LiveDoc`）、`readTurns` / `readTurn`（`turnsOf` 按 `core.channel` 切轮）、`readPersonTurns`（跨频道；私聊工作记录）、`personOfChannel`（私聊对面是谁，SSE 用）。纯切轮只有 `groupsOf(entries, from, to, channelId?)` 一个：给了 `channelId` 只切那个频道，不给就切这个人的所有频道 |
| `app/trace.ts` | 313 | **轨迹派生，纯函数**（ADR-001 / ADR-003）：会话条目 → `ViewTurn`。`buildTurn` / `summaryOf` / `withoutSteps` / `slimTurn` / `stripAnsi`；单轮 200 步、单步输出 8 KB、思考 4 KB 上限；拿不到耗时就不编 |
| `app/people.ts` | 122 | `createPeople` —— 一个人：档案、记忆的读 / 加 / 改 / 删；`MemoryEditBody`。记忆的 DTO 形状交给 `app/project.ts` 的 `memorySummary` / `memoryEntries` |
| `app/teams.ts` | 33 | `createTeams` —— 一个团队：`readTeamProfile`（README 正文 + 管理员显示名 + `memory.md` 的全部小节，时间恒为 `null`） |
| `app/plugins.ts` | 143 | `createPlugins` —— 插件清单（`enabled` 每次从磁盘读，开关才是下次启动的事实；`brings` 是这次进程真注册出来的工具 / 提示词 / 接口 / 监听）/ 开关（`setEnabled` → `plugin/manifest.ts` 的 `writePluginEnabled`）/ 装与删（`install` → `installPluginFiles`、`remove` → `removePluginFolder`）/ 一个插件的前端入口（名字过 `isSafeName`，只发已装上插件声明过的 `client.js`）/ 把 `PluginRouteSpec` 换成接口层认识的 `AppPluginRoute`（含 `body` 的 `unknown → JsonValue` 那一处转换） |
| `app/project.ts` | 371 | **投影**（原 `view/index.ts` 并进来）：`idOf` / `titleOf` / `channelList` / `messageView` / `channelDetail` / `orgView` / `attentionItems` / `withLabels`；显示名走 `agent/identity.ts`，团队头走 `channel/types.ts` 的 `teamId`。另有记忆投影 `memorySummary` / `memoryEntries`（个人与团队共用；没有 journal 的条目时间给 `null`） |
| `app/chat.ts` | 169 | 说话用例：`postAsOwner` / `openDirectMessage`（委托 `ensureOwnerDm`，幂等）/ `markRead`；校验（`from` 只认我、附件必须在盘上、已读夹到上界、私聊对象必须在名册里）在这里而不在路由里 |
| `app/avatar.ts` | 69 | 头像的**画法**：`avatarSvg(seed, size)`（DiceBear `micah`，取景与底色都在这里）/ `avatarEtag` / `clampAvatarSize`。纯函数，没有 IO：路由把字节写出去 |
| `app/uploads.ts` | 76 | 上传语义：`createUploads` —— 收下字节、写元数据、读回时决定内联还是下载。工作区文件树已删，三道闸随它一起走了 |
| `app/runs.ts` | 46 | 后台命令的收尾：`createRuns` 的 `sweep()` —— 服务启动时把上一轮遗留的后台命令结账，在起跑的那个频道留一条 `note`（谁起的、哪条命令、活着被停掉还是早就结束了）。失败只记一行，不影响启动（ADR-013） |
| `app/diag.ts` | 150 | `record()`（卡顿落 `logs/jank.jsonl`）/ `recordRuntimeReport()` / `lastReport()` / `onAbnormal()`（订阅异常报告，看门狗用）/ `formatRuntimeReport()`；运行报告落 `logs/runtime.jsonl`，`task_outdated` 算良性。单条 4KB、单文件 5MB 轮转一代（`appendJsonLine` 的 `rotateAt`） |
| `app/watch.ts` | 49 | 看门狗（ADR-016）：`createWatch` 订阅 `diag.onAbnormal`，异常报告一到就在全员频道留一条 `note`（`底座报告：…`），10 分钟最多一条；`serve.ts` 启动 `start()`、关服务 `stop()`。只通报，不自动救 |
| `app/audit.ts` | 82 | 审计钩子（ADR-010）：`auditHooks(deps)` 返回两个 `HookRegistration`（`ToolTask` 的 `beforeTool` / `afterTool`、`GenerationTask` 的 `afterResponse`），一次工具调用 / 一次模型回复各写一行到 `logs/tools.jsonl`（单文件 5MB 轮转一代）。**只读不改**：不改参数、不拦调用、不改结果；写失败就丢这一行，不反噬调用。装配层把它挂在 `core-tools` 扩展上 —— 那是每个会话都选的扩展 |
| `app/errors.ts` | 20 | `AppError` + 五个 reason（`bad-request` / `forbidden` / `not-found` / `too-large` / `internal`），**刻意不带状态码**：说「找不到」，不说 404 |
| `view/dto.ts` | 201 | **界面吃的每种 JSON 只在这里定义一次**：零 import、零函数、零 IO —— 它是**契约层**（投影已并进 `app/project.ts`）；`ui/app/src/api/types.ts` 只是 type-only 再导出它 |
| `interface/http/routes.ts` | 317 | 路由表：27 条 `/api/*`（按方法 + 路径算）+ 插件自己注册的接口 + `*rest` 静态兜底。handler 只做「解析参数 → 调 `app/` → 序列化」 |
| `interface/http/respond.ts` | 100 | HTTP 出口原语：`json` / `fail` / `HttpError` / `readJson`（正文上限 1MB、写接口必须声明 `application/json`）/ `statusOf`（用例原因 → 状态码） |
| `interface/http/route-match.ts` | 131 | 表驱动路由匹配：`Route` / `RouteContext` / `RouteHandler` / `matchRoute`（`:name` 捕获 / `*name` 吃余量），不引入框架 |
| `interface/http/network.ts` | 80 | 监听地址：`isWildcardHost` / `isLoopbackHost` / `browserUrlOf` / `lanAddresses` / `lanUrlsOf` |
| `interface/http/static-assets.ts` | 310 | 静态资源：`serveStatic`（SPA 回退）/ `loadAsset` / `etagFor` / `bodyFor`；按编码区分的 ETag + Last-Modified + `Vary` + br/gzip 协商 + `insideRoot` 越界判断 |
| `interface/http/origin-guard.ts` | 130 | 来源闸：`hostAllowed` / `originAllowed` / `allowedHostsOf` / `selfOriginsOf`（Host 与 Origin 白名单，默认只给本机） |
| `interface/http/sse.ts` | 422 | SSE 两半都在这里：编解码纯函数（`encodeEvent` / `retryFrame` / `keepAliveFrame`，唯一能脱离 socket 单测的部分）**和**有状态的 `createStreamHub`（连接集合、120ms 去抖、每连接每频道游标；`org` 推整份快照（带 `activity`），`create` 只推订阅者，`trace` 只推正在跑的那几轮并按指纹去重；一次提交后两分钟里每秒补推一次（`wakePulse` / `pulseNow`），运行状态不落盘也不等提交） |
| `shell/assemble.ts` | 524 | `assembleCore()` —— 扫文件夹 → **装插件（工具并进同一个注册表、提示词段与消息钩子一起接）** → 开会话 → 绑名册 → 播种全员频道；接线只调一次 `wireChannel`，成员投影只调 `channel/membership.ts`（装配不再自己写业务规则）；`ownerSpeak` / `makeAfterPost`；`identityExtension` / `installIdentity` 是 async（身份段要 await 读模板）；`core-tools` 扩展上挂 `app/audit.ts` 的钩子（会话 id → slug 的反查也在这里） |
| `shell/seed.ts` | 324 | `seedOwnerAssistant`（读 `seed/agents/assistant/identity.md` 建人 + 助理个人层技能，只建一次）/ `seedPromptTemplates`（`seed/prompt/*.md` 只补不改地补进 `workspace/prompt/`）/ `syncAllSkills`（全员层技能按 hash 同步）/ `seedRules`（`rules.md`，只补不改）/ `seedPlugins`（`seed/plugins/*` 整份缺失才拷）/ `seedPersonalSkills`；常量 `SEED_ASSISTANT_IDENTITY` / `SEED_ASSISTANT_SKILLS` |
| `shell/serve.ts` | 134 | `serveCore()` —— 只留装配顺序、进程级的东西（端口 / Host·Origin 闸 / listen·close / 启动横幅）、把兜不住的异常翻成 500；路由与 SSE 都在 `interface/http/` |
| `shell/main.ts` | 171 | 启动：播种规矩 / 提示词模板 / 全员层技能（`seedRules` / `seedPromptTemplates` / `syncAllSkills`）→ 必要时建人 → 读模型 → `createDiag` → `openCore({settings: {compaction}, onReport})` → `assembleCore` → `serveCore` → 等 Ctrl-C；并自检「记忆整理」技能在不在 |

### 2.2 `ui/app/src/`（React + TS，构建到 `ui/web/`）

源码在这里，产物在 `ui/web/`（服务端发那个目录，**别手改产物**）。改完必须 `npm run ui:build`。

| 文件 | 职责 |
| --- | --- |
| `ui/app/index.html` | 页面骨架 + **首帧定色的内联脚本**（放样式之前，否则先白一下再变深） |
| `ui/app/vite.config.ts` | 构建配置。`outDir: "../web"`、`emptyOutDir: false`（清空会在出错时连 index.html 一起删掉） |
| `src/main.tsx` | 入口：装样式、`bootstrap()`、**先 `bootPlugins()` 再挂 `<App>`**（插槽首帧就是满的；插件拉不到也照常渲染） |
| `src/App.tsx` | 外壳装配：三列网格、头部（标题 / 状态 / 找你 / 团队 / 设置 / 详情）、主题与布局落地、键盘（Esc 关浮层、⌘K 开「找你」） |
| `src/state/store.ts` | **唯一状态源**（`useSyncExternalStore`）。拉数据、SSE 打补丁、`openChannel`/`loadEarlier`/`applyMessage`、`applyOrg`（人 + `activity`）、`applyTurn`/`loadTurn`（轨迹按 `seq` 分桶）、localStorage 两键 |
| `src/state/useStore.ts` | 40 行薄封装。**选择器必须外部声明**，否则每次渲染都是新函数 → 无限重渲染 |
| `src/api/client.ts` | 全部 `fetch` 包装。**每个后端路由必须在这里有消费者**（边界检查会扫 `ui/app/src`） |
| `src/api/types.ts` | **type-only 再导出** `src/core/view/dto.ts`：后端改字段这里就编译不过。权威定义只有那一份，不要在这儿加后端没有的字段 |
| `src/stream/model.ts` | **消息 → 行模型，纯函数**：`buildRows()`（时间分隔、同一人两分钟内算一段 / 半分钟内连发合并气泡、`note` 单独一行）与 `buildWorkRows()`（私聊页：消息 + 这个人在各频道的工作轮次按时间合排；只有话没做事的一轮不画壳）。历史库里的 `think`/`tool`/`work`/`step` 直接过滤，不画 |
| `src/stream/RunBlock.tsx` | 一轮的折叠行 + 步骤树。默认「在跑就展开、历史收起」，手动改过记 `localStorage["solo.trace.open"]`；步骤详情按 kind 分四种（命令 / 文件 / 思考 / 说话），同一时间只展开一个 |
| `src/stream/Stream.tsx` | 把行画出来 + 贴底/上翻/回到最新；`run` 行交给 `RunBlock`；空频道画 `Empty`（头像 + 一句话 + 可点的 `@名字`） |
| `src/rows.ts` | 只剩 `isNeed()`：这条要不要我处理（顶栏「N 件找你」与左侧 2px 竖线的唯一来源） |
| `src/plugin/registry.ts` | 前端插槽：`SlotName` / `SLOTS`（11 个：`sidebar.*` / `topbar.actions` / `stream.*` / `composer.actions` / `rightPanel.*` / `settings.section` / `overlays`，位置表在 DESIGN §2.8）、`register` / `cellsOf`、`bootPlugins()`（`GET /api/plugins` → 逐个 `import` `/api/plugins/<slug>/client.js` → `apply(ui)`，注入 `style`）。`ui` 里带 `api`（接口客户端）与 `store` / `useStore`（界面状态）。失败只 `console.warn` |
| `src/plugin/Slot.tsx` | `<Slot name>`：把注册表里的格子画出来；没有插件时返回 `null`，不占位 |
| `src/sidebar/Sidebar.tsx` | 侧栏：logo、可收起成 56px 图标条、一列平铺频道（两行：名字+状态 / 预览）；列表脚下有一个 `sidebar.footer` 插槽。第一格是助理：私聊还没开过时画入口（`AssistantRow`），点下去 `store.openWithPerson` 建频道再打开 |
| `src/composer/Composer.tsx` | 输入卡：自增高、Enter/Shift+Enter、**中文输入法合成期不误发**、@ 弹层（280px、6 行、头像 + 身份 + `@slug`）、附件队列、拖拽、粘贴、引用条 |
| `src/panels/RightPanel.tsx` | 右栏第三列：详情 / 技能 / 记忆（后两个共用一个换人器，只列当前频道成员）+ 插件注册的页签（`rightPanel.tab`）。关的时候等 300ms 过渡再卸载 |
| `src/panels/Overlays.tsx` | 设置、找你清单、团队、toast。**同一时刻只开一个**（图片灯箱在 `App.tsx`）。`NeedMenu` 由 `App.tsx` 放进顶栏按钮的 `.menu-anchor` 里渲染 —— 菜单要贴着按钮长 |
| `src/hooks/useStreams.ts` | org 与频道两条 SSE（`org` / `create` / `trace`）；失败退避 1s→15s；org 事件自带整份快照（`applyOrg`），侧栏与「找你」仍走 `store.refreshLists` |
| `src/hooks/useToasts.ts` | 三条上限 / 3.6 秒 |
| `src/lib/avatar.ts` | 头像只拼 `<img src="/api/avatar/…">`（种子取 slug、要 2 倍尺寸）、四种状态、`groupAvatar()` 群组头像（座位 + 挖洞遮罩）。**画在服务端**（`src/core/app/avatar.ts`），这里不画 |
| `src/lib/markdown.ts` | `renderMarkdown()` —— 最小 Markdown，**先转义再拼** |
| `src/lib/copy-code.ts` | 代码块「复制」：`CODE_COPY_CLASS` 一处定义，`installCodeCopy()` 在 `main.tsx` 装一次全局委托（正文是 `dangerouslySetInnerHTML` 注入的，React 事件接不到里面的按钮） |
| `src/lib/format.ts` | 转义、相对时间、`clockTime` / `dayLabel`、`humanDuration`（`<1s` / `3.2s` / `1m 12s`）、`humanBytes`、`unreadLabel`、`copyText` |
| `src/lib/jank.ts` | 卡顿自报：长帧 > 240ms / 长任务 > 200ms 才记一条，`mark(label)` 标「当时在干什么」，攒够 5 秒或 `pagehide` 发 `POST /api/diag` |
| `src/styles/*.css` | 七个样式文件，顺序见 `styles/index.css`（token 先落地）；记忆抽屉并进右栏后 `memory.css` 已删 |
| `public/fonts/*.woff2` | Montserrat 300/400/500（本地字体，只用于品牌名） |

## 3. 「我想改 X → 动这里」

| 想改什么 | 动这里 | 注意 |
| --- | --- | --- |
| 加一个工具（能力） | `channel/tools/` 里对应的模块加共用件（`context.ts` / `channel-choice.ts` / `recall.ts` / `guards.ts`）、新工具一个 builder 文件，再登记进 `channel/tools/index.ts` 的 `createCoreTools` | 工具 description 只写参数语义和机械后果，行为要求引用技能 / 规矩；同一件事的几种做法用一个 `action` 枚举，不要开新工具名（现在是 7 个）；加完数一遍总数 |
| 加一个真模型场景 | `scripts/scenario-live.ts` 的 `SCENARIOS` 注册表（`id` / `title` / `gate` / `cost` / `run`） | 搭建用代码（`createLiveAgent` / `createTeamFixture` / `openDm`），模型只负责被观察的行为；等待与证据只走 `scripts/live-support.ts`；`mechanism` 失败按代码查、`behavior` 失败按提示词查 |
| 教 agent 一套做法 | **不要写代码**，写 `seed/skills/<名字>/SKILL.md`（团队层写 `teams/<团队>/skills/<名字>/SKILL.md`，个人层写 `agents/<slug>/skills/<名字>/SKILL.md`） | `seed/skills/` 的现成技能 |
| 改一段提示词的**措辞** | `seed/prompt/NN-段名.md`（播种进 `workspace/prompt/`，之后以 workspace 为准） | 改文案不用改代码、不用重启，下一条消息生效。一个 md = 一段 = 一个 cache section，文件名前缀定序 |
| 加一段提示词 / 改段落顺序 | 在 `seed/prompt/` 加 `NN-段名.md` + `scripts/prompt-fixture.ts` 补它用到的样例插槽 | 顺序是语义（规矩在能力前面），改顺序会触发一次性整块重写；确定性是硬要求，`npm run prompt:check` 会拦 |
| 加一个插槽 | `docs/design/SEED-CONTRACT.md` §3 登记（值 + 来源）+ `scripts/prompt-fixture.ts` 给样例值 + 装配层填值 | 插槽表是唯一权威；未知插槽渲染成「（未设置）」并报出来，不许静默变空；「空的时候怎么说」用 `{{x ?? 默认句}}` 写在模板里，不要写回代码 |
| 工具名要出现在提示词里 | 写 `{{tool:xxx}}`（注册表实拍，工具改名自动跟） | 不许写字面量 —— V2 的 40 处硬编码就是这么烂掉的 |
| 改「全员都要守的规矩」（先给结论、在哪个频道回话、别写英文独白） | **不要写进 `.ts`**：改 `seed/rules.md`，再同步到 `workspace/rules.md` | 每轮都进提示词的只有这一份；技能正文只在 `60-skills.md` 那段列目录时才进上下文 |
| 改起手技能的同步行为 | `shell/seed.ts` 的 `syncAllSkills` + `<workspace>/.seed-manifest.json` | 按 hash 判「用户改过没有」，改过的不覆盖 |
| 加一个身份字段 | `agent/identity.ts` 的 `IdentityHeader` | 现在是 4 个：`name`/`title`/`manager`/`team`，加之前先问能不能推导 |
| 改「这条会话是私聊还是群聊」 | `channel/types.ts` 的 `chatKind` | **`dm:` 前缀 + 恰好 `{我, 一人}` 才是私聊**；团队 / 全员频道两个人也永远是群聊。界面的 `kind` 只是它的投影 |
| 开一个私聊 / 建一个频道 | `channel/membership.ts` 的 `ensureOwnerDm`（装配 / 招人自动建）+ `app/chat.ts` 的 `openDirectMessage` + 路由 `POST /api/people/:slug/dm` | **建频道只有这一份实现**；通用 `POST /api/channels` 已删。其余频道只由装配投影（全员 / 团队 / 每个成员的私聊） |
| 改私聊工作记录（跨频道轮次 / 实时） | `app/read.ts` 的 `readPersonTurns` / `groupsOf`（不传 `channelId`）/ `personOfChannel` + `interface/http/sse.ts` 的 `pushTrace` + `ui/app/src/stream/model.ts` 的 `buildWorkRows` + `state/store.ts` 的 `work` | 群聊不画过程；私聊按 `startedAt` 合排，跨频道 `seq` 不可比，键必须带 `channelId` |
| 改团队 README 的写入校验 | `team/doc.ts` 的 `leadProblem` / `createTeamProblem` + `channel/tools/file.ts` 写分支 | 校验在 `writeTextAt` **之前**；拒绝时不落盘、不 `syncTeam`。助理 = 直接向 owner 汇报的人；开新团队只有助理能做，改已有团队不限 |
| 加一条审计 / 想看「他调了什么、花了多久、模型为什么停」 | `app/audit.ts`（钩子，写 `logs/tools.jsonl`）+ `shell/assemble.ts` 里挂在哪个扩展上 | 钩子**只读不改**：不改参数、不拦调用、不改结果。要拦的（密钥 / 路径越界 / 建团队权限）留在工具里 —— 钩子拿不到 `workspaceRoot` 和名册。新增钩子先在 `docs/DECISIONS.md` 说明为什么不能用现成日志 |
| 改谁能被 @ 到 / 什么写法算 @ | `channel/mentions.ts` 的 `recipientsOf`（成员规则）+ `parseMentions`（名字 → slug） | 两件事分开改：成员过滤是安全边界，别名只是翻译。别名只认 `slug` / `name` / `我` / `owner` **精确匹配**；`@CEO`、拼音、title、`@老板` 一律丢弃，不许加回模糊匹配 |
| 改「要我拍板就 @ 我」 | `channel/tools/say.ts` | 只有一种情形把 `owner` 加进 `mentions`：**正文显式 @我**。补的是 `mentions`，**不改正文**；关键词嗅探与「`decision` 自动补 owner」都已删（ADR-009） |
| 改「没明确频道时在哪儿回话」 | `channel/rules.ts` 的 `fallbackChannelId` + `channel/tools/channel-choice.ts` 的 `defaultChannel` | 兜底只找最近活跃的真实频道；**落到私聊就报错**让模型显式给 channel，不静默写进一个不存在的频道（这条踩过：话写成功了，频道里谁都看不见）。显式 `channel` 认 id，也认**频道名**——提示词里给的是标题，不是 id |
| 改频道成员怎么来 | `channel/rules.ts` 的 `projectChannel` + `channel/membership.ts` 的 `joinTeamChannel` / `syncTeamChannel` / `addToAllChannel` / `ensureOwnerDm` | 成员是 `identity.md` + 团队 `README.md` 的投影；全员 / 重扫用 `merge`，团队用 `replace`。全员频道只是播种一次的普通群，没有特权 |
| 文件读写 / 名字 / Markdown 头 | `fsx.ts`（工作区相对路径）/ `runtime/io.ts`（绝对路径机械 IO）/ `naming.ts` / `md/doc.ts` | 每个都只有一份实现；直接 `node:fs` 只允许 `docs/CODE.md` §1 列的五类例外，别在业务模块里新开 |
| 加一个插件 / 改插件能做什么 | `src/core/plugin/`（`api.ts` 的四个动作、`manifest.ts` 的清单字段）+ `shell/assemble.ts` 的装配 + `ui/app/src/plugin/registry.ts` 的 `SlotName` | 插件是**运行时数据**（`workspace/plugins/`，gitignore），不是代码；加动作 = 改 `PluginApi` + 装配里多接一根线；加插槽 = 登记 `SlotName` + 在宿主里画 `<Slot>`（ADR-018）。开关在设置浮层（`Overlays.tsx` 的 `PluginsSection`），落盘走 `writePluginEnabled` |
| 加一条 HTTP 路由 | `interface/http/routes.ts` 的 `routes` 表 + `app/` 里的一次用例调用 + `ui/app/src/api/client.ts` 里的消费者 | handler 只做「解析 → 调 app → 序列化」，≤30 行；业务校验属于 `app/`。没有消费者边界检查会失败 |
| 改路由匹配 / 静态资源 / 来源闸 / 网卡 | `interface/http/route-match.ts` / `static-assets.ts` / `origin-guard.ts` / `network.ts` | 表驱动匹配（`:name` / `*name`）、ETag 与压缩协商、Host·Origin 闸都在这里；别自己拼 `writeHead`，走 `json` / `fail` 四个出口 |
| 改 SSE（事件形状 / 去抖 / 游标） | `interface/http/sse.ts` | 编解码是纯函数（`encodeEvent` 等）、有状态那半是 `createStreamHub`；先看 `test/core/sse.test.ts` 与 `hub-stream.test.ts` |
| 改「我不 @ 人时谁接话」 | `channel/rules.ts` 的 `speakerBefore` + `channel/mentions.ts` 的 `recipientsOf` | 认的是我上一句话之后第一个接话的人（`note` 不算）；我还没说话才退回第一个成员。`renderDelivery` 吃投递层算好的 `woken`，别自己再推一遍（ADR-015） |
| 改看门狗的判据 / 通报方式 | `app/watch.ts` + `app/diag.ts` 的 `onAbnormal` | 只通报、不自动救；用订阅不用轮询（`lastReport` 只留最新一条，轮询会漏）（ADR-016） |
| 改后台命令（`run` 的 `background`） | `channel/jobs.ts`（起 / 记 / 收）+ `channel/tools/run.ts` 的 background 分支 + `app/runs.ts`（启动清扫）+ `channel/post.ts` 的 `wakeTo` | 结果回到**起跑的那个频道**，以 `note` 落库、`wakeTo` 叫醒起跑的人（`note` 默认谁也不叫）；最多 30 分钟；输出只回尾巴 8000 字（ADR-013） |
| 改一条消息的字数上限 | `channel/tools/guards.ts` 的 `sayLimitOf` + `channel/tools/say.ts` | 群聊 600 / 私聊 1200，看的是目标频道的 `chatKind`（ADR-014） |
| 改附件（落盘 / 上限 / 清理） | `channel/attachments.ts`（字节与元数据）+ `app/uploads.ts`（语义：内联还是给路径） | 上限与「先读完再比等于没有上限」都在 `channel/attachments.ts`；别把字节塞进频道文档（教训） |
| 改界面字段 | `view/dto.ts`（先改 `docs/WEB-API.md`）+ 投影在 `app/project.ts` | DTO 是唯一权威，`ui/app/src/api/types.ts` 只是它的 type-only 再导出 —— 改字段界面立刻编译不过。字段必须有前端消费者 |
| 改界面样式 / 交互 | `ui/app/` | **改完必须 `npm run ui:build`**；文件职责见 §2.2 |
| 改头像（画风 / 取景 / 配色 / 尺寸） | `src/core/app/avatar.ts`（画法）+ `ui/app/src/lib/avatar.ts`（种子与尺寸）+ `ui/app/src/styles/motion.css` 的 `.av` | 画在服务端、按 slug 稳定；`size` 夹在 16–256；界面要 2 倍尺寸。动的是整张 `<img>`（三态各一种动法） |
| 改「上翻看历史 / 回到最新」 | `ui/app/src/stream/Stream.tsx` 的 `rememberAnchor` / `toBottom` 与 `state/store.ts` 的 `loadEarlier` | 补历史**只往前面插**、用锚点行按回原位，别改回整列重建 |
| 改团队记忆沉淀的触发条件 / 游标时机 | `team/memory.ts` 的 `settleCandidates` + `team/settle.ts` 的 `waiting` | 游标语义在 `team/settle.ts`，改之前先读懂 |
| 改「这批消息该不该记」的判据 | `seed/prompt/95-settle.md` —— **不要写进 `team/memory.ts`** | 判据是 `use: delivery` 的模板：decision 必记、report 看是否超出当前任务、纯过程话不记；技能正文不在沉淀那一轮的上下文里，所以判据必须写在正文里 |
| 改「什么该记、什么不该记」 | `seed/skills/记忆整理/SKILL.md` —— **不要写代码** | 提示词只说「按那份技能整理」 |
| 换模型 / 加自定义模型 | `workspace/settings.json` 的 `models`；代码在 `runtime/models.ts` | 别复活「内置模型覆盖」机制 |
| 播种出厂内容 | `shell/seed.ts`：`seedRules`（规矩，只补不改）/ `seedPromptTemplates`（`seed/prompt/`，只补不改）/ `syncAllSkills`（全员层技能，按 hash 同步）/ `seedPlugins`（示范插件，整份缺失才拷）/ `seedOwnerAssistant`（助理身份读 `seed/agents/assistant/identity.md`）/ `seedPersonalSkills` | 规矩与提示词模板只补不改（可能被用户亲手改过）；技能按 hash 判断改没改；助理身份只建一次 |
| 改 seed 出厂内容的规矩 | `docs/design/SEED-CONTRACT.md` + `test/core/seed-contract.test.ts` | 一条事实一个家、`rules.md` ≤15 条零工具名、技能 ≤4 KB —— 这些是机械验收，改 seed 前先读契约 |

## 4. 启动顺序（第 3 步最容易出错）

`main.ts`：

0. `seedRules` + `seedPromptTemplates` + `syncAllSkills`（`--no-seed` 时不跑）—— 规矩、
   提示词模板、全员层技能每次启动各同步一遍，并自检「记忆整理」技能是否存在
   （沉淀链路要用它）。**顺序有讲究**：模板必须在 `assembleCore` 之前落到 `workspace/prompt/`，
   否则身份段读不到模板、装配出 0 段的 agent。
1. `setupModels(process.env, { workspace })` —— 读 `settings.json`，装配 provider。**在
   `openCore` 之前**，因为 `harness` 需要 `models`。`contextWindow` 取不到时回落 128k。
2. `createDiag(workspace)` —— 卡顿与运行报告的落盘口。
3. `openCore({ databasePath, models, registry, settings: { compaction: compactionSettings(models) }, onReport: diag.recordRuntimeReport })`。
4. `assembleCore(...)` —— 见下。
5. `serveCore({ shell, ... })`。

`assembleCore` 内部顺序也不能乱：

1. `createCoreTools` → `defineExtension` → 每人的 `identityExtension(slug)`；
2. 扫 `agents/` 目录；
3. 每人 `openOne(slug)`：查内存 → 查名册 → 复用（补 `applyModel` + `installIdentity` +
   `membership.joinTeamChannel`）或新建会话 → `membership.addToAllChannel` → `membership.joinTeamChannel`；
4. **一次 commit** 把名册写回（每个人一次 commit 会让启动慢一个数量级）；
5. 播种全员频道（已存在就补缺失成员）；
6. `rescan()` 可从外部再触发（改完 `identity.md` 加人不必重启）。

**坑**：第 3 步的 `openOne` 必须同时做「进全员频道」和「进团队频道」，两者都幂等。
第一版只在 `rescan()` 里补团队频道，于是「改 identity 加上 team」的人永远进不去。

**坑（已定，未落）**：`assembleCore` 现在读不到任何 system 模板时只 warn，症状是「提示词
全空但服务正常启动」。定论是**模板目录不存在或为空就抛**（单段缺失不抛 —— `skip-empty` 就是
为合法编辑准备的）。卡在 `assemble.test.ts` 那批临时工作区只建了 `agents/`、没播种 `prompt/`，
要先让它们补 `seedPromptTemplates(root)` 才能落，否则一次红 55 条。

会话形态不在这里决定：没有「个人频道」这种东西，也没有 `ensurePersonalChannel`。
私聊是 `dm:` 前缀、成员恰好 `{我, 一人}` 的会话，我通过 `openDirectMessage` 开的时候才有；
一个 agent 不进任何群也能活。

## 5. 改动前的检查清单

```bash
npm run check        # tsc --noEmit + 边界检查
npm test             # 71 文件 / 726 例，应该 <3s
npm run prompt:check # 提示词黄金渲染：确定性、插槽全填、每段 ≤12 行、模板里零工具名
npm run live         # 真实模型端到端 16 项，会花 token，只在改行为后跑；连跑两次都要 16/16
npm run live:scenarios -- --rounds=3   # 多 agent 场景 6 个 × 3 轮（硬 3/3、行为 2/3）
```

`live` 的验收门是**两条 + 一个趋势**：两次 16/16；收尾（`[turn]`）
补发的内容/频道/去重正确（单测守）；次数记下来 —— 7 个阶段超过 4 次就是提示词在退化。

改行为时**必须**同步三处：代码、`test/core/` 里的用例、`docs/`（`CORE` 概念 / `WEB-API`
字段 / `DECISIONS` 若碰了不可轻易改的约定）。

真实模型自测是保底：五百多个单测全绿而 `npm run live` 只过 4 项的情况**发生过**——
那一次是两个 bug 叠在一起（`ownerSpeak` 漏传 wake + wake 在 `submit` 之后才落盘），
症状是「我在群里问，对方在私聊里答」，单测完全看不见。

## 6. 测试布局

`test/core/`（49 文件，纯函数 + 装配）：

| 文件 | 覆盖 |
| --- | --- |
| `support.ts` | 不是用例：测试脚手架（临时工作区、开库、装配、收尾），各文件共用 |
| `channel-state.test.ts` | @ 解析、`chatKind`（`dm:` + 两人）、`projectChannel` 三态、四类收件人、`deliveryTargets`、`dmId` 顺序无关、未读、幂等建频道 |
| `channel-write.test.ts` | 频道写入的字节代价（每写一条花多少字节是契约）；`appendNote` 与普通消息共用写入路径、`nextSeq` 自愈 |
| `naming.test.ts` | 三种名字共用校验、`owner` 只对 agent 保留、清洗结果一定能过校验、旧 `assertSlug` / `assertTeamSlug` 仍可用 |
| `dm-channel.test.ts` | `openDirectMessage`：`dm:` id、幂等、拒绝我 / 不存在 / 空 slug |
| `mention-alias.test.ts` | `@` 别名解析：`@我` 的 6 种叫法、CEO/真名/title、垃圾 token 丢弃、老数据兜底；「我在跟谁说话」五条（ADR-015） |
| `turn.test.ts` | 答了却没说出来：结算收尾的补发判据、两层唤醒记录选频道 |
| `queue-jump.test.ts` | 我问话插队：只撤同会话 `queued` 项、最多 5 条、我自己排的不让路 |
| `say-contract.test.ts` | `say` 的落点契约：兜底频道不落私聊、投递正文带频道 id、`decision` 不自动补 `owner`、`[PASS]` 与单人在场不许静音、过程话可连发（「一轮一句结论」已降级为 `rules.md` 约束） |
| `deliver.test.ts` | 投递正文 / 未读摘要 / 失败不阻塞；两人团队频道不出现私聊文案 |
| `post-failure.test.ts` | 投递失败可见：目标没会话时留 note、投递抛错时写「投递失败：会话已关闭」（原在 `relay.test.ts`，接力上限删掉后单独成文件） |
| `identity.test.ts` | YAML 解析、`reportsOf`/`chainUp`、slug 闸与重名后缀、建人；渲染部分走 V3：真实工作区 + 播种 `prompt/`，覆盖名字/正文/汇报线/团队 README/目录不谎报、确定性、工具清单从注册表实拍 |
| `memory.test.ts` / `memory-forget.test.ts` | 分区、追加、摘要；`removeSection` 按 `sectionsOf` 的口径重建 |
| `memory-timeline.test.ts` | `memoryTimeline()`：从 journal 反推每节来历（add/edit、时间、作者）、没变不刷新、删掉不留、坏行跳过 |
| `memory-actor.test.ts` | 记忆面板留痕写上真实来源（`human` / `remember` / `agent`） |
| `journal.test.ts` | 记忆日志：追加一行 JSON、落盘失败只 warn |
| `secrets.test.ts` | 读密钥、三种形态的脱敏 |
| `skills.test.ts` | 三层覆盖、拷贝不覆盖、frontmatter |
| `models.test.ts` | `setupModels` 的默认模型（没有配置 = 没有模型，ADR-023） |
| `model-switch.test.ts` | 改 `settings.json` 后**每个会话**都换到新模型（装配层逐个读 `agent.model`） |
| `person-model.test.ts` | 给一个人换模型：当场生效、写进 `settings.json` 的 `agentModels`、重启后装配认、空串回默认、没有的模型 400 |
| `team.test.ts` | 团队 README 的读写、`lead` / `doing` / `membersOfTeam` |
| `team-profile.test.ts` | 团队档案：缺团队 404、README 字段搬全、团队记忆时间留空 |
| `team-memory.test.ts` | `teams/<slug>/memory.md`：追加、候选筛选 |
| `settle.test.ts` / `settle-e2e.test.ts` | 沉淀纯函数 + 装配层端到端（单游标语义） |
| `shell.test.ts` / `shell-e2e.test.ts` | 装配、重启幂等、wake 记录位置 |
| `assemble.test.ts` | 播种、多 agent、频道成员 |
| `directory-persist.test.ts` | 加人之后重启：复用同一个会话、不制造孤儿 |
| `doc-checkpoint.test.ts` | 名册 / 沉淀游标按增量条数压基线 |
| `view.test.ts` | 视图投影（`kind` / `role` / 未读、侧栏预览只取人说的话） |
| `attention.test.ts` | 「找你」（`GET /api/attention`）：只收点名 @我的、排除我自己发的、7 天窗口、已读带标记 |
| `rules-prompt.test.ts` | 规矩进提示词（走装配层同一个 `renderAgentSection()`）：位置在身份后能力前、缺了整段消失、确定性、`loadRules` 读盘、`seed/rules.md` 覆盖八条 |
| `monologue.test.ts` | 内心独白拦截：英文计划式开场拦住、中文汇报里夹英文不拦、太短不判 |
| `seed-sync.test.ts` | 全员层技能同步（缺的补上 / 未改的更新 / 改过的不动 / 幂等 / manifest / `rules.md` 只补不改） |
| `unanswered.test.ts` | 结算原因翻成人话 |
| `wake.test.ts` | 结算收尾：`aborted`（合并唤醒）不留痕，`no_model` 留痕，`done` 走收尾 |
| `history.test.ts` | `read_history` 能翻到被压缩掉的历史 |
| `attach.test.ts` | `planAttachments`：哪些附件给模型读、怎么读 |
| `uploads-sweep.test.ts` | `sweepOrphanUploads`：没人引用的附件被清掉 |
| `watch.test.ts` | 看门狗：异常变一句话、窗口内只报一条、stop 之后不再写频道（ADR-016） |
| `run-jobs.test.ts` | 后台命令：跑完回调 + 记录删掉、超时杀掉、起不来也回话、重启清扫（活着的杀掉）、`note` 默认不叫醒而 `wakeTo` 才叫醒 |
| `safety.test.ts` | `resolveInWorkspace`：越界路径一律拒 |
| `http-guard.test.ts` | `hostAllowed`：Host 头必须是本服务自己 |
| `reconcile.test.ts` | 启动自愈真的跑完了（不写表后读表、不撤排队输入、只清陈旧 `run`）+ 任务与输入记录回收 |
| `serialize-commit.test.ts` | `serializedHarness`：同一进程里的 commit 排队跑不互相吃 |
| `diag.test.ts` | 运行报告：底座形状摊平成可落盘的 JSON、`formatRuntimeReport` 的人话、写 `logs/runtime.jsonl`、`lastReport` 跳过 `task_outdated`、超长报告被截到 4KB、工作区不可写也不抛 |
| `prompt-render.test.ts` | V3 模板渲染：文件名定序、段名唯一、`skip-empty` 空则整段消失、delivery 不进系统提示词、两次渲染逐字节相同、模板声明的插槽全被填满 |
| `text-slots.test.ts` | 插槽：未知 →「（未设置）」并报 `unknown`、空串/纯空白报 `unset`、值里带 `{{}}` 不二次展开、确定性 |
| `seed-contract.test.ts` | seed 契约的机械验收：`rules.md` ≤15 条零工具名、一条事实一个家、`seed/prompt` 十一段齐、`{{tool:X}}` 与注册表真名对表、人名只在 identity.md、项目技能不进全员层、技能 ≤4 KB、seed <500 KB |
| `dto.test.ts` | DTO 是唯一权威：`dto.ts` 自己零 import、界面类型文件只再导出、界面用的名字都在 DTO 里；投影输出与 DTO 字段一一对应 |
| `sse.test.ts` | SSE 编解码：一帧的字节形状、多行 JSON 不会被拆行、`retry` / 保活注释 |
| `tools-actions.test.ts` | 工具收敛：注册表只剩 **7** 个、旧名字一个不剩；`chats` / `read_history` / `file` 各自的 `action` 默认值与非法值报错；写团队 README 触发 `syncTeam`、失败仍算写入成功 |

`test/ui/`（7 文件，前端里能脱离浏览器跑的那部分）：

| 文件 | 测什么 |
| --- | --- |
| `stream-model.test.ts` | `buildRows()`：同一人连发 `grouped` / `cont` 的口径、时间分隔、历史 `think/tool/work` 被过滤 |
| `source-contract.test.ts` | 源码里接没接上：代码块复制按钮（生成的 HTML 有按钮 + 启动时装了委托）、设置面板选中态（`aria-checked` 两边一致）、频道 `EventSource` 只注册 `create` / `error` |
| `sidebar-order.test.ts` | `sortChannels`：侧栏排序 |
| `unread-badge.test.ts` | `unreadLabel`：未读徽标文案 |
| `head-subtitle.test.ts` | `headParts`：顶栏副标题拼装 |
| `layout.test.ts` | 布局约定（读 CSS / 组件源码）：引用条与附件托盘的居中轨道、右栏三列与收起动画、侧栏收起成图标条、消息正文换行 |
| `jank.test.ts` | `classifyJank()`：hidden / resumed / foreground 三判；`mark()` 幂等 |
