import { describe, expect, it } from "vitest";
import { monologueOpener } from "../../src/core/channel/tools.ts";

/**
 * 「这是内心独白，不是发言」的判据。
 *
 * 每一例都来自线上的真实发言或真实汇报 —— 判据要拦得住独白，也不能把正常汇报打掉。
 */
describe("monologueOpener", () => {
	it("拦住英文计划式开场", () => {
		expect(
			monologueOpener(
				"Let me clone first, then read the compose before touching anything. The repo is at /Users/kirer/ds-bot.",
			),
		).toBe("let me");
		expect(
			monologueOpener(
				"Now I'll check whether the port is free and then make the one mandated edit to the compose file.",
			),
		).toBe("now i");
		expect(
			monologueOpener(
				"I need to verify the docker subdir exists before I can create the data directories it mounts.",
			),
		).toBe("i need to");
		expect(
			monologueOpener("Okay, so the volume mounts are relative to the ds-bot dir, not our workspace root."),
		).toBe("okay,");
	});

	it("不拦中文汇报里夹英文", () => {
		// 中文占多数：英文比例低于 70%，不判独白。
		expect(
			monologueOpener("Let me 先说明结论：已经把 DS-Bot 部署到 127.0.0.1:13080，端口检查通过。"),
		).toBeUndefined();
		expect(
			monologueOpener("部署完成。改动是 compose 的绑定地址从 0.0.0.0 改成 127.0.0.1，其他没动。"),
		).toBeUndefined();
	});

	it("不拦以普通英文标识符开头的正文", () => {
		expect(monologueOpener("docker compose up 已经跑通，服务在 13080 端口监听，日志无报错。")).toBeUndefined();
		expect(monologueOpener("SKILL.md 里的 frontmatter 名字还是 frontend-design，我改成了前端视觉设计。")).toBeUndefined();
	});

	it("太短的不判（可能是正常的一句话）", () => {
		expect(monologueOpener("Let me know")).toBeUndefined();
	});
});
