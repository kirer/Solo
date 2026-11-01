/**
 * 示范插件的后端一半。
 *
 * 注意这里**一个 import 都没有**：插件需要的东西全在 `apply` 的参数里。这不只是省事，
 * 是那条边界 —— 插件不该 import 内核的任何内部实现，否则它就不是「加能力」，
 * 而是「另一个内核」，内核一改它就碎。
 *
 * 文件由 Node 直接跑（类型擦除），所以不能用 enum / namespace / 装饰器。
 * 这份 `Api` 只是本地注释用的形状，真正的契约在 `src/core/plugin/api.ts`。
 */
type Api = {
	readonly Type: { Object(properties: Record<string, never>): unknown };
	readonly text: (value: string) => unknown;
	tool(spec: {
		name: string;
		description: string;
		parameters: unknown;
		execute: () => Promise<unknown>;
	}): void;
	prompt(text: string): void;
};

export function apply(api: Api): void {
	api.tool({
		name: "clock",
		description: "看这台机器现在几点、在哪个时区。不确定今天的日期或时刻时用它，不要猜。",
		parameters: api.Type.Object({}),
		execute: async () => {
			const now = new Date();
			const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			return api.text(`${now.toLocaleString("zh-CN", { hour12: false })}（${zone}）`);
		},
	});

	// 提示词段：每个 agent 的提示词最后会多出这一段，改完重启生效。
	// 它必须是**静态文本**：塞时间戳会让提示词每轮都不一样，前缀缓存就没了。
	api.prompt("「示范」插件装着一个 clock 工具：问到现在几点、今天几号时用它，别自己推。");
}
