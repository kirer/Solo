/**
 * 一次性的语音合成进程。
 *
 * sherpa-onnx 的原生绑定只有 `create*`，没有任何 `destroy`/`free`（查过
 * `sherpa-onnx.node` 的导出符号表），`OfflineTts` 这个 C++ 对象一旦建出来，
 * 346MB 的 Kokoro 权重就再也还不给系统了 —— 留在后端进程里就是常驻。
 *
 * 所以合成放到这个子进程里做：主进程把活交给它，它建模型、念完、把 wav 交回去、
 * 立刻退出。进程一没，模型占的内存全归还。代价是每句多一次 ~575ms 的模型加载
 * （实测：加载 575ms，合成 241ms）。
 *
 * 协议：stdin 收一行 JSON `{ text, speed, sid }`，stdout 吐一行 JSON
 * `{ wav }` 或 `{ error }`。只合一句就退出。
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 找到 sherpa-onnx-node。
 *
 * **第一顺位是主进程递过来的 `SOLO_SHERPA_ROOT`**：worker 的 `argv[1]` 是插件目录、
 * cwd 跟着启动它的 App 走（Finder 双击起的是 `/`），自己猜那几处会全落空 ——
 * 之前语音整体哑、却报「运行时没装好」就是这个。剩下几处只在手动跑（比如单测、
 * 命令行直接调）时兜底。
 */
function loadSherpa() {
	const roots = [];
	const handed = process.env.SOLO_SHERPA_ROOT;
	if (handed !== undefined && handed !== "") roots.push(handed);
	roots.push(process.cwd(), resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
	const tried = [];
	for (const root of roots) {
		try {
			return createRequire(join(root, "package.json"))("sherpa-onnx-node");
		} catch (error) {
			if (error?.code !== "MODULE_NOT_FOUND") throw error;
			tried.push(root);
		}
	}
	// 说清楚找过哪儿：光说「没装好」会把好端端装着的包判成没装，把人往错的方向带。
	throw new Error(
		`语音运行时没装好：找不到 sherpa-onnx-node（找过 ${tried.join("、") || "（无可用路径）"}）。` +
			"这是程序安装不完整，重装 Solo 能修好。",
	);
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

async function main() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const dir = String(job.ttsRoot);
	const sherpa = loadSherpa();
	const engine = new sherpa.OfflineTts({
		model: {
			kokoro: {
				model: join(dir, "model.onnx"),
				voices: join(dir, "voices.bin"),
				tokens: join(dir, "tokens.txt"),
				lexicon: [join(dir, "lexicon-us-en.txt"), join(dir, "lexicon-zh.txt")].join(","),
			},
			numThreads: Number(job.numThreads) || 8,
			provider: "cpu",
		},
		maxNumSentences: 1,
		silenceScale: 0.2,
		ruleFsts: ["date-zh.fst", "number-zh.fst", "phone-zh.fst"].map((name) => join(dir, name)).join(","),
	});
	const pieces = [];
	let sampleRate = 22_050;
	let failed = "";
	try {
		const audio = await engine.generateAsync({
			text: String(job.text),
			sid: Number(job.sid) || 0,
			speed: Number(job.speed) || 1,
			onProgress: (info) => {
				if (info.samples && info.samples.length > 0) pieces.push(Float32Array.from(info.samples));
				return 1;
			},
		});
		if (Number(audio.sampleRate) > 0) sampleRate = Number(audio.sampleRate);
		if (pieces.length === 0 && audio.samples && audio.samples.length > 0) pieces.push(Float32Array.from(audio.samples));
	} catch (error) {
		failed = error instanceof Error ? error.message : String(error);
	}
	if (pieces.length === 0) {
		return { error: failed === "" ? "没有合成出声音" : failed };
	}
	if (failed !== "" && !/settlement/iu.test(failed)) {
		return { error: failed };
	}
	let total = 0;
	for (const piece of pieces) total += piece.length;
	const samples = new Float32Array(total);
	let offset = 0;
	for (const piece of pieces) {
		samples.set(piece, offset);
		offset += piece.length;
	}
	return { wav: encodeWav(samples, sampleRate) };
}

/** 把整份结果写完、等管道排空再退；直接 `process.exit` 会把没写完的字节截掉。 */
function emit(payload) {
	return new Promise((done) => {
		process.stdout.write(JSON.stringify(payload), () => {
			// 回调触发时数据已交给内核，再让事件循环空转一轮确保刷干净。
			setTimeout(done, 10);
		});
	});
}

main().then(
	(value) => emit(value ?? {}).then(() => process.exit(0)),
	(error) => emit({ error: error instanceof Error ? error.message : String(error) }).then(() => process.exit(0)),
);
