# 代码地图

要改某个东西，该动哪个文件。**概念**见 [CORE](CORE.md)，**接口字段**见 [WEB-API](WEB-API.md)。

## 1. 分层与边界

```
src/core/
  runtime/   防腐层：唯一能 import @earendil-works/* 的地方
  agent/     一个人：身份 / 提示词 / 记忆 / 技能 / 名册
  team/      一个团队：README.md / memory.md / 自动沉淀
  channel/   说话：纯规则 / 投递 / 写一条 / 17 个工具
  shell/     外壳：装配 / HTTP+SSE / 视图投影 / 启动
    http/    路由表 / 静态资源 / 网卡探测 / 来源闸
ui/app/      界面源码（React + TS + Vite；构建产物 `ui/web/`）
seed/        起手技能（公司层 + 助理个人层）+ 规矩文案 `rules.md`
scripts/     三个脚本：边界检查、真实模型自测、team 改名迁移
```

**三条边界**（`scripts/check-boundaries.mjs` 机械化，违反即 `npm run check` 失败）：

1. 只有 `src/core/runtime/` 能 import pi-durable / pi-ai / chord。
2. 内核（`agent|team|channel`）不得反向 import `shell/` —— 依赖只能 `shell → 内核`。
3. `serve.ts` 的每条 `pattern` 必须在 `ui/app/src` 里有消费者（白名单：`/api/org`，
   Docker 健康检查用）。

## 2. 全量文件（`src/core` 下 36 个 ts，9177 行；行数会漂，以表里的职责为准）

| 文件 | 行数 | 里面有什么 |
| --- | --- | --- |
| `runtime/index.ts` | 58 | 防腐层再导出：`BACKGROUND_CONTEXT` / `createRegistry` / `defineDoc` / `defineTool` / `openCore` / `setupModels` / `Type` |
| `runtime/open.ts` | 307 | `openCore({databasePath, models, registry, settings?}) → {harness, registry, close}`；open 之后先跑 `reconcileZombieTasks()`（ADR-025） |
| `runtime/models.ts` | 185 | `setupModels()`：读 `settings.json` 的 `providers` 数组 → `createProvider` → `setProvider`；回落到环境变量 / 本地网关 |
| `runtime/serialize.ts` | 59 | `serializedHarness()` —— 同一进程里所有 `harness.commit` 排队跑（底座的文档代理是按读集覆盖，不排队就会互相吃掉） |
| `agent/identity.ts` | 141 | `parseIdentity` / `readIdentity` / `readAllIdentities` / `reportsOf` / `chainUp` / `managerOf`；头字段只四个：`name` / `title` / `manager` / `team`；`OWNER_SLUG = "owner"` |
| `agent/prompt.ts` | 294 | `renderAgentPrompt()` —— 唯一的提示词渲染器，确定性（ADR-005）；首行定义「本提示词里的『我』指用户本人」；规矩一节来自 `rules.md`（ADR-038）；出口再 `redact()` 一遍（密钥不许进提示词） |
| `agent/rules.ts` | 41 | `loadRules()` / `renderRulesSection()` —— 读 `<workspace>/rules.md` 并排成「## 规矩」一节；缺文件 = 整段不出现 |
| `agent/runtime.ts` | 167 | `registeredTools()`（从注册表实拍工具清单）、`renderAgentSection()`（每次重读盘，含 `rules.md`）、`readTeamBrief()` |
| `agent/memory.ts` | 295 | `readMemory` / `sectionsOf` / `appendMemory` / `writeMemory` / `memoryDigest` / `memoryTimeline` / `entryProblem`；`MEMORY_FILE="memory.md"`、`DIGEST_LIMIT=12`、`MEMORY_LIMITS={entry:300, main:4_000}`；写入去重 + 串行 + 记一笔 journal |
| `agent/journal.ts` | 49 | `appendJournal()` —— `<agentDir>/.memory-journal.jsonl` 追加一行 JSON（谁、何时、append/replace、before/after 全文）；失败只 warn |
| `agent/secrets.ts` | 100 | `loadSecrets` / `redactor` / `redact` —— 读 `<workspace>/.secrets.json`，把密钥的三种形态（原值 / JSON 转义 / URL 编码）从文本里抹掉 |
| `agent/skills.ts` | 231 | 两层技能：`listSkills` / `readSkill` / `writeSkill` / `writeCompanySkill` / `copySkillDir` |
| `agent/create.ts` | 131 | `slugify`（中文保留）/ `uniqueSlug` / `renderIdentityFile` / `createAgent` / `renderOrgChart` |
| `agent/roster.ts` | 65 | `DirectoryDoc`、`conversationFor` / `slugFor` / `wakeOf` —— 名册是缓存，不是真相 |
| `team/doc.ts` | 181 | `teams/<slug>/README.md` 的读写；`TeamDoc{slug,name,lead?,doing?,status,body}`、`membersOfTeam()` |
| `team/memory.ts` | 178 | `teams/<slug>/memory.md` + `settleCandidates()`（不按 `kind` 筛，只排除整理者自己）/ `renderSettlePrompt()`（规则指向公司技能「记忆整理」，不复述清单） |
| `team/settle.ts` | 213 | 自动沉淀：`settleProject` 已改名 `settleTeam` / `settleTarget`；单游标（问完只记 `waiting`，记忆文件 mtime 变了才推进，ADR-033）；失败时往团队频道留一条 `note`（`appendTeamNote`） |
| `channel/state.ts` | 476 | 纯规则：`ChannelDoc`（增量满 64 条压基线，ADR-027）/ `appendMessage` / `recipientsOf` / `parseMentions` / `needsOwner`（决策句式，ADR-037）/ `chatKind`（**只看成员表**：恰好 `{我, 一人}` = `dm`，其余 `group`）/ `teamId`（`team:<slug>`）/ `fallbackChannelId`（只找最近活跃的群，一个群都没有才回落 `dm:owner-<slug>`）/ `unreadCount` / `markRead` / `ensureChannel` |
| `channel/alias.ts` | 117 | `@` 别名解析（ADR-036）：`resolveMention` / `mentionRosterOf` / `normalizeAlias`——`@我` / `@CEO` / 真名 / title → slug，名册由 `agents/*/identity.md` 喂进来 |
| `channel/deliver.ts` | 480 | `deliver()`（唯一的跨 agent 原语，ADR-008）、`renderDelivery`（第一行带频道 id；私聊多一句「只回这里」）、`renderReplyRules` / `renderDigest` / `queuedAhead` / `coalesceQueue` |
| `channel/unanswered.ts` | 71 | 「叫了他但他这一轮没答上来」的留痕：`reasonText`（结算原因翻成人话，没见过的原样贴）/ `renderUnanswered` / `watchSettled`（后台等结算，不 await、不抛，ADR-069） |
| `channel/speech.ts` | 35 | 「这一轮已经说过结果了」的进程内标记（`markSpoken` / `spokenResult` / `clearSpoken`）；`say` 不带 `step` 才算结果（ADR-064） |
| `channel/post.ts` | 288 | `postMessage()` —— 写一条（单元素 splice，ADR-027）+ 解析 @（可带 roster / 额外 mention）+ 投递 |
| `channel/attach.ts` | 121 | 附件 → 模型能看见的东西：`planAttachments()` 决定哪些附件给模型读、怎么读 |
| `channel/uploads.ts` | 282 | 附件落盘与清理：`isUploadId` / `kindOfMime` / `mimeOf` / `safeName` / `nameFrom` / `sweepOrphanUploads`（单文件一份元数据，频道文档里只存 id） |
| `channel/tools.ts` | 1186 | 17 个工具（`createCoreTools`）：say/read_channel/org/hire/update_identity/remember/recall/read_history/list_skills/read_skill/write_skill/list_teams/read_team/write_team/run/write_file/read_file；`say` 负责「在哪儿回话、叫醒谁」（**没有 `to`**：私聊只能我开），`defaultChannel` / `mentionRoster` |
| `shell/assemble.ts` | 673 | `assembleCore()` —— 扫文件夹 → 开会话 → 绑名册 → 建频道；`addToCompanyChannel` / `joinTeamChannel` / `syncTeamChannel` / `ownerSpeak` / `makeAfterPost` |
| `shell/rescue.ts` | 166 | 「他答了但没说出来」的安全网：`startAnswerRescue` / `spokeAfterWake` / `slugOfConversation`（ADR-067） |
| `shell/seed.ts` | 298 | `seedOwnerAssistant`（身份 + 助理个人层技能，只建一次）/ `syncCompanySkills`（公司层技能按 hash 同步，ADR-039）/ `seedRules`（`rules.md`，只补不改）/ `seedPersonalSkills` |
| `shell/serve.ts` | 1224 | `serveCore()` —— 17 条路由 + 两条 SSE（`org` / 频道 `create`）+ 静态文件 |
| `shell/view.ts` | 465 | 视图投影：`channelList` / `channelDetail` / `messageView` / `orgView` / `attentionItems`；`ViewChannelKind` **只有 `dm | group`**（`chatKind()` 的结果，不猜 id 前缀） |
| `shell/main.ts` | 144 | 启动：同步规矩与公司层技能（`seedRules` / `syncCompanySkills`）→ 必要时建人 → 读模型 → `openCore` → `assembleCore` → `serveCore` → 等 Ctrl-C；并自检「记忆整理」技能在不在 |
| `shell/http/routes.ts` | 122 | `matchRoute()` 表驱动路由（`:name` 捕获 / `*name` 吃余量） |
| `shell/http/static-assets.ts` | 201 | ETag / br+gzip 协商 / `loadAsset` |
| `shell/http/origin.ts` | 55 | 来源闸：`hostAllowed` / `originAllowed` —— 谁的页面有资格让这个服务「写」 |
| `shell/http/network.ts` | 78 | 网卡探测（启动时打印局域网地址） |

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
| `src/api/types.ts` | 后端视图的 TS 镜像。权威定义在 `src/core/shell/view.ts`，**不许加后端没有的字段** |
| `src/stream/model.ts` | **消息 → 行模型，纯函数** `buildRows()`。时间分隔、同一人两分钟内算一段 / 半分钟内连发合并气泡、`note` 单独一行。历史库里的 `think`/`tool`/`work`/`step` 直接过滤，不画（ADR-081） |
| `src/stream/Stream.tsx` | 把行画出来 + 贴底/上翻/回到最新 |
| `src/rows.ts` | 只剩 `isNeed()`：这条要不要我处理（顶栏「N 件找你」与左侧 2px 竖线的唯一来源） |
| `src/sidebar/Sidebar.tsx` | 侧栏：logo、可收起成 56px 图标条、一列平铺频道（两行：名字+状态 / 预览） |
| `src/composer/Composer.tsx` | 输入卡：自增高、Enter/Shift+Enter、**中文输入法合成期不误发**、@ 弹层、附件队列、拖拽、粘贴、引用条 |
| `src/panels/RightPanel.tsx` | 右栏第三列：两个 tab（详情 / 文件）。关的时候等 300ms 过渡再卸载 |
| `src/panels/Overlays.tsx` | 设置、找你清单、团队、灯箱、toast。**同一时刻只开一个** |
| `src/hooks/useStreams.ts` | org 与频道两条 SSE（`org` / `create`）；失败退避 1s→15s；org 推送合并成一次拉取 |
| `src/hooks/useToasts.ts` | 三条上限 / 3.6 秒 |
| `src/lib/avatar.ts` | 手绘 SVG 头像（三族身体 × 六色）、四种状态、`groupAvatar()` 群组头像 |
| `src/lib/markdown.ts` | `renderMarkdown()` —— 最小 Markdown，**先转义再拼** |
| `src/lib/format.ts` | 转义、相对时间、`clockTime` / `dayLabel`、`humanBytes`、`unreadLabel`、`copyText` |
| `src/lib/jank.ts` | 卡顿自报：长帧 > 240ms / 长任务 > 200ms 才记一条，`mark(label)` 标「当时在干什么」，攒够 5 秒或 `pagehide` 发 `POST /api/diag` |
| `src/lib/messages.ts` | `mergeMessages()` 两页按 `seq` 去重合并；`localEcho()` / `insertLocalMessage()` / `channelCursor()` / `enqueueMessage()`（按帧批处理的前置去重） |
| `src/panels/MemoryDrawer.tsx` | 记忆抽屉：读 / 加 / 删一条，每条画一行来历（`at` / `by` / `op`，没有日志就不画） |
| `src/styles/*.css` | 八个样式文件，顺序见 `styles/index.css`（token 先落地） |
| `public/fonts/*.woff2` | Montserrat 300/400/500（本地字体，只用于品牌名） |

## 3. 「我想改 X → 动这里」

| 想改什么 | 动这里 | 注意 |
| --- | --- | --- |
| 加一个工具（能力） | `channel/tools.ts` 的 `createCoreTools` | 工具 description 就是说明书，写清「什么时候用」；加完数一遍总数（现在是 17 个） |
| 教 agent 一套做法 | **不要写代码**，写 `seed/skills/<名字>/SKILL.md` 或让 agent `write_skill` | 见 ADR-007 |
| 改提示词的段落 | `agent/prompt.ts` 的 `renderAgentPrompt` | 必须保持确定性（ADR-005）；加了字段就要有测试 |
| 改「全公司都要守的规矩」（先给结论、在哪个频道回话、别写英文独白） | **不要写进 `.ts`**：改 `seed/rules.md`，再同步到 `workspace/rules.md` | 每轮都进提示词的只有这一份（ADR-038）；技能正文只在 `read_skill` 时才进上下文 |
| 改起手技能的同步行为 | `shell/seed.ts` 的 `syncCompanySkills` + `<workspace>/.seed-manifest.json` | 按 hash 判「用户改过没有」，改过的不覆盖（ADR-039） |
| 加一个身份字段 | `agent/identity.ts` 的 `IdentityHeader` | 现在是 4 个：`name`/`title`/`manager`/`team`，加之前先问能不能推导 |
| 改「这条会话是私聊还是群聊」 | `channel/state.ts` 的 `chatKind` | **只看成员表**（恰好 `{我, 一人}` 才是私聊），不看 id 前缀；界面的 `kind` 只是它的投影 |
| 改谁能被 @ 到 | `channel/state.ts` 的 `recipientsOf`（成员规则）+ `channel/alias.ts` 的 `resolveMention`（名字 → slug） | 两件事分开改：成员过滤是安全边界，别名只是翻译；改前者要同步 `test/core/channel-state.test.ts`，改后者同步 `test/core/mention-alias.test.ts` |
| 改「要我拍板就 @ 我」 | `channel/state.ts` 的 `needsOwner` + `channel/tools.ts` 的 `say`（ADR-037） | 补的是 `mentions`，**不改正文** |
| 改「没明确频道时在哪儿回话」 | `channel/state.ts` 的 `fallbackChannelId` | 只在**群聊**里找最近活跃的那个；一个群都没有才回落我和他的私聊。兜底永远不新建频道 |
| 改频道成员怎么来 | `shell/assemble.ts` 的 `joinTeamChannel` / `syncTeamChannel` / `addToCompanyChannel` | 成员是 `identity.md` + 团队 `README.md` 的投影（ADR-012）；公司频道只是播种一次的普通群，没有特权 |
| 加一条 HTTP 路由 | `shell/serve.ts` 的 `routes` 表 | 必须在前端有消费者，否则边界检查失败 |
| 改界面字段 | `shell/view.ts` | 字段必须有前端消费者（ADR-016） |
| 改界面样式 / 交互 | `ui/app/` | **改完必须 `npm run ui:build`**；文件职责见 §2.2 |
| 改「上翻看历史 / 回到最新」 | `ui/app/src/stream/Stream.tsx` 的 `rememberAnchor` / `toBottom` 与 `state/store.ts` 的 `loadEarlier` | 补历史**只往前面插**、用锚点行按回原位，别改回整列重建（ADR-052） |
| 改团队记忆沉淀的触发条件 / 游标时机 | `team/memory.ts` 的 `settleCandidates` + `team/settle.ts` 的 `waiting` | 游标语义在 ADR-033（取代 ADR-013），改之前先读懂 |
| 改「什么该记、什么不该记」 | `seed/skills/记忆整理/SKILL.md` —— **不要写代码** | 提示词只说「按那份技能整理」 |
| 换模型 / 加自定义模型 | `workspace/settings.json` 的 `models`；代码在 `runtime/models.ts` | 别复活「内置模型覆盖」机制（ADR-021） |
| 播种技能 | `seed/` + `shell/seed.ts` 的 `syncCompanySkills` / `seedPersonalSkills` | 公司层每次启动同步、改过的不覆盖；个人层只建一次 |

## 4. 启动顺序（第 3 步最容易出错）

`main.ts`：

0. `seedRules` + `syncCompanySkills`（`--no-seed` 时不跑）—— 规矩与公司层技能每次启动同步一遍
   （ADR-039），并自检「记忆整理」技能是否存在（沉淀链路要用它）。
1. `setupModels(process.env, { workspace })` —— 读 `settings.json`，装配 provider。**在
   `openCore` 之前**，因为 `harness` 需要 `models`。
2. `openCore({ databasePath, models, registry })`。
3. `assembleCore(...)` —— 见下。
4. `serveCore({ shell, ... })`。

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

会话形态不在这里决定：没有「个人频道」这种东西，也没有 `ensurePersonalChannel`。
私聊是成员恰好 `{我, 一人}` 的会话，我开的时候才有；一个 agent 不进任何群也能活。

## 5. 改动前的检查清单

```bash
npm run check      # tsc --noEmit + 边界检查
npm test           # 55 文件 / 451 例，应该 <3s
npm run live       # 真实模型端到端 12 项，会花 token，只在改行为后跑
```

改行为时**必须**同步三处：代码、`test/core/` 里的用例、`docs/`（`CORE` 概念 / `WEB-API`
字段 / `DECISIONS` 若碰了不可轻易改的约定）。

真实模型自测是保底：451 个单测全绿而 `npm run live` 只过 4 项的情况**发生过**——
那一次是两个 bug 叠在一起（`ownerSpeak` 漏传 wake + wake 在 `submit` 之后才落盘），
症状是「我在群里问，对方在私聊里答」，单测完全看不见。

## 6. 测试布局

`test/core/`（42 文件，纯函数 + 装配）：

| 文件 | 覆盖 |
| --- | --- |
| `channel-state.test.ts` | @ 解析、`chatKind` 只认成员表、四类收件人、`dmId` 顺序无关、未读、幂等建频道 |
| `channel-write.test.ts` | 频道写入的字节代价（ADR-027 的底线：每写一条花多少字节是契约） |
| `mention-alias.test.ts` | `@` 别名解析（ADR-036）：`@我` 的 6 种叫法、CEO/真名/title、垃圾 token 丢弃、老数据兜底 |
| `rescue.test.ts` | 答了却没说出来：补发判据、序号自愈（ADR-067） |
| `queue-jump.test.ts` | 我问话插队：只撤同会话 `queued` 项、最多 5 条、我自己排的不让路（ADR-066） |
| `say-contract.test.ts` | `say` 的落点契约：兜底频道不落私聊、投递正文带频道 id、`decision` 自动补 `owner`（ADR-037）、`[PASS]` 与单人在场不许静音（ADR-063）、一轮只说一句结论（ADR-064） |
| `deliver.test.ts` | 投递正文 / 未读摘要 / 失败不阻塞 |
| `relay.test.ts` | 接力上限（ADR-042）：`relayLimit` / `botHopsSinceOwner`（我没说过话也从建立算起）/ 拦截时只落库并留 note / 显式 `@` 可突破 |
| `identity.test.ts` | YAML 解析、`reportsOf`/`chainUp`、渲染确定性、不谎报文件路径 |
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
| `rules-prompt.test.ts` | 规矩进提示词（位置、空则整段消失、确定性、`seed/rules.md` 覆盖六条） |
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

`test/ui/`（13 文件，前端里能脱离浏览器跑的那部分）：

| 文件 | 测什么 |
| --- | --- |
| `stream-model.test.ts` | `buildRows()`：同一人连发 `grouped` / `cont` 的口径、时间分隔、历史 `think/tool/work` 被过滤 |
| `stream-events.test.ts` | 频道 `EventSource` 的事件（`create` 幂等 upsert） |
| `sse-batch.test.ts` | `enqueueMessage()`：按帧批处理的前置去重 |
| `local-echo.test.ts` | `localEcho()`：POST 成功即落本地一条 |
| `merge-messages.test.ts` | `mergeMessages()`：升序、去重、重叠时后一批赢、乱序、空输入、丢掉没有 `seq` 的项（ADR-052） |
| `sidebar-order.test.ts` | `sortChannels`：侧栏排序 |
| `side-rail.test.ts` | 侧栏收起成图标条 |
| `unread-badge.test.ts` | `unreadLabel`：未读徽标文案 |
| `head-subtitle.test.ts` | `headParts`：顶栏副标题拼装 |
| `right-panel.test.ts` | 右栏：后端字段都画出来 / 没技能没记忆就明说（ADR-056） |
| `composer-alignment.test.ts` | 引用条与附件托盘的居中轨道 |
| `wrap-css.test.ts` | 消息正文换行 |
| `jank.test.ts` | `classifyJank()`：hidden / resumed / foreground 三判；`mark()` 幂等 |
