/**
 * 出厂插件「Token 统计」：审计日志 → 一份用量账。
 *
 * 界面上的数字不能是猜的，所以这里钉的是口径：
 * - 计费 Token = 新输入 + 缓存读 + 缓存写 + 输出；
 * - 缓存命中率 = 缓存读 ÷（新输入 + 缓存读 + 缓存写）；
 * - 坏的 / 不是 `model` 的行跳过，旧日志没有 `write` 当 0。
 *
 * 面板长什么样不在这里测（插件是数据，不进界面测试）；这里只测后端那一条路由。
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins } from "../../src/core/plugin/index.ts";
import type { PluginRouteSpec } from "../../src/core/plugin/index.ts";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

type Summary = {
	range: { days: number; from: string; to: string };
	totals: { requests: number; input: number; cache: number; write: number; output: number; tokens: number; cost: number; cacheRate: number };
	daily: readonly { date: string; tokens: number }[];
	heatmap: readonly { date: string; tokens: number }[];
	people: readonly { key: string; tokens: number }[];
	models: readonly { key: string; tokens: number }[];
	empty: boolean;
	person?: {
		who: string;
		daily: readonly { date: string; tokens: number }[];
		totals: { requests: number; tokens: number; cost: number; cacheRate: number };
	};
};

const DAY = 86_400_000;

/** 一个装了「Token 统计」的临时工作区，日志里塞几行真实的审计形状。 */
async function boot(rows: readonly Record<string, unknown>[]): Promise<PluginRouteSpec> {
	const root = await mkdtemp(join(tmpdir(), "token-plugin-"));
	boxes.push(root);
	const workspace = join(root, "workspace");
	const logs = join(root, "logs");
	await mkdir(join(workspace, "plugins"), { recursive: true });
	await mkdir(logs, { recursive: true });
	const seed = fileURLToPath(new URL("../../plugins-src/Token统计", import.meta.url));
	await cp(seed, join(workspace, "plugins", "Token统计"), { recursive: true });
	await writeFile(join(logs, "tools.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	const host = await loadPlugins({ pluginsRoot: join(workspace, "plugins"), workspace, logsRoot: logs, log: () => {} });
	expect(host.errors).toEqual([]);
	const route = host.routes.find((item) => item.pattern === "/api/p/tokens");
	if (route === undefined) throw new Error("Token 统计没有注册 /api/p/tokens");
	return route;
}

async function summaryOf(route: PluginRouteSpec, days: string): Promise<Summary> {
	return (await route.handle({ method: "GET", params: {}, query: { days } })) as Summary;
}

describe("Token 统计的账", () => {
	it("按口径加总，坏行与非模型行跳过", async () => {
		const now = Date.now();
		const route = await boot([
			{
				at: new Date(now).toISOString(),
				kind: "model",
				who: "知言",
				model: "m",
				in: 100,
				out: 20,
				cache: 300,
				write: 50,
				cost: 0.01,
				ms: 1000,
			},
			// 旧日志没有 `write`：当 0，不是错。
			{ at: new Date(now - DAY).toISOString(), kind: "model", who: "阿拓", model: "m", in: 10, out: 5, cache: 0, cost: 0, ms: 500 },
			{ at: new Date(now).toISOString(), kind: "tool", who: "知言", tool: "run", ok: true },
			{ at: "不是时间", kind: "model", in: 999 },
		]);

		const data = await summaryOf(route, "7");
		expect(data.empty).toBe(false);
		expect(data.totals).toMatchObject({
			requests: 2,
			input: 110,
			cache: 300,
			write: 50,
			output: 25,
			tokens: 485,
			cost: 0.01,
		});
		// 300 ÷ (110 + 300 + 50)
		expect(data.totals.cacheRate).toBeCloseTo(300 / 460, 10);
		expect(data.people.map((row) => row.key)).toEqual(["知言", "阿拓"]);
		expect(data.daily).toHaveLength(7);
		expect(data.daily.at(-1)?.tokens).toBe(470);
		expect(data.heatmap).toHaveLength(56);
	});

	it("资料页那一格：只算这个人，且固定近 7 天（与选中档位无关）", async () => {
		const now = Date.now();
		const row = (at: number, who: string, input: number, output: number, cache: number, write: number) => ({
			at: new Date(at).toISOString(),
			kind: "model",
			who,
			model: "m",
			in: input,
			out: output,
			cache,
			write,
			cost: 0.01,
			ms: 1000,
		});
		const route = await boot([
			row(now, "知言", 100, 20, 300, 50),
			row(now - DAY, "知言", 10, 5, 0, 0),
			row(now, "阿拓", 1, 1, 0, 0),
			// 九天前的那条不在「近 7 天」里。
			row(now - 9 * DAY, "知言", 999, 0, 0, 0),
		]);

		const data = (await route.handle({ method: "GET", params: {}, query: { days: "30", who: "知言" } })) as Summary;
		expect(data.person?.who).toBe("知言");
		expect(data.person?.daily).toHaveLength(7);
		expect(data.person?.daily.at(-1)?.tokens).toBe(470);
		expect(data.person?.totals).toMatchObject({ requests: 2, tokens: 485 });

		// 不传 `who` 就没有这一格。
		const plain = await summaryOf(route, "7");
		expect(plain.person).toBeUndefined();
	});

	it("没有日志时有空态，而不是五百", async () => {
		const route = await boot([]);
		const data = await summaryOf(route, "30");
		expect(data.empty).toBe(true);
		expect(data.totals.tokens).toBe(0);
		expect(data.totals.cacheRate).toBe(0);
		expect(data.people).toEqual([]);
	});
});
