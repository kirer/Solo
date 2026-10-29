# 代码地图

要改某个东西，该动哪个文件。**概念**见 [CORE](CORE.md)，**接口字段**见 [WEB-API](WEB-API.md)。

## 1. 分层与边界

```
src/core/
  runtime/   防腐层：唯一能 import @earendil-works/* 的地方
  agent/     一个人：身份 / 提示词 / 记忆 / 技能 / 名册
  project/   一个项目：README.md / memory.md / 自动沉淀
  channel/   说话：纯规则 / 投递 / 写一条 / 20 个工具
  shell/     外壳：装配 / HTTP+SSE / 视图投影 / 启动
    http/    路由表 / 静态资源 / 网卡探测
ui/web/      纯静态界面，无构建步骤
seed/        起手技能（公司层 + 知言个人层）+ 规矩文案 `rules.md`
scripts/     两个脚本：边界检查、真实模型自测
```

**三条边界**（`scripts/check-boundaries.mjs` 机械化，违反即 `npm run check` 失败）：

1. 只有 `src/core/runtime/` 能 import pi-durable / pi-ai / chord。
2. 内核（`agent|project|channel`）不得反向 import `shell/` —— 依赖只能 `shell → 内核`。
3. `serve.ts` 的每条 `pattern` 必须在 `ui/web/js` 里有消费者（白名单：`/api/org`，
   Docker 健康检查用）。

## 2. 全量文件（`src/core` 下 30 余个 ts，约 7K 行；行数会漂，以表里的职责为准）

| 文件 | 行数 | 里面有什么 |
| --- | --- | --- |
| `runtime/index.ts` | 57 | 防腐层再导出：`BACKGROUND_CONTEXT` / `createRegistry` / `defineDoc` / `defineTool` / `openCore` / `setupModels` / `Type` |
| `runtime/open.ts` | 142 | `openCore({databasePath, models, registry, settings?}) → {harness, close}`；open 之后先跑 `reconcileZombieTasks()`（ADR-025） |
| `runtime/models.ts` | 151 | `setupModels()`：读 `settings.json` 的 `providers` 数组 → `createProvider` → `setProvider`；回落到环境变量 / 本地网关 |
| `agent/identity.ts` | 136 | `parseIdentity` / `readIdentity` / `readAllIdentities` / `reportsOf` / `chainUp` / `managerOf`；`OWNER_SLUG = "owner"` |
| `agent/prompt.ts` | 259 | `renderAgentPrompt()` —— 唯一的提示词渲染器，确定性（ADR-005）；规矩一节来自 `rules.md`（ADR-038）；只留事实；出口再 `redact()` 一遍（密钥不许进提示词） |
| `agent/rules.ts` | 41 | `loadRules()` / `renderRulesSection()` —— 读 `<workspace>/rules.md` 并排成「## 规矩」一节；缺文件 = 整段不出现 |
| `agent/runtime.ts` | 151 | `registeredTools()`（从注册表实拍工具清单）、`renderAgentSection()`（每次重读盘，含 `rules.md`）、`readProjectBrief()` |
| `agent/memory.ts` | 215 | `readMemory` / `sectionsOf` / `appendMemory` / `writeMemory` / `memoryDigest` / `entryProblem`；`MEMORY_FILE="memory.md"`、`DIGEST_LIMIT=12`、`MEMORY_LIMITS={entry:300, main:4_000}`；写入去重 + 串行 + 记一笔 journal |
| `agent/journal.ts` | 49 | `appendJournal()` —— `<agentDir>/.memory-journal.jsonl` 追加一行 JSON（谁、何时、append/replace、before/after 全文）；失败只 warn |
| `agent/secrets.ts` | 100 | `loadSecrets` / `redactor` / `redact` —— 读 `<workspace>/.secrets.json`，把密钥的三种形态（原值 / JSON 转义 / URL 编码）从文本里抹掉 |
| `agent/skills.ts` | 231 | 两层技能：`listSkills` / `readSkill` / `writeSkill` / `writeCompanySkill` / `copySkillDir` |
| `agent/create.ts` | 131 | `slugify`（中文保留）/ `uniqueSlug` / `renderIdentityFile` / `createAgent` / `renderOrgChart` |
| `agent/roster.ts` | 62 | `DirectoryDoc`、`conversationFor` / `slugFor` / `wakeOf` —— 名册是缓存，不是真相 |
| `project/doc.ts` | 164 | `projects/<slug>/README.md` 的读写；`ProjectDoc{slug,name,owner,status,body}` |
| `project/memory.ts` | 144 | `projects/<slug>/memory.md` + `settleCandidates()`（不按 `kind` 筛，只排除整理者自己）/ `renderSettlePrompt()`（规则指向公司技能「记忆整理」，不复述清单） |
| `project/settle.ts` | 208 | 自动沉淀：`settleProject` / `confirmedBy`；单游标（问完只记 `waiting`，记忆文件 mtime 变了才推进，ADR-033）；失败时往项目频道留一条 `note`（`appendProjectNote`） |
| `channel/state.ts` | 415 | 纯规则：`ChannelDoc`（增量满 64 条压基线，ADR-027）/ `appendMessage` / `recipientsOf` / `parseMentions` / `needsOwner`（决策句式，ADR-037）/ `fallbackChannelId`（兜底频道，非个人频道优先）/ `unreadCount` / `markRead` / `ensureChannel` |
| `channel/alias.ts` | 116 | `@` 别名解析（ADR-036）：`resolveMention` / `mentionRosterOf` / `normalizeAlias`——`@老大` / `@CEO` / 真名 / title → slug，名册由 `agents/*/identity.md` 喂进来 |
| `channel/deliver.ts` | 273 | `deliver()`（唯一的跨 agent 原语，ADR-008）、`renderDelivery`（第一行带频道 id；私聊多一句「只回这里」）/ `renderDigest` |
| `channel/unanswered.ts` | 78 | 「叫了他但他这一轮没答上来」的留痕：`reasonText`（结算原因翻成人话，没见过的原样贴）/ `renderUnanswered` / `watchSettled`（后台等结算，不 await、不抛，ADR-069） |
| `channel/speech.ts` | 40 | 「这一轮已经说过结果了」的进程内标记（`markSpoken` / `spokenResult` / `clearSpoken`）；由 `deliver()` 在新一轮清空（ADR-064） |
| `channel/post.ts` | 238 | `postMessage()` —— 写一条（单元素 splice，ADR-027）+ 解析 @（可带 roster / 额外 mention）+ 投递 |
| `channel/transcript.ts` | 129 | `projectAssistantEntry()`：把会话 `pi.assistant` 条目里的 thinking/text/toolCall 投影成 `think`/`say`/`tool` 三类消息（纯函数，不落库） |
| `channel/tools.ts` | 1067 | 17 个工具（say/read_channel/org/hire/update_identity/remember/recall/read_history/list_skills/read_skill/write_skill/list_projects/read_project/write_project/run/write_file/read_file）；`say` 负责「在哪儿回话、叫醒谁」，`defaultChannel` / `mentionRoster` / `ensureDm`（同事私聊，ADR-041） |
| `shell/assemble.ts` | 612 | `assembleCore()` —— 扫文件夹 → 开会话 → 绑名册 → 建频道 → 启投影；`ownerSpeak` / `makeAfterPost` |
| `shell/projector.ts` | 208 | 会话记录 → 个人频道的投影管道：`startTranscriptSink` / `backfillTranscripts` / `projectEntry`（游标持久化，ADR-026）；`keptProjections()` 决定老大私聊只落 `say`（ADR-040） |
| `shell/seed.ts` | 298 | `seedOwnerAssistant`（身份，只建一次）/ `syncCompanySkills`（公司层技能按 hash 同步，ADR-039）/ `seedRules`（`rules.md`，只补不改）/ `seedPersonalSkills` |
| `shell/serve.ts` | 454 | `serveCore()` —— 8 条路由 + SSE + 静态文件 |
| `shell/view.ts` | 302 | 视图投影：`channelList` / `channelDetail` / `messageView` / `orgView`（无 `dmKind`，dm 统一为一类） |
| `shell/main.ts` | 144 | 启动：同步规矩与公司层技能（`seedRules` / `syncCompanySkills`）→ 必要时建人 → 读模型 → `openCore` → `assembleCore` → `serveCore` → 等 Ctrl-C；并自检「记忆整理」技能在不在 |
| `shell/http/routes.ts` | 122 | `matchRoute()` 表驱动路由（`:name` 捕获 / `*name` 吃余量） |
| `shell/http/static-assets.ts` | 201 | ETag / br+gzip 协商 / `loadAsset` |
| `shell/http/network.ts` | 78 | 网卡探测（启动时打印局域网地址） |

### 2.2 `ui/web/`（纯静态，无构建，浏览器直接跑源码）

| 文件 | 职责 |
| --- | --- |
| `index.html` | 唯一的页面骨架：顶栏 / 人栏 / 频道栏 / 纸（消息区 + 输入卡）/ 浮层。**没有第二个页面，也没有路由框架**（hash 只有 `#/c/<channelId>`） |
| `css/base.css` | 重置、5 个 `@font-face`（IBM Plex，本地 woff2）、全部 token、6 档字号阶梯 |
| `css/shell.css` | 取景框、顶栏、人栏、频道栏、纸张、浮层（团队 / 菜单 / 灯箱）、手机单区域 |
| `css/stream.css` | 消息流的四种行（`say` / `event` / `note` / `decision`）、时间分隔、骨架、空态 / 错误、动作条、气泡布局、附件、`.md` 补样式 |
| `css/composer.css` | 输入卡、附件队列、拖拽落点提示、@ 提及弹窗、引用条 |
| `css/memory.css` | 记忆面板（抽屉） |
| `css/pending.css` | 待办卡（`decision` 行的选项按钮 + 自定义输入 + 回执） |
| `css/motion.css` | 18 个 `@keyframes`、头像状态动画、入场 / 退场、`prefers-reduced-motion` |
| `js/app.js` | 全部状态与交互：拉数据、SSE、渲染、滚动、输入、附件、浮层、快捷键。**改动 90% 落在这里** |
| `js/rows.js` | `buildStream()` 把消息数组变成 DOM；一条消息长什么样只在这里定义 |
| `js/avatar.js` | 手绘 SVG 头像（三族身体 × 六色）、四种状态、`groupAvatar()` 群组头像（座位表 + mask 挖洞） |
| `js/messages.js` | `mergeMessages()` —— 两页消息按 `seq` 去重合并（唯一可脱离浏览器测的前端逻辑） |
| `js/memory.js` | 记忆面板：拉取 / 筛选 / 展开 / 记一条 / 删一节 + 纯函数（`lineCount` / `linesOf` / 过滤） |
| `js/detail.js` | 详情面板的内容（私聊看人 / 群看群）：纯「数据 → HTML」，不发请求。**没有的字段不画空标题** |
| `js/attach.js` | 附件：判断类型、缩略图、文件 chip、上传、队列项 |
| `js/markdown.js` | `renderMarkdown()` —— 最小的 Markdown（标题 / 列表 / 代码 / 表格 / 链接 / 图片），**先转义再拼** |
| `js/motion.js` | 弹簧缓动、`installMotionTokens()`、`withLinger()`（退场动画的通用壳） |
| `js/format.js` | 转义、相对时间、`copyText()` |
| `js/api.js` | 五个 `fetch` 包装 + `streamOrg()`。**每个后端路由必须在这里有消费者**（边界检查会查） |
| `fonts/*.woff2` | IBM Plex Sans 400/500/600 + Mono 400/500（本地字体，不许只写 `font-family` 指望系统有） |

## 3. 「我想改 X → 动这里」

| 想改什么 | 动这里 | 注意 |
| --- | --- | --- |
| 加一个工具（能力） | `channel/tools.ts` 的 `createCoreTools` | 工具 description 就是说明书，写清「什么时候用」 |
| 教 agent 一套做法 | **不要写代码**，写 `seed/skills/<名字>/SKILL.md` 或让 agent `write_skill` | 见 ADR-007 |
| 改提示词的段落 | `agent/prompt.ts` 的 `renderAgentPrompt` | 必须保持确定性（ADR-005）；加了字段就要有测试 |
| 改「全公司都要守的规矩」（先给结论、在哪个频道回话、别写英文独白） | **不要写进 `.ts`**：改 `seed/rules.md`，再同步到 `workspace/rules.md` | 每轮都进提示词的只有这一份（ADR-038）；技能正文只在 `read_skill` 时才进上下文 |
| 改起手技能的同步行为 | `shell/seed.ts` 的 `syncCompanySkills` + `<workspace>/.seed-manifest.json` | 按 hash 判「用户改过没有」，改过的不覆盖（ADR-039） |
| 加一个身份字段 | `agent/identity.ts` 的 `IdentityHeader` | 现在是 4 个：`name`/`title`/`manager`/`project`，加之前先问能不能推导 |
| 改谁能被 @ 到 | `channel/state.ts` 的 `recipientsOf`（成员规则）+ `channel/alias.ts` 的 `resolveMention`（名字 → slug） | 两件事分开改：成员过滤是安全边界，别名只是翻译；改前者要同步 `test/core/channel-state.test.ts`，改后者同步 `test/core/mention-alias.test.ts` |
| 改「要老大拍板就 @ 老大」 | `channel/state.ts` 的 `needsOwner` + `channel/tools.ts` 的 `say`（ADR-037） | 补的是 `mentions`，**不改正文** |
| 改「没明确频道时在哪儿回话」 | `channel/state.ts` 的 `fallbackChannelId` | 非个人频道优先（`mine[0]` 可能是私聊） |
| 改频道成员怎么来 | `shell/assemble.ts` 的 `joinProjectChannel` / `addToCompanyChannel` | 成员是 `identity.md` + `README.md` 的投影（ADR-012） |
| 加一条 HTTP 路由 | `shell/serve.ts` 的 `routes` 表 | 必须在前端有消费者，否则边界检查失败 |
| 改界面字段 | `shell/view.ts` | 字段必须有前端消费者（ADR-016） |
| 改界面样式 / 交互 | `ui/web/` | 无构建步骤；文件职责见 §2.2，三条规矩见 CORE §9 |
| 改「上翻看历史 / 回到最新」 | `ui/web/js/app.js` 的 `loadEarlier` / `syncToBottom` / `renderFlow` 的 `pinned` | 补历史**只往前面插**、用锚点行按回原位，别改回整列重建（ADR-052） |
| 改记忆沉淀的触发条件 / 游标时机 | `project/memory.ts` 的 `settleCandidates` + `project/settle.ts` 的 `waiting` | 游标语义在 ADR-033（取代 ADR-013），改之前先读懂 |
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
   `joinProjectChannel`）或新建会话 → `addToCompanyChannel` → `joinProjectChannel`；
4. **一次 commit** 把名册写回（每个人一次 commit 会让启动慢一个数量级）；
5. 播种公司频道（已存在就补缺失成员）；
6. `rescan()` 可从外部再触发（改完 `identity.md` 加人不必重启）。

**坑**：第 3 步的 `openOne` 必须同时做「进公司频道」和「进项目频道」，两者都幂等。
第一版只在 `rescan()` 里补项目频道，于是「改 identity 加上 project」的人永远进不去。

## 5. 改动前的检查清单

```bash
npm run check      # tsc --noEmit + 边界检查
npm test           # 47 文件 / 430 例，应该 <3s
npm run live       # 真实模型端到端 12 项，会花 token，只在改行为后跑
```

改行为时**必须**同步三处：代码、`test/core/` 里的用例、`docs/`（`CORE` 概念 / `WEB-API`
字段 / `DECISIONS` 若碰了不可轻易改的约定）。

真实模型自测是保底：308 个单测全绿而 `npm run live` 只过 4 项的情况**发生过**——
那一次是两个 bug 叠在一起（`ownerSpeak` 漏传 wake + wake 在 `submit` 之后才落盘），
症状是「老大在公司频道问，对方在个人频道答」，单测完全看不见。

## 6. 测试布局

| 文件 | 覆盖 |
| --- | --- |
| `channel-state.test.ts` | @ 解析、四类收件人、`dmId` 顺序无关、未读、幂等建频道 |
| `mention-alias.test.ts` | `@` 别名解析（ADR-036）：老大的 6 种叫法、CEO/真名/title、垃圾 token 丢弃、老数据兜底 |
| `rescue.test.ts` | 答了却没说出来：补发判据、占位顶替、序号自愈（ADR-067） |
| `queue-jump.test.ts` | 老大问话插队：只撤同会话 `queued` 项、最多 5 条、老大自己排的不让路（ADR-066） |
| `step-merge.test.ts` | 过程话 30 秒内合并：正文接在上一条、`seq` 不变、不重复投递；带 @ 的不合（ADR-065） |
| `say-contract.test.ts` | `say` 的落点契约：兜底频道不落私聊、投递正文带频道 id、`decision` 自动补 `owner`（ADR-037）、`[PASS]` 与单人在场不许静音（ADR-063）、一轮只说一句结论（ADR-064） |
| `deliver.test.ts` | 投递正文 / 未读摘要 / 失败不阻塞 |
| `identity.test.ts` | YAML 解析、`reportsOf`/`chainUp`、渲染确定性、不谎报文件路径 |
| `memory.test.ts` | 分区、追加、摘要 |
| `skills.test.ts` | 两层覆盖、拷贝不覆盖、frontmatter |
| `org.test.ts` | slug、建人、组织架构投影 |
| `project.test.ts` / `project-memory.test.ts` | README 读写、memory 追加、候选筛选 |
| `settle.test.ts` / `settle-e2e.test.ts` | 沉淀纯函数 + 装配层端到端（单游标语义） |
| `shell.test.ts` / `shell-e2e.test.ts` | 装配、重启幂等、wake 记录位置 |
| `assemble.test.ts` | 播种、多 agent、频道成员 |
| `view.test.ts` | 视图投影（`kind` / `role` / 未读） |
| `rules-prompt.test.ts` | 规矩进提示词（位置、空则整段消失、确定性、`seed/rules.md` 覆盖六条） |
| `projector.test.ts` | 投影落点（ADR-040）：老大私聊只留 `say`、项目频道原样全留、判定只看 `dm:` + 成员 |
| `seed-sync.test.ts` | 公司层技能同步（缺的补上 / 未改的更新 / 改过的不动 / 幂等 / manifest / `rules.md` 只补不改） |
| `relay.test.ts` | 接力上限（ADR-042）：`relayLimit` / `botHopsSinceOwner`（老大没说过话也从建立算起）/ 拦截时只落库并留 note / 显式 `@` 可突破 |
| `colleague-dm.test.ts` | 同事私聊（ADR-041）：`to` 建出只装两人的频道 / 方向对称 / `mentions` 与 `wakeOnAll` 都指着他 / `to: owner` 不新建 / 发给不存在的人老实报错 |
| `attention.test.ts` | 「找你」（`GET /api/attention`）：只收要老大拍板的、排除老大自己发的、7 天窗口、已读带标记、跨频道按时间倒序 |
| `reconcile.test.ts` | 僵尸任务回收：`pi.live` 指向已终态任务时摘掉 `run` 并把积压输入放回这一轮 |
| `work-log.test.ts` | `run` 的命令日志不进老大的私聊（ADR-071） |

`test/ui/`（前端里能脱离浏览器跑的那部分）：

| 文件 | 测什么 |
| --- | --- |
| `memory-panel.test.ts` | 记忆面板纯逻辑：`lineCount` / `linesOf`（「条」是行数不是节数）/ 筛选 / 行数版文案 / 删除确认里的条数 |
| `merge-messages.test.ts` | `mergeMessages()`：升序、去重、重叠时后一批赢、乱序、空输入、丢掉没有 `seq` 的项（ADR-052） |
| `detail-panel.test.ts` | 详情面板：后端字段都画出来 / 没技能没记忆就明说 / 用户可控字串不变标签（ADR-056） |
| `say-contract.test.ts`（新增两例） | 独白与超长**不落库**（不只返回提示，`lastOf().seq` 必须没变） |
| `monologue.test.ts` | 内心独白拦截：英文计划式开场拦住、中文汇报里夹英文不拦、`docker compose` 这类标识符开头不拦、太短不判（ADR-058） |
