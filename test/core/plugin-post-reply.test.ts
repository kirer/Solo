/**
 * 插件发言的口子（`api.post`）认不认 `replyTo`，以及它会不会变成后门。
 *
 * 为什么要门：`replyTo` 是「选了什么」的唯一凭据（界面只看这个），
 * 所以它能指到一条消息上，但**只能**是这个频道里真实存在的那条 ——
 * 跨频道 / 不存在的 id 一律拒，别让它变成往别处投递的通道。
 */
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelDoc, type ChannelState } from "../../src/core/channel/types.ts";
import { projectChannel } from "../../src/core/channel/rules.ts";
import { sandboxPool } from "./support.ts";

const pool = sandboxPool();
afterEach(() => pool.cleanup());

const models = { provider: "test", modelId: "test" };

async function setup() {
	const box = await pool.make("plugin-post-");
	// 一个小插件：暴露一条路由，把 `api.post` 的入参原样透过来。
	const dir = join(box.layout.pluginsRoot, "poster");
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "plugin.md"),
		"---\nname: poster\ndescription: 试 replyTo\n---\n",
	);
	await writeFile(
		join(dir, "plugin.js"),
		`
export function apply(api) {
	api.route({
		method: "POST",
		pattern: "/api/p/poster/ping",
		handle: async ({ body }) => {
			await api.post({ channelId: body.channelId, text: body.text, replyTo: body.replyTo });
			return { ok: true };
		},
	});
}
`,
	);
	const runtime = await box.open();
	const shell = await box.assemble(runtime, { defaultModel: models });
	return { box, shell };
}

describe("插件发言的 replyTo", () => {
	it("指同一个频道里的消息：能发出去，且真的挂在那条消息上", async () => {
		const { shell } = await setup();
		const first = await shell.postAs({ channelId: "all", from: "owner", text: "第一句" });
		const route = shell.plugins.routes.find((item) => item.pattern === "/api/p/poster/ping");
		if (route === undefined) throw new Error("没有注册路由");
		await route.handle({
			method: "POST",
			params: {},
			query: {},
			body: { channelId: "all", text: "选好了", replyTo: first.seq },
		});
		const state = await shell.channels();
		const messages = state.messages.all ?? [];
		const last = messages[messages.length - 1];
		expect(last?.text).toBe("选好了");
		expect(last?.replyTo).toBe(first.seq);
	});

	it("指不存在的 seq：拒掉，别静默发出去", async () => {
		const { shell } = await setup();
		await shell.postAs({ channelId: "all", from: "owner", text: "第一句" });
		const route = shell.plugins.routes.find((item) => item.pattern === "/api/p/poster/ping");
		if (route === undefined) throw new Error("没有注册路由");
		await expect(
			route.handle({
				method: "POST",
				params: {},
				query: {},
				body: { channelId: "all", text: "选好了", replyTo: 9999 },
			}),
		).rejects.toThrow();
	});

	it("指别的频道里的消息：拒掉，不能跨频道引用", async () => {
		const { shell } = await setup();
		// 先让两个频道都真的存在，再拿 A 的 seq 去引用 B。
		const other = await shell.postAs({ channelId: "all", from: "owner", text: "别的频道" });
		await shell.harness.commit(async (tx) => {
			const doc = (await tx.doc(ChannelDoc)) as ChannelState;
			Object.assign(
				doc,
				projectChannel(doc, {
					id: "team:x",
					title: "x",
					members: ["owner"],
					wakeOnAll: ["owner"],
					at: Date.now(),
					mode: "create",
				}),
			);
		}, { signal: new AbortController().signal });
		const route = shell.plugins.routes.find((item) => item.pattern === "/api/p/poster/ping");
		if (route === undefined) throw new Error("没有注册路由");
		await expect(
			route.handle({
				method: "POST",
				params: {},
				query: {},
				body: { channelId: "team:x", text: "串台", replyTo: other.seq },
			}),
		).rejects.toThrow();
	});
});
