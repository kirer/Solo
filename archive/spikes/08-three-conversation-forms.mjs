// 验证「老板与员工对话」的三种形态，以及按角色/项目/阶段拆 token
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, defineDoc, defineExtension, defineTask, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const ctx = BACKGROUND_CONTEXT;
const Org = defineDoc({ kind:"app.org", version:1, scope:"session", initial:()=>({ staff:{} }), checkpointWhen:()=>false });
const Anchor = defineTask({ name:"app.anchor", version:1, initial:()=>({phase:"done"}),
  phases:{ done: async (_t,r,c)=>r.commit(()=>({status:"terminal",outcome:{status:"completed",result:null}}),c) },
  abort: async (_t,r,c)=>r.commit(()=>({status:"terminal",outcome:{status:"aborted"}}),c) });

const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(defineExtension({ name:"tasks", tasks:[Anchor] }));
const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
const root = await harness.root(ctx, { agent:{ model:{provider:"faux",modelId:"faux-1"} } });

// 造一个员工
const empId = await root.commit(async (tx) => {
  const org = await tx.doc(Org);
  const anchor = await tx.createTask(Anchor, null, { ownership:{kind:"conversation"}, background:true });
  const child = await tx.createConversation({ ownership:{kind:"task", taskId:anchor} });
  await configure(tx, child.id, { model:{provider:"faux",modelId:"faux-1"}, instructions:"你是 dev-1" });
  org.staff["dev-1"] = child.id;
  return child.id;
}, ctx);
const emp = await harness.conversation(empId, ctx);

faux.setResponses([ fauxAssistantMessage("员工第 1 答") ]);
await (await emp.submit({type:"input",content:"员工问题 1"}, ctx)).wait(ctx);

// ── 形态 A：直接对员工说（同一会话，插入对话主线） ──────────────────
faux.setResponses([ fauxAssistantMessage("老板直接问的回答（在主线上）") ]);
const a = await (await emp.submit({type:"input",content:"老板直接问一句"}, ctx)).wait(ctx);
const afterA = await emp.entries({order:"ascending"},100,undefined,ctx);
console.log("A 直接对话 → 主线 entries:", afterA.items.length, "状态:", a.status);

// ── 形态 B：fork 到某个 entry，开分支聊（不污染主线） ────────────────
const firstAnswer = afterA.items.find(e=>e.kind==="pi.assistant");
faux.setResponses([ fauxAssistantMessage("分支里的回答") ]);
const branch = await emp.fork(firstAnswer.id, { ownership:{kind:"ownerless"} }, ctx);
const b = await (await branch.submit({type:"input",content:"分支里问一句"}, ctx)).wait(ctx);
const afterB = await emp.entries({order:"ascending"},100,undefined,ctx);
const branchEntries = await branch.entries({order:"ascending"},100,undefined,ctx);
console.log("B fork → 主线仍是", afterB.items.length, "条；分支", branchEntries.items.length, "条；状态", b.status);

// ── 形态 C：新开一个独立会话，只带上下文摘要（完全隔离） ────────────
const side = await harness.createConversation({ ownership:{kind:"ownerless"},
  agent:{ model:{provider:"faux",modelId:"faux-1"},
    instructions:"你是老板的私人顾问，针对 dev-1 的进度给建议。" } }, ctx);
faux.setResponses([ fauxAssistantMessage("独立顾问的回答") ]);
const c = await (await side.submit({type:"input",content:"dev-1 的进度你怎么看"}, ctx)).wait(ctx);
const sideEntries = await side.entries({order:"ascending"},100,undefined,ctx);
console.log("C 独立会话 → entries:", sideEntries.items.length, "状态:", c.status);

// ── 按角色/项目/阶段拆 token ────────────────────────────────────────
async function usageOf(convId) {
  const page = await harness.conversation(convId, ctx).then(x=>x.entries({order:"ascending"},200,undefined,ctx));
  const rows = [];
  for (const e of page.items) {
    if (e.kind !== "pi.assistant") continue;
    const u = e.model?.[0]?.usage;
    if (!u) continue;
    rows.push({ entry: e.id, at: e.model[0].timestamp, model: e.model[0].model, total: u.totalTokens, cost: u.cost.total });
  }
  return rows;
}
console.log("员工会话逐条 token:", JSON.stringify(await usageOf(empId)));
console.log("分支会话逐条 token:", JSON.stringify(await usageOf(branch.id)));
console.log("独立会话逐条 token:", JSON.stringify(await usageOf(side.id)));

// 按会话汇总（= 按角色/按项目，因为一个角色/项目就是一个会话）
const convs = await root.commit((tx)=>tx.scanConversations({}, 50), ctx);
const byConv = {};
for (const rec of convs.items) {
  const rows = await usageOf(rec.id);
  if (rows.length) byConv[rec.id] = rows.reduce((s,r)=>s+r.total,0);
}
console.log("按会话汇总 token:", JSON.stringify(byConv));
await harness.close(ctx);
