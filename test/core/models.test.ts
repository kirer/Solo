import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactionPolicyFor, compactionSettings, FALLBACK_CONTEXT_WINDOW, setupModels } from "../../src/core/runtime/models.ts";

const dirs: string[] = [];

function workspaceWith(settings: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "settings-"));
	dirs.push(dir);
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings), "utf8");
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const PROVIDER = {
	id: "magpie",
	name: "本地网关",
	baseUrl: "http://127.0.0.1:3425/v1",
	apiKey: "magpie",
	api: "openai-responses",
	models: [{ id: "auto/deepseek-v4.1-flash", reasoning: true }],
};

describe("setupModels 的默认模型", () => {
	it("settings.json 的 defaultModel 指向不存在的 provider 时改用可用模型，并说清原因", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const setup = setupModels({}, { workspace: workspaceWith({ defaultModel: "commandcode/auto/hy3", providers: [PROVIDER] }) });
		expect(setup.defaultModel).toEqual({ provider: "magpie", modelId: "auto/deepseek-v4.1-flash" });
		expect(setup.models.getModel("magpie", "auto/deepseek-v4.1-flash")).toBeDefined();
		// 静默回落最费时间：界面只表现成「所有人都不说话」，日志里必须能看见。
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("commandcode/auto/hy3"));
	});

	it("provider 对、模型名不对，同样回落", () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const setup = setupModels({}, { workspace: workspaceWith({ defaultModel: "magpie/auto/hy5", providers: [PROVIDER] }) });
		expect(setup.defaultModel).toEqual({ provider: "magpie", modelId: "auto/deepseek-v4.1-flash" });
	});

	it("引用是对的就不动它，也不打警告", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const setup = setupModels({}, { workspace: workspaceWith({ defaultModel: "magpie/auto/deepseek-v4.1-flash", providers: [PROVIDER] }) });
		expect(setup.defaultModel).toEqual({ provider: "magpie", modelId: "auto/deepseek-v4.1-flash" });
		expect(warn).not.toHaveBeenCalled();
	});

	it("没写 defaultModel 时用第一个 provider 的第一个模型", () => {
		const setup = setupModels({}, { workspace: workspaceWith({ providers: [PROVIDER] }) });
		expect(setup.defaultModel).toEqual({ provider: "magpie", modelId: "auto/deepseek-v4.1-flash" });
	});

	it("provider 里一个模型都没有就明确报错，不静默启动", () => {
		const empty = { ...PROVIDER, models: [] };
		expect(() => setupModels({}, { workspace: workspaceWith({ providers: [empty] }) })).toThrow(/没有模型/);
	});

	it("模型清单是空的、defaultModel 又指向不存在的模型时，报错而不是拿空清单去跑", () => {
		const empty = { ...PROVIDER, models: [] };
		expect(() =>
			setupModels({}, { workspace: workspaceWith({ defaultModel: "commandcode/auto/hy3", providers: [empty] }) }),
		).toThrow(/没有任何可用模型可回落/);
	});

	it("settings.json 读不出来 = 没有模型：不悄悄换上本地网关", () => {
		// 悄悄回落最坏的地方是「看不出来」：界面一切正常，人却不知道自己在用哪只模型。
		const setup = setupModels({}, { workspace: workspaceWith("坏掉的内容") });
		expect(setup.defaultModel).toBeUndefined();
		expect(setup.models.getModels()).toEqual([]);
	});

	it("什么都没配（没有 settings.json、没有密钥）：同样没有模型", () => {
		const setup = setupModels({}, { workspace: "" });
		expect(setup.defaultModel).toBeUndefined();
		expect(setup.models.getModels()).toEqual([]);
	});
});

describe("上下文窗口：真值优先，取不到才保守", () => {
	it("pi-ai 目录里有这个模型就用目录的 contextWindow", () => {
		const settings = {
			providers: [
				{ id: "anthropic", api: "anthropic", models: [{ id: "claude-sonnet-4-5" }] },
			],
		};
		const setup = setupModels({}, { workspace: workspaceWith(settings) });
		const model = setup.models.getModel("anthropic", "claude-sonnet-4-5");
		expect(model?.contextWindow).toBe(200_000);
	});

	it("目录里没有（自建网关）就用保守默认，不是 1M", () => {
		const setup = setupModels({}, { workspace: workspaceWith({ providers: [PROVIDER] }) });
		const model = setup.models.getModel("magpie", "auto/deepseek-v4.1-flash");
		expect(model?.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
		expect(model?.contextWindow).toBeLessThan(1_000_000);
	});

	it("settings.json 显式写了就以它为准", () => {
		const provider = { ...PROVIDER, models: [{ id: "auto/deepseek-v4.1-flash", contextWindow: 64_000, maxTokens: 8_000 }] };
		const setup = setupModels({}, { workspace: workspaceWith({ providers: [provider] }) });
		const model = setup.models.getModel("magpie", "auto/deepseek-v4.1-flash");
		expect(model?.contextWindow).toBe(64_000);
		expect(model?.maxTokens).toBe(8_000);
	});
});

describe("压缩策略：阈值跟着窗口走", () => {
	it("200k 的模型，阻塞阈值明显小于 200k", () => {
		const settings = { providers: [{ id: "anthropic", api: "anthropic", models: [{ id: "claude-sonnet-4-5" }] }] };
		const setup = setupModels({}, { workspace: workspaceWith(settings) });
		const policy = compactionSettings(setup.models).modelOverrides["anthropic/claude-sonnet-4-5"];
		expect(policy).toBeDefined();
		const threshold = 200_000 - (policy?.reserveTokens ?? 0);
		expect(threshold).toBeLessThan(200_000);
		expect(threshold).toBeGreaterThan(150_000);
	});

	it("未知模型按保守窗口算阈值", () => {
		const setup = setupModels({}, { workspace: workspaceWith({ providers: [PROVIDER] }) });
		const policy = compactionSettings(setup.models).modelOverrides["magpie/deepseek-v4.1-flash"] ??
			compactionSettings(setup.models).modelOverrides["magpie/auto/deepseek-v4.1-flash"];
		expect(policy).toBeDefined();
		expect(FALLBACK_CONTEXT_WINDOW - (policy?.reserveTokens ?? 0)).toBeLessThan(FALLBACK_CONTEXT_WINDOW);
		// 兜底那条（不在覆写里的模型）也是保守窗口，不是底座那个 16384/1M 组合。
		const global = compactionSettings(setup.models);
		expect(FALLBACK_CONTEXT_WINDOW - global.reserveTokens).toBeLessThan(FALLBACK_CONTEXT_WINDOW);
	});

	it("保留原文的量永远小于压缩阈值（否则压不动）", () => {
		for (const window of [8_192, 32_768, 131_072, 200_000, 1_000_000]) {
			const policy = compactionPolicyFor(window);
			expect(policy.keepRecentTokens).toBeLessThan(window - policy.reserveTokens);
			expect(policy.backgroundTokens).toBeLessThan(window - policy.reserveTokens);
		}
	});
});
