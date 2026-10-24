// 验证三件对方案最关键的事：① 员工会话独立记账并可聚合到项目 ② 后台员工不被老板 Esc 打断
// ③ SQLite 崩溃后重启，run 继续跑完。全部 faux provider。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
	configure, createRegistry, defineDoc, defineExtension, defineTask, defineTool,
	Harness, UsageDoc, section,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const ctx = BACKGROUND_CONTEXT;
const dir = await mkdtemp(join(tmpdir(), "aico2-"));
const db = join(dir, "company.sqlite");

const Org = defineDoc({ kind:"app.org", version:1, scope:"session", history:"latest", fork:"initial",
  initial:()=>({ projects:{}, employees:{} }), checkpointWhen:()=>false });

const Employee = defineExtension({ name:"role-employee",
  sections:[section("role", ()=> "你是项目员工。只做被指派的事。")] });
const Anchor = defineTask({ name:"app.anchor", version:1, initial:()=>({phase:"done"}),
  phases:{ done: async (_t,r,c)=>r.commit(()=>({status:"terminal",outcome:{status:"completed",result:null}}),c) },
  abort: async (_t,r,c)=>r.commit(()=>({status:"terminal",outcome:{status:"aborted"}}),c) });

// 慢工具：模拟长任务，用来验证重启恢复
const slow = defineTool({ name:"slow_work", description:"take a while",
  parameters: Type.Object({ ms: Type.Number() }), replay:"safe",
  execute: async (a) => { await new Promise(r=>setTimeout(r,a.ms)); return { output:[{type:"text",text:"slow done"}] }; } });

const Hire = defineTool({ name:"hire", description:"招聘项目员工",
  parameters: Type.Object({ project:Type.String(), name:Type.String(), cwd:Type.String() }), replay:"safe",
  execute: async (a, api, c) => {
    const id = await api.commit(async (tx) => {
      const org = await tx.doc(Org);
      const key = `${a.project}/${a.name}`;
      if (org.employees[key] !== undefined) return org.employees[key];
      const anchor = await tx.createTask(Anchor, null, { ownership:{kind:"conversation"}, background:true });
      const child = await tx.createConversation({ ownership:{kind:"task", taskId:anchor} });
      await configure(tx, child.id, { extensions:[Employee], instructions:`${a.project} 项目员工 ${a.name}`, cwd:a.cwd });
      org.employees[key] = child.id;
      org.projects[a.project] ??= [];
      org.projects[a.project].push(a.name);
      return child.id;
    }, c);
    return { output:[{type:"text",text:`hired -> ${id}`}] };
  }});

const Assign = defineTool({ name:"assign", description:"派活给员工并等答复",
  parameters: Type.Object({ project:Type.String(), name:Type.String(), task:Type.String() }), replay:"safe",
  execute: async (a, api, c) => {
    const org = await api.snapshot(Org, c);
    const childId = org.employees[`${a.project}/${a.name}`];
    const conv = await api.conversation(childId, c);
    await api.details({ conversationId: childId }, c);
    const s = await (await conv.submit({ type:"input", content:a.task, requestId:`assign:${api.taskId}` }, c)).wait(c);
    return { output:[{type:"text",text:`child ${s.status}`}] };
  }});

const Mgmt = defineExtension({ name:"mgmt", tools:[Hire, Assign, slow] });
const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(Mgmt);
registry.install(defineExtension({ name:"roles", tasks:[Anchor], sections:[] }));
registry.install(Employee);

const open = async () => Harness.open(await openNodeSqliteStorage(db), { models, registry }, ctx);

// ── 阶段 1：招聘 + 派活 + 独立记账 ─────────────────────────────────────────
let harness = await open();
const ceo = await harness.root(ctx, { agent:{ model:{provider:"faux",modelId:"faux-1"}, extensions:[Mgmt] } });
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("hire", { project:"alpha", name:"dev-1", cwd:dir })], { stopReason:"toolUse" }),
  fauxAssistantMessage("hired."),
  fauxAssistantMessage([fauxToolCall("assign", { project:"alpha", name:"dev-1", task:"实现登录" })], { stopReason:"toolUse" }),
  fauxAssistantMessage("员工回报：登录做完了。"),
  fauxAssistantMessage("parent done."),
]);
console.log("run1", (await (await ceo.submit({type:"input",content:"招人"}, ctx)).wait(ctx)).status);
console.log("run2", (await (await ceo.submit({type:"input",content:"派活"}, ctx)).wait(ctx)).status);

// 按项目聚合成本：scanConversations + UsageDoc
const org = await harness.snapshot(Org, undefined, ctx);
const projectCost = {};
const scan = await ceo.commit((tx) => tx.scanConversations({}, 100, undefined), ctx);
for (const rec of scan.items) {
  const u = await harness.snapshot(UsageDoc, rec.id, ctx);
  if (u === undefined) continue;
  const tokens = Object.values(u.models).reduce((s,m)=>s+m.totalTokens,0);
  if (tokens === 0) continue;
  console.log(`  conversation ${rec.id} tokens=${tokens}`);
}
const empId = org.employees["alpha/dev-1"];
const empUsage = await harness.snapshot(UsageDoc, empId, ctx);
console.log("员工会话独立 usage tokens:", Object.values(empUsage.models).reduce((s,m)=>s+m.totalTokens,0));
console.log("员工会话 id:", empId, "vs CEO 会话 id:", ceo.id);

// ── 阶段 2：后台员工不被老板 Esc 打断 ────────────────────────────────────
faux.setResponses([fauxAssistantMessage("员工回答被打断了吗"), fauxAssistantMessage("老板的新问题")]);
const empConv = await harness.conversation(empId, ctx);
const empSub = await empConv.submit({ type:"input", content:"长任务" }, ctx);
await ceo.abort(ctx);                       // 老板 Esc：只影响 CEO 会话
const empSettled = await empSub.wait(ctx);
console.log("老板 abort 后员工仍完成:", empSettled.status);

// ── 阶段 3：崩溃重启恢复 ────────────────────────────────────────────────
faux.setResponses([fauxAssistantMessage([fauxToolCall("slow_work", { ms: 800 })], { stopReason:"toolUse" }),
  fauxAssistantMessage("slow path done")]);
const sub = await ceo.submit({ type:"input", content:"跑慢任务", requestId:"job-slow" }, ctx);
await new Promise(r=>setTimeout(r,150));
await harness.close(ctx);                    // 相当于进程在工具跑到一半时退出
console.log("closed mid-run");

harness = await open();                      // 重开同一 SQLite
const inspect = await harness.inspect(ctx);
console.log("恢复前 live tasks:", inspect.tasks.map(t=>`${t.record.kind}/${t.state.kind}`).join(",") || "(none)");
harness.resume();
const root2 = await harness.root(ctx);
const again = await (await root2.submit({ type:"input", content:"跑慢任务", requestId:"job-slow" }, ctx)).wait(ctx);
console.log("重启后同一 requestId 恢复:", again.status, again.id === sub.id ? "(同一个 submission)" : "(新 submission)");

await harness.close(ctx);
await rm(dir, { recursive:true, force:true });
console.log("OK");
