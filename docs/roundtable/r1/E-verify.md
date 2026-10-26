# E 席（验收与测试设计 / 唱反调）：让这四份意见可被证伪

> 只做一件事：把 A/B/C/D 的主张变成**能跑红或跑绿的具体断言**。凡是能被 `grep` 推翻的地方都附命令。

---

## 0. 前置：三个必须先纠正的事实（否则下面所有断言都无处落地）

| # | 圆桌流转的说法 | 我实测 | 命令 |
|---|---|---|---|
| 0.1 | 「可以在 CI 里跑」 | **本仓库没有 CI**。`.github/workflows` 不存在，`package.json` 里也没有任何 `verify` 聚合脚本 | `ls .github/workflows` → exit 1；`sed -n '1,25p' package.json` 只有 `test`/`check`/`ui:build`/`ui:shot` |
| 0.2 | 「real-model 会静默 skip 掉 8 个 e2e」 | 该文件实测 **3** 个顶层 `test`，不是 8 | `grep -c "^\s*test(" test/e2e/real-model.test.ts` → 3 |
| 0.3 | 「D：`board.js` 后端挂了静默显示假任务」 | **有可见标记**，不静默：badge + 报错文案都在 | `ui/js/board.js:420-422`（`el.source.textContent = board.mocked ? "示例数据" : ""`）、`ui/js/board.js:487-489`（`applyBoard(mockBoard())` + `showError("...下面是契约示例数据")`） |

**0.1 是本席的硬前置**：没有 CI，「加一条 CI 断言」= 「加一条没人跑的脚本」。第一交付物不是测试，是 `npm run verify` 的**收据机制**（§4）。不解决它，A/B/C/D 的任何删除都不可回滚。

---

## 1. 判决口径：行为测试 vs 实现测试（先立规矩，再逐条判）

三条全部满足才算行为测试；任一不满足即**实现测试**，重构中变红**不该拦**：

1. **可替换性**：换个遵守同一契约的实现，断言仍成立。
2. **无内部名词**：不出现私有函数名/常量名/`folded`/`attempt`/`taskId` 拼装格式。
3. **无调用形状**：不断言调用次数与中间状态，只断言外部可见结果（频道有 kind=Y 消息 / 文档有 X / 某人真收到）。

反例（实抓）：
```
test/e2e/delegation.test.ts:11  import { delegate, describeStaff, isEmployeeBusy } from "../../src/company/delegation.ts";
```
`describeStaff`/`isEmployeeBusy` 是内部辅助函数，被 e2e 当公共 API 用；签名一改就红，但「员工忙不忙」这个行为没变 → **不算回归**。

---

## 2. 逐条证伪测试（八条，附「现在会红还是会绿」）

### A-1「`delegation.ts` 是尸体」

**A 席的证据链是断的，必须先修。** A 席用 `grep -rn "deps\.delegate" src/` 零命中断言生产上已死。实测：

```
grep -rn "deps\.delegate" src/            → 0 命中   （A 席的观察为真）
grep -n  "readonly delegate" src/company/management-tools.ts  → 91
grep -n  "delegate: async" src/company/org.ts                 → 242
```

零命中的真实含义是：`ToolDependencies.delegate`（`src/company/management-tools.ts:91`）被声明、被 `src/company/org.ts:233-256` 注入，但 management-tools 内部从未读取。死的是那个闭包。`assign_task` 的真实路径是：

```
src/company/tools.ts:157          assign_task: "assignTask"
src/company/management-tools.ts:739  assignTask: dispatch.assignTask
src/company/management-tools.ts:152  const dispatch = createDispatchTools({ runtime });
```
`createDispatchTools` 在 `src/company/tools/dispatch.ts`，**与 `delegate()` 无关**。

**结论（生产路径已死）大概率对，方法论错**——用错的 grep 得出对的结论，下次就会得出错的结论。正确断言：

```ts
// test/unit/route-consumers.test.ts —— 断言：对 delegate 的调用必须沿工具注册表可达
test("delegate 在生产调用图里可达", async () => {
  const reachable = await callGraphFromToolRegistry(); // capabilities.ts tool名 → tools.ts 映射 → impl
  expect(reachable.has("src/company/delegation.ts#delegate")).toBe(false); // 现在是 false = 确认已死
});
```

**承重难点：8 个测试文件把 `delegate()` 当夹具，删它会一起红。** 实测命中：`test/unit/cost.test.ts:23`、`test/e2e/hierarchy.test.ts:36`、`test/e2e/trail.test.ts:12`、`test/e2e/tui.test.ts:15`、`test/e2e/terminate.test.ts:21`、`test/e2e/delegation.test.ts:11`、`test/e2e/acceptance.test.ts:15`、`test/e2e/reliability.test.ts:23`。调用次数 `grep -c "delegate("`：trail 6、delegation 11、reliability 3、acceptance 2、hierarchy 2、cost 2、terminate 1、tui 1。

判别规则（表驱动，不许拍脑袋）：

| 夹具用法 | 判 | 处理 |
|---|---|---|
| `await delegate(...)` 只为了「先让库里有个任务/有次上报」，后续断言与 delegation 无关 | **夹具** | 换成 `scripts/` 外的测试辅助函数 `seedTaskViaAssignPath()`，走 `assign_task` 真路径 |
| 断言 `isEmployeeBusy` / `describeStaff` 的返回值 | 实现测试 | 改断言为「任务状态文档里 status 是否为 doing」 |
| 断言 `delegation` 抛错文案 / `attempt` 编号 | 实现测试 | 删 |

**落地顺序不可颠倒**：①加夹具函数迁移 8 个文件 → ②跑绿 → ③再删。反过来会产生 8 处红，你会误以为是回归。

### A-2「`role` 是自由字符串，招『前端』静默退化成只读」

代码确认，且**能立刻复现**：

```
src/company/management-tools.ts:487   role: Type.String({ description: "员工角色：产品 / 设计 / 开发 / 测试 / 运营" })   // 无 enum
src/company/staff-tools.ts:39         const toolset = STAFF_TOOLSETS[role] ?? DEFAULT_TOOLSET;
src/company/staff-tools.ts:35         const DEFAULT_TOOLSET: StaffToolset = { read: true, write: false, bash: false };
```

**必须在删 `STAFF_TOOLSETS` 之前写，而且必须红**（四席里唯一「今天就复现得出」的 bug）：

```ts
// test/unit/staff-tools.test.ts（新增）
test("未知角色不得静默退化为只读", () => {
  const tools = toolsForRole("前端").map((t) => t.name);
  expect(tools).toContain("write");   // 现在红：DEFAULT_TOOLSET.write === false
});
```

**但要给「正确修法」留选择权**，两种都合格，测试要写成 accept-either：

```ts
test("未知角色要么给写权限，要么显式拒绝", () => {
  const outcome = tryToolsForRole("前端");           // 返回 {ok:true,tools} | {ok:false,reason}
  if (outcome.ok) expect(outcome.tools.map((t) => t.name)).toContain("write");
  else { expect(outcome.reason).toMatch(/未知角色/); }   // 招聘入口就报错，比静默只读好
});
```
配套（防「修了 tools 忘了 hire」）：`staff_hire` 若接受 `role:"前端"`，该员工 `my_capabilities` 必须含 `write` 或 `bash`。

### B-1「记忆系统从未跑过」（端到端）

机制（B 席只给数字没给机制）：`memory_write` 在 `src/company/capabilities.ts:70` 是 `core: false`，要靠 `tool_search` 加载；而 tokenizer 只切 ASCII（A 席）。中文公司搜不到 → 永不调用 → `app.memory` 0 条。**两个 bug 同一条因果链，不修 tokenizer 就修不出记忆。**

```ts
// test/e2e/memory-e2e.test.ts（新增）—— faux provider，不碰真模型
test("员工做完一次任务后，生产库应出现 app.memory 文档", async () => {
  await bootCompany(runtime);                 // 现有 test/e2e 的做法
  await assignAndCompleteTask(runtime);       // faux 剧本：员工执行 → task_report
  const mem = await runtime.harness.snapshot(MemoryDoc, BACKGROUND_CONTEXT);
  expect(mem?.entries?.length ?? 0).toBeGreaterThan(0);
});
```

**现在必红。** 「从未跑过」的模块不能靠删掉结案，只能靠让这条测试转绿结案；B 席的 `CapabilityRecipe` 若落地，这是它唯一有效的验收门。中间态用 `test.fails("记忆写入闭环（ADR-0xx 未实现，转绿即删 .fails）")` —— 实现完成那天它会**意外通过而变红**，强制有人回来删标记。比 `test.skip` 强一个量级。

### B-2「折叠器反复折 distill」（防止修 bug 时被测试拦）

```
src/domain/memory.ts:125   已有的 distill 条目也会被再次折进去——否则反复折叠会留下一堆总结。
test/unit/domain-memory.test.ts:95   test("反复折叠不会堆出一堆总结（旧总结也被再折一次）", () => {
test/unit/domain-memory.test.ts:105      expect(summaries).toHaveLength(1);
test/unit/domain-memory.test.ts:108      expect(summaries[0]?.folded).toBeGreaterThan(FOLD_BATCH);
```

`folded > FOLD_BATCH` 这一行**就是**在钉 bug：它要求「一条总结的 folded 计数是累加的」，而 B 席测得 200 条写入后代数 153。修 bug 时这条**必然红**，而它不该拦。

→ 修 bug 的 PR 必须**在同一个 PR 里**把这条改成：

```ts
// 行为断言：折叠代数有界
test("折叠代数是有限的（不去折 distill）", () => {
  let s = seed(200);
  s = compactMemory(s);
  const maxDepth = Math.max(...s.entries.map(e => e.depth ?? 0));  // depth 需新增
  expect(maxDepth).toBeLessThanOrEqual(3);
});
```
这是「哪些红不该拦」的标准答案：**不是忽略红，是把钉实现的断言换成钉行为的断言。**

### C-1「`unanswered` 静默死亡」

代码确认，两处同步路径**有**检查，异步投递路径**没有**：

```
src/company/delegation.ts:221   if (settled.status === "unanswered") {   ← 同步路径检查
src/company/roundtable.ts:694   if (settled.status === "unanswered") ...  ← 同步路径检查
src/company/deliver.ts:146      delivered.push(target);                  ← 只 push，从不等 wait()、从不看 status
src/company/watchdog.ts:684     if (submission.status !== "queued") continue;  ← 只扫 queued
```

`deliver()` 的 `catch` 会写 stderr（`deliver.ts:152-157`），但 `unanswered` 不是异常，是**正常返回的状态**，所以连日志都没有。

```ts
// test/e2e/deliver-unanswered.test.ts（新增）—— 不依赖真实模型
test("投递落到 unanswered 时必须被 Liveness 看见并重投", async () => {
  // 1. 造 no_model：只注册 catalog 不注册 provider（models.ts 已注释过这条坑）
  const runtime = await openCompany({ models: emptyModels(), registry }, BACKGROUND_CONTEXT);
  // 2. 直接调 deliver，目标是一个没有可用模型的会话
  const outcome = await deliver(runtime, { channel, message, targets: [target] }, BACKGROUND_CONTEXT);
  expect(outcome.delivered).toContain(target);          // 现状：投递被记为成功 ← bug 入口
  // 3. 跑看门狗一轮
  const alerts = await watchdogSweep(runtime, BACKGROUND_CONTEXT);
  expect(alerts.some(a => a.reason === "delivery-unanswered")).toBe(true);
  // 4. 断言真重投：该会话出现第二条 input submission
  expect(await countingSubmissions(runtime, target)).toBeGreaterThanOrEqual(2);
});
```
**现在红在第 3 步。** 第 2 步断言 `delivered` 含 target 是**故意写成现状**——它是「投递成功被当成已读」的最小复现。比测试更强的是类型强制：`deliver` 必须能表达三态而不是两态：

```ts
type DeliverOutcome = { delivered: number[]; failed: number[]; unanswered: number[] };
```

### C-2「升级链与看门狗用两套 owner 算法」

代码确认，两套算法的输入都不一样：

| 机制 | 判定 owner 的依据 | 位置 |
|---|---|---|
| 待决项（pending） | `item.decisionOwner ?? item.level` | `src/company/escalation.ts:668` |
| 看门狗超时升级 | `org.people[].managerId`（组织树父子） | `src/company/watchdog.ts:449-452` |

```ts
// test/unit/owner-singularity.test.ts（新增）
test("同一个问题在任意时刻只有一个 owner", async () => {
  // 构造：一个 pending item + 一条超时的 question 消息，指向同一个人
  const pendingOwner = decisionOwnerOfItem(pendingItem);
  const alert = (await watchdogSweep(runtime, ctx)).find(a => a.reason === "question-unanswered");
  const alertOwner = alert.conversationId;
  expect(alertOwner).toBe(pendingOwner);   // 或：必须存在于同一个 notifier 映射里
});

test("owner 判定只有一个真相源", () => {
  // 静态断言：src/ 里出现 owner 判定的地方只允许 1 个文件导出
  expect(filesExporting(/function .*[oO]wner(Of|For)/)).toHaveLength(1);
});
```
第二条是「契约级」断言，比第一条便宜、比第一条耐用。**现在两条都会红。**

### D-1「5 个接口零消费者」→ 需要**持续**检查，不是一次性 grep

现状（`grep -n 'pattern: "/api' src/server/http.ts`）：`/api/pending`(332)、`/api/feed/:conversationId`(354)、`/api/stream/feed/:conversationId`(410)、`/api/interrupt`(424)、`/api/upload`。注意 **`ui/dist/app.js` 会污染 grep**（bundle 大量命中）。

放哪里：**`scripts/check-boundaries.mjs`**，不是 `test/`。理由三条：

1. 纯静态检查（零运行时/零 SQLite/零 tmpdir），塞进 `test/` 只是让 `npm test` 多 fork 一个进程。
2. `check-boundaries.mjs` 已挂在 `npm run check` 上（`check` = `tsc --noEmit && node scripts/check-boundaries.mjs`），**改完代码必跑**；`npm test` 常被跳过。
3. 它要读全仓源码文本（`ui/js/**`、`src/tui/**`），这是 boundary checker 的天然职责。

```js
// scripts/check-boundaries.mjs 追加
const ROUTE_ALLOW_UNCONSUMED = new Set([
  "POST /api/interrupt",   // TUI 用，且未来给「停止」按钮
]);
const consumers = [
  readAll("ui/js"),        // 注意：必须读 ui/js，不是 ui/dist（dist 是 bundle，会假绿）
  readAll("src/tui"),
  readAll("scripts"),
].join("\n");
// 路由表在 src/server/http.ts:327 起，字段名是 `pattern`（不是 path），表驱动读，别手抄
for (const route of routesFrom("src/server/http.ts")) {
  const key = `${route.method ?? "*"} ${route.pattern}`;
  if (ROUTE_ALLOW_UNCONSUMED.has(key)) continue;
  const literal = route.pattern.replace(/\/:[^/]+/g, "");         // /api/feed/:id → /api/feed
  if (!consumers.includes(literal)) fail(`路由无人消费: ${key}`);
}
```
配套（否则白名单无限膨胀）：条目必须注释「谁在消费/什么时候删」，超过 3 条要在 review 里解释。反向也成立：D 席若删掉 `ui/js` 里的轮询代码，这条检查立刻红「有路由没人用」。

### D-2「mock 数据必须带可见标记」

现有实现**已经满足**（见 §0.3），所以这条的验收不是「加标记」，是「**禁止无标记的 mock**」的持续断言：

```js
// scripts/check-boundaries.mjs
// 任何返回 mock 的函数，返回值对象里必须含 mocked: true
for (const fn of functionsNamedLike(/mock/i, ["ui/js", "src/server"])) {
  if (returnsObjectWithout(fn, "mocked")) fail(`${fn.file}:${fn.line} mock 数据缺少 mocked:true`);
}
```
再加一条运行时断言（真浏览器，放 `scripts/ui-check.mjs`）：后端故意 500 → 看板必须同时出现错误文案与可见的 `[data-mock="true"]`。`board.js:421` 已有 `el.source.dataset.mock`。

---

## 3. 770 个 case 里，哪些红是「钉实现」——三组实测

判据见 §1。下面三组是我实际 grep 到的，**其余 26 个含 `escalat` 的文件请用同一口径逐个过**（预算内只抽了三组）。

| 组 | 位置 | 它断言了什么 | 判定 |
|---|---|---|---|
| **G1 记忆折叠** | `test/unit/domain-memory.test.ts:95-108` | `expect(summaries).toHaveLength(1)` + `expect(summaries[0]?.folded).toBeGreaterThan(FOLD_BATCH)` | **实现测试**。它钉的是「 distill 被再折」这个 bug 的副产物：`folded` 累加计数是内部编号。B 席修折叠器时必红，且不该拦 |
| **G2 派活夹具** | `test/e2e/delegation.test.ts:11`、`test/e2e/trail.test.ts:12`（6 次调用）、`test/e2e/reliability.test.ts:23`（3 次） | import `delegate`/`isEmployeeBusy`/`describeStaff` 作为状态构造器与断言对象 | **混合**。`delegate()` 调用是**夹具**（换掉即可）；`isEmployeeBusy`/`describeStaff` 是**实现测试**（内部函数名进了断言） |
| **G3 升级告警形状** | `src/company/watchdog.ts:451-459` 定义了 `taskId: "ch:<id>:<seq>"`、`action: "escalate-question"`、`reason: "question-unanswered"`；对应断言散落在 26 个含 `escalat` 的测试文件里 | 断言 alert 的字段字面量与 `taskId` 拼装格式 | **实现测试**。`taskId` 的拼装格式是内部编号；行为是「超时的问题被升级给上一级」，与字符串长什么样无关。C 席塌缩成 3 原语时这一批必红 |

反向例子（**行为测试，重构中不该动、红了要立刻查）**：
- `test/unit/routes.test.ts`：测的是**匹配语义**（文件头注释第 4-6 行自陈：「刻意测匹配语义而不是某个端点返回什么」），`/api/models/` 与 `/api/models` 等价（`test/unit/routes.test.ts:48`）。删任何 handler 它都不该红——合格的契约层。
- `test/contract/runtime.test.ts`：**只有 1 个文件**。A/B/C 三席都在动运行时语义（记忆折叠、投递状态、owner 判定），contract 层却只有 1 个文件覆盖。这是全仓最大的覆盖缺口，比 770 个 case 的数量更值得关注。

**操作规则（写进 `AGENTS.md` §3.2）**：一次重构让 N 个测试变红，PR 必须逐个列出「实现测试 / 行为测试」；实现测试**在同一个 PR 里改成行为断言**，不许 `skip`、不许 `-t` 排除。

---

## 4. `real-model.test.ts` 的静默 skip：让它不可能被忽略

现状（`test/e2e/real-model.test.ts:29-31`）：

```ts
const probe = await probeLocalGateway({ timeoutMs: 10_000 }).catch(() => ({ ok: false, detail: "不可用" }));
describe.skipIf(!probe.ok)("真实模型端到端", () => { ... });
```
`vitest` 的 skip 在汇总里只是 `3 skipped`，混在 `Tests 7xx passed` 里没有视觉权重。文件头注释（19-27 行）已经记过一次同类教训（2_000ms 探测→随机 skip），结论是「调大超时」——**治症状**。

**三层方案，缺一层都还会漏。第 1 层（默认失败）**：反转默认值 —— skip 必须是**显式退出**。

```ts
const SKIP = process.env.SKIP_REAL_MODEL === "1";
test.skipIf(SKIP)("真实模型可用性前置", async () => {
  const probe = await probeLocalGateway({ timeoutMs: 10_000 });
  if (!probe.ok) throw new Error(`真实模型不可用：${probe.detail}；不想跑必须显式设 SKIP_REAL_MODEL=1`);
});
```
忘记跑真模型 = 红；不想跑 = 必须在命令里写明。

**第 2 层（收据）**：`numPendingTests > 0` 即失败。

```bash
# package.json
"test:json": "vitest --run --reporter=json --outputFile=.taste/vitest.json",
"verify":   "npm run check && npm run test:json && node scripts/verify-receipt.mjs && npm run ui:build"
```
```js
// scripts/verify-receipt.mjs
const r = JSON.parse(read(".taste/vitest.json"));
if (r.numPendingTests > 0 && process.env.SKIP_REAL_MODEL !== "1")
  fail(`${r.numPendingTests} 个测试被跳过，且没有 SKIP_REAL_MODEL=1 授权`);
write(".taste/receipt.json", { at: Date.now(), pending: r.numPendingTests,
  realModelRan: Number(process.env.SKIP_REAL_MODEL !== "1"), git: headSha() });
```

**第 3 层（新鲜度门）**：`ui-check`、验收剧本这类「必须真跑过」的结论，只认 24 小时内、同一 commit 的收据：`node scripts/verify-receipt.mjs --require-real-model --max-age=86400`。该脚本目前不存在 → **这个仓库取不到任何一次「全绿」的证据**。这条本身就是 §0.1 的落地。

**反例**：加 `console.log("skipping real model")`。日志被 `| tail -5` 截断时它就消失。**不可忽略 = 机器可判定，不是人可阅读。**

---

## 5. 「小恐龙游戏」验收剧本（老板自测用）

老板原话（转述）：**「快速做一个 chrome 离线的精简的小恐龙游戏」**，中途插入**「需要音效」**。

### 5.1 六步机制 + 观察手段 + 通过判据

| 步 | 机制 | 观察手段（具体到文档/接口/事件） | 通过判据 |
|---|---|---|---|
| 1 立项 | `project_create` → `ProjectDoc`；建 `project:<slug>` 频道 | `sqlite3 workspace/company.sqlite "select kind,count(*) from docs group by kind"`（kind 枚举见 `grep -rn 'kind: "app\.' src/`）；`GET /api/channels` 里出现 `kind: "project"` | 存在 1 条 project 文档；出现 `project:<slug>` 频道且 `memberCount ≥ 2` |
| 2 配人 | `staff_hire` → `PersonDoc`；写入频道成员 | `GET /api/channels/:id` 的 `members[]` 含新员工 | 员工数与 project 文档 `staff` 列表一致；**role 能在 `STAFF_TOOLSETS` 命中**（否则 A-2 在此爆发：招「前端」只读，跑不动 `bash`） |
| 3 派活 | `assign_task` → `TaskDoc`；`deliver()` 投递；员工提交 `app.channel` 条目 | 任务文档 status `todo→doing`；频道里出现 `kind: "task"`，`refs.taskId` 指该任务 | 任务 status = `doing`；**且**目标会话的 submissions 里有一条 `status` 不是 `unanswered`（C-1 的判据，此处最容易死） |
| 4 改需求「加音效」 | **预测断点在此**：`dependsOn` 字段存在但 `task_update` 不接受 | `grep -n "dependsOn" src/domain/tasks.ts` → 63/154/198/232（字段与校验都在）；`grep -n "task_update" src/company/management-tools.ts` 看参数表 | 期望：能在原任务上追加验收项，`dependsOn` 增加一条。**现状：只能 `task_cancel` + 新建**，导致 trail 断裂（旧任务挂在 cancelled，新任务没有历史） |
| 5 验收 | `task_report` → `kind: "report"` 消息 + 任务 `done`；`usage` 记账 | 频道里 `kind === "report" && refs.taskId === <id>`；`rollupAll(runtime)`（`src/company/cost.ts`）的 `totalTokens` 相比步骤 3 前**严格增长** | report 存在；任务 `done`；`totalTokens` 增量 > 0；workspace 目录里存在可运行的 `index.html`（`ls workspace/projects/<slug>`） |
| 6 成本 | usage 文档 → `rollupAll` | 同步骤 5；ADR-003：**只从用量文档取，不求和历史消息**（分叉会话重复计账） | 每个员工 `usage.totalTokens > 0`；有 0 即有员工从未被唤醒（死在 C-1） |

### 5.2 断点预测（按可能性排序，全部来自代码事实）

1. **步骤 4 必卡**（`dependsOn` 死字段）。这是剧本的核心考点。老板说「要音效」时若 agent 选择「取消重建」，验收应判**不合格**——历史断了，答不出「音效是第几次改动加的」。
2. **步骤 3 可能静默死亡**（C-1）。判据必须查 submissions 的 `status`，不能只看任务变 `doing`——两个信号会背离。
3. **步骤 2 配人 → 步骤 5 跑不动**（A-2：招「前端」只读 → 写不了 `index.html`）。症状是「任务 done 但目录空」。
4. **步骤 6 成本为 0**：某员工 usage=0 而任务 done，说明上报是假的（`src/company/delegation.ts:13` 注释已记过同类事故）。

### 5.3 剧本的可执行形态

剧本应**固化为 e2e**，不是人肉清单：

```ts
// test/e2e/acceptance-dino.test.ts
test("老板剧本：立项→配人→派活→改需求→验收", async () => {
  await sendBossMessage("快速做一个 chrome 离线的精简的小恐龙游戏");
  expect(await projectCount()).toBe(1);
  expect(await staffWith(r => r.role === "开发")).toHaveLength(1);
  const task = await latestTask();
  expect(await submissionStatusOf(task.assignee)).not.toBe("unanswered");   // C-1
  await sendBossMessage("需要音效");                                        // 步骤 4
  expect(await taskRevisions(task.id)).toBeGreaterThan(1);                  // 现在必红
  expect(await readReport(task.id)).toMatchObject({ kind: "report" });
  expect((await rollupAll(runtime)).totalTokens).toBeGreaterThan(0);
});
```
四席任何一条修复，都必须让这个剧本的**某一行**由红转绿——这是本席对「可证伪」的全部要求。

---

## 6. 我的反对票

### 反对票 1：D 席「mock 静默显示假任务」—— **事实错**

`ui/js/board.js:129` 有 `mocked: true`；`ui/js/board.js:420-422` 渲染成可见 badge（`el.source.textContent = board.mocked ? "示例数据" : ""`，`el.source.hidden = !board.mocked`）；`ui/js/board.js:487-489` 还弹 `showError("...下面是契约示例数据")`。**不静默。**

真问题 D 席没提，有两条：
- mock 是硬编码常量，后端恢复后不自动重取；
- `catch` 里 `applyBoard(mockBoard())` **覆盖**上一份真实数据，而 `board.js:490` 另一分支说「保持上一次的数据」——同一个 catch 两种策略，自相矛盾。

### 反对票 2：A 席的**方法论**错（结论可能对）

见 §A-1。`grep deps.delegate` 零命中只证明「dep 无人消费」，不证明「`delegation.ts` 无人调用」——`src/company/org.ts:242` 仍在调 `delegate()`。这次侥幸对，因为那个闭包恰好也死了。**下次用同一手法删 `src/company/tools/dispatch.ts`，会真把派活删掉，而所有断言全绿（夹具走的是 `delegate()`）。**

### 反对票 3：整圆桌的**目标函数**错

四席 KPI 都是**减行数**（A −370 / B +160 / C −81% / D 14775→11000）。但行数不是本仓库的约束，**可观测性**才是。770 个 case 里唯一不可再生的资产是「哪些断言描述了真实行为」——§3 的 G1/G3 恰恰在**保护 bug**。理由三条（不是「风险大」，是「优化了错的量」）：

1. **第一件事应是 `scripts/verify-receipt.mjs` + 反转 real-model skip 默认值**（~60 行），收益是后续所有删除可回滚。现在没有。
2. **不该重写**。C 席的 3 原语方向我同意，但必须**先让 `deliver()` 三态可表达**（~10 行），再塌缩 8123 行。顺序反了，塌缩中产生的静默丢消息**现有测试发现不了**（全绿）。
3. **A-2 是四份意见里唯一的真 bug，也是唯一「今天就能写红」的断言**，优先级应高于所有删除项——它正在生产上制造只读员工。

### 我唯一同意的「删」

`test/unit/domain-memory.test.ts:105-108` 的两条断言必须改（不是删文件）——它们保护 bug。这是本席唯一主张「现在就动手」的动作。

---

## 附：本席的 10 条只读命令（可复跑）

```bash
grep -rn "deps\.delegate" src/                                   # 0 命中
grep -n  "readonly delegate" src/company/management-tools.ts      # 91
grep -n  "delegate: async" src/company/org.ts                     # 242
grep -rn 'from "../../src/company/delegation' test/                # 8 文件
grep -rc "delegate(" test/e2e/*.ts test/unit/*.ts | grep -v ":0"  # 调用次数
grep -n  "STAFF_TOOLSETS\|DEFAULT_TOOLSET" src/company/staff-tools.ts  # 20/35/39
grep -n  "unanswered" src/company/delegation.ts src/company/roundtable.ts  # 221/694
grep -n  'status !== "queued"' src/company/watchdog.ts            # 684
grep -rln "escalat" test/ | wc -l                                 # 26
ls .github/workflows                                              # exit 1（无 CI）
```
