// 验证 ① watchDoc ② 显式 extensions 数组真的能剥掉管理工具 ③ beforeRequest 软提醒
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, MemoryStorage, hook, GenerationTask, section } from "@earendil-works/pi-durable";

const ctx = BACKGROUND_CONTEXT;
const Budget = defineDoc({ kind:"app.budget", version:1, scope:"conversation", history:"latest", fork:"initial",
  initial:()=>({ limitUsd: 1, spentUsd: 0 }), checkpointWhen:()=>false });

const mgmtTool = defineTool({ name:"hire", description:"hire", parameters: Type.Object({}), execute: async()=>({ output:[{type:"text",text:"ok"}] }) });
const Mgmt = defineExtension({ name:"mgmt", tools:[mgmtTool] });
const Emp = defineExtension({ name:"role-employee", sections:[section("role",()=>"你是员工。")] });

const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
const registry = createRegistry(); registry.install(Mgmt); registry.install(Emp);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
const root = await harness.root(ctx, { agent:{ model:{provider:"faux",modelId:"faux-1"} } });

const emp = await harness.createConversation({ ownership:{kind:"ownerless"},
  agent:{ extensions:[Emp] } }, ctx);            // 显式数组：只要 Emp，不要 Mgmt
const mgr = await harness.createConversation({ ownership:{kind:"ownerless"},
  agent:{ extensions:[Mgmt, Emp] } }, ctx);

const empAgent = await emp.agent(ctx);
const mgrAgent = await mgr.agent(ctx);
console.log("员工可见工具:", JSON.stringify(empAgent.tools?.map(t=>t.name) ?? []));
console.log("管理层可见工具:", JSON.stringify(mgrAgent.tools?.map(t=>t.name) ?? []));

// watchDoc：注意只有 tx.doc() 会创建文档，watch/snapshot 对不存在的文档返回 undefined
const w0 = await harness.watchDoc(Budget, emp.id, ctx);
console.log("未创建时 watchDoc:", w0 === undefined ? "undefined（符合预期）" : "有值");
await emp.commit(async (tx)=>{ await tx.doc(Budget, emp.id); }, ctx);
const w = await harness.watchDoc(Budget, emp.id, ctx);
console.log("watchDoc 初值:", JSON.stringify(w.value));
w.start(() => {});   // 注意：start() 之前 watch.value 冻结在获取时那一版
await emp.commit(async (tx)=>{ (await tx.doc(Budget, emp.id)).spentUsd = 0.5; }, ctx);
await new Promise(r=>setTimeout(r,50));
console.log("watchDoc 更新后:", JSON.stringify(w.value));
await w.stop();

// beforeRequest 软提醒：超预算时替换 messages
const Guard = defineExtension({
  name:"budget-guard",
  hooks:[ hook(GenerationTask, {
    beforeRequest: async (_req, api, c) => {
      const b = await api.snapshot(Budget, api.conversationId, c);
      if (b === undefined || b.spentUsd < b.limitUsd) return undefined;
      return { messages: [{ role:"user", content:"[budget guard] 超预算，只回复 BUDGET EXCEEDED。", timestamp: Date.now() }] };
    },
  })],
});
registry.install(Guard);
const guarded = await harness.createConversation({ ownership:{kind:"ownerless"},
  agent:{ model:{provider:"faux",modelId:"faux-1"}, extensions:[Emp, Guard] } }, ctx);
await guarded.commit(async (tx)=>{ (await tx.doc(Budget, guarded.id)).spentUsd = 2; }, ctx);
faux.setResponses([ fauxAssistantMessage("BUDGET EXCEEDED") ]);
const s = await (await guarded.submit({type:"input",content:"真实问题"}, ctx)).wait(ctx);
console.log("settled:", JSON.stringify(s));
const page = await guarded.entries({ order:"ascending" }, 20, undefined, ctx);
console.log("软提醒结果:", s.status, "最后一条 assistant:", JSON.stringify(page.items.filter(e=>e.kind==="pi.assistant").at(-1)?.model?.[0]?.content ?? null));
await harness.close(ctx);
