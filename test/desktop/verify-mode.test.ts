/**
 * 验证模式（`SOLO_VERIFY_NO_DIALOG=1`）：跑验收时对话框不许把机器挂住，但「本来要说什么」
 * 必须留在日志里；失败照旧记进 `lastCheck`。
 *
 * 为什么读源码：`desktop/src/updates.ts` 一 import 就要 electron，vitest 里起不来。
 * 这条开关的正确性一半在判据（只认 `"1"`）、一半在位置（只判在 `notify()` 一处）——
 * 两样都得盯源码，真跑起来的验证交给 CI 里那步「真机点一次」。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const read = (relpath: string): string => readFileSync(join(REPO, relpath), "utf8");

describe("验证模式：开关", () => {
	const source = read("desktop/src/updates.ts");

	it("判据只认 `SOLO_VERIFY_NO_DIALOG === \"1\"`，不认 `true` / `yes` / 「有值就算」", () => {
		expect(source).toContain('process.env["SOLO_VERIFY_NO_DIALOG"] === "1"');
		// 宽松写法多一种，就多一条「为什么没生效」的猜法。
		expect(source).not.toMatch(/SOLO_VERIFY_NO_DIALOG[^;\n]*!==\s*undefined/);
		expect(source).not.toMatch(/SOLO_VERIFY_NO_DIALOG[^;\n]*===\s*"true"/);
		expect(source).not.toMatch(/SOLO_VERIFY_NO_DIALOG[^;\n]*===\s*"yes"/);
	});

	it("只在 `notify()` 里判一处（别的地方再判一次 = 两套行为）", () => {
		const occurs = source.split('process.env["SOLO_VERIFY_NO_DIALOG"]').length - 1;
		expect(occurs, "这个环境变量在整个文件里只该出现一次").toBe(1);
		// 判据收在一个小函数里，但这个函数只许被 `notify()` 调一次。
		expect(source).toContain("const verifyMode = (): boolean => process.env[\"SOLO_VERIFY_NO_DIALOG\"] === \"1\";");
		const calls = source.split("if (verifyMode()) {").length - 1;
		expect(calls, "`verifyMode()` 只该在 notify 里判一次").toBe(1);
		const notifyAt = source.indexOf("const notify = (body: MessageBoxOptions)");
		const callAt = source.indexOf("if (verifyMode()) {");
		expect(notifyAt).toBeGreaterThan(0);
		expect(callAt).toBeGreaterThan(notifyAt);
		// 下一个函数定义之前就判完了（说明确实在 notify 体内）。
		expect(source.indexOf("const installDir = ()", callAt)).toBeGreaterThan(callAt);
	});
});

describe("验证模式：关框时留下什么", () => {
	const source = read("desktop/src/updates.ts");

	it("关框同时 `console.warn` 一行，带 step 和人话（`message` + `detail`）", () => {
		expect(source).toContain("console.warn(`[update] 验证模式不弹框（${step}）：${body.message}｜${body.detail ?? \"\"}`);");
	});

	it("当作「点了取消」：返回 `cancelId`，绝不返回 0（0 是「下载」「立即重启安装」）", () => {
		expect(source).toContain('const dismissed = typeof body.cancelId === "number" ? body.cancelId : 0;');
		expect(source).toContain("return Promise.resolve(dismissed);");
		expect(source).not.toContain("return Promise.resolve(0);");
	});

	it("失败照旧记进 `lastCheck`：`notify` 里不许碰 `lastCheck`", () => {
		const start = source.indexOf("const notify = (body: MessageBoxOptions)");
		const end = source.indexOf("const installDir = ()", start);
		const body = source.slice(start, end);
		expect(body).not.toContain("lastCheck");
		// 失败那条还在 catch 里，和开关无关。
		expect(source).toContain("result = { at: Date.now(), ok: false, message };");
		expect(source).toContain("lastCheck = result;");
	});

	it("`step` 提到闭包上（notify 读得到），每次进 check 重新从「取清单」开始", () => {
		expect(source).toContain("let step = \"取清单\";");
		expect(source).toContain("step = \"取清单\";");
		// 闭包里那句（带 `let`）在 notify 之前；check 里那句是重置，在 check 之后。
		expect(source.indexOf("let step = \"取清单\";")).toBeLessThan(
			source.indexOf("const notify = (body: MessageBoxOptions)"),
		);
		expect(source.indexOf("\n\t\tstep = \"取清单\";")).toBeGreaterThan(source.indexOf("const check = async ()"));
	});
});

describe("这条开关真的接到了 CI 那步上", () => {
	const script = read("scripts/verify-update-click.mjs");
	const workflow = read(".github/workflows/release.yml");
	const page = read("ui/app/src/panels/SettingsPage.tsx");

	it("脚本自己给应用设开关、带调试端口、两样隔离目录都指临时目录", () => {
		expect(script).toContain("SOLO_VERIFY_NO_DIALOG: \"1\"");
		expect(script).toContain("--remote-debugging-port=");
		expect(script).toContain("HOME: home");
		expect(script).toContain("--user-data-dir=");
	});

	it("按 aria-label 找按钮、隔 20ms 以上回读 `status.at`、存 DOM 和截图", () => {
		expect(script).toContain('[aria-label="检查更新"]');
		expect(script).toContain("updateStatus");
		// 回读间隔不许低于 20ms（要求「隔 20ms 以上」）。
		expect(script).toContain('const pollGap = Number(args.get("--poll-gap") ?? "250")');
		expect(script).toContain("after.at > beforeAt");
		expect(script).toContain("Page.captureScreenshot");
		expect(script).toContain("settings-row.html");
	});

	it("三样证据齐了才算过：`status.at` 变大 + `ok:false` + 那行字是失败句 + 截到图", () => {
		// 更新源指到没人听的本地端口，失败才可复现；不然查通了那行字是「当前版本 x」。
		expect(script).toContain("SOLO_UPDATE_URL: feed");
		expect(script).toContain('http://127.0.0.1:9/');
		expect(script).toContain('const failedLine = "检查更新没连上，稍后重试";');
		expect(script).toContain("if (after?.ok !== false) {");
		expect(script).toContain("if (!showedFailureLine) {");
		expect(script).toContain("if (shot?.data === undefined) await fail");
		// 那行字会等它重画出来（界面 700ms 轮询一次），不能 `at` 一变就截图。
		expect(script.indexOf("descShown.includes(failedLine)")).toBeLessThan(
			script.indexOf("Page.captureScreenshot"),
		);
	});

	it("设置页那颗按钮上真有这个 aria-label（脚本按它找）", () => {
		expect(page).toContain('aria-label="检查更新"');
	});

	it("mac job 出包后跑这一步，证据作为一个 artifact 传走", () => {
		expect(workflow).toContain("真机点一次「检查更新」");
		expect(workflow).toContain("node scripts/verify-update-click.mjs --app");
		expect(workflow).toContain("release/mac-arm64/Solo.app/Contents/MacOS/Solo");
		expect(workflow).toContain("name: mac-update-click");
		// 打包那步和验那步的先后：先出包，再点。
		expect(workflow.indexOf("打包（dmg 失败重试一次）")).toBeLessThan(workflow.indexOf("真机点一次「检查更新」"));
	});

	it("`publish` 的 tag 守卫还在（手动跑不许误发版本）", () => {
		expect(workflow).toContain("if: github.ref_type == 'tag'");
	});
});
