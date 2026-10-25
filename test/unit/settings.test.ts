/**
 * settings.json 存储的单元测试。
 *
 * 只测纯逻辑（不涉及 HTTP）：默认值、PATCH 合并、模型增删、
 * restartRequired 的口径、以及坏输入的错误类型。
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openSettings,
	SettingsConflictError,
	SettingsInputError,
	type SettingsStore,
} from "../../src/server/settings.ts";

const dirs: string[] = [];

async function tempStore(environment: NodeJS.ProcessEnv = {}): Promise<{ store: SettingsStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "aic-settings-"));
	dirs.push(dir);
	return { store: openSettings({ workspace: dir, environment }), dir };
}

afterEach(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs.length = 0;
});

describe("设置默认值", () => {
	test("没有 settings.json 时给出本机默认值", async () => {
		const { store } = await tempStore();
		const settings = await store.read();
		expect(settings.network).toEqual({ host: "127.0.0.1", port: 7788 });
		expect(settings.models.custom).toEqual([]);
		expect(settings.im).toEqual({ enabled: false, outboundWebhook: "", inboundToken: "", accounts: [] });
	});

	test("环境变量作为默认值（AI_COMPANY_HOST / PORT）", async () => {
		const { store } = await tempStore({ AI_COMPANY_HOST: "0.0.0.0", PORT: "7790" } as NodeJS.ProcessEnv);
		const settings = await store.read();
		expect(settings.network).toEqual({ host: "0.0.0.0", port: 7790 });
	});

	test("损坏的 settings.json 回退默认值而不是抛错", async () => {
		const { store, dir } = await tempStore();
		await writeFile(join(dir, "settings.json"), "{ 不是 JSON", "utf8");
		const settings = await store.read();
		expect(settings.network.host).toBe("127.0.0.1");
	});
});

describe("PATCH 合并", () => {
	test("network / im 按段合并，accounts 整段替换", async () => {
		const { store } = await tempStore();
		await store.patch({
			network: { host: "0.0.0.0", port: 7799 },
			im: {
				enabled: true,
				outboundWebhook: "http://127.0.0.1:9999/hook",
				inboundToken: "tok",
				accounts: [{ id: "a1", channel: "wechat", name: "老板微信", enabled: true, note: "备注" }],
			},
		});
		const settings = await store.read();
		expect(settings.network).toEqual({ host: "0.0.0.0", port: 7799 });
		expect(settings.im.enabled).toBe(true);
		expect(settings.im.accounts).toHaveLength(1);
		expect(settings.im.accounts[0]).toMatchObject({ id: "a1", channel: "wechat", name: "老板微信" });

		await store.patch({ im: { accounts: [] } });
		expect((await store.read()).im.accounts).toEqual([]);
		// 其他字段不受影响
		expect((await store.read()).im.enabled).toBe(true);
	});

	test("非法端口 / 非法 JSON 被拒绝", async () => {
		const { store } = await tempStore();
		await expect(store.patch("nope")).rejects.toBeInstanceOf(SettingsInputError);
		// 非法端口回退到旧值而不是写坏文件
		await store.patch({ network: { port: 99999 } });
		expect((await store.read()).network.port).toBe(7788);
	});

	test("只改 IM 不算需要重启；改 network / 模型才算", async () => {
		const { store } = await tempStore();
		expect(await store.restartRequired()).toBe(false);
		await store.patch({ im: { enabled: true } });
		expect(await store.restartRequired()).toBe(false);
		await store.patch({ network: { host: "0.0.0.0" } });
		expect(await store.restartRequired()).toBe(true);
	});
});

describe("模型增删", () => {
	test("新增自定义模型并落盘", async () => {
		const { store, dir } = await tempStore();
		const model = await store.addModel({
			id: "gpt-5-mini",
			name: "GPT-5 mini",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "sk-test",
			inputPerMTok: 0.25,
			outputPerMTok: 2,
			contextWindow: 400_000,
			maxOutput: 128_000,
		});
		expect(model).toMatchObject({ id: "gpt-5-mini", provider: "openai", inputPerMTok: 0.25 });

		const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as {
			models: { custom: { id: string; apiKey?: string }[] };
		};
		expect(raw.models.custom[0]?.id).toBe("gpt-5-mini");
		// apiKey 允许明文存储（文档要求提醒用户，但功能上要能保存）
		expect(raw.models.custom[0]?.apiKey).toBe("sk-test");
		expect(await store.hasCustomModel("gpt-5-mini")).toBe(true);
		expect(await store.restartRequired()).toBe(true);
	});

	test("重复 id 冲突、非法 id / baseUrl 报输入错误", async () => {
		const { store } = await tempStore();
		await store.addModel({ id: "dup" });
		await expect(store.addModel({ id: "dup" })).rejects.toBeInstanceOf(SettingsConflictError);
		await expect(store.addModel({ id: "" })).rejects.toBeInstanceOf(SettingsInputError);
		await expect(store.addModel({ id: "../escape" })).rejects.toBeInstanceOf(SettingsInputError);
		await expect(store.addModel({ id: "ok", baseUrl: "ftp://x" })).rejects.toBeInstanceOf(SettingsInputError);
	});

	test("删除自定义模型；不存在的返回 false", async () => {
		const { store } = await tempStore();
		await store.addModel({ id: "a" });
		expect(await store.removeModel("a")).toBe(true);
		expect(await store.hasCustomModel("a")).toBe(false);
		expect(await store.removeModel("a")).toBe(false);
	});

	test("重新打开存储仍能读到模型（持久化）", async () => {
		const { store, dir } = await tempStore();
		await store.addModel({ id: "persisted", provider: "anthropic" });
		const reopened = openSettings({ workspace: dir, environment: {} });
		const settings = await reopened.read();
		expect(settings.models.custom.map((item) => item.id)).toEqual(["persisted"]);
		// 新进程的基线就是磁盘上的配置 → 不需要重启
		expect(await reopened.restartRequired()).toBe(false);
	});
});
