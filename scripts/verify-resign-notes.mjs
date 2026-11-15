/**
 * `resign-notes` 那个 job 的本地干跑：把 yml 里的 `run:` 段抠出来真跑一遍。
 *
 * 为什么单独一个：这条路只换两个文件、不碰 139MB 的包，出错的地方全在「细节」上——
 * 上传列表里多写一个文件名、`files` 段被重算成别的值、dry_run 忘了挡——真跑一次就知道。
 *
 * 干跑里用的不是假密钥：本地那把私钥签完、`src/core/signing.ts` 用源码里那把公钥验一遍，
 * 验不过就是真过不了（用户端用的就是这把公钥）。
 *
 * 两条硬断言：
 *   1. 跑完以后 dmg / zip 的名字、sha256、字节数三个都没变（假 gh 现算，不是抄的）；
 *   2. `feat`/`fix` 之外没人上传二进制：假 gh 记的账里只有 `latest-mac.json` 和它的 `.sig`。
 *
 * 用法：node --experimental-strip-types scripts/verify-resign-notes.mjs
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySignature } from "../src/core/signing.ts";
import { UPDATE_PUBLIC_KEY } from "../desktop/src/update-key.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ymlPath = join(repo, ".github/workflows/release.yml");
const keyPath = process.env.SOLO_UPDATE_KEY_FILE ?? join(homedir(), ".solo-update-key.pem");
if (!existsSync(keyPath)) {
	console.error(`没有发布私钥 ${keyPath}：签不了，这一步就是空跑。有私钥再跑，别把它当成验过了。`);
	process.exit(1);
}

const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const tag = `v${version}`;

/** 从 yml 里抠某个 job 的 `- name:` + `run: |` 段，保持文件里的顺序。 */
function jobSteps(text, job) {
	const start = text.search(new RegExp(`^  ${job}:$`, "m"));
	if (start < 0) throw new Error(`release.yml 里没有 ${job} job`);
	const afterHeader = text.slice(start);
	const body0 = afterHeader.slice(afterHeader.indexOf("\n") + 1);
	const end = body0.search(/^  [a-zA-Z-]+:$/m);
	const body = end < 0 ? body0 : body0.slice(0, end);
	const steps = [];
	for (const chunk of body.split(/^ {6}- name: /m).slice(1)) {
		const name = chunk.split("\n")[0].trim();
		const run = /^ {8}run: \|\n((?: {10}.*\n|\n)*)/m.exec(chunk);
		if (run === null) continue;
		const script = run[1]
			.split("\n")
			.map((line) => (line.startsWith("          ") ? line.slice(10) : line))
			.join("\n");
		steps.push({ name, script });
	}
	return steps;
}

const steps = jobSteps(readFileSync(ymlPath, "utf8"), "resign-notes");
if (steps.length === 0) throw new Error("resign-notes 里一段 run: 都没抠到，先看 yml 的缩进是不是变了");

const root = mkdtempSync(join(tmpdir(), "solo-resign-dryrun-"));
const fail = (message) => {
	console.error(`✗ ${message}`);
	process.exitCode = 1;
};
try {
	for (const name of ["scripts", "node_modules"]) {
		const from = join(repo, name);
		if (existsSync(from)) symlinkSync(from, join(root, name));
	}

	// 文案：仓库里有就用仓库那份（那才是 CI 会读到的），没有就现场造一份。
	const notesRel = `release-notes/${version}.txt`;
	if (existsSync(join(repo, notesRel))) {
		mkdirSync(join(root, "release-notes"), { recursive: true });
		copyFileSync(join(repo, notesRel), join(root, notesRel));
		console.log(`文案用仓库里的 ${notesRel}`);
	} else {
		mkdirSync(join(root, "release-notes"), { recursive: true });
		writeFileSync(
			join(root, notesRel),
			[
				"· 派活时把活记进板：归谁、到哪一步、卡在谁那，右栏一眼看得见；没活时就空着",
				"· 派活顺手定验收标准，板上标出「缺验收」，一件活只交给一个人",
				"· 跳到某条消息时停在靠上的位置，好接着往下看",
				"· 往上翻着看更早的消息，位置不再突然跳掉一页",
				"· 语音不再一上来就要授权，第一次会等 30 秒再问",
				"",
			].join("\n"),
		);
		console.log(`仓库里还没有 ${notesRel}，干跑临时造了一份（5 条）`);
	}

	// 假 Release：线上那份清单 + 两个假二进制（内容随便，但 sha256 真算，改了就能发现）。
	const release = join(root, "fake-release");
	mkdirSync(release, { recursive: true });
	for (const asset of [`Solo-${version}-arm64.dmg`, `Solo-${version}-arm64.zip`]) {
		writeFileSync(join(release, asset), `假产物 ${asset}\n`.repeat(64));
	}
	const zipBytes = readFileSync(join(release, `Solo-${version}-arm64.zip`));
	const { createHash, createPrivateKey, sign } = await import("node:crypto");
	const onlineManifest = `${JSON.stringify(
		{
			version,
			notes: ["旧的一条内部话：跳转用例别再读没落地的 TaskBoard.tsx"],
			files: {
				darwin: {
					file: `Solo-${version}-arm64.zip`,
					sha512: createHash("sha512").update(zipBytes).digest("base64"),
					size: zipBytes.length,
				},
			},
		},
		null,
		2,
	)}\n`;
	const privateKey = createPrivateKey(readFileSync(keyPath));
	writeFileSync(join(release, "latest-mac.json"), onlineManifest);
	writeFileSync(join(release, "latest-mac.json.sig"), `${sign(null, Buffer.from(onlineManifest, "utf8"), privateKey).toString("base64")}\n`);

	// 假 gh：`view --json assets` 现算 sha256（所以「二进制被换掉」它自己就会露），
	// `upload` 真写回假 Release 目录，其它一律记账。
	mkdirSync(join(root, "bin"), { recursive: true });
	const fakeGh = join(root, "bin", "gh");
	writeFileSync(
		fakeGh,
		`#!/bin/bash
set -uo pipefail
echo "gh $*" >> "\${FAKE_GH_LOG:?}"
args="\$*"
case "\$1 \$2" in
  "release view")
    case "\$args" in
      *"--json tagName"*) echo "${tag}" ;;
      *"--json assets"*)
        for f in "\${FAKE_RELEASE_DIR:?}"/*.zip "\${FAKE_RELEASE_DIR:?}"/*.dmg "\${FAKE_RELEASE_DIR:?}"/*.exe; do
          [ -f "\$f" ] || continue
          echo "\$(basename "\$f") sha256:\$(shasum -a 256 "\$f" | cut -c1-32) \$(wc -c < "\$f" | tr -d ' ')"
        done ;;
      *) echo "[假 gh] 不认识的 release view：\$args" >&2; exit 1 ;;
    esac ;;
  "release download")
    dest="."
    prev=""
    for arg in "\$@"; do
      if [ "\$prev" = "-D" ]; then dest="\$arg"; fi
      prev="\$arg"
    done
    mkdir -p "\$dest"
    cp "\$FAKE_RELEASE_DIR"/latest-mac.json "\$dest"/
    cp "\$FAKE_RELEASE_DIR"/latest-mac.json.sig "\$dest"/ ;;
  "release upload")
    skip=3
    for arg in "\$@"; do
      if [ "\$skip" -gt 0 ]; then skip=\$((skip-1)); continue; fi
      case "\$arg" in --*) continue ;; esac
      if [ ! -f "\$arg" ]; then echo "[假 gh] 要传的文件不存在：\$arg" >&2; exit 1; fi
      cp "\$arg" "\${FAKE_RELEASE_DIR:?}/\$(basename "\$arg")"
    done ;;
  *) echo "[假 gh] 没预料到的调用：gh \$args" >&2; exit 1 ;;
esac
exit 0
`,
	);
	chmodSync(fakeGh, 0o755);

	const env = {
		...process.env,
		PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
		FAKE_GH_LOG: join(root, "gh.log"),
		FAKE_RELEASE_DIR: release,
		RUNNER_TEMP: join(root, "runner-temp"),
		SOLO_UPDATE_KEY: readFileSync(keyPath, "utf8"),
		GH_TOKEN: "fake-token",
		GITHUB_OUTPUT: join(root, "github-output"),
	};
	mkdirSync(env.RUNNER_TEMP, { recursive: true });
	writeFileSync(env.FAKE_GH_LOG, "");
	writeFileSync(env.GITHUB_OUTPUT, "");

	const substitute = (script, stepName, tagValue) =>
		script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr) => {
			const table = {
				"inputs.tag": "",
				"inputs.notes_file": notesRel,
				"github.token": "fake-token",
				"steps.pick.outputs.tag": tagValue,
			};
			if (table[expr] === undefined) throw new Error(`${stepName} 里有个本地替不了的表达式：${whole.trim()}`);
			return table[expr];
		});

	const runStep = (step, tagValue, extraEnv = {}) => {
		const script = substitute(step.script, step.name, tagValue);
		const result = spawnSync("bash", ["-c", script], { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8" });
		if (result.status !== 0) {
			throw new Error(`「${step.name}」跑挂了（退出码 ${String(result.status)}）\n${result.stdout}\n${result.stderr}`);
		}
		return result;
	};

	// 第一趟：dry_run（默认就是它）。这一趟不许有一次 upload。
	let tagValue = "";
	for (const step of steps) {
		const out = runStep(step, tagValue, { DRY_RUN: "1" });
		if (step.name === "选 tag") {
			const line = readFileSync(env.GITHUB_OUTPUT, "utf8").split("\n").find((l) => l.startsWith("tag="));
			tagValue = (line ?? "").slice(4);
			if (tagValue !== tag) throw new Error(`选 tag 选出来的是「${tagValue}」，不是 ${tag}`);
			console.log(`选 tag → ${tagValue}`);
		}
		process.stdout.write(`「${step.name}」过\n`);
		void out;
	}
	const dryLog = readFileSync(env.FAKE_GH_LOG, "utf8");
	if (/release upload/.test(dryLog)) fail("dry_run=1 的时候还调了 upload");
	// 那一步在 dry_run 下必须自己说清「这次只演」：不然看日志的人以为传上去了。
	const uploadStep = steps.find((step) => step.name.startsWith("只传那两个文件"));
	if (!runStep(uploadStep, tagValue, { DRY_RUN: "1" }).stdout.includes("[dry-run]")) {
		fail("dry_run=1 那步没打印 [dry-run]，看着像真传了");
	}

	// 第二趟：真传。传完只许清单和它的 .sig 变。
	writeFileSync(env.FAKE_GH_LOG, "");
	for (const step of steps.slice(3)) runStep(step, tagValue, { DRY_RUN: "" });
	const realLog = readFileSync(env.FAKE_GH_LOG, "utf8");
	const uploads = realLog.split("\n").filter((line) => line.startsWith("gh release upload"));
	if (uploads.length !== 1) fail(`真传那趟 upload 调了 ${String(uploads.length)} 次，应该正好一次`);
	const uploaded = (uploads[0] ?? "").split(/\s+/).filter((token) => token.startsWith("feed/") || token.startsWith("dist/"));
	if (JSON.stringify(uploaded) !== JSON.stringify(["feed/latest-mac.json", "feed/latest-mac.json.sig"])) {
		fail(`传上去的东西不对：${uploaded.join(" ")}`);
	}

	// 硬断言：二进制三个数都没变（before.txt / after.txt 是 job 自己记的账）。
	const before = readFileSync(join(root, "before.txt"), "utf8");
	const after = readFileSync(join(root, "after.txt"), "utf8");
	if (before.trim() === "" ) fail("before.txt 是空的：假 gh 的资产列表没生效，这条断言等于没验");
	if (before !== after) fail(`二进制变了：\n传之前\n${before}传之后\n${after}`);
	console.log(`二进制没变（${String(before.trim().split("\n").length)} 个：\n${before.trim()}\n）`);

	// 新清单：notes 换成 5 条、files 段一个字节没动、签名用源码公钥验得过。
	const oldManifest = JSON.parse(onlineManifest);
	const next = JSON.parse(readFileSync(join(root, "feed", "latest-mac.json"), "utf8"));
	if (JSON.stringify(next.files) !== JSON.stringify(oldManifest.files)) fail("files 段被改过了");
	if (next.version !== oldManifest.version) fail("version 被改过了");
	const expected = readFileSync(join(root, notesRel), "utf8")
		.split("\n")
		.map((line) => line.replace(/^\s*[·•\-*]\s*/, "").trim())
		.filter((line) => line !== "");
	if (JSON.stringify(next.notes) !== JSON.stringify(expected)) fail(`notes 不对：${JSON.stringify(next.notes)}`);
	const sig = readFileSync(join(root, "feed", "latest-mac.json.sig"), "utf8").trim();
	const text = readFileSync(join(root, "feed", "latest-mac.json"), "utf8");
	if (!verifySignature(UPDATE_PUBLIC_KEY, text, sig)) fail("新清单的签名用源码里那把公钥验不过");
	console.log(`notes ${String(next.notes.length)} 条、签名用 ${basename(join(repo, "desktop/src/update-key.ts"))} 里那把公钥验过`);

	if (process.exitCode === 1) {
		console.error("干跑没过，别拿去 CI 上试。");
	} else {
		console.log("resign-notes 干跑全过：只换了 notes，二进制一个字节没变，签名源码公钥验得过。");
	}
} finally {
	if (process.exitCode !== 1) spawnSync("rm", ["-rf", root]);
	else console.log(`中间产物留在 ${root}`);
}
