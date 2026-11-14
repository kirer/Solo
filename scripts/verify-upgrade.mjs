/**
 * 发布验收：**旧版真能升到新版**（Solo 2026-11-14 点名要的那条，2.9.19 之前没人验过）。
 *
 * 为什么之前验不了：已发布的版本都不会自己把那两下点掉 —— v2.9.18 里没有
 * `SOLO_VERIFY_NO_DIALOG`（查出新版本弹原生框），2.9.19 的验证模式又故意返回 `cancelId`
 * （`updates.ts` 里写着「返回 0 就等于替用户把包装上了」）。原生框不在渲染进程里，CDP 点不到，
 * runner 上也没有辅助功能授权。所以拆成三段，能验多少验多少：
 *
 * - 段 1（旧版自己去查）：装 2.9.18 到临时 HOME，`SOLO_UPDATE_URL` 指到本地 feed（清单是
 *   发布私钥现签的本轮清单），等首查。`[update] 有新版本 x（当前 y）` 这行在弹框之前打，
 *   拿到就证明「取清单 → 验签 → 比版本」三步在真打包件上是通的。之后框会等人点，超时收进程。
 * - 段 2（替换那一段）：不经过 app，直接 `import { macInstallScript }` 拿**产品原文**生成的脚本，
 *   喂真 zip 把 .app 从旧版换到新版；再喂截断的 zip，验「装不上但现有安装一字节没动」。
 * - 段 3（整链，要 `SOLO_VERIFY_INSTALL=1`）：拿**本版包**当旧版（把 `package.json` 的版本号
 *   降一格），本地 feed 喂本版签名清单，让它自己下载、自己替换、自己重开，最后读启动日志
 *   确认新进程认的版本是新版。这条只有带钩子的版本跑得起来（2.9.20 起）。
 *   「自己重开」那一步的 `open` 换成了转发器（见下面 `stageFull` 里的注释）：真 `open` 走
 *   LaunchServices，环境不经过我们这儿，新进程会去碰真实 `~/.solo`。
 *
 * 隔离：`HOME`、`--user-data-dir` 都在临时目录里；`.app` 解到 `$HOME/Applications`，不装、不碰
 * `/Applications`（替换目标由 `installDir()` 跟着 exe 走，天然被关在临时 HOME 内）。开窗只有
 * 段 3 的最后一次 `open`，CI runner 上没有人在用。
 *
 * 用法（CI 在 mac job 里跑；段 1 和段 3 都要发布私钥，段 2 不用）：
 *   node --experimental-strip-types scripts/verify-upgrade.mjs --out update-upgrade \
 *     --old-zip old/Solo-2.9.18-arm64.zip --new-zip release/Solo-2.9.20-arm64.zip \
 *     --key "$RUNNER_TEMP/solo-update-key.pem" --stages 1,2
 *   node --experimental-strip-types scripts/verify-upgrade.mjs --out update-upgrade-full \
 *     --new-zip release/Solo-2.9.20-arm64.zip --key "$RUNNER_TEMP/solo-update-key.pem" --stages 3
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { macInstallScript } from "../desktop/src/install.ts";
import { createUpdateServer } from "./update-server.ts";

const OWNER = "kirer";
const REPO = "Solo";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const { values: args } = parseArgs({
	options: {
		out: { type: "string" },
		stages: { type: "string" },
		"old-zip": { type: "string" },
		"old-tag": { type: "string" },
		"new-zip": { type: "string" },
		"new-version": { type: "string" },
		key: { type: "string" },
		port: { type: "string" },
		"long-wait": { type: "string" },
	},
});

const outDir = args.out;
if (outDir === undefined) {
	console.error("用法：node --experimental-strip-types scripts/verify-upgrade.mjs --out <目录> [--stages 1,2,3] [--old-zip <zip>] [--new-zip <zip>] [--key <私钥>]");
	process.exit(2);
}
const repoRoot = resolve(import.meta.dirname, "..");
const stages = (args.stages ?? "1,2").split(",").map((one) => one.trim());
const oldTag = args["old-tag"] ?? "v2.9.18";
const port = Number(args.port ?? "8899");
/** 段 1 要等首查 30 秒 + 冷启动装 seed；段 3 还要下 140MB。 */
const longWait = Number(args["long-wait"] ?? "600000");

await mkdir(outDir, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "solo-verify-upgrade-"));
const notes = [];
const note = (line) => {
	notes.push(line);
	console.log(line);
};

const children = [];
let server;
const cleanup = async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	if (server !== undefined) await server.close().catch(() => undefined);
	await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
};
const fail = async (reason) => {
	await note(`失败：${reason}`);
	await writeFile(join(outDir, "result.txt"), `失败：${reason}\n\n${notes.join("\n")}\n`);
	await cleanup();
	process.exit(1);
};
const pass = async (summary) => {
	await note(summary);
	await writeFile(join(outDir, "result.txt"), `通过\n\n${notes.join("\n")}\n`);
	await cleanup();
	process.exit(0);
};

/** 解 zip 到 `<home>/Applications`，返回 `Solo.app` 的路径。 */
const installApp = async (zip, home) => {
	const apps = join(home, "Applications");
	await mkdir(apps, { recursive: true });
	execFileSync("ditto", ["-x", "-k", zip, apps], { stdio: "pipe" });
	const app = join(apps, "Solo.app");
	if (!existsSync(app)) await fail(`${basename(zip)} 里没有 Solo.app`);
	return app;
};

/** 版本判据就是这个文件：`asar: false`，整份摊在 Resources/app 里。 */
const versionOf = async (app) =>
	JSON.parse(await readFile(join(app, "Contents", "Resources", "app", "package.json"), "utf8")).version;
const setVersion = async (app, version) => {
	const file = join(app, "Contents", "Resources", "app", "package.json");
	const pkg = JSON.parse(await readFile(file, "utf8"));
	await writeFile(file, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
};

/** 占位 settings.json：一台机器上一只模型都没有时首屏是引导，updater 起来即可，这里只为跳过它。 */
const writePlaceholder = async (userData) => {
	await mkdir(userData, { recursive: true });
	await writeFile(
		join(userData, "settings.json"),
		`${JSON.stringify(
			{
				defaultModel: "verify/placeholder",
				providers: [
					{
						id: "verify",
						name: "验收占位（不会真发请求）",
						baseUrl: "http://127.0.0.1:9/v1",
						apiKey: "verify",
						models: [{ id: "placeholder" }],
					},
				],
			},
			null,
			2,
		)}\n`,
	);
};

/** 起一个 app（直跑二进制，和 `verify-update-click.mjs` 一个路子）。 */
const startApp = async (app, home, env) => {
	const userData = join(home, "userdata");
	await writePlaceholder(userData);
	const logs = [];
	// 本脚本可能是从 Solo 自己的 Electron 里起的，那样环境里带着 `ELECTRON_RUN_AS_NODE=1`；
	// 继承下去被验的 app 就不当 Electron 跑，`--user-data-dir` 会被当成坏参数直接退出 9
	// （沈迟 2026-11-15 踩过，见团队记忆）。
	const childEnv = { ...process.env, HOME: home, ...env };
	delete childEnv.ELECTRON_RUN_AS_NODE;
	const child = spawn(join(app, "Contents", "MacOS", "Solo"), [`--user-data-dir=${userData}`], {
		env: childEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => logs.push(chunk));
	}
	child.on("exit", (code, signal) => logs.push(`\n[verify] 应用退出：code=${String(code)} signal=${String(signal)}\n`));
	return { child, logs, text: () => logs.join("") };
};

const waitFor = async (what, deadline, check) => {
	while (Date.now() < deadline) {
		if (await check()) return true;
		await sleep(300);
	}
	await note(`等超时（${what}）`);
	return false;
};

/**
 * 本轮的清单和签名，用发布私钥现签 —— 就是发版那一步的同一个脚本（`update:manifest`）。
 * 段 1（2.9.18 自己去查）和段 3（本版包当旧版）都吃这一份：里面写的是本轮版本，两者都比它旧。
 * 不用线上清单，是因为线上 latest 就是「上一个已发布版」，跟段 1 里装的旧版是同一个版本号，
 * 比不出东西来；而旧版里内置的公钥配得上这把私钥，验签这一环照样是真的。
 */
let candidateFeedUrl;
const ensureCandidateFeed = async () => {
	if (candidateFeedUrl !== undefined) return candidateFeedUrl;
	if (newZip === undefined) await fail("段 1 / 段 3 要 --new-zip（本轮打出来的新版 zip）");
	if (args.key === undefined) await fail("段 1 / 段 3 要 --key（清单得用发布私钥现签）");
	const dir = join(scratch, "feed");
	await mkdir(dir, { recursive: true });
	await copyFile(newZip, join(dir, basename(newZip)));
	execFileSync(
		"npm",
		[
			"run",
			"update:manifest",
			"--",
			"--feed",
			dir,
			"--version",
			newVersion,
			"--tag",
			`v${newVersion}`,
			"--file",
			`darwin=${newZip}`,
			"--plugins-src",
			"plugins-src",
			"--key",
			resolve(args.key),
		],
		{ cwd: repoRoot, stdio: "pipe" },
	);
	const manifest = JSON.parse(await readFile(join(dir, "latest-mac.json"), "utf8"));
	if (manifest.version !== newVersion) await fail(`签出来的清单写着 ${manifest.version}，不是 ${newVersion}`);
	note(`清单现签好了：${manifest.version}，包 ${basename(newZip)}，${String(manifest.files.darwin.size)} 字节`);
	server = await createUpdateServer({ dir, port, host: "127.0.0.1", log: (line) => note(line) });
	candidateFeedUrl = server.url;
	return candidateFeedUrl;
};

const needOldZip = async () => {
	if (args["old-zip"] !== undefined) return args["old-zip"];
	const dir = join(scratch, "old");
	await mkdir(dir, { recursive: true });
	note(`本地没有旧版包，去 Release ${oldTag} 取（${basename(oldTag)}）`);
	execFileSync("gh", ["release", "download", oldTag, "--pattern", "Solo-*-arm64.zip", "--dir", dir], { stdio: "pipe" });
	const name = `Solo-${oldTag.replace(/^v/, "")}-arm64.zip`;
	const path = join(dir, name);
	if (!existsSync(path)) await fail(`Release ${oldTag} 上没有 ${name}`);
	return path;
};

const newZip = args["new-zip"] === undefined ? undefined : resolve(args["new-zip"]);
const newVersion =
	args["new-version"] ?? JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

// ---- 段 1：旧版自己去查 ----

const stageOldChecks = async () => {
	note("段 1：装旧版，让它自己把清单拉下来、验签、判版本");
	const url = await ensureCandidateFeed();
	const home = join(scratch, "home-old");
	const app = await installApp(await needOldZip(), home);
	const oldVersion = await versionOf(app);
	note(`旧版 ${oldVersion}｜本轮清单 ${newVersion}｜feed ${url}`);
	if (newVersion === oldVersion) await fail(`旧版就是 ${oldVersion}，跟本轮版本一样，这条验不出东西`);
	const run = await startApp(app, home, { SOLO_UPDATE_URL: url });
	const deadline = Date.now() + longWait;
	const found = await waitFor("日志里出现「有新版本」", deadline, () => /\[update\] 有新版本 /.test(run.text()));
	const text = run.text();
	await writeFile(join(outDir, "stage1-old.log"), text);
	if (!found) {
		run.child.kill("SIGKILL");
		await fail(`旧版 ${String(longWait)}ms 内没打印「有新版本」，见 stage1-old.log`);
	}
	const matched = /\[update\] 有新版本 (\S+)（当前 (\S+)）/.exec(text);
	if (matched === null) await fail("日志格式对不上，见 stage1-old.log");
	if (matched[1] !== newVersion) await fail(`日志说新版本是 ${String(matched[1])}，清单是 ${newVersion}`);
	if (matched[2] !== oldVersion) await fail(`日志说当前版本是 ${String(matched[2])}，装的是 ${oldVersion}`);
	if (text.includes("[update] 取清单失败")) await fail("日志里有「取清单失败」，签名或地址不对，见 stage1-old.log");
	// 2.9.18 没有验证模式：框会弹出来等人点，进程还活着就是证据。
	const stillRunning = run.child.exitCode === null && run.child.signalCode === null;
	run.child.kill("SIGKILL");
	await sleep(500);
	note(
		stillRunning
			? "旧版真弹出了原生框（进程没自己退）：CI 上没人点，这正是段 2 要绕过的那一段"
			: "旧版自己退出了（不该发生）",
	);
	note(`段 1 通：${oldVersion} 拿真清单、真签名判出了 ${newVersion}`);
};

// ---- 段 2：替换那一段 ----

const stageReplace = async () => {
	if (newZip === undefined) await fail("段 2 要 --new-zip（本轮打出来的新版 zip）");
	note("段 2：用产品自己的 macInstallScript 把 .app 换掉");
	const mark = join(scratch, "open-called.txt");
	const fakeBin = join(scratch, "bin");
	await mkdir(fakeBin, { recursive: true });
	// 换掉 `open`：脚本最后那行会真的把 app 打开，这里只记一笔（开窗不是这一步要验的）。
	await writeFile(join(fakeBin, "open"), '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$SOLO_VERIFY_OPEN_MARK"\nexit 0\n');
	await chmod(join(fakeBin, "open"), 0o755);
	const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, SOLO_VERIFY_OPEN_MARK: mark };

	const oldZip = await needOldZip();
	const home = join(scratch, "home-replace");
	const app = await installApp(oldZip, home);
	const before = await versionOf(app);
	const script = macInstallScript({ pid: 999999, appPath: app, zipPath: newZip });
	const ok = spawnSync("/bin/sh", ["-c", script], { env, encoding: "utf8" });
	await writeFile(join(outDir, "stage2-script.sh"), `${script}\n`);
	if (ok.status !== 0) {
		await writeFile(join(outDir, "stage2-replace.log"), `${ok.stdout ?? ""}${ok.stderr ?? ""}`);
		await fail(`替换脚本退出码 ${String(ok.status)}，见 stage2-replace.log`);
	}
	const after = await versionOf(app);
	note(`替换：${before} → ${after}（期望 ${newVersion}）`);
	if (after !== newVersion) await fail(`替换后版本是 ${after}，不是 ${newVersion}`);
	if (existsSync(`${app}.old`)) await fail("Solo.app.old 还在（没清掉）");
	const opened = existsSync(mark) ? (await readFile(mark, "utf8")).trim() : "";
	if (!opened.includes(app)) await fail(`安装脚本没走到「打开新版本」那一步（open 标记：「${opened}」）`);
	note(`安装脚本最后一行 open 被拦下（记录：${opened}）`);

	// 负例：截断的包必须装不上，而且**不能动**现有的 .app。
	const badHome = join(scratch, "home-replace-bad");
	const badApp = await installApp(oldZip, badHome);
	const badZip = join(scratch, "broken.zip");
	const full = await readFile(newZip);
	await writeFile(badZip, full.subarray(0, Math.min(1 << 20, full.byteLength)));
	await rm(mark, { force: true });
	const bad = spawnSync("/bin/sh", ["-c", macInstallScript({ pid: 999999, appPath: badApp, zipPath: badZip })], {
		env,
		encoding: "utf8",
	});
	await writeFile(join(outDir, "stage2-broken.log"), `${bad.stdout ?? ""}${bad.stderr ?? ""}`);
	if (bad.status === 0) await fail("截断的包居然装成功了");
	const badVersion = await versionOf(badApp);
	if (badVersion !== before) await fail(`坏包把现有安装改成了 ${badVersion}（原来是 ${before}）`);
	if (existsSync(`${badApp}.old`)) await fail("坏包那次留下了 Solo.app.old");
	if (existsSync(mark)) await fail("坏包那次居然走到了「打开新版本」");
	note(`段 2 通：真包换到 ${newVersion}；截断包退出码 ${String(bad.status)}，现有安装仍是 ${badVersion}，没留下半套文件`);
};

// ---- 段 3：整链（旧版 → 新版，自己下载自己装自己重开） ----

const stageFull = async () => {
	note(`段 3：整链 ${newVersion} —— 拿本版包当旧版，让它自己升上来`);
	const home = join(scratch, "home-full");
	const app = await installApp(newZip, home);
	const standInVersion = "0.0.0-verify";
	await setVersion(app, standInVersion);
	note(`替身版本号改成 ${standInVersion}（跑的是本版代码，只是它认为自己是旧的）`);

	// 安装脚本最后一行是 `open <新 app>`。这一行换成转发器：让它按**我们指的 HOME** 把新版本
	// 拉起来。不换的话 `open` 走 LaunchServices、环境不经过我们这儿，新进程会去碰真实 `~/.solo`
	// —— 在开发机上就是跟老板正在用的那份抢同一个库。
	const launchedHome = join(scratch, "home-launched");
	const appLog = join(scratch, "launched.log");
	const pidFile = join(scratch, "launched.pid");
	const fakeBin = join(scratch, "bin-full");
	await mkdir(fakeBin, { recursive: true });
	await mkdir(join(launchedHome, "userdata"), { recursive: true });
	await writeFile(
		join(fakeBin, "open"),
		[
			"#!/bin/sh",
			'[ -d "$1" ] || exit 1',
			`export HOME="${launchedHome}"`,
			// 新进程不该再进自动安装模式（它已经是新版了，版本比不过就会自己停）。
			"unset SOLO_VERIFY_INSTALL",
			`"$1/Contents/MacOS/Solo" --user-data-dir="${join(launchedHome, "userdata")}" >"${appLog}" 2>&1 &`,
			`echo $! > "${pidFile}"`,
			"exit 0",
			"",
		].join("\n"),
	);
	await chmod(join(fakeBin, "open"), 0o755);

	const url = await ensureCandidateFeed();
	const env = { SOLO_UPDATE_URL: url, SOLO_VERIFY_INSTALL: "1", PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
	const run = await startApp(app, home, env);
	const deadline = Date.now() + longWait;
	const downloaded = await waitFor("日志里出现「下载完成」", deadline, () => /\[update\] 下载完成/.test(run.text()));
	const text1 = run.text();
	await writeFile(join(outDir, "stage3-full.log"), text1);
	if (!downloaded) {
		run.child.kill("SIGKILL");
		await fail(`没下完（${String(longWait)}ms），见 stage3-full.log`);
	}
	if (!text1.includes("[update] 自动安装模式：跳过「下载」")) await fail("没走自动安装那条路（SOLO_VERIFY_INSTALL 没生效？）");
	if (!text1.includes("[update] 自动安装模式：跳过「立即重启安装」")) await fail("没跳过第二次点击，见 stage3-full.log");
	if (!/\[update\] 下载完成：\S+/.test(text1)) await fail("下载完成那行不对");
	const exited = await waitFor(
		"旧进程退出",
		Date.now() + 180_000,
		() => run.child.exitCode !== null || run.child.signalCode !== null,
	);
	await sleep(1000);
	await writeFile(join(outDir, "stage3-full.log"), run.text());
	if (!exited) {
		run.child.kill("SIGKILL");
		await fail("旧进程没退出（安装器没接上？）");
	}
	note(`旧进程退出码 ${String(run.child.exitCode)}`);

	const installed = await versionOf(app);
	if (installed !== newVersion) await fail(`装完的 .app 版本是 ${installed}，不是 ${newVersion}`);
	if (existsSync(`${app}.old`)) await fail("Solo.app.old 还在（没清掉）");

	// 新进程自己认的版本：启动日志那行里写着 `版本 x.y.z`。
	const coreLog = join(launchedHome, ".solo", "logs", "core.log");
	const launched = await waitFor("启动日志里出现新进程", Date.now() + 180_000, () => {
		if (!existsSync(coreLog)) return false;
		return (readFileSync(coreLog, "utf8").match(/\[shell\] 启动：/g) ?? []).length >= 1;
	});
	const log = existsSync(coreLog) ? readFileSync(coreLog, "utf8") : "";
	await writeFile(join(outDir, "stage3-core.log"), log);
	if (!launched) await fail("装完之后没看到新进程启动，见 stage3-core.log");
	const launches = log.split("\n").filter((line) => line.startsWith("[shell] 启动："));
	const last = launches[launches.length - 1] ?? "";
	const lastVersion = /版本 ([^；]+)；/.exec(last)?.[1] ?? "";
	if (lastVersion !== newVersion) await fail(`新进程认的版本是 ${lastVersion}，不是 ${newVersion}`);
	const childPid = existsSync(pidFile) ? Number((await readFile(pidFile, "utf8")).trim()) : 0;
	if (childPid > 0) {
		try {
			process.kill(childPid, "SIGKILL");
		} catch {
			// 自己退了就算了
		}
	}
	note(`安装脚本把新版本拉起来了，它自己认的版本是 ${lastVersion}（pid ${String(childPid)}，已收）`);
	await pass(`段 3 通：${standInVersion} → ${newVersion} 整链走完（下载、替换、重开、新进程认新版本）`);
};

if (stages.includes("1")) await stageOldChecks();
if (stages.includes("2")) await stageReplace();
if (stages.includes("3")) await stageFull();
await pass(`段 ${stages.join("+")} 全通`);
