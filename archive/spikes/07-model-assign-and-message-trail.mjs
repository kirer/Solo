// 验证 ① 角色可分配不同模型 ② 员工间消息用自定义 entry 落库可跨会话追溯
// ③ 按阶段/按消息粒度拆 token（从 entries 的 usage 字段逐条求和）
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, defineDoc, defineEntry, defineExtension, defineTask, defineTool, Harness, MemoryStorage, AssistantEntry } from "@earendil-works/pi-durable";

const ctx = BACKGROUND_CONTEXT;

// 自定义 entry：所有「谁对谁说了什么」都落成不可变 entry，跨会话可追溯
const MessageEntry = defineEntry("app.message");

const Org = defineDoc({ kind:"app.org", version:1, scope:"session", initial:()=>({ staff:{} }), checkpointWhen:()=>false });
const Anchor = defineTask({ name:"app.anchor", version:1, initial:()=>({phase:"done"}),
  phases:{ done: async (_t,r,c)=>r.commit(()=>({status:"terminal",outcome:{status:"completed",result:null}}),c) },
  abort: async (_t,r,c)=>r.commit(()=>({status:"terminal",outcome:{status:"aborted"}}),c) });

// CHRO 招聘时按员工能力分配模型
const Hire = defineTool({ name:"hire", description:"招聘并按需分配模型",
  parameters: Type.Object({ name:Type.String(), model:Type.String() }), replay:"safe",
  execute: async (a, api, c) => {
    const id = await api.commit(async (tx) => {
      const org = await tx.doc(Org);
      if (org.staff[a.name]) return org.staff[a.name];
      const anchor = await tx.createTask(Anchor, null, { ownership:{kind:"conversation"}, background:true });
      const child = await tx.createConversation({ ownership:{kind:"task", taskId:anchor} });
      await configure(tx, child.id, {
        model: { provider:"faux", modelId: a.model },       // ← 按员工分配模型
        instructions: `你是 ${a.name}。`,
      });
      org.staff[a.name] = child.id;
      // 招聘这件事本身也留痕
      await tx.appendEntry(api.conversationId, { kind:"app.message",
        data: { at: Date.now(), from:"CHRO", to:a.name, type:"hire", model:a.model } });
      return child.id;
    }, c);
    return { output:[{type:"text",text:`hired ${a.name} -> ${id}`}] };
  }});

// 员工之间/向上汇报：双方会话各写一条 message entry（双向留痕）
const Tell = defineTool({ name:"tell", description:"对某人说一句话",
  parameters: Type.Object({ to:Type.String(), text:Type.String() }), replay:"safe",
  execute: async (a, api, c) => {
    const org = await api.snapshot(Org, c);
    const targetId = org.staff[a.to];
    await api.commit(async (tx) => {
      await tx.appendEntry(api.conversationId, { kind:"app.message",
        data:{ at:Date.now(), from:"self", to:a.to, type:"tell", text:a.text } });
      await tx.appendEntry(targetId, { kind:"app.message",
        data:{ at:Date.now(), from:"peer", to:a.to, type:"tell", text:a.text } });
    }, c);
    return { output:[{type:"text",text:"sent"}] };
  }});

const models = createModels();
const faux = fauxProvider({ models: [{ id:"faux-1" }, { id:"cheap-1" }, { id:"strong-1" }] });
models.setProvider(faux.provider);
const registry = createRegistry();
const Mgmt = defineExtension({ name:"mgmt", tools:[Hire, Tell] });
registry.install(Mgmt);
registry.install(defineExtension({ name:"tasks", tasks:[Anchor] }));
const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
const chro = await harness.root(ctx, { agent:{ model:{provider:"faux",modelId:"faux-1"},
  extensions:[Mgmt] } });

// 招两个员工，一个用便宜模型一个用强模型
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("hire",{name:"dev-1",model:"cheap-1"})],{stopReason:"toolUse"}),
  fauxAssistantMessage([fauxToolCall("hire",{name:"dev-2",model:"strong-1"})],{stopReason:"toolUse"}),
  fauxAssistantMessage("两个都招好了"),
]);
await (await chro.submit({type:"input",content:"招两个开发"}, ctx)).wait(ctx);
const org = await harness.snapshot(Org, ctx);
console.log("员工模型分配:", JSON.stringify(org.staff));
const d1 = await harness.conversation(org.staff["dev-1"], ctx);
const d2 = await harness.conversation(org.staff["dev-2"], ctx);
console.log("dev-1 实际模型:", JSON.stringify((await d1.agent(ctx)).model));
console.log("dev-2 实际模型:", JSON.stringify((await d2.agent(ctx)).model));

// 员工互发消息
faux.setResponses([ fauxAssistantMessage([fauxToolCall("tell",{to:"dev-2",text:"登录接口我写好了"})],{stopReason:"toolUse"}),
  fauxAssistantMessage("已告知") ]);
const d1s = await (await d1.submit({type:"input",content:"告诉 dev-2 接口好了"}, ctx)).wait(ctx);
console.log("d1 submit:", JSON.stringify(d1s));
const d1page = await d1.entries({ order:"ascending" }, 50, undefined, ctx);
for (const e of d1page.items) console.log("  d1 entry", e.kind, JSON.stringify(e.data ?? null).slice(0,150));

// 跨会话追溯所有 message entry
const convs = await chro.commit((tx)=>tx.scanConversations({}, 50), ctx);
const trail = [];
for (const rec of convs.items) {
  const page = await chro.commit((tx)=>tx.scanEntries({ conversationId: rec.id, order:"ascending" }, 200), ctx);
  for (const e of page.items) if (e.kind === "app.message") trail.push({ conv: rec.id, ...e.data });
}
console.log("沟通留痕条数:", trail.length);
for (const t of trail) console.log("  ", JSON.stringify(t));

// 按消息粒度拆 token
for (const [name, id] of Object.entries(org.staff)) {
  const page = await harness.conversation(id, ctx).then(c=>c.entries({ order:"ascending" }, 100, undefined, ctx));
  let total = 0, perTurn = [];
  for (const e of page.items) {
    if (e.kind !== "pi.assistant") continue;
    const u = e.model?.[0]?.usage;
    if (!u) continue;
    total += u.totalTokens;
    perTurn.push({ at: e.model[0].timestamp, in: u.input, out: u.output, cacheRead: u.cacheRead, total: u.totalTokens, model: e.model[0].model });
  }
  console.log(`${name} 逐条 usage:`, JSON.stringify(perTurn), "合计", total);
}
await harness.close(ctx);
