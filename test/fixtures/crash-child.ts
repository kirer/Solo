/**
 * kill -9 测试的子进程：开库、建会话、起一个会挂住的任务，然后等父进程杀它。
 *
 * 只通过 stdout 说话：`TASK_ID <id>` 让父进程知道该等哪条任务，`TASK_RUNNING`
 * 由任务自己打印，表示它真的进了 phase（而不只是被创建）。
 */
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "../../src/core/runtime/index.ts";
import { openCore } from "../../src/core/runtime/open.ts";
import { crashExtension, crashRegistry, crashTask } from "./crash-task.ts";

const databasePath = process.env.CRASH_DB;
if (databasePath === undefined) throw new Error("缺少 CRASH_DB");

const runtime = await openCore({ databasePath, models: createModels(), registry: crashRegistry() });
runtime.harness.resume();
const conversation = await runtime.harness.createConversation(
	{ ownership: { kind: "ownerless" }, agent: { extensions: [crashExtension] } },
	BACKGROUND_CONTEXT,
);
const taskId = await conversation.commit(
	(tx) => tx.createTask(crashTask, {}, { ownership: { kind: "conversation" } }),
	BACKGROUND_CONTEXT,
);
console.log(`TASK_ID ${String(taskId)}`);

// 任务自己会挂住；这个定时器只是让事件循环别退出。
setInterval(() => undefined, 1_000);
