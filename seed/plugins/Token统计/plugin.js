/**
 * Token 统计的后端：把审计日志读成一份「谁、哪只模型、花了多少」的账。
 *
 * 数据只有一个来源 —— `api.logsRoot` 下的 `tools.jsonl`（ADR-010 的审计钩子，每次
 * 模型回复写一行：`at` / `who` / `model` / `in` / `out` / `cache` / `write` / `cost`
 * / `ms`）。不看会话数据库：审计是唯一一份「按调用」的账，数据库里只有消息。
 *
 * 口径（与 dsh-context 的 Context Insights 对齐，只保留 Solo 真有的字段）：
 * - **计费 Token** = 新输入 + 缓存读 + 缓存写 + 输出；`cache` 不是 `in` 的子集；
 * - **缓存命中率** = 缓存读 ÷（新输入 + 缓存读 + 缓存写）；
 * - **成本** = 各家 provider 回报的美元金额；本地网关通常是 0；
 * - 按**本地日期**切天（日志里的 `at` 是 UTC，人看的是自己那一天）。
 *
 * 写成 `.js`：与另外两个出厂插件一样，单测会把它原样装进临时目录里跑。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 86_400_000;
/** 审计单文件 5MB 轮转一代（ADR-010），所以最多两份。 */
const FILES = ["tools.jsonl", "tools.jsonl.1"];
const HEATMAP_DAYS = 56;
/** 「全部」的图最多铺一年，再久就不是趋势而是考古了。 */
const MAX_CHART_DAYS = 366;

function toNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dayKey(time) {
	const date = new Date(time);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${String(date.getFullYear())}-${month}-${day}`;
}

/** 本地日的零点（按毫秒）。 */
function startOfDay(time) {
	const date = new Date(time);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function shiftDay(day, delta) {
	const date = new Date(`${day}T00:00:00`);
	date.setDate(date.getDate() + delta);
	return dayKey(date.getTime());
}

/** 把一行 JSON 解析成审计记录；坏的、不是 `model` 的、没有时间的都跳过。 */
function parseLine(line) {
	if (line === "") return undefined;
	let row;
	try {
		row = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (row === null || typeof row !== "object" || row.kind !== "model") return undefined;
	const at = Date.parse(row.at);
	if (!Number.isFinite(at)) return undefined;
	return {
		at,
		who: typeof row.who === "string" && row.who !== "" ? row.who : "未识别",
		model: typeof row.model === "string" && row.model !== "" ? row.model : "未知模型",
		input: toNumber(row.in),
		output: toNumber(row.out),
		// 旧日志没有 `write`：缺席就是 0，不是错。
		cache: toNumber(row.cache),
		write: toNumber(row.write),
		cost: toNumber(row.cost),
		ms: toNumber(row.ms),
	};
}

async function readRecords(logsRoot) {
	const rows = [];
	for (const name of FILES) {
		const text = await readFile(join(logsRoot, name), "utf8").catch(() => "");
		for (const line of text.split("\n")) {
			const row = parseLine(line.trim());
			if (row !== undefined) rows.push(row);
		}
	}
	return rows;
}

function emptyTotals() {
	return { requests: 0, input: 0, cache: 0, write: 0, output: 0, tokens: 0, cost: 0, ms: 0 };
}

function addTo(total, row) {
	const billed = row.input + row.cache + row.write + row.output;
	total.requests += 1;
	total.input += row.input;
	total.cache += row.cache;
	total.write += row.write;
	total.output += row.output;
	total.tokens += billed;
	total.cost += row.cost;
	total.ms += row.ms;
}

function finish(total) {
	const prompt = total.input + total.cache + total.write;
	return { ...total, cacheRate: prompt === 0 ? 0 : total.cache / prompt };
}

/** 按某个键聚合，`tokens` 降序 —— 界面不用自己排，两边也不会排出两种顺序。 */
function groupOf(rows, keyOf) {
	const groups = new Map();
	for (const row of rows) {
		const key = keyOf(row);
		const bucket = groups.get(key) ?? emptyTotals();
		addTo(bucket, row);
		groups.set(key, bucket);
	}
	return [...groups.entries()]
		.map(([key, total]) => ({ key, ...finish(total) }))
		.sort((left, right) => right.tokens - left.tokens || right.requests - left.requests);
}

/** 请求的档位：7 / 30 / 0（全部）。别的值一律按 30 天算，不报错。 */
function rangeDays(query) {
	const raw = query.days;
	if (raw === "0" || raw === "all") return 0;
	const days = Number(raw);
	if (!Number.isFinite(days)) return 30;
	return [7, 30].includes(days) ? days : 30;
}

export function apply(api) {
	api.route({
		method: "GET",
		pattern: "/api/p/tokens",
		async handle(request) {
			const days = rangeDays(request.query);
			const records = await readRecords(api.logsRoot);
			const now = Date.now();
			const today = startOfDay(now);

			// 「全部」的账是全部；图的起点最多往回铺一年。
			let inRange = records;
			let from;
			if (days === 0) {
				const earliest = records.reduce((min, row) => Math.min(min, row.at), now);
				from = Math.max(startOfDay(earliest), today - (MAX_CHART_DAYS - 1) * DAY_MS);
			} else {
				from = today - (days - 1) * DAY_MS;
				inRange = records.filter((row) => row.at >= from);
			}

			const byDay = new Map();
			for (const row of records) {
				const key = dayKey(row.at);
				const bucket = byDay.get(key) ?? emptyTotals();
				addTo(bucket, row);
				byDay.set(key, bucket);
			}

			const firstDay = dayKey(from);
			const lastDay = dayKey(today);
			const daily = [];
			for (let day = firstDay; day <= lastDay; day = shiftDay(day, 1)) {
				const total = byDay.get(day) ?? emptyTotals();
				daily.push({
					date: day,
					tokens: total.tokens,
					cost: total.cost,
					requests: total.requests,
				});
				// 「全部」按最早一条算，可能把范围撑得很长；最多 366 天。
				if (daily.length >= MAX_CHART_DAYS) break;
			}

			const heatmap = [];
			for (let offset = HEATMAP_DAYS - 1; offset >= 0; offset -= 1) {
				const day = dayKey(today - offset * DAY_MS);
				const total = byDay.get(day) ?? emptyTotals();
				heatmap.push({ date: day, tokens: total.tokens });
			}

			return {
				range: { days, from: firstDay, to: lastDay },
				totals: finish(inRange.reduce((total, row) => (addTo(total, row), total), emptyTotals())),
				daily,
				heatmap,
				people: groupOf(inRange, (row) => row.who),
				models: groupOf(inRange, (row) => row.model),
				empty: records.length === 0,
			};
		},
	});
}
