// 验证 ① 会议 = task 多 phase + 并行子任务 + waiting 收齐 ② 等老板拍板 = sleepUntil（跨重启不占进程）
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const ctx = BACKGROUND_CONTEXT;
let clock = Date.now();
const now = () => clock;

const Minutes = defineDoc({ kind:"app.minutes", version:1, scope:"session", history:"latest", fork:"initial",
  initial:()=>({ records: [] }), checkpointWhen:()=>false });

// 单个高管的意见（子任务）
const Opinion = defineTask({
  name:"app.opinion", version:1,
  initial: (input) => ({ phase:"think" }),
  phases: {
    think: async (task, runtime, c) => {
      // 真实实现：runtime.conversation(roleConvId).submit(...)
      const verdict = task.input.role === "CFO" ? "太贵，建议缩到 2 人" : "可以做";
      await runtime.commit(() => ({ status:"terminal", outcome:{ status:"completed", result:{ role: task.input.role, verdict } } }), c);
    },
  },
  abort: async (_t, runtime, c) => runtime.commit(() => ({ status:"terminal", outcome:{ status:"aborted" } }), c),
});

// 会议：议程 → 并行收集意见 → CEO 决策 → 纪要
const Meeting = defineTask({
  name:"app.meeting", version:1,
  initial: () => ({ phase:"collect" }),
  phases: {
    collect: async (task, runtime, c) => {
      await runtime.commit(async (tx) => {
        const ids = [];
        for (const role of ["CTO","CFO","CPO"]) {
          ids.push(await tx.createTask(Opinion, { role }, { ownership:{ kind:"task", taskId: task.id } }));
        }
        return { status:"waiting", checkpoint:{ phase:"decide", opinions: ids }, on: ids, policy:"allSettled" };
      }, c);
    },
    decide: async (task, runtime, c) => {
      const outcomes = await runtime.outcomes(task.state.checkpoint.opinions, c);
      const verdicts = outcomes.map(o => o.status === "completed" ? o.result : { role:"?", verdict:"failed" });
      await runtime.commit(async (tx) => {
        (await tx.doc(Minutes)).records.push({ at: now(), verdicts });
        return { status:"terminal", outcome:{ status:"completed", result:{ verdicts } } };
      }, c);
    },
  },
  abort: async (_t, runtime, c) => runtime.commit(() => ({ status:"terminal", outcome:{ status:"aborted" } }), c),
});

// 等老板拍板：睡到 deadline，期间不占 invocation，重启后仍有效
const AskBoss = defineTask({
  name:"app.ask_boss", version:1,
  initial: () => ({ phase:"wait" }),
  phases: {
    wait: async (task, runtime, c) => {
      await runtime.sleepUntil(now() + task.input.ms, { phase:"collect" }, c);
    },
    collect: async (task, runtime, c) => {
      await runtime.commit(() => ({ status:"terminal", outcome:{ status:"completed", result:"老板已拍板" } }), c);
    },
  },
  abort: async (_t, runtime, c) => runtime.commit(() => ({ status:"terminal", outcome:{ status:"aborted" } }), c),
});

const models = createModels(); models.setProvider(fauxProvider().provider);
const registry = createRegistry();
registry.install(defineExtension({ name:"org", tasks:[Opinion, Meeting, AskBoss] }));
const harness = await Harness.open(new MemoryStorage(), { models, registry, now }, ctx);
const root = await harness.root(ctx, { agent:{ model:{provider:"faux",modelId:"faux-1"} } });

const meeting = await root.commit((tx) => tx.createTask(Meeting, null, { ownership:{kind:"conversation"} }), ctx);
harness.resume();
const settled = await harness.waitForTask(meeting, ctx);
console.log("会议结果:", JSON.stringify(settled));
console.log("纪要:", JSON.stringify(await harness.snapshot(Minutes, ctx)));

// 睡眠任务：时钟推进前不完成
const ask = await root.commit((tx) => tx.createTask(AskBoss, { ms: 60_000 }, { ownership:{kind:"conversation"} }), ctx);
await new Promise(r=>setTimeout(r,80));
const insp = await harness.inspect(ctx);
const askState = insp.tasks.find(t => t.record.id === ask);
console.log("等老板任务状态:", askState?.state.kind, "(sleeping = 不占进程)");
clock += 61_000;                      // 老板 61 秒后拍板
harness.wake();
const done = await harness.waitForTask(ask, ctx);
console.log("睡眠唤醒后:", JSON.stringify(done));
await harness.close(ctx);
