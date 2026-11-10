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
	// 落盘是「记下来就返回」的（不 await），所以删目录时会跟写撞上：重试几次。
	for (const box of boxes.splice(0)) {
		await rm(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

const DM: PluginChannel = { id: "dm:owner-知言", title: "知言", kind: "dm", members: ["owner", "知言"] };

type Posted = { channelId: string; text: string; replyTo?: number };

type Booted = {
	host: PluginHost;
	posts: Posted[];
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
	const posts: Posted[] = [];
	const host = await loadPlugins({
		pluginsRoot: join(workspace, "plugins"),
		workspace,
		logsRoot: join(workspace, "logs"),
		channels: async () => channels,
		post: async (input) => {
			posts.push({
				channelId: input.channelId,
				text: input.text,
				...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
			});
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

	it("私聊里的话送回最近说话的那个聊天：助理说的送，我自己打的不送，别处的话不出门", async () => {
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
		const said = (text: string, channelId = DM.id, from = "知言", human = false): Message => ({
			seq: 1,
			from,
			at: Date.now(),
			text,
			mentions: [],
			kind: "chat",
			...(human ? { human: true } : {}),
		});
		// 别的频道：不送。
		await listener(said("别处的话", "team:alpha"), "team:alpha");
		expect(calls).toEqual([]);
		// 桥自己带进来的那行回显（`api.post` 以我的身份落进私聊）：不送，否则 IM 里自说自话。
		await listener(said("[IM · Webhook · 张三] 在吗", DM.id, "owner"), DM.id);
		expect(calls).toEqual([]);

		await listener(said("在的，马上看。"), DM.id);
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe("https://example.test/hook");
		expect(JSON.stringify(calls[0]?.body)).toContain("在的，马上看。");
		// 不加前缀：老板要的是「跟微信里说的一样」。
		expect(JSON.stringify(calls[0]?.body)).not.toContain("[桌面]");

		// 我在桌面自己打的字（`human`）：不送。那是我自己写的，推过去只会刷屏。
		await listener(said("桌面端发一句", DM.id, "owner", true), DM.id);
		expect(calls.length).toBe(1);

		// 助理的回复 `from` 也是 `owner`（后端所有「我说话」都写 owner），但**没有** human：
		// 这才是要推的那一类 —— 以前按 from 判，把助理的话一起挡了，方向是反的。
		await listener(said("助理的回复", DM.id, "owner"), DM.id);
		expect(calls.length).toBe(2);
		expect(JSON.stringify(calls[1]?.body)).toContain("助理的回复");
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

	it("重启之后桌面端说的话还能送出去：聊天表是落盘的", async () => {
		// 这条钉的是那个安静到没人发现的 bug：`lastChat()` 过去只在**收到**消息时才有的填，
		// 应用重启一次就空了，桌面端说的话一条也发不出去（不报错、不提示）。
		const calls: { url: string; body: unknown }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: { body?: unknown }) => {
			calls.push({ url: String(url), body: init?.body });
			return { ok: true, status: 200, json: async () => ({ ok: true }) };
		});
		const { host, workspace } = await boot([WEBHOOK_BOT]);

		// 先收一条：这时才知道「该回到哪个聊天」。
		await route(host, "/api/p/im/in/:id").handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "在吗" },
		});
		// 落盘是异步的，等它写完再去读。
		await vi.waitFor(async () => {
			const saved = JSON.parse(await readFile(join(workspace, "im", "bots.json"), "utf8")) as {
				bots: { chats?: { id: string }[] }[];
			};
			expect(saved.bots[0]?.chats?.map((chat) => chat.id)).toEqual(["c1"]);
		});

		// 「重启」：拿同一份配置重新装一遍插件，内存里的东西全没了。
		const again = await boot([WEBHOOK_BOT]);
		const saved = JSON.parse(await readFile(join(workspace, "im", "bots.json"), "utf8")) as {
			bots: Record<string, unknown>[];
		};
		await writeFile(
			join(again.workspace, "im", "bots.json"),
			JSON.stringify({ bots: saved.bots }),
		);
		const rebooted = await boot(saved.bots);
		const listener = rebooted.host.messages[0];
		if (listener === undefined) throw new Error("没有听消息");
		// 用助理说的话验：我自己打的字现在不推（那是另一条规矩），说明不了这张表还在不在。
		await listener(
			{ seq: 1, from: "Solo", at: Date.now(), text: "重启之后这一句还出得去", mentions: [], kind: "chat" },
			DM.id,
		);
		expect(calls.length).toBe(1);
		expect(JSON.stringify(calls[0]?.body)).toContain("重启之后这一句还出得去");
	});

	it("整条链路：微信进来一句，助理回的话出去、人亲手打的不出去，内容不加前缀", async () => {
		// 这条走完整链路：入站先让插件记住「跟谁在聊」，再分别喂老板 / 助理的消息，
		// 看推出去的内容。工位上就能验，不用碰老板的机器。
		const calls: { url: string; body: { text?: { content?: string } } }[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
			calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
			return { ok: true, status: 200, json: async () => ({}) };
		});
		const { host, posts } = await boot([WEBHOOK_BOT]);

		// ① 微信那边来一句 → 落进助理私聊，插件记住这个聊天。
		await route(host, "/api/p/im/in/:id").handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "服务器是不是挂了" },
		});
		expect(posts.length).toBe(1);

		const listener = host.messages[0];
		if (listener === undefined) throw new Error("没有听消息");
		const said = (text: string, from: string, human = false): Message => ({
			seq: 1,
			from,
			at: Date.now(),
			text,
			mentions: [],
			kind: "chat",
			...(human ? { human: true } : {}),
		});

		// ② 老板在桌面自己打的字（human）：一条都不出去（他自己写的，推过去只剩刷屏）。
		await listener(said("我看下", "owner", true), DM.id);
		expect(calls).toEqual([]);

		// ③ 助理的回复：出去。`from` 同样是 `owner`，但没有 human —— 这就是关键区别。
		await listener(said("没挂，是网络抖了一下", "owner"), DM.id);
		expect(calls.length).toBe(1);
		const pushed = calls[0]?.body.text?.content ?? "";
		// 正文原样，不加前缀（老板要「跟微信里说的一样」）。
		expect(pushed).toBe("没挂，是网络抖了一下");

		// ④ 老板再说一句：还是不出门（别把他自己打的推出去）。
		await listener(said("那就好", "owner", true), DM.id);
		expect(calls.length).toBe(1);
	});

	it("人亲手打的字不推到微信，助理的回复照推：判据是 human 不是 from", async () => {
		// 老板自己打的话推过去只会刷屏 —— 判据是 `human` 标记。
		// 不能看 `from`：后端所有「我说话」都写 `from: "owner"`（防冒充），
		// 只看 from 会把助理的回复一起挡掉，那就成了「一句都到不了微信」。
		const calls: { url: string; body: unknown }[] = [];
		vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
			calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
			return { ok: true, status: 200, json: async () => ({}) };
		});
		const { host } = await boot([WEBHOOK_BOT]);
		await route(host, "/api/p/im/in/:id").handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "在吗" },
		});
		const listener = host.messages[0];
		if (listener === undefined) throw new Error("没有听消息");
		const said = (text: string, from: string, human = false): Message => ({
			seq: 1,
			from,
			at: Date.now(),
			text,
			mentions: [],
			kind: "chat",
			...(human ? { human: true } : {}),
		});

		// 我打的（human）：一条都不出去。
		await listener(said("这是我在桌面打的", "owner", true), DM.id);
		expect(calls).toEqual([]);

		// 助理的回复：出去，正文原样、不加前缀。
		await listener(said("这是助理说的", "owner"), DM.id);
		expect(calls.length).toBe(1);
		expect(calls[0]?.body.text?.content).toBe("这是助理说的");

		// 我打的还是不出门。
		await listener(said("我再说一句", "owner", true), DM.id);
		expect(calls.length).toBe(1);
	});

	it("长中文回复按字节切片：每片都不超 2048 字节，一条都不丢", async () => {
		// 以前按 `length`（字符）切，中文一个字 3 字节，3800 字一片是 11400 字节，
		// 超过企业微信 2048 上限 → 整条被拒。700 字以上就中。
		const calls: { body: string }[] = [];
		vi.stubGlobal("fetch", async (_url: string, init?: { body?: string }) => {
			calls.push({ body: String(init?.body ?? "") });
			return { ok: true, status: 200, json: async () => ({}) };
		});
		const { host } = await boot([WEBHOOK_BOT]);
		await route(host, "/api/p/im/in/:id").handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "在吗" },
		});
		const listener = host.messages[0];
		if (listener === undefined) throw new Error("没有听消息");

		// 3600 个中文字 ≈ 10800 字节，以前按字符切是 1 片（直接被拒），现在应切成 ≥6 片。
		const long = "这是一句很长的中文回复。".repeat(300);
		expect(long.length).toBeGreaterThan(3000);
		await listener(
			{ seq: 1, from: "Solo", at: Date.now(), text: long, mentions: [], kind: "chat" },
			DM.id,
		);

		expect(calls.length).toBeGreaterThan(1);
		for (const call of calls) {
			const sent = JSON.parse(call.body) as { text?: { content?: string } };
			const content = sent.text?.content ?? "";
			// 每片实际正文的 UTF-8 字节数必须在平台上限以内。
			expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(2048);
		}
		// 一个字都不能丢：拼回去和原文一致（切片处会吃掉换行，这里没有换行）。
		const joined = calls
			.map((call) => (JSON.parse(call.body) as { text?: { content?: string } }).text?.content ?? "")
			.join("");
		expect(joined).toBe(long);
	});

	it("带选项的消息推到微信是普通文字，选项编号列出来", async () => {
		const calls: { url: string; body: unknown }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: { body?: unknown }) => {
			calls.push({ url: String(url), body: init?.body });
			return { ok: true, status: 200, json: async () => ({ ok: true }) };
		});
		const { host } = await boot([WEBHOOK_BOT]);
		await route(host, "/api/p/im/in/:id").handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "在吗" },
		});

		const listener = host.messages[0];
		if (listener === undefined) throw new Error("没有听消息");
		await listener(
			{
				seq: 7,
				from: "知言",
				at: Date.now(),
				text: "要哪个？",
				mentions: [],
				kind: "chat",
				options: ["先修 A", "先修 B", "都别动"],
			},
			DM.id,
		);
		expect(calls.length).toBe(1);
		const sent = JSON.stringify(calls[0]?.body);
		expect(sent).toContain("要哪个？");
		expect(sent).toContain("1. 先修 A");
		expect(sent).toContain("2. 先修 B");
		expect(sent).toContain("3. 都别动");
	});

	it("微信里回一个编号，就是真的选了那一项", async () => {
		const calls: { url: string; body: unknown }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: { body?: unknown }) => {
			calls.push({ url: String(url), body: init?.body });
			return { ok: true, status: 200, json: async () => ({ ok: true }) };
		});
		const { host, posts } = await boot([WEBHOOK_BOT]);
		const inbound = route(host, "/api/p/im/in/:id");

		// 收一条 → 知道该回哪里。
		await inbound.handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "在吗" },
		});
		expect(posts.length).toBe(1);

		// 助理抛出一个带选项的问题，推到微信那边。
		const listener = host.messages[0];
		if (listener === undefined) throw new Error("没有听消息");
		await listener(
			{
				seq: 42,
				from: "知言",
				at: Date.now(),
				text: "要哪个？",
				mentions: [],
				kind: "chat",
				options: ["先修 A", "先修 B"],
			},
			DM.id,
		);
		expect(calls.length).toBe(1);

		// 老板在微信里回「2」：要变成一次真正的选择 —— 正文是选项原文，且 `replyTo` 指回那条消息。
		await inbound.handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "2" },
		});
		expect(posts.length).toBe(2);
		expect(posts[1]).toEqual({ channelId: DM.id, text: "先修 B", replyTo: 42 });
	});

	it("回的不是纯编号就当普通消息，别把老板的话吞成选择", async () => {
		const calls: { url: string; body: unknown }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: { body?: unknown }) => {
			calls.push({ url: String(url), body: init?.body });
			return { ok: true, status: 200, json: async () => ({ ok: true }) };
		});
		const { host, posts } = await boot([WEBHOOK_BOT]);
		const inbound = route(host, "/api/p/im/in/:id");
		await inbound.handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "在吗" },
		});
		const listener = host.messages[0];
		if (listener === undefined) throw new Error("没有听消息");
		await listener(
			{
				seq: 42,
				from: "知言",
				at: Date.now(),
				text: "要哪个？",
				mentions: [],
				kind: "chat",
				options: ["先修 A", "先修 B"],
			},
			DM.id,
		);
		// 「1 和 2 都行」是他自己的想法，不是选项：不能被吞成选 1。
		await inbound.handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "1 和 2 都行" },
		});
		expect(posts.length).toBe(2);
		expect(posts[1]?.replyTo).toBeUndefined();
		expect(posts[1]?.text).toContain("1 和 2 都行");
		// 超出范围的编号也当普通消息。
		await inbound.handle({
			method: "POST",
			params: { id: "b1" },
			query: { token: "secret" },
			body: { chatId: "c1", userId: "u1", name: "张三", text: "9" },
		});
		expect(posts[2]?.replyTo).toBeUndefined();
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
