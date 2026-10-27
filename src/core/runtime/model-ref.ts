/**
 * 模型引用与解析（纯类型 + 纯函数，无 IO）。
 *
 * 全系统只有一件事需要它：把 `workspace/settings.json` 里用户手写的一个字符串
 * （`auto/deepseek-v4.1-flash`）认成一份具体模型。这件事只依赖 catalog 的形状，
 * 跟公司概念（人、项目、频道）无关，所以它属于 `core/runtime`。
 */

/** 模型引用（provider + modelId），与底层结构一致但由本层拥有。 */
export type ModelRef = { readonly provider: string; readonly modelId: string };

/** 可分配模型的清单项，带价格以便判断成本。 */
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
 * 支持三种写法：
 * - catalog 里**唯一**的 id（`auto/deepseek-v4.1-flash`）；
 * - catalog 里**唯一**的 modelId；
 * - `provider/modelId`（如 `commandcode/auto/deepseek-v4.1-flash`）。
 *
 * **判别式返回值，不静默回退**：认不出来就返回 `{ ok: false, reason }`，
 * 由调用方决定怎么办——写配置文件与跑一个会话，失败语义不一样。
 * 这是刻意设计：**只共享「识别能力」，不共享「失败语义」**。
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
