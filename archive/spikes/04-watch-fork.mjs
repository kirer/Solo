// 验证「老板实时查看 + 与任何员工分叉沟通」：watch 拿结构化视图、watchTaskGraph 看全员在跑什么、
// fork 任意会话的任意 entry 单独聊。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, defineDoc, defineExtension, defineTask, defineTool, Harness, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const ctx = BACKGROUND_CONTEXT;
const dir = await mkdtemp(join(tmpdir(),"aico4-"));
const Org = defineDoc({ kind:"app.org", version:1, scope:"session", history:"latest", fork:"initial",
  initial:()=>({ employees:{} }), checkpointWhen:()=>false });
const Employee = defineExtension({ name:"role-employee", sections:[section("role",()=>"你是员工。")] });
const Anchor = defineTask({ name:"app.anchor", version:1, initial:()=>({phase:"done"}),
  phases:{ done: async (_t,r,c)=>r.commit(()=>({status:"terminal",outcome:{status:"completed",result:null}}),c) },
  abort: async (_t,r,c)=>r.commit(()=>({status:"terminal",outcome:{status:"aborted"}}),c) });
const Hire = defineTool({ name:"hire", description:"hire", parameters: Type.Object({ name:Type.String() }), replay:"safe",
  execute: async (a, api, c) => {
    const id = await api.commit(async (tx) => {
      const org = await tx.doc(Org);
      if (org.employees[a.name]) return org.employees[a.name];
      const anchor = await tx.createTask(Anchor, null, { ownership:{kind:"conversation"}, background:true });
      const child = await tx.createConversation({ ownership:{kind:"task", taskId:anchor} });
      await configure(tx, child.id, { extensions:[Employee], instructions:`你是员工 ${a.name}` });
      org.employees[a.name] = child.id;
      return child.id;
    }, c);
    return { output:[{type:"text",text:`hired ${id}`}] };
  }});
const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
const registry = createRegistry();
const Mgmt = defineExtension({ name:"mgmt", tools:[Hire] });
registry.install(Mgmt);
registry.install(defineExtension({ name:"roles", tasks:[Anchor] }));
registry.install(Employee);
const harness = await Harness.open(await openNodeSqliteStorage(join(dir,"c.sqlite")), { models, registry }, ctx);
const ceo = await harness.root(ctx, { agent:{ model:{provider:"faux",modelId:"faux-1"},
  extensions:[Mgmt] } });

faux.setResponses([ fauxAssistantMessage([fauxToolCall("hire",{name:"dev-1"})],{stopReason:"toolUse"}), fauxAssistantMessage("hired.") ]);
await (await ceo.submit({type:"input",content:"招人"}, ctx)).wait(ctx);
const pg = await ceo.entries({ order:"ascending" }, 50, undefined, ctx);
console.log("ceo entries:", pg.items.map(e=>e.kind).join(","));
const org = await harness.snapshot(Org, undefined, ctx);
console.log("org:", JSON.stringify(org));
const tr = pg.items.find(e=>e.kind==="pi.tool-result");
console.log("tool-result:", JSON.stringify(tr?.model ?? null).slice(0,400));
const empId = org.employees["dev-1"];
const emp = await harness.conversation(empId, ctx);

// ① 老板 watch 员工会话：拿结构化视图 + 实时帧
const watch = await emp.watch(ctx);
console.log("watch 初始:", Object.keys(watch.value), "entries=", watch.value.entries.length,
  "docs=", Object.keys(watch.value.docs).join(","));
const frames = [];
watch.start((value, ops) => { frames.push({ entries: value.entries.length, live: Object.keys(value.docs["pi.live"] ?? {}).length }); });

faux.setResponses([ fauxAssistantMessage("员工回答：登录模块完成，但缺测试。") ]);
await (await emp.submit({type:"input",content:"进度如何"}, ctx)).wait(ctx);
await new Promise(r=>setTimeout(r,120));
console.log("watch 收到帧数:", frames.length, JSON.stringify(frames));
await watch.stop();

// ② 老板分叉员工会话，单独问一句，不影响员工主线
const page = await emp.entries({ order:"ascending" }, 50, undefined, ctx);
const target = page.items.find(e=>e.kind==="pi.assistant");
const fork = await emp.fork(target.id, { ownership:{kind:"ownerless"} }, ctx);
faux.setResponses([ fauxAssistantMessage("私下问：那个测试谁补？员工答：我自己补。") ]);
const fr = await (await fork.submit({type:"input",content:"私下问一句"}, ctx)).wait(ctx);
console.log("分叉:", fork.id, fr.status);
const empAfter = await emp.entries({ order:"ascending" }, 50, undefined, ctx);
console.log("员工主线 entries 未被污染:", empAfter.items.length === page.items.length, `(${empAfter.items.length} vs ${page.items.length})`);

// ③ 老板看全员在跑什么
const graph = await harness.watchTaskGraph(ctx);
console.log("task graph:", Object.keys(graph.value.tasks).length, "nodes");
await graph.stop();

// ④ 归档/软删：durable 没有删除 API，用 document 标记
const Archive = defineDoc({ kind:"app.archive", version:1, scope:"session", history:"latest", fork:"initial",
  initial:()=>({ conversations: [] }), checkpointWhen:()=>false });
await ceo.commit(async (tx)=>{ (await tx.doc(Archive)).conversations.push(empId); }, ctx);
console.log("软删标记:", JSON.stringify(await harness.snapshot(Archive, ctx)));

await harness.close(ctx);
await rm(dir,{recursive:true,force:true});
