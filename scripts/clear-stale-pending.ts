#!/usr/bin/env node
/**
 * 一次性运维脚本：以 CEO 身份关闭历史遗留的待决问题。
 *
 * 背景：老板被 6 条「待拍板」淹没，全部是 dino-runner 事故期间留下的，
 * 且都停在 CEO 这一级（不该出现在老板桌上）。这里逐条给出结论并关闭。
 *
 * 用法：node --experimental-strip-types scripts/clear-stale-pending.ts [--db 路径]
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "../src/runtime/index.ts";
import { createRegistry, openCompany, recover } from "../src/runtime/index.ts";
import { createEscalationTask, answerPendingAsCeo, listPending } from "../src/company/escalation.ts";

/** 每条历史待办的结论：key → 决定。 */
const DECISIONS: Record<string, string> = {
	"esc:19:1":
		"不追加投入。项目已按老板要求终止，不再评估商业价值；立项文档与 PLAN.md 保留备查。此类「做不做」的问题应由你（CEO）在授权范围内先给判断，不要直接丢给老板。",
	"esc:7:2":
		"已解决，无需开资源。执行器不可用的根因是工作空间相对路径被重复拼接（harness 侧 cwd 解析缺陷），已由平台侧修复：立项/启动一律落绝对路径，执行环境入口统一规整 cwd。员工 bash 已恢复。后续若再遇到同类问题，先查项目 workspace 是否为绝对路径。",
	"esc:1:3":
		"已解决。命令分发层并未拦截任何东西——报错是 cwd 拼重导致 access() 失败，所以任何命令（含 echo/cd）都跑不了。修复后已实测可执行，静态托管也已跑通。",
	"esc:7:4":
		"已修复。相对 cwd 会被 NodeExecutionEnv 再拼一次进程目录，最终路径重复；现在 createProject 用绝对路径，环境入口 normalizeCwd 兜底，历史数据启动时迁移。",
	"esc:19:5":
		"不删除。老板明确要求保留 dino-runner 的产物与档案，终止状态保持不变，不再执行彻底删除。",
	"esc:1:6":
		"驳回，不删除。老板要求保留项目与产物；路径校验问题已修复，但保留决定优先。后续如要删除需老板重新明确同意。",
};

const dbArg = process.argv.indexOf("--db");
const databasePath = dbArg >= 0 ? (process.argv[dbArg + 1] as string) : join(process.cwd(), "workspace", "company.sqlite");

const { setupModels } = await import("../src/runtime/index.ts");
const { models } = setupModels();
const registry = createRegistry();
const runtime = await openCompany({ databasePath, models, registry }, BACKGROUND_CONTEXT);
await recover(runtime, BACKGROUND_CONTEXT);
registry.install({ name: "escalation", tasks: [createEscalationTask(runtime)] } as never);

const pending = await listPending(runtime, BACKGROUND_CONTEXT);
let closed = 0;
for (const item of pending) {
	const decision = DECISIONS[item.key];
	if (decision === undefined) {
		process.stdout.write(`跳过 ${item.key}（level=${item.level}）：没有预设结论\n`);
		continue;
	}
	if (item.level !== "ceo") {
		process.stdout.write(`跳过 ${item.key}：level=${item.level}，不是 CEO 这一级\n`);
		continue;
	}
	const ok = await answerPendingAsCeo(runtime, { key: item.key, answer: decision }, BACKGROUND_CONTEXT);
	process.stdout.write(`${ok ? "已关闭" : "失败  "} ${item.key}\n`);
	if (ok) closed += 1;
}

const left = await listPending(runtime, BACKGROUND_CONTEXT);
process.stdout.write(`\n关闭 ${closed} 条；剩余未决 ${left.length} 条\n`);
await runtime.close();
