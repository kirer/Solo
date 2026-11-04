/**
 * 装更新：应用自己不能覆盖自己（macOS 的 `.app` 在跑，Windows 的 exe 被锁），
 * 所以留一个进程外的小脚本：等本进程退出 → 解包 → 替换 → 重新打开 → 删临时目录。
 *
 * 两个平台走同一条路线（ADR-029）：都是「zip + 进程外替换」，不是 Squirrel / NSIS。
 * 失败时恢复旧版本：先挪走旧的再放新的，放不进去就把旧的挪回来。
 *
 * Windows 的替换脚本额外做三件事（ADR-070）：
 * - 先写一个 ready 文件再等旧进程退出：主进程据此确认脚本真的跑起来了，而不是静默退出；
 * - 用系统自带的 `tar.exe` 解包（比 `Expand-Archive` 快一个数量级），没有才退回后者；
 * - 解包后、替换后都核对 `package.json` 的版本，半套文件不会被当成新版本打开。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

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
	readonly readyPath: string;
	readonly version: string;
	readonly fromVersion: string;
}): string {
	const ps = (value: string): string => `'${value.replaceAll("'", "''")}'`;
	const appDir = ps(input.appDir);
	const exePath = ps(input.exePath);
	const readyPath = ps(input.readyPath);
	const version = ps(input.version);
	const fromVersion = ps(input.fromVersion);
	return [
		`$ErrorActionPreference = 'Stop'`,
		`$log = Join-Path $env:TEMP 'solo-update.log'`,
		`$appDir = ${appDir}`,
		`$exe = ${exePath}`,
		`$version = ${version}`,
		`$fromVersion = ${fromVersion}`,
		`$readyFile = ${readyPath}`,
		`function Write-Log { param([string]$message) try { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message) -Encoding UTF8 } catch { } }`,
		`try { Set-Content -LiteralPath $log -Value ("[{0}] 开始更新：{1} -> {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $fromVersion, $version) -Encoding UTF8 } catch { }`,
		`try {`,
		// 先握手再等退出：主进程看到这个文件才关自己；脚本根本没起来时用户会收到错误。
		`  Set-Content -LiteralPath $readyFile -Value 'ready' -Encoding ASCII`,
		`  Write-Log '安装器已启动，等待旧进程退出'`,
		`  $deadline = (Get-Date).AddSeconds(90)`,
		`  while (Get-Process -Id ${input.pid} -ErrorAction SilentlyContinue) {`,
		`    if ((Get-Date) -gt $deadline) { throw '旧进程 90 秒还没退出。' }`,
		`    Start-Sleep -Milliseconds 300`,
		`  }`,
		// 后端 / 后台命令可能也跑在同一个 Solo.exe 上；主进程退了不代表 exe 解锁。
		`  try { $left = @(Get-Process -Name 'Solo' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) } catch { $left = @() }`,
		`  if ($left.Count -gt 0) {`,
		`    Write-Log "还有 $($left.Count) 个同路径进程，等 30 秒"`,
		`    $deadline = (Get-Date).AddSeconds(30)`,
		`    while ($true) {`,
		`      try { $left = @(Get-Process -Name 'Solo' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) } catch { $left = @() }`,
		`      if ($left.Count -eq 0) { break }`,
		`      if ((Get-Date) -gt $deadline) {`,
		`        Write-Log "强制结束 $($left.Count) 个同路径进程"`,
		`        $left | Stop-Process -Force -ErrorAction SilentlyContinue`,
		`        Start-Sleep -Seconds 2`,
		`        break`,
		`      }`,
		`      Start-Sleep -Milliseconds 300`,
		`    }`,
		`  }`,
		`  $tmp = Join-Path $env:TEMP ("solo-update-" + [guid]::NewGuid())`,
		`  $tar = Join-Path $env:SystemRoot 'System32\\tar.exe'`,
		`  if (Test-Path -LiteralPath $tar) {`,
		`    Write-Log '用 tar 解包'`,
		`    & $tar -xf ${ps(input.zipPath)} -C $tmp`,
		`    if ($LASTEXITCODE -ne 0) { throw "tar 解包失败（退出码 $LASTEXITCODE）。" }`,
		`  } else {`,
		`    Write-Log '用 Expand-Archive 解包'`,
		`    Expand-Archive -LiteralPath ${ps(input.zipPath)} -DestinationPath $tmp -Force`,
		`  }`,
		`  $pkg = [IO.Path]::Combine($tmp, 'resources', 'app', 'package.json')`,
		`  if (-not (Test-Path -LiteralPath $pkg)) { throw '更新包不完整：找不到 resources\\app\\package.json。' }`,
		`  $packagedVersion = (Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).version`,
		`  if ($packagedVersion -ne $version) { throw "更新包版本是 $packagedVersion，不是 $version。" }`,
		`  Write-Log "解包完成，开始替换 $appDir"`,
		`  robocopy $tmp $appDir /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null`,
		`  $copyCode = $LASTEXITCODE`,
		`  Write-Log "robocopy 退出码 $copyCode"`,
		// 8 以上才算失败（0–7 是「拷了 / 有多的文件」这类正常结果）。装在 Program Files
		// 下面时普通权限写不进去，再提权试一次：UAC 由用户点，拒绝就算失败。
		`  if ($copyCode -ge 8) {`,
		`    $quote = { param($value) "'" + $value.Replace("'", "''") + "'" }`,
		`    $copy = 'robocopy {0} {1} /MIR /NFL /NDL /NJH /NJS /R:1 /W:1; exit $LASTEXITCODE' -f (& $quote $tmp), (& $quote $appDir)`,
		`    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($copy))`,
		`    Write-Log '普通权限写不进去，提权重试'`,
		`    $elevated = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)`,
		`    if ($elevated.ExitCode -ge 8) { throw "robocopy 退出码 $($elevated.ExitCode)：安装目录没有写权限。" }`,
		`  }`,
		`  $installedPkg = [IO.Path]::Combine($appDir, 'resources', 'app', 'package.json')`,
		`  $installedVersion = if (Test-Path -LiteralPath $installedPkg) { (Get-Content -LiteralPath $installedPkg -Raw -Encoding UTF8 | ConvertFrom-Json).version } else { $null }`,
		`  if ($installedVersion -ne $version) { throw "替换后版本是 $installedVersion，不是 $version。" }`,
		`  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue`,
		`  Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue`,
		`  Write-Log '安装完成，启动新版本'`,
		`  Start-Process -FilePath $exe -WorkingDirectory $appDir`,
		`} catch {`,
		// 不能静默失败：先前的版本会什么都不说地把旧程序再打开一遍，看起来像「点了没反应」。
		`  Write-Log ("失败：{0}" -f ($_ | Out-String))`,
		`  $message = @('更新没有装成功。', '', $_.Exception.Message, '', "日志：$log", '', '请下载新版安装包手动安装。') -join [Environment]::NewLine`,
		`  try { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($message, 'Solo 更新失败') | Out-Null } catch { }`,
		`  try { Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue } catch { }`,
		`  try { if ($tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } } catch { }`,
		// 只有确认安装目录还是完整的旧版本时才自动打开；半套文件不要启动。
		`  try {`,
		`    $installedPkg = [IO.Path]::Combine($appDir, 'resources', 'app', 'package.json')`,
		`    if (Test-Path -LiteralPath $installedPkg) {`,
		`      $installedVersion = (Get-Content -LiteralPath $installedPkg -Raw -Encoding UTF8 | ConvertFrom-Json).version`,
		`      if ($installedVersion -eq $fromVersion -and (Test-Path -LiteralPath $exe)) { Start-Process -FilePath $exe -WorkingDirectory $appDir }`,
		`    }`,
		`  } catch { }`,
		`}`,
	].join("\n");
}

/**
 * 起一个脱离本进程的安装器。Windows 会等脚本写出 ready 文件再返回：主进程此时才关自己，
 * 脚本没起来（被杀软拦了、PowerShell 起不来、job 对象限制…）会当场报错而不是静默退出。
 */
export function scheduleInstall(input: {
	readonly pid: number;
	readonly appPath: string;
	readonly appDir: string;
	readonly zipPath: string;
	readonly exePath: string;
	readonly version: string;
	readonly fromVersion: string;
}): Promise<void> {
	if (process.platform === "darwin") {
		const child = spawn("/bin/sh", ["-c", macInstallScript({ pid: input.pid, appPath: input.appPath, zipPath: input.zipPath })], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		return new Promise((resolve, reject) => {
			child.once("spawn", () => resolve());
			child.once("error", reject);
		});
	}
	const readyPath = join(dirname(input.zipPath), `installer-${randomUUID()}.ready`);
	rmSync(readyPath, { force: true });
	const script = windowsInstallScript({
		pid: input.pid,
		appDir: input.appDir,
		zipPath: input.zipPath,
		exePath: input.exePath,
		readyPath,
		version: input.version,
		fromVersion: input.fromVersion,
	});
	// -EncodedCommand 省掉所有引号转义：PowerShell 读 UTF-16LE 的 base64。
	const child = spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
		{ detached: true, stdio: "ignore", windowsHide: true },
	);
	child.unref();
	return new Promise((resolve, reject) => {
		let settled = false;
		let poll: ReturnType<typeof setInterval> | undefined;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (poll !== undefined) clearInterval(poll);
			child.kill();
			reject(new Error("安装器 20 秒内没有启动（没写出 ready 文件）"));
		}, 20_000);
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (poll !== undefined) clearInterval(poll);
			reject(error);
		});
		child.once("spawn", () => {
			poll = setInterval(() => {
				if (settled || !existsSync(readyPath)) return;
				settled = true;
				clearTimeout(timer);
				if (poll !== undefined) clearInterval(poll);
				resolve();
			}, 100);
		});
	});
}
