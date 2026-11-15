/**
 * 发版脚本本地干跑（Solo 2026-11-15 点名要的）：
 * **把 `release.yml` 里 `publish` 那几段 `run:` 抠出来，在本地真跑一遍**，用假 zip、假 tag、
 * 假 `gh`，不碰网络、不建 Release。
 *
 * 为什么要有它：发版那段脚本，每次发版才是它第一次真跑。main 上的 run 只跑到 build，
 * `publish` 整段被 `if: github.ref_type == 'tag'` 挡住。于是「`set -u` 读了个没定义过的变量」
 * 这种事只能等真发版那一次、花二十多分钟才炸出来（2026-11-15 的 `KEY_PEM` 就是）。
 * 本地一秒半就能炸。
 *
 * 假到什么程度：`gh` 换成记账的假货（写一行调用、检查要传的文件在不在），`git`/`node` 都是真的
 * ——notes 是真从提交标题生成的，清单是真用 `~/.solo-update-key.pem` 签的。只差「把资产真传上去」。
 *
 * 用法：`node scripts/verify-release-steps.mjs`（要本机有发布私钥；没有就明说跳过，不假装验过）。
 */
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ymlPath = join(repo, ".github/workflows/release.yml");
const keyPath = process.env.SOLO_UPDATE_KEY_FILE ?? join(homedir(), ".solo-update-key.pem");

if (!existsSync(keyPath)) {
	console.error(`没有发布私钥 ${keyPath}：签不了清单，这一步就是空跑。` + "有私钥再跑，别把它当成验过了。");
	process.exit(1);
}

/** 从 yml 里抠 `publish:` 这个 job 的 `- name:` + `run: |` 段，保持文件里的顺序。 */
const publishSteps = (text) => {
	const start = text.search(/^  publish:$/m);
	if (start < 0) throw new Error("release.yml 里没有 publish job");
	const afterHeader = text.slice(start);
	const bodyStart = afterHeader.indexOf("\n") + 1;
	const body0 = afterHeader.slice(bodyStart);
	const end = body0.search(/^  [a-zA-Z-]+:$/m); // 下一个 job（publish 是最后一个时就没有）
	const body = end < 0 ? body0 : body0.slice(0, end);
	// 按 `- name:` 切成一段段：同一个 step 里 name 和 run 之间可能还夹着 `id:`、`env:` 之类，
	// 所以先切段、再在段内找 `run: |`，别指望它们紧挨着。
	const steps = [];
	for (const chunk of body.split(/^ {6}- name: /m).slice(1)) {
		const name = chunk.split("\n")[0].trim();
		const run = /^ {8}run: \|\n((?: {10}.*\n|\n)*)/m.exec(chunk);
		if (run === null) continue; // `- uses:` 那种没有 run，跳过
		const script = run[1]
			.split("\n")
			.map((line) => (line.startsWith("          ") ? line.slice(10) : line))
			.join("\n");
		steps.push({ name, script });
	}
	return steps;
};

const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const tag = `v${version}`;

/** `${{ … }}` 在本地没有 actions 帮忙求值，这里只认 publish 里真的用到的三种。 */
const expressions = {
	"steps.tag.outputs.tag": tag,
	"needs.verify.outputs.version": version,
	"github.token": "fake-token",
};
const substitute = (script, stepName) =>
	script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr) => {
		const value = expressions[expr];
		if (value === undefined) throw new Error(`${stepName} 里有个本地替不了的表达式：${whole.trim()}`);
		return value;
	});

const root = mkdtempSync(join(tmpdir(), "solo-release-dryrun-"));
try {
	// 把仓库里要用的东西软链进来：脚本会按相对路径找 scripts/、plugins-src/、node_modules/。
	for (const name of ["scripts", "plugins-src", "node_modules"]) {
		const from = join(repo, name);
		if (existsSync(from)) symlinkSync(from, join(root, name));
	}
	// 假产物：清单只算 sha512，打包物本身多大无所谓；上传那步由假 gh 检查文件在不在。
	mkdirSync(join(root, "dist"), { recursive: true });
	const assets = [
		`Solo-${version}-arm64.dmg`,
		`Solo-${version}-arm64.zip`,
		`Solo-${version}-x64.exe`,
		`Solo-${version}-x64.zip`,
	];
	for (const asset of assets) writeFileSync(join(root, "dist", asset), `假产物 ${asset}\n`.repeat(16));

	// 假 gh：只记账。`release view` 按 FAKE_RELEASE_STATE 回答，其余三件（create/upload/edit）
	// 校验要传的文件存在，然后写一行日志——真实 gh 少了文件就是红，这里替它先红。
	mkdirSync(join(root, "bin"), { recursive: true });
	const fakeGh = join(root, "bin", "gh");
	writeFileSync(
		fakeGh,
		`#!/bin/bash
set -uo pipefail
echo "gh $*" >> "\${FAKE_GH_LOG:?}"
what="\$1 \$2"
case "\$what" in
  "release view")
    case "\${FAKE_RELEASE_STATE:-none}" in
      none) echo "release not found" >&2; exit 1 ;;
      draft) echo true ;;
      published) echo false ;;
      *) echo "[假 gh] FAKE_RELEASE_STATE 只认 none/draft/published" >&2; exit 1 ;;
    esac ;;
  "release create")
    prev=""
    for arg in "\$@"; do
      if [ "\$prev" = "--notes-file" ] && [ ! -f "\$arg" ]; then
        echo "[假 gh] --notes-file 指的文件不存在：\$arg" >&2; exit 1
      fi
      prev="\$arg"
    done ;;
  "release upload")
    # \$1=release \$2=upload \$3=<tag>，再往后才是要传的文件
    skip=3
    for arg in "\$@"; do
      if [ "\$skip" -gt 0 ]; then skip=\$((skip-1)); continue; fi
      case "\$arg" in --*) continue ;; esac
      if [ ! -f "\$arg" ]; then echo "[假 gh] 要传的文件不存在：\$arg" >&2; exit 1; fi
    done ;;
  "release edit") ;;
  *) echo "[假 gh] 没预料到的调用：gh \$*" >&2; exit 1 ;;
esac
exit 0
`,
	);
	chmodSync(fakeGh, 0o755);

	const steps = publishSteps(readFileSync(ymlPath, "utf8"));
	if (steps.length === 0) throw new Error("publish 里一段 run: 都没抠到，先看 yml 的缩进是不是变了");

	let failed = 0;
	/** 跑一段：造一个独立的 GITHUB_OUTPUT 和一个独立的假 gh 记账文件，返回退出码、输出原文、gh 调用。 */
	const runStep = (slot, step, extraEnv = {}) => {
		const outputFile = join(root, `gh-output-${slot}`);
		writeFileSync(outputFile, "");
		const logFile = join(root, `fake-gh-${slot}.log`);
		writeFileSync(logFile, "");
		const scriptFile = join(root, `step-${slot}.sh`);
		writeFileSync(scriptFile, substitute(step.script, step.name));
		const env = {
			...process.env,
			...extraEnv,
			PATH: `${join(root, "bin")}:${process.env.PATH}`,
			// 脚本里要 `git describe` / `git log`（notes 和「动了没动代码」那道闸都靠它），可产物得落在
			// 临时目录：用 GIT_DIR + GIT_WORK_TREE 把 git 指回真仓库，cwd 仍然在临时目录。
			// GIT_OPTIONAL_LOCKS=0 是防止只读命令顺手去拿仓库的 index 锁。
			GIT_DIR: join(repo, ".git"),
			GIT_WORK_TREE: repo,
			GIT_OPTIONAL_LOCKS: "0",
			// runner 上这些都由 actions 提供，本地照着造一份，麻烦的是它们别缺。
			RUNNER_TEMP: join(root, "runner-temp"),
			GITHUB_SHA: "0000000000000000000000000000000000000000",
			GITHUB_REF_NAME: tag,
			GITHUB_REF_TYPE: "tag",
			GITHUB_OUTPUT: outputFile,
			VERSION: version,
			SOLO_UPDATE_KEY: readFileSync(keyPath, "utf8"),
			GH_TOKEN: "fake-token",
			FAKE_GH_LOG: logFile,
			FAKE_RELEASE_STATE: process.env.FAKE_RELEASE_STATE ?? "none",
		};
		mkdirSync(env.RUNNER_TEMP, { recursive: true });
		const result = spawnSync("bash", [scriptFile], { cwd: root, env, encoding: "utf8" });
		return {
			status: result.status,
			output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
			calls: readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean),
		};
	};
	const report = (label, outcome) => {
		if (outcome.status === 0) {
			console.log(`${label} …… 过${outcome.calls.length > 0 ? `（假 gh 收到 ${outcome.calls.length} 条调用）` : ""}`);
			for (const call of outcome.calls) console.log(`    ${call}`);
			return true;
		}
		failed += 1;
		console.error(`${label} …… 红（退出码 ${String(outcome.status)}）`);
		console.error(outcome.output.split("\n").slice(-25).join("\n"));
		return false;
	};

	for (const [index, step] of steps.entries()) report(`段 ${index + 1} ${step.name}`, runStep(index, step));

	// 顺带验 dry_run：最后一段带上 DRY_RUN=1 再跑一遍，动手的三条一律只打印，真 gh 一条都不该调。
	const lastIndex = steps.length - 1;
	const dry = runStep(999, steps[lastIndex], { DRY_RUN: "1" });
	const writes = dry.calls.filter((call) => !call.startsWith("gh release view"));
	if (dry.status === 0 && writes.length === 0) {
		const printed = dry.output.split("\n").filter((line) => line.includes("[dry-run] 将执行"));
		console.log(`顺带验 dry_run=1：动手的 ${printed.length} 条只打印了，真 gh 一条没调（只读的 view 照旧）`);
		for (const line of printed) console.log(`    ${line}`);
	} else {
		failed += 1;
		console.error(`dry_run=1 不对：退出码 ${String(dry.status)}，真调了：${JSON.stringify(writes)}`);
		console.error(dry.output.split("\n").slice(-25).join("\n"));
	}

	const feedDir = join(root, "feed");
	const feedFiles = existsSync(feedDir) ? readdirSync(feedDir).sort() : [];
	if (feedFiles.length > 0) console.log(`feed 产出 ${feedFiles.length} 个文件：${feedFiles.join("、")}`);
	console.log(
		failed === 0
			? `publish 四段本地全跑通（假 gh，没建 Release、没传资产）。真发版前再跑一次这个，比等 CI 二十分钟便宜。`
			: `有 ${failed} 段红了，上面是原文。`,
	);
	process.exit(failed === 0 ? 0 : 1);
} finally {
	rmSync(root, { recursive: true, force: true });
}
