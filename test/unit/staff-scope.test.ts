/**
 * 能力范围：`write:src/` 只能写 `src/` 之内（ADR-035）。
 *
 * 为什么这条测试必须存在：真实验收里 `dino-lead` 与 `dino-dev` 都被授予了
 * 整工作空间的 `write`，都被派了「写 index.html」，dev 覆盖了 lead 已经自测过的
 * 版本（`docs/roundtable/ACCEPTANCE-dino.md`「二、发现的问题 → 1（严重）」）。
 * 只测「有 write 就写得了文件」是不够的，必须钉住**「写 src 之外会被拒绝」**，
 * 否则权限声明又退回到「有没有 write」这一层。
 *
 * 这里不启动公司、不开数据库：`scopedTools()` 只依赖 `api.env`，
 * 而 `createEnvironmentRegistry()` 能单独造一个真实文件系统环境。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { assertGrantable, assertGrantableTools, toolsForNames } from "../../src/company/staff-tools.ts";
import { BACKGROUND_CONTEXT, createEnvironmentRegistry } from "../../src/runtime/index.ts";
import { createTestContext } from "../support.ts";

/** 造一个工作空间 + 一个带 env 的工具调用上下文。 */
async function setup(toolNames: readonly string[]) {
	const ctx = await createTestContext();
	const workspace = join(ctx.dir, "projects", "alpha");
	await mkdir(join(workspace, "src"), { recursive: true });
	await mkdir(join(workspace, "docs"), { recursive: true });
	await mkdir(join(workspace, "src-evil"), { recursive: true });

	const environments = createEnvironmentRegistry();
	const env = await environments.factory({ conversationId: 1, cwd: workspace }, BACKGROUND_CONTEXT);
	if (env === undefined) throw new Error("测试环境构造失败");

	/** `api` 只用到 `env`，其余字段本次不碰。 */
	const api = { conversationId: 1, env } as never;
	const tool = (name: string) => {
		const found = toolsForNames(toolNames).find((candidate) => candidate.name === name);
		if (found === undefined) throw new Error(`没有这个工具：${name}`);
		return found;
	};

	return {
		ctx,
		workspace,
		tool,
		run: async (name: string, args: Record<string, unknown>) => tool(name).execute(args as never, api, BACKGROUND_CONTEXT),
		async cleanup() {
			await environments.cleanup(BACKGROUND_CONTEXT);
			await ctx.cleanup();
		},
	};
}

describe("write:src/ —— 只能写 src/ 之内", () => {
	test("写 src/a.js 放行，文件真的落盘", async () => {
		const s = await setup(["write:src/"]);
		try {
			await s.run("write", { path: "src/a.js", content: "export const a = 1;\n" });
			const written = await import("node:fs/promises").then((fs) => fs.readFile(join(s.workspace, "src", "a.js"), "utf8"));
			expect(written).toBe("export const a = 1;\n");
		} finally {
			await s.cleanup();
		}
	});

	test("拒绝 ../escape.js（不许用 .. 跳出去）", async () => {
		const s = await setup(["write:src/"]);
		try {
			await expect(s.run("write", { path: "../escape.js", content: "x" })).rejects.toThrow(/被限制在 `src\/` 之内/);
		} finally {
			await s.cleanup();
		}
	});

	test("拒绝绝对路径 /tmp/abs.js", async () => {
		const s = await setup(["write:src/"]);
		try {
			await expect(s.run("write", { path: "/tmp/abs.js", content: "x" })).rejects.toThrow(/被限制在 `src\/` 之内/);
		} finally {
			await s.cleanup();
		}
	});

	test("拒绝 src-evil/x.js（前缀相同但不在目录之内）", async () => {
		const s = await setup(["write:src/"]);
		try {
			// 边界必须是分隔符：`.../src` 不能匹配 `.../src-evil`
			await expect(s.run("write", { path: "src-evil/x.js", content: "x" })).rejects.toThrow(/被限制在 `src\/` 之内/);
		} finally {
			await s.cleanup();
		}
	});

	test("越界报错文案指出允许目录与实际路径（上级能据此判断该不该批）", async () => {
		const s = await setup(["write:src/"]);
		try {
			const failure = await s
				.run("write", { path: "../evil.js", content: "x" })
				.then(() => undefined)
				.catch((error: unknown) => error as Error);
			expect(failure).toBeDefined();
			expect(failure?.message).toContain("src/");
			expect(failure?.message).toContain("../evil.js");
			expect(failure?.message).toContain("write:src/");
		} finally {
			await s.cleanup();
		}
	});

	test("写入不存在的子目录仍然可以（write 自己建父目录，范围不改变语义）", async () => {
		const s = await setup(["write:src/nested/"]);
		try {
			await s.run("write", { path: "src/nested/deep/a.js", content: "1\n" });
			const text = await import("node:fs/promises").then((fs) => fs.readFile(join(s.workspace, "src/nested/deep/a.js"), "utf8"));
			expect(text).toBe("1\n");
		} finally {
			await s.cleanup();
		}
	});

	test("绝对路径落在授权目录里也放行（归一化不是「只许相对路径」）", async () => {
		const s = await setup(["write:src/"]);
		try {
			await s.run("write", { path: join(s.workspace, "src", "b.js"), content: "2\n" });
			const text = await import("node:fs/promises").then((fs) => fs.readFile(join(s.workspace, "src", "b.js"), "utf8"));
			expect(text).toBe("2\n");
		} finally {
			await s.cleanup();
		}
	});
});

describe("read:docs/ —— 只限制读，不误伤别的工具", () => {
	test("读 docs/x.md 放行，读 src/a.js 拒绝", async () => {
		const s = await setup(["read:docs/"]);
		try {
			await writeFile(join(s.workspace, "docs", "x.md"), "# hi\n");
			await writeFile(join(s.workspace, "src", "a.js"), "x\n");
			await expect(s.run("read", { path: "docs/x.md" })).resolves.toBeDefined();
			await expect(s.run("read", { path: "src/a.js" })).rejects.toThrow(/被限制在 `docs\/` 之内/);
		} finally {
			await s.cleanup();
		}
	});
});

describe("无范围的 write —— 向后兼容", () => {
	test("老写法 write 仍能写任意路径", async () => {
		const s = await setup(["write"]);
		try {
			await s.run("write", { path: "docs/a.md", content: "1\n" });
			await s.run("write", { path: "src/a.js", content: "2\n" });
			await s.run("write", { path: "../outside.js", content: "3\n" });
			const fs = await import("node:fs/promises");
			expect(await fs.readFile(join(s.workspace, "docs", "a.md"), "utf8")).toBe("1\n");
			expect(await fs.readFile(join(s.workspace, "src", "a.js"), "utf8")).toBe("2\n");
			expect(await fs.readFile(join(s.ctx.dir, "projects", "outside.js"), "utf8")).toBe("3\n");
		} finally {
			await s.cleanup();
		}
	});

	test("write + write:src/ 同时授予：无范围的优先，工具名仍然只有一个 write", async () => {
		const s = await setup(["write", "write:src/"]);
		try {
			const names = toolsForNames(["write", "write:src/"]).map((tool) => tool.name);
			// 模型不该看到两个同名不同义的工具
			expect(names).toEqual(["write"]);
			// 无范围覆盖全空间：src 之外也写作成功
			await s.run("write", { path: "docs/a.md", content: "1\n" });
		} finally {
			await s.cleanup();
		}
	});

	test("带范围时对模型暴露的名字仍是基名 write", async () => {
		expect(toolsForNames(["write:src/"]).map((tool) => tool.name)).toEqual(["write"]);
		expect(toolsForNames(["read:docs/", "edit:src/"]).map((tool) => tool.name)).toEqual(["read", "edit"]);
	});
});

describe("assertGrantable 对带范围的名字", () => {
	test("合法范围通过", () => {
		expect(() => assertGrantable("write:src/")).not.toThrow();
		expect(() => assertGrantable("read:docs/")).not.toThrow();
		expect(() => assertGrantable("edit:src/nested/")).not.toThrow();
		// 无 scope 的老写法照样通过
		expect(() => assertGrantable("write")).not.toThrow();
	});

	test("绝对路径范围报错", () => {
		expect(() => assertGrantable("write:/abs/")).toThrow(/不能是绝对路径/);
	});

	test("含 .. 的范围报错", () => {
		expect(() => assertGrantable("write:../x/")).toThrow(/不能包含 "\.\."/);
	});

	test("基名不认识时仍按未知工具报（范围不是免死金牌）", () => {
		expect(() => assertGrantable("bogus:x/")).toThrow(/未知工具/);
	});

	test("bash 不能带范围", () => {
		expect(() => assertGrantable("bash:src/")).toThrow(/bash 不支持目录范围/);
	});

	test("空范围报错", () => {
		expect(() => assertGrantable("write:")).toThrow(/目录范围是空的/);
	});

	test("批量校验也会拦住越界声明", () => {
		expect(() => assertGrantableTools(["read", "write:src/"])).not.toThrow();
		expect(() => assertGrantableTools(["read", "write:/abs/"])).toThrow(/不能是绝对路径/);
	});
});

describe("scope 归一化", () => {
	test("./ 前缀与 Windows 分隔符视作同一件事，工具名仍是基名", () => {
		expect(toolsForNames(["write:./src/"]).map((tool) => tool.name)).toEqual(["write"]);
		expect(toolsForNames(["write:src\\"]).map((tool) => tool.name)).toEqual(["write"]);
	});
});
