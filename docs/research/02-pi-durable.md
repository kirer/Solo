# Pi Durable 深度调研

> 对象：`@earendil-works/pi-durable` v1.4.0（2026-10-21，MIT；**当前依赖已是 1.5.0，见文末升级注记**）。方法：原文 + 全部外链 + npm registry + GitHub 源码/spec/CHANGELOG + **本地安装并实跑 11 个验证脚本**（正文标"实测"者均为本机结果，Node v26.12.0 / macOS）。
> 来源：发布文 <https://earendil.com/posts/pi-durable/>｜配套 <https://earendil.com/posts/pi-1-0/>、<https://earendil.com/posts/what-is-a-harness/>、<https://earendil.com/posts/pi-durable-on-cloudflare/>｜README <https://github.com/earendil-works/pi/blob/main/packages/durable/README.md>｜规范 <https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md>（5594 行）｜示例 <https://github.com/earendil-works/pi/tree/main/packages/durable/test/examples>（31 个）｜CHANGELOG <https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md>｜npm <https://www.npmjs.com/package/@earendil-works/pi-durable>｜Cloudflare 参考实现 <https://github.com/earendil-works/pi-durable-cloudflare>

---

## 结论摘要（给决策者）

1. **它是地基，不是应用。** TypeScript 库，提供"持久化对话 + 持久化任务 + 持久化文档"运行时。Pi（pi.dev 的 coding agent）只是它的消费者，共享 `pi-ai` 模型层与"极简/可改"哲学。**不含 TUI、登录、任何业务界面**——做"一人公司"等于从零写应用外壳，但并发、崩溃恢复、多客户端、成本记账这些最难的部分它已给出。

2. **工程质量高，但 API 明确 experimental。** 周下载 38.7 万（pi-coding-agent 271 万，约 1:7），主仓 11.7 万 star，31 个可运行示例，5594 行规范。README 首行："Experimental. The API changes without notice between releases." 事实核查：**1.1→1.4 每个 minor 都带 Breaking Changes**。这是最大风险，属工程风险而非能力风险。

3. **最小路径极短：3 秒装完、30 行跑通。** 本机全流程验证通过（SQLite 崩溃恢复、fork、watch、自定义 tool/doc/task、subagent、usage）。

4. **崩溃恢复是真的。** 实测：发起调 60 秒工具的 run，中途 `process.exit(0)`；重开同一 SQLite，`inspect()` 显示 `pi.generation` 为 `pending`；`resume()` 后同 `requestId` 返回原 submission 并答完。

5. **多 agent 编排齐备，但 subagent 要自己写（约 40 行）。** 原文明确："Pi Durable has no built-in subagents"。它给原语：ownership 树、结构化并发（abort 自底向上）、inbox（steer/followUp/write/reject）、task graph、durable sleep。实测写出可用的 subagent 并跑通父子分别记账。

6. **成本统计够做 CFO，但没有预算硬约束。** 每会话 `pi.usage`（按 `provider/model` 与 tool 分桶），`harness.usage()` 汇总，含 token 与 cost，`cost.totalFromProvider` 标记是否实报。**缺口**：无 `maxCost`；`beforeRequest` 抛异常**不能阻断请求**（实测仅报 `extension_error` 后继续跑），只能改写请求软拦——对应未合并 issue #11055。

7. **建议：选它做地基，用"防腐层"策略。** 所有调用收敛到自建薄封装（`CompanyRuntime`），业务代码不直接 import；锁精确版本；每升版跑契约测试。

8. **现在就要排除的场景**：多进程同写一份数据（官方："One process owns a storage at a time, and there is no cross-process locking"）、开箱多租户鉴权、cron 式定时（只有 sleep-until）、Web UI（完全没有）。

---

## 一、pi-durable 是什么

### 1.1 定位：库，不是应用

原文："Pi Durable is that harness. It does not replace the Pi coding agent. It is a framework for building any agentic application, coding agents included."（<https://earendil.com/posts/pi-durable/>）

对比：Pi 是终端应用（TUI）、单人本机、单会话为主、进程死了人看着续；pi-durable 是 npm 库、无 UI、开发者嵌入、一个 harness 内无限并发、进程死了自己续、多客户端可 attach 同一会话。包名分别是 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-durable`。

**Pi 1.0 里已有一个用 pi-durable 重写的小 coding agent**（`packages/coding-agent/src/experimental/durable`），另有约 1300 行 vacation planner——"用 pi-durable 做完整 agent 应用"是被验证过的路径，且是产品级代码。三层依赖（全部 MIT、同 repo、同版本号）：`pi-ai`（统一 LLM API：provider 目录/auth/stream/token-cost/tool 定义）→ `chord`（文档状态机：不可变 delta/watch/Context）→ `pi-durable`（Session/Harness/Conversation/Task/Extension）。

### 1.2 解决什么问题

原文四类需求与实现：**Long runs anywhere**（Storage 抽象与运行时无关，SQLite/JSONL 核心无 Node API，可跑 Bun/Cloudflare DO——✅ 有官方 DO 示例仓）；**Survives crashes**（每 step 提交 checkpoint + `resume()` + `requestId` 幂等——✅ 实测复现）；**Many conversations**（单 harness 多 conversation 共享一条提交线——✅ 实测两会话并行）；**Extensions/Malleable/Multiplayer**（registry 热替换、一切 UI 状态即已提交状态——✅ API 有，UI 自建）。

**注意：它不是通用事件溯源框架**，尽管很像。entry 不可变（像 ES），document 可变 JSON（不像）。规范 §13 Non-goals 明确排除"semantic event journal"与"CRDT/offline multi-writer merge"。**别拿它当事件溯源数据库**。核心不变式（spec §1）："A Session atomically commits immutable entries, full task records, and Chord-tracked documents. Only committed state is observable." 这解释了所有设计（progress 每 100ms 提交、watch 只给已提交帧、崩溃最多丢 100ms）。

### 1.3 生态数据（实测）

最新版 1.4.0，共 17 个版本（首版 2026-10-01）；1.0.1→1.4.0 共 23 天 7 版；周下载 387,665；Node `>=22.19.0` 硬约束；**ESM only**；7 个直接依赖（实测共 91 包）；三包解压约 13MB；代码约 2.7 万行 TS；主仓 117,424 star / 15,014 fork；durable 相关 open issue 21 个。

---

## 二、核心概念与架构

### 2.1 分层模型

```
Storage（Memory / SQLite / JSONL / IndexedDB / DO-SQLite）
 └ Session（一条原子提交线 + 全局 ID 命名空间）
    └ Harness（Session + 调度器 + registry + models + env）
       ├ Conversation（transcript 作用域，可 fork）
       │   ├ Entry[]（不可变：pi.user/pi.assistant/pi.tool-result/pi.system/pi.compaction/pi.reset/自定义）
       │   └ Document[]（可变 JSON：pi.agent/pi.live/pi.inbox/pi.usage/pi.provider/自定义）
       └ Task[]（持久化状态机，每 step 一次 checkpoint；owner = 某 Conversation 或另一 Task）
```

### 2.2 概念 → API

| 概念 | 一句话 | API / 标识 |
|---|---|---|
| **Harness** | 一个打开的 Storage + 在其上跑 agent 的全部机器；所有变更走一条原子提交线 | `Harness.open(storage, opts, ctx)`、`resume()`、`wake()`、`closed` |
| **Storage** | 持久化后端接口，很小可自实现 | `new MemoryStorage()`、`openNodeSqliteStorage(p)`、`openNodeJsonlStorage(d, ctx)`、`IndexedDbStorage.open(n)`、`openDurableObjectSqliteStorage(ctx.storage)` |
| **Registry** | 本进程装了哪些 extension，可运行中替换 | `createRegistry()`、`install/uninstall`、`RegistryReader.snapshot()` |
| **Conversation** | 一份 transcript；handle 无状态，按 `id` 比较 | `harness.root(ctx, opts)`、`createConversation()`、`conversation(id)`、`ROOT_CONVERSATION_ID`（=1） |
| **Entry** | 一条不可变记录 | `tx.appendEntry()`、`conversation.entries(q, limit, cur, ctx)`、`tx.entry(Class, id)`；类 `UserEntry`/`AssistantEntry`/`ToolResultEntry`/`SystemEntry`/`CompactionEntry`/`ResetEntry` |
| **Document** | 与 transcript 同事务变更的类型化 JSON | `defineDoc({kind, version, scope, history, fork, initial, checkpointWhen})`、`tx.doc(T, id)`、`snapshot()`、`watchDoc()`；内置 `AgentDoc`/`LiveDoc`/`InboxDoc`/`UsageDoc`/`ProviderDoc`/`NestedCallDoc` |
| **Commit** | 一次原子写：entry+doc+task 同成同败 | `conversation.commit(tx=>)`、`harness.commit()`、`api.commit()`（tool 内）、`runtime.commit()`（task 内） |
| **Task** | 持久化状态机，每 step 存 checkpoint | `defineTask({name, version, initial, phases, abort})`、`tx.createTask()`、`api.createTask()`、`getTask/waitForTask/abortTask/retryTask` |
| **Submission** | 交给会话的一件事，可等待 | `conversation.submit(draft, ctx)` → `submission.wait(ctx)` → `{status:"done"\|"unanswered"}`；`harness.submission(id)`、`abortSubmission()` |
| **Turn / Run** | turn = 一次响应+其工具；run = 输入到最终答案 | 只读：`pi.live.run`/`generation`/`tools` |
| **Extension** | 具名 bundle：sections+tools+hooks+wraps+tasks | `defineExtension({...})`；五个扩展点见 §3.5 |
| **Fork** | 在任意 entry 分叉，看到父到该点的历史但不复制 | `conversation.fork(entryId, opts, ctx)`、`tx.forkConversation()`、`context(ctx,{at})` |
| **Watch** | 订阅结构化视图（先当前值，再每次提交的精确 ops） | `conversation.watch(ctx)`、`viewState(ctx)`、`start/stop/closed` |
| **Inbox** | 会话忙时的排队区（steer/followUp/write/reject） | `submit({whenBusy})`、`InboxDoc`、`settings.steeringMode/followUpMode` |
| **Compaction** | 后台摘要旧消息，摘要落 turn 边界，旧 entry 永久保留 | `conversation.compact(instr, ctx)`、`settings.compaction.{reserveTokens, keepRecentTokens, backgroundTokens, modelOverrides}`、`CompactionTask` |
| **Checkpoint** | task 每步状态快照 | `runtime.commit(()=>({status, checkpoint}))`、`runtime.sleepUntil()`、`TaskRecord.state.checkpoint` |
| **Agent** | 会话跑什么：模型/thinking/扩展/工具/指令/cwd | `conversation.configure(change, ctx)`、`agent(ctx)`、`configure(tx,id,change)` |
| **Environment** | 工具执行环境（本机/远程/沙箱） | `NodeExecutionEnv({cwd})`、`HarnessOptions.env`、`env.exec(argv,opts,ctx)`、`cleanup()` |

### 2.3 一次问答在存储里的样子

```
submit(input) → pi.user
  pi.generation → pi.system（仅当 prompt/工具变化）, pi.assistant（含 tool calls）
    pi.tool × n → pi.tool-result × n   （由 generation 拥有并等待）
  pi.generation → pi.assistant（答案）→ submission done
```
实测 `entries()` 返回 `pi.assistant | pi.user | pi.assistant | pi.tool-result | pi.assistant | pi.system | pi.user`（**降序**）。`pi.system` 只在变化点出现——为保住 provider prompt cache。

---

## 三、二次开发流程（重点）

### 3.1 安装与运行时

```bash
npm install @earendil-works/pi-durable@1.4.0 @earendil-works/pi-ai@1.4.0 @earendil-works/chord@1.4.0
```

实测 91 个包、**3 秒**。要求：Node ≥22.19、ESM only、根入口加载 TypeBox（未打包峰值 RSS 约 23MB，tree-shaken 约 4MB）。可用 subpath：`./tools` `./env{,/node}` `./storage/{memory,sqlite,sqlite/node,sqlite/cloudflare,jsonl,jsonl/node,indexeddb}` `./codemode` `./tool-search` `./images{,/node,/cloudflare}` `./testing`（后三者在 1.2+ 才有）。

### 3.2 最小可运行例子（实测通过）

用 pi-ai 内置 `faux` provider（假模型，无需 key，可脚本化响应）：

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, createRegistry, AssistantEntry } from "@earendil-works/pi-durable";

const ctx = BACKGROUND_CONTEXT;   // 每次调用都要传：携带取消信号与 telemetry span
const models = createModels();
const faux = fauxProvider();      // 换 openaiProvider() / anthropicProvider() 即真模型
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage(fauxText("Paris."))]);

// 1) 打开 Harness（可选 settings/env/onReport）；2) 根会话：首次创建，之后每次重启都是同一个（ID=1）
const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
// 3) 提交 → 4) 等结果：{ status:"done"|"unanswered", type:"input", answer:EntryId }
const settled = await (await root.submit({ type: "input", content: "Capital of France?" }, ctx)).wait(ctx);
// 5) entry 只是引用，内容要解引用；6) 成本见 §5
const e = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
console.log(e.model?.[0]?.content, await harness.usage(ctx));   // [{type:"text",text:"Paris."}] { models:{...}, tools:{} }
await harness.close(ctx);
```

实测输出 `settled: done input` / `answer: [{"type":"text","text":"Paris."}]` / usage 如 §5。换真模型只改两行：`models.setProvider(openaiProvider())`（读 `OPENAI_API_KEY`）与 `agent.model = { provider: "openai", modelId: "gpt-6.1-sol" }`。

**三个必知坑**（都实测踩过）：① `entries()` 默认 **descending**（新→旧），正序传 `{ order: "ascending" }`；② **entry 是引用**，要 `tx.entry(Class, id)` 解引用，且 `tx` 的读必须在第一次表写前，否则抛 `ReadAfterWrite`；③ **commit 回调里不能 await 任何 Session API**（`snapshot`/`getTask`/嵌套 commit），否则**间歇性死锁**——回调持有唯一那条提交线。

### 3.3 Storage 选型

| 后端 | 导入 | 持久 | 适用与注意 |
|---|---|---|---|
| Memory | `MemoryStorage`（根） | ❌ | 测试/一次性。参考语义实现：递归拷贝所有读写值，模拟真实隔离边界 |
| **SQLite** | `openNodeSqliteStorage(file)` `.../storage/sqlite/node` | ✅ | **生产首选**。WAL + `synchronous=NORMAL`：进程崩溃安全、**掉电可能丢最后一笔**；只把 working set 放内存 |
| JSONL | `openNodeJsonlStorage(dir, ctx)` `.../storage/jsonl/node` | ✅ | 审计/append-only。**整个历史也放内存**→长跑别用；`{fsync:true}` 才保掉电；`main.jsonl` 永不 compaction |
| IndexedDB | `IndexedDbStorage.open(name)` `.../storage/indexeddb` | ✅ | 浏览器。单 owner 独占，需 Web Locks 包生命周期 + `navigator.storage.persist()` |
| DO SQLite | `openDurableObjectSqliteStorage(ctx.storage)` `.../storage/sqlite/cloudflare` | ✅ | Cloudflare DO。一次提交 = 一个 DO 存储事务；同 storage 多 adapter 自动共享操作队列 |

**结论**：单机 Node → **SQLite**；将来上 Cloudflare 只换 adapter（同一套 `SqliteDatabase` facade）。自实现后端可行，但 `commit(writes, adopt, ctx)` 有硬契约：`adopt(seq)` 必须在批次落盘后**同步**调用一次且在下一次 commit 前，漏了就静默破坏一致性 → **务必跑 `registerStorageConformance`**（`/testing`，兼容 Vitest/Jest）。

### 3.4 注册自定义 tool

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool, defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { createBashTool, CodingTools } from "@earendil-works/pi-durable/tools";

const searchIssues = defineTool({
  name: "search_issues", description: "Search the issue tracker",
  parameters: Type.Object({ query: Type.String() }),
  replay: "safe",                       // 只读 → 崩溃后可安全重跑；省略默认 "unsafe"
  execute: async (args, api) => {
    api.output(`searching for ${args.query}\n`);   // 流式输出，最终成为 result.output
    return { output: [{ type: "text", text: await tracker.search(args.query) }] };
  },
});
const deploy = defineTool({             // 不给 replay：中断后只告知"被打断"，绝不重放
  name: "deploy", description: "Deploy a version", parameters: Type.Object({ version: Type.String() }),
  execute: async (args) => ({ output: [{ type: "text", text: await ci.deploy(args.version) }] }),
});
registry.install(defineExtension({ name: "ops", tools: [searchIssues, deploy] }));
registry.install(CodingTools);          // 内置 read / write / edit / bash
```

关键可选字段：`replay:"safe"`（崩溃后自动重跑）、`callers:["model"|"tools"]`（谁能调）、`deferred:true`（先不给模型看，由 `tool_search` 加载）、`structuredOutputSchema`、`outputLimits`（默认 50KiB/2000 行）。**三个输出通道**：`output`（给模型）、`structuredOutput`（给程序）、`details`（给 UI），transcript 只存 `output` 与 `details`。同名 tool 后装覆盖前面的；`wrapTool(tool, (t) => ({...t, execute: 包装}))` 装饰"最终赢的那个"（如给任何 bash 加计时、或换成 venv 里的 bash）。

### 3.5 Extension 的五个扩展点

```ts
import { defineExtension, section, hook, GenerationTask, ToolTask } from "@earendil-works/pi-durable";

const MyExt = defineExtension({
  name: "my-ext",
  sections: [                     // ① 系统提示词片段，每次请求前重建
    section("role", () => "You are the CFO. Report numbers, never prose."),
    section("cwd", (input) => input.env?.cwd),   // 返回 undefined 则整段省略
  ],
  tools: [/* ② */],
  hooks: [                        // ③ 介入内置任务
    hook(ToolTask, { beforeTool: (c) => c.name === "bash" ? { block: "no shell" } : undefined }),
    hook(GenerationTask, { onYield: (a) => needsMoreWork(a) ? { continue: "Keep going." } : undefined }),
  ],
  wraps: [/* ④ 装饰别的 tool/section */], tasks: [/* ⑤ 自定义持久化任务 */],
});
```

Hook 全表：`GenerationTask` 的 `beforeRequest`（替换本次请求 messages，**只能替换不能拒绝**，见 §7.5）/ `afterResponse` / `onYield`（返 `{continue}` 则续跑）/ `afterTools`；`ToolTask` 的 `beforeTool`（阻断或改写参数，**抛异常=阻断**，首个 block 终止链）/ `afterTool`（替换结果，沿链传递）；`CompactionTask` 的 `beforeCompact`。多扩展 hook 同一事件按会话选择顺序成链，`onYield` 在首个"继续"处停，observer 类总是全跑。**Hook 崩溃后会重跑，决定必须存 `memo`（首写生效）**：

```ts
hook(ToolTask, { beforeTool: async (call, api, ctx) => {
  if (call.name !== "deploy") return undefined;
  let ok = await api.memo<boolean>("approval:deploy", ctx);     // 重启后读旧答案，不再问人
  ok ??= await api.memo("approval:deploy", await askInSlack(call), ctx);
  return ok ? undefined : { block: "Nobody approved the deploy." };
} });
```

**实测验证**（`beforeTool` 阻断 + `onYield` 续跑）：`settled: done | deploy actually ran: 0`，模型收到 `<harness>[error] Tool call blocked: no deploy allowed</harness>`。**对"一人公司"的审批流极关键**（CFO 批付款、CTO 批部署）。

### 3.6 Fork

```ts
const answered = await (await channel.submit({ type: "input", content: "@agent why did the deploy fail?" }, ctx)).wait(ctx);
// 在助手答案那个 entry 分叉；thread 看到父到该点的历史，但不复制
const thread = await channel.fork(answered.answer!, { ownership: { kind: "ownerless" } }, ctx);
// 两者并发，互不阻塞
const [a, b] = await Promise.all([
  thread.submit({ type: "input", content: "@agent can we roll it back?" }, ctx),
  channel.submit({ type: "input", content: "@agent who is on call today?" }, ctx),
]);
await Promise.all([a.wait(ctx), b.wait(ctx)]);
```


实测 `root.id=1`、`fork.id=11`，fork 的 entries 与父到分叉点完全一致。`defineDoc` 的 `fork` 字段决定文档行为：`"initial"`（子从初始值，如 `pi.usage` 从 0 计，**不重复计父的账**）/ `"current"`（继承父当前值）/ `"asOf"`（继承父在分叉 entry 时的值，最符合对话分支直觉）。另有 `conversation.context(ctx,{at:entryId})`：拿"若在该点 fork 会看到什么上下文"但**不创建会话**。

### 3.7 Watch 事件流

**A. `watch()` — 结构化视图 + 精确 ops（推荐自建 UI）**：

```ts
const watch = await root.watch(ctx);
render(watch.value);            // 附着时当前值：{ conversation, entries, docs }
watch.start(async (value, ops) => {
  // value.entries = 活动 transcript
  // value.docs["pi.live"] = 正在流的 generation（partial/retry/deferred）与 tool 调用
  // value.docs["pi.inbox" | "pi.usage" | "pi.agent" | "pi.provider"]
  render(value);
  await send(ops);              // 转发远端，客户端自己 apply
});
// await watch.stop();
```

实测 `watch.value` 键为 `['conversation','entries','docs']`；跑一轮观察到 3 次提交，`docs["pi.usage"]` 随之更新。

**B. `watchEvents()` — coding-agent 风格事件（实验性，字节更多）**：`watchEvents(harness, root.id, ctx)` → `initialize(stream.snapshot)` → `stream.start(evs => ...)`，快照打底后增量推送。实测事件类型：`message_start, message_end, submission, run_start, turn_start, turn_end, run_end, usage_changed`。

**流控事实**：慢消费者最多积压 **100 帧**，超出后用一帧完整最新视图替换未投递后缀 → **中间态被跳过**；要审计每次变化必须写 entry/journal 再显式 scan；迟到/重连从当前视图开始**不重放**；进度提交默认每 **100ms**（崩溃最多丢 100ms）；结束原因 `stopped/cancelled/retired/ended/listener_error/failed`。

### 3.8 中断恢复（实测复现）

```ts
// ── 进程一：工具调用中途被 process.exit(0) 杀掉 ──
const slow = defineTool({ name: "slow", description: "slow", parameters: Type.Object({}),
  execute: async () => { await new Promise(r => setTimeout(r, 60_000)); return { output: [{type:"text",text:"never"}] }; } });
const h1 = await Harness.open(await openNodeSqliteStorage("./agent.sqlite"), { models, registry }, ctx);
await (await h1.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } }))
  .submit({ type: "input", content: "go", requestId: "job-1" }, ctx);
process.exit(0);        // ← 崩溃点：工具正在跑

// ── 进程二：重开同一文件 ──
const harness = await Harness.open(await openNodeSqliteStorage("./agent.sqlite"), { models, registry }, ctx);
const root = await harness.root(ctx);     // 还是同一个 root
harness.resume();                         // 启动调度器，续跑被打断的任务
const settled = await (await root.submit({ type: "input", content: "go", requestId: "job-1" }, ctx)).wait(ctx);
```

实测：`inspect before resume: [{"kind":"pi.generation","status":"pending"}]` → `settled: done input`。`resume()` 之前 `inspect()` 显示 `pending`——**恢复前不跑任何 handler**（规范："No handler dispatches during open"）。

**恢复语义的精确边界**：

| 情形 | 行为 |
|---|---|
| 模型请求被打断 | 重发；部分答案留在 transcript 标 aborted |
| tool `replay:"safe"` / 默认 unsafe | 重跑 ／ **不重跑**，模型收到 `interrupted` 错误 + 已提交部分输出，自行决定 |
| 排队消息 / 同 `requestId` 重提 | 仍在队列 ／ 返回**原 submission**（exactly-once 准入） |
| `close()` | 停所有 invocation 但**不写 outcome**，重开续跑；**close 不计 crash 计数**；若 tool 忽略 abort signal，`close()` 会挂住、Storage 不释放 |
| 连续崩溃 5 次（`restartLimit`）且未提交新状态 | task 被 park（`blocked: restart_limit`），需 `harness.retryTask(id)`；`abandonOnRestart:true` 的 task 则连同其拥有的一切被 abort |

---

## 四、多 agent 编排能力

### 4.1 Subagent：没有内置，但有原语（约 40 行）

原文："Pi Durable has no built-in subagents, but they take a few lines of code to build"。模式：**tool 创建一个自己拥有的 conversation，驱动它，等它答完**。

```ts
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
const Subagent: Extension = defineExtension({
  name: "subagent",
  tools: [defineTool({
    name: "subagent", description: "Delegate a self-contained task to a subagent and get its answer back.",
    parameters: Type.Object({ task: Type.String() }),
    replay: "safe",                              // 崩溃重跑时能找回同一个子会话
    execute: async (args, api, ctx) => {
      const child = await api.commit(async (tx) => {
        // ownership 索引记住子会话，重跑时复用而非再建一个
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing !== undefined) return existing.id;
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        // 子会话从父 agent 复制而来：改便宜模型、不许它再开子 agent
        await configure(tx, created.id, { model: { provider: "openai", modelId: "gpt-6-luna" }, extensions: { remove: [Subagent] } });
        return created.id;
      }, ctx);
      await api.details({ conversationId: child }, ctx);   // UI 可把子会话挂在这个调用下
      const settled = await (await (await api.conversation(child, ctx))!
        .submit({ type: "input", content: args.task, requestId: `subagent:${api.taskId}` }, ctx)).wait(ctx);
      const msg = (await api.commit((tx) => tx.entry(AssistantEntry, settled.answer!), ctx))?.model?.[0] as AssistantMessage;
      return { output: [{ type: "text", text: msg.content.flatMap((c) => c.type === "text" ? [c.text] : []).join("") }] };
    },
  })],
});
```

**实测通过**：子会话创建成功（`owner = {conversationId:1, taskId:12}`），父子**分别**有 `pi.usage`（父 174 tokens / 子 10），`harness.usage()` 汇总 184 → "多角色成本分别核算"天然支持。

**两种模式**：前台（`ownership:{kind:"task"}`，父 idle 等子 idle，Esc 级联中止，见 `21-subagent-foreground.ts`）／后台（子会话由**后台 anchor task** 拥有、每条消息投递由 reporter task 负责，父 Esc/idle 碰不到，子答完用 follow-up **推回**父会话，见 `22-subagent-background.ts` 364 行最完整）。后台技巧：用"立刻完成"的 anchor task 当所有权边界（**后台任务是遍历边界**）；reporter 的 `requestId` 用 `subagent:${reporter.id}` 保证重启后消息只发一次、报告只回一次。

### 4.2 Ownership 树与结构化并发（多 agent 不失控的机制保证）

规范 §5.5：每个 task 创建时必须指定 owner（`{kind:"conversation"}` 顶层 / `{kind:"task", taskId}` 子）；每个 conversation 要么 ownerless 要么被一个 task 拥有；**abort 向下流**（先 abort 它拥有的一切，再跑自己的 abort handler，自底向上清理）；**拥有的工作不能比 owner 活得久**（完成时若拥有工作仍在跑，状态为 `completing`，真正 `terminal` 要等它们全结束）；**background 是边界**（普通遍历跳过 background task 及整棵子树，`abort(ctx,{background:true})` 才能穿透）。

### 4.3 Child tasks 与 Task Graph

```ts
const Payment = defineTask<{ card: string }, { phase: "charge" }, string>({
  name: "shop.payment", version: 1, initial: () => ({ phase: "charge" }),
  phases: { charge: async (task, runtime, ctx) => {
    const c = await bank.charge(task.input.card, `payment-${task.id}`);   // key 保证幂等
    await runtime.commit(() => ({ status: "terminal", outcome: c.ok
      ? { status: "completed", result: c.receipt }
      : { status: "failed", error: { message: c.error } } }), ctx);
  } },
  abort: async (task, runtime, ctx) => {           // 另一笔失败时退款
    await bank.refund(`payment-${task.id}`);
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
  },
});
// 父任务：并发起 4 个子任务，全部结束后在 decide 阶段汇总
pay: async (task, runtime, ctx) => { await runtime.commit(async (tx) => {
  const payments = [];
  for (const card of task.input.cards)
    payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
  return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "failFast" };
}, ctx); },
decide: async (task, runtime, ctx) => { await runtime.outcomes(task.state.checkpoint.payments, ctx); /* 再提交 outcome */ },
```

`policy:"failFast"` → 首个子任务失败即 abort 其余；`"allSettled"` → 全结束才继续。

**Task Graph**（"老板看板"）：`harness.watchTaskGraph(ctx)` 给所有活任务的一个值，节点含 owner 边、状态（`pending/running/waiting/completing/sleeping`）、是否 background、拥有哪些 conversation、`blocked` 原因；重启后原 `running` 显示为 `pending` 直到重跑，graph 只列活任务。

### 4.4 Inbox：给运行中的 agent 发消息（实测）

```ts
const s1 = await root.submit({ type: "input", content: "long task" }, ctx);
await root.submit({ type: "input", content: "steer msg",  whenBusy: "steer" }, ctx);
await root.submit({ type: "input", content: "follow msg", whenBusy: "followUp" }, ctx);
// 实测 pi.inbox = {"items":[{"id":23,"mode":"steer",...},{"id":24,"mode":"followUp",...}]}
try { await root.submit({ type: "input", content: "x", whenBusy: "reject" }, ctx); }
catch { /* 实测抛 ConversationBusy */ }
await s1.wait(ctx);   // 实测之后 pi.inbox = {"items":[]}，两条都被消费
```

四种语义：`"followUp"`（默认，run 答完后放入开启下一 run）／`"steer"`（当前工具轮结束后插入，加入**正在跑**的工作）／`"reject"`（忙则抛 `ConversationBusy`）／`type:"write"`（只追加 entry 不询问模型；仅带 `kind`+`data` 时**立即**追加，聊天消息即时显示）。

`submission.abort(ctx)` 撤回排队项；`steeringMode`/`followUpMode="all"` 可一次放入全部。**对"老板随时插话"的直接价值**：`steer` = 老板打断正在干活的员工并改方向；`followUp` = 老板追加一句、员工做完手头再处理。**这两个语义不用自己写**。

### 4.5 调度器、sleep 与并发

**durable sleep**（不是 cron，是"睡到某时刻"）：

```ts
const Reminder = defineTask<{ text: string; at: number }, { phase: "wait" } | { phase: "deliver" }, null>({
  name: "app.reminder", version: 1, initial: () => ({ phase: "wait" }),
  phases: {
    wait: (task, runtime, ctx) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, ctx),
    deliver: async (task, runtime, ctx) => {
      await notify(task.input.text);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
    },
  },
  abort: (_t, r, ctx) => r.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});
```

实测：`harness.wake()` 返回 `{"active":true,"at":1792785638213}`（下一 deadline），到点 `deliver` 自动触发。**sleep 期间不占 invocation、不占进程**——这是"定期开会"的正确实现方式。

**并发边界**（别误解）：harness 内**多 conversation 并发**支持（实测两会话 6ms 内答完）；conversation 内**工具并行**由 `settings.toolExecution="parallel"`（默认）；**跨进程同写一个 storage 不支持**（只能 `readOnly:true`）；**无全局并发上限配置**（无 `maxConcurrentTasks`），限流自己加信号量；Cloudflare 一 session 一 DO，天然隔离 + 休眠。

---

## 五、Usage 与 Cost（CFO 关键）

### 5.1 数据结构与三个取数口

```ts
type Usage = { input; output; cacheRead; cacheWrite; totalTokens;
  cacheWrite1h?;  // Anthropic 独有：1h 保留的 cacheWrite 子集
  reasoning?;     // output 的子集
  cost: { input; output; cacheRead; cacheWrite; total;  // 实报优先，否则目录价估算
          totalFromProvider? } };                       // true = 真实账单
type UsageState = { models: Record<string, Usage>; tools: Record<string, Usage> };
// models 键 = "provider/modelId"；tools 键 = tool 名（tool 也可返回 usage）
```

```ts
const u = await harness.snapshot(UsageDoc, conversationId, ctx);  // ① 单会话（内置 pi.usage 文档）
const total = await harness.usage(ctx);                            // ② 全会话汇总
// ③ UI 实时：watch 的 value.docs["pi.usage"]，或 watchEvents 的 usage_changed
```

**记账规则**（规范 §8.6，实测吻合）：每个 `pi.assistant` 在同一 commit 把 usage 累加到 `models[provider/model]`；每个带 usage 的 `pi.tool-result`（含嵌套调用）累加到 `tools[toolName]`；**每次 compaction 摘要尝试都计入**（即使 stale/失败/未放置）；**失败与中止的尝试也计**；**fork 从 0 计**（不重复计父）；无跨会话持久总额，`harness.usage()` 每次现算求和。

### 5.2 实测：分层成本可见

```
父会话: input 61 / output 12 / cacheRead 40 / cacheWrite 61 → totalTokens 174
子会话: input  4 / output  2 / cacheRead  0 / cacheWrite  4 → totalTokens  10
Session 汇总（harness.usage）:                                  totalTokens 184
```

→ **"每个角色花了多少、每个项目花了多少"原生支持**：角色 = conversation，读它的 `pi.usage`；项目 = 一组 conversation，自己 scan 求和。

### 5.3 cost 从哪来（**必须理解，否则会看到一堆 0**）

`cost` 由 pi-ai 在**每个 provider API 实现内部**调 `calculateCost(model, usage)` 填充（`anthropic-messages.js`/`openai-responses-shared.js`/`mistral-conversations.js`/`classifier-shared.js` 均有调用点）。所以真实 provider → cost 有值（实报时 `totalFromProvider:true`）；**`faux`/自建 provider 未填 `cost` 字段 → cost 全 0，只有 token 数**。实测：

实测：faux 无价目时 cost 全 0（`{"input":0,...,"total":0}`）；而 `calculateCost(claudeFable5, {input:12000, output:800, cacheRead:30000, cacheWrite:2000})` → `{input:0.12, output:0.04, cacheRead:0.03, cacheWrite:0.025, total:0.215}`（该模型目录价 `{input:10, output:50, cacheRead:1, cacheWrite:12.5}` 美元/百万 token）。

**给 CFO 的实操建议**：自建 provider 务必填 `cost:{input,output,cacheRead,cacheWrite}`（美元/百万 token），否则账全 0；历史数据可用 `calculateCost()` 补算。

### 5.4 缺口：没有预算硬约束（要自己写，且有坑）

pi-durable **没有** `maxCost`/`budget` 配置（grep 过 spec 与 `HarnessSettings`，只有 `restartLimit`、`outputLimits`、`compaction.reserveTokens` 等，均非成本约束）。实测两种自建方案：

```ts
const spent = async (api, ctx) =>   // 共用：本会话已花多少 token
  Object.values((await api.snapshot(UsageDoc, api.conversationId, ctx))?.models ?? {})
    .reduce((s, m) => s + m.totalTokens, 0);

// ❌ A：抛异常 —— 不阻断（实测只报 extension_error，请求照样发出去）
hook(GenerationTask, { beforeRequest: async (r, api, ctx) => {
  if (await spent(api, ctx) >= BUDGET) throw new Error("budget exceeded"); } });

// ✅ B：替换 messages —— 软拦截（实测生效）
hook(GenerationTask, { beforeRequest: async (r, api, ctx) => {
  const total = await spent(api, ctx);
  if (total < BUDGET) return undefined;
  return { messages: [{ role: "user", content: `[budget guard] 已花 ${total} tokens，超预算。只回复：BUDGET EXCEEDED。`, timestamp: Date.now() }] };
} });
```

A 实测：`run 1 done usage:[20]` → `report: extension_error budget exceeded` → `run 2 done usage:[41]`（**请求照样发出**）——异常被 `onReport` 记为 `extension_error` 后**跳过该 hook 继续请求**，正是未合并 issue **#11055**。B 实测第 3 轮最后 entry 为 `BUDGET EXCEEDED`，真实问题未送给模型；**代价**是仍花一次极小请求、回复不可控。**更硬的做法**：tool 层 `beforeTool` 真正 block + 业务层不派单；要"零成本硬停"只能 `abortTask()`/`conversation.abort()`（run 会变 `unanswered`）。

---

## 六、与"一人公司"需求的匹配度

需求：多角色（CEO/CTO/CFO/CPO/COO/CMO/CHRO）+ 项目 + 项目内员工 + 定期开会 + 老板随时查看与分叉沟通 + 成本核算。

| 需求 | pi-durable 提供 | 判定 |
|---|---|---|
| **多角色 + 各角色不同模型/预算** | conversation + `configure()` 各自 model/thinkingLevel/extensions/tools/instructions/cwd；`compaction.modelOverrides` 按模型设阈值 | ✅ **直接可用**。角色 = 一 extension（人格与职责）+ 一 conversation（状态与成本） |
| **项目** | conversation（或一组）+ 自定义 document 存项目元数据 | ⚠️ **半自建**，无"项目"一级概念 |
| **项目内员工** | task-owned conversation + `configure` 复制父 agent | ✅ 直接可用（subagent 模式） |
| **员工长期存在、可反复对话** | 后台 subagent 模式（anchor + reporter），`22-subagent-background.ts` 完整参考 | ⚠️ 要写约 200 行（官方示例可抄） |
| **定期开会** | `defineTask` + `runtime.sleepUntil()`；`wake()` + `onWake` 给宿主定闹钟 | ✅ 直接可用。**但无 cron 表达式**，重复会议要自己排下次 sleep |
| **老板随时查看 + 分叉沟通** | `watch()`/`watchEvents()`/`watchTaskGraph()`（迟到重连从当前视图开始）；`fork(entryId)` + `ownership:{kind:"ownerless"}` + `whenBusy:"steer"\|"followUp"` | ✅ 分叉**直接可用**（设计时就考虑，Slack thread 隐喻）；查看数据层可用、**UI 自建** |
| **成本核算（按角色/项目）** | `pi.usage` per conversation + `harness.usage()` + `Usage.cost` | ✅ 数据层可用，报表/告警自建 |
| **成本硬预算** | ❌ 无 | ❌ **必须自建**（hook 软拦 + tool block + 不派单） |
| **审批流**（CFO 批付款、CTO 批部署） | `hook(ToolTask,{beforeTool})` + `api.memo` 幂等 | ✅ 直接可用（实测阻断生效） |
| **崩溃恢复** | checkpoint + `resume()` + `requestId` 幂等 + `restartLimit` park | ✅ 直接可用（实测复现） |
| **多客户端（老板/手机/网页）** | 一切 UI 状态即已提交状态；`watch()` 给精确 ops 可转发 socket | ✅ 数据层可用，传输层自建 |
| **权限/多租户 + 删除会话** | ❌ 均无（CF 示例："intentionally has no authentication"；issue #11026 无删除 API） | ❌ **必须自建**（软删 = 自定义 doc 标记） |
| **审计日志** | entry 不可变、永不删、compaction 只加不删；`entries()` 可分页扫 | ✅ 可用（导出自己写） |

**建议的架构映射**：

```
Session（= 一家公司，一个 storage / 一个进程）
├── CompanyDoc（公司元信息、角色名册、项目索引）
├── Conversation "board"（老板主会话 = root）
├── Conversation "role:CEO"/"role:CTO"/"role:CFO"...   ← 每角色一个长期会话
├── Conversation "project:alpha"                       ← 每项目一个
│    └── task-owned conversations "...:employee:dev1" ...
├── Task MeetingScheduler（sleepUntil 到下次例会 → 各角色汇报）
├── Task LedgerRollup（定期把各会话 pi.usage 汇总进 CostDoc）
└── Extensions: role-*（sections 定人格 + tools 子集）/ approval-guard（付款部署需 memo 审批）
                / budget-guard（beforeRequest 改写 + beforeTool block）/ subagent / spawn-employee
```

**净结论**：可直接复用的"硬骨头"= 崩溃恢复、并发多会话、fork、inbox 排队语义、ownership 树与级联 abort、per-conversation 成本记账、watch 事件流、审批 hook、durable sleep（自研至少 3-6 个月且极易写错）。必须自写的"外壳"= 所有 UI、认证与多租户、项目与角色领域建模、预算硬约束、报表、会话归档、cron、限流。工作量估算（我的判断）：MVP（单机 + 简易 Web + 7 角色 + 项目 + 会议 + 成本看板）约 **6-10 人周**；生产级（鉴权、多租户、部署、监控、预算硬控）再加 **8-12 人周**。

---

## 七、风险与坑

### 7.1 Experimental 与 API 不稳定（**最高风险**）

README 首行："Experimental. The API changes without notice between releases." 逐版读 CHANGELOG 确认：**1.1/1.2/1.3/1.4 每个 minor 都有 Breaking Changes**：

| 版本 | 破坏性变更（节选） |
|---|---|
| 1.1.0 | `Storage` 必须支持 `ConversationQuery.order`；`runtime.context()` 签名改 |
| 1.2.0 | `ToolTaskInput`/`Result` 改 tagged union（`pi.tool` v2 并迁移 v1）；`ToolExecutionResult.content → output`；**任何 Storage 错误都 fatal**；`bash` 非零退出改 error result |
| 1.3.0 | `SqliteStorage.open(db,{prefix})` 命名空间；CF adapter 共享操作队列 |
| 1.4.0 | **删 `TaskRuntime.sleep()`**（改 `sleepUntil`）；新增 `sleeping` 状态（穷举 `TaskState` 的代码要加 case）；**SQLite schema v2 迁移后不可回滚**；`defineDoc` **强制** `checkpointWhen`；新增 `restartLimit`（默认 5）；`onReport` 加第二参数 |
| 未发布(main) | `Storage.commit()` 加 `adopt`；**删 `Conversation.viewState()`/`Harness.taskGraph()`**，改 `watch()`/`watchTaskGraph()`；新增 `readOnly` |

**实测确认 churn 真实性**：按 main 分支 README 写的代码里，`readOnly: true` 在 1.4.0 被**静默忽略**，`harness.taskGraph` 不存在——**文档与已发布版本存在漂移**。→ **对策**：锁精确版本（`1.4.0`，不用 `^`）；README 一律以 `v1.4.0` tag 为准（`raw.githubusercontent.com/earendil-works/pi/v1.4.0/packages/durable/README.md`），不读 `main`。

**运行时与打包**：Node ≥22.19 硬约束；ESM only 无 CJS（老工具链集成痛）；三包解压约 13MB、根入口加载 TypeBox 峰值 RSS 约 23MB（tree-shaken 约 4MB）；`pi-ai` 直依赖 `openai`/`@anthropic-ai/sdk`/`@google/genai`/`@smithy/node-http-handler`（实测 91 包）。

### 7.2 存储后端的坑

**单进程独占**——官方："One process owns a storage at a time, and there is no cross-process locking."，两进程同开会互相破坏，只能 `readOnly:true` 只读。**SQLite 迁移不可逆**——1.4.0 打开旧库自动迁 schema v2 并重建 task 表，迁移后 1.3.0 及更早打不开，部署无法回滚。**SQLite 掉电**——WAL + `synchronous=NORMAL` 进程崩溃安全，但**掉电可能丢最后一笔**。**JSONL 内存**——"Keeps the whole history in memory too... use SQLite for long-running agents"，默认不 fsync，`main.jsonl` 永不 compaction。**Memory 是参考实现**——递归拷贝所有值模拟真实隔离，非性能导向。**自定义后端硬契约**——`commit` 必须同步调 `adopt(seq)` 一次且在下次 commit 前，`mintId()` 必须大于所有已存在 ID（跨重开），写错静默破坏一致性 → **必跑 conformance**；改 `prefix` 不迁移已有数据。

### 7.3 恢复语义的边界（最易误判）

- **只有 `replay:"safe"` 的 tool 会重跑**，默认 `unsafe`。把"发邮件/转账"设成 `safe` 又没做外部幂等**会重复执行**。规范原文："a replay-safe tool with external effects still needs its own idempotency."
- **`close()` ≠ crash**：close 不计 crash 计数且不写 outcome，混淆会导致 `restartLimit` 误判。**`restartLimit`（默认 5）会 park 任务**（`blocked: restart_limit`，`wake()` 不再认为 active）→ **必须巡检 + `retryTask()` + 告警**，否则静默卡死。**`abandonOnRestart`**：非 replay-safe tool 创建的嵌套调用与子任务默认带此标记，重启被 abort。**`env` 在恢复时重建**：重跑用**当前** `cwd`，可能与首次不同。
- **close 会被不合作代码挂住**："A task handler, tool, or hook that ignores its signal keeps `close()` pending and Storage open" → 所有 tool 必须尊重 abort signal。
- **存储错误致命**：任何 `Storage` 方法抛错（读也算）→ Session 失败自我关闭，之后全部 reject `SessionFailed`，**无重试**，要 reopen（`harness.closed` 里判断 `reason==="failed"` 即重启）。`StorageRequestError` 只失败那一次读，但 `commit()`/`mintId()` 抛同类错误仍致命。

### 7.4 并发限制

无跨进程（见 7.2）；**无全局并发上限配置**，限流自己加信号量；**单条提交线**（commit 全串行，长事务阻塞一切 → "Never await models, tools, processes, network calls, humans, a nested Session commit, or a Session waiter inside it"）；**commit 内读 Session API 会间歇死锁**（`snapshot()`/`getTask()`/`watchDoc()` 在回调里可能永不 resolve）；工具输出上限默认 50KiB/2000 行；watch 积压上限 100 帧。

### 7.5 功能缺口与已知 issue

缺口：**无认证/多租户**（CF 示例："intentionally has no authentication"）、**无会话删除**（issue #11026）、**Harness 无 conversation 列表 API**（只能在 `commit(tx => tx.scanConversations(...))` 里查，实测确认）、**无 cron**（只有 sleep-until）、**无 UI**、**无内置 subagent**（前台约 40 行/后台约 200 行）、**无成本硬预算且 `beforeRequest` 不能拒绝**（§5.4，实测 + issue #11055）。

其它 open issue：#11332（后台任务与 busy 语义边界仍在调整）、#10857（CF 上 sleeping task 只在下个请求才唤醒）、#11139（generation 响应错误时死循环风险）、#10583（压缩阈值与真实用量有偏差）、#11327（`watchEvents` 断线只能拿快照，不能续传）。

### 7.6 Prompt cache 的隐性成本坑

`section()` 渲染结果**每次都变**（如嵌入当前时间）→ 每次追加 `pi.system` delta → **彻底破坏 prompt cache**，成本可能翻几倍；默认扩展选择下装/卸扩展或改 settings 也会追加 system entry → miss cache。好消息：它只发**变化部分**，且支持 mid-conversation system message（Anthropic/OpenAI Codex）。**给 CFO 的提醒**：`cacheRead` 便宜 10 倍、`cacheWrite` 贵 1.25 倍，"人格 section 稳定"直接等于省钱——7 个角色的 section 必须写成常量。

---

## 八、基于 pi-durable 实现一人公司的可行性判断与技术风险

### 8.1 判断：**推荐采用，作为地基，不作为平台**

**支持**：① 解决的正是最难自研的部分（崩溃恢复 + 并发多会话 + 多客户端一致视图 + per-conversation 成本记账），自研隐性 bug 成本极高（尤其"老板随时插话 + 分叉 + 后台员工"这种状态组合）；② "fork + inbox + ownership" 三元组几乎为该场景设计，原文 Slack channel/thread 隐喻与"老板主频道问、thread 追问、员工后台干活"高度同构；③ 成本数据模型正确且分层，足以支撑 CFO 报表；④ 审批流可用（实测生效），是"AI 员工不能擅自花钱/部署"的机制保证；⑤ 生态活跃（23 天 7 版、11.7 万 star、CF 官方示例仓、31 个示例、5594 行规范），不是玩具；⑥ MIT + 全本地符合数据主权；⑦ 可移植（Node → CF DO 只换 storage adapter）。

**保留**：① API experimental、每 minor 破坏兼容（最大风险，但属工程风险）；② 不提供任何应用层（UI/鉴权/多租户/项目管理/报表/cron/预算硬控全自写），省的是"runtime"不是"产品"；③ 单进程独占 storage 限制水平扩展（除非走 CF DO"一 session 一 DO"）；④ 无内置 subagent 与成本硬预算；⑤ 心智负担不低（commit 线、`ReadAfterWrite`、`completing`、background 边界、replay 语义、watch 帧上限），踩坑偏隐蔽（死锁、间歇性）。

### 8.2 推荐策略：**防腐层 + 锁版本 + 契约测试**

```
业务代码 → CompanyRuntime（唯一 import pi-durable 的地方）
             ├── openCompany()     封装 Harness.open + 恢复巡检
             ├── spawnRole() / spawnEmployee() / forkAt() / talk()
             ├── subscribe()       封装 watch / watchEvents
             ├── cost()            封装 usage 聚合 + 预算判断
             └── approve()         封装 memo 审批
目录：src/runtime/（防腐层：open/registry/env/recover）→ src/company/（业务）→ src/server/（watch 转发 + submit 接消息）
```

纪律：① **锁精确版本** `"1.5.0"`（三包同版本，无 `^`）；② **只读 v1.5.0 tag 的文档**，不读 `main`；③ **写契约测试**（8 个封装各 1-2 个集成测试，用 `fauxProvider` 不需真 key），升级前必跑；④ 只在有明确收益时升级、每次读 CHANGELOG 的 Breaking Changes、SQLite schema 迁移前备份（v2 不可回滚）；⑤ **绝不自行实现 Storage**（确需 Postgres 先跑 `registerStorageConformance`）；⑥ **所有 tool 显式声明 `replay`**，有外部副作用的绝不设 `safe`，各自做幂等 key；⑦ **所有 tool/hook/task 尊重 abort signal**，否则 `close()` 挂住；⑧ **必须实现的宿主逻辑**：`harness.closed` 失败即 reopen、启动 `inspect()` 巡检 `restart_limit` + `retryTask()` + 告警、`onReport` 全量分类接住、`settings.progress` 按存储延迟调（远程可放宽到 500ms）。

### 8.3 落地里程碑

| 阶段 | 目标 | 验收 |
|---|---|---|
| **M0 技术验证**（3-5 天） | 跑通 §3.2 最小例 + §3.8 崩溃恢复 + §4.1 subagent + §5 成本分层 | 4 个可运行脚本，成本数字对得上 |
| **M1 角色骨架**（1-2 周） | 7 角色 extension + 每角色一 conversation + `CompanyRuntime` + 契约测试 | 7 角色各自对话，成本独立可查 |
| **M2 项目与员工**（2 周） | 项目 doc 模型 + task-owned 员工会话 + 后台 subagent（抄 `22-subagent-background.ts`） | 一项目 3 员工并发干活，老板可 steer |
| **M3 会议、分叉与成本**（2 周） | MeetingScheduler + fork 任意 entry + inbox 四模式接 UI；LedgerRollup + 预算软拦 + 审批 hook + 报表 | 定时例会；任意消息可分叉；CFO 看按角色/项目/时间的成本；超预算被拦 |
| **M5 生产化**（3-4 周） | 鉴权、多租户、部署、监控、告警、归档、限流 | 可对外 |

### 8.4 风险评级

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| API 破坏性变更返工 | **高**（每 minor） | 中（有防腐层可控） | 锁版本 + 契约测试 + 薄封装 |
| 存储错误致 Session 静默关闭 / task 被 park 后卡死 | 中 | **高**（停摆） | `harness.closed` 重启 + 启动 `inspect()` 巡检 + `retryTask` + 告警 |
| commit 内 await 间歇死锁 | **高**（文档明列） | 中 | code review 规则 + lint |
| replay 误用致副作用重复 | 中 | **高**（重复付款/部署） | 强制显式 `replay` + 外部幂等 key + 审批 hook |
| 成本失控（无硬预算） | **高** | 中 | 软拦 + tool block + 不派单 + 日预算巡检 |
| 单进程独占 / 团队心智负担 | 中 | 中 | 早期"一 session 一进程/DO"；只经 `CompanyRuntime` 使用 |
| 上游停维护 | 低（活跃） | **高** | MIT + 约 2.7 万行 TS → fork 自维护可行 |

### 8.5 一句话结论

> **值得作为"一人公司"的运行时地基**——它把 durable execution、多会话并发、fork/inbox/ownership、分层成本记账这些最难且最易出隐性 bug 的部分做对了，并经 Cloudflare 生产场景验证。但它**不是平台也不是应用**：UI、鉴权、领域建模、预算硬控、cron、报表全部自建，experimental 的 API 意味着必须用"防腐层 + 锁版本 + 契约测试"隔离变更风险。能接受这套纪律，它是当前开源选项里最贴合"多角色 AI 公司"语义的基座；不能接受则应退回保守方案（`pi-coding-agent` SDK + 自建持久层），代价是重新面对崩溃恢复与并发一致性的复杂度。

---

## 1.5.0 升级注记（2026-11-05）

- **依赖**：`pi-durable` / `pi-ai` / `chord` / `pi-schema` 全部锁 `1.5.0`。`typebox` 不再是传递依赖。
- **本文正文的时效**：§ 一到 § 八是 1.4.0 的调研结论。1.5.0 里以下说法已经变了：
  `task_parked` / `retryTask` 的 park 语义没有了（连续重启超限由 `task_interrupted` 报告，任务结束）；
  `session_failed` 改叫 `storage_failed`；`subscribeCommits` 换成 `observeCommits`；
  `watchEvents()` 被删，改用会话视图 / `ConversationTranscript`；`pi.live` 失败后保留 `runFailure`；
  工具参数 schema 走 `pi-schema`（`obj` / `str` / `num` / `bool` / `arr` / `opt`），不再从 `pi-ai` 拿 TypeBox。
- **我们实际用到的迁移**：`src/core/runtime/index.ts` 的 `Type.*` 门面、`open.ts` 的
  `toRuntimeReport(report)`、`interface/http/sse.ts` 的 `observeCommits`；详见 ADR-071。
- **1.5.0 新增、尚未采用**：`maxTurns`、`continue` submission、`runFailure`、`readOnly`、
  `whenIdle: "reject"`（`whenBusy: "steer"` 1.4.0 已有、我们已在用）、`beforeProviderRequest`、`afterRun`、`ConversationTranscript`。
  它们对 Solo 的价值见 ADR-071「取舍」。

## 附录：实际执行的验证清单

均在本机（macOS / Node v26.12.0 / npm 11.20.0）实跑，正文标"实测"者即来自此表：**①** `npm install` 三包 @1.4.0 → 91 包 / 3 秒；**②** 最小对话（Memory + faux）→ 答出 "Paris."，usage 正确；**③** 崩溃恢复（SQLite + 60s tool + `process.exit`）→ `inspect()` 见 `pending` → `resume()` → 同 `requestId` 答完；**④** fork / watch / watchEvents → fork id=11、watch 3 次提交、8 类事件；**⑤** 自定义 tool + doc + subagent + 分层 usage → 子会话 owner 正确、父子 usage 分别统计；**⑥** 并发两会话 / inbox 三模式 → 6ms 并发、steer/followUp 入队并消费、reject 抛 `ConversationBusy`；**⑦** CodingTools（bash）+ compaction → bash 输出正确、compact 产生 `pi.compaction`；**⑧** 自定义 task + `sleepUntil` + `wake()` → `wake()` 返回 deadline、到点触发 `deliver`；**⑨** JSONL 重开 / readOnly → 重开读到历史、`readOnly` 在 1.4.0 尚不存在（静默忽略）；**⑩** 预算 guard（抛异常 vs 改写请求）→ 抛异常仅报 `extension_error` 不阻断、改写可软拦；**⑪** `calculateCost` → 12k in/800 out/30k cacheRead/2k cacheWrite = $0.215。
