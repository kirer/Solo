/**
 * 出厂插件「IM 机器人」：外面的话进助理私聊，助理的话回外面。
 *
 * 这里钉的是链路与边界，不测 Telegram 自己的协议：
 * - 只认助理那条私聊（别的频道的话不出门）；
 * - 收到 → `api.post` 一条带来源前缀的话；
 * - 助理回复 → 回到最近说话的那个聊天（Webhook 用 fetch 发）；
 * - token 不对 / 不在白名单 → 不落进私聊；
 * - 配置写在 `<appRoot>/im/bots.json`，不写进插件目录（否则出厂升级永远判「被改过」）。
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPlugins, type PluginHost } from "../../src/core/plugin/index.ts";
import type { PluginChannel } from "../../src/core/plugin/api.ts";
import type { Message } from "../../src/core/channel/types.ts";

const boxes: string[] = [];

afterEach(async () => {
	vi.unstubAllGlobals();
	for (const box of boxes.splice(0)) await rm(box, { recursive: true, force: true });
});

const DM: PluginChannel = { id: "dm:owner-知言", title: "知言", kind: "dm", members: ["owner", "知言"] };

type Booted = {
	host: PluginHost;
	posts: { channelId: string; text: string }[];
	workspace: string;
};

async function boot(
	bots: readonly Record<string, unknown>[],
	channels: readonly PluginChannel[] = [DM],
): Promise<Booted> {
	const workspace = await mkdtemp(join(tmpdir(), "im-plugin-"));
	boxes.push(workspace);
	await mkdir(join(workspace, "plugins"), { recursive: true });
	await mkdir(join(workspace, "assistant", "知言"), { recursive: true });
	const seed = fileURLToPath(new URL("../../seed/plugins/IM机器人", import.meta.url));
	await cp(seed, join(workspace, "plugins", "IM机器人"), { recursive: true });
	await mkdir(join(workspace, "im"), { recursive: true });
	await writeFile(join(workspace, "im", "bots.json"), JSON.stringify({ bots }));
	const posts: { channelId: string; text: string }[] = [];
	const host = await loadPlugins({
		pluginsRoot: join(workspace, "plugins"),
		workspace,
		logsRoot: join(workspace, "logs"),
		channels: async () => channels,
		post: async (input) => {
			posts.push({ channelId: input.channelId, text: input.text });
		},
		log: () => {},
	});
	expect(host.errors).toEqual([]);
	return { host, posts, workspace };
}

function route(host: PluginHost, pattern: string) {
	const found = host.routes.find((item) => item.pattern === pattern);
	if (found === undefined) throw new Error(`没有注册 ${pattern}`);
	return found;
}

const WEBHOOK_BOT = {
	id: "b1",
	name: "测试机器人",
	platform: "webhook",
	enabled: true,
	token: "secret",
	webhookUrl: "https://example.test/hook",
	mode: "mention",
	allow: [],
};

describe("IM 机器人", () => {
	it("认得出助理私聊，并把它写在状态里", async () => {
		const { host } = await boot([WEBHOOK_BOT]);
		const snapshot = (await route(host, "/api/p/im").handle({ method: "GET", params: {}, query: {} })) as {
			assistant: { channelId: string; name: string } | null;
			bots: { id: string; status: string }[];
		};
		expect(snapshot.assistant).toEqual({ slug: "知言", name: "知言", channelId: DM.id });
		expect(snapshot.bots.map((bot) => bot.id)).toEqual(["b1"]);
		expect(snapshot.bots[0]?.status).toBe("running");
	});

	it("Webhook 收到的消息带着来源进助理私聊", async () => {
		const { host, posts } = await boot([WEBHOOK_BOT]);
		const inbound = route(host, "/api/p/im/in/:id");
		await inbound.handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "帮我看下这个" },
		});
		expect(posts).toEqual([{ channelId: DM.id, text: "[IM · Webhook · 张三] 帮我看下这个" }]);
	});

	it("token 不对就拒收", async () => {
		const { host, posts } = await boot([WEBHOOK_BOT]);
		await expect(
			route(host, "/api/p/im/in/:id").handle({
				method: "POST",
				params: { id: "b1" },
				query: { token: "wrong" },
				body: { chatId: "c1", userId: "u1", name: "张三", text: "你好" },
			}),
		).rejects.toThrow("token");
		expect(posts).toEqual([]);
	});

	it("白名单外的人说话不落进私聊", async () => {
		const { host, posts } = await boot([{ ...WEBHOOK_BOT, allow: ["u9"] }]);
		await route(host, "/api/p/im/in/:id").handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "你好" },
		});
		expect(posts).toEqual([]);
	});

	it("助理的回复送回最近说话的那个聊天，别处的话不出门", async () => {
		const calls: { url: string; body: unknown }[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
			calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
			return { ok: true, status: 200, json: async () => ({}) };
		});
		const { host, posts } = await boot([WEBHOOK_BOT]);
		await route(host, "/api/p/im/in/:id").handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "在吗" },
		});
		expect(posts.length).toBe(1);

		const listener = host.messages[0];
		if (listener === undefined) throw new Error("没有听消息");
		const said = (text: string, channelId = DM.id, from = "知言"): Message => ({
			seq: 1,
			from,
			at: Date.now(),
			text,
			mentions: [],
			kind: "chat",
		});
		// 别的频道：不送。
		await listener(said("别处的话", "team:alpha"), "team:alpha");
		expect(calls).toEqual([]);
		// 我自己说的话：不送（否则等于把 IM 里的原话再回一遍）。
		await listener(said("[IM · Webhook · 张三] 在吗", DM.id, "owner"), DM.id);
		expect(calls).toEqual([]);

		await listener(said("在的，马上看。"), DM.id);
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe("https://example.test/hook");
		expect(JSON.stringify(calls[0]?.body)).toContain("在的，马上看。");
	});

	it("保存机器人写进 appRoot/im，不写进插件目录", async () => {
		const { host, workspace } = await boot([]);
		await route(host, "/api/p/im/bots").handle({
			method: "POST",
			params: {},
			query: {},
			body: { name: "新机器人", platform: "webhook", webhookUrl: "https://example.test/hook", token: "t" },
		});
		const saved = JSON.parse(await readFile(join(workspace, "im", "bots.json"), "utf8")) as {
			bots: { name: string }[];
		};
		expect(saved.bots.map((bot) => bot.name)).toEqual(["新机器人"]);
		const inPlugin = await readFile(join(workspace, "plugins", "IM机器人", "bots.json"), "utf8").catch(() => "");
		expect(inPlugin).toBe("");
	});

	it("微信：扫完码把凭据落成机器人，之后用 context_token 回话", async () => {
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		let polls = 0;
		vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
			const text = String(url);
			const body = init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
			if (text.includes("get_bot_qrcode")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						ret: 0,
						qrcode: "qr-token",
						qrcode_img_content: "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=qr-token&bot_type=3",
					}),
				};
			}
			if (text.includes("get_qrcode_status")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						status: "confirmed",
						bot_token: "wx-token",
						ilink_bot_id: "bot-1",
						ilink_user_id: "user-1",
						baseurl: "https://ilinkai.weixin.qq.com",
					}),
				};
			}
			if (text.includes("getupdates")) {
				polls += 1;
				if (polls === 1) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							ret: 0,
							msgs: [
								{
									message_type: 1,
									from_user_id: "wx_u1",
									context_token: "ctx-1",
									item_list: [{ type: 1, text_item: { text: "在吗" } }],
								},
							],
							get_updates_buf: "buf-2",
						}),
					};
				}
				throw new Error("offline");
			}
			if (text.includes("sendmessage")) {
				calls.push({ url: text, body });
				return { ok: true, status: 200, json: async () => ({ ret: 0 }) };
			}
			return { ok: true, status: 200, json: async () => ({}) };
		});

		const { host, posts, workspace } = await boot([]);
		const started = (await route(host, "/api/p/im/weixin/login").handle({
			method: "POST",
			params: {},
			query: {},
		})) as { id: string; status: string; qr: { size: number; bits: string } };
		expect(["wait", "confirmed"]).toContain(started.status);
		expect(started.qr.size).toBeGreaterThan(20);
		expect(started.qr.bits.length).toBe(started.qr.size ** 2);

		const login = route(host, "/api/p/im/weixin/login/:id");
		await vi.waitFor(async () => {
			const status = (await login.handle({
				method: "GET",
				params: { id: started.id },
				query: {},
			})) as { status: string; botId: string };
			expect(status.status).toBe("confirmed");
			expect(status.botId).not.toBe("");
		});

		const saved = JSON.parse(await readFile(join(workspace, "im", "bots.json"), "utf8")) as {
			bots: { platform: string; token: string; accountId: string; baseUrl: string }[];
		};
		expect(saved.bots[0]).toMatchObject({
			platform: "weixin",
			token: "wx-token",
			accountId: "bot-1",
			baseUrl: "https://ilinkai.weixin.qq.com/",
		});

		// 微信里说的话进助理私聊，带着来源前缀。
		await vi.waitFor(() => expect(posts.length).toBe(1));
		expect(posts[0]?.text).toContain("[IM · 微信 · wx_u1] 在吗");

		// 助理的回答回到那个聊天，并带上这一轮的 context_token。
		const listener = host.messages[0];
		if (listener === undefined) throw new Error("没有听消息");
		await listener(
			{ seq: 1, from: "知言", at: Date.now(), text: "在的", mentions: [], kind: "chat" },
			DM.id,
		);
		await vi.waitFor(() => expect(calls.length).toBe(1));
		const msg = calls[0]?.body.msg as Record<string, unknown>;
		expect(msg).toMatchObject({ to_user_id: "wx_u1", context_token: "ctx-1" });
		expect(JSON.stringify((msg.item_list as unknown[])[0])).toContain("在的");
	});

	it("微信返回的扫码地址不是腾讯域名就不画二维码", async () => {
		vi.stubGlobal("fetch", async () => ({
			ok: true,
			status: 200,
			json: async () => ({ ret: 0, qrcode: "qr-token", qrcode_img_content: "https://evil.test/qr?qrcode=1" }),
		}));
		const { host } = await boot([]);
		await expect(
			route(host, "/api/p/im/weixin/login").handle({ method: "POST", params: {}, query: {} }),
		).rejects.toThrow("不可信");
	});

	it("Webhook 机器人没有接入口令就不收：建的时候当场拒", async () => {
		const { host } = await boot([]);
		await expect(
			route(host, "/api/p/im/bots").handle({
				method: "POST",
				params: {},
				query: {},
				body: { name: "没口令", platform: "webhook", webhookUrl: "https://example.test/hook" },
			}),
		).rejects.toThrow("接入口令");
	});
});
