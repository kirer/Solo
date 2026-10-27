/**
 * 组织的纯类型与纯函数（无 IO）。
 *
 * 从 `company/docs.ts` 拆出来：`docs.ts` 里既有纯类型，又有 `defineDoc()`
 * （会 import 底层运行时）。`domain/` 层的判定逻辑需要前者，不该被后者拖上运行时。
 *
 * `company/docs.ts` 从这里 re-export，所以调用方的 import 路径不用改。
 */
/** 管理层岗位名。 */
export const MANAGEMENT_ROLES = ["ceo", "cto", "cfo", "cpo", "coo", "cmo", "chro"] as const;
export type ManagementRole = (typeof MANAGEMENT_ROLES)[number];

/** 「本项目负责人」这种上级引用的前缀，例如 `leader:ops-defect-loop`。 */
export const LEADER_REF_PREFIX = "leader:";

/**
 * 直属上级的引用：管理层岗位，或某个项目的负责人。
 *
 * **必须是字符串标量**，不能是对象：升级链把层级原样存进待决文档并用 `===`
 * 比较，对象经 JSON 落盘/恢复后引用必然不等，会让升级任务永远等不到答复
 * （表现为 30s 超时，不是报错）。用 `leader:<slug>` 还能让负责人换人时
 * 自动跟随，不需要迁移员工记录。
 */
export type ManagerRef = ManagementRole | `${typeof LEADER_REF_PREFIX}${string}`;

/** 岗位的中文显示名。 */
export const ROLE_LABELS: Record<ManagementRole, string> = {
	ceo: "CEO",
	cto: "CTO",
	cfo: "CFO",
	cpo: "CPO",
	coo: "COO",
	cmo: "CMO",
	chro: "CHRO",
};

/** 模型引用（provider + modelId），与底层结构一致但由本层拥有。 */
export type ModelRef = { readonly provider: string; readonly modelId: string };

/** 可分配模型的清单项，带价格以便 CHRO 判断成本。 */
export type ModelOption = {
	readonly id: string;
	readonly provider: string;
	readonly modelId: string;
	readonly label: string;
	/** 美元 / 百万输入 token。 */
	readonly inputPerMTok: number;
	/** 美元 / 百万输出 token。 */
	readonly outputPerMTok: number;
};

/**
 * 解析模型引用：把用户/配置里写的字符串解析成 catalog 里的一条模型。
 *
 * 支持三种写法（与 `runtime/models.ts` 的 `resolveDefaultModel` 识别口径一致）：
 * - catalog 里**唯一**的 id（`auto/deepseek-v4.1-flash`）；
 * - catalog 里**唯一**的 modelId；
 * - `provider/modelId`（如 `commandcode/auto/deepseek-v4.1-flash`）。
 *
 * **判别式返回值，不静默回退**：认不出来就返回 `{ ok: false, reason }`，
 * 由调用方决定怎么办——招聘场景必须报错，配置场景可以回退默认值。
 * 这是刻意设计：**只共享「识别能力」，不共享「失败语义」**。
 * 两边的处理策略差异是业务契约，不能在这里被抹平：
 * - `staff_hire` 选错模型 → 员工起来 `no_model` 或烧错成本，**必须招聘时拦住**；
 * - `settings.models.default` 写坏 → 配置层宽容，回退默认值。
 *
 * **实现约束（改动前必读）**：
 * 必须用 `indexOf("/")` 拆**第一个**斜杠，**禁止**改成 `lastIndexOf`。
 * 原因：`modelId` 自身可能含斜杠——本平台的 `auto/deepseek-v4.1-flash`
 * 就是「路由组前缀 + 模型名」的整串，`provider/modelId` 实际是三段
 * `commandcode/auto/deepseek-v4.1-flash`。用 `lastIndexOf` 会拆成
 * `provider="commandcode/auto"`、`modelId="deepseek-v4.1-flash"`，
 * **必然与 catalog 失配**（catalog 里 provider 只有 `commandcode`）。
 */
export function resolveModelOption(
	reference: string | undefined,
	catalog: readonly ModelOption[],
):
	| { readonly ok: true; readonly option: ModelOption }
	| { readonly ok: false; readonly reason: "empty" | "unknown" | "ambiguous" } {
	const value = (reference ?? "").trim();
	if (value === "") return { ok: false, reason: "empty" };

	// ① 先按 id / modelId 精确匹配。
	//    用 filter 而不是 find：命中多条时宁可报 ambiguous，也不静默取第一条——
	//    否则 catalog 里出现同 modelId 的两个 provider 时，会随机选一个。
	const byId = catalog.filter((item) => item.id === value || item.modelId === value);
	const only = byId[0];
	if (byId.length === 1 && only !== undefined) return { ok: true, option: only };
	if (byId.length > 1) return { ok: false, reason: "ambiguous" };

	// ② 再按 provider/modelId 拆（必须 indexOf 首个斜杠，理由见函数注释）。
	//    slash > 0：排除 "/model" 这种首个字符就是斜杠的畸形输入。
	const slash = value.indexOf("/");
	if (slash > 0) {
		const provider = value.slice(0, slash);
		const modelId = value.slice(slash + 1);
		if (modelId !== "") {
			const hit = catalog.find((item) => item.provider === provider && item.modelId === modelId);
			if (hit !== undefined) return { ok: true, option: hit };
		}
	}

	return { ok: false, reason: "unknown" };
}

/** 项目状态。 */
export type ProjectStatus = "planning" | "active" | "paused" | "done" | "terminated" | "archived";

/** 项目索引项。 */
export type ProjectEntry = {
	readonly slug: string;
	readonly name: string;
	/** 工作空间绝对路径。 */
	readonly workspace: string;
	/** 项目负责人会话标识。 */
	readonly leader: number;
	/** 项目负责人的名字（显示用）。 */
	readonly leaderName: string;
	readonly status: ProjectStatus;
	/** 需求摘要。 */
	readonly brief: string;
	readonly createdAt: number;
	/** 终止记录：谁、为什么、什么时候。只有 status 为 terminated 时有。 */
	terminated?: {
		at: number;
		by: string;
		reason: string;
	};
};

/** 员工名册项。 */
export type StaffEntry = {
	/** 员工名（项目内唯一）。 */
	readonly name: string;
	/** 员工角色（产品 / 设计 / 开发 / 测试 …）。名册上的标签，不决定能力。 */
	readonly role: string;
	/** 职责：招聘时上级写下的一段话（拼进提示词，展示在档案页）。 */
	readonly duty: string;
	/**
	 * 被授予的原子执行工具名，按招聘时的声明保存，重启后据此重建能力包。
	 *
	 * 名字可带一段可选的目录范围：`"write"` 是整个工作空间，
	 * `"write:src/"` 是只允许写工作空间里的 `src/`（ADR-035）。
	 * 范围只对 `read` / `write` / `edit` 有意义；`bash` 无法用路径前缀约束，
	 * 它本身就是全盘访问，所以隔离靠「不给 bash」。
	 */
	readonly tools: string[];
	readonly conversationId: number;
	/** 所属项目 slug。 */
	readonly project: string;
	/** 直属上级：管理层岗位，或本项目负责人（`leader:<slug>`）。 */
	readonly manager: ManagerRef;
	/** 生效模型。 */
	readonly model: ModelRef;
	readonly hiredAt: number;
	readonly archived: boolean;
};

/** 公司索引：组织状态的唯一真相源。 */
export type CompanyState = {
	company: {
		name: string;
		createdAt: number;
	};
	/** 管理层岗位 → 会话标识。 */
	roles: Record<string, number>;
	/** 项目 slug → 项目。 */
	projects: Record<string, ProjectEntry>;
	/** `${project}/${name}` → 员工。 */
	staff: Record<string, StaffEntry>;
	/** 已归档的会话标识（底层无删除 API，用软删标记）。 */
	archived: number[];
	/** 公司默认模型。 */
	defaultModel: ModelRef;
	/** 项目工作空间的根目录。删除项目时用它校验路径，防止误删。 */
	workspaceRoot: string;
	/** 可分配模型清单。 */
	modelCatalog: ModelOption[];
};


// ── 上级引用（ManagerRef）的解析 ──────────────────────────────────────────────
//
// 所有展示、提示词与升级路由都必须走这里，禁止再直接 ROLE_LABELS[person.manager]：
// 传入 `leader:<slug>` 时查表会得到 undefined，且不会报错（静默显示「undefined」）。

/** 是否「本项目负责人」引用。 */
export function isLeaderManagerRef(ref: string): ref is `${typeof LEADER_REF_PREFIX}${string}` {
	return ref.startsWith(LEADER_REF_PREFIX);
}

/** 从 `leader:<slug>` 取出项目 slug；不是负责人引用时返回 undefined。 */
export function leaderSlugOf(ref: string): string | undefined {
	return isLeaderManagerRef(ref) ? ref.slice(LEADER_REF_PREFIX.length) : undefined;
}

/** 上级引用的显示名：岗位名，或项目负责人的名字。 */
export function managerLabelOf(state: CompanyState | undefined, ref: ManagerRef): string {
	if (!isLeaderManagerRef(ref)) return ROLE_LABELS[ref] ?? ref;
	const slug = leaderSlugOf(ref);
	const project = slug === undefined ? undefined : state?.projects[slug];
	if (project === undefined) return "未知负责人";
	return project.leaderName !== "" ? project.leaderName : project.name;
}

/** 上级引用对应的会话标识；解析不到时返回 undefined。 */
export function managerConversationOf(state: CompanyState | undefined, ref: ManagerRef): number | undefined {
	if (!isLeaderManagerRef(ref)) {
		const id = state?.roles[ref];
		return id === undefined ? undefined : Number(id);
	}
	const slug = leaderSlugOf(ref);
	const project = slug === undefined ? undefined : state?.projects[slug];
	return project?.leader;
}

/**
 * 引用是否合法：管理层岗位，或「指定项目的负责人」。
 *
 * 跨项目负责人一律不合法——员工只能向本项目负责人汇报，
 * 否则会绕过项目边界（一个项目的负责人指挥另一个项目的人）。
 */
export function isValidManagerRef(
	state: CompanyState | undefined,
	ref: string,
	projectSlug?: string,
): boolean {
	if ((MANAGEMENT_ROLES as readonly string[]).includes(ref)) return true;
	const slug = leaderSlugOf(ref);
	if (slug === undefined || slug === "") return false;
	if (projectSlug !== undefined && slug !== projectSlug) return false;
	return state?.projects[slug] !== undefined;
}

