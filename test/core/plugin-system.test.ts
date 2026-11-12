/**
 * 插件系统动作的五条硬线。每条至少一例，**松一条就红**。
 *
 * ① 绝对路径不从插件手里过：插件只给相对路径，路径由内核拼；
 * ② `realpath` 复判、软链接不跟、只收文件、出工作区就拒；
 * ③ 默认全不给；批准写回 `plugin.md`；升级新增的权限要重新问；
 * ④ 每次动作落一条审计（哪个插件、什么动作、什么时候、开没开成）；
 * ⑤ 文件树插件接上三个动作（原先的「打开所在文件位置」）。
 *
 * 还有一个没说但必须有：**没有 exec**。宿主根本不实现「跑一条命令」这个动作，
 * 这里钉住「动作表里就三个」。
 */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	SYSTEM_ACTION_DETAILS,
	SYSTEM_ACTION_LABELS,
	SYSTEM_ACTIONS,
	createSystemActions,
	loadPlugins,
	parsePermissions,
	pendingPermissions,
	resolveInside,
	writePluginGrants,
	readPluginManifest,
} from "../../src/core/plugin/index.ts";
import type { SystemActor, SystemAudit, PluginScope } from "../../src/core/plugin/index.ts";

const boxes: string[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

/** 一个临时组织：插件根 + 工作区 + 日志。返回绝对路径，测试自己往里放东西。 */
async function box(): Promise<{ root: string; pluginsRoot: string; workspace: string; area: string; logs: string }> {
	const root = await mkdtemp(join(tmpdir(), "plugin-system-"));
	boxes.push(root);
	const pluginsRoot = join(root, "plugins");
	const workspace = join(root, "app");
	const area = join(root, "space");
	const logs = join(root, "logs");
	await mkdir(pluginsRoot, { recursive: true });
	await mkdir(workspace, { recursive: true });
	await mkdir(area, { recursive: true });
	await mkdir(logs, { recursive: true });
	return { root, pluginsRoot, workspace, area, logs };
}

/** 记下所有请求的假宿主。真 Electron 那边接的是 `shell` / `clipboard`。 */
function spyActor(): { actor: SystemActor; acts: { action: string; path: string }[]; texts: string[] } {
	const acts: { action: string; path: string }[] = [];
	const texts: string[] = [];
	return {
		acts,
		texts,
		actor: {
			act: async (action, absolutePath) => {
				acts.push({ action, path: absolutePath });
			},
			copyText: async (text) => {
				texts.push(text);
			},
		},
	};
}

async function audits(logs: string): Promise<readonly SystemAudit[]> {
	const text = await readFile(join(logs, "tools.jsonl"), "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as SystemAudit)
		.filter((entry) => entry.kind === "plugin-system");
}

const scopeOf =
	(area: string): ((channelId: string) => Promise<PluginScope | undefined>) =>
	async (channelId) =>
		channelId === "c1"
			? { kind: "group" as const, title: "测试频道", root: area, label: "测试" }
			: undefined;

describe("硬线①：绝对路径不从插件手里过", () => {
	it("插件传 `../`、绝对路径、`~`、NUL 全部拒，且一次都没到宿主", async () => {
		const { area } = await box();
		const spy = spyActor();
		const act = createSystemActions({
			plugin: "t",
			active: ["system.reveal"],
			scope: scopeOf(area),
			actor: spy.actor,
		});

		await expect(act({ action: "system.reveal", channelId: "c1", path: "../x.png" })).rejects.toThrow(/不许有 \.\./);
		await expect(act({ action: "system.reveal", channelId: "c1", path: "/etc/hosts" })).rejects.toThrow(/相对路径/);
		await expect(act({ action: "system.reveal", channelId: "c1", path: "~/a.png" })).rejects.toThrow(/不认 ~/);
		await expect(act({ action: "system.reveal", channelId: "c1", path: "a\0.png" })).rejects.toThrow(/NUL/);
		expect(spy.acts).toEqual([]);
	});
});

describe("硬线②：realpath 复判、软链接不跟、只收文件", () => {
	it("指向外面的软链接拒；目录拒；文件放行", async () => {
		const { root, area } = await box();
		await writeFile(join(area, "ok.png"), "x");
		await writeFile(join(root, "outside.png"), "x");
		await symlink(join(root, "outside.png"), join(area, "escape.png"));
		await mkdir(join(area, "adir"), { recursive: true });

		const spy = spyActor();
		const act = createSystemActions({
			plugin: "t",
			active: ["system.reveal", "system.open"],
			scope: scopeOf(area),
			actor: spy.actor,
		});

		await expect(act({ action: "system.reveal", channelId: "c1", path: "escape.png" })).rejects.toThrow(/软链接/);
		await expect(act({ action: "system.open", channelId: "c1", path: "adir" })).rejects.toThrow(/只收文件/);
		await act({ action: "system.reveal", channelId: "c1", path: "ok.png" });
		// 交给宿主的是 `realpath` 之后的绝对路径：macOS 的 `/var` 本身就是个软链接，
		// 原样交出去会被挡在「不跟软链接」那条前面，所以这里按真实路径比。
		expect(spy.acts).toEqual([{ action: "reveal", path: join(await realpath(area), "ok.png") }]);
	});

	it("`resolveInside` 单独也守得住：根是软链接时按 realpath 判", async () => {
		const { root, area } = await box();
		await mkdir(join(root, "real", "inside"), { recursive: true });
		await writeFile(join(root, "real", "inside", "f.txt"), "x");
		await symlink(join(root, "real"), join(root, "alias"));
		// 根传 alias/inside，真实路径在 real/inside —— 同一个地方，应该放行。
		const ok = await resolveInside(join(root, "alias", "inside"), "f.txt", { fileOnly: true });
		expect("absolute" in ok).toBe(true);
		const bad = await resolveInside(join(root, "alias", "inside"), "../../../etc/hosts", { fileOnly: true });
		expect("reason" in bad).toBe(true);
	});

	it("全员频道没有工作区：不是回退到某个目录，是拒", async () => {
		const { area } = await box();
		const spy = spyActor();
		const act = createSystemActions({ plugin: "t", active: ["system.reveal"], scope: scopeOf(area), actor: spy.actor });
		await expect(act({ action: "system.reveal", channelId: "all", path: "a.png" })).rejects.toThrow(/没有工作区/);
		expect(spy.acts).toEqual([]);
	});
});

describe("硬线③：默认全不给、批准写回、升级重问", () => {
	it("动作表就三个，没有 exec 这一类", () => {
		expect([...SYSTEM_ACTIONS]).toEqual(["system.reveal", "system.copyText", "system.open"]);
	});

	it("声明了但没批 = 调了抛错；批了才动", async () => {
		const { area } = await box();
		await writeFile(join(area, "a.png"), "x");
		const spy = spyActor();

		const closed = createSystemActions({ plugin: "t", active: [], scope: scopeOf(area), actor: spy.actor });
		await expect(closed({ action: "system.reveal", channelId: "c1", path: "a.png" })).rejects.toThrow(/没有声明或没有被批准/);
		expect(spy.acts).toEqual([]);

		const open = createSystemActions({
			plugin: "t",
			active: ["system.reveal"],
			scope: scopeOf(area),
			actor: spy.actor,
		});
		await open({ action: "system.reveal", channelId: "c1", path: "a.png" });
		expect(spy.acts).toHaveLength(1);
	});

	it("写回 `plugin.md` 只认清单里声明过的；不认识的权限名当场拒", async () => {
		const { pluginsRoot } = await box();
		await mkdir(join(pluginsRoot, "demo"), { recursive: true });
		await writeFile(
			join(pluginsRoot, "demo", "plugin.md"),
			["---", "name: 演示", "permissions: system.reveal, system.open", "---", "", "正文", ""].join("\n"),
		);

		await writePluginGrants(pluginsRoot, "demo", ["system.reveal"]);
		const read = await readPluginManifest(pluginsRoot, "demo");
		if ("error" in read) throw new Error(read.error);
		expect(read.manifest.granted).toEqual(["system.reveal"]);
		expect(read.manifest.pending).toEqual(["system.open"]);

		// 没声明的不能批（否则手写一行就等于凭空多一个动作）。
		await expect(writePluginGrants(pluginsRoot, "demo", ["system.copyText"])).rejects.toThrow(/没有在 permissions 里声明/);
		// 不认识的名字也要拒。
		await expect(writePluginGrants(pluginsRoot, "demo", ["system.reveal", "system.openUrl"])).rejects.toThrow(/不认识/);
	});

	it("升级加了新权限：老的不再问，新的必须重问", async () => {
		expect(pendingPermissions(["system.reveal", "system.open"], ["system.reveal"])).toEqual(["system.open"]);
		// 删掉又要回来的那条也要重问（删掉那一刻起人就没再批过）。
		expect(pendingPermissions(["system.reveal"], [])).toEqual(["system.reveal"]);
		expect(parsePermissions("[system.reveal, system.open]")).toEqual(["system.reveal", "system.open"]);
		expect(parsePermissions("- system.reveal\n- system.copyText")).toEqual(["system.reveal", "system.copyText"]);
	});
});

describe("硬线④：审计查得到", () => {
	it("成功一条 ok:true，失败一条 ok:false 带原因，都有插件名与动作", async () => {
		const { area, logs } = await box();
		await writeFile(join(area, "a.png"), "x");
		const spy = spyActor();
		const act = createSystemActions({
			plugin: "文件树",
			active: ["system.reveal", "system.copyText"],
			scope: scopeOf(area),
			actor: spy.actor,
			auditFile: join(logs, "tools.jsonl"),
		});

		await act({ action: "system.reveal", channelId: "c1", path: "a.png" });
		await act({ action: "system.copyText", channelId: "c1", text: "你好" });
		await expect(act({ action: "system.reveal", channelId: "c1", path: "no.png" })).rejects.toThrow();

		const lines = await audits(logs);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatchObject({ plugin: "文件树", action: "system.reveal", ok: true });
		expect(lines[1]).toMatchObject({ plugin: "文件树", action: "system.copyText", ok: true });
		expect(lines[2]).toMatchObject({ plugin: "文件树", action: "system.reveal", ok: false });
		expect(lines[2]?.reason).toContain("没有这个文件");
		// 时间必须是 ISO：排查时按它排序。
		expect(lines[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(spy.texts).toEqual(["你好"]);
	});
});

describe("硬线⑤：文件树插件接上了", () => {
	it("刚装上：三条全在待批里，一条都没批 —— 确认卡是真的要弹", async () => {
		const { pluginsRoot, workspace, area, logs } = await box();
		const seed = fileURLToPath(new URL("../../plugins-src/文件树", import.meta.url));
		await cp(seed, join(pluginsRoot, "文件树"), { recursive: true });

		const host = await loadPlugins({ pluginsRoot, workspace, logsRoot: logs, scope: scopeOf(area), log: () => undefined });
		expect(host.errors).toEqual([]);

		const summary = host.plugins.find((plugin) => plugin.slug === "文件树");
		expect(summary?.permissions?.declared).toEqual(["system.reveal", "system.open", "system.copyText"]);
		// 文档里没写 `granted:` = 一条都没批。仓库里那一份也必须是这个状态，
		// 不然「装时弹一次确认」就是空转的。
		expect(summary?.permissions?.granted).toEqual([]);
		expect(summary?.permissions?.pending).toEqual(["system.reveal", "system.open", "system.copyText"]);
		expect(host.routes.find((item) => item.pattern === "/api/p/files/system")).toBeDefined();
	});

	it("批过之后：`/system` 路由真的调到宿主，路径是内核拼的绝对路径", async () => {
		const { pluginsRoot, workspace, area, logs } = await box();
		const seed = fileURLToPath(new URL("../../plugins-src/文件树", import.meta.url));
		await cp(seed, join(pluginsRoot, "文件树"), { recursive: true });
		// 这一步在界面上是「全部批准」：同一件事，写回文档的那一行。
		await writePluginGrants(pluginsRoot, "文件树", ["system.reveal", "system.open", "system.copyText"]);

		const spy = spyActor();
		const host = await loadPlugins({
			pluginsRoot,
			workspace,
			logsRoot: logs,
			scope: scopeOf(area),
			system: spy.actor,
			log: () => undefined,
		});
		expect(host.plugins.find((plugin) => plugin.slug === "文件树")?.permissions?.pending).toEqual([]);

		const route = host.routes.find((item) => item.pattern === "/api/p/files/system");
		await writeFile(join(area, "截图.png"), "x");
		const ok = (await route?.handle({
			method: "POST",
			params: {},
			query: {},
			body: { channel: "c1", action: "reveal", path: "截图.png" },
		})) as { kind: string };
		expect(ok.kind).toBe("ok");
		expect(spy.acts[0]?.path).toBe(join(await realpath(area), "截图.png"));
	});

	it("确认卡上的话写的是「你机器上的文件 / 默认程序」，不是动作名", () => {
		expect(SYSTEM_ACTION_LABELS["system.reveal"]).toContain("你机器上的");
		expect(SYSTEM_ACTION_LABELS["system.open"]).toContain("默认程序");
		expect(SYSTEM_ACTION_LABELS["system.open"]).toContain("你机器上的");
		expect(SYSTEM_ACTION_DETAILS["system.open"]).toContain("不能执行命令");
	});

	it("没批的那条：路由回一句人话，不是静默", async () => {
		const { pluginsRoot, workspace, area, logs } = await box();
		const seed = fileURLToPath(new URL("../../plugins-src/文件树", import.meta.url));
		await cp(seed, join(pluginsRoot, "文件树"), { recursive: true });
		// 把人批的那一行抹掉 = 一条都没批。
		const manifestPath = join(pluginsRoot, "文件树", "plugin.md");
		const text = await readFile(manifestPath, "utf8");
		await writeFile(manifestPath, text.replace(/^granted:.*$/m, ""), "utf8");

		const spy = spyActor();
		const host = await loadPlugins({
			pluginsRoot,
			workspace,
			logsRoot: logs,
			scope: scopeOf(area),
			system: spy.actor,
			log: () => undefined,
		});
		await writeFile(join(area, "截图.png"), "x");
		const route = host.routes.find((item) => item.pattern === "/api/p/files/system");
		const bad = (await route?.handle({
			method: "POST",
			params: {},
			query: {},
			body: { channel: "c1", action: "reveal", path: "截图.png" },
		})) as { kind: string; error?: string };
		expect(bad.kind).toBe("error");
		expect(bad.error).toMatch(/没有声明或没有被批准/);
		expect(spy.acts).toEqual([]);
	});

	it("清单里写了宿主不认识的动作：整个插件不装，错误写清楚", async () => {
		const { pluginsRoot, workspace, area, logs } = await box();
		await mkdir(join(pluginsRoot, "坏插件"), { recursive: true });
		await writeFile(
			join(pluginsRoot, "坏插件", "plugin.md"),
			["---", "name: 坏插件", "permissions: system.revealFile", "---", ""].join("\n"),
		);
		await writeFile(join(pluginsRoot, "坏插件", "plugin.js"), "export function apply() {}\n");

		const host = await loadPlugins({ pluginsRoot, workspace, logsRoot: logs, scope: scopeOf(area), log: () => undefined });
		expect(host.errors.join("\n")).toContain("不认识的权限 system.revealFile");
	});

	it("宿主没接执行器（网页版）：动作抛「这个宿主不支持」，不是假装做完了", async () => {
		const { pluginsRoot, workspace, area, logs } = await box();
		const seed = fileURLToPath(new URL("../../plugins-src/文件树", import.meta.url));
		await cp(seed, join(pluginsRoot, "文件树"), { recursive: true });
		const host = await loadPlugins({ pluginsRoot, workspace, logsRoot: logs, scope: scopeOf(area), log: () => undefined });
		await writeFile(join(area, "截图.png"), "x");
		const route = host.routes.find((item) => item.pattern === "/api/p/files/system");
		const bad = (await route?.handle({
			method: "POST",
			params: {},
			query: {},
			body: { channel: "c1", action: "open", path: "截图.png" },
		})) as { kind: string; error?: string };
		expect(bad.kind).toBe("error");
		expect(bad.error).toMatch(/不支持系统动作/);
	});
});
