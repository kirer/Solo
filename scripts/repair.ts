/**
 * 一次性修复脚本：清理全员频道的历史任务消息 + 修正团队频道成员（去幽灵、补统筹）。
 *
 * 这是给**已损坏的运行态**用的，不是常规装配路径。它复用团队自己的运行时
 * （openCore / assembleCore），只对 `core.channels` 文档做两件事：
 *   1. 把 全员频道（`all`）里已有的消息清空 —— 那里混进了我误下的任务，
 *      全员频道现在预留、不承载任务消息；频道本身保留（成员不动）。
 *   2. 对每个团队频道调用 `syncTeam`，按事实精确重算成员（去掉 gunanyan 这类
 *      幽灵 slug，补上知言这类统筹者）。
 *
 * 用法（在停掉旧服务、改完文件之后跑）：
 *   node --experimental-strip-types scripts/repair.ts
 */
import { createRegistry, setupModels } from "../src/core/runtime/index.ts";
import { openCore } from "../src/core/runtime/open.ts";
import { assembleCore } from "../src/core/shell/assemble.ts";
import { ChannelDoc, teamId } from "../src/core/channel/types.ts";
import { listTeams } from "../src/core/team/doc.ts";
import { BACKGROUND_CONTEXT } from "../src/core/runtime/index.ts";

const workspace = process.env.WORKSPACE ?? "workspace";
const agentsRoot = `${workspace}/agents`;
const teamsRoot = `${workspace}/teams`;
const databasePath = `${workspace}/core.sqlite`;

async function main(): Promise<void> {
	const configured = setupModels(process.env, { workspace });
	const runtime = await openCore({ databasePath, models: configured.models, registry: createRegistry() });
	const shell = await assembleCore(runtime.harness, runtime.registry, {
		agentsRoot,
		teamsRoot,
		...(configured.defaultModel === undefined ? {} : { defaultModel: configured.defaultModel }),
	});

	const ctx = BACKGROUND_CONTEXT;

	// 1. 清空全员频道的消息（保留频道与成员）。
	let cleared = 0;
	await runtime.harness.commit(async (tx) => {
		const doc = (await tx.doc(ChannelDoc)) as Awaited<ReturnType<typeof shell.channels>>;
		const allChannel = doc.channels["all"];
		// 收窄一次再判：`noUncheckedIndexedAccess` 下 `doc.messages["all"]` 每次访问都是
		// `X | undefined`，先 `?.length ?? 0` 判空、再直接 `.length` 是类型撒谎（TS2532）。
		const allMessages = doc.messages["all"];
		if (allChannel !== undefined && allMessages !== undefined && allMessages.length > 0) {
			cleared = allMessages.length;
			doc.messages["all"] = [];
			doc.nextSeq["all"] = 1;
		}
		for (const slug of Object.keys(doc.readMarks)) {
			if (doc.readMarks[slug]?.["all"] !== undefined) {
				delete doc.readMarks[slug]["all"];
			}
		}
	}, ctx);
	console.log(`全员频道：清空了 ${cleared} 条历史消息（频道与成员保留）。`);

	// 2. 每个团队频道按事实重算成员。
	const teams = await listTeams(teamsRoot);
	for (const team of teams) {
		const before = (await shell.channels()).channels[teamId(team.slug)]?.members ?? [];
		await shell.syncTeam(team.slug, ctx);
		const after = (await shell.channels()).channels[teamId(team.slug)]?.members ?? [];
		const removed = before.filter((m) => !after.includes(m));
		const added = after.filter((m) => !before.includes(m));
		console.log(
			`团队 ${team.slug}：成员 ${after.sort().join("、")}` +
				(removed.length ? `（移除幽灵 ${removed.join("、")}）` : "") +
				(added.length ? `（补入 ${added.join("、")}）` : ""),
		);
	}

	await shell.close().catch(() => undefined);
	await runtime.close().catch(() => undefined);
	console.log("修复完成。");
}

await main();
