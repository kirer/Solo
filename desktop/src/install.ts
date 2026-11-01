/**
 * 装更新：应用自己不能覆盖自己（macOS 的 `.app` 在跑，Windows 的 exe 被锁），
 * 所以留一个进程外的小脚本：等本进程退出 → 解包 → 替换 → 重新打开 → 删临时目录。
 *
 * 两个平台走同一条路线（ADR-029）：都是「zip + 进程外替换」，不是 Squirrel / NSIS。
 * 失败时恢复旧版本：先挪走旧的再放新的，放不进去就把旧的挪回来。
 */
import { spawn } from "node:child_process";

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export function macInstallScript(input: {
	readonly pid: number;
	readonly appPath: string;
	readonly zipPath: string;
}): string {
	const app = quote(input.appPath);
	return [
		`while kill -0 ${input.pid} 2>/dev/null; do sleep 0.3; done`,
		`tmp=$(mktemp -d /tmp/solo-update.XXXXXX) || exit 1`,
		`ditto -x -k ${quote(input.zipPath)} "$tmp" || exit 1`,
		`[ -d "$tmp/Solo.app" ] || exit 1`,
		`old=${app}.old`,
		`rm -rf "$old"`,
		`mv ${app} "$old" || exit 1`,
		`if ! mv "$tmp/Solo.app" ${app}; then mv "$old" ${app}; exit 1; fi`,
		`xattr -dr com.apple.quarantine ${app} 2>/dev/null`,
		`rm -rf "$old" "$tmp"`,
		`open ${app}`,
	].join("\n");
}

export function windowsInstallScript(input: {
	readonly pid: number;
	readonly appDir: string;
	readonly zipPath: string;
	readonly exePath: string;
}): string {
	const ps = (value: string): string => `'${value.replaceAll("'", "''")}'`;
	return [
		`while (Get-Process -Id ${input.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }`,
		`$tmp = Join-Path $env:TEMP ("solo-update-" + [guid]::NewGuid())`,
		`Expand-Archive -LiteralPath ${ps(input.zipPath)} -DestinationPath $tmp -Force`,
		`robocopy $tmp ${ps(input.appDir)} /MIR /NFL /NDL /NJH /NJS | Out-Null`,
		`Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue`,
		`Start-Process ${ps(input.exePath)}`,
	].join("\n");
}

/** 起一个脱离本进程的安装器，然后调用方自己退出。 */
export function scheduleInstall(input: {
	readonly pid: number;
	readonly appPath: string;
	readonly appDir: string;
	readonly zipPath: string;
	readonly exePath: string;
}): void {
	if (process.platform === "darwin") {
		spawn("/bin/sh", ["-c", macInstallScript({ pid: input.pid, appPath: input.appPath, zipPath: input.zipPath })], {
			detached: true,
			stdio: "ignore",
		}).unref();
		return;
	}
	// -EncodedCommand 省掉所有引号转义：PowerShell 读 UTF-16LE 的 base64。
	const script = windowsInstallScript({
		pid: input.pid,
		appDir: input.appDir,
		zipPath: input.zipPath,
		exePath: input.exePath,
	});
	spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
		{ detached: true, stdio: "ignore", windowsHide: true },
	).unref();
}
