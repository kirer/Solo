/**
 * 能力目录（声明式）：谁能用什么工具、哪些默认给、哪些靠搜索按需加载。
 *
 * 设计见 `docs/design/COMMS-REFACTOR.md` §4 与 ADR-032。
 *
 * ── 为什么需要「按需加载」 ──
 *
 * 工具越多，模型选错的概率越高。CEO 现在有 25 个工具，其中真正每轮都要用的
 * 只有 5–6 个（whoami / say / ask / task_list / task_update）。
 * 其余（roundtable / project_delete / staff_rename …）一周用一次。
 *
 * `deferred: true` 的工具**不直接出现在模型面前**：
 * - 模型调 `tool_search("圆桌")` → BM25 检索 → 命中后 `control.addTools` 写进会话
 * - 从下一次请求起，这个工具就「长」在会话上了（`modelTools.add`，跨压缩保留）
 *
 * 收益：核心工具少 → 选择准确率高；长尾工具不消失 → 能力不打折。
 *
 * ── 为什么不给模型「动态创建工具」 ──
 *
 * 工具是 TypeScript 函数，注册即任意代码执行。能力目录是静态代码（受 review），
 * 装配是动态的。这条边界不能破。
 */
import type { Extension } from "../runtime/index.ts";

/** 能力分层。 */
export const CAPABILITY_LAYERS = ["universal", "exec", "staff", "leader", "management", "ceo"] as const;
export type CapabilityLayer = (typeof CAPABILITY_LAYERS)[number];

/** 一条能力。 */
export type Capability = {
	/** 工具名（与 `ManagementToolset` 的映射键一致）。 */
	readonly name: string;
	readonly layer: CapabilityLayer;
	/**
	 * 是否**默认**直接给模型。
	 *
	 * `false` = 标记为 `deferred`，模型需要时用 `tool_search` 找到它。
	 * 判断标准：**每一轮都可能用到**才给 true。
	 */
	readonly core: boolean;
	/** 一句话说明（供文档与诊断；真实描述在工具定义里）。 */
	readonly summary: string;
};

/**
 * 全量能力目录。
 *
 * 顺序有意义：`core: true` 的按这个顺序出现在模型面前，
 * 靠前的更容易被选中（模型对靠前的工具注意力更高）。
 */
export const CAPABILITIES: readonly Capability[] = [
	// ── 通用（每轮都可能用）──
	{ name: "whoami", layer: "universal", core: true, summary: "我是谁：角色、上级、下属、频道、任务" },
	{ name: "inbox", layer: "universal", core: true, summary: "未读汇总与 @ 我的问题" },
	{ name: "say", layer: "universal", core: true, summary: "频道发言（不 @）" },
	{ name: "ask", layer: "universal", core: true, summary: "频道提问 + @ 某人" },
	{ name: "read_channel", layer: "universal", core: true, summary: "读频道历史" },
	{ name: "task_list", layer: "universal", core: true, summary: "我的任务" },
	{ name: "task_update", layer: "universal", core: true, summary: "报进度 / 完成（done 必须带 evidence）" },

	// ── 通用 ──
	// my_capabilities 必须是核心：它是「回答能不能做某事之前先自查」的入口，
	// 如果它自己被延迟，模型就查不到自己的工具清单（自举悖论）。
	{ name: "my_capabilities", layer: "universal", core: true, summary: "我当前真实可用的工具清单" },

	// ── 记忆（#12）──
	// memory_search 是核心：回答「以前怎么处理的」之前都要先查，
	// 藏起来就等于逼模型凭印象答。memory_write 是低频动作，延迟。
	{ name: "memory_search", layer: "universal", core: true, summary: "按关键词检索分层记忆（个人 / 项目 / 公司）" },
	{ name: "memory_write", layer: "universal", core: false, summary: "把一条经验写进记忆（层级由角色决定）" },

	// ── 员工 ──
	{ name: "escalate", layer: "staff", core: true, summary: "向上逐级上报" },

	// ── 负责人 / 管理层 ──
	{ name: "assign_task", layer: "leader", core: true, summary: "建任务派给下属（必须有验收标准）" },
	{ name: "task_create", layer: "leader", core: false, summary: "建任务（assign_task 的直白版，参数更严格）" },
	{ name: "ask_role", layer: "leader", core: true, summary: "找某人问一句（不限方向）" },
	{ name: "staff_list", layer: "leader", core: true, summary: "项目名册与忙碌状态" },
	{ name: "org_tree", layer: "leader", core: false, summary: "公司组织架构" },
	{ name: "project_list", layer: "leader", core: true, summary: "项目清单" },
	{ name: "project_plan", layer: "leader", core: false, summary: "写 PLAN.md" },
	{ name: "project_status", layer: "leader", core: false, summary: "推进项目状态" },
	{ name: "decide", layer: "leader", core: false, summary: "拍板并留痕" },
	{ name: "pending_list", layer: "leader", core: false, summary: "等我拍板的问题" },
	{ name: "answer_pending", layer: "leader", core: false, summary: "回答一条等我拍板的问题" },
	{ name: "dispose_pending", layer: "leader", core: false, summary: "驳回 / 标记已解决" },

	// ── 管理层专属 ──
	{ name: "project_create", layer: "management", core: false, summary: "立项" },
	{ name: "project_terminate", layer: "management", core: false, summary: "终止项目（两步流程第一步）" },
	{ name: "project_delete", layer: "management", core: false, summary: "彻底删除项目（须已终止）" },
	{ name: "staff_hire", layer: "management", core: false, summary: "招聘员工" },
	{ name: "staff_rename", layer: "management", core: false, summary: "员工改名" },
	{ name: "staff_reassign", layer: "management", core: false, summary: "变更员工直属上级" },
	{ name: "staff_archive", layer: "management", core: false, summary: "归档员工" },
	{ name: "budget_check", layer: "management", core: false, summary: "查预算" },
	{ name: "cost_report", layer: "management", core: false, summary: "成本报告" },
	{ name: "review_architecture", layer: "management", core: false, summary: "技术评审" },
	{ name: "roundtable", layer: "management", core: false, summary: "开圆桌讨论" },
	{ name: "roundtable_minutes", layer: "management", core: false, summary: "查圆桌纪要" },

	// ── CEO 专属 ──
	{ name: "take_over_pending", layer: "ceo", core: false, summary: "把老板级待办接管回 CEO 层" },
];

/** 按名字查能力。 */
export function capabilityOf(name: string): Capability | undefined {
	return CAPABILITIES.find((capability) => capability.name === name);
}

/** 某层的全部能力名。 */
export function capabilitiesOfLayer(layer: CapabilityLayer): readonly string[] {
	return CAPABILITIES.filter((capability) => capability.layer === layer).map((capability) => capability.name);
}

/**
 * 把一组工具名拆成「默认给」与「延迟加载」。
 *
 * 传入的是某个角色声明的能力名（可能含未知项），返回过滤后的两段。
 */
export function splitCore(names: readonly string[]): {
	readonly core: readonly string[];
	readonly deferred: readonly string[];
} {
	const core: string[] = [];
	const deferred: string[] = [];
	for (const name of names) {
		const capability = capabilityOf(name);
		// 目录里没有的能力按「默认给」处理：新加工具时不会因为它没登记就突然消失
		if (capability === undefined || capability.core) core.push(name);
		else deferred.push(name);
	}
	return { core, deferred };
}

/**
 * 能力目录的自检：每个能力都必须能在 `ManagementToolset` 里找到实现。
 *
 * 这条检查曾经能抓到真实 bug：`dispose_pending` / `take_over_pending` 定义了、
 * 也注入了，但没进 `CAPABILITY_TO_TOOL` 映射表，于是任何 agent 都拿不到，
 * 只有老板的 HTTP 入口能用。现在由 `test/unit/capabilities.test.ts` 钉住。
 */
export function auditCapabilities(available: ReadonlySet<string>): readonly string[] {
	return CAPABILITIES.map((capability) => capability.name).filter((name) => !available.has(name));
}

/** 诊断用：能力目录的分层统计。 */
export function describeCatalog(): string {
	const lines = ["能力目录："];
	for (const layer of CAPABILITY_LAYERS) {
		const items = CAPABILITIES.filter((capability) => capability.layer === layer);
		if (items.length === 0) continue;
		const core = items.filter((capability) => capability.core).map((capability) => capability.name);
		const deferred = items.filter((capability) => !capability.core).map((capability) => capability.name);
		lines.push(`  ${layer}（${items.length}）：核心 ${core.length} / 延迟 ${deferred.length}`);
		if (deferred.length > 0) lines.push(`    延迟：${deferred.join("、")}`);
	}
	return lines.join("\n");
}

/** 类型占位：让 `Extension` 的 import 不被 tree-shake（目录本身不构造扩展）。 */
export type { Extension };
