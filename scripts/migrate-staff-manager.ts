#!/usr/bin/env node
/**
 * 员工直属上级迁移：把「岗位上级」（coo/cto）改成「本项目负责人」引用
 * （`leader:<slug>`），并重渲染员工提示词里的「直属上级是 …」。
 *
 * 用法：
 *   node --experimental-strip-types scripts/migrate-staff-manager.ts \
 *     --db <sqlite 路径> [--project ops-defect-loop] [--staff log-ops,backend-fix] [--dry-run] [--check]
 *
 *   --db        必填。没有默认库，避免手滑打开生产库。
 *   --project   默认 ops-defect-loop。
 *   --staff     默认 log-ops,backend-fix（逗号分隔；只迁这些员工）。
 *   --dry-run   只报告将变更的条目，`migrated=0`，不写公司文档，退出码 0。
 *   --check     只读断言（不迁移）：每名目标员工 manager 都是 `leader:<project>`
 *               且 managerLabelOf 能解析出负责人名。未完成退出码 1，完成 0。
 *
 * ⚠️ 执行前必须先停掉 7788 端口上的服务
 *
 * 本项目是单进程、单 SQLite 库（WAL）。服务还在跑时执行本脚本，会和活进程抢同一个库：
 * 轻则 `database is locked`，重则两个进程各自持有过期的 CompanyDoc 快照互相覆盖，
 * 或让在跑的任务被重启计数。本脚本不判断服务是否在跑，请在停服窗口内执行。
 * 停服后再确认没有进程监听 7788（例如 `lsof -nP -iTCP:7788 -sTCP:LISTEN` 应无输出）。
 *
 * 备份不由本脚本负责（脚本失败时不应留下半套备份/恢复状态），由 RUNBOOK 的人工步骤完成。
 * 推荐用 SQLite 自己的在线备份，得到的是一致快照（含 WAL 里尚未 checkpoint 的事务）：
 *
 *   sqlite3 workspace/company.sqlite \
 *     ".backup 'workspace/company.sqlite.bak-$(date +%Y%m%d-%H%M%S)'"
 *
 * 若坚持用 cp：先停服，再同时拷贝主文件与 `-wal`、`-shm`；只拷主文件可能丢掉最近事务。
 *
 * 不调用 recover()：那会把停服期间积压的任务重新调度起来（可能真的调用模型）。
 * 迁移只读公司索引、只写 CompanyDoc 的 manager 字段与员工会话的 instructions，
 * 不依赖任务恢复；服务重启后照常恢复。
 *
 * 幂等：已经是 `leader:<project>` 的员工会被跳过，第二次执行 migrated=0。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, createRegistry, openCompany, setupModels, type CompanyRuntime } from "../src/runtime/index.ts";
import { CompanyDoc, LEADER_REF_PREFIX, isLeaderManagerRef, managerLabelOf } from "../src/company/docs.ts";
import { migrateStaffManagers } from "../src/company/org.ts";

const DEFAULT_PROJECT = "ops-defect-loop";
const DEFAULT_STAFF = ["log-ops", "backend-fix"] as const;

const USAGE = [
	"用法：node --experimental-strip-types scripts/migrate-staff-manager.ts --db <path> [--project ops-defect-loop] [--staff log-ops,backend-fix] [--dry-run] [--check]",
	"  --db <path>        必填：要迁移的 SQLite 库（执行前先停服并备份）",
	"  --project <slug>   项目 slug，默认 ops-defect-loop",
	"  --staff <a,b>      只迁这些员工，默认 log-ops,backend-fix",
	"  --dry-run          只打印将变更的条目，不写库",
	"  --check            只读断言迁移已完成，未完成退出码 1",
].join("\n");

class UsageError extends Error {}

type CliOptions = {
	readonly db: string;
	readonly project: string;
	readonly staff: readonly string[];
	readonly dryRun: boolean;
	readonly check: boolean;
};

/** 解析命令行参数；任何不认识的参数都直接报错，不做猜测。 */
function parseArgs(argv: readonly string[]): CliOptions {
	let db: string | undefined;
	let project = DEFAULT_PROJECT;
	let staff: readonly string[] = DEFAULT_STAFF;
	let dryRun = false;
	let check = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--db": {
				const value = argv[index + 1];
				if (value === undefined || value.startsWith("--")) throw new UsageError("--db 需要一个库文件路径");
				db = value;
				index += 1;
				break;
			}
			case "--project": {
				const value = argv[index + 1];
				if (value === undefined || value.startsWith("--")) throw new UsageError("--project 需要一个项目 slug");
				project = value;
				index += 1;
				break;
			}
			case "--staff": {
				const value = argv[index + 1];
				if (value === undefined || value.startsWith("--")) throw new UsageError("--staff 需要逗号分隔的员工名");
				const names = value
					.split(",")
					.map((name) => name.trim())
					.filter((name) => name !== "");
				if (names.length === 0) throw new UsageError("--staff 至少需要一个员工名");
				staff = names;
				index += 1;
				break;
			}
			case "--dry-run":
				dryRun = true;
				break;
			case "--check":
				check = true;
				break;
			default:
				throw new UsageError(`未知参数：${arg}`);
		}
	}

	if (db === undefined) throw new UsageError("缺少必填参数 --db（本脚本没有默认库，避免误开生产库）");
	if (dryRun && check) throw new UsageError("--dry-run 与 --check 不能同时使用：前者报告待迁移项，后者断言已完成");
	return { db: resolve(db), project, staff, dryRun, check };
}

/** 打开公司运行时。只读语义由调用方保证：check/dry-run 不提交迁移。 */
async function openRuntime(databasePath: string): Promise<CompanyRuntime> {
	const { models } = setupModels();
	return openCompany({ databasePath, models, registry: createRegistry() }, BACKGROUND_CONTEXT);
}

/** --check：只读断言，不迁移。 */
async function runCheck(runtime: CompanyRuntime, options: CliOptions): Promise<number> {
	const state = await runtime.harness.snapshot(CompanyDoc, BACKGROUND_CONTEXT);
	if (state === undefined) {
		console.error("检查失败：公司尚未初始化（找不到 app.company 文档）。");
		return 1;
	}

	const project = state.projects[options.project];
	if (project === undefined) {
		console.error(`检查失败：项目不存在：${options.project}`);
		return 1;
	}

	const expected = `${LEADER_REF_PREFIX}${options.project}`;
	const failures: string[] = [];
	let checked = 0;

	if (typeof project.leader !== "number" || project.leaderName === "") {
		failures.push(`项目 ${options.project} 缺少 leader/leaderName，无法解析负责人`);
	}

	for (const name of options.staff) {
		const key = `${options.project}/${name}`;
		const person = state.staff[key];
		if (person === undefined) {
			failures.push(`${name}：项目名册里找不到 ${key}`);
			console.log(`FAIL ${name}: 不在名册`);
			continue;
		}
		checked += 1;
		const manager = person.manager;
		const refOk = isLeaderManagerRef(manager) && manager === expected;
		const label = managerLabelOf(state, manager);
		const labelOk = label !== "" && label !== "未知负责人";
		const pass = refOk && labelOk;
		console.log(`${pass ? "PASS" : "FAIL"} ${name}: manager=${manager} label=${label}`);
		if (!refOk) failures.push(`${name}：manager 是 ${manager}，期望 ${expected}`);
		if (!labelOk) failures.push(`${name}：managerLabelOf 无法解析 ${manager}`);
	}

	if (checked !== options.staff.length) failures.push(`只检查到 ${checked}/${options.staff.length} 名目标员工`);

	if (failures.length === 0) {
		console.log(`check=ok staff=${checked}/${options.staff.length} project=${options.project}`);
		return 0;
	}
	console.error("检查失败：迁移尚未完成。");
	for (const failure of failures) console.error(`  - ${failure}`);
	return 1;
}

/** 正常执行 / dry-run。 */
async function runMigration(runtime: CompanyRuntime, options: CliOptions): Promise<number> {
	const result = await migrateStaffManagers(
		runtime,
		{
			project: options.project,
			staff: options.staff,
			dryRun: options.dryRun,
		},
		BACKGROUND_CONTEXT,
	);

	if (options.dryRun) {
		console.log(`[dry-run] 未写库；将变更 ${result.details.length} 名员工（skipped=${result.skipped}）：`);
		for (const detail of result.details) console.log(`  - ${detail}`);
		if (result.details.length === 0) console.log("  （没有需要迁移的员工，已是目标状态）");
		console.log(`migrated=${result.migrated}`);
		return 0;
	}

	console.log(`migrated=${result.migrated}`);
	console.log(`skipped=${result.skipped}`);
	for (const detail of result.details) console.log(`  - ${detail}`);
	if (result.migrated === 0) console.log("没有需要迁移的员工（已是目标状态）。");
	return 0;
}

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2));
	// 先确认库存在：openCompany 打开不存在的路径会新建空库，路径写错时会在别处
	// 留下一个空文件，还会报「公司尚未初始化」，容易误导。
	if (!existsSync(options.db)) throw new UsageError(`库文件不存在：${options.db}`);
	const runtime = await openRuntime(options.db);
	try {
		if (options.check) return await runCheck(runtime, options);
		return await runMigration(runtime, options);
	} finally {
		await runtime.close(BACKGROUND_CONTEXT);
	}
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`迁移失败：${message}`);
		if (error instanceof UsageError) console.error(USAGE);
		else if (error instanceof Error && error.stack !== undefined) console.error(error.stack);
		process.exitCode = 1;
	});
