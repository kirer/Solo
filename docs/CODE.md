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
seed/        播种技能（公司层 + 知言个人层）
scripts/     两个脚本：边界检查、真实模型自测
```

**三条边界**（`scripts/check-boundaries.mjs` 机械化，违反即 `npm run check` 失败）：

1. 只有 `src/core/runtime/` 能 import pi-durable / pi-ai / chord。
2. 内核（`agent|project|channel`）不得反向 import `shell/` —— 依赖只能 `shell → 内核`。
3. `serve.ts` 的每条 `pattern` 必须在 `ui/web/js` 里有消费者（白名单：`/api/org`，
   Docker 健康检查用）。

## 2. 全量文件（25 个 ts，约 5.8K 行）

| 文件 | 行数 | 里面有什么 |
| --- | --- | --- |
| `runtime/index.ts` | 54 | 防腐层再导出：`BACKGROUND_CONTEXT` / `createRegistry` / `defineDoc` / `defineTool` / `openCore` / `setupModels` / `Type` |
| `runtime/open.ts` | 46 | `openCore({databasePath, models, registry, settings?}) → {harness, close}` |
| `runtime/models.ts` | 151 | `setupModels()`：读 `settings.json` 的 `providers` 数组 → `createProvider` → `setProvider`；回落到环境变量 / 本地网关 |
| `agent/identity.ts` | 136 | `parseIdentity` / `readIdentity` / `readAllIdentities` / `reportsOf` / `chainUp` / `managerOf`；`OWNER_SLUG = "owner"` |
| `agent/prompt.ts` | 235 | `renderAgentPrompt()` —— 唯一的提示词渲染器，确定性（ADR-005）；规则外移到技能，只留事实 |
| `agent/runtime.ts` | 144 | `registeredTools()`（从注册表实拍工具清单）、`agentSection()`（`render` 每次重读盘）、`readProjectBrief()` |
| `agent/memory.ts` | 91 | `readMemory` / `sectionsOf` / `appendMemory` / `writeMemory` / `memoryDigest`；`MEMORY_FILE="memory.md"`、`DIGEST_LIMIT=12` |
| `agent/skills.ts` | 231 | 两层技能：`listSkills` / `readSkill` / `writeSkill` / `writeCompanySkill` / `copySkillDir` |
| `agent/create.ts` | 131 | `slugify`（中文保留）/ `uniqueSlug` / `renderIdentityFile` / `createAgent` / `renderOrgChart` |
| `agent/roster.ts` | 62 | `DirectoryDoc`、`conversationFor` / `slugFor` / `wakeOf` —— 名册是缓存，不是真相 |
| `project/doc.ts` | 164 | `projects/<slug>/README.md` 的读写；`ProjectDoc{slug,name,owner,status,body}` |
| `project/memory.ts` | 146 | `projects/<slug>/memory.md` + `settleCandidates()` / `renderSettlePrompt()`；`SETTLE_KINDS=["decision","report"]` |
| `project/settle.ts` | 140 | 自动沉淀：`settleProject` / `confirmedBy`；单游标（问完即推进） |
| `channel/state.ts` | 269 | 纯规则：`ChannelDoc`（单频道 256 条 checkpoint）/ `appendMessage` / `recipientsOf` / `parseMentions` / `unreadCount` / `markRead` / `ensureChannel` |
| `channel/deliver.ts` | 174 | `deliver()`（唯一的跨 agent 原语，ADR-008）、`renderDelivery` / `renderDigest` |
| `channel/post.ts` | 102 | `postMessage()` —— 写一条 + 解析 @ + 投递 |
| `channel/tools.ts` | 777 | 16 个工具（say/read_channel/org/hire/update_identity/remember/recall/list_skills/read_skill/write_skill/list_projects/read_project/write_project/run/write_file/read_file） |
| `shell/assemble.ts` | 723 | `assembleCore()` —— 扫文件夹 → 开会话 → 绑名册 → 建频道 → 播技能；`ownerSpeak` |
| `shell/serve.ts` | 454 | `serveCore()` —— 8 条路由 + SSE + 静态文件 |
| `shell/view.ts` | 302 | 视图投影：`channelList` / `channelDetail` / `messageView` / `orgView`（无 `dmKind`，dm 统一为一类） |
| `shell/main.ts` | 122 | 启动：读模型 → `openCore` → `assembleCore` → `serveCore` → 等 Ctrl-C |
| `shell/http/routes.ts` | 122 | `matchRoute()` 表驱动路由（`:name` 捕获 / `*name` 吃余量） |
| `shell/http/static-assets.ts` | 201 | ETag / br+gzip 协商 / `loadAsset` |
| `shell/http/network.ts` | 78 | 网卡探测（启动时打印局域网地址） |

## 3. 「我想改 X → 动这里」

| 想改什么 | 动这里 | 注意 |
| --- | --- | --- |
| 加一个工具（能力） | `channel/tools.ts` 的 `createCoreTools` | 工具 description 就是说明书，写清「什么时候用」 |
| 教 agent 一套做法 | **不要写代码**，写 `seed/skills/<名字>/SKILL.md` 或让 agent `write_skill` | 见 ADR-007 |
| 改提示词的段落 | `agent/prompt.ts` 的 `renderAgentPrompt` | 必须保持确定性（ADR-005）；加了字段就要有测试 |
| 加一个身份字段 | `agent/identity.ts` 的 `IdentityHeader` | 现在是 4 个：`name`/`title`/`manager`/`project`，加之前先问能不能推导 |
| 改谁能被 @ 到 | `channel/state.ts` 的 `recipientsOf` | 四条规则，改一条要同步 `test/core/channel-state.test.ts` |
| 改频道成员怎么来 | `shell/assemble.ts` 的 `joinProjectChannel` / `addToCompanyChannel` | 成员是 `identity.md` + `README.md` 的投影（ADR-012） |
| 加一条 HTTP 路由 | `shell/serve.ts` 的 `routes` 表 | 必须在前端有消费者，否则边界检查失败 |
| 改界面字段 | `shell/view.ts` | 字段必须有前端消费者（ADR-016） |
| 改界面样式 / 交互 | `ui/web/` | 无构建步骤；三条规矩见 CORE §9 |
| 改记忆沉淀的触发条件 | `project/memory.ts` 的 `SETTLE_KINDS` | 游标语义在 ADR-013，改之前先读懂 |
| 换模型 / 加自定义模型 | `workspace/settings.json` 的 `models`；代码在 `runtime/models.ts` | 别复活「内置模型覆盖」机制（ADR-021） |
| 播种技能 | `seed/` + `shell/assemble.ts` 的 `seedCompanySkills` / `seedPersonalSkills` | 已存在的不覆盖 |

## 4. 启动顺序（第 3 步最容易出错）

`main.ts`：

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
npm test           # 14 文件 / 133 例，应该 <1s
npm run live       # 真实模型端到端 12 项，会花 token，只在改行为后跑
```

改行为时**必须**同步三处：代码、`test/core/` 里的用例、`docs/`（`CORE` 概念 / `WEB-API`
字段 / `DECISIONS` 若碰了不可轻易改的约定）。

真实模型自测是保底：133 个单测全绿而 `npm run live` 只过 4 项的情况**发生过**——
那一次是两个 bug 叠在一起（`ownerSpeak` 漏传 wake + wake 在 `submit` 之后才落盘），
症状是「老板在公司频道问，对方在个人频道答」，单测完全看不见。

## 6. 测试布局

| 文件 | 覆盖 |
| --- | --- |
| `channel-state.test.ts` | @ 解析、四类收件人、`dmId` 顺序无关、未读、幂等建频道 |
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
