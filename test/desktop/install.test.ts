/**
 * 更新安装脚本：等旧进程退出、进程外替换、失败要看得见。
 *
 * 这两段脚本跑在用户机器上，单测不能真的执行它们；这里钉的是会悄悄坏掉的那几行——
 * 等待的 pid、替换失败的回滚、Windows 上的失败弹窗与提权重试。没有这些，更新失败
 * 的表现就是「点了没反应」，用户只能看到一个旧版本又打开了。
 */
import { describe, expect, it } from "vitest";
import { macInstallScript, windowsInstallScript } from "../../desktop/src/install.ts";

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
		const script = windowsInstallScript({
			pid: 7,
			appDir: "D:\\Program Files\\Solo",
			zipPath: "C:\\Users\\me\\AppData\\Local\\Temp\\update.zip",
			exePath: "D:\\Program Files\\Solo\\Solo.exe",
		});
		expect(script).toContain("Get-Process -Id 7");
		expect(script).toContain("$appDir = 'D:\\Program Files\\Solo'");
		expect(script).toContain("robocopy $tmp $appDir");
		// robocopy 0–7 都算成功，8 以上才是失败。
		expect(script).toContain("if ($LASTEXITCODE -ge 8)");
		// Program Files 写不进去时提权再试一次。
		expect(script).toContain("-Verb RunAs");
		expect(script).toContain("MessageBox");
		expect(script).toContain("solo-update.log");
		// 失败后只有在程序文件还在时才把它重新打开。
		expect(script).toContain("if (Test-Path -LiteralPath $exe) { Start-Process $exe }");
	});

	it("Windows：路径里的单引号按 PowerShell 规则转义", () => {
		const script = windowsInstallScript({
			pid: 1,
			appDir: "D:\\it's\\Solo",
			zipPath: "C:\\it's\\update.zip",
			exePath: "D:\\it's\\Solo\\Solo.exe",
		});
		expect(script).toContain("'D:\\it''s\\Solo'");
		expect(script).toContain("'C:\\it''s\\update.zip'");
	});
});
