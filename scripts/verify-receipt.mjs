#!/usr/bin/env node
/**
 * 验证收据：把「测试真的跑了」变成机器可判定的事实。
 *
 * 为什么需要：本仓库没有 CI，而 `test/e2e/real-model.test.ts` 曾在网关不可用时
 * **整个文件静默 skip**——`Tests 649 passed` 里不显示 skip，于是随机不跑没人发现。
 * 所以这里把 `numPendingTests` / `numTodoTests` 也算失败，并把结果落成收据，
 * 供 `--check-receipt` 在验收前确认：上次是绿的、而且绿的是**当前 commit**。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const RECEIPT_PATH = join(ROOT, ".taste", "verify-receipt.json");
const MAX_LIST = 20;
const FRESH_MS = 24 * 60 * 60 * 1000;
const SKIP_HINT = "跳过的测试等于没测。若本次不打算跑真模型，必须显式设 SKIP_REAL_MODEL=1";

function head() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

/** 跑 vitest 并拿到 JSON 报告；stdio 继承，让失败信息仍然打在终端上。 */
function runVitest(reportPath) {
	return new Promise((resolve) => {
		const child = spawn("npx", ["vitest", "--run", "--reporter=json", `--outputFile=${reportPath}`], {
			cwd: ROOT,
			stdio: "inherit",
		});
		child.on("error", () => resolve(1));
		child.on("close", (code) => resolve(code ?? 1));
	});
}

/**
 * 按文件归类用例状态。
 *
 * 为什么不只按断言状态数：`beforeAll` 抛错时 vitest 会把**该文件的每个用例**都记成
 * skipped、`numFailedTests` 仍是 0。照断言状态念会把「真的失败了」播报成「跳过了」，
 * 于是这里把「文件自己红了」和「用例被显式 skip」分开数。
 */
function collect(report) {
	const skipped = [];
	const todo = [];
	const failed = [];
	const brokenSuites = [];
	const collateral = [];
	for (const file of report.testResults ?? []) {
		const fileFailed = file.status === "failed";
		if (fileFailed) {
			// 报错原因有时在文件级 message，有时在首个断言的 failureMessages，两边都试。
			const detail =
				String(file.message ?? "") ||
				(file.assertionResults ?? []).flatMap((assertion) => assertion.failureMessages ?? []).join("\n");
			brokenSuites.push(`${relative(ROOT, file.name)}${detail === "" ? "" : `：${detail.split("\n")[0]}`}`);
		}
		for (const assertion of file.assertionResults ?? []) {
			const name = assertion.fullName;
			if (assertion.status === "failed") failed.push(name);
			else if (assertion.status === "todo") todo.push(name);
			else if (assertion.status === "pending" || assertion.status === "skipped") {
				// 文件崩了才没跑的用例不是「跳过」，是「被连累」：混进 skip 计数会掩盖失败原因。
				(fileFailed ? collateral : skipped).push(name);
			}
		}
	}
	return { skipped, todo, failed, brokenSuites, collateral };
}

function printList(title, names) {
	if (names.length === 0) return;
	console.error(`\n${title}（${names.length} 条）：`);
	for (const name of names.slice(0, MAX_LIST)) console.error(`  - ${name}`);
	if (names.length > MAX_LIST) console.error(`  …… 其余 ${names.length - MAX_LIST} 条省略`);
}

/** 收据新鲜度门：绿 + 当前 commit + 24 小时内。 */
async function checkReceipt({ quiet = false } = {}) {
	let receipt;
	try {
		receipt = await readJson(RECEIPT_PATH);
	} catch {
		return { ok: false, reason: `没有收据（${RECEIPT_PATH}），先跑 npm run verify` };
	}
	const current = head();
	const at = Date.parse(receipt.at ?? "");
	if (receipt.ok !== true) return { ok: false, reason: `上次 verify 未通过（ok=${receipt.ok}）` };
	if (receipt.commit !== current) {
		return { ok: false, reason: `收据记录的 commit ${receipt.commit || "（空）"} 不是当前 HEAD ${current}` };
	}
	if (!Number.isFinite(at) || at < Date.now() - FRESH_MS) {
		return { ok: false, reason: `收据时间 ${receipt.at} 已超过 24 小时，请重跑 npm run verify` };
	}
	if (!quiet) console.log(`收据有效：${receipt.numTotalTests} 个测试全绿，commit ${current.slice(0, 8)}，at ${receipt.at}`);
	return { ok: true };
}

async function main() {
	const args = new Set(process.argv.slice(2));

	if (args.has("--check-receipt")) {
		const result = await checkReceipt();
		if (!result.ok) {
			console.error(`收据检查失败：${result.reason}`);
			process.exit(1);
		}
		return;
	}

	const reportPath = join(tmpdir(), `verify-receipt-${process.pid}.json`);
	const exitCode = await runVitest(reportPath);

	let report;
	try {
		report = await readJson(reportPath);
	} catch {
		console.error(`\nverify 失败：vitest 没有产出 JSON 报告（退出码 ${exitCode}），测试可能没跑起来。`);
		process.exit(1);
	}

	const { skipped, todo, failed, brokenSuites, collateral } = collect(report);
	const ok =
		report.success === true &&
		exitCode === 0 &&
		failed.length === 0 &&
		brokenSuites.length === 0 &&
		todo.length === 0 &&
		skipped.length === 0;

	// 收据先落盘再判新鲜度：红也要留证，否则下一次只能看终端历史。
	await mkdir(join(ROOT, ".taste"), { recursive: true });
	await writeFile(
		RECEIPT_PATH,
		`${JSON.stringify(
			{
				ok,
				numTotalTests: report.numTotalTests ?? 0,
				numPendingTests: skipped.length,
				commit: head(),
				at: new Date().toISOString(),
			},
			null,
			"\t",
		)}\n`,
	);

	if (!ok) {
		console.error(
			`\nverify 失败：总共 ${report.numTotalTests ?? 0} 个测试，` +
				`通过 ${report.numPassedTests ?? 0}，失败 ${failed.length}，` +
				`崩溃的测试文件 ${brokenSuites.length}（${collateral.length} 个用例因此没跑），` +
				`跳过 ${skipped.length}，todo ${todo.length}。`,
		);
		printList("整个文件崩掉的测试文件", brokenSuites);
		printList("失败的测试", failed);
		printList("被跳过的测试", skipped);
		printList("todo 的测试", todo);
		if (skipped.length > 0 || todo.length > 0) console.error(`\n${SKIP_HINT}`);
		process.exit(1);
	}

	console.log(`\nverify 通过：${report.numTotalTests} 个测试，0 跳过`);

	// 默认还要确认「刚落盘的收据仍然对得上当前 HEAD」：测试跑 2 分钟，
	// 中途切了分支或有人提交，收据就指向一个不存在的绿。
	if (!args.has("--no-freshness")) {
		const fresh = await checkReceipt({ quiet: true });
		if (!fresh.ok) {
			console.error(`\n收据新鲜度检查失败：${fresh.reason}`);
			process.exit(1);
		}
	}
}

await main();
