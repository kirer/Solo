import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupModels } from "../../src/core/runtime/models.ts";

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

	it("settings.json 读不出来时回落本地网关", () => {
		const setup = setupModels({}, { workspace: workspaceWith("坏掉的内容") });
		expect(setup.defaultModel.provider).toBe("magpie");
		expect(setup.models.getModel(setup.defaultModel.provider, setup.defaultModel.modelId)).toBeDefined();
	});
});
