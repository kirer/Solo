/**
 * 千问实时语音合成（阿里云百炼，`qwen3-tts-flash-realtime`，华北 2）。
 *
 * 这套协议照 dsh-orb-cordis 的商用方案接：连上 WebSocket，`session.update` 定音色与
 * 语速，`input_text_buffer.append` 交一句字，`response.audio.delta` 一块块回 24 kHz
 * 16-bit 单声道 PCM，`session.finished` 收尾。这里不往喇叭边收边放（Solo 的接口是
 * 一问一答），所以把 PCM 收齐再封成 WAV 交给前端。
 *
 * Key 只在请求头里出现，不进日志、不进报错文案。
 */

export const QWEN_MODEL = "qwen3-tts-flash-realtime";
export const QWEN_URL = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${QWEN_MODEL}`;
export const QWEN_SAMPLE_RATE = 24_000;
export const QWEN_SPEED_MIN = 0.5;
export const QWEN_SPEED_MAX = 2;
export const DEFAULT_QWEN_VOICE = "Cherry";
export const DEFAULT_QWEN_SPEED = 1.4;

const STANDARD = [
	["Cherry", "芊悦", "女", "阳光亲切"],
	["Serena", "苏瑶", "女", "温柔"],
	["Ethan", "晨煦", "男", "阳光，略带北方口音"],
	["Chelsie", "千雪", "女", "二次元"],
	["Momo", "茉兔", "女", "撒娇搞怪"],
	["Vivian", "十三", "女", "拽、小暴躁"],
	["Moon", "月白", "男", "率性帅气"],
	["Maia", "四月", "女", "知性温柔"],
	["Kai", "凯", "男", "舒缓"],
	["Nofish", "不吃鱼", "男", "不翘舌的设计师"],
	["Bella", "萌宝", "女", "小萝莉"],
	["Jennifer", "詹妮弗", "女", "美语电影质感"],
	["Ryan", "甜茶", "男", "戏感强"],
	["Katerina", "卡捷琳娜", "女", "御姐"],
	["Aiden", "艾登", "男", "美语大男孩"],
	["Eldric Sage", "沧明子", "男", "沉稳老者"],
	["Mia", "乖小妹", "女", "乖巧"],
	["Mochi", "沙小弥", "男", "早慧小大人"],
	["Bellona", "燕铮莺", "女", "洪亮、字正腔圆"],
	["Vincent", "田叔", "男", "沙哑烟嗓"],
	["Bunny", "萌小姬", "女", "萌系小萝莉"],
	["Neil", "阿闻", "男", "新闻主持人"],
	["Elias", "墨讲师", "女", "讲课"],
	["Arthur", "徐大爷", "男", "质朴、慢"],
	["Nini", "邻家妹妹", "女", "软糯"],
	["Seren", "小婉", "女", "助眠、舒缓"],
	["Pip", "顽屁小孩", "男", "调皮童声"],
	["Stella", "少女阿月", "女", "甜、少女音"],
	["Bodega", "博德加", "男", "热情西班牙大叔"],
	["Sonrisa", "索尼莎", "女", "开朗拉美大姐"],
	["Alek", "阿列克", "男", "低沉、俄语口音"],
	["Dolce", "多尔切", "男", "慵懒意大利大叔"],
	["Sohee", "素熙", "女", "韩语欧尼"],
	["Ono Anna", "小野杏", "女", "鬼灵精怪"],
	["Lenn", "莱恩", "男", "理性德国青年"],
	["Emilien", "埃米尔安", "男", "浪漫法国大哥哥"],
	["Andre", "安德雷", "男", "磁性沉稳"],
	["Radio Gol", "拉迪奥·戈尔", "男", "足球解说"],
];

const DIALECT = [
	["Jada", "上海-阿珍", "女", "上海话"],
	["Dylan", "北京-晓东", "男", "北京话"],
	["Li", "南京-老李", "男", "南京话"],
	["Marcus", "陕西-秦川", "男", "陕西话"],
	["Roy", "闽南-阿杰", "男", "闽南语"],
	["Peter", "天津-李彼得", "男", "天津话"],
	["Sunny", "四川-晴儿", "女", "四川话"],
	["Eric", "四川-程川", "男", "四川话"],
	["Rocky", "粤语-阿强", "男", "粤语"],
	["Kiki", "粤语-阿清", "女", "粤语"],
];

/** @type {{voice: string, label: string, group: "standard" | "dialect"}[]} */
export const QWEN_VOICES = [...STANDARD.map(([voice, name, gender, note]) => ({
	voice,
	label: `${name} · ${gender} · ${note}`,
	group: "standard",
})), ...DIALECT.map(([voice, name, gender, note]) => ({
	voice,
	label: `${name} · ${gender} · ${note}`,
	group: "dialect",
}))];

const VOICE_SET = new Set(QWEN_VOICES.map((item) => item.voice));

/** 音色原文区分大小写，`Eldric Sage` / `Ono Anna` / `Radio Gol` 里的空格保留。 */
export function isQwenVoice(value) {
	return typeof value === "string" && VOICE_SET.has(value);
}

export function clampQwenSpeed(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return DEFAULT_QWEN_SPEED;
	return Math.round(Math.min(QWEN_SPEED_MAX, Math.max(QWEN_SPEED_MIN, number)) * 10) / 10;
}

function base64PcmToFloat(delta) {
	const bytes = Buffer.from(delta, "base64");
	const count = Math.floor(bytes.length / 2);
	const samples = new Float32Array(count);
	for (let index = 0; index < count; index += 1) samples[index] = bytes.readInt16LE(index * 2) / 32_768;
	return samples;
}

function wavBase64(samples, sampleRate) {
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

const CONNECT_TIMEOUT = 10_000;
const FIRST_AUDIO_TIMEOUT = 3_000;
const IDLE_TIMEOUT = 30_000;

/**
 * 合成一句，回 base64 WAV。失败抛错；超时（还没出过音频）换一条连接重试，最多两次。
 */
export function synthesizeQwen({ text, apiKey, voice, speed, retries = 2 }) {
	const key = String(apiKey ?? "").trim();
	if (key === "") return Promise.reject(new Error("千问需要先填 API Key"));
	const body = String(text ?? "").trim();
	if (body === "") return Promise.reject(new Error("没有要念的字"));
	if (body.length > 1_000) return Promise.reject(new Error("这句太长了（上限 1000 字）"));

	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			if (error === null) resolve(value);
			else reject(error);
		};
		const attempt = (left) => {
			runOnce(body, key, voice, clampQwenSpeed(speed), (error, value, noAudio) => {
				if (error === null) return finish(null, value);
				if (noAudio === true && left > 0) {
					setTimeout(() => attempt(left - 1), 300);
					return;
				}
				finish(error);
			});
		};
		attempt(Math.max(0, Math.floor(retries)));
	});
}

function runOnce(text, apiKey, voice, speed, done) {
	let socket;
	try {
		socket = new WebSocket(QWEN_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
	} catch (error) {
		done(error, undefined, false);
		return;
	}
	let settled = false;
	let sent = false;
	let gotAudio = false;
	let timer;
	const chunks = [];
	const clear = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const end = (error, value, noAudio) => {
		if (settled) return;
		settled = true;
		clear();
		try {
			socket.close();
		} catch {
			// 对端可能已经走了。
		}
		done(error, value, noAudio);
	};
	const arm = (ms) => {
		clear();
		timer = setTimeout(() => end(new Error("千问语音合成超时"), undefined, !gotAudio), ms);
		timer.unref?.();
	};
	const send = (payload) => {
		socket.send(JSON.stringify({ event_id: `event_${Math.random().toString(16).slice(2)}`, ...payload }));
	};

	socket.addEventListener("open", () => {
		if (settled) return;
		try {
			send({
				type: "session.update",
				session: {
					mode: "server_commit",
					voice,
					language_type: "Chinese",
					response_format: "pcm",
					sample_rate: QWEN_SAMPLE_RATE,
					speech_rate: speed,
				},
			});
		} catch (error) {
			end(error, undefined, false);
		}
	});

	socket.addEventListener("message", (event) => {
		if (settled) return;
		arm(gotAudio ? IDLE_TIMEOUT : FIRST_AUDIO_TIMEOUT);
		let message;
		try {
			message = JSON.parse(typeof event.data === "string" ? event.data : "");
		} catch {
			return;
		}
		if (typeof message !== "object" || message === null) return;
		if (message.type === "error") {
			const detail = typeof message.error?.message === "string" ? message.error.message : "";
			end(new Error(detail === "" ? "千问语音合成失败" : detail), undefined, false);
			return;
		}
		if (message.type === "session.updated") {
			if (sent) return;
			sent = true;
			try {
				send({ type: "input_text_buffer.append", text });
				send({ type: "session.finish" });
			} catch (error) {
				end(error, undefined, false);
				return;
			}
			arm(FIRST_AUDIO_TIMEOUT);
			return;
		}
		if (message.type === "response.audio.delta") {
			if (typeof message.delta !== "string" || message.delta === "") return;
			const samples = base64PcmToFloat(message.delta);
			if (samples.length === 0) return;
			gotAudio = true;
			chunks.push(samples);
			arm(IDLE_TIMEOUT);
			return;
		}
		if (message.type === "session.finished") {
			if (chunks.length === 0) {
				end(new Error("千问没有返回声音"), undefined, true);
				return;
			}
			let total = 0;
			for (const chunk of chunks) total += chunk.length;
			const merged = new Float32Array(total);
			let at = 0;
			for (const chunk of chunks) {
				merged.set(chunk, at);
				at += chunk.length;
			}
			end(null, wavBase64(merged, QWEN_SAMPLE_RATE), false);
		}
	});

	// 连不上（多半是 Key 不对或网络不通）不重试：重试只给「连上了但迟迟不出声」。
	socket.addEventListener("error", () => end(new Error("千问语音连不上（检查 API Key 与网络）"), undefined, false));
	socket.addEventListener("close", () => end(new Error("千问语音连不上（检查 API Key 与网络）"), undefined, false));
	arm(CONNECT_TIMEOUT);
}
