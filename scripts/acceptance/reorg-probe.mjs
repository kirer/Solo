#!/usr/bin/env node
/**
 * 组织调整（员工直属上级 → 项目负责人）只读验收探针。
 *
 * 用法：
 *   node scripts/acceptance/reorg-probe.mjs --db <sqlite> [--expect before|after] [--dump]
 *
 * 做的事：
 *   1. 直接以只读方式打开 SQLite（node:sqlite 的 DatabaseSync，{ readOnly: true }）。
 *   2. 读 documents / document_revisions，按底层规则重放文档：
 *      取最新 base，再按 seq 顺序应用其后的 delta（s / d / a / t / p / m / r）。
 *   3. 从重放出的 app.company 取 projects/staff；按员工 conversationId 找
 *      app.profile（documents.owner_id 即会话 id）与 pi.agent，取出 parent 与
 *      instructions 里「直属上级是 …」那一行。
 *   4. 输出 JSON 数组 [{name, pass, detail}]，最后一行 `FAIL n/m`；有失败退出码 1。
 *
 * --expect before：迁移前取证。断言两名员工 manager 仍是 coo/cto、
 *                   instructions 仍写 COO/CTO、profile.parent 若存在必须是 73。
 * --expect after ：迁移后验收。断言两名员工 manager 是 leader:ops-defect-loop、
 *                   manager 解析出的负责人名是「许砚舟」、instructions 写「直属上级是 许砚舟」。
 * --dump         ：只打印结构化快照，不做断言，退出码 0。
 *
 * 约束：不写库、不启动服务、不发网络请求。真库请先复制到 /tmp 再读
 * （cp workspace/company.sqlite /tmp/x.sqlite 与对应 -wal）。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PROJECT_SLUG = "ops-defect-loop";
const LEADER_REF = `leader:${PROJECT_SLUG}`;
const EXPECTED_LEADER = 73;
const EXPECTED_LEADER_NAME = "许砚舟";
const STAFF = [
	{ name: "log-ops", legacyManager: "coo", legacyLabel: "COO" },
	{ name: "backend-fix", legacyManager: "cto", legacyLabel: "CTO" },
];
const ROLE_LABELS = {
	ceo: "CEO",
	cto: "CTO",
	cfo: "CFO",
	cpo: "CPO",
	coo: "COO",
	cmo: "CMO",
	chro: "CHRO",
};

const USAGE = [
	"用法：node scripts/acceptance/reorg-probe.mjs --db <sqlite> [--expect before|after] [--dump]",
	"  --db <path>        只读打开的库文件（建议传真库副本）",
	"  --expect before    断言数据库仍是迁移前的旧状态",
	"  --expect after     断言迁移已完成",
	"  --dump             只打印结构化快照，不断言",
].join("\n");

class UsageError extends Error {}

/** 解析命令行参数。 */
function parseArgs(argv) {
	let db;
	let expect;
	let dump = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) throw new UsageError("--db 需要一个库文件路径");
			db = value;
			index += 1;
		} else if (arg === "--expect") {
			const value = argv[index + 1];
			if (value !== "before" && value !== "after") throw new UsageError("--expect 只接受 before 或 after");
			expect = value;
			index += 1;
		} else if (arg === "--dump") {
			dump = true;
		} else {
			throw new UsageError(`未知参数：${arg}`);
		}
	}
	if (db === undefined) throw new UsageError("缺少必填参数 --db");
	return { db: resolve(db), expect, dump };
}

// ── 文档重放 ────────────────────────────────────────────────────────────────
//
// 与底层 materializeDocument 的规则一致：取 seq <= upper 的最新 base，
// 然后按 seq 升序应用其后的 delta。delta 是 chord 的 Op 元组，路径内联。

/** 重放一个操作批次。只读脚本里保持最小实现，但语义与 chord 的 apply 对齐。 */
function applyOps(target, ops) {
	let root = target;
	for (const op of ops) {
		if (!Array.isArray(op)) throw new Error(`delta 操作不是数组：${JSON.stringify(op)}`);
		const verb = op[0];
		if (verb === "r") {
			root = op[1];
			continue;
		}
		const path = op[1];
		if (!Array.isArray(path)) throw new Error(`delta 路径不是数组：${JSON.stringify(op)}`);
		const parent = path.length === 0 ? root : resolvePath(root, path.slice(0, -1));
		const key = path.length === 0 ? undefined : path[path.length - 1];
		switch (verb) {
			case "s":
				parent[key] = op[2];
				break;
			case "d":
				if (Array.isArray(parent)) parent.splice(key, 1);
				else delete parent[key];
				break;
			case "a":
				if (typeof parent[key] !== "string") throw new Error(`a 操作的目标不是字符串：${JSON.stringify(path)}`);
				parent[key] = `${parent[key]}${op[2]}`;
				break;
			case "t":
				if (typeof parent[key] !== "string") throw new Error(`t 操作的目标不是字符串：${JSON.stringify(path)}`);
				parent[key] = parent[key].slice(op[2]);
				break;
			case "p":
				if (!Array.isArray(parent)) throw new Error(`p 操作的目标不是数组：${JSON.stringify(path)}`);
				parent.splice(op[2], op[3], ...op[4]);
				break;
			case "m": {
				if (!Array.isArray(parent)) throw new Error(`m 操作的目标不是数组：${JSON.stringify(path)}`);
				const previous = parent.slice();
				for (let index = 0; index < op[2].length; index += 1) parent[index] = previous[op[2][index]];
				break;
			}
			default:
				throw new Error(`未知的 delta 操作：${String(verb)}`);
		}
	}
	return root;
}

function resolvePath(root, path) {
	let node = root;
	for (const segment of path) {
		if (node === null || typeof node !== "object" || !Object.hasOwn(node, segment)) {
			throw new Error(`delta 路径不存在：${JSON.stringify(path)}`);
		}
		node = node[segment];
	}
	return node;
}

/** 读取并重放一个文档的当前内容。 */
function materializeDocument(db, documentId) {
	const revisions = db
		.prepare("SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? ORDER BY seq ASC")
		.all(documentId);
	let baseIndex = -1;
	for (let index = revisions.length - 1; index >= 0; index -= 1) {
		if (revisions[index].kind === "base") {
			baseIndex = index;
			break;
		}
	}
	if (baseIndex < 0) throw new Error(`文档 ${documentId} 缺少 base 修订`);
	const base = revisions[baseIndex];
	let value = JSON.parse(base.content);
	for (let index = baseIndex + 1; index < revisions.length; index += 1) {
		const revision = revisions[index];
		if (revision.kind !== "delta") {
			throw new Error(`文档 ${documentId} 在 base 之后出现非 delta 修订（seq=${revision.seq}）`);
		}
		value = applyOps(value, JSON.parse(revision.content));
	}
	return value;
}

/** 读取某个 kind 的所有存活文档：documents.owner_id → 重放后的内容。 */
function readDocumentsByKind(db, kind) {
	const rows = db
		.prepare("SELECT id, owner_id FROM documents WHERE kind = ? AND retired_at IS NULL ORDER BY id ASC")
		.all(kind);
	const byOwner = new Map();
	for (const row of rows) {
		byOwner.set(Number(row.owner_id), materializeDocument(db, row.id));
	}
	return byOwner;
}

/** 最新的存活的 singleton/session 文档内容。 */
function readLatestDocument(db, kind) {
	const row = db
		.prepare("SELECT id FROM documents WHERE kind = ? AND retired_at IS NULL ORDER BY id DESC LIMIT 1")
		.get(kind);
	if (row === undefined) throw new Error(`找不到 ${kind} 文档`);
	return materializeDocument(db, row.id);
}

// ── 数据整理 ────────────────────────────────────────────────────────────────

/** 与 src/company/docs.ts 的 managerLabelOf 同义：岗位显示名，或项目负责人名。 */
function managerLabelOf(company, ref) {
	if (typeof ref !== "string" || ref === "") return "未知负责人";
	if (!ref.startsWith("leader:")) return ROLE_LABELS[ref] ?? ref;
	const project = company?.projects?.[ref.slice("leader:".length)];
	if (project === undefined) return "未知负责人";
	return project.leaderName !== "" && project.leaderName !== undefined ? project.leaderName : project.name;
}

/** 从 instructions 里取出「直属上级是 …」那一行。 */
function superiorLine(instructions) {
	if (typeof instructions !== "string") return null;
	return instructions.split("\n").find((line) => line.includes("直属上级是")) ?? null;
}

/** 从「直属上级是 XXX。」里取出负责人名。 */
function superiorNameOf(line) {
	if (line === null) return null;
	const match = line.match(/直属上级是\s*(.+?)(?:。|$)/);
	return match === null ? null : match[1].trim();
}

/** 构造探针用的结构化快照。 */
function buildSnapshot(db) {
	const company = readLatestDocument(db, '"app.company"');
	const profiles = readDocumentsByKind(db, '"app.profile"');
	const agents = readDocumentsByKind(db, '"pi.agent"');

	const project = company?.projects?.[PROJECT_SLUG] ?? null;
	const staff = {};
	for (const definition of STAFF) {
		const key = `${PROJECT_SLUG}/${definition.name}`;
		const entry = company?.staff?.[key];
		if (entry === undefined) {
			staff[definition.name] = {
				key,
				present: false,
				conversationId: null,
				manager: null,
				managerLabel: null,
				profile: null,
				instructions: null,
				instructionsLine: null,
			};
			continue;
		}
		const conversationId = Number(entry.conversationId);
		const profile = profiles.get(conversationId);
		const agent = agents.get(conversationId);
		const line = superiorLine(agent?.instructions);
		staff[definition.name] = {
			key,
			present: true,
			archived: entry.archived === true,
			conversationId,
			manager: entry.manager,
			managerLabel: managerLabelOf(company, entry.manager),
			profile:
				profile === undefined
					? null
					: {
							title: profile.title ?? null,
							kind: profile.kind ?? null,
							project: profile.project ?? null,
							parent: profile.parent ?? null,
						},
			instructions: agent?.instructions ?? null,
			instructionsLine: line,
			instructionsSuperior: superiorNameOf(line),
		};
	}

	return {
		project:
			project === null
				? null
				: {
						slug: project.slug,
						name: project.name,
						leader: project.leader,
						leaderName: project.leaderName,
						status: project.status,
					},
		staff,
	};
}

/** 数据当前呈现的方向：before / after / mixed。 */
function observedDirection(snapshot) {
	const managers = STAFF.map((definition) => snapshot.staff[definition.name]?.manager ?? null);
	const legacy = STAFF.map((definition) => definition.legacyManager);
	if (managers.every((manager) => manager === LEADER_REF)) return "after";
	if (managers.every((manager, index) => manager === legacy[index])) return "before";
	return "mixed";
}

// ── 断言 ────────────────────────────────────────────────────────────────────

function createCheckCollector() {
	const results = [];
	return {
		results,
		add(name, pass, detail) {
			results.push({ name, pass: pass === true, detail: String(detail) });
		},
	};
}

/** 无论什么方向都应该成立的结构性断言。 */
function addStructuralChecks(collector, snapshot) {
	const project = snapshot.project;
	collector.add(
		"project:exists",
		project !== null,
		project === null ? `projects 里没有 ${PROJECT_SLUG}` : `project=${project.name}`,
	);
	collector.add(
		"project:leader=73",
		project?.leader === EXPECTED_LEADER,
		`leader=${project?.leader ?? "<missing>"}（期望 ${EXPECTED_LEADER}）`,
	);
	collector.add(
		"project:leaderName=许砚舟",
		project?.leaderName === EXPECTED_LEADER_NAME,
		`leaderName=${project?.leaderName ?? "<missing>"}（期望 ${EXPECTED_LEADER_NAME}）`,
	);

	for (const definition of STAFF) {
		const staff = snapshot.staff[definition.name];
		collector.add(
			`staff:${definition.name}:present`,
			staff.present === true && staff.archived !== true,
			staff.present ? `conversationId=${staff.conversationId} archived=${staff.archived ?? false}` : "名册里没有这名员工",
		);
		collector.add(
			`staff:${definition.name}:manager-resolvable`,
			typeof staff.manager === "string" && staff.manager !== "" && staff.managerLabel !== "未知负责人",
			`manager=${staff.manager ?? "<missing>"} → ${staff.managerLabel ?? "<missing>"}`,
		);
		const parent = staff.profile?.parent ?? null;
		collector.add(
			`staff:${definition.name}:profile-parent-compatible`,
			parent === null || parent === EXPECTED_LEADER,
			parent === null ? "无 parent 字段（旧字段已移除，可接受）" : `parent=${parent}（若存在必须为 ${EXPECTED_LEADER}）`,
		);
	}
}

/** 旧状态断言。 */
function addBeforeChecks(collector, snapshot) {
	for (const definition of STAFF) {
		const staff = snapshot.staff[definition.name];
		collector.add(
			`staff:${definition.name}:manager=${definition.legacyManager}`,
			staff.manager === definition.legacyManager,
			`manager=${staff.manager ?? "<missing>"}（迁移前期望 ${definition.legacyManager}）`,
		);
		collector.add(
			`staff:${definition.name}:instructions=${definition.legacyLabel}`,
			typeof staff.instructionsLine === "string" && staff.instructionsLine.includes(`直属上级是 ${definition.legacyLabel}`),
			`instructions 行=${staff.instructionsLine ?? "<missing>"}`,
		);
	}
}

/** 新状态断言。 */
function addAfterChecks(collector, snapshot) {
	for (const definition of STAFF) {
		const staff = snapshot.staff[definition.name];
		collector.add(
			`staff:${definition.name}:manager=${LEADER_REF}`,
			staff.manager === LEADER_REF,
			`manager=${staff.manager ?? "<missing>"}（迁移后期望 ${LEADER_REF}）`,
		);
		collector.add(
			`staff:${definition.name}:manager-label=许砚舟`,
			staff.managerLabel === EXPECTED_LEADER_NAME,
			`manager=${staff.manager ?? "<missing>"} 解析为 ${staff.managerLabel ?? "<missing>"}（期望 ${EXPECTED_LEADER_NAME}）`,
		);
		collector.add(
			`staff:${definition.name}:instructions含许砚舟`,
			typeof staff.instructionsLine === "string" && staff.instructionsLine.includes(`直属上级是 ${EXPECTED_LEADER_NAME}`),
			`instructions 行=${staff.instructionsLine ?? "<missing>"}`,
		);
	}
}

// ── 入口 ────────────────────────────────────────────────────────────────────

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (!existsSync(options.db)) throw new Error(`库文件不存在：${options.db}`);
	const db = new DatabaseSync(options.db, { readOnly: true });
	try {
		if (options.dump) {
			console.log(JSON.stringify(buildSnapshot(db), null, 2));
			return 0;
		}

		const snapshot = buildSnapshot(db);
		const collector = createCheckCollector();
		addStructuralChecks(collector, snapshot);

		const observed = observedDirection(snapshot);
		if (options.expect !== undefined) {
			collector.add(
				"direction:matches-expect",
				observed === options.expect,
				`数据方向=${observed}（--expect ${options.expect}）`,
			);
			if (options.expect === "before") addBeforeChecks(collector, snapshot);
			else addAfterChecks(collector, snapshot);
		} else {
			collector.add(
				"direction:recognized",
				observed === "before" || observed === "after",
				`数据方向=${observed}（未传 --expect，仅做一致性检查）`,
			);
			if (observed === "before") addBeforeChecks(collector, snapshot);
			if (observed === "after") addAfterChecks(collector, snapshot);
		}

		console.log(JSON.stringify(collector.results, null, 2));
		const failed = collector.results.filter((result) => !result.pass).length;
		console.log(`FAIL ${failed}/${collector.results.length}`);
		return failed === 0 ? 0 : 1;
	} finally {
		db.close();
	}
}

try {
	process.exitCode = main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`探针失败：${message}`);
	if (error instanceof UsageError) console.error(USAGE);
	process.exitCode = 1;
}
