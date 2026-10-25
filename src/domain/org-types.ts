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
	/** 员工角色（产品 / 设计 / 开发 / 测试 …）。 */
	readonly role: string;
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

