// 验证「项目 = 工作空间文件夹」：env 按 conversationId 返回不同 cwd，员工真的在项目目录里读写。
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, defineDoc, defineExtension, defineTask, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const ctx = BACKGROUND_CONTEXT;
const base = await mkdtemp(join(tmpdir(), "aico3-"));
const projectDir = join(base, "projects", "alpha");
await mkdir(projectDir, { recursive: true });

const Workspace = defineDoc({ kind:"app.workspace", version:1, scope:"conversation", history:"latest",
  fork:"initial", initial:()=>({}), checkpointWhen:()=>false });

const Anchor = defineTask({ name:"app.anchor", version:1, initial:()=>({phase:"done"}),
  phases:{ done: async (_t,r,c)=>r.commit(()=>({status:"terminal",outcome:{status:"completed",result:null}}),c) },
  abort: async (_t,r,c)=>r.commit(()=>({status:"terminal",outcome:{status:"aborted"}}),c) });

const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(CodingTools);
registry.install(defineExtension({ name:"roles", tasks:[Anchor] }));

const harness = await Harness.open(new MemoryStorage(), {
  models, registry,
  env: async ({ conversationId, read }, envCtx) => {
    const ws = await read.snapshot(Workspace, conversationId, envCtx);
    return ws?.path === undefined ? undefined : new NodeExecutionEnv({ cwd: ws.path });
  },
}, ctx);

// 项目会话：把 workspace path 写进 document，env 就按它给 cwd
const project = await harness.createConversation({ ownership:{kind:"ownerless"},
  agent:{ model:{provider:"faux",modelId:"faux-1"}, extensions:[CodingTools], cwd: projectDir } }, ctx);
await project.commit(async (tx) => { (await tx.doc(Workspace, project.id)).path = projectDir; }, ctx);

const writeTool = CodingTools.tools.find(t=>t.name==="write");
console.log("coding tools:", CodingTools.tools.map(t=>t.name).join(","));

faux.setResponses([
  fauxAssistantMessage([fauxToolCall("write", { path: "README.md", content: "# Alpha 项目\n由员工写的。\n" })], { stopReason:"toolUse" }),
  fauxAssistantMessage("写好了"),
]);
const s = await (await project.submit({ type:"input", content:"在项目里建 README" }, ctx)).wait(ctx);
console.log("run:", s.status);
console.log("落盘文件内容:", JSON.stringify(await readFile(join(projectDir, "README.md"), "utf8")));
await harness.close(ctx);
await rm(base, { recursive:true, force:true });
