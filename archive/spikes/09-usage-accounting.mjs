// 关键：fork 会话的 entries 含父历史，按 entry 求和会重复计账。正确做法是读每个会话的 pi.usage 文档。
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, UsageDoc } from "@earendil-works/pi-durable";

const ctx = BACKGROUND_CONTEXT;
const models = createModels(); const faux = fauxProvider(); models.setProvider(faux.provider);
const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
const root = await harness.root(ctx, { agent:{ model:{provider:"faux",modelId:"faux-1"} } });

faux.setResponses([ fauxAssistantMessage("父第1答") ]);
await (await root.submit({type:"input",content:"父问题1"}, ctx)).wait(ctx);
faux.setResponses([ fauxAssistantMessage("父第2答") ]);
await (await root.submit({type:"input",content:"父问题2"}, ctx)).wait(ctx);

const page = await root.entries({order:"ascending"},100,undefined,ctx);
const mid = page.items.find(e=>e.kind==="pi.assistant");
const branch = await root.fork(mid.id, { ownership:{kind:"ownerless"} }, ctx);
faux.setResponses([ fauxAssistantMessage("分支答") ]);
await (await branch.submit({type:"input",content:"分支问题"}, ctx)).wait(ctx);

const usage = (u) => Object.values(u?.models ?? {}).reduce((s,m)=>s+m.totalTokens,0);
const rootU = await harness.snapshot(UsageDoc, root.id, ctx);
const branchU = await harness.snapshot(UsageDoc, branch.id, ctx);
console.log("父会话 UsageDoc:", usage(rootU));
console.log("分支会话 UsageDoc:", usage(branchU), "← 从 0 开始计，不重复父的账");
console.log("两者相加:", usage(rootU)+usage(branchU), "= harness.usage() 全公司:", usage(await harness.usage(ctx)));

// 反例：按 entries 求和会重复
const sumEntries = async (conv) => {
  const p = await conv.entries({order:"ascending"},200,undefined,ctx);
  return p.items.filter(e=>e.kind==="pi.assistant").reduce((s,e)=>s+(e.model?.[0]?.usage?.totalTokens ?? 0),0);
};
console.log("反例：按 entries 求和 父:", await sumEntries(root), "分支:", await sumEntries(branch),
  "→ 分支里含父的 entry，相加会虚高");
await harness.close(ctx);
