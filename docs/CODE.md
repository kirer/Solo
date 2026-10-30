# 代码地图

要改某个东西，该动哪个文件。**概念**见 [CORE](CORE.md)，**接口字段**见 [WEB-API](WEB-API.md)。

## 1. 分层与边界

```
src/core/
  fsx.ts          文件系统的唯一入口：全项目只有它 import `node:fs`；路径不许出工作区
  doc.ts          所有 markdown 都是 `{path, front, body}`：一套 frontmatter 解析与渲染
  text.ts         插槽渲染：`{{名字}}` → 事实；未知插槽写「（未设置）」并报出来
  prompt.ts       提示词：读 `workspace/prompt/*.md` → 填插槽 → 按文件名前缀拼段
  runtime/        防腐层：唯一能 import @earendil-works/* 的地方（openCore / models / serialize）
  agent/          一个人：身份 / 提示词 / 记忆 / 技能 / 名册
  team/           一个团队：README.md / memory.md / 自动沉淀
  channel/        说话：频道规则 / 写一条（含投递） / 唤醒 / 附件 / 7 个工具
  app/            用例：读（含人 + 投影） / 说话 / 文件（含附件） / 诊断（不 import node:http）
  view/           契约层：只有 `dto.ts`，零 import（投影已并进 `app/read.ts`）
  interface/http/ 唯一 import node:http 的地方：路由表 / 原语与静态资源 / SSE
  shell/          装配与启动：assemble / main / serve / rescue / seed
ui/app/           界面源码（React + TS + Vite；构建产物 `ui/web/`）
seed/             出厂内容：`rules.md` / `prompt/`（插槽模板）/ `skills/`（公司层）/
                  `agents/assistant/`（助理身份 + 个人技能）/ `pool/`（默认不装的技能）
scripts/          五个脚本：边界检查、真实模型自测、team 改名迁移、提示词黄金渲染、渲染样例插槽表
```

**五个层，依赖只能朝一个方向**（ADR-082）：

```
interface  →  app  →  domain（agent | channel | team | runtime）
     ↘         ↓
       view（契约层：只有 dto.ts，零 import）
shell = 装配层，唯一可以同时 import 全部
```

**三条边界**（ADR-002 起就在，`scripts/check-boundaries.mjs` 机械化，违反即 `npm run check` 失败）：

1. 只有 `src/core/runtime/` 能 import pi-durable / pi-ai / chord。
2. 内核（`agent|team|channel`）不得反向 import `shell/` —— 依赖只能 `shell → 内核`。
3. `interface/http/routes.ts` 的每条 `pattern` 必须在 `ui/app/src` 里有消费者（白名单：
   `/api/org`，Docker 健康检查用）。

**分层重构后同一脚本又收紧了三条**（它文件头自己编号是「六条规定」；`LAYER_RULES` 落成
**四组**：域 / view / app / interface —— 多出来的那组是把第 2 条扩成「域也不许向上够
`app` / `view` / `interface`」）：

4. **`view/` 是契约层**：只有 `dto.ts`，一个 import 都不许有（投影已并进 `app/read.ts`；
   检查脚本第 2 组的目标仍是 `src/core/view/`，合并后目录里只剩这一个文件）。
5. **`app/` 不许 import `node:http`** —— 用例要能脱离网络被直接测试。
6. **`interface/` 是唯一碰 `node:http` 的地方**，但它只许经 `app/` 与 `view/` 说话：
   不许 import `agent|channel|team|runtime` 的内部实现（否则业务会再长回 handler 里）。

## 2. 全量文件（`src/core` 下 46 个 ts，10371 行；行数会漂，以表里的职责为准）

| 文件 | 行数 | 里面有什么 |
| --- | --- | --- |
| `fsx.ts` | 130 | `createFsx(root)` → `{read / write / list / exists / remove}`，路径一律相对工作区，越界抛 `FsxEscapeError`；列表用**码点**排序（`localeCompare` 跟机器 locale 变，会打穿 prompt cache）；读不到返回 `undefined`（缺席是常态），写失败才抛 |
| `doc.ts` | 86 | `parseDoc` / `renderDoc` / `readDoc` / `writeDoc` / `frontOf` —— identity / 团队 README / SKILL / rules / memory 全是 `{path, front, body}`，只有这一份实现；头只认单行 `key: value`（多行值不解析也不丢）；读入统一换行 |
| `text.ts` | 140 | `renderSlots`（返回 `{text, issues}`，装配层要区分两种错）/ `renderTemplate`（只返回文本的便捷壳）/ `slotsIn` / `hasSlot` / `toolSlots`（delivery 段没有注册表可查，`{{tool:say}}` 按后缀自解释——名字写错不报错，靠 seed 侧检查兜）；`unknown`（模板写了、装配没给 = 缺陷）与 `unset`（给了、现在确实是空 = 事实）分开报；不二次展开、纯函数 |
| `prompt.ts` | 167 | `loadTemplates` / `renderPrompt` / `renderPromptDir` / `promptDirOf`：文件名 `NN-段名.md` 定序（不合法直接抛，顺序是语义）；`skip-empty` 为空则整段消失；`use: delivery` 不进系统提示词；模板缓存只允许落在 async 边界上，不跨轮复用 |
| `runtime/index.ts` | 36 | 防腐层再导出：`BACKGROUND_CONTEXT` / `createRegistry` / `defineDoc` / `defineTool` / `openCore` / `setupModels` / `compactionSettings` / `Type` |
| `runtime/open.ts` | 386 | `openCore({databasePath, models, registry, settings?, onReport?}) → {harness, registry, close}`；open 之后先跑 `reconcileZombieTasks()`（ADR-025）；`onReport` 把底座的错误出口接成 `RuntimeReport`（ADR-083） |
| `runtime/models.ts` | 272 | `setupModels()`：读 `settings.json` 的 `providers` 数组 → `createProvider` → `setProvider`；回落到环境变量 / 本地网关。`contextWindow` 取自 pi-ai 的模型目录，取不到回落 `FALLBACK_CONTEXT_WINDOW = 128 * 1024`；`compactionPolicyFor` / `compactionSettings` 按窗口算压缩阈值（reserve 15%、keepRecent 10% 底 8192、background 5%），并按 `provider/model` 出 overrides |
| `runtime/io.ts` | 37 | `readTextOrUndefined`（读不到就是 `undefined`，不抛）/ `createSerialGate`（同一把串行锁）—— 全仓只有这一份 |
| `runtime/serialize.ts` | 59 | `serializedHarness()` —— 同一进程里所有 `harness.commit` 排队跑（底座的文档代理是按读集覆盖，不排队就会互相吃掉） |
| `agent/frontmatter.ts` | 54 | `parseFrontmatter` / `stripFrontmatter` / `renderFrontmatter` —— identity / SKILL / 团队 README 的 YAML 头只有这一份实现，字段顺序与渲染字节是合同（黄金测试钉住） |
| `agent/identity.ts` | 119 | `parseIdentity` / `readIdentity` / `readAllIdentities` / `reportsOf` / `chainUp` / `managerOf`；头字段只四个：`name` / `title` / `manager` / `team`；`OWNER_SLUG = "owner"` |
| `oneline.ts` | 17 | `oneLine(text, max)` —— 折成一行 + 超长截断；频道摘要、投递预览、团队记忆、界面副标题共用 |
| `agent/rules.ts` | 41 | `loadRules()` / `renderRulesSection()` —— 读 `<workspace>/rules.md` 并排成「## 规矩」一节；缺文件 = 整段不出现 |
| `agent/runtime.ts` | 363 | `agentSections()`（**async**）—— 每段一个 section key（`<slug>-<segment>`、`tag:false`，ADR-083）；`slotsFor()` 只填**这段模板真用到的**插槽（保住按段懒读）；`registeredTools()`（从注册表实拍工具清单）、`renderAgentSection()`（每次重读盘，含 `rules.md`）、`readTeamBrief()` |
| `agent/memory.ts` | 295 | `readMemory` / `sectionsOf` / `appendMemory` / `writeMemory` / `memoryDigest` / `memoryTimeline` / `entryProblem`；`MEMORY_FILE="memory.md"`、`DIGEST_LIMIT=12`、`MEMORY_LIMITS={entry:300, main:4_000}`；写入去重 + 串行 + 记一笔 journal |
| `agent/journal.ts` | 49 | `appendJournal()` —— `<agentDir>/.memory-journal.jsonl` 追加一行 JSON（谁、何时、append/replace、before/after 全文）；失败只 warn |
| `agent/secrets.ts` | 100 | `loadSecrets` / `redactor` / `redact` —— 读 `<workspace>/.secrets.json`，把密钥的三种形态（原值 / JSON 转义 / URL 编码）从文本里抹掉 |
| `agent/skills.ts` | 195 | 两层技能：`listSkills` / `readSkill` / `writeSkill` / `writeCompanySkill` / `copySkillDir` |
| `agent/create.ts` | 88 | `slugify`（中文保留）/ `uniqueSlug` / `renderIdentityFile` / `createAgent` |
| `agent/roster.ts` | 65 | `DirectoryDoc`、`conversationFor` / `slugFor` / `wakeOf` —— 名册是缓存，不是真相 |
| `team/doc.ts` | 157 | `teams/<slug>/README.md` 的读写；`TeamDoc{slug,name,lead?,doing?,status,body}`、`membersOfTeam()` |
| `team/memory.ts` | 150 | `teams/<slug>/memory.md` + `settleCandidates()`（不按 `kind` 筛，只排除整理者自己）/ `renderSettlePrompt(template, team, candidates)`（**只做排版**：候选排成 `{{candidates}}`、填 `{{team}}` `{{pending}}`，判据在 `seed/prompt/95-settle.md`） |
| `team/settle.ts` | 240 | 自动沉淀：`settleProject` 已改名 `settleTeam` / `settleTarget`；单游标（问完只记 `waiting`，记忆文件 mtime 变了才推进，ADR-033）；走 `wake()` 而不是直投；**模板缺了就不问**（warn + 游标不推进，等模板补上下次再问）；失败时往团队频道留一条 `note`（`appendTeamNote`） |
| `channel/store.ts` | 494 | 频道的**纯规则**（原 `state.ts` + `alias.ts` 合并）：`ChannelDoc`（增量满 64 条压基线，ADR-027）/ `chatKind`（**只看成员表**：恰好 `{我, 一人}` = `dm`）/ `teamId` / `fallbackChannelId`（只找最近活跃的群；一个群都没有就回落 `dm:owner-<slug>`）/ `recipientsOf` / `unreadCount` / `markRead` / `ensureChannel`；`parseMentions` 的别名只认 `slug` / `name` / `我` / `owner` **精确匹配**（`@CEO`、拼音、title、`@老板` 一律丢弃，ADR-088）。接力上限（原 `relayLimit` / `botHopsSinceOwner`）已删，改由 `rules.md` 第 13 条约束（ADR-090） |
| `channel/post.ts` | 799 | `postMessage()` —— **写一条 + 唤醒**的唯一入口（落库与唤醒必须成对）；`appendNote()` 系统留痕；`deliver()`（唯一跨 agent 原语，ADR-008）/ `renderDelivery` / `renderReplyRules` / `renderDigest` / `queuedAhead` / `coalesceQueue` / `deliveryPrompt`（三份模板：reply / interrupted / settle）。原 `deliver.ts` 并进来 |
| `channel/files.ts` | 405 | 附件（原 `uploads.ts` + `attach.ts` 合并）：`putUpload` / `readUploadMeta` / `sweepOrphanUploads`（单文件一份元数据，频道文档里只存 id）/ `kindOfMime` / `mimeOf` / `nameFrom` / `contentDisposition` / `readBounded`（边读边数——先读完再比上限等于没有上限）/ `placeholderOf`（附件 → 模型能看到的那几行） |
| `channel/wake.ts` | 132 | `wake()` —— **叫醒一个人只有这一条路**：合并排队项、记 wake、重置「一轮一句」、提交、没产出留痕；正文用 `bodyOf(merged, busy)` 回调给（要先合并才知道并了几条）。`post()` 与 `team/settle.ts` 都走它 |
| `channel/tools.ts` | 1010 | **7 个工具**（`createCoreTools`，ADR-084 / ADR-090）：`say` / `chats` / `read_history` / `remember` / `hire` / `run` / `file`；同一件事的几种做法是一个 `action` 枚举，不是几个近义工具名。`say` 负责「在哪儿回话、叫醒谁」（**没有 `to`**：私聊只能我开），`defaultChannel` 兜底落到私聊**直接报错**。`me` / `skills` / `teams` / `write_team` 已删——它们是「用 `file` 读写某个固定路径 md」的包装，改自己就是写 `agents/<slug>/identity.md` |
| `channel/unanswered.ts` | 71 | 「叫了他但他这一轮没答上来」的留痕：`reasonText`（结算原因翻成人话）/ `renderUnanswered` / `watchSettled`（后台等结算，不 await、不抛，ADR-069） |
| `app/index.ts` | 52 | `createApp(services)` → `{snapshots, read, people, chat, files, uploads, diag}`；再导出 `OWNER_SLUG` / `AppError` / `CoreServices` / `readBody`（分层规则禁止 interface 层直接 import 领域实现） |
| `app/types.ts` | 94 | `CoreServices` —— 用例层看出去的「装配好的核心」 |
| `app/snapshot.ts` | 88 | `channelSnapshot()`（只读人 + 频道，SSE 增量用它）/ `snapshot()`（再加团队文档推出的两张查表）；团队文档按 `teams/` 目录 mtime + 250ms 窗口缓存 |
| `app/read.ts` | 589 | 读 + 人 + **投影**（原 `app/people.ts` 与 `view/index.ts` 并进来）：`channelList` / `channelDetail` / `messageView` / `orgView` / `attentionItems` / `labelIn` / `withLabels`，外加 `createPeople` 的档案与记忆读改写；每个入口都是「取快照 → 投影 → 返回 DTO」 |
| `app/chat.ts` | 166 | 说话用例：`postMessage` / `createChannel` / `markRead`；校验（`from` 只认我、附件必须在盘上、已读夹到上界）在这里而不在路由里 |
| `app/files.ts` | 242 | 右栏只读文件树 + 附件语义（原 `app/uploads.ts` 并进来）：三道闸（前缀 → `lstat` 不跟链 → `realpath` 再验，越界一律 `forbidden`）/ `createUploads` / `mapLimit` |
| `app/diag.ts` | 139 | `record()`（卡顿落 `logs/jank.jsonl`）/ `recordRuntimeReport()` / `lastReport()` / `formatRuntimeReport()`；运行报告落 `logs/runtime.jsonl`，`task_outdated` 算良性（ADR-083）。单条 4KB、单文件 5MB 轮转一代 |
| `app/errors.ts` | 20 | `AppError` + 五个 reason（`bad-request` / `forbidden` / `not-found` / `too-large` / `internal`），**刻意不带状态码**：说「找不到」，不说 404 |
| `view/dto.ts` | 223 | **界面吃的每种 JSON 只在这里定义一次**（ADR-082）：零 import、零函数、零 IO —— 它是**契约层**（投影已并进 `app/read.ts`）；`ui/app/src/api/types.ts` 只是 type-only 再导出它 |
| `interface/http/routes.ts` | 222 | 路由表：18 条 `/api/*`（按方法 + 路径算）+ `*rest` 静态兜底。handler 只做「解析参数 → 调 `app/` → 序列化」 |
| `interface/http/server.ts` | 733 | HTTP 原语 + 表驱动匹配 + 来源闸 + 静态资源 + 网卡探测（原 `match` / `guard` / `network` / `static-assets` 都并进来）：`json` / `fail` / `readJson` / `serveStatic` / `matchRoute`（`:name` 捕获 / `*name` 吃余量）/ `isWildcardHost` / `browserUrlOf`；静态资源带 ETag（按编码）+ Last-Modified + `Vary` + br/gzip 协商 |
| `interface/http/sse.ts` | 262 | SSE 两半都在这里：编解码纯函数（`encodeEvent` / `retryFrame` / `keepAliveFrame`，唯一能脱离 socket 单测的部分）**和**有状态的 `createStreamHub`（连接集合、120ms 去抖、每连接每频道游标；`org` 推整份快照，`create` 只推订阅者） |
| `shell/assemble.ts` | 626 | `assembleCore()` —— 扫文件夹 → 开会话 → 绑名册 → 建频道；`addToCompanyChannel` / `joinTeamChannel` / `syncTeamChannel` / `ownerSpeak` / `makeAfterPost`；`identityExtension` / `installIdentity` 是 async（身份段要 await 读模板） |
| `shell/rescue.ts` | 164 | 「他答了但没说出来」的安全网：`startAnswerRescue` / `spokeAfterWake` / `slugOfConversation`（ADR-067） |
| `shell/seed.ts` | 330 | `seedOwnerAssistant`（读 `seed/agents/assistant/identity.md` 建人 + 助理个人层技能，只建一次）/ `seedPromptTemplates`（`seed/prompt/*.md` 只补不改地补进 `workspace/prompt/`）/ `syncCompanySkills`（公司层技能按 hash 同步，ADR-039）/ `seedRules`（`rules.md`，只补不改）/ `seedPersonalSkills`；常量 `SEED_ASSISTANT_IDENTITY` / `SEED_ASSISTANT_SKILLS` |
| `shell/serve.ts` | 134 | `serveCore()` —— 只留装配顺序、进程级的东西（端口 / Host·Origin 闸 / listen·close / 启动横幅）、把兜不住的异常翻成 500；路由与 SSE 都在 `interface/http/` |
| `shell/main.ts` | 176 | 启动：播种规矩 / 提示词模板 / 公司层技能（`seedRules` / `seedPromptTemplates` / `syncCompanySkills`）→ 必要时建人 → 读模型 → `createDiag` → `openCore({settings: {compaction}, onReport})` → `assembleCore` → `serveCore` → 等 Ctrl-C；并自检「记忆整理」技能在不在 |

### 2.2 `ui/app/src/`（React + TS，构建到 `ui/web/`，ADR-079）

源码在这里，产物在 `ui/web/`（服务端发那个目录，**别手改产物**）。改完必须 `npm run ui:build`。

| 文件 | 职责 |
| --- | --- |
| `ui/app/index.html` | 页面骨架 + **首帧定色的内联脚本**（放样式之前，否则先白一下再变深） |
| `ui/app/vite.config.ts` | 构建配置。`outDir: "../web"`、`emptyOutDir: false`（清空会在出错时连 index.html 一起删掉） |
| `src/main.tsx` | 入口：装样式、`bootstrap()`、挂 `<App>` |
| `src/App.tsx` | 外壳装配：三列网格、头部（标题 / 状态 / 找你 / 团队 / 设置 / 详情）、主题与布局落地、键盘（Esc 关浮层、⌘K 开「找你」） |
| `src/state/store.ts` | **唯一状态源**（`useSyncExternalStore`）。拉数据、SSE 打补丁、`openChannel`/`loadEarlier`/`applyMessage`、在线状态推导、localStorage 三键 |
| `src/state/useStore.ts` | 40 行薄封装。**选择器必须外部声明**，否则每次渲染都是新函数 → 无限重渲染 |
| `src/api/client.ts` | 全部 `fetch` 包装。**每个后端路由必须在这里有消费者**（边界检查会扫 `ui/app/src`） |
| `src/api/types.ts` | **type-only 再导出** `src/core/view/dto.ts`：后端改字段这里就编译不过。权威定义只有那一份，不要在这儿加后端没有的字段（ADR-016） |
| `src/stream/model.ts` | **消息 → 行模型，纯函数** `buildRows()`。时间分隔、同一人两分钟内算一段 / 半分钟内连发合并气泡、`note` 单独一行。历史库里的 `think`/`tool`/`work`/`step` 直接过滤，不画（ADR-081） |
| `src/stream/Stream.tsx` | 把行画出来 + 贴底/上翻/回到最新 |
| `src/rows.ts` | 只剩 `isNeed()`：这条要不要我处理（顶栏「N 件找你」与左侧 2px 竖线的唯一来源） |
| `src/sidebar/Sidebar.tsx` | 侧栏：logo、可收起成 56px 图标条、一列平铺频道（两行：名字+状态 / 预览） |
| `src/composer/Composer.tsx` | 输入卡：自增高、Enter/Shift+Enter、**中文输入法合成期不误发**、@ 弹层、附件队列、拖拽、粘贴、引用条 |
| `src/panels/RightPanel.tsx` | 右栏第三列：两个 tab（详情 / 文件）。关的时候等 300ms 过渡再卸载 |
| `src/panels/Overlays.tsx` | 设置、找你清单、团队、toast。**同一时刻只开一个**（图片灯箱在 `App.tsx`） |
| `src/hooks/useStreams.ts` | org 与频道两条 SSE（`org` / `create`）；失败退避 1s→15s；org 推送交给 `store.refreshLists`（侧栏与「找你」只有这一条刷新路） |
| `src/hooks/useToasts.ts` | 三条上限 / 3.6 秒 |
| `src/lib/avatar.ts` | 手绘 SVG 头像（三族身体 × 六色）、四种状态、`groupAvatar()` 群组头像 |
| `src/lib/markdown.ts` | `renderMarkdown()` —— 最小 Markdown，**先转义再拼** |
| `src/lib/copy-code.ts` | 代码块「复制」：`CODE_COPY_CLASS` 一处定义，`installCodeCopy()` 在 `main.tsx` 装一次全局委托（正文是 `dangerouslySetInnerHTML` 注入的，React 事件接不到里面的按钮） |
| `src/lib/format.ts` | 转义、相对时间、`clockTime` / `dayLabel`、`humanBytes`、`unreadLabel`、`copyText` |
| `src/lib/jank.ts` | 卡顿自报：长帧 > 240ms / 长任务 > 200ms 才记一条，`mark(label)` 标「当时在干什么」，攒够 5 秒或 `pagehide` 发 `POST /api/diag` |
| `src/panels/MemoryDrawer.tsx` | 记忆抽屉：读 / 加 / 删一条，每条画一行来历（`at` / `by` / `op`，没有日志就不画） |
| `src/styles/*.css` | 八个样式文件，顺序见 `styles/index.css`（token 先落地） |
| `public/fonts/*.woff2` | Montserrat 300/400/500（本地字体，只用于品牌名） |

## 3. 「我想改 X → 动这里」

| 想改什么 | 动这里 | 注意 |
| --- | --- | --- |
| 加一个工具（能力） | `channel/tools.ts` 的 `createCoreTools` | 工具 description 就是说明书，写清「什么时候用」；同一件事的几种做法用一个 `action` 枚举，不要开新工具名（现在是 7 个，ADR-084 / ADR-090）；加完数一遍总数 |
| 教 agent 一套做法 | **不要写代码**，写 `seed/skills/<名字>/SKILL.md` 或让 agent `skills(action=write)` | 见 ADR-007 |
| 改一段提示词的**措辞** | `seed/prompt/NN-段名.md`（播种进 `workspace/prompt/`，之后以 workspace 为准） | 改文案不用改代码、不用重启，下一条消息生效。一个 md = 一段 = 一个 cache section，文件名前缀定序 |
| 加一段提示词 / 改段落顺序 | 在 `seed/prompt/` 加 `NN-段名.md` + `scripts/prompt-fixture.ts` 补它用到的样例插槽 | 顺序是语义（规矩在能力前面），改顺序会触发一次性整块重写（ADR-083）；确定性是硬要求（ADR-005），`npm run prompt:check` 会拦 |
| 加一个插槽 | `docs/design/SEED-CONTRACT.md` §4 登记（值 + 来源）+ `scripts/prompt-fixture.ts` 给样例值 + 装配层填值 | 插槽表是唯一权威；未知插槽渲染成「（未设置）」并报出来，不许静默变空 |
| 工具名要出现在提示词里 | 写 `{{tool:xxx}}`（注册表实拍，工具改名自动跟） | 不许写字面量 —— V2 的 40 处硬编码就是这么烂掉的 |
| 改「全公司都要守的规矩」（先给结论、在哪个频道回话、别写英文独白） | **不要写进 `.ts`**：改 `seed/rules.md`，再同步到 `workspace/rules.md` | 每轮都进提示词的只有这一份（ADR-038）；技能正文只在 `skills(action=read)` 时才进上下文 |
| 改起手技能的同步行为 | `shell/seed.ts` 的 `syncCompanySkills` + `<workspace>/.seed-manifest.json` | 按 hash 判「用户改过没有」，改过的不覆盖（ADR-039） |
| 加一个身份字段 | `agent/identity.ts` 的 `IdentityHeader` | 现在是 4 个：`name`/`title`/`manager`/`team`，加之前先问能不能推导 |
| 改「这条会话是私聊还是群聊」 | `channel/store.ts` 的 `chatKind` | **只看成员表**（恰好 `{我, 一人}` 才是私聊），不看 id 前缀；界面的 `kind` 只是它的投影 |
| 改谁能被 @ 到 / 什么写法算 @ | `channel/store.ts` 的 `recipientsOf`（成员规则）+ `parseMentions`（名字 → slug） | 两件事分开改：成员过滤是安全边界，别名只是翻译。别名只认 `slug` / `name` / `我` / `owner` **精确匹配**（ADR-088）；`@CEO`、拼音、title、`@老板` 一律丢弃，不许加回模糊匹配 |
| 改「要我拍板就 @ 我」 | `channel/tools.ts` 的 `say`（ADR-037） | 只有两种情形把 `owner` 加进 `mentions`：正文显式 @我；或 `kind=decision` 且没点别人。补的是 `mentions`，**不改正文**；关键词嗅探已删 |
| 改「没明确频道时在哪儿回话」 | `channel/store.ts` 的 `fallbackChannelId` + `channel/tools.ts` 的 `defaultChannel` | 兜底只找最近活跃的真实频道；**落到私聊就报错**让模型显式给 channel，不静默写进一个不存在的频道（这条踩过：话写成功了，频道里谁都看不见） |
| 改频道成员怎么来 | `shell/assemble.ts` 的 `joinTeamChannel` / `syncTeamChannel` / `addToCompanyChannel` | 成员是 `identity.md` + 团队 `README.md` 的投影（ADR-012）；公司频道只是播种一次的普通群，没有特权 |
| 加一条 HTTP 路由 | `interface/http/routes.ts` 的 `routes` 表 + `app/` 里的一次用例调用 + `ui/app/src/api/client.ts` 里的消费者 | handler 只做「解析 → 调 app → 序列化」，≤30 行；业务校验属于 `app/`。没有消费者边界检查会失败 |
| 改路由匹配 / 静态资源 / 来源闸 / 网卡 | `interface/http/server.ts` | 表驱动匹配（`:name` / `*name`）、ETag 与压缩协商、Host·Origin 闸都在这里；别自己拼 `writeHead`，走 `json` / `fail` 四个出口 |
| 改 SSE（事件形状 / 去抖 / 游标） | `interface/http/sse.ts` | 编解码是纯函数（`encodeEvent` 等）、有状态那半是 `createStreamHub`；先看 `test/core/sse.test.ts` 与 `hub-stream.test.ts` |
| 改附件（落盘 / 上限 / 清理） | `channel/files.ts`（字节与元数据）+ `app/files.ts`（语义：内联还是给路径） | 上限与「先读完再比等于没有上限」都在 `channel/files.ts`；别把字节塞进频道文档（ADR-027 的教训） |
| 改界面字段 | `view/dto.ts`（先改 `docs/WEB-API.md`）+ 投影在 `app/read.ts` | DTO 是唯一权威，`ui/app/src/api/types.ts` 只是它的 type-only 再导出 —— 改字段界面立刻编译不过。字段必须有前端消费者（ADR-016） |
| 改界面样式 / 交互 | `ui/app/` | **改完必须 `npm run ui:build`**；文件职责见 §2.2 |
| 改「上翻看历史 / 回到最新」 | `ui/app/src/stream/Stream.tsx` 的 `rememberAnchor` / `toBottom` 与 `state/store.ts` 的 `loadEarlier` | 补历史**只往前面插**、用锚点行按回原位，别改回整列重建（ADR-052） |
| 改团队记忆沉淀的触发条件 / 游标时机 | `team/memory.ts` 的 `settleCandidates` + `team/settle.ts` 的 `waiting` | 游标语义在 ADR-033（取代 ADR-013），改之前先读懂 |
| 改「这批消息该不该记」的判据 | `seed/prompt/95-settle.md` —— **不要写进 `team/memory.ts`** | 判据是 `use: delivery` 的模板：decision 必记、report 看是否超出当前任务、纯过程话不记；技能正文不在沉淀那一轮的上下文里，所以判据必须写在正文里 |
| 改「什么该记、什么不该记」 | `seed/skills/记忆整理/SKILL.md` —— **不要写代码** | 提示词只说「按那份技能整理」 |
| 换模型 / 加自定义模型 | `workspace/settings.json` 的 `models`；代码在 `runtime/models.ts` | 别复活「内置模型覆盖」机制（ADR-021） |
| 播种出厂内容 | `shell/seed.ts`：`seedRules`（规矩，只补不改）/ `seedPromptTemplates`（`seed/prompt/`，只补不改）/ `syncCompanySkills`（公司层技能，按 hash 同步，ADR-039）/ `seedOwnerAssistant`（助理身份读 `seed/agents/assistant/identity.md`）/ `seedPersonalSkills` | 规矩与提示词模板只补不改（可能被用户亲手改过）；技能按 hash 判断改没改；助理身份只建一次；`seed/pool/` 不播种 |
| 改 seed 出厂内容的规矩 | `docs/design/SEED-CONTRACT.md` + `test/core/seed-contract.test.ts` | 一条事实一个家、`rules.md` ≤15 条零工具名、技能 ≤4 KB、项目技能不进公司层 —— 这些是机械验收，改 seed 前先读契约 |

## 4. 启动顺序（第 3 步最容易出错）

`main.ts`：

0. `seedRules` + `seedPromptTemplates` + `syncCompanySkills`（`--no-seed` 时不跑）—— 规矩、
   提示词模板、公司层技能每次启动各同步一遍（ADR-039），并自检「记忆整理」技能是否存在
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
   `joinTeamChannel`）或新建会话 → `addToCompanyChannel` → `joinTeamChannel`；
4. **一次 commit** 把名册写回（每个人一次 commit 会让启动慢一个数量级）；
5. 播种公司频道（已存在就补缺失成员）；
6. `rescan()` 可从外部再触发（改完 `identity.md` 加人不必重启）。

**坑**：第 3 步的 `openOne` 必须同时做「进公司频道」和「进团队频道」，两者都幂等。
第一版只在 `rescan()` 里补团队频道，于是「改 identity 加上 team」的人永远进不去。

**坑（已定，未落）**：`assembleCore` 现在读不到任何 system 模板时只 warn，症状是「提示词
全空但服务正常启动」。定论是**模板目录不存在或为空就抛**（单段缺失不抛 —— `skip-empty` 就是
为合法编辑准备的）。卡在 `assemble.test.ts` 那批临时工作区只建了 `agents/`、没播种 `prompt/`，
要先让它们补 `seedPromptTemplates(root)` 才能落，否则一次红 55 条。

会话形态不在这里决定：没有「个人频道」这种东西，也没有 `ensurePersonalChannel`。
私聊是成员恰好 `{我, 一人}` 的会话，我开的时候才有；一个 agent 不进任何群也能活。

## 5. 改动前的检查清单

```bash
npm run check        # tsc --noEmit + 边界检查
npm test             # 61 文件 / 549 例，应该 <3s
npm run prompt:check # 提示词黄金渲染：确定性、插槽全填、每段 ≤12 行、模板里零工具名
npm run live         # 真实模型端到端 12 项，会花 token，只在改行为后跑；连跑两次都要 12/12
```

`live` 的验收门是**两条 + 一个趋势**（ADR-089）：两次 12/12；`rescue` 补发的内容/频道/去重
正确（单测守）；`rescue` 次数记下来 —— 7 个阶段超过 4 次就是提示词在退化。`rescue=0` 不是门。

改行为时**必须**同步三处：代码、`test/core/` 里的用例、`docs/`（`CORE` 概念 / `WEB-API`
字段 / `DECISIONS` 若碰了不可轻易改的约定）。

真实模型自测是保底：549 个单测全绿而 `npm run live` 只过 4 项的情况**发生过**——
那一次是两个 bug 叠在一起（`ownerSpeak` 漏传 wake + wake 在 `submit` 之后才落盘），
症状是「我在群里问，对方在私聊里答」，单测完全看不见。

## 6. 测试布局

`test/core/`（50 文件，纯函数 + 装配）：

| 文件 | 覆盖 |
| --- | --- |
| `channel-state.test.ts` | @ 解析、`chatKind` 只认成员表、四类收件人、`dmId` 顺序无关、未读、幂等建频道 |
| `channel-write.test.ts` | 频道写入的字节代价（ADR-027 的底线：每写一条花多少字节是契约） |
| `mention-alias.test.ts` | `@` 别名解析（ADR-036）：`@我` 的 6 种叫法、CEO/真名/title、垃圾 token 丢弃、老数据兜底 |
| `rescue.test.ts` | 答了却没说出来：补发判据、序号自愈（ADR-067） |
| `queue-jump.test.ts` | 我问话插队：只撤同会话 `queued` 项、最多 5 条、我自己排的不让路（ADR-066） |
| `say-contract.test.ts` | `say` 的落点契约：兜底频道不落私聊、投递正文带频道 id、`decision` 自动补 `owner`（ADR-037）、`[PASS]` 与单人在场不许静音（ADR-063）、过程话可连发（「一轮一句结论」已降级为 `rules.md` 约束，ADR-090） |
| `deliver.test.ts` | 投递正文 / 未读摘要 / 失败不阻塞 |
| `post-failure.test.ts` | 投递失败可见：目标没会话时留 note、投递抛错时写「投递失败：会话已关闭」（原在 `relay.test.ts`，接力上限删掉后单独成文件，ADR-090） |
| `identity.test.ts` | YAML 解析、`reportsOf`/`chainUp`；渲染部分走 V3：真实工作区 + 播种 `prompt/`，覆盖名字/正文/汇报线/团队 README/目录不谎报、确定性、工具清单从注册表实拍 |
| `memory.test.ts` / `memory-forget.test.ts` | 分区、追加、摘要；`removeSection` 按 `sectionsOf` 的口径重建 |
| `memory-timeline.test.ts` | `memoryTimeline()`：从 journal 反推每节来历（add/edit、时间、作者）、没变不刷新、删掉不留、坏行跳过 |
| `memory-actor.test.ts` | 记忆面板留痕写上真实来源（`human` / `remember` / `agent`） |
| `journal.test.ts` | 记忆日志：追加一行 JSON、落盘失败只 warn |
| `secrets.test.ts` | 读密钥、三种形态的脱敏 |
| `skills.test.ts` | 两层覆盖、拷贝不覆盖、frontmatter |
| `org.test.ts` | slug、建人、组织架构投影 |
| `models.test.ts` | `setupModels` 的默认模型 |
| `team.test.ts` | 团队 README 的读写、`lead` / `doing` / `membersOfTeam` |
| `team-memory.test.ts` | `teams/<slug>/memory.md`：追加、候选筛选 |
| `settle.test.ts` / `settle-e2e.test.ts` | 沉淀纯函数 + 装配层端到端（单游标语义） |
| `shell.test.ts` / `shell-e2e.test.ts` | 装配、重启幂等、wake 记录位置 |
| `assemble.test.ts` | 播种、多 agent、频道成员 |
| `directory-persist.test.ts` | 加人之后重启：复用同一个会话、不制造孤儿 |
| `doc-checkpoint.test.ts` | 名册 / 沉淀游标按增量条数压基线 |
| `view.test.ts` | 视图投影（`kind` / `role` / 未读、侧栏预览只取人说的话） |
| `attention.test.ts` | 「找你」（`GET /api/attention`）：只收点名 @我的、排除我自己发的、7 天窗口、已读带标记 |
| `rules-prompt.test.ts` | 规矩进提示词（走装配层同一个 `renderAgentSection()`）：位置在身份后能力前、缺了整段消失、确定性、`loadRules` 读盘、`seed/rules.md` 覆盖八条 |
| `monologue.test.ts` | 内心独白拦截：英文计划式开场拦住、中文汇报里夹英文不拦、太短不判（ADR-058） |
| `seed-sync.test.ts` | 公司层技能同步（缺的补上 / 未改的更新 / 改过的不动 / 幂等 / manifest / `rules.md` 只补不改） |
| `unanswered.test.ts` | 结算原因翻成人话 |
| `history.test.ts` | `read_history` 能翻到被压缩掉的历史 |
| `attach.test.ts` | `planAttachments`：哪些附件给模型读、怎么读 |
| `uploads-sweep.test.ts` | `sweepOrphanUploads`：没人引用的附件被清掉 |
| `files-list.test.ts` | `mapLimit`：并发有上限、顺序不变 |
| `safety.test.ts` | `resolveInWorkspace`：越界路径一律拒 |
| `http-guard.test.ts` | `hostAllowed`：Host 头必须是本服务自己 |
| `reconcile.test.ts` / `runtime-reconcile.test.ts` | 僵尸任务回收 + 启动自愈真的跑完了 |
| `serialize-commit.test.ts` | `serializedHarness`：同一进程里的 commit 排队跑不互相吃 |
| `diag.test.ts` | 运行报告：底座形状摊平成可落盘的 JSON、`formatRuntimeReport` 的人话、写 `logs/runtime.jsonl`、`lastReport` 跳过 `task_outdated`、超长报告被截到 4KB、工作区不可写也不抛 |
| `prompt-render.test.ts` | V3 模板渲染：文件名定序、段名唯一、`skip-empty` 空则整段消失、delivery 不进系统提示词、两次渲染逐字节相同、模板声明的插槽全被填满 |
| `text-slots.test.ts` | 插槽：未知 →「（未设置）」并报 `unknown`、空串/纯空白报 `unset`、值里带 `{{}}` 不二次展开、确定性 |
| `seed-contract.test.ts` | seed 契约的机械验收：`rules.md` ≤15 条零工具名、一条事实一个家、`seed/prompt` 十一段齐、`{{tool:X}}` 与注册表真名对表、人名只在 identity.md、项目技能不进公司层、技能 ≤4 KB、seed <500 KB |
| `dto.test.ts` | DTO 是唯一权威：`dto.ts` 自己零 import、界面类型文件只再导出、界面用的名字都在 DTO 里；投影输出与 DTO 字段一一对应 |
| `sse.test.ts` | SSE 编解码：一帧的字节形状、多行 JSON 不会被拆行、`retry` / 保活注释 |
| `tools-actions.test.ts` | 工具收敛：注册表只剩 **7** 个、旧名字一个不剩；`chats` / `read_history` / `file` 各自的 `action` 默认值与非法值报错 |

`test/ui/`（11 文件，前端里能脱离浏览器跑的那部分）：

| 文件 | 测什么 |
| --- | --- |
| `stream-model.test.ts` | `buildRows()`：同一人连发 `grouped` / `cont` 的口径、时间分隔、历史 `think/tool/work` 被过滤 |
| `stream-events.test.ts` | 频道 `EventSource` 的事件（`create` 幂等 upsert） |
| `sidebar-order.test.ts` | `sortChannels`：侧栏排序 |
| `md-copy.test.ts` | 代码块复制按钮（生成的 HTML 有按钮 + 启动时装了委托）、设置面板选中态（`aria-checked` 两边一致） |
| `side-rail.test.ts` | 侧栏收起成图标条 |
| `unread-badge.test.ts` | `unreadLabel`：未读徽标文案 |
| `head-subtitle.test.ts` | `headParts`：顶栏副标题拼装 |
| `right-panel.test.ts` | 右栏：后端字段都画出来 / 没技能没记忆就明说（ADR-056） |
| `composer-alignment.test.ts` | 引用条与附件托盘的居中轨道 |
| `wrap-css.test.ts` | 消息正文换行 |
| `jank.test.ts` | `classifyJank()`：hidden / resumed / foreground 三判；`mark()` 幂等 |
