/**
 * 后台命令的收尾（用例层）：服务重启时把上一轮遗留的活清掉，并在频道里留一句话。
 *
 * 为什么要有：后台命令的「跑完了」是**进程内**的回调。进程一死，那条结果就永远不会回来，
 * 而起跑的人还在等 —— 频道里一片空白，和「命令还在跑」长得一模一样。所以重启时必须
 * 把账结掉：活着的杀掉（它还在没人知道的地方占着端口），死掉的照实说。
 */
import { join } from "node:path";
import { sweepRunJobs } from "../channel/jobs.ts";
import { OWNER } from "../channel/types.ts";
import { BACKGROUND_CONTEXT } from "../runtime/index.ts";
import type { CoreServices } from "./types.ts";

export function createRuns(shell: CoreServices) {
	const dir = join(shell.layout.logsRoot, "run");

	/**
	 * 清一次遗留的后台命令。
	 *
	 * 失败只记一行，不影响启动 —— 清不掉只是留下一个孤儿进程，服务该起还是要起。
	 */
	async function sweep(): Promise<void> {
		try {
			const stale = await sweepRunJobs(dir);
			for (const { job, killed } of stale) {
				const ending = killed ? "服务重启时它还活着，已经停掉" : "服务重启时它已经结束，但结果没回来";
				await shell
					.postAs(
						{
							channelId: job.channelId,
							from: OWNER,
							text: `${job.slug} 的后台命令没有结果了：$ ${job.command}（${ending}）。要的话重新跑一次。`,
							kind: "note",
						},
						BACKGROUND_CONTEXT,
					)
					.catch(() => undefined);
			}
			if (stale.length > 0) console.log(`[core] 收掉 ${stale.length} 条重启前遗留的后台命令`);
		} catch {
			/* 清理失败不影响启动 */
		}
	}

	return { dir, sweep };
}
