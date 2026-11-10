/**
 * 悬浮球的后端：把一段录音转成文字。
 *
 * 只做一件事 —— 面板上的麦克风录完，前端把音频 base64 发到 `/api/orb/transcribe`，
 * 这里落成临时文件，交给系统自带的端侧模型（macOS 26 的 SpeechAnalyzer，见 asr.swift）
 * 转写，回一行文字。**音频不出本机**：不接云端 STT、不要 API key、不留存档。
 *
 * 第一次转写会做两件事（都在本机）：
 * - 用 `swiftc` 把 asr.swift 编到临时目录（要有 Xcode 命令行工具）；
 * - 让系统下载一次对应语言的语音模型（之后一直命中本地）。
 *
 * 转写是串行的：同时来两段只会排队，不会抢着编译 / 抢着用模型。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
	DEFAULT_QWEN_SPEED,
	DEFAULT_QWEN_VOICE,
	QWEN_SPEED_MAX,
	QWEN_SPEED_MIN,
	QWEN_VOICES,
	clampQwenSpeed,
	isQwenVoice,
	synthesizeQwen,
} from "./qwen.js";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("./asr.swift", import.meta.url));
/** base64 的长度上限：整条 JSON 还要过接口层 1 MB 的闸。 */
// 30 秒 16 kHz 单声道 16 位 WAV ≈ 960 KB，base64 之后 ≈ 1.28 MB 字符。
const MAX_AUDIO = 1_400_000;
/** 转写的硬超时：超时 SIGKILL 掉转写器、回错误，不许无限挂着把 serial() 队列堵死。 */
const ASR_TIMEOUT = 30_000;
/** 规范化的死线：afconvert 自己也可能卡在坏容器上。 */
const CONVERT_TIMEOUT = 15_000;
const MAX_OUT = 2 * 1024 * 1024;

/**
 * 起一个子进程，**自己**看表：到点杀、并且一定 settle。
 *
 * 为什么不信 `execFile` 的 `timeout`：那个超时只在进程真的收得到信号、真的走掉时才算数。
 * solo-asr 打开解不开的音频时，AVAudioFile 抛错之后进程既不退出也不响应 SIGTERM，
 * 回调于是永远不回来 —— 父进程那条 promise 不 settle，`serial()` 整条链就跟着排死。
 * 这里三点都自己兜：SIGKILL 杀**进程组**（`detached` 起、`-pid` 杀，连带它可能起的子进程）、
 * `exit` 之后再兜一次、外加一个「必须 settle」的闸。
 */
function run(command, args, timeout) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const out = [];
		const err = [];
		let bytes = 0;
		let settled = false;
		let killedByTimeout = false;
		let seat = 0;

		const settle = (error, stdout, stderr) => {
			if (settled) return;
			settled = true;
			clearTimeout(seat);
			if (error === null) resolve({ stdout, stderr });
			else reject(error);
		};
		const kill = () => {
			killedByTimeout = true;
			try {
				// 整个进程组一起杀：负 pid。杀不掉（ENOENT / ESRCH）就当它已经走了。
				process.kill(-child.pid, "SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					/* 已经不在了 */
				}
			}
		};

		seat = setTimeout(() => {
			kill();
			// 杀完立刻 reject：不指望 child 的 exit 事件 —— 那正是这次不可靠的东西。
			const error = new Error(`转写超时：${String(Math.round(timeout / 1000))} 秒没有结果`);
			error.timedOut = true;
			error.stderr = Buffer.concat(err).toString("utf8");
			settle(error, "", error.stderr);
		}, timeout);

		child.stdout.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > MAX_OUT) {
				kill();
				settle(new Error("转写输出太大"), "", "");
				return;
			}
			out.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			err.push(chunk);
		});
		child.on("error", (error) => {
			error.stderr = Buffer.concat(err).toString("utf8");
			settle(error, "", error.stderr);
		});
		child.on("close", (code, signal) => {
			const stderr = Buffer.concat(err).toString("utf8");
			if (code === 0) {
				settle(null, Buffer.concat(out).toString("utf8"), stderr);
				return;
			}
			const error = new Error(
				killedByTimeout ? `转写超时：${String(Math.round(timeout / 1000))} 秒没有结果` : `命令失败：${command}（${String(signal ?? code)}）`,
			);
			error.code = code;
			error.signal = signal;
			error.timedOut = killedByTimeout;
			error.stderr = stderr;
			settle(error, "", stderr);
		});
		// 兜底：进程既不给 close 也不给 error（理论上不会，但这一条是「队列不许被堵」的底）。
		// 比 timeout 晚 5 秒才轮到；settle 幂等，先到的那个说了算。
		setTimeout(() => {
			if (settled) return;
			kill();
			settle(new Error("转写进程没有回应"), "", Buffer.concat(err).toString("utf8"));
		}, timeout + 5_000).unref();
	});
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

let build = null;

/** 编译好的转写器；同一份源码只编一次。`SOLO_ASR_BIN` 可以指到现成的二进制。 */
async function helper() {
	const override = process.env.SOLO_ASR_BIN;
	if (override !== undefined && override !== "") return override;

	const source = await readFile(SOURCE, "utf8");
	const dir = join(tmpdir(), "solo-orb-asr", createHash("sha256").update(source).digest("hex").slice(0, 12));
	const bin = join(dir, "solo-asr");
	if (await exists(bin)) return bin;
	if (build === null) {
		build = (async () => {
			await mkdir(dir, { recursive: true });
			try {
				await run("swiftc", ["-O", "-parse-as-library", SOURCE, "-o", bin], 180_000);
			} catch (error) {
				if (error.code === "ENOENT") throw new Error("转写要先装 Xcode 命令行工具：xcode-select --install");
				const detail = String(error.stderr ?? error.message).trim().split("\n").slice(-2).join(" ");
				throw new Error(`编译本地转写器失败：${detail}`);
			}
			if (!(await exists(bin))) throw new Error("编译本地转写器失败：没有产出可执行文件");
			return bin;
		})().finally(() => {
			build = null;
		});
	}
	return build;
}

/**
 * 进转写器之前一律换成 16k 单声道 wav：容器/编码是什么都不猜。
 *
 * 用系统自带的 afconvert（macOS 上没有 ffmpeg 也能跑），不引入新依赖。解不开的文件就在
 * 这一步明确报错 —— 坏文件不进 solo-asr，它打不开的时候是不退出的（见 ASR_TIMEOUT）。
 */
async function toWav(input, dir) {
	const out = join(dir, "voice.wav");
	try {
		await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16", "-c", "1", input, out], CONVERT_TIMEOUT);
	} catch (error) {
		if (error.code === "ENOENT") throw new Error("转写要用系统自带的 afconvert（/usr/bin/afconvert），这台机器上没有");
		throw new Error(`这段录音解不开：${String(error.stderr ?? error.message).trim()}`);
	}
	// 退出码 0 也不许盲信：afconvert 对残缺容器会出现「报完错还是落下个空 wav」的情形。
	// 产物不存在 / 没有音频帧，就在这一步判死，绝不把空 wav 喂给 solo-asr（它打不开就不退出）。
	const size = await stat(out).then((info) => info.size, () => 0);
	const header = await readFile(out).then((bytes) => bytes.subarray(0, 44), () => Buffer.alloc(0));
	const riff = header.length >= 12 && header.toString("latin1", 0, 4) === "RIFF" && header.toString("latin1", 8, 12) === "WAVE";
	const dataBytes = header.length >= 44 ? header.readUInt32LE(40) : 0;
	if (size <= 44 || !riff || dataBytes === 0) throw new Error("这段录音解不开：转换后没有音频数据");
	// 再核一遍这确实是有内容的 PCM：aiff / 32 位浮点这类「afconvert 认得、solo-asr 不认」的产物也在这里拦掉。
	const bits = header.length >= 44 ? header.readUInt16LE(34) : 0;
	const format = header.length >= 44 ? header.readUInt16LE(20) : 0;
	const channels = header.length >= 44 ? header.readUInt16LE(22) : 0;
	if (format !== 1 || bits === 0 || channels === 0 || dataBytes % (channels * (bits / 8)) !== 0) {
		throw new Error("这段录音解不开：转换出来的不是干净的 16 位 PCM");
	}
	return out;
}

function extensionOf(mime) {
	if (mime.includes("webm")) return "webm";
	if (mime.includes("ogg")) return "ogg";
	if (mime.includes("wav")) return "wav";
	if (mime.includes("mpeg")) return "mp3";
	return "m4a";
}

/**
 * 端侧模型按词吐结果，中文之间会带空格（「你好 ，今天」）。只收中文两侧的空格，
 * 英文单词之间的空格留着。
 */
function tidy(text) {
	return text
		.replace(/\s+([，。！？；：、）》」』】…—])/gu, "$1")
		.replace(/([（《「『【])\s+/gu, "$1")
		.replace(/([㐀-鿿])\s+(?=[㐀-鿿])/gu, "$1")
		.trim();
}

async function transcribe(body) {
	const audio = typeof body?.audio === "string" ? body.audio : "";
	if (audio === "") return { error: "没有收到录音" };
	if (audio.length > MAX_AUDIO) return { error: "这段录音太长了（上限约 30 秒）" };

	const bytes = Buffer.from(audio, "base64");
	if (bytes.length < 1_000) return { error: "录音太短，没听清" };

	const mime = typeof body?.mime === "string" ? body.mime : "audio/mp4";
	const raw = typeof body?.lang === "string" ? body.lang : "zh-CN";
	const lang = /^[a-zA-Z-]{2,16}$/u.test(raw) ? raw : "zh-CN";

	const dir = await mkdtemp(join(tmpdir(), "solo-orb-audio-"));
	try {
		const extension = extensionOf(mime);
		const saved = join(dir, `voice.${extension}`);
		await writeFile(saved, bytes);
		// 一律先规范成 16k 单声道 wav 再喂转写器（容器/编码不猜；解不开就在这一步明确报错）。
		const input = await toWav(saved, dir);

		const bin = await helper();
		const { stdout } = await run(bin, [input, lang], ASR_TIMEOUT);
		const text = tidy(stdout);
		return text === "" ? { error: "没听清，再说一次？" } : { text };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// ── 播报：本地 Kokoro 神经音色（Apache-2.0，可商用） ─────────────────────
//
// sherpa-onnx + Kokoro-82M v1.0 多语种模型。系统朗读那档（speechSynthesis）不要了：
// 它读中文是拼接合成，怎么挑音色都机械。这里不用 Matcha —— 那份中文模型训练自
// Baker 数据集，数据集声明仅限非商业用途（见 ADR-118）。
//
// 模型不进仓库、也不进插件目录（插件目录按 hash 整份同步，ADR-097），第一次用的
// 时候下到 `<appRoot>/voice/tts/kokoro-zh`，约 346 MB。

const TTS_DIR = "voice/tts/kokoro-zh";
const KOKORO_REV = "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b";
/** hf-mirror 先走（国内快），huggingface.co 兜底。 */
const TTS_MIRRORS = ["https://hf-mirror.com", "https://huggingface.co"];
/**
 * Kokoro v1.0 里的中文音色：八个，四女四男。`sid` 是 `voices.bin` 里的 speaker id，
 * 换音色只换这个数。默认 `zf_xiaoxiao`。
 */
const VOICES = [
	{ id: 45, name: "zf_xiaobei", label: "晓北", note: "女声 · 轻" },
	{ id: 46, name: "zf_xiaoni", label: "晓妮", note: "女声 · 亮" },
	{ id: 47, name: "zf_xiaoxiao", label: "晓晓", note: "女声 · 稳（默认）" },
	{ id: 48, name: "zf_xiaoyi", label: "晓伊", note: "女声 · 软" },
	{ id: 49, name: "zm_yunjian", label: "云健", note: "男声 · 沉" },
	{ id: 50, name: "zm_yunxi", label: "云希", note: "男声 · 清" },
	{ id: 51, name: "zm_yunxia", label: "云夏", note: "男声 · 温" },
	{ id: 52, name: "zm_yunyang", label: "云扬", note: "男声 · 亮" },
];
const KOKORO_SID = 47;
/** 全部钉在固定 revision 上：`main` 会漂，hash 就对不上了。 */
const TTS_FILES = [
	{
		name: "model.onnx",
		path: `csukuangfj/kokoro-multi-lang-v1_0/resolve/${KOKORO_REV}/model.onnx`,
		bytes: 325_560_556,
		sha256: "b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11",
	},
	{
		name: "voices.bin",
		path: `csukuangfj/kokoro-multi-lang-v1_0/resolve/${KOKORO_REV}/voices.bin`,
		bytes: 28_200_960,
		sha256: "1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29",
	},
	{
		name: "tokens.txt",
		path: `csukuangfj/kokoro-multi-lang-v1_0/resolve/${KOKORO_REV}/tokens.txt`,
		bytes: 687,
		sha256: "6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425",
	},
	{
		name: "lexicon-zh.txt",
		path: `csukuangfj/kokoro-multi-lang-v1_0/resolve/${KOKORO_REV}/lexicon-zh.txt`,
		bytes: 2_365_182,
		sha256: "902bc2d20ac7c449c5ecbbbb23c89d12119c03ed5b8ed27f114f0260c9e35229",
	},
	{
		name: "lexicon-us-en.txt",
		path: `csukuangfj/kokoro-multi-lang-v1_0/resolve/${KOKORO_REV}/lexicon-us-en.txt`,
		bytes: 5_956_885,
		sha256: "7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14",
	},
	{
		name: "date-zh.fst",
		path: `csukuangfj/kokoro-multi-lang-v1_0/resolve/${KOKORO_REV}/date-zh.fst`,
		bytes: 59_154,
		sha256: "eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718",
	},
	{
		name: "number-zh.fst",
		path: `csukuangfj/kokoro-multi-lang-v1_0/resolve/${KOKORO_REV}/number-zh.fst`,
		bytes: 64_482,
		sha256: "743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd",
	},
	{
		name: "phone-zh.fst",
		path: `csukuangfj/kokoro-multi-lang-v1_0/resolve/${KOKORO_REV}/phone-zh.fst`,
		bytes: 88_630,
		sha256: "1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7",
	},
];
const TTS_BYTES = TTS_FILES.reduce((sum, file) => sum + file.bytes, 0);

let ttsRoot = "";
let log = () => {};
const ttsState = { downloading: false, progress: 0, error: "" };

async function hasModel() {
	for (const file of TTS_FILES) {
		try {
			const info = await stat(join(ttsRoot, file.name));
			if (info.size !== file.bytes) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * 从应用安装目录解析 sherpa-onnx-node。
 *
 * 插件住在 `<appRoot>/plugins/<slug>/`（桌面端就是 userData），往上一路找 node_modules
 * 找不到依赖；后端入口在 `<install>/src/shell/main.ts`，所以按 `process.argv[1]` 倒推
 * 安装根，再退到 cwd 和插件自己的目录。
 */
function loadSherpa() {
	const roots = [];
	const entry = process.argv[1];
	if (typeof entry === "string" && entry !== "") roots.push(resolve(dirname(entry), "..", ".."));
	roots.push(process.cwd(), dirname(fileURLToPath(import.meta.url)));
	for (const root of roots) {
		try {
			return createRequire(join(root, "package.json"))("sherpa-onnx-node");
		} catch (error) {
			if (error?.code !== "MODULE_NOT_FOUND") throw error;
		}
	}
	throw new Error("语音运行时没装好（sherpa-onnx-node）");
}

/**
 * 合成一句。**模型不留在后端进程里**：交给一次性子进程 `tts-worker.js`，
 * 它建模型、念完、退出，346MB 随进程一起还给系统。
 *
 * 为什么必须这样：`sherpa-onnx.node` 只导出 `create*`，一个 `destroy`/`free`
 * 都没有（翻过符号表），`OfflineTts` 建出来后没有任何办法释放。留在后端就是常驻。
 *
 * 代价：每句多一次模型加载，实测 575ms 加载 + 241ms 合成。
 * 旧的常驻写法省掉这 575ms，代价是后端起机就吃 346MB 到关机。
 */
function synthInWorker(text, speed, sid) {
	return new Promise((settle, rejectPromise) => {
		const worker = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "tts-worker.js")], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		});
		let out = "";
		let err = "";
		let settled = false;
		// 这里**不能** kill：worker 是念完自己 exit 的，这时 stdout 可能还在往管道里灌，
		// kill 会把剩下的字节截掉（实测卡在 64KB 管道缓冲）。只清定时器和兑现 Promise。
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			settle(value);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker.kill();
			rejectPromise(error);
		};
		// 载模型 + 合成一起给 120 秒：慢机器上第一句可能久一点，但不能永远挂着。
		const timer = setTimeout(() => {
			fail(new Error("语音合成超时（120 秒）"));
		}, 120_000);
		worker.stdout.setEncoding("utf8");
		worker.stdout.on("data", (chunk) => {
			out += chunk;
		});
		worker.stderr.setEncoding("utf8");
		worker.stderr.on("data", (chunk) => {
			err += chunk;
		});
		worker.on("error", (error) => {
			fail(error);
		});
		// 用 close 而不是 exit：exit 可能早于 stdout 读干净，超长的一行 JSON 会被截半。
		// 只在 stdout 的 "end" 之后取结果：单行 JSON 可能几百 KB，管道缓冲只有 64KB，
		// 先到 close 就读到半截（实测正好卡在 65536 字节）。`end` 之后再等 close 就没意义了。
		worker.stdout.on("end", () => {
			const lines = out.trim().split("\n");
			const line = lines[lines.length - 1] ?? "";
			if (line === "") {
				finish({ error: err.trim() === "" ? "语音进程没说话就退了" : err.trim() });
				return;
			}
			try {
				finish(JSON.parse(line));
			} catch {
				finish({ error: `语音进程回了看不懂的东西：${line.slice(0, 200)}` });
			}
		});
		// 进程没了但 stdout 没 end（崩了 / 被系统杀了）：给个能看懂的错，别让请求挂着。
		worker.on("close", () => {
			if (settled) return;
			finish({ error: err.trim() === "" ? "语音进程没说话就退了" : err.trim() });
		});
		worker.stdin.end(JSON.stringify({ text, speed, sid, ttsRoot, numThreads: 8 }));
	});
}

function encodeWav(samples, sampleRate) {
	const data = Buffer.alloc(samples.length * 2);
	for (let index = 0; index < samples.length; index += 1) {
		const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
		data.writeInt16LE(Math.round(value * 32_767), index * 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]).toString("base64");
}

/**
 * 合成一段。Electron-as-node 里 `generate()` 会抛 "External buffers are not allowed"，
 * 只能走 `generateAsync` 的进度回调；它结束时常带一句 "TTS settlement failed"，
 * 但音频已经完整交出来了 —— 有 chunk 就照用。
 */
async function synth(text, speed, sid) {
	const result = await synthInWorker(text, speed, sid);
	if (typeof result?.wav === "string" && result.wav !== "") return result.wav;
	throw new Error(typeof result?.error === "string" && result.error !== "" ? result.error : "没有合成出声音");
}

async function fetchModelFile(origin, file, onBytes) {
	const response = await fetch(`${origin}/${file.path}`);
	if (!response.ok || response.body === null) throw new Error(`下载失败 HTTP ${String(response.status)}`);
	const part = join(ttsRoot, `${file.name}.part`);
	const hash = createHash("sha256");
	let received = 0;
	const stream = Readable.fromWeb(response.body);
	stream.on("data", (chunk) => {
		hash.update(chunk);
		received += chunk.length;
		onBytes(received);
	});
	await pipeline(stream, createWriteStream(part));
	if (received !== file.bytes) {
		await rm(part, { force: true });
		throw new Error(`${file.name} 大小不对（${String(received)}）`);
	}
	if (hash.digest("hex") !== file.sha256) {
		await rm(part, { force: true });
		throw new Error(`${file.name} 校验不对`);
	}
	await rename(part, join(ttsRoot, file.name));
}

async function downloadModel() {
	if (ttsState.downloading) return;
	ttsState.downloading = true;
	ttsState.progress = 0;
	ttsState.error = "";
	try {
		await mkdir(ttsRoot, { recursive: true });
		let done = 0;
		for (const file of TTS_FILES) {
			try {
				const info = await stat(join(ttsRoot, file.name));
				if (info.size === file.bytes) {
					done += file.bytes;
					ttsState.progress = done / TTS_BYTES;
					continue;
				}
			} catch {
				// 还没有，下面去下。
			}
			let last = "";
			let ok = false;
			for (const origin of TTS_MIRRORS) {
				try {
					await fetchModelFile(origin, file, (received) => {
						ttsState.progress = (done + Math.min(received, file.bytes)) / TTS_BYTES;
					});
					ok = true;
					break;
				} catch (error) {
					last = error instanceof Error ? error.message : String(error);
				}
			}
			if (!ok) throw new Error(last === "" ? "下载失败" : last);
			done += file.bytes;
			ttsState.progress = done / TTS_BYTES;
		}
		ttsState.progress = 1;
	} catch (error) {
		ttsState.error = error instanceof Error ? error.message : String(error);
		log(`语音模型下载失败：${ttsState.error}`);
	} finally {
		ttsState.downloading = false;
	}
}

async function voiceStatus() {
	return {
		present: await hasModel(),
		downloading: ttsState.downloading,
		progress: ttsState.progress,
		error: ttsState.error,
		bytes: TTS_BYTES,
		default: KOKORO_SID,
		voices: VOICES.map((voice) => ({ id: voice.id, name: voice.name, label: voice.label, note: voice.note })),
	};
}

let speakChain = Promise.resolve();

function serialSpeak(task) {
	const next = speakChain.then(task, task);
	speakChain = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

// ── 播报用哪一套：本地 Kokoro / 千问云端（阿里云百炼） ───────────────────
//
// 照 dsh-orb-cordis 的商用方案：设置里选一种，Key 存在本机的语音配置里
// （`<appRoot>/orb/voice.json`，不进插件目录，也不进日志）。选了千问就不回退本地。

const SPEECH_FILE = "orb/voice.json";
const SPEECH_DEFAULT = {
	engine: "local",
	apiKey: "",
	qwenVoice: DEFAULT_QWEN_VOICE,
	qwenSpeed: DEFAULT_QWEN_SPEED,
};
let speechRoot = "";

function tidySpeech(raw) {
	const value = typeof raw === "object" && raw !== null ? raw : {};
	return {
		engine: value.engine === "qwen" ? "qwen" : "local",
		apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
		qwenVoice: isQwenVoice(value.qwenVoice) ? value.qwenVoice : DEFAULT_QWEN_VOICE,
		qwenSpeed: clampQwenSpeed(value.qwenSpeed ?? DEFAULT_QWEN_SPEED),
	};
}

async function readSpeech() {
	try {
		return tidySpeech(JSON.parse(await readFile(join(speechRoot, SPEECH_FILE), "utf8")));
	} catch {
		return { ...SPEECH_DEFAULT };
	}
}

async function writeSpeech(next) {
	const file = join(speechRoot, SPEECH_FILE);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(`${file}.tmp`, JSON.stringify(next, null, 2));
	await rename(`${file}.tmp`, file);
	return next;
}

async function speechStatus() {
	const speech = await readSpeech();
	return {
		engine: speech.engine,
		hasKey: speech.apiKey.trim() !== "",
		qwenVoice: speech.qwenVoice,
		qwenSpeed: speech.qwenSpeed,
		voices: QWEN_VOICES,
		defaultVoice: DEFAULT_QWEN_VOICE,
		speedMin: QWEN_SPEED_MIN,
		speedMax: QWEN_SPEED_MAX,
	};
}

/** 设置页一次改几项：Key 只在明确给了字符串时才动（空串 = 清掉）。 */
async function saveSpeech(body) {
	const old = await readSpeech();
	const next = {
		engine: body?.engine === "qwen" || body?.engine === "local" ? body.engine : old.engine,
		apiKey: typeof body?.apiKey === "string" ? body.apiKey.trim() : old.apiKey,
		qwenVoice: isQwenVoice(body?.qwenVoice) ? body.qwenVoice : old.qwenVoice,
		qwenSpeed: body?.qwenSpeed === undefined ? old.qwenSpeed : clampQwenSpeed(body.qwenSpeed),
	};
	await writeSpeech(next);
	return speechStatus();
}

// ── 唤醒词：本地 sherpa-onnx KWS（wenetspeech 3.3M，约 4.8 MB） ────────────
//
// 关键词是拼音（`n ǐ h ǎo s uǒ l uó` = 你好索罗）。模型小、常听不费电；
// 只为「点一下才听」留个例外，唤醒后立刻把麦克风交给录音，不常开。

const WAKE_DIR = "voice/kws-zh";
const WAKE_BASE = "https://modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/resolve/master";
const WAKE_KEYWORDS = [
	"n ǐ h ǎo s uǒ l uó @你好索罗",
	"n ǐ h ǎo zh ù l ǐ @你好助理",
	"x iǎo s uǒ @小索",
].join("\n") + "\n";
const WAKE_FILES = [
	{
		name: "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
		bytes: 4_807_159,
		sha256: "017af32f2c0138f931d05fbc009ee864295e910aff304f77d2f563815fc834fb",
	},
	{
		name: "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
		bytes: 181_025,
		sha256: "fe53b8d6a07bc5373d1770649025a5a985c8fb3dab70323386a1b73aacba0546",
	},
	{
		name: "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
		bytes: 65_208,
		sha256: "431de10b554f134ef8af320feea2db337e641290449a3d3f6cb6e5f5fd2c9c3d",
	},
	{ name: "tokens.txt", bytes: 1_627, sha256: "72316508d9119696145abc6f1f8cdc46287535c34e5ce7e595f845cb1499cf2e" },
];
const WAKE_BYTES = WAKE_FILES.reduce((sum, file) => sum + file.bytes, 0);
let wakeRoot = "";
const wakeState = { downloading: false, progress: 0, error: "" };
let spotter;
let wakeStream;

async function hasWakeModel() {
	for (const file of WAKE_FILES) {
		try {
			const info = await stat(join(wakeRoot, file.name));
			if (info.size !== file.bytes) return false;
		} catch {
			return false;
		}
	}
	return true;
}

async function fetchWakeFile(file, onBytes) {
	const response = await fetch(`${WAKE_BASE}/${file.name}`);
	if (!response.ok || response.body === null) throw new Error(`下载失败 HTTP ${String(response.status)}`);
	const part = join(wakeRoot, `${file.name}.part`);
	const hash = createHash("sha256");
	let received = 0;
	const stream = Readable.fromWeb(response.body);
	stream.on("data", (chunk) => {
		hash.update(chunk);
		received += chunk.length;
		onBytes(received);
	});
	await pipeline(stream, createWriteStream(part));
	if (received !== file.bytes) {
		await rm(part, { force: true });
		throw new Error(`${file.name} 大小不对（${String(received)}）`);
	}
	if (hash.digest("hex") !== file.sha256) {
		await rm(part, { force: true });
		throw new Error(`${file.name} 校验不对`);
	}
	await rename(part, join(wakeRoot, file.name));
}

async function downloadWake() {
	if (wakeState.downloading) return;
	wakeState.downloading = true;
	wakeState.progress = 0;
	wakeState.error = "";
	try {
		await mkdir(wakeRoot, { recursive: true });
		await writeFile(join(wakeRoot, "keywords.txt"), WAKE_KEYWORDS);
		let done = 0;
		for (const file of WAKE_FILES) {
			try {
				const info = await stat(join(wakeRoot, file.name));
				if (info.size === file.bytes) {
					done += file.bytes;
					wakeState.progress = done / WAKE_BYTES;
					continue;
				}
			} catch {
				// 还没有，下面去下。
			}
			await fetchWakeFile(file, (received) => {
				wakeState.progress = (done + Math.min(received, file.bytes)) / WAKE_BYTES;
			});
			done += file.bytes;
			wakeState.progress = done / WAKE_BYTES;
		}
		wakeState.progress = 1;
	} catch (error) {
		wakeState.error = error instanceof Error ? error.message : String(error);
		log(`唤醒模型下载失败：${wakeState.error}`);
	} finally {
		wakeState.downloading = false;
	}
}

async function wakeStatus() {
	return {
		present: await hasWakeModel(),
		downloading: wakeState.downloading,
		progress: wakeState.progress,
		error: wakeState.error,
		bytes: WAKE_BYTES,
	};
}

async function wakeSpotter() {
	if (spotter !== undefined) return spotter;
	const sherpa = loadSherpa();
	const keywords = join(wakeRoot, "keywords.txt");
	await writeFile(keywords, WAKE_KEYWORDS);
	spotter = new sherpa.KeywordSpotter({
		featConfig: { sampleRate: 16_000, featureDim: 80 },
		modelConfig: {
			transducer: {
				encoder: join(wakeRoot, WAKE_FILES[0].name),
				decoder: join(wakeRoot, WAKE_FILES[1].name),
				joiner: join(wakeRoot, WAKE_FILES[2].name),
			},
			tokens: join(wakeRoot, "tokens.txt"),
			numThreads: 1,
			provider: "cpu",
		},
		keywordsFile: keywords,
		keywordsScore: 1.0,
		keywordsThreshold: 0.25,
	});
	return spotter;
}

/** 吃一段 16 kHz 浮点 PCM（base64 的 Float32），回这一小段里有没有叫醒。 */
async function feedWake(samples, reset) {
	const kws = await wakeSpotter();
	if (wakeStream === undefined) wakeStream = kws.createStream();
	if (reset) {
		kws.reset(wakeStream);
		return { hit: false };
	}
	wakeStream.acceptWaveform({ samples, sampleRate: 16_000 });
	const hits = [];
	while (kws.isReady(wakeStream)) {
		kws.decode(wakeStream);
		const keyword = kws.getResult(wakeStream).keyword;
		if (typeof keyword === "string" && keyword !== "") hits.push(keyword);
	}
	if (hits.length > 0) {
		kws.reset(wakeStream);
		return { hit: true, keyword: hits[0] };
	}
	return { hit: false };
}

let chain = Promise.resolve();

/** 串行：两段录音同时到，第二段等第一段转完。 */
function serial(task) {
	const next = chain.then(task, task);
	chain = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

export function apply(api) {
	ttsRoot = join(api.workspace, TTS_DIR);
	speechRoot = api.workspace;
	wakeRoot = join(api.workspace, WAKE_DIR);
	log = (line) => {
		api.log(line);
	};
	api.route({
		method: "GET",
		pattern: "/api/orb/voice",
		handle: async () => voiceStatus(),
	});
	api.route({
		method: "POST",
		pattern: "/api/orb/voice",
		handle: async () => {
			void downloadModel();
			return voiceStatus();
		},
	});
	api.route({
		method: "GET",
		pattern: "/api/orb/speech",
		handle: async () => speechStatus(),
	});
	api.route({
		method: "POST",
		pattern: "/api/orb/speech",
		handle: async (request) => {
			try {
				return await saveSpeech(request.body);
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		},
	});
	api.route({
		method: "POST",
		pattern: "/api/orb/speak",
		handle: async (request) =>
			serialSpeak(async () => {
				try {
					const raw = typeof request.body?.text === "string" ? request.body.text : "";
					const text = raw.trim();
					if (text === "") return { error: "没有要念的字" };
					const speech = await readSpeech();
					if (speech.engine === "qwen") {
						if (speech.apiKey.trim() === "") return { error: "千问还没填 API Key", needKey: true };
						if (text.length > 1_000) return { error: "这句太长了（上限 1000 字）" };
						const wav = await synthesizeQwen({
							text,
							apiKey: speech.apiKey,
							voice: speech.qwenVoice,
							speed: speech.qwenSpeed,
						});
						return { wav, engine: "qwen" };
					}
					if (!(await hasModel())) return { error: "语音模型还没下载", needModel: true };
					if (text.length > 400) return { error: "这句太长了（上限 400 字）" };
					const speedRaw = Number(request.body?.speed ?? 1);
					const speed = Number.isFinite(speedRaw) ? Math.min(2, Math.max(0.5, speedRaw)) : 1;
					const sidRaw = Number(request.body?.sid ?? KOKORO_SID);
					const sid = VOICES.some((voice) => voice.id === sidRaw) ? sidRaw : KOKORO_SID;
					return { wav: await synth(text, speed, sid), engine: "local" };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log(`朗读没成：${message}`);
					return { error: message };
				}
			}),
	});
	api.route({
		method: "GET",
		pattern: "/api/orb/wake",
		handle: async () => wakeStatus(),
	});
	api.route({
		method: "POST",
		pattern: "/api/orb/wake",
		handle: async () => {
			void downloadWake();
			return wakeStatus();
		},
	});
	api.route({
		method: "POST",
		pattern: "/api/orb/kws",
		handle: async (request) =>
			serial(async () => {
				try {
					const reset = request.body?.reset === true;
					if (!reset && !(await hasWakeModel())) return { error: "唤醒模型还没下载", needModel: true };
					if (reset) return await feedWake(new Float32Array(0), true);
					const raw = typeof request.body?.samples === "string" ? request.body.samples : "";
					if (raw === "") return { hit: false };
					const bytes = Buffer.from(raw, "base64");
					const copy = new Uint8Array(bytes.length);
					copy.set(bytes);
					return await feedWake(new Float32Array(copy.buffer, 0, Math.floor(copy.length / 4)), false);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log(`唤醒没成：${message}`);
					return { error: message };
				}
			}),
	});
	api.route({
		method: "POST",
		pattern: "/api/orb/transcribe",
		handle: async (request) =>
			serial(async () => {
				try {
					const result = await transcribe(request.body);
					if (result.error !== undefined) api.log(`转写没成：${result.error}`);
					return result;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					api.log(`转写没成：${message}`);
					return { error: message };
				}
			}),
	});
}
