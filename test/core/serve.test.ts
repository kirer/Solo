/**
 * 静态资源目录的默认位置。
 *
 * `serve.ts` 从自己的文件位置往上数到仓库根 —— 它一搬家（ADR-043 就搬过一次），
 * 层数就变，首页静默 404：服务起得来、接口全正常，只有 `/` 打不开。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultUiDir } from "../../src/shell/serve.ts";

describe("serve：界面产物在哪", () => {
	it("默认 uiDir 指向仓库里的 ui/web/index.html", () => {
		// Windows 上旧实现用 `URL.pathname` 会得到 `/C:/…`，这个断言会直接红；
		// 所以它同时是「首页不要静默 404」的跨平台守门。
		expect(existsSync(join(defaultUiDir(), "index.html"))).toBe(true);
	});
});
