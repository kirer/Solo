/**
 * 真模型场景套件的**纯函数**部分：命令行与轮次聚合。
 *
 * 这里不碰模型、不碰磁盘：`scripts/scenario-live.ts` 的判定全靠这两个函数，
 * 把「2/3 门」「SKIP 不进分母」「--smoke 只警告行为失败」钉住，
 * 免得套件自己在真模型跑偏时给出错的结论。
 */
import { describe, expect, test } from "vitest";
import {
	aggregateRounds,
	parseLiveArgs,
	seqBaseline,
	type Check,
	type RoundResult,
	type RoundStatus,
} from "../../scripts/live-support.ts";

const check = (kind: Check["kind"], ok: boolean): Check => ({ id: kind, title: kind, kind, ok, detail: "" });

function round(scenarioId: string, status: RoundStatus, index = 1): RoundResult {
	const checks: Check[] =
		status === "PASS"
			? [check("mechanism", true), check("behavior", true)]
			: status === "PARTIAL"
				? [check("mechanism", true), check("behavior", false)]
				: status === "FAIL"
					? [check("mechanism", false), check("behavior", true)]
					: [];
	return { scenarioId, round: index, status, checks, durationMs: 1 };
}

const scenarios = [
	{ id: "hard-one", gate: "hard" as const },
	{ id: "behavior-one", gate: "behavior" as const },
];

describe("aggregateRounds：硬场景与行为场景分开判", () => {
	test("3 轮全过才算过", () => {
		const aggregate = aggregateRounds(
			[round("hard-one", "PASS", 1), round("hard-one", "PASS", 2), round("hard-one", "PASS", 3)],
			[scenarios[0]!],
		);
		expect(aggregate.rows[0]?.ok).toBe(true);
		expect(aggregate.exitCode).toBe(0);
	});

	test("机制门失败一轮就不过", () => {
		const aggregate = aggregateRounds(
			[round("hard-one", "PASS", 1), round("hard-one", "FAIL", 2), round("hard-one", "PASS", 3)],
			[scenarios[0]!],
		);
		expect(aggregate.rows[0]?.ok).toBe(false);
		expect(aggregate.rows[0]?.reason).toMatch(/机制门失败/);
		expect(aggregate.exitCode).toBe(1);
	});

	test("脚本异常一轮就不过", () => {
		const aggregate = aggregateRounds(
			[round("hard-one", "PASS", 1), round("hard-one", "ERROR", 2), round("hard-one", "PASS", 3)],
			[scenarios[0]!],
		);
		expect(aggregate.rows[0]?.ok).toBe(false);
		expect(aggregate.rows[0]?.reason).toMatch(/脚本异常/);
	});

	test("行为场景 2/3 过、1/3 不过", () => {
		const twoOfThree = aggregateRounds(
			[round("behavior-one", "PASS", 1), round("behavior-one", "PASS", 2), round("behavior-one", "PARTIAL", 3)],
			[scenarios[1]!],
		);
		expect(twoOfThree.rows[0]?.ok).toBe(true);
		expect(twoOfThree.exitCode).toBe(0);

		const oneOfThree = aggregateRounds(
			[round("behavior-one", "PASS", 1), round("behavior-one", "PARTIAL", 2), round("behavior-one", "PARTIAL", 3)],
			[scenarios[1]!],
		);
		expect(oneOfThree.rows[0]?.ok).toBe(false);
		expect(oneOfThree.exitCode).toBe(1);
	});

	test("SKIP 不进分母：2 过 + 1 跳 = 2/2", () => {
		const aggregate = aggregateRounds(
			[round("behavior-one", "PASS", 1), round("behavior-one", "PASS", 2), round("behavior-one", "SKIP", 3)],
			[scenarios[1]!],
		);
		expect(aggregate.rows[0]?.counted).toBe(2);
		expect(aggregate.rows[0]?.passRate).toBe(1);
		expect(aggregate.rows[0]?.ok).toBe(true);
	});

	test("全部 SKIP 是覆盖缺口，不当作通过、也不单独置退出码", () => {
		const aggregate = aggregateRounds(
			[round("behavior-one", "SKIP", 1), round("behavior-one", "SKIP", 2), round("behavior-one", "SKIP", 3)],
			[scenarios[1]!],
		);
		expect(aggregate.rows[0]?.coverageGap).toBe(true);
		expect(aggregate.rows[0]?.reason).toMatch(/覆盖缺口/);
		expect(aggregate.failed).toHaveLength(0);
		expect(aggregate.exitCode).toBe(0);
	});

	test("--smoke：行为门失败只警告，机制门失败照旧", () => {
		const behaviorFail = aggregateRounds(
			[round("behavior-one", "PARTIAL", 1)],
			[scenarios[1]!],
			{ smoke: true },
		);
		expect(behaviorFail.rows[0]?.ok).toBe(true);

		const mechanismFail = aggregateRounds([round("hard-one", "FAIL", 1)], [scenarios[0]!], { smoke: true });
		expect(mechanismFail.rows[0]?.ok).toBe(false);
	});

	test("--strict：行为场景也要 3/3", () => {
		const aggregate = aggregateRounds(
			[round("behavior-one", "PASS", 1), round("behavior-one", "PASS", 2), round("behavior-one", "PARTIAL", 3)],
			[scenarios[1]!],
			{ strict: true },
		);
		expect(aggregate.rows[0]?.ok).toBe(false);
	});
});

describe("seqBaseline", () => {
	test("还没说过话的新频道记 0，而不是漏掉", async () => {
		const shell = {
			channels: async () => ({
				channels: { all: {}, "team:新团队": {} },
				messages: {},
				nextSeq: { all: 5 },
				readMarks: {},
			}),
		} as unknown as Parameters<typeof seqBaseline>[0];
		// 漏掉的频道会让 waitForMention 回落到 Infinity，永远看不到新团队里的话。
		await expect(seqBaseline(shell)).resolves.toEqual({ all: 5, "team:新团队": 0 });
	});
});

describe("parseLiveArgs", () => {
	test("默认：全部场景、3 轮、不保留", () => {
		const args = parseLiveArgs([]);
		expect(args.scenarios).toBeUndefined();
		expect(args.rounds).toBe(3);
		expect(args.keep).toBe(false);
		expect(args.smoke).toBe(false);
	});

	test("--scenario 逗号分隔", () => {
		expect(parseLiveArgs(["--scenario=dm-routing,restart"]).scenarios).toEqual(["dm-routing", "restart"]);
	});

	test("--rounds / --timeout / --settings / --out", () => {
		const args = parseLiveArgs(["--rounds=1", "--timeout=90000", "--settings=/tmp/s.json", "--out=/tmp/out"]);
		expect(args.rounds).toBe(1);
		expect(args.timeoutMs).toBe(90_000);
		expect(args.settings).toBe("/tmp/s.json");
		expect(args.out).toBe("/tmp/out");
	});

	test("不认识、缺值、非法值都直接报错", () => {
		expect(() => parseLiveArgs(["--nope"])).toThrow(/不认识的参数/);
		expect(() => parseLiveArgs(["--rounds=0"])).toThrow(/正整数/);
		expect(() => parseLiveArgs(["--rounds"])).toThrow(/正整数/);
		expect(() => parseLiveArgs(["--scenario="])).toThrow(/需要 id/);
		expect(() => parseLiveArgs(["--timeout=10"])).toThrow(/毫秒/);
	});

	test("--smoke 只用于 1 轮", () => {
		expect(() => parseLiveArgs(["--smoke"])).toThrow(/--rounds=1/);
		expect(parseLiveArgs(["--smoke", "--rounds=1"]).smoke).toBe(true);
	});
});
