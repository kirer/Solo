/**
 * 更新安装脚本：等旧进程退出、进程外替换、失败要看得见。
 *
 * 这两段脚本跑在用户机器上，单测不能真的执行它们；这里钉的是会悄悄坏掉的那几行——
 * 等待的 pid、替换失败的回滚、Windows 上的失败弹窗与提权重试。没有这些，更新失败
 * 的表现就是「点了没反应」，用户只能看到一个旧版本又打开了。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { macInstallScript, scheduleInstall, windowsInstallScript } from "../../desktop/src/install.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:crypto", () => ({ randomUUID: () => "fixed" }));

const originalPlatform = process.platform;
const setPlatform = (platform: NodeJS.Platform): void => {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
};

class FakeChild extends EventEmitter {
	readonly unref = vi.fn();
	readonly kill = vi.fn();
}

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	vi.useRealTimers();
	mocks.spawn.mockReset();
});

const windowsInput = (overrides: Partial<Parameters<typeof windowsInstallScript>[0]> = {}) => ({
	pid: 7,
	appDir: "D:\\Program Files\\Solo",
	zipPath: "C:\\Users\\me\\AppData\\Local\\Temp\\update.zip",
	exePath: "D:\\Program Files\\Solo\\Solo.exe",
	readyPath: "C:\\Users\\me\\AppData\\Local\\Temp\\installer.ready",
	version: "2.0.11",
	fromVersion: "2.0.10",
	...overrides,
});

describe("更新安装脚本", () => {
	it("macOS：等旧进程退出再换包，换不进去就把旧包挪回来", () => {
		const script = macInstallScript({ pid: 42, appPath: "/Applications/Solo.app", zipPath: "/tmp/a.zip" });
		expect(script).toContain("kill -0 42");
		expect(script).toContain("ditto -x -k '/tmp/a.zip'");
		expect(script).toContain("mv '/Applications/Solo.app' \"$old\"");
		expect(script).toContain("if ! mv");
		expect(script).toContain("open '/Applications/Solo.app'");
	});

	it("Windows：等旧进程退出，装不上要报错而不是静默重开旧程序", () => {
		const script = windowsInstallScript(windowsInput());
		expect(script).toContain("Get-Process -Id 7");
		expect(script).toContain("$appDir = 'D:\\Program Files\\Solo'");
		expect(script).toContain("robocopy $tmp $appDir");
		// robocopy 0–7 都算成功，8 以上才是失败。
		expect(script).toContain("if ($copyCode -ge 8)");
		// Program Files 写不进去时提权再试一次。
		expect(script).toContain("-Verb RunAs");
		expect(script).toContain("MessageBox");
		expect(script).toContain("solo-update.log");
		// 失败后只有在安装目录仍是完整旧版本时才重新打开。
		expect(script).toContain("if ($installedVersion -eq $fromVersion -and (Test-Path -LiteralPath $exe))");
		expect(script).toContain("Start-Process -FilePath $exe -WorkingDirectory $appDir");
	});

	it("Windows：先写 ready 文件再等退出，主进程能确认安装器真的起来了", () => {
		const script = windowsInstallScript(windowsInput());
		expect(script).toContain("Set-Content -LiteralPath $readyFile -Value 'ready'");
		expect(script).toContain("$readyFile = 'C:\\Users\\me\\AppData\\Local\\Temp\\installer.ready'");
	});

	it("Windows：优先用 tar 解包，没有 tar 才退回 Expand-Archive", () => {
		const script = windowsInstallScript(windowsInput());
		expect(script).toContain("$tar = Join-Path $env:SystemRoot 'System32\\tar.exe'");
		expect(script).toContain("& $tar -xf 'C:\\Users\\me\\AppData\\Local\\Temp\\update.zip' -C $tmp");
		expect(script).toContain("Expand-Archive -LiteralPath 'C:\\Users\\me\\AppData\\Local\\Temp\\update.zip'");
	});

	it("Windows：解包后和替换后都核对 package.json 的版本", () => {
		const script = windowsInstallScript(windowsInput());
		expect(script).toContain("$version = '2.0.11'");
		expect(script).toContain("$fromVersion = '2.0.10'");
		expect(script).toContain("$packagedVersion -ne $version");
		expect(script).toContain("$installedVersion -ne $version");
	});

	it("Windows：路径里的单引号按 PowerShell 规则转义", () => {
		const script = windowsInstallScript(
			windowsInput({
				appDir: "D:\\it's\\Solo",
				zipPath: "C:\\it's\\update.zip",
				exePath: "D:\\it's\\Solo\\Solo.exe",
				readyPath: "C:\\it's\\installer.ready",
			}),
		);
		expect(script).toContain("'D:\\it''s\\Solo'");
		expect(script).toContain("'C:\\it''s\\update.zip'");
		expect(script).toContain("'C:\\it''s\\installer.ready'");
	});

	it("Windows：安装器写出 ready 文件后才返回", async () => {
		vi.useFakeTimers();
		setPlatform("win32");
		const child = new FakeChild();
		mocks.spawn.mockReturnValue(child);
		const dir = mkdtempSync(join(tmpdir(), "solo-install-test-"));
		const zipPath = join(dir, "update.zip");
		const readyPath = join(dir, "installer-fixed.ready");
		try {
			const pending = scheduleInstall({
				pid: 1,
				appPath: "C:\\Solo",
				appDir: "C:\\Solo",
				zipPath,
				exePath: "C:\\Solo\\Solo.exe",
				version: "2.0.11",
				fromVersion: "2.0.10",
			});
			child.emit("spawn");
			writeFileSync(readyPath, "ready");
			await vi.advanceTimersByTimeAsync(150);
			await expect(pending).resolves.toBeUndefined();
			expect(child.unref).toHaveBeenCalled();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("Windows：20 秒没写 ready 就报错并杀掉安装器", async () => {
		vi.useFakeTimers();
		setPlatform("win32");
		const child = new FakeChild();
		mocks.spawn.mockReturnValue(child);
		const dir = mkdtempSync(join(tmpdir(), "solo-install-test-"));
		const zipPath = join(dir, "update.zip");
		try {
			const pending = scheduleInstall({
				pid: 1,
				appPath: "C:\\Solo",
				appDir: "C:\\Solo",
				zipPath,
				exePath: "C:\\Solo\\Solo.exe",
				version: "2.0.11",
				fromVersion: "2.0.10",
			});
			child.emit("spawn");
			const assertion = expect(pending).rejects.toThrow("20 秒内没有启动");
			await vi.advanceTimersByTimeAsync(20_100);
			await assertion;
			expect(child.kill).toHaveBeenCalled();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
