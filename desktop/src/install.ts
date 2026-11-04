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
	const appDir = ps(input.appDir);
	const exePath = ps(input.exePath);
	return [
		`$ErrorActionPreference = 'Stop'`,
		`$log = Join-Path $env:TEMP 'solo-update.log'`,
		`$appDir = ${appDir}`,
		`$exe = ${exePath}`,
		`try {`,
		// 旧进程还占着 exe 和 sqlite；等它真的退出再动文件。
		`  while (Get-Process -Id ${input.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }`,
		`  $tmp = Join-Path $env:TEMP ("solo-update-" + [guid]::NewGuid())`,
		`  Expand-Archive -LiteralPath ${ps(input.zipPath)} -DestinationPath $tmp -Force`,
		`  robocopy $tmp $appDir /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null`,
		// 8 以上才算失败（0–7 是「拷了 / 有多的文件」这类正常结果）。装在 Program Files
		// 下面时普通权限写不进去，再提权试一次：UAC 由用户点，拒绝就算失败。
		`  if ($LASTEXITCODE -ge 8) {`,
		`    $quote = { param($value) "'" + $value.Replace("'", "''") + "'" }`,
		`    $copy = 'robocopy {0} {1} /MIR /NFL /NDL /NJH /NJS /R:1 /W:1; exit $LASTEXITCODE' -f (& $quote $tmp), (& $quote $appDir)`,
		`    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($copy))`,
		`    $elevated = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)`,
		`    if ($elevated.ExitCode -ge 8) { throw "robocopy 退出码 $($elevated.ExitCode)：安装目录没有写权限。" }`,
		`  }`,
		`  if (-not (Test-Path -LiteralPath $exe)) { throw '替换之后找不到程序文件。' }`,
		`  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue`,
		`  Start-Process $exe`,
		`} catch {`,
		// 不能静默失败：先前的版本会什么都不说地把旧程序再打开一遍，看起来像「点了没反应」。
		`  try { if ($tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } } catch { }`,
		`  try { ($_ | Out-String) | Set-Content -LiteralPath $log -Encoding UTF8 } catch { }`,
		`  $message = @('更新没有装成功。', '', $_.Exception.Message, '', "日志：$log", '', '请下载新版安装包手动安装。') -join [Environment]::NewLine`,
		`  try { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($message, 'Solo 更新失败') | Out-Null } catch { }`,
		`  if (Test-Path -LiteralPath $exe) { Start-Process $exe }`,
		`}`,
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
