/**
 * 悬浮球：任何一屏都能直接跟助理说一句。
 *
 * 交互借 [dsh-orb-cordis](https://github.com/mini-yifan/dsh-orb-cordis) 的那颗球：
 * 贴右边、悬停展开、点击钉住、拖走、拖出右缘收成一条、右键菜单。但**不搬它的形态**——
 * Solo 里没有第二个 Electron 进程、没有 Computer Use，球只是一个浮着的「助理私聊」入口：
 * 说的是同一批消息，走的是同一条 `/api/channels/:id`，历史与已读都跟着那条私聊。
 *
 * 数据只有两处：频道列表 / 当前频道详情来自 `store`（SSE 在推）；不在当前频道时，
 * 面板打开期间按需 `api.getChannel` 拉一次，之后每 4 秒补一次。没有本地账本。
 *
 * 语音是主用法：点麦克风说一句（录完发给本机转写器，见 plugin.js），助理的回复
 * 自动读出来。听写与朗读都在本机：系统端侧模型 + 系统语音，不走云端。
 */

const SLUG = "悬浮球";
const PREF_KEY = "solo.orb";
/** 球的直径（px）。拖动与贴边的计算都用它。 */
const BALL = 80;
/** 小人实际占的高度（画布 80×96，人本身到脚下阴影为止）。摆面板要按这个算，不能按 80。 */
const BALL_H = 96;
/** 拖过右缘多近算「贴边」。 */
const DOCK_AT = 12;
/**
 * 气泡（小人头顶那一句）。老板 2026-11-11：面板全砍，话只从头顶冒。
 *
 * 三个数是调出来的，不是拍的：
 * - `BUBBLE_GAP` 10：再小尾巴就压到头发上；
 * - `BUBBLE_CHROME` 34：上下内边距 + 一行「名字」+ 尾巴留白，量高度时先扣掉这么多；
 * - `BUBBLE_HOLD` 6000：念完还留 6 秒够看完，20 个字的长句也来得及。
 */
const BUBBLE_GAP = 10;
const BUBBLE_CHROME = 34;
const BUBBLE_MIN_W = 232;
const BUBBLE_MAX_W = 320;
const BUBBLE_HOLD = 6000;
const BUBBLE_FADE = 420;
/**
 * 球长在哪（`ui/app/src/main.tsx` 写在 `<html data-orb>` 上）：
 * - `inline`：浏览器，球浮在页面里（原来的样子）；
 * - `window`：桌面壳的独立透明窗，坐标固定，拖球 = 挪整扇窗；
 * - `none`：桌面主窗口，不画球（球只在一处，ADR-116）。
 */
const ORB_MODE = typeof document === "undefined" ? "inline" : (document.documentElement.dataset.orb ?? "inline");
const WINDOW_MODE = ORB_MODE === "window";

/**
 * 回声消除（AEC3）。
 *
 * ## 为什么要有
 *
 * 它念的时候，喇叭的声音从麦克风原路回来。实测：把它的朗读衰减 20dB 再喂 VAD，
 * 仍有 88% 的帧被判成「有人在说话」—— 于是它自己把自己打断，老板开口反倒听不见。
 * 靠 `getUserMedia({echoCancellation:true})` 顶不住（实测只压约 2dB）。
 *
 * ## 怎么用
 *
 * 播放的那一轨已经被接进 `AudioContext`（`startMouth` 里的 `createMediaElementSource`），
 * 参考信号就从那儿分一路出来 —— 我们手里有 TTS 的原样 WAV，参考比通用方案准。
 * 麦克风改成 48k 收，过 AEC 直接吐 16k（`sampleRateOut`），下面那条 16k 链路一个字不用改。
 *
 * ## 三条硬规矩
 *
 * 1. **麦克风断了必须看得见**：track `ended` / `muted`、`ctx` 挂起，都要报 `paused`，
 *    界面说清楚。安静地装作在听，比不听更糟。
 * 2. **AEC 挂了降级到「播放期间直接丢输入」**，不能因为 AEC 挂了整个听不见。
 * 3. **不加路由就拿不到 wasm**：所以 wasm 走 `/api/plugins/<slug>/assets/<file>`，
 *    文件名里带版本号，缓存可以放心长。
 */
const AEC_WASM_FILE = "webrtcaec3-0.3.0.wasm";
/** AEC3 只吃 32k / 48k；48k 是浏览器和多数设备的原生档。 */
const AEC_RATE = 48000;
/**
 * 串音延迟：播放出去到它从麦克风回来，大约多久。
 *
 * 实测 40ms 和 80ms 都收敛得住，但 macOS 上不同输出设备差很多（内置扬声器 / 蓝牙 / 外接）。
 * 所以**不硬编码死**，留一个能调的口子；真机上压不干净先动这个值，别急着换算法。
 */
const AEC_DELAY_MS = 40;

/**
 * 一份 AEC3 模块（wasm 编译一次，多个会话共用）。
 *
 * 失败记 `null` 之后不再重试：这台机器上就是没有（取不到 wasm / 不支持 WebAssembly），
 * 每次开会话重试一遍只会让「听不见」这件事变得更难解释。
 */
let aecModulePromise = null;

/** `<script>` 只能插一次，插两遍会执行两遍、抢着定义同一个全局。 */
const scriptLoads = new Map();

function loadAecModule() {
	if (aecModulePromise !== null) return aecModulePromise;
	aecModulePromise = (async () => {
		const base = `/api/plugins/${encodeURIComponent(SLUG)}/assets`;
		// **不能 `import()`**：这份 Emscripten 产物第 104 行是 `WebRtcAec3Wasm="data:..."`，
		// 给一个没声明过的全局赋值 —— 在 ES module 的严格模式下直接 ReferenceError。
		// 它本来就是给 `<script>` 用的（UMD，靠 `var WebRtcAec3` 挂到全局），所以照它的方式加载。
		//
		// wasm 也不必传：胶水自己内联了一份（`locateFile` 都没机会被问到）。所以
		// `AEC_WASM_FILE` 那条路由是留给「哪天换了不内联的版本」的口子，现在不发文件也跑得动。
		await loadScript(`${base}/webrtcaec3.js`);
		const factory = globalThis.WebRtcAec3;
		if (typeof factory !== "function") throw new Error("回声消除模块没挂到全局");
		return await factory({});
	})().catch(() => null);
	return aecModulePromise;
}

/** 插一个 `<script>` 并等它加载完。同一个 URL 只插一次。 */
function loadScript(url) {
	const loaded = scriptLoads.get(url);
	if (loaded !== undefined) return loaded;
	const promise = new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = url;
		script.async = true;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error(`加载失败：${url}`));
		document.head.append(script);
	});
	scriptLoads.set(url, promise);
	return promise;
}

/**
 * 一次播放会话的 AEC。
 *
 * 生灭跟着「有没有在念」走：`playNext` 放第一片时开，队列空、`speakingRef` 落回 false 时关。
 * 不关会漏 wasm 堆内存（类型定义里明写 free 是必须的）。
 *
 * @param {object} options
 * @param {AudioContext} options.ctx 播放所在的 AudioContext（48k），参考信号从它的图里分出来
 * @param {MediaStreamAudioSourceNode} options.reference 参考信号源
 */
function createEchoCanceller(options) {
	const { ctx, reference } = options;
	let aec = null;
	let tap = null;
	/** 参考信号环形缓冲：它得比麦克风**早**喂，因为串音有延迟。 */
	const refQueue = [];
	let refFrames = 0;
	let refRead = 0;
	/** 参考侧要压着多少帧才开始吐（按 AEC_DELAY_MS 折算）。 */
	const delayFrames = Math.round((AEC_DELAY_MS / 1000) * AEC_RATE);

	const failed = (reason) => {
		release();
		return { ok: false, reason };
	};

	if (typeof ctx === "undefined" || ctx === null) return { ok: false, reason: "没有播放上下文" };
	if (typeof globalThis.WebAssembly === "undefined") return { ok: false, reason: "不支持 WebAssembly" };

	let disposed = false;
	let ready = null;

	const ensure = () => {
		if (ready !== null) return ready;
		ready = (async () => {
			const module = await loadAecModule();
			if (module === null) throw new Error("取不到回声消除模块");
			if (disposed) throw new Error("会话已经结束");
			const instance = new module.AEC3(AEC_RATE, 1, 1);
			instance.setAudioBufferDelay(AEC_DELAY_MS);
			aec = instance;
			// 参考信号单独分出来，不接 destination：接了就又多一份回声。
			tap = ctx.createScriptProcessor(4096, 1, 1);
			const silence = ctx.createGain();
			silence.gain.value = 0;
			reference.connect(tap);
			tap.connect(silence);
			silence.connect(ctx.destination);
			tap.onaudioprocess = (event) => {
				if (aec === null) return;
				refQueue.push(new Float32Array(event.inputBuffer.getChannelData(0)));
				refFrames += event.inputBuffer.length;
			};
			return instance;
		})();
		return ready;
	};

	/**
	 * 处理一块麦克风数据，回清掉回声的 16k 样本。
	 *
	 * 参考信号不够（刚开始念、或者干脆没接上）时**原样返回**——宁可这次没消掉，
	 * 也别把麦克风吞掉：吞了就变成「它念的时候人说话听不见」，比回声更糟。
	 */
	const process = (input48k) => {
		if (aec === null) {
			// 还没初始化好：照原样降下去，别丢字。
			return downsample(input48k, AEC_RATE, TARGET_RATE);
		}
		try {
			let consumed = refRead;
			while (refFrames - consumed >= delayFrames && refQueue.length > 0) {
				const block = refQueue[0];
				const need = delayFrames - consumed;
				const take = Math.min(block.length, Math.max(need, 0)) || block.length;
				const slice = block.subarray(0, take);
				aec.analyze([slice]);
				if (take >= block.length) {
					refQueue.shift();
				} else {
					refQueue[0] = block.subarray(take);
				}
				consumed += slice.length;
			}
			refRead = Math.min(consumed, refFrames);
			const opts = { sampleRateOut: TARGET_RATE };
			const size = aec.processSize([input48k], opts);
			if (size <= 0) return new Float32Array(0);
			const out = [new Float32Array(size)];
			aec.process(out, [input48k], opts);
			return out[0];
		} catch {
			// 出一次错就彻底关掉，别每一块都抛一遍。
			release();
			return downsample(input48k, AEC_RATE, TARGET_RATE);
		}
	};

	/** 关掉实例。可以重复调用。 */
	function release() {
		disposed = true;
		refQueue.length = 0;
		refFrames = 0;
		refRead = 0;
		if (tap !== null) {
			tap.onaudioprocess = null;
			try {
				tap.disconnect();
			} catch {
				/* 已经断了 */
			}
			tap = null;
		}
		const instance = aec;
		aec = null;
		if (instance !== null) {
			try {
				instance.free();
			} catch {
				/* 已经释放了 */
			}
		}
	}

	return { ok: true, ensure, process, release, failed };
}

/** 简单线性重采样（只在 AEC 没起来时兜底用；AEC 自己会吐 16k）。 */
function downsample(samples, from, to) {
	if (!Number.isFinite(from) || from <= 0 || Math.abs(from - to) < 1) return samples;
	const ratio = from / to;
	const length = Math.floor(samples.length / ratio);
	const out = new Float32Array(length);
	for (let index = 0; index < length; index += 1) {
		const pos = index * ratio;
		const low = Math.floor(pos);
		const high = Math.min(low + 1, samples.length - 1);
		const frac = pos - low;
		out[index] = samples[low] * (1 - frac) + samples[high] * frac;
	}
	return out;
}

/**
 * 默认音色。v1.0 的 `zf_xiaoxiao` 在 v1.1-zh 这套模型里没有，默认落在 `zf_001`。
 *
 * **存名字，不存 sid。** sid 是 `voices.bin` 里的下标，换一次模型就整体错位：
 * 老版本存的 47 是晓晓，在 v1.1 里同一个 47 是 `zf_083`——另一个人，而且不报错、
 * 不静音、不回落，用户只会觉得「声音怎么变了」。名字至少能判出「这一版认不认识」。
 */
const DEFAULT_VOICE = "zf_001";
/** 名字长什么样。真正的白名单在后端（`/api/orb/voice` 会给全表）。 */
const VOICE_NAME_RE = /^(?:zf|zm)_\d{3}$/;

/** 位置、贴边、朗读开关与音色记在本机：换个屏幕再打开，还是你上次的那一套。 */
function readPrefs() {
	// 朗读**默认开**（老板 2026-11-11）：气泡都冒出来了、却没声音，这不合理。
	// 以前默认关，结果升级完的人一句都听不到，还以为坏了。关掉会记住（`speak: false`）。
	const fallback = {
		right: 18,
		top: null,
		docked: false,
		speak: true,
		wake: false,
		listen: false,
		voice: DEFAULT_VOICE,
		// 新用户（连 json 都没有）没有「要重选音色」这回事，直接算迁完，不弹横幅。
		voiceMigrated: true,
		speed: 1,
	};
	try {
		const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PREF_KEY);
		if (raw === null) return fallback;
		const value = JSON.parse(raw);
		// 老库里的 `speak:false` 不是他点的，是**旧版默认值**写下去的（2.9.3 前后才把默认改开）。
		// 光看 `false` 分不出来，所以往后每次存都盖一个 `touched` 标记：老板真点过开关，
		// 那一次是经 `toggleSpeak` → `savePrefs` 写进去的，一定会带 `touched:true`。
		// 迁移只认「没有这个标记的老数据 + 存的正好是旧默认值 false」这一种：
		// 有标记的 false 是他自己的选择，不动；迁移完往后都带标记，不会迁第二次。
		const legacy = value?.touched !== true && value?.speak === false;
		// 音色迁移，只做一次。v1.0 的库里只有数字 sid（45–52），那 8 个名字在 v1.1 里
		// 一个都不存在，原样透传会把人静默送到另一个人身上。所以**没有标记的老库一律
		// 回默认**，由设置页那句横幅请他重选；重选后写名字 + 标记，之后照名字走。
		const migrated = value?.voiceMigrated === true;
		const voice =
			migrated && typeof value?.voice === "string" && VOICE_NAME_RE.test(value.voice) ? value.voice : DEFAULT_VOICE;
		return {
			right: Number.isFinite(value?.right) ? value.right : 18,
			top: Number.isFinite(value?.top) ? value.top : null,
			docked: value?.docked === true,
			// 没存过就是开；只有明确关过（`false`）才算关。老库里那种「没标记的 false」按
			// 旧默认值算，迁成开（见上）；带标记的 `false` 才是他自己关的。
			speak: legacy ? true : value?.speak !== false,
			wake: value?.wake === true,
			// 常驻听默认关：麦克风一直开着是件要用户点头的事，第一次得他自己打开（开了会记住）。
			listen: value?.listen === true,
			voice,
			voiceMigrated: migrated,
			speed: Number.isFinite(value?.speed) ? clamp(value.speed, 0.7, 1.5) : 1,
		};
	} catch {
		return fallback;
	}
}

function savePrefs(next) {
	try {
		// `touched: true` 是「人动过这套设置」的标记，只给迁移用（见 `readPrefs` 里那段）：
		// 有标记的 `speak:false` 是他自己关的，没标记的才可能是旧默认值。
		if (typeof localStorage !== "undefined") localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), ...next, touched: true }));
	} catch {
		// 存不了就只在这次里生效，不影响用。
	}
}

function clamp(value, low, high) {
	return Math.min(high, Math.max(low, value));
}

/** 一小段 16 kHz 浮点 PCM 交给本机唤醒器；`reset` 只清解码状态。 */
async function postKws(samples, reset) {
	let body = { reset: true };
	if (!reset) {
		const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
		let binary = "";
		for (let index = 0; index < bytes.length; index += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
		}
		body = { samples: btoa(binary) };
	}
	const response = await fetch("/api/orb/kws", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return response.json();
}

/** 一条消息的时间：一分钟内「刚刚」，一小时内「N 分钟前」，再久给时分。 */
function ago(at) {
	const gap = Date.now() - at;
	if (gap < 60_000) return "刚刚";
	if (gap < 3_600_000) return `${String(Math.floor(gap / 60_000))} 分钟前`;
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export default {
	id: SLUG,

	style: `
		/* 整块浮在最上层：只有球和面板接事件，别的地方不挡点击。 */
		.orb { position: fixed; z-index: 70; pointer-events: none; }
		/* .orb 自己是 pointer-events:none，伪元素的 ::before 撑不出命中目标 ——
		   把容器改成 auto、再把球/气泡/菜单的 auto 收掉不现实（它们本来就要能点）。
		   所以热区由**一个真元素** .orb-hit 撑，见下方样式与渲染。 */
		/* 球面是一个站着的小人（纸片），不再是一颗抽象球或一块标识方块。
		   选「纸上低对比 + 一颗蓝点」是因为它要在壁纸上待一整天：安静时几乎不动，
		   不跟屏幕上别的东西抢注意力；一开口，姿态和嘴自己说话。 */
		.orb-ball {
			--orb-paper: #f7f4ee;
			--orb-ink: #23262b;
			--orb-line: #c9c2b4;
			--orb-dot: #7d9cc4;
			pointer-events: auto;
			position: relative;
			display: grid; place-items: center;
			width: 80px; height: 96px; padding: 0;
			border: 0; border-radius: 16px;
			background: transparent;
			/* 阴影落在脚下，不围一圈：围一圈就成了「球」，不是「站在屏幕上的人」。 */
			box-shadow: none;
			filter: drop-shadow(0 10px 14px rgb(0 0 0 / 0.26));
			cursor: grab; touch-action: none;
			transition: transform 160ms ease, filter 160ms ease;
		}
		.orb-ball:hover { transform: scale(1.05); filter: drop-shadow(0 14px 18px rgb(0 0 0 / 0.3)); }
		/* 嘴上/眼睛上的颜色不从主题继承：投影和面板底色会把深色换成浅色，人就糊了。 */
		.orb-mark .orb-mouth, .orb-mark .orb-pupils circle { stroke: var(--orb-ink); }
		.orb-mark .orb-mouth[data-mouth="open4"] { stroke-width: 2.4; }
		.orb-ball:active { cursor: grabbing; }
		/* 贴边：只留一条边。悬停滑出来，松手不动它就还回去 —— 和 dsh 那颗球一个意思。 */
		.orb[data-docked="true"] .orb-ball { transform: translateX(68px); }
		.orb[data-docked="true"] .orb-ball:hover { transform: none; }
		/* 贴边只露 12px 缝，人手扫不进去。滑出靠 [data-peek]：window 上 mousemove 判
		 * 鼠标贴到右缘时点亮。热区只占窗内 12px，不往左多伸一个像素。 */
		.orb-hit {
			position: absolute;
			top: 0; bottom: 0; left: 0; width: 12px;
			pointer-events: auto;
			background: transparent;
		}
		.orb[data-docked="true"][data-peek="true"] .orb-ball { transform: none; }
		/* 小人填满球面；SVG 自己带身体，按钮只负责阴影与命中。 */
		.orb-mark { display: block; width: 80px; height: 96px; overflow: visible; }
		.orb-mark svg { display: block; width: 100%; height: 100%; overflow: visible; }
		/* 呼吸、眨眼：安静时也有一点点活着的感觉，但幅度压到 1px 级，不烦人。 */
		.orb-mark .orb-breath { animation: orb-breath 8s ease-in-out infinite; }
		@keyframes orb-breath { 0%, 100% { transform: none; } 45% { transform: translateY(-1px); } }
		.orb-mark .orb-eye {
			transform-origin: center; transform-box: fill-box;
			animation: orb-blink 20s ease-in-out infinite;
		}
		@keyframes orb-blink { 0%, 92%, 100% { transform: scaleY(1); } 93.6% { transform: scaleY(0.08); } 95.2% { transform: scaleY(1); } }
		/* 在听：头偏一点、眼睛微睁、耳朵边两圈往里收的弧。 */
		.orb-mark[data-view="listen"] { transform: rotate(-3deg); }
		.orb-mark[data-view="listen"] .orb-eyes { transform: scale(1.12); transform-origin: 50% 40%; }
		.orb-mark .orb-arc { opacity: 0; animation: orb-arc 1.4s ease-out infinite; }
		.orb-mark .orb-arc + .orb-arc { animation-delay: 0.7s; }
		@keyframes orb-arc { 0% { opacity: 0.1; } 30% { opacity: 0.7; } 100% { opacity: 0; } }
		/* 在想：目光上抬左右扫，一只手在敲，头顶蓝点明暗。 */
		.orb-mark[data-view="think"] .orb-pupils { animation: orb-scan 2.4s ease-in-out infinite; }
		@keyframes orb-scan { 0% { transform: translate(-1.2px, -2.4px); } 50% { transform: translate(1.2px, -2.4px); } 100% { transform: translate(-1.2px, -2.4px); } }
		.orb-mark[data-view="think"] .orb-hand { animation: orb-tap 1s ease-in-out infinite; transform-origin: 50% 0; }
		@keyframes orb-tap { 0%, 100% { transform: none; } 25% { transform: rotate(-8deg) translateY(-1px); } 50% { transform: none; } 75% { transform: rotate(-8deg) translateY(-1px); } }
		.orb-mark[data-view="think"] .orb-dot { animation: orb-glim 1.1s ease-in-out infinite; }
		@keyframes orb-glim { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
		/* 在念：轻微点头；嘴的档位由 JS 每帧写（真机跟 AnalyserNode 的音量）。 */
		.orb-mark[data-view="speak"] { animation: orb-nod 0.5s ease-in-out infinite; }
		@keyframes orb-nod { 0%, 100% { transform: none; } 50% { transform: translateY(-1px) rotate(0.6deg); } }
		/* 正在跑：一圈转着的弧，圆角跟着球面走，不是圆环。只在这一轮里存在，结算即消失。 */
		.orb-ring {
			position: absolute; inset: -5px; border-radius: 18px; padding: 2px;
			background: conic-gradient(from 0deg, transparent 0 190deg, var(--accent) 330deg, transparent 360deg);
			-webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
			-webkit-mask-composite: xor;
			mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
			mask-composite: exclude;
			animation: orb-spin 1.5s linear infinite;
			pointer-events: none;
		}
		@keyframes orb-spin { to { transform: rotate(360deg); } }
		/* 「没念出来」的红点：跟未读角标抢同一个角会叠住，所以让到左下。 */
		.orb-badge.orb-alert {
			top: auto; right: auto; bottom: 2px; left: -4px;
			background: var(--danger, #c0503c); color: #fff;
			font-weight: 700; padding: 0;
			box-shadow: 0 2px 6px rgb(0 0 0 / 0.28);
		}
		.orb-badge {
			position: absolute; top: -3px; right: -3px;
			min-width: 17px; height: 17px; padding: 0 4px;
			border-radius: 999px; box-sizing: border-box;
			background: var(--accent-solid); color: var(--on-accent);
			font-size: 10px; line-height: 17px; font-weight: 600;
			font-variant-numeric: tabular-nums; text-align: center;
		}

		/* ── 气泡：小人头顶唯一的一张嘴 ─────────────────────────────
		   老板 2026-11-11 拍板：面板全砍，话只从头顶冒。所以这里没有列表、没有输入框，
		   一次只挂一句 —— 上一条被新的顶掉，头顶不是消息列表。
		   定位（left/top/width）由 JS 算好写进 style，
		   尾巴的水平位置走 --bubble-tail-x，始终对着小人中心。 */
		.orb-bubble {
			pointer-events: none;
			position: absolute;
			box-sizing: border-box;
			display: flex; flex-direction: column;
			padding: 7px 11px 8px;
			background: var(--ground);
			border: 0.5px solid var(--line);
			border-radius: 13px;
			box-shadow: var(--shadow, 0 14px 34px rgb(0 0 0 / 0.2));
			/* 出现在哪一侧由 JS 说：尾巴在气泡顶边（气泡在头上）还是底边（气泡在脚下）。 */
			animation: orb-bubble-in 150ms ease;
			will-change: opacity;
		}
		@keyframes orb-bubble-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
		/* 淡出：只掉透明度，位置不动，读到一半的文字别跳。 */
		.orb-bubble[data-fading="true"] { opacity: 0; transition: opacity 420ms ease; }
		/* 尾巴：一个转了 45° 的小方块，正好让边框那条线接上气泡。 */
		.orb-bubble::after {
			content: "";
			position: absolute;
			left: var(--bubble-tail-x, 50%);
			width: 9px; height: 9px;
			background: var(--ground);
			border: 0.5px solid var(--line);
			transform: translateX(-50%) rotate(45deg);
			border-radius: 1.5px;
		}
		/* 气泡在小人上边：尾巴挂气泡底边，只留左和下两条边（盖住气泡那一边的框线）。 */
		.orb-bubble[data-side="above"]::after { bottom: -5px; border-left: 0; border-top: 0; }
		/* 气泡在小人下边：尾巴挂气泡顶边。 */
		.orb-bubble[data-side="below"]::after { top: -5px; border-right: 0; border-bottom: 0; }
		.orb-bubble-who {
			flex: none;
			font-size: 10px; line-height: 13px; font-weight: 600;
			color: var(--ink-3); letter-spacing: .02em;
			margin-bottom: 1px;
		}
		.orb-bubble-who[data-me="true"] { color: var(--accent); }
		/* 正文：**压矮时自己滚，绝不截字**（老板：要能看全）。 */
		.orb-bubble .text {
			flex: 0 1 auto; min-height: 0;
			overflow: auto; overscroll-behavior: contain;
			margin: 0;
			color: var(--ink); font-size: 12.5px; line-height: 18.5px;
			white-space: pre-wrap; word-break: break-word;
		}
		.orb-bubble .text::-webkit-scrollbar { width: 4px; }
		.orb-bubble .text::-webkit-scrollbar-thumb { background: var(--control); border-radius: 2px; }
		/* 等它开口的那一小段：三个点，够看，不喊。 */
		.orb-bubble-wait { display: flex; align-items: center; gap: 3px; height: 18.5px; }
		.orb-bubble-wait i {
			width: 4px; height: 4px; border-radius: 50%;
			background: var(--ink-3);
			animation: orb-wait 1.15s ease-in-out infinite;
		}
		.orb-bubble-wait i:nth-child(2) { animation-delay: .16s; }
		.orb-bubble-wait i:nth-child(3) { animation-delay: .32s; }
		@keyframes orb-wait { 0%, 100% { opacity: .28; transform: none; } 40% { opacity: 1; transform: translateY(-1.5px); } }
		/* 「没念出来」挂在小人身上，气泡里只说「没听清 / 没发出去」这类自己的错。 */
		.orb-bubble[data-kind="error"] { border-color: var(--danger, #c0503c); }
		.orb-bubble[data-kind="error"] .text { color: var(--danger, #c0503c); }

		/* 在听：小人身边一圈随音量起伏的光，代替「按住麦克风」那一步的可视反馈。 */
		.orb-listen {
			position: absolute; inset: -6px;
			border-radius: 18px;
			pointer-events: none;
			box-shadow: 0 0 0 2px var(--accent-dim);
			transition: box-shadow 140ms linear, opacity 200ms ease;
		}

		.orb-menu {
			pointer-events: auto;
			position: absolute;
			min-width: 148px; padding: 5px;
			background: var(--ground); border: 0.5px solid var(--line);
			border-radius: 12px; box-shadow: var(--shadow, 0 18px 48px rgb(0 0 0 / 0.22));
		}
		.orb-menu button {
			display: block; width: 100%; padding: 7px 9px;
			border: 0; border-radius: 8px; background: transparent;
			color: var(--ink); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer;
		}
		.orb-menu button:hover { background: var(--hover); }
		.orb-menu button:disabled { color: var(--ink-3); cursor: default; }
		.orb-menu button:disabled:hover { background: transparent; }
		/* 菜单项前的状态点：亮 = 开着，灰 = 关着。语音两项点完原来屏幕上零变化，
		 * 老板的结论就是「点了没反应」。绝对定位占位、不参与排版，文字才对齐。 */
		.orb-menu button[data-on] { position: relative; padding-left: 19px; }
		.orb-menu button[data-on]::before {
			content: ""; position: absolute; left: 6px; top: 50%;
			width: 5px; height: 5px; margin-top: -2.5px; border-radius: 50%;
			background: var(--line, #c9c2b4); opacity: 0.55;
		}
		.orb-menu button[data-on="true"]::before { background: var(--accent, #4b7bec); opacity: 1; }

		/* 设置里的「悬浮球语音」一页：和 Token 用量同一套骨架（抬头 → 内容），
		   一个容器查询管宽窄（设置那张 800 弹窗里宽、右栏 / 手机上窄）。 */
		.ov {
			display: flex; flex-direction: column;
			height: 100%; min-width: 0; min-height: 0;
			background: var(--frame);
			container-type: inline-size;
		}
		.ov-head {
			display: flex; flex: none; align-items: center; gap: 8px;
			min-height: 62px; padding: 0 14px 0 18px;
			border-bottom: 0.5px solid var(--rule);
		}
		.ov-back {
			display: grid; place-items: center; flex: none;
			width: 28px; height: 28px; padding: 0;
			border: 0; border-radius: 8px; background: transparent;
			color: var(--ink-3); cursor: pointer;
		}
		.ov-back:hover { background: var(--hover); color: var(--ink); }
		.ov-head h2 { margin: 0; font-size: 15px; line-height: 21px; font-weight: 600; }
		.ov-head p { margin: 1px 0 0; font-size: 11px; line-height: 15px; color: var(--ink-3); }
		.ov-head[data-host="panel"] h2 { display: none; }
		.ov-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 18px clamp(16px, 3vw, 32px) 26px; }
		.ov-inner { display: flex; flex-direction: column; gap: 22px; width: 100%; max-width: 640px; margin: 0 auto; }
		.ov-sec > h3 { margin: 0 0 8px; font-size: 12.5px; line-height: 17px; font-weight: 600; color: var(--ink); }
		.ov-sec > p { margin: 6px 0 0; color: var(--ink-3); font-size: 11.5px; line-height: 17px; }
		.ov-row {
			display: flex; align-items: center; gap: 12px;
			min-height: 46px; padding: 8px 12px;
			border: 0.5px solid var(--rule); border-radius: 10px;
			background: var(--field);
		}
		.ov-row + .ov-row { margin-top: 8px; }
		.ov-row-main { flex: 1 1 auto; min-width: 0; }
		.ov-row-main b { display: block; font-size: 13px; line-height: 18px; font-weight: 500; color: var(--ink); }
		.ov-row-main span { display: block; font-size: 11.5px; line-height: 16px; color: var(--ink-3); }
		.ov-voices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
		.ov-voice-select { width: 100%; height: 34px; padding: 0 8px; border: 1px solid #d4d4d8; border-radius: 8px; background: #fff; color: #18181b; font-size: 13px; }
		.ov-banner { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-bottom: 10px; padding: 10px 12px; border: 1px solid #fcd34d; border-radius: 10px; background: #fffbeb; color: #78350f; font-size: 12.6px; line-height: 1.5; }
		.ov-banner b { font-size: 13px; }
		.ov-voice {
			padding: 9px 12px; text-align: left;
			border: 0.5px solid var(--rule); border-radius: 10px;
			background: var(--field); color: var(--ink); font: inherit; cursor: pointer;
		}
		.ov-voice:hover { border-color: var(--control); }
		.ov-voice[data-on="true"] { border-color: var(--accent); background: var(--accent-dim); }
		.ov-voice b { display: block; font-size: 13px; line-height: 18px; font-weight: 500; }
		.ov-voice span { display: block; font-size: 11px; line-height: 15px; color: var(--ink-3); }
		.ov-speed { display: flex; flex: 1 1 auto; align-items: center; gap: 10px; min-width: 0; }
		.ov-speed input { flex: 1 1 auto; min-width: 0; accent-color: var(--accent); }
		.ov-speed b { min-width: 44px; text-align: right; font-size: 12.5px; font-variant-numeric: tabular-nums; }
		.ov-btn {
			flex: none; height: 30px; padding: 0 12px;
			border: 0; border-radius: 8px;
			background: var(--accent-solid); color: var(--on-accent);
			font: inherit; font-size: 12.5px; cursor: pointer;
		}
		.ov-btn:disabled { opacity: 0.45; cursor: default; }
		.ov-engines { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
		.ov-engine {
			padding: 10px 12px; text-align: left;
			border: 0.5px solid var(--rule); border-radius: 10px;
			background: var(--field); color: var(--ink); font: inherit; cursor: pointer;
		}
		.ov-engine:hover { border-color: var(--control); }
		.ov-engine[data-on="true"] { border-color: var(--accent); background: var(--accent-dim); }
		.ov-engine b { display: block; font-size: 13px; line-height: 18px; font-weight: 500; }
		.ov-engine span { display: block; font-size: 11px; line-height: 15px; color: var(--ink-3); }
		.ov-key {
			flex: 0 1 220px; min-width: 120px; height: 30px; padding: 0 9px;
			box-sizing: border-box;
			border: 0.5px solid var(--control); border-radius: 8px;
			background: var(--ground); color: var(--ink); font: inherit; font-size: 12px;
		}
		.ov-key:focus { outline: none; border-color: var(--accent); }
		.ov-select {
			flex: 0 1 260px; min-width: 140px; height: 30px; padding: 0 8px;
			border: 0.5px solid var(--control); border-radius: 8px;
			background: var(--ground); color: var(--ink); font: inherit; font-size: 12px;
		}
		.ov-note { margin: 0; color: var(--ink-3); font-size: 11.5px; line-height: 18px; }
		@container (max-width: 460px) { .ov-voices { grid-template-columns: 1fr; } }
	`,

	apply(ui) {
		/** 嘴的六个形状。前端挑档和 SVG 初值共用这一份，别两处各写一遍。 */
		const MOUTH_D = {
			flat: "M38 40 h4.5",
			o: "M39.2 38.6 a1.7 2 0 1 1 3.4 0 a1.7 2 0 1 1 -3.4 0",
			smile: "M37.6 39.6 q2.7 2 5.3 0",
			open1: "M37.8 38.9 a2.8 1.1 0 1 1 5.2 0 a2.8 1.1 0 1 1 -5.2 0",
			open2: "M37.6 38.9 a3.0 1.9 0 1 1 5.6 0 a3.0 1.9 0 1 1 -5.6 0",
			open3: "M37.4 38.9 a3.2 2.6 0 1 1 6.0 0 a3.2 2.6 0 1 1 -6.0 0",
			open4: "M37.2 38.9 a3.4 3.3 0 1 1 6.4 0 a3.4 3.3 0 1 1 -6.4 0",
		};

		const { h, React, api, store, useStore, brandMarkSvg } = ui;
		const { useEffect, useRef, useState } = React;

		/** 独立窗的桥（`desktop/src/orb-preload.cts`）；浏览器里没有，调用全是 no-op。 */
		const bridge = () => (typeof window === "undefined" ? undefined : window.soloOrb);

		/**
		 * 小人：一个站着的人，四种看法（安静 / 在听 / 在想 / 在念）。
		 * 内联 SVG + CSS 动画：透明窗里 canvas 抠透明会出杂点，逐帧图要多几十份资源；
		 * SVG 跟主题一起缩放，嘴只是一个 d 属性，念的时候每帧改它。
		 */
		function personSvg(size, view) {
			const mouth =
				view === "speak" ? MOUTH_D.open2 : view === "think" ? MOUTH_D.smile : view === "listen" ? MOUTH_D.o : MOUTH_D.flat;
			return `<svg viewBox="0 0 80 96" width="${String(size)}" height="${String(Math.round((size * 96) / 80))}" aria-hidden="true">
	<ellipse cx="40" cy="92" rx="17" ry="3.4" fill="rgb(0 0 0 / 0.16)"/>
	<g class="orb-breath">
		<path class="orb-body" d="M40 60 q-11 1 -12 12 q0 10 2 14 h7 l1 -14 h4 l1 14 h7 q2 -4 2 -14 q-1 -11 -12 -12Z" fill="var(--orb-paper)" stroke="var(--orb-line)" stroke-width="1.3" stroke-linejoin="round"/>
		<path class="orb-limb" d="M28.5 62 q-6 3 -6.5 10 q-.4 5 2 6 q2.6 1 3.4 -2 q1.2 -7 4 -10Z" fill="var(--orb-paper)" stroke="var(--orb-line)" stroke-width="1.3" stroke-linejoin="round"/>
		<path class="orb-limb" d="M51.5 62 q6 3 6.5 10 q.4 5 -2 6 q-2.6 1 -3.4 -2 q-1.2 -7 -4 -10Z" fill="var(--orb-paper)" stroke="var(--orb-line)" stroke-width="1.3" stroke-linejoin="round"/>
		${view === "think" ? '<path class="orb-hand" d="M29 52 q-6 4 -2 9 q3 3 6 -1" fill="var(--orb-paper)" stroke="var(--orb-line)" stroke-width="1.3" stroke-linejoin="round"/>' : ""}
		<circle class="orb-head" cx="40" cy="38" r="15.5" fill="var(--orb-paper)" stroke="var(--orb-line)" stroke-width="1.3"/>
		<circle class="orb-dot" cx="49.4" cy="25.4" r="3.6" fill="var(--orb-dot)"/>
		<g class="orb-eyes"><g class="orb-pupils">
			<g class="orb-eye"><circle cx="35.2" cy="36" r="1.75" fill="var(--orb-ink)"/></g>
			<g class="orb-eye"><circle cx="44.8" cy="36" r="1.75" fill="var(--orb-ink)"/></g>
		</g></g>
		<path class="orb-mouth" d="${mouth}" fill="none" stroke="var(--orb-ink)" stroke-width="2.1" stroke-linecap="round" data-mouth="${view === "speak" ? "open2" : "flat"}"/>
		${view === "listen" ? '<path class="orb-arc" d="M13 34 q-2.4 5 0 10" fill="none" stroke="var(--orb-ink)" stroke-width="1.8" stroke-linecap="round"/><path class="orb-arc" d="M9.4 31.6 q-3.4 7.4 0 14.8" fill="none" stroke="var(--orb-ink)" stroke-width="1.8" stroke-linecap="round"/>' : ""}
	</g>
</svg>`;
		}

		/** 读之前把 Markdown 记号剥掉：念出来的是话，不是符号。 */
		function plainText(text) {
			return String(text)
				.replace(/```[\s\S]*?```/gu, "（代码）")
				.replace(/`([^`]+)`/gu, "$1")
				.replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
				.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
				.replace(/^#{1,6}\s+/gmu, "")
				.replace(/^\s*[-*+]\s+/gmu, "")
				.replace(/[*_~]/gu, "")
				.trim();
		}

		/** 一句太长就切开：每片一次请求，第一片先出声，后面的接上。 */
		function splitSpeech(text) {
			const pieces = [];
			let rest = text;
			while (rest.length > 160) {
				const cut = Math.max(
					rest.lastIndexOf("。", 160),
					rest.lastIndexOf("！", 160),
					rest.lastIndexOf("？", 160),
					rest.lastIndexOf("；", 160),
					rest.lastIndexOf("，", 160),
				);
				const at = cut >= 40 ? cut + 1 : 160;
				pieces.push(rest.slice(0, at).trim());
				rest = rest.slice(at).trim();
			}
			if (rest !== "") pieces.push(rest);
			return pieces.filter((piece) => piece !== "");
		}

		/**
		 * 录音不走 MediaRecorder。
		 *
		 * Chromium / Electron 只肯录 webm+opus（wav / ogg 都报不支持），而后端规范化用的
		 * macOS 自带 afconvert 打不开 webm，症状是 `Couldn't open input file ('typ?')`。
		 * 这里直接收 WebAudio 的 PCM，前端封成 16-bit 单声道 WAV —— 到后端没有任何容器可坏。
		 */
		const TARGET_RATE = 16000;

		/** Float32 PCM → 16 kHz 单声道 16-bit WAV。 */
		function wavBytes(samples, sampleRate) {
			const bytes = new Uint8Array(44 + samples.length * 2);
			const view = new DataView(bytes.buffer);
			const ascii = (offset, text) => {
				for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
			};
			const dataBytes = samples.length * 2;
			ascii(0, "RIFF");
			view.setUint32(4, 36 + dataBytes, true);
			ascii(8, "WAVE");
			ascii(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, sampleRate, true);
			view.setUint32(28, sampleRate * 2, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			ascii(36, "data");
			view.setUint32(40, dataBytes, true);
			for (let index = 0; index < samples.length; index += 1) {
				const value = Math.max(-1, Math.min(1, samples[index]));
				view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
			}
			return bytes;
		}

		/** 线性重采样到 16 kHz（浏览器拿到 44.1k / 48k 时兜底；已经是 16k 就原样返回）。 */
		function at16k(samples, rate) {
			if (!Number.isFinite(rate) || rate <= 0 || Math.abs(rate - TARGET_RATE) < 1) return samples;
			const ratio = rate / TARGET_RATE;
			const length = Math.max(1, Math.floor(samples.length / ratio));
			const out = new Float32Array(length);
			for (let index = 0; index < length; index += 1) {
				const at = index * ratio;
				const left = Math.floor(at);
				const right = Math.min(samples.length - 1, left + 1);
				const mix = at - left;
				out[index] = samples[left] * (1 - mix) + samples[right] * mix;
			}
			return out;
		}

		/** Uint8Array → base64（分块拼，别用一个巨大的字符串把内存顶住）。 */
		function bytesToBase64(bytes) {
			let binary = "";
			const step = 0x8000;
			for (let at = 0; at < bytes.length; at += step) {
				binary += String.fromCharCode.apply(null, bytes.subarray(at, Math.min(bytes.length, at + step)));
			}
			return btoa(binary);
		}

		const icon = (children) =>
			h(
				"svg",
				{
					width: 15,
					height: 15,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.8,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				children,
			);
		const micIcon = () =>
			icon([
				h("path", { key: "cap", d: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" }),
				h("path", { key: "arc", d: "M19 11a7 7 0 0 1-14 0" }),
				h("path", { key: "stem", d: "M12 18v3" }),
			]);
		const stopIcon = () => icon(h("rect", { key: "stop", x: 7, y: 7, width: 10, height: 10, rx: 2 }));
		const speakerIcon = (on) =>
			icon([
				h("path", { key: "cone", d: "M11 5 6 9H3v6h3l5 4z" }),
				on
					? h("path", { key: "wave", d: "M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" })
					: h("path", { key: "off", d: "m16 9 5 6m0-6-5 6" }),
			]);

		function Orb() {
			const people = useStore((state) => state.people);
			const channels = useStore((state) => state.channels);
			const currentId = useStore((state) => state.currentId);
			const liveDetail = useStore((state) => state.detail);
			const setupStep = useStore((state) => state.setupStep);

			const assistant = people.find((person) => person.assistant === true);
			const dm =
				assistant === undefined
					? undefined
					: channels.find((channel) => channel.kind === "dm" && channel.members.includes(assistant.slug));
			const dmId = dm?.id ?? null;

			const [prefs] = useState(readPrefs);
			// 独立窗里球的位置是固定的（窗口自己记位置），默认落在窗口右上。
			const [right, setRight] = useState(WINDOW_MODE ? 18 : prefs.right);
			const [top, setTop] = useState(() =>
				WINDOW_MODE ? 20 : (prefs.top ?? Math.round((typeof window === "undefined" ? 640 : window.innerHeight) * 0.36)),
			);
			const [docked, setDocked] = useState(WINDOW_MODE ? false : prefs.docked);
			/** 贴边时鼠标贴到窗口右缘：球滑出来。不放宽热区——宽了就压正文。 */
			const [peek, setPeek] = useState(false);
			const [menu, setMenu] = useState(false);
			const [detail, setDetail] = useState(null);
			/** 最近一条要告诉用户的错。**不再往面板里写**：没有面板了，它冒在头顶。 */
			const [error, setErrorState] = useState("");
			const [sending, setSending] = useState(false);
			const [speakOn, setSpeakOn] = useState(prefs.speak === true);
			const [recording, setRecording] = useState(false);
			const [elapsed, setElapsed] = useState(0);
			const [transcribing, setTranscribing] = useState(false);
			/** 和 `transcribing` 同步的 ref：`onaudioprocess` 里读 state 会一直是旧值（闭包），必须走 ref。 */
			/** 本地语音模型的状态（`GET /api/orb/voice`）：没下就显示一行下载。 */
			const [voice, setVoice] = useState(null);
			/**
			 * 最近一次「没念出来」的原话，**收着面板也挂在球上**。
			 *
			 * 以前 `reportSpeech` 只往 `speechProblemRef` 里攒，等老板下次打开面板才补一句。
			 * 可「收着也要念」恰恰是老板不看面板的时候 —— 他不打开，就永远不知道是哑的。
			 * 2.8.0 上「一个字都听不到」就是这么一声不响地哑了：自动播放被拒，
			 * 日志里有 `NotAllowedError`，界面上什么都没有。
			 */
			const [speechProblem, setSpeechProblem] = useState("");

			/**
			 * 头顶那一句。`kind` 三种：`it` = 它说的，`me` = 我说的，`error` = 出错要说一句。
			 * 一次只挂一句：新的直接顶掉旧的，不留历史（头顶不是消息列表）。
			 */
			const [bubble, setBubble] = useState(null);
			/** 淡出阶段：只掉透明度，位置不动，别让读到一半的字跳走。 */
			const [bubbleFading, setBubbleFading] = useState(false);
			/** 一次性「说话」事件：转写回来先冒我说的，等它回话再冒它的。 */
			const [saidAt, setSaidAt] = useState(0);
			const bubbleRef = useRef(null);
			/** 气泡自己的流水号（DOM 上的 `id` 是字符串，不能拿来数数）。 */
			const bubbleSeq = useRef(1);
			/** `bubbleShow` 的转发口：它定义在 early-return 之后，前面的调用会撞 `const` 死区。 */
			const showBubbleRef = useRef(() => {});
			const hideBubbleRef = useRef(() => {});
			/**
			 * 冒泡的「信箱」：上面那条挑消息的 effect 跑在渲染中间，这儿只放进去，
			 * 真正冒出来交给下面那个 effect —— 在 effect 里 setState 才不会打架。
			 */
			const bubblePendingRef = useRef(null);
			const bubbleTimer = useRef(0);
			const transcribingRef = useRef(false);

			const drag = useRef(null);
			const skipClick = useRef(false);
			const hoverTimer = useRef(0);
			/** 离开球 / 面板后晚一点再关命中，别在两者之间挪动时漏掉点击。 */
			const passTimer = useRef(0);
			const menuRef = useRef(null);
			const recorderRef = useRef(null);
			const chunksRef = useRef([]);
			const streamRef = useRef(null);
			const tickRef = useRef(0);
			const cancelledRef = useRef(false);
			/** 已经念过的消息序号：轮询与 SSE 会重复给同一条，别念两遍。 */
			const spokenRef = useRef(new Set());
			/** 最近一次「念不出来」的原因：面板收着时没人看得见，打开面板要能补上这一句。 */
			const speechProblemRef = useRef("");
			const primedRef = useRef(false);
			/** 播报队列：合成好的 wav 一片接一片播。面板收着也照播（老板 2026-11-09：收着也要念）。 */
			const queueRef = useRef([]);
			const audioRef = useRef(null);
			const speakingRef = useRef(false);
			/**
			 * 合成是**串行**的，而且只留一个待念的（老板 2026-11-10）。
			 *
			 * `tts-worker.js` 每念一句就是一个独立进程，各自要把 310MB 的模型读进来。
			 * 以前这里是 `for (...) void speakText(...)`：几条新消息一起来就并发起好几个
			 * worker，CPU 冲到 700%、内存 630MB，整台机器跟着卡。
			 * 现在同一时刻只有一个在合成；期间又来的排进这一个槽位，槽位里已有就丢掉
			 * —— 攒着的那句早就没意义了，人也不会想听十句过期播报。
			 */
			const synthesizingRef = useRef(false);
			const pendingRef = useRef(null);
			const voicePollRef = useRef(0);
			const fetchVoice = async () => {
				try {
					const response = await fetch("/api/orb/voice");
					const data = await response.json();
					setVoice(data);
					return data;
				} catch {
					return null;
				}
			};

			const stopAudio = () => {
				queueRef.current = [];
				pendingRef.current = null;
				speakingRef.current = false;
				const player = audioRef.current;
				audioRef.current = null;
				if (player !== null) {
					player.onended = null;
					player.onerror = null;
					player.pause();
				}
				stopMouth();
			};

			/**
			 * 出问题就说一句：现在没有面板，唯一的地方就是头顶那个气泡（`kind: "error"`）。
			 * 以前这些分支全是 `return` —— 用户只看到「开关是开的」，别的什么都没有。
			 */
			const reportSpeech = (why) => {
				const line = `没念出来：${why}`;
				speechProblemRef.current = line;
				// 先说一句：哑了这件事必须当场看见，不能等人来打开什么东西才发现。
				setSpeechProblem(line);
				sayProblem(line);
				console.warn(`[${SLUG}] ${line}`);
			};

			/**
			 * 播不出来就说出来。
			 *
			 * 以前 `player.onerror = playNext`：解码失败被当成「这段念完了」，一路静音跳完，
			 * 用户只看到开关亮着、一句话都没有，日志里也查不到。现在停掉这一片、记一句，
			 * 再接着放后面的（后面的也许只是这一片坏了）。
			 */
			const speechFailed = (why) => {
				queueRef.current = [];
				const player = audioRef.current;
				audioRef.current = null;
				speakingRef.current = false;
				if (player !== null) {
					player.onended = null;
					player.onerror = null;
					player.pause();
				}
				stopMouth();
				// 自动播放被拒跟「没有输出设备」完全是两回事，别把人带去查音箱。
				// 原文长这样：`NotAllowedError: play() failed because the user didn't interact
				// with the document first.` 壳里已经用 `autoplayPolicy` 放开了；万一还撞上，
				// 说明那扇窗没带上这个设置，说清楚比说「检查输出设备」有用得多。
				reportSpeech(
					why.includes("NotAllowedError") || why.includes("didn't interact")
						? "系统不允许自动出声（这扇窗没被允许自动播放）"
						: `${why}（音频没能播放，检查系统输出设备）`,
				);
			};

			/** 嘴跟真音量：分析正在播的那片，每 60ms 读一次 RMS 挑档；只在播放时跑。 */
			const mouthRef = useRef("");
			const meterRef = useRef(null);
			const mouthTimer = useRef(0);
			/** 这一次播放的 AEC 会话（`{ ok, ensure, process, release }`），没在念就是 null。 */
			const echoRef = useRef(null);
			/**
			 * 回声消除的状态，给界面看：
			 * - `off`：没开（没念 / 还没起来）
			 * - `on`：在用
			 * - `failed`：起不来，已降级成「念的时候直接丢输入」
			 */
			const [echoState, setEchoState] = useState("off");

			const stopMouth = () => {
				if (mouthTimer.current !== 0) {
					clearInterval(mouthTimer.current);
					mouthTimer.current = 0;
				}
				const ctx = meterRef.current;
				meterRef.current = null;
				mouthRef.current = "";
				// 必须真 close()：不关就是一直挂在默认输出设备上（macOS 上能看见它一直在响）。
				if (ctx !== null && ctx.state !== "closed") void ctx.close().catch(() => {});
			};

			/**
			 * 接上播放的这一片：动嘴 + 交出参考信号（AEC 要用）。
			 *
			 * 返回 `{ ctx, source }`，接不上就返回 `null` —— 调用方据此决定「回声消除不可用」。
			 * 返回 null 不等于不出声：声音照放，只是没接进 Web Audio 图、也就没有参考信号。
			 */
			/**
			 * 开一次回声消除会话。`wired` 是 `startMouth` 的返回值。
			 *
			 * 接不上（没 AudioContext / createMediaElementSource 被拦）就是**没有参考信号**，
			 * 这时候不硬开：AEC 没有参考等于白跑，还会把麦克风拖慢。记成 `failed` 降级。
			 */
			const startEcho = (wired) => {
				stopEcho();
				if (wired === null || wired === undefined) {
					setEchoState("failed");
					return;
				}
				const session = createEchoCanceller({ ctx: wired.ctx, reference: wired.source });
				if (session.ok !== true) {
					setEchoState("failed");
					return;
				}
				echoRef.current = session;
				setEchoState("on");
				// 先把 wasm 编译起来（几十毫秒），编译完之前来的麦克风数据走兜底降采样。
				void session
					.ensure()
					.then(() => {
						// 会话可能在这中间已经换了（下一片开新会话）——只认自己还活着的那次。
						if (echoRef.current === session) setEchoState("on");
					})
					.catch(() => {
						if (echoRef.current === session) {
							echoRef.current = null;
							setEchoState("failed");
						}
					});
			};

			const stopEcho = () => {
				const session = echoRef.current;
				echoRef.current = null;
				if (session !== null) session.release();
			};

			const startMouth = (player) => {
				stopMouth();
				const Ctx = typeof window === "undefined" ? undefined : window.AudioContext;
				if (Ctx === undefined) return null;
				try {
					const ctx = new Ctx();
					const source = ctx.createMediaElementSource(player);
					const analyser = ctx.createAnalyser();
					analyser.fftSize = 512;
					source.connect(analyser);
					analyser.connect(ctx.destination);
					const bins = new Uint8Array(analyser.frequencyBinCount);
					meterRef.current = ctx;
					mouthTimer.current = window.setInterval(() => {
						analyser.getByteTimeDomainData(bins);
						let sum = 0;
						for (const value of bins) {
							const v = (value - 128) / 128;
							sum += v * v;
						}
						const rms = Math.sqrt(sum / bins.length);
						// 四档：安静 0.02 以下闭嘴，往上依次张开；阈值是听着调出来的，不是拍的。
						const next = rms < 0.02 ? "open1" : rms < 0.05 ? "open2" : rms < 0.1 ? "open3" : "open4";
						if (next === mouthRef.current) return;
						mouthRef.current = next;
						// 直接改 DOM 的 d：每 60ms 一次重渲染不划算，嘴只是一个属性。
						const path = document.querySelector(".orb-mark .orb-mouth");
						if (path !== null) {
							path.setAttribute("d", MOUTH_D[next]);
							path.setAttribute("data-mouth", next);
						}
					}, 60);
					return { ctx, source };
				} catch {
					// 接不上就不动嘴，别因为嘴把声音也弄没了。
					stopMouth();
					return null;
				}
			};

			const playNext = () => {
				const next = queueRef.current.shift();
				if (next === undefined) {
					speakingRef.current = false;
					audioRef.current = null;
					// 念完了：影子会话也该收 —— 下一次开口是新的环境、新的回声路径。
					stopEcho();
					return;
				}
				const player = new Audio(`data:audio/wav;base64,${next}`);
				audioRef.current = player;
				speakingRef.current = true;
				// 嘴跟着这一片的真音量动；接不上（没 AudioContext / 被拦）就退回静态张嘴。
				const wired = startMouth(player);
				startEcho(wired);
				player.onended = playNext;
				player.onerror = () => speechFailed((player.error?.message ?? "") || "解码失败");
				void player.play().catch((error_) => {
					// NotAllowedError = 浏览器不给自动放（没有用户手势）：这也要说出来，
					// 否则「开关开着却没有声音」又变成一件只能猜的事。
					speechFailed(error_ instanceof Error ? error_.message : String(error_));
				});
			};

			/**
			 * 排一句要念的话。
			 *
			 * **不是 async、不返回 Promise**：调用方就是 `for` 循环里一路甩过来，这里只
			 * 往槽位里放一句就走。真正合成交给 `drainSpeech` 串着跑 —— 见 `synthesizingRef`。
			 */
			const speakText = (raw) => {
				const text = plainText(raw).slice(0, 1200);
				if (text === "") return;
				// 正在念的那句之后**只留一个位置，而且是直接覆盖、不是排队**：连来 4 条
				// 只会念第 1 条和最后那条第 4 条，中间两条直接丢。这是故意的——攒着的
				// 播报早就过期了，没人想听四条历史。别当 bug 改回队列。
				pendingRef.current = text;
				if (!synthesizingRef.current) void drainSpeech();
			};

			/** 把槽位里的句子一句一句合成掉；同一时刻只有一个在跑。 */
			const drainSpeech = async () => {
				if (synthesizingRef.current) return;
				synthesizingRef.current = true;
				try {
					while (pendingRef.current !== null) {
						const next = pendingRef.current;
						pendingRef.current = null;
						await synthesize(next);
					}
				} finally {
					synthesizingRef.current = false;
				}
			};

			/** 本地神经音色念一句：切成小片合成，第一片先出声。 */
			const synthesize = async (raw) => {
				const text = plainText(raw).slice(0, 1200);
				if (text === "") return;
				// 音色与语速每次现读：设置里刚改完，下一句就照新的念，不用重开面板。
				const prefs = readPrefs();
				for (const piece of splitSpeech(text)) {
					try {
						const response = await fetch("/api/orb/speak", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ text: piece, speed: prefs.speed, voice: prefs.voice }),
						});
						const data = await response.json().catch(() => ({}));
						// 合成回来的这一片**无条件**播：以前这里有一句 `if (!openRef.current) return`，
						// 合成慢一点、面板刚收起，这一片就静默丢了 —— 老板听到的「开关开着没声音」。
						if (typeof data?.wav === "string") {
							queueRef.current.push(data.wav);
							if (!speakingRef.current) playNext();
							continue;
						}
						if (data?.needModel === true) {
							void fetchVoice();
							reportSpeech(`还没下载语音模型（${SLUG} 设置 → 语音）`);
							return;
						}
						reportSpeech(typeof data?.error === "string" ? data.error : "没合成出来");
						return;
					} catch (error_) {
						reportSpeech(error_ instanceof Error ? error_.message : String(error_));
						return;
					}
				}
			};

			const downloadVoice = async () => {
				try {
					const response = await fetch("/api/orb/voice", { method: "POST" });
					setVoice(await response.json());
				} catch {
					return;
				}
				if (voicePollRef.current !== 0) clearInterval(voicePollRef.current);
				voicePollRef.current = window.setInterval(() => {
					void fetchVoice().then((data) => {
						if (data === null || data.downloading !== true) {
							clearInterval(voicePollRef.current);
							voicePollRef.current = 0;
						}
					});
				}, 1000);
			};

			// 正在看的这条私聊：直接吃 store（SSE 在推）；别的频道才用自己拉的那份。
			const shown = currentId === dmId ? liveDetail : detail;
			const messages = (shown?.messages ?? []).filter((message) => message.kind === "chat").slice(-14);
			const activity = assistant?.activity;
			const busy = activity !== undefined;
			const unread = dm?.unread ?? 0;
			// 小人摆哪个姿势：正在念 > 在想 / 正在干活 > 安静。
			// 「在听」这一版还到不了 —— 唤醒还是「按住才听」，等常驻听落地才接得上。
			const look = speakingRef.current ? "speak" : busy ? "think" : "idle";

			// 右键菜单 148 宽：右边放得下就在右边，否则换到左边 / 上下，**不压小人**。
			// （气泡的位置不在这里算：它要量真实高度，见 `layoutBubble()`。）
			const viewport =
				typeof window === "undefined" ? { width: 375, height: 812 } : { width: window.innerWidth, height: window.innerHeight };
			const orbLeft = viewport.width - right - BALL;
			const orbTop = top;
			const gap = 8;
			const edge = 8;

			const menuPlace = (() => {
				const besideOrb = orbLeft + BALL + gap + 148 <= viewport.width - edge;
				if (besideOrb) {
					return {
						left: `${String(BALL + gap)}px`,
						top: `${String(clamp(orbTop, edge, Math.max(edge, viewport.height - 156)) - orbTop)}px`,
					};
				}
				const lineLeft = clamp(orbLeft, edge, Math.max(edge, viewport.width - 148 - edge));
				const above = orbTop - gap - 148;
				if (above >= edge) return { left: `${String(lineLeft - orbLeft)}px`, top: `${String(above - orbTop)}px` };
				return {
					left: `${String(lineLeft - orbLeft)}px`,
					top: `${String(orbTop + BALL_H + gap - orbTop)}px`,
				};
			})();

			const cancelHover = () => {
				if (hoverTimer.current !== 0) {
					clearTimeout(hoverTimer.current);
					hoverTimer.current = 0;
				}
			};

			/** 独立窗：鼠标在球 / 面板上才接点击，透明的地方直接穿到桌面。 */
			const holdInteractive = (on) => {
				if (!WINDOW_MODE) return;
				if (passTimer.current !== 0) {
					clearTimeout(passTimer.current);
					passTimer.current = 0;
				}
				if (on) {
					bridge()?.setInteractive(true);
					return;
				}
				passTimer.current = window.setTimeout(() => {
					passTimer.current = 0;
					bridge()?.setInteractive(false);
				}, 140);
			};

			/**
			 * 收掉能收的：菜单、正在按的那段录音。
			 *
			 * **正在念的不掐**（老板 2026-11-09 定的：收着也要念完），
			 * 气泡也不掐 —— 它是唯一的出口，提前收掉等于把话咽了。
			 */
			const closeAll = () => {
				cancelHover();
				const recorder = recorderRef.current;
				if (recorder !== null && recorder.state !== "inactive") {
					cancelledRef.current = true;
					recorder.stop();
				}
				setMenu(false);
			};

			// **这个 effect 是头顶气泡的唯一数据源。** 主界面（inline）那颗球和单独窗口
			// （`?orb=1`）那颗球走的是同一条：谁「新」由 `spokenRef` 里的 seq 判，不靠
			// store 推不推。以前冒泡写在朗读那段的末尾，而网页版不后台念、在中间就
			// `return` 了 —— 于是主界面收到回复一句气泡都不冒，单独窗口却正常。
			// 改这块先记住：**看和听不能共用一条早退**。
			//
			// 补私聊消息。**不管 `currentId` 是不是这条私聊都要拉**（老板 2026-11-10）：
			// 原先这里写着「正在看私聊时 store 已经在推，不用再拉」，可悬浮窗是独立的一扇窗，
			// 它自己的 `store.detail` 是空的，主窗口那份不会流过来——结果是 `currentId` 正好
			// 停在私聊上时，这里一次都不拉，`fresh` 恒空，一句都不念。
			//
			// **收起面板也照拉**：这个开关叫「收着也要念」，可收起时恰恰没人拉私聊，
			// 最该响的时候一声不响。面板收起 = 老板在干别的，才更需要被叫。
			useEffect(() => {
				if (dmId === null) return undefined;
				let alive = true;
				const pull = async () => {
					try {
						const next = await api.getChannel(dmId, 20);
						if (alive) setDetail(next);
					} catch {
						// 拉不到就保持上一次的样子，下一次再试。
					}
				};
				void pull();
				const timer = setInterval(() => void pull(), 4000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [dmId, currentId]);

			// 语音模型在不在：装一次问一次，没下的话面板里给一行下载。
			useEffect(() => {
				void fetchVoice();
			}, []);

			// 助理的新回复自动读出来。第一次只记基线：打开时不会把旧消息全念一遍。
			//
			// **只念跟老板有关的**（老板 2026-11-10）：私聊里的助理回复，加上任意会话里点名
			// 找老板的那条（`needsYou`，判据在核心里，只认显式 @）。成员之间在团队频道里
			// 干活的技术对话不念 —— 以前全念，结果把 SIGTERM、osascript、reinstall 这些
			// 内部术语播给老板听，那是噪音不是内容。
			useEffect(() => {
				const slug = assistant?.slug;
				// 念什么跟着「老板私聊」走，跟面板上正开着哪个频道无关：
				// `detail` 就是那条私聊（收起时也由上面那个轮询在补），`shown` 是屏幕上
				// 正在看的那份——停在团队频道时它压根不含私聊，拿它当数据源，收起 / 切走后
				// 私聊的回复就永远念不到。
				if (slug === undefined) {
					// 没准备好助理时什么都不念，但基线照记（否则准备好那一刻会把历史全倒一遍）。
					primedRef.current = true;
					return;
				}
				const isAssistantChat = (message) => message.kind === "chat" && message.fromSlug === slug;
				// 私聊那份消息：正看着私聊时 store 在推（`liveDetail`），其余时候靠上面那个轮询
				// 拉进 `detail`。两份都可能最新，按 seq 合并，谁新用谁。
				const dmMessages = new Map();
				for (const message of [...(liveDetail?.messages ?? []), ...(detail?.messages ?? [])]) {
					dmMessages.set(message.seq, message);
				}
				// 私聊里助理说的：整条念（那是有人跟老板说话）。
				const inDm = [...dmMessages.values()].filter(isAssistantChat);
				// 别的会话里点名找老板的：只念这一条（`needsYou` 由核心算，只认显式 @）。
				const named = (shown?.messages ?? []).filter(
					(message) => isAssistantChat(message) && message.needsYou === true,
				);
				// 键必须是 `频道:序号`，**不能只用序号**：seq 是频道内自增的，每条聊天都从 1
				// 开始数。换私聊 / 换会话时，新频道里排第 3 的那条会撞上老频道第 3 条的键，
				// 于是被判成「念过了」跳过，或者反过来把旧的又念一遍——就是老板听到的
				// 「换私聊把旧回复重念一遍」。频道名跟着消息走，轨道才知道它属于哪。
				const tracks = [
					...inDm.map((message) => ({ chatId: dmId, message })),
					...named.map((message) => ({ chatId: shown?.id ?? "", message })),
				];
				const seenKey = (track) => `${track.chatId ?? ""}:${track.message.seq}`;
				if (!primedRef.current) {
					for (const track of tracks) spokenRef.current.add(seenKey(track));
					primedRef.current = true;
					return;
				}
				const fresh = tracks.filter((track) => !spokenRef.current.has(seenKey(track)));
				for (const track of tracks) spokenRef.current.add(seenKey(track));
				const chats = tracks.map((track) => track.message);
				// 头顶只挂最后一句：几条一起到，看完的那一句才有用（上一条被顶掉是故意的）。
				//
				// **这一行必须在下面那个 `return` 之前**。以前它写在最后，可网页版（inline）
				// 在中间就 `return` 了（那里不后台念）—— 于是「主界面那颗球收到回复不冒泡」，
				// 而单独窗口那颗会冒。看到的和听到的是两件事，不能共用一条早退。
				const lastFresh = fresh[fresh.length - 1];
				if (lastFresh !== undefined) {
					bubblePendingRef.current = {
						text: lastFresh.message.text,
						kind: "it",
						who: lastFresh.message.fromLabel ?? undefined,
					};
				}

				// 只看朗读开关。以前这里还写着 `&& open`（面板开着才念），面板一没这个条件就废了。
				//
				// **网页版（inline）也念**（老板 2026-11-11）：以前这里还有一条
				// `|| ORB_MODE === "inline"`，理由是「那一屏可能根本没在看，出声会打扰」。
				// 可主界面那颗球就在老板眼前，他点了「打开朗读」，一个字都不出声 —— 那这个开关
				// 就是坏的。挡声音的应该是开关本身，不是「你在哪扇窗里」。真不想听，关掉它。
				if (!speakOn) return;
				// 这里**不是**并发起一串合成：`speakText` 只往槽位里塞一句，真正的合成由
				// `drainSpeech` 串着跑，槽位里只留一个待念的，多的直接丢（见 `synthesizingRef`）。
				// 以前是 `for (...) void speakText(...)`，几条消息一起来就起好几个 310MB 的
				// worker，CPU 700%、内存 630MB。
				// `fresh` 里装的是 `{ chatId, message }`（轨道），不是消息本身。以前这里写
				// `speakText(message.text)`，取的是轨道上的 `text` —— 永远是 undefined，
				// `plainText` 把它 `String()` 成 "undefined"，后端照合成，老板就听见念「undefined」。
				for (const track of fresh) speakText(track.message.text);
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [shown, speakOn, assistant, detail, liveDetail]);

			// 卸载：录音、麦克风、朗读一起收掉。
			useEffect(
				() => () => {
					clearInterval(tickRef.current);
					clearTimeout(passTimer.current);
					const recorder = recorderRef.current;
					if (recorder !== null && recorder.state !== "inactive") {
						cancelledRef.current = true;
						recorder.stop();
					}
					for (const track of streamRef.current?.getTracks() ?? []) track.stop();
					streamRef.current = null;
					stopAudio();
					clearInterval(voicePollRef.current);
					voicePollRef.current = 0;
				},
				[],
			);

			// Esc：有菜单收菜单，有气泡收气泡。没有面板可收了。
			useEffect(() => {
				if (!menu && bubble === null) return undefined;
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					const recorder = recorderRef.current;
					if (recorder !== null && recorder.state !== "inactive") {
						// 录音中按 Esc = 取消这段，不动别的。
						cancelledRef.current = true;
						recorder.stop();
						return;
					}
					if (menu) setMenu(false);
					else bubbleHide();
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [menu, bubble?.id]);

			// 点别处收菜单。
			useEffect(() => {
				if (!menu) return undefined;
				const onDown = (event) => {
					if (menuRef.current !== null && !menuRef.current.contains(event.target)) setMenu(false);
				};
				document.addEventListener("pointerdown", onDown);
				return () => document.removeEventListener("pointerdown", onDown);
			}, [menu]);

			// 独立窗被菜单栏图标藏起来时页面变成 hidden：录音、朗读一起收掉。
			useEffect(() => {
				if (!WINDOW_MODE) return undefined;
				const onVisibility = () => {
					if (document.visibilityState === "hidden") closeAll();
				};
				document.addEventListener("visibilitychange", onVisibility);
				return () => document.removeEventListener("visibilitychange", onVisibility);
			}, []);

			// 窗口变小了把球拉回可见范围（手机上转屏就会遇到）。
			useEffect(() => {
				const onResize = () => {
					if (typeof window === "undefined") return;
					setRight((value) => clamp(value, 0, Math.max(0, window.innerWidth - BALL - 8)));
					setTop((value) => clamp(value, 8, Math.max(8, window.innerHeight - BALL - 8)));
				};
				onResize();
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);

			// 贴边滑出：鼠标贴到窗口右缘就算。热区一宽就压正文，右边栏按钮就点不到。
			useEffect(() => {
				if (!docked || WINDOW_MODE) return undefined;
				const onMove = (event) => {
					const nearEdge = window.innerWidth - event.clientX <= 12;
					const inBand = event.clientY >= top - 16 && event.clientY <= top + BALL + 16;
					setPeek(nearEdge && inBand);
				};
				const off = () => setPeek(false);
				window.addEventListener("mousemove", onMove, { passive: true });
				window.addEventListener("blur", off);
				return () => {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("blur", off);
					setPeek(false);
				};
			}, [docked, top]);

			// 悬停**不再展开任何东西**：没有面板可展开了。悬停只做两件小事 ——
			// 独立窗里把命中接上（否则点不到），贴着边时滑出来。
			const enter = () => {
				cancelHover();
				holdInteractive(true);
			};

			const leave = () => {
				cancelHover();
				// 拖着的时候别把命中关掉，不然拖到一半窗口就点不动了。
				//
				// **菜单开着也别关**（老板 2026-11-12 报「菜单四项都点不动」）：菜单是球的**兄弟**
				// 节点、摆在球外面（见 `menuPlace`），鼠标从球移到菜单那一段必定先触发球的
				// `pointerleave` —— 140ms 后窗口进穿透态，那之后点在菜单上的每一下都落到桌面。
				// 按钮的 `onClick` 全是对的，是根本没收到点击。
				if (!menu && drag.current === null) holdInteractive(false);
			};

			const onPointerDown = (event) => {
				if (event.button !== 0) return;
				cancelHover();
				holdInteractive(true);
				drag.current = WINDOW_MODE
					? { window: true, screenX: event.screenX, screenY: event.screenY, moved: false }
					: {
							x: event.clientX,
							y: event.clientY,
							right,
							top,
							docked,
							moved: false,
							lastRight: right,
							lastTop: top,
						};
				skipClick.current = false;
				event.currentTarget.setPointerCapture?.(event.pointerId);
			};

			const onPointerMove = (event) => {
				const state = drag.current;
				if (state === null) return;
				if (state.window === true) {
					// 独立窗：球在窗口里的位置不动，这一下挪的是整扇窗（主进程负责夹边界）。
					const dx = event.screenX - state.screenX;
					const dy = event.screenY - state.screenY;
					if (!state.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
					state.moved = true;
					state.screenX = event.screenX;
					state.screenY = event.screenY;
					bridge()?.dragBy(dx, dy);
					return;
				}
				const dx = event.clientX - state.x;
				const dy = event.clientY - state.y;
				if (!state.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
				state.moved = true;
				const nextRight = clamp(state.right - dx, 0, Math.max(0, window.innerWidth - BALL - 8));
				const nextTop = clamp(state.top + dy, 8, Math.max(8, window.innerHeight - BALL - 8));
				state.lastRight = nextRight;
				state.lastTop = nextTop;
				setRight(nextRight);
				setTop(nextTop);
				// 从贴边状态拖出来一段就解贴。
				if (state.docked && nextRight > 64) {
					state.docked = false;
					setDocked(false);
				}
			};

			const onPointerUp = () => {
				const state = drag.current;
				drag.current = null;
				if (state === null || !state.moved) return;
				skipClick.current = true;
				if (state.window === true) {
					// 窗口位置由壳记住；球在窗口里不动，也没有贴边。
					bridge()?.dragEnd();
					return;
				}
				const nextDocked = state.lastRight < DOCK_AT;
				setDocked(nextDocked);
				if (nextDocked) setRight(0);
				savePrefs({ right: nextDocked ? 0 : state.lastRight, top: state.lastTop, docked: nextDocked });
			};

			// 点一下 = 打开那个小菜单（直接说话 / 朗读 / 贴边 / 回默认位置）。
			//
			// 以前点一下是「钉住面板」——面板没了，这个动作也就没意义了。说一句话不需要点，
			// 点这里是为了调开关和挪位置。
			const onClick = () => {
				if (skipClick.current) {
					skipClick.current = false;
					return;
				}
				cancelHover();
				hideBubbleRef.current();
				if (docked) {
					// 贴着边点一下 = 先把它请出来，再开菜单。
					setDocked(false);
					savePrefs({ right: 18, top, docked: false });
					setRight(18);
				}
				setMenu((value) => !value);
			};

			const onContextMenu = (event) => {
				event.preventDefault();
				cancelHover();
				setMenu(true);
			};

			const toggleDock = () => {
				const next = !docked;
				setDocked(next);
				if (next) setRight(0);
				savePrefs({ right: next ? 0 : right, top, docked: next });
				setMenu(false);
			};

			const recenter = () => {
				setMenu(false);
				if (WINDOW_MODE) {
					bridge()?.recenter();
					return;
				}
				const nextTop = Math.round(window.innerHeight * 0.36);
				setDocked(false);
				setRight(18);
				setTop(nextTop);
				savePrefs({ right: 18, top: nextTop, docked: false });
			};

			const cleanupStream = () => {
				for (const track of streamRef.current?.getTracks() ?? []) track.stop();
				streamRef.current = null;
			};

			const sendText = async (text) => {
				const value = text.trim();
				if (value === "" || dmId === null) return;
				setSending(true);
				sayProblem("");
				// 我说的话也冒在头顶：不冒，等它回话那段就只剩一片空白，看不出「听见了没有」。
				// 走 ref：`sendText` 定义在 `bubbleShow` 之前，直接调会碰 `const` 的暂时性死区。
				showBubbleRef.current({ text: value, kind: "me" });
				try {
					await api.sendMessage(dmId, { text: value });
					if (currentId !== dmId) {
						const next = await api.getChannel(dmId, 20).catch(() => null);
						if (next !== null) setDetail(next);
					}
				} catch (error_) {
					sayProblem(`没发出去：${error_ instanceof Error ? error_.message : String(error_)}`);
				} finally {
					setSending(false);
				}
			};

			const finishRecording = async (sampleRate) => {
				clearInterval(tickRef.current);
				tickRef.current = 0;
				setRecording(false);
				setElapsed(0);
				cleanupStream();
				recorderRef.current = null;
				const chunks = chunksRef.current;
				chunksRef.current = [];
				if (cancelledRef.current) return;

				let total = 0;
				for (const chunk of chunks) total += chunk.length;
				if (total < TARGET_RATE * 0.3) {
					sayProblem("太短了，没听清");
					return;
				}
				const merged = new Float32Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					merged.set(chunk, offset);
					offset += chunk.length;
				}
				const pcm = at16k(merged, sampleRate);
				const wav = wavBytes(pcm, TARGET_RATE);
				sayProblem("");
				transcribingRef.current = true;
				setTranscribing(true);
				try {
					// 前端也掐一道：后端 30 秒硬超时，这里 45 秒兜底（转写 + 上传都在里面）。
					const response = await fetch("/api/orb/transcribe", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							audio: bytesToBase64(wav),
							mime: "audio/wav",
							lang: navigator.language || "zh-CN",
						}),
						signal: AbortSignal.timeout(45_000),
					});
					const data = await response.json().catch(() => ({}));
					if (!response.ok) throw new Error(data?.error ?? `转写接口 ${String(response.status)}`);
					if (typeof data?.error === "string") {
						sayProblem(data.error);
						return;
					}
					const text = typeof data?.text === "string" ? data.text.trim() : "";
					if (text === "") {
						sayProblem("没听清，再说一次？");
						return;
					}
					await sendText(text);
				} catch (error_) {
					sayProblem(`没转成：${error_ instanceof Error ? error_.message : String(error_)}`);
				} finally {
					transcribingRef.current = false;
					setTranscribing(false);
				}
			};

			const stopRecording = (cancel) => {
				const recorder = recorderRef.current;
				cancelledRef.current = cancel === true;
				if (recorder !== null && recorder.state !== "inactive") recorder.stop();
			};

			const startRecording = async () => {
				if (dmId === null) {
					sayProblem("助理私聊还没建好");
					return;
				}
				if (recording || transcribing) return;
				if (typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia === undefined) {
					sayProblem("这个环境不支持录音");
					return;
				}
				sayProblem("");
				try {
					const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					streamRef.current = stream;
					// 一路直收 PCM：先要 16 kHz，拿不到就按设备原生采样率录，落 WAV 之前再重采样。
					const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
					let ctx;
					try {
						ctx = new AudioCtx({ sampleRate: TARGET_RATE });
					} catch {
						ctx = new AudioCtx();
					}
					await ctx.resume().catch(() => undefined);
					const source = ctx.createMediaStreamSource(stream);
					const node = ctx.createScriptProcessor(4096, 1, 1);
					const mute = ctx.createGain();
					mute.gain.value = 0;
					chunksRef.current = [];
					cancelledRef.current = false;
					// 调用点和 MediaRecorder 一样：`state` + `stop()`。
					const capture = {
						state: "recording",
						stop() {
							if (capture.state === "inactive") return;
							capture.state = "inactive";
							node.onaudioprocess = null;
							try {
								source.disconnect();
								node.disconnect();
								mute.disconnect();
							} catch {
								/* 已经断开了 */
							}
							void ctx.close().catch(() => undefined);
							void finishRecording(ctx.sampleRate);
						},
					};
					node.onaudioprocess = (event) => {
						if (recorderRef.current !== capture) return;
						chunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
					};
					source.connect(node);
					node.connect(mute);
					mute.connect(ctx.destination);
					recorderRef.current = capture;
					setElapsed(0);
					const startedAt = Date.now();
					tickRef.current = window.setInterval(() => {
						const seconds = Math.floor((Date.now() - startedAt) / 1000);
						setElapsed(seconds);
						if (seconds >= 30) stopRecording(false);
					}, 250);
					setRecording(true);
					// 说话时把正在读的那句掐掉，别录到自己。
					stopAudio();
					// 开口就是语音对话：第一次按麦克风顺手把朗读打开。
					if (!speakOn) {
						setSpeakOn(true);
						savePrefs({ speak: true });
					}
				} catch (error_) {
					cleanupStream();
					const name = error_?.name;
					sayProblem(
						name === "NotAllowedError" || name === "SecurityError"
							? "没拿到麦克风权限：到系统设置里允许 Solo 使用麦克风"
							: name === "NotFoundError"
								? "没找到麦克风"
								: `打不开麦克风：${error_ instanceof Error ? error_.message : String(error_)}`,
					);
				}
			};

			const toggleSpeak = () => {
				const next = !speakOn;
				setSpeakOn(next);
				savePrefs({ speak: next });
				if (!next) stopAudio();
				showBubbleRef.current({ text: next ? "朗读：开" : "朗读：关", kind: "it" });
			};

			// ── 常驻听：不用点，开口就说 ───────────────────────────────
			//
			// 老板 2026-11-11 要的就这一句：「不用点就能说话，说完冒气泡」。
			// 所以麦克风一直开着，用能量（RMS）判有没有人在说：
			//
			// 1. 一直往 `ringRef` 里塞 100ms 一块的 PCM，只留最近 1.5 秒
			//    —— 开头那半个字在「判定为说话」之前就已经发生过了，没有环形缓冲就会切掉它；
			// 2. 连续 3 块超过 `VAD_ON` 算开口，往后接；安静 6 块（约 800ms）算说完；
			// 3. 说完把这一段（含前面那 1.5 秒）拼成 WAV 走 `/api/orb/transcribe`，转写出来就发；
			// 4. **它自己在念的时候整段丢掉**（`speakingRef` 一真就直接丢输入）——
			//    上面那套 AEC 只服务唤醒词那条路，常驻听这里用最笨也最稳的办法：不听自己。
			//
			// 判据是能量，不是模型：说话大声、敲键盘、风扇都会误触。所以门槛定得高
			// （见 `VAD_ON`），而且少于 0.45 秒的「嗯」直接丢，不打扰。
			const VAD_ON = 0.045;
			const VAD_OFF = 0.022;
			const VAD_BLOCK = 100;
			const VAD_OPEN_BLOCKS = 3;
			const VAD_CLOSE_BLOCKS = 6;
			const VAD_PREROLL = 15;
			const VAD_MIN_MS = 450;
			const VAD_MAX_MS = 15_000;
			const [listenOn, setListenOn] = useState(prefs.listen === true);
			/** 常驻听此刻的状态，给小人身边那圈光用。 */
			const [listening, setListening] = useState(false);
			const [sayLevel, setSayLevel] = useState(0);
			const ringRef = useRef([]);
			const listenRef = useRef(null);
			const listenBusyRef = useRef(false);
			const listenFailRef = useRef(0);
			const levelRef = useRef(0);
			const vadRef = useRef({ speaking: false, loud: 0, quiet: 0, kept: 0, blocks: 0 });

			const stopListen = () => {
				const state = listenRef.current;
				listenRef.current = null;
				setListening(false);
				setSayLevel(0);
				ringRef.current = [];
				vadRef.current = { speaking: false, loud: 0, quiet: 0, kept: 0, blocks: 0 };
				if (state === null) return;
				try {
					state.node.onaudioprocess = null;
					state.node.disconnect();
					state.source.disconnect();
					state.mute.disconnect();
				} catch {
					// 已经断了就算了。
				}
				for (const track of state.stream.getTracks()) track.stop();
				void state.ctx.close().catch(() => undefined);
			};

			/** 一段 PCM 交给转写，转写出来就发。和按麦克风那条路共用 `finishRecording` 的逻辑。 */
			const sayTranscribe = async (samples, rate) => {
				if (dmId === null) return;
				const pcm = at16k(samples, rate);
				const wav = wavBytes(pcm, TARGET_RATE);
				// `transcribing` / `transcribingRef` 由**调用方**开合：两条录音路径的收尾时机
				// 不一样（按键那条还要停录音机），放这里会在外面还没收完时就解锁。
				sayProblem("");
				try {
					const response = await fetch("/api/orb/transcribe", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							audio: bytesToBase64(wav),
							mime: "audio/wav",
							lang: navigator.language || "zh-CN",
						}),
						signal: AbortSignal.timeout(45_000),
					});
					const data = await response.json().catch(() => ({}));
					if (!response.ok) throw new Error(data?.error ?? `转写接口 ${String(response.status)}`);
					if (typeof data?.error === "string") {
						sayProblem(data.error);
						return;
					}
					const text = typeof data?.text === "string" ? data.text.trim() : "";
					// 转写出来是空的就不用报错：常驻听会一直有说话声、咳嗽声，每次都弹一句太吵。
					if (text === "") return;
					// 冒泡交给 `sendText`：那里一处冒，两条录音路径才长得一样。
					await sendText(text);
				} catch (error_) {
					sayProblem(`没转成：${error_ instanceof Error ? error_.message : String(error_)}`);
				}
			};

			/**
			 * 开常驻听。**返回「真的听上了没有」**——调用方靠这个决定开关该不该亮。
			 *
			 * 2026-11-11 老板定的：开关不许先开。以前是 `setListenOn(true)` 再 `void startListen()`，
			 * 撞上 `dmId === null` 或者麦克风没权限，就变成「开关显示打开、麦克风根本没开、也不报错」。
			 * 现在改成先听上、再点开关；听不上就把开关按回去。
			 */
			const startListen = async () => {
				if (listenRef.current !== null) return true;
				if (listenBusyRef.current) return false;
				// 私聊还没加载出来：现在听上了也发不出去，直接说清为什么，别装作在听。
				if (dmId === null) {
					sayProblem("私聊还没加载出来，等一下再开");
					return false;
				}
				// 失败也接着试，但别每拍都去撞权限弹窗。
				if (Date.now() - listenFailRef.current < 8_000) return false;
				listenBusyRef.current = true;
				try {
					let stream;
					try {
						stream = await navigator.mediaDevices.getUserMedia({
							audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
						});
					} catch (error_) {
						listenFailRef.current = Date.now();
						const name = error_?.name;
						sayProblem(
							name === "NotAllowedError" || name === "SecurityError"
								? "没拿到麦克风权限：就不能不点直接说了"
								: name === "NotFoundError"
									? "没找到麦克风"
									: "麦克风打不开",
						);
						return false;
					}
					const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
					const ctx = new AudioCtx({ sampleRate: TARGET_RATE });
					await ctx.resume().catch(() => undefined);
					if (ctx.state !== "running") {
						for (const track of stream.getTracks()) track.stop();
						void ctx.close().catch(() => undefined);
						listenFailRef.current = Date.now();
						sayProblem("浏览器没让后台听麦克风");
						return false;
					}
					const source = ctx.createMediaStreamSource(stream);
					const node = ctx.createScriptProcessor(4096, 1, 1);
					const mute = ctx.createGain();
					mute.gain.value = 0;
					const state = { stream, ctx, node, source, mute, rate: ctx.sampleRate };
					const block = Math.round((state.rate * VAD_BLOCK) / 1000);
					node.onaudioprocess = (event) => {
						if (listenRef.current !== state) return;
						const input = new Float32Array(event.inputBuffer.getChannelData(0));
						// 它在念：整段丢掉。自己说的话进了转写，就会变成「助理自己跟自己聊」。
						if (speakingRef.current) {
							vadRef.current = { speaking: false, loud: 0, quiet: 0, kept: 0, blocks: 0 };
							ringRef.current = [];
							return;
						}
						// 转写 / 发送正在跑：这一波先不接，免得叠着发两条。
						if (transcribingRef.current === true) return;
						let sum = 0;
						for (const value of input) sum += value * value;
						const rms = Math.sqrt(sum / input.length);
						levelRef.current = rms;
						const vad = vadRef.current;
						if (vad.speaking) {
							vad.loud = rms >= VAD_ON ? vad.loud + 1 : 0;
							vad.quiet = rms < VAD_OFF ? vad.quiet + 1 : 0;
							ringRef.current.push(input);
							while (ringRef.current.length > VAD_MAX_MS / VAD_BLOCK + VAD_PREROLL) ringRef.current.shift();
							vad.kept += VAD_BLOCK;
							if (vad.quiet < VAD_CLOSE_BLOCKS) return;
							// 说完了：把这一段拼起来。
							vad.speaking = false;
							const chunks = ringRef.current;
							ringRef.current = [];
							const keep = vad.kept;
							vad.kept = 0;
							vad.loud = 0;
							vad.quiet = 0;
							setListening(false);
							if (keep < VAD_MIN_MS) return;
							let total = 0;
							for (const piece of chunks) total += piece.length;
							const merged = new Float32Array(total);
							let offset = 0;
							for (const piece of chunks) {
								merged.set(piece, offset);
								offset += piece.length;
							}
							// 常驻听和按键录音**共用**这个锁：两条路同时开转写会撞成一个 310MB 的模型。
							// （`transcribing` 那个 state 给界面看，这个 ref 给回调看 —— 回调里读到的
							// 永远是闭包里的旧 state。）
							transcribingRef.current = true;
							setTranscribing(true);
							void sayTranscribe(merged, state.rate).finally(() => {
								transcribingRef.current = false;
								setTranscribing(false);
							});
							return;
						}
						// 还没开口：环形缓冲一直转着，等着「判定为说话」那一刻能往回捞。
						ringRef.current.push(input);
						while (ringRef.current.length > VAD_PREROLL + VAD_OPEN_BLOCKS) ringRef.current.shift();
						vad.loud = rms >= VAD_ON ? vad.loud + 1 : 0;
						if (vad.loud < VAD_OPEN_BLOCKS) return;
						vad.speaking = true;
						vad.quiet = 0;
						vad.kept = vad.loud * VAD_BLOCK;
						setListening(true);
					};
					source.connect(node);
					node.connect(mute);
					mute.connect(ctx.destination);
					listenRef.current = state;
					listenBusyRef.current = false;
					setListening(true);
					sayProblem("");
					return true;
				} catch {
					listenFailRef.current = Date.now();
					return false;
				} finally {
					listenBusyRef.current = false;
				}
			};

			/**
			 * 开关「直接说话」。
			 *
			 * 先真听上再点亮开关：原来先点亮再 startListen，没开成就留下「亮着却没在听」的假象。
			 * 现在听上了才亮，听不上按回去。
			 */
			const toggleListen = async () => {
				if (listenOn) {
					setListenOn(false);
					savePrefs({ listen: false });
					stopListen();
					showBubbleRef.current({ text: "直接说话：关", kind: "it" });
					return;
				}
				// 气泡先出才去开麦：等权限要几百毫秒到几秒，先说「正在打开…」再改口。
				showBubbleRef.current({ text: "直接说话：正在打开…", kind: "it" });
				const ok = await startListen();
				setListenOn(ok);
				savePrefs({ listen: ok });
				if (!ok) stopListen();
				showBubbleRef.current({ text: ok ? "直接说话：开" : "直接说话：没打开", kind: ok ? "it" : "error" });
			};

			// ── 唤醒词：面板关着的时候常听一小段，听到「你好索罗」就开面板收话 ──
			//
			// 只用本机 KWS（wenetspeech 3.3M），16 kHz 分片送 `/api/orb/kws`；
			// 叫醒后先放掉麦克风，再走原来那套录音。设置里关掉就彻底不碰麦克风。
			// 开不成（模型没下、没麦克风权限、浏览器不让后台发音）要把原因说出来 ——
			// 静默失败时用户只会看到「唤醒词叫不醒」。

			const [wakeOn, setWakeOn] = useState(prefs.wake === true);
			const [wakeFail, setWakeFail] = useState("");
			const wakeRef = useRef(null);
			const wakeBusyRef = useRef(false);
			const wakeCheckedRef = useRef(0);

			const stopWake = () => {
				const state = wakeRef.current;
				if (state === null) return;
				wakeRef.current = null;
				try {
					state.node.disconnect();
					state.source.disconnect();
					state.mute.disconnect();
				} catch {
					// 已经断了就算了。
				}
				for (const track of state.stream.getTracks()) track.stop();
				void state.ctx.close().catch(() => {});
				void postKws(null, true).catch(() => {});
			};

			const startWake = async () => {
				if (wakeRef.current !== null || wakeBusyRef.current) return;
				// 失败也接着试：模型下载完、权限点过之后，下一拍就该听上（5 秒一次，别打麦克风）。
				if (Date.now() - wakeCheckedRef.current < 5_000) return;
				wakeBusyRef.current = true;
				wakeCheckedRef.current = Date.now();
				try {
					const status = await fetch("/api/orb/wake")
						.then((response) => response.json())
						.catch(() => null);
					if (status?.present !== true) {
						setWakeFail(status?.downloading === true ? "唤醒模型正在下载" : "唤醒模型还没下载");
						// 开着唤醒词却缺模型（换机器、上次没下完）：自己接着下，别等人去设置里点。
						if (status?.downloading !== true) void fetch("/api/orb/wake", { method: "POST" }).catch(() => undefined);
						return;
					}
					if (typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia === undefined) {
						setWakeFail("这个环境没有麦克风");
						return;
					}
					let stream;
					try {
						stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					} catch (error_) {
						const name = error_?.name;
						setWakeFail(
							name === "NotAllowedError" || name === "SecurityError"
								? "麦克风没权限"
								: name === "NotFoundError"
									? "没找到麦克风"
									: "麦克风打不开",
						);
						return;
					}
					const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
					// **48k 收**：AEC3 只吃 32k / 48k。它自己在输出侧降到 16k
					// （`sampleRateOut`），所以下面 `postKws` 那条 16k 链路一个字不用改。
					const ctx = new AudioCtx({ sampleRate: AEC_RATE });
					await ctx.resume().catch(() => undefined);
					// 没跑起来的 AudioContext 不会出声，也就永远收不到音频：说清楚，别假装在听。
					if (ctx.state !== "running") {
						for (const track of stream.getTracks()) track.stop();
						void ctx.close().catch(() => undefined);
						setWakeFail("浏览器没让后台听麦克风");
						return;
					}
					const source = ctx.createMediaStreamSource(stream);
					const node = ctx.createScriptProcessor(4096, 1, 1);
					const mute = ctx.createGain();
					mute.gain.value = 0;
					const state = { stream, ctx, node, source, mute, sending: false };
					node.onaudioprocess = (event) => {
						if (state.sending || wakeRef.current !== state) return;
						const input = event.inputBuffer.getChannelData(0);
						// 过一遍回声消除：它把喇叭里回来的自己压掉，顺带吐 16k。
						// 会话不在（没在念 / AEC 起不来）就是原样降采样 —— 不丢字。
						const session = echoRef.current;
						const copy = session === null ? downsample(input, AEC_RATE, TARGET_RATE) : session.process(input);
						if (copy.length === 0) return;
						state.sending = true;
						void postKws(copy, false)
							.then((data) => {
								state.sending = false;
								if (data?.hit === true && wakeRef.current === state) void woke();
							})
							.catch(() => {
								state.sending = false;
							});
					};
					source.connect(node);
					node.connect(mute);
					mute.connect(ctx.destination);
					wakeRef.current = state;
					setWakeFail("");
				} catch {
					setWakeFail("唤醒没开成");
				} finally {
					wakeBusyRef.current = false;
				}
			};

			const woke = async () => {
				stopWake();
				sayProblem("");
				await startRecording();
			};

			useEffect(() => {
				const tick = () => {
					const want = readPrefs().wake === true;
					setWakeOn(want);
					// 常驻听开着就不起唤醒词：两路都要麦克风，而常驻听已经把「直接说」做完了。
					if (want && !listenOn && !recording && !transcribing) void startWake();
					else stopWake();
				};
				const timer = window.setInterval(tick, 1500);
				tick();
				return () => {
					clearInterval(timer);
					stopWake();
				};
			}, [listenOn, recording, transcribing]);

			// 还没接模型时主界面在引导页；独立窗里照旧留着球，别让一扇透明窗空着。
			if (setupStep !== null && !WINDOW_MODE) return null;

			/* ── 气泡从头顶冒：说话、回话、出错，全走这一处 ────────────────
			   老板 2026-11-11：面板全砍，头顶是唯一的嘴。所以下面没有列表、没有输入框，
			   也没有「点开才看见」的东西 —— 有事直接冒一句，6 秒后自己淡。 */
			const bubbleShow = (next) => {
				if (next === null || String(next.text ?? "").trim() === "") return;
				if (bubbleTimer.current !== 0) {
					clearTimeout(bubbleTimer.current);
					bubbleTimer.current = 0;
				}
				setBubbleFading(false);
				setBubble({
					text: String(next.text),
					kind: next.kind ?? "it",
					who: next.who ?? (next.kind === "me" ? "你" : (assistant?.label ?? "助理")),
					wait: next.wait === true,
					// 每条都有一个新的序号：同样一句话再来一遍也要能重新触发排版和计时。
					id: bubbleSeq.current++,
				});
			};
			showBubbleRef.current = bubbleShow;

			/** 让它说一句（它自己的话也顺手念出来，念不念由朗读开关决定）。 */
			const sayBubble = (text, kind = "it", extra = null) => {
				bubbleShow({ text, kind, ...extra });
				if (kind !== "error" && text !== "") speakText(text);
			};

			/**
			 * 说一句「出问题了」：写进状态（球上那个红点读它），同时冒在头顶。
			 *
			 * 现在没有面板了，所有老的 `setError(...)` 调用点都走这里 —— 一处冒泡，不散在各处。
			 * 它不念：错是自己的错，念出来只会更吵。
			 */
			const sayProblem = (why) => {
				const line = String(why ?? "").trim();
				// 传空串 = 抹掉旧错（老的 `setError("")` 全是这个意思），但不要冒一个空气泡。
				if (line === "") {
					setErrorState("");
					return;
				}
				setErrorState(line);
				bubbleShow({ text: line, kind: "error" });
			};

			const bubbleHide = () => {
				if (bubbleTimer.current !== 0) {
					clearTimeout(bubbleTimer.current);
					bubbleTimer.current = 0;
				}
				setBubbleFading(true);
				bubbleTimer.current = window.setTimeout(() => {
					bubbleTimer.current = 0;
					setBubble(null);
					setBubbleFading(false);
				}, BUBBLE_FADE);
			};
			hideBubbleRef.current = bubbleHide;
			/** 重新计时：新的一句冒出 / 窗口尺寸变了，都从这一刻再数 6 秒。 */
			const bubbleHold = () => {
				if (bubbleTimer.current !== 0) clearTimeout(bubbleTimer.current);
				setBubbleFading(false);
				bubbleTimer.current = window.setTimeout(() => {
					bubbleTimer.current = 0;
					setBubbleFading(true);
					bubbleTimer.current = window.setTimeout(() => {
						bubbleTimer.current = 0;
						setBubble(null);
						setBubbleFading(false);
					}, BUBBLE_FADE);
				}, BUBBLE_HOLD);
			};

			/** 尾巴对着小人中心：气泡放哪都按这个算。 */
			const tailX = BALL / 2;

			/**
			 * 气泡放哪。
			 *
			 * 五级退让，跟原型里那版一致：
			 * 1. 小人右侧（尾巴挂在气泡左边）—— 空间够宽、又不压到人；
			 * 2. 小人左侧；
			 * 3. **头顶**：气泡在小人上方，尾巴挂底边对着头顶（老板要的「从头顶冒」就是这一档）；
			 * 4. 脚下：上面没地方就翻到下面；
			 * 5. 上下都不够才压矮自己：给一个 `maxHeight`，正文自己滚，**不截字**。
			 *
			 * 量的顺序很要紧：先把 `maxHeight` 清掉再量自然高度，否则量到的是上一轮的约束。
			 */
			const layoutBubble = () => {
				const node = bubbleRef.current;
				if (node === null) return;
				const edge = 8;
				const narrow = viewport.width < BUBBLE_MIN_W + 40;
				const width = narrow
					? Math.max(160, viewport.width - 24)
					: Math.min(BUBBLE_MAX_W, Math.max(BUBBLE_MIN_W, viewport.width - 96));
				node.style.maxHeight = "";
				node.style.width = `${String(width)}px`;
				const natural = node.offsetHeight;
				// 竖位：头顶优先，其次脚下。
				const aboveTop = orbTop - BUBBLE_GAP - natural;
				const belowTop = orbTop + BALL_H + BUBBLE_GAP;
				const fitsAbove = aboveTop >= edge;
				const fitsBelow = belowTop + natural <= viewport.height - edge;
				// 横位：气泡左右贴着小人，高度随便（顶对齐球）。
				const rightLeft = orbLeft + BALL + BUBBLE_GAP;
				const leftLeft = orbLeft - BUBBLE_GAP - width;
				const fitsRight = rightLeft + width <= viewport.width - edge;
				const fitsLeft = leftLeft >= edge;
				// 横位也要验纵向：气泡太高时贴着球会让它半截出窗。
				const besideFits = (left) => {
					const alignedTop = clamp(orbTop, edge, Math.max(edge, viewport.height - natural - edge));
					return alignedTop + natural <= viewport.height - edge && alignedTop >= edge && left >= edge;
				};

				let place = null;
				if (!narrow && fitsRight && besideFits(rightLeft)) {
					place = { left: rightLeft, top: clamp(orbTop, edge, Math.max(edge, viewport.height - natural - edge)), side: "right" };
				} else if (!narrow && fitsLeft && besideFits(leftLeft)) {
					place = { left: leftLeft, top: clamp(orbTop, edge, Math.max(edge, viewport.height - natural - edge)), side: "left" };
				} else if (fitsAbove) {
					place = { left: clamp(orbLeft + tailX - width / 2, edge, Math.max(edge, viewport.width - width - edge)), top: aboveTop, side: "above" };
				} else if (fitsBelow) {
					place = {
						left: clamp(orbLeft + tailX - width / 2, edge, Math.max(edge, viewport.width - width - edge)),
						top: belowTop,
						side: "below",
					};
				} else {
					// 上下都塞不下：挑空间大的那边，压矮。
					const roomAbove = orbTop - BUBBLE_GAP - edge;
					const roomBelow = viewport.height - edge - (orbTop + BALL_H + BUBBLE_GAP);
					const room = Math.max(96, Math.max(roomAbove, roomBelow));
					place =
						roomAbove >= roomBelow
							? { left: clamp(orbLeft + tailX - width / 2, edge, Math.max(edge, viewport.width - width - edge)), top: edge, side: "above", maxHeight: room }
							: {
									left: clamp(orbLeft + tailX - width / 2, edge, Math.max(edge, viewport.width - width - edge)),
									top: belowTop,
									side: "below",
									maxHeight: room,
								};
				}
				node.style.width = `${String(width)}px`;
				node.style.left = `${String(place.left - orbLeft)}px`;
				node.style.top = `${String(place.top - orbTop)}px`;
				node.setAttribute("data-side", place.side);
				if (place.maxHeight === undefined) node.style.maxHeight = "";
				else node.style.maxHeight = `${String(place.maxHeight)}px`;
				// 尾巴永远对着小人中心；贴顶 / 贴底被子元素裁掉时也还留在气泡上。
				const bubbleCenter = place.left + width / 2;
				node.style.setProperty("--bubble-tail-x", `${String(clamp(orbLeft + tailX - bubbleCenter + width / 2, 16, width - 16))}px`);
				node.style.visibility = "visible";
			};

			// 气泡跟着球走：球动、窗口变、文字换，都要重新摆一次。
			// 挪球时每帧一次 `setRight`，所以 `right` / `top` 变了就重排 —— 气泡才会一路跟手。
			useEffect(() => {
				if (bubble === null) return undefined;
				layoutBubble();
				const onResize = () => layoutBubble();
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, [bubble?.id, bubble?.text, right, top]);

			// 每条新的冒出：开始数那 6 秒。换一条就重新数。
			useEffect(() => {
				if (bubble === null) return undefined;
				bubbleHold();
				return undefined;
			}, [bubble?.id]);

			// 信箱里有一句就冒出来。挑消息的那段只往信箱里放，不直接 setState。
			useEffect(() => {
				const pending = bubblePendingRef.current;
				if (pending === null) return;
				bubblePendingRef.current = null;
				bubbleShow(pending);
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [shown, detail, liveDetail]);

			// 它自己的回复一冒出来就把「我在等」那句顶掉 —— 等的那一句只在没别的话好说时才在。
			useEffect(() => {
				if (bubble === null || bubble.wait !== true) return;
				if (messages.length === 0) return;
				const last = messages[messages.length - 1];
				if (last === undefined) return;
				if (last.text === bubble.text) return;
				sayBubble(last.text, "it");
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [messages, bubble?.id]);

			// 常驻听：开关打开就一直挂着；私聊还没建好、或者正在按键录音时先不起（两路抢麦克风）。
			useEffect(() => {
				const want = listenOn && dmId !== null && !recording;
				if (want && listenRef.current === null) void startListen();
				else if (!want && listenRef.current !== null) stopListen();
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [listenOn, dmId, recording]);

			// 「在听」那圈光的强弱：rms 很低很低，直接按比例放大到看得见。
			useEffect(() => {
				if (!listening) return undefined;
				const timer = window.setInterval(() => {
					setSayLevel(clamp(levelRef.current * 9, 0.12, 1));
				}, 120);
				return () => clearInterval(timer);
			}, [listening]);

			// 卸载：气泡的计时器也要收，别在卸掉的组件上 setState。
			useEffect(() => () => clearTimeout(bubbleTimer.current), []);

			const ball = h(
				"button",
				{
					type: "button",
					className: "orb-ball",
					id: "orb-ball",
					"aria-label": unread > 0 ? `助理（${String(unread)} 条未读）` : "助理",
					"aria-expanded": menu ? "true" : "false",
					onClick,
					onPointerDown,
					onPointerMove,
					onPointerUp,
					onPointerCancel: onPointerUp,
					onContextMenu,
					onPointerEnter: enter,
					onPointerLeave: leave,
				},
				busy ? h("span", { className: "orb-ring", "aria-hidden": "true" }) : null,
				// 在听：身边一圈随音量起伏的光。这是「不用点就能说」唯一需要的提示。
				listening
					? h("span", {
							className: "orb-listen",
							"aria-hidden": "true",
							style: { opacity: String(0.35 + sayLevel * 0.65), boxShadow: `0 0 0 ${String(2 + sayLevel * 3)}px var(--accent-dim)` },
						})
					: null,
				// 球面是一个站着的小人：不另画一颗渐变球。
				h("span", {
					className: "orb-mark",
					"data-view": look,
					"aria-hidden": "true",
					dangerouslySetInnerHTML: { __html: personSvg(80, look) },
				}),
				// 「没念出来」挂一个可见的红点：以前只写在悬停提示里，老板不看提示就永远不知道是哑的。
				speechProblem === "" ? null : h("span", { className: "orb-badge orb-alert", "aria-hidden": "true" }, "!"),
				unread > 0 ? h("span", { className: "orb-badge" }, unread > 99 ? "99+" : String(unread)) : null,
			);

			const menuBox = menu
				? h(
						"div",
						{
							className: "orb-menu",
							role: "menu",
							ref: menuRef,
							style: { ...menuPlace, width: "148px" },
							// 鼠标也可能直接从外面进菜单、不经过球：那时 `enter` 一次都没跑过，
							// 窗口还是穿透的。菜单自己再接一次命中。
							onPointerEnter: enter,
						},
						WINDOW_MODE
							? null
							: h(
									"button",
									{
										type: "button",
										role: "menuitem",
										"data-on": "false",
										disabled: dmId === null,
										onClick: () => {
											if (dmId === null) return;
											closeAll();
											void store.openChannel(dmId);
										},
									},
									"打开助理私聊",
								),
						h(
							"button",
							{
								type: "button",
								role: "menuitem",
								"data-on": listenOn ? "true" : "false",
								onClick: () => {
									setMenu(false);
									void toggleListen();
								},
							},
							listenOn ? "关掉「直接说话」" : "打开「直接说话」",
						),
						h(
							"button",
							{
								type: "button",
								role: "menuitem",
								"data-on": speakOn ? "true" : "false",
								onClick: () => {
									setMenu(false);
									toggleSpeak();
								},
							},
							speakOn ? "关掉朗读" : "打开朗读",
						),
						WINDOW_MODE
							? h(
									"button",
									{
										type: "button",
										role: "menuitem",
										onClick: () => {
											setMenu(false);
											closeAll();
											bridge()?.hide();
										},
									},
									"隐藏悬浮球",
								)
							: h(
									"button",
									{
										type: "button",
										role: "menuitem",
										"data-on": docked ? "true" : "false",
										onClick: toggleDock,
									},
									docked ? "从边上请出来" : "贴到右边收起",
								),
						h(
							"button",
							{
								type: "button",
								role: "menuitem",
								"data-on": "false",
								onClick: recenter,
							},
							"回到默认位置",
						),
					)
				: null;

			const bubbleBox =
				bubble === null
					? null
					: h(
							"div",
							{
								className: "orb-bubble",
								ref: bubbleRef,
								role: "status",
								"aria-live": "polite",
								"data-kind": bubble.kind,
								"data-fading": bubbleFading ? "true" : "false",
								onClick: () => {
									if (bubble.kind === "error") bubbleHide();
								},
								style: { visibility: "hidden", left: "0px", top: "0px" },
							},
							h("span", { className: "orb-bubble-who", "data-me": bubble.kind === "me" ? "true" : "false" }, bubble.who),
							bubble.wait === true
								? h("span", { className: "orb-bubble-wait", "aria-label": "等它回话" }, h("i"), h("i"), h("i"))
								: h("p", { className: "text" }, bubble.text),
						);

			return h(
				"div",
				{
					className: "orb",
					"data-docked": docked ? "true" : "false",
					"data-peek": peek ? "true" : "false",
					style: { right: `${String(right)}px`, top: `${String(top)}px` },
				},
				// 贴边热区：不画东西，只让窗口最右那 12px 点得到。
				docked && !menu ? h("div", { className: "orb-hit", "aria-hidden": "true" }) : null,
				bubbleBox,
				menuBox,
				ball,
			);
		}

		/** 设置里的一行：进「悬浮球语音」。 */
		function VoiceEntry() {
			const active = useStore((state) => state.pluginView === SLUG);
			return h(
				"button",
				{
					type: "button",
					className: "app-entry",
					id: "rail-orb-voice",
					"aria-label": "悬浮球语音",
					"aria-current": active ? "true" : "false",
					onClick: () => store.openPluginView(SLUG),
				},
				h(
					"svg",
					{
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 1.7,
						strokeLinecap: "round",
						strokeLinejoin: "round",
					},
					h("path", { d: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" }),
					h("path", { d: "M19 11a7 7 0 0 1-14 0" }),
					h("path", { d: "M12 18v3" }),
				),
			);
		}

		/**
		 * 一整页语音设置：朗读开关、音色、语速、模型。
		 *
		 * 音色列表后端 `GET /api/orb/voice` 一次给全（v1.1-zh 的 100 个中文音色），这里只负责挑。
		 * 挑完把**名字**写进本机（`localStorage["solo.orb"]`），面板下一句就照新的念。
		 */
		function VoicePage() {
			const inPanel = useStore((state) => state.rightPage === SLUG);
			const [status, setStatus] = useState(null);
			const [speech, setSpeech] = useState(null);
			const [wake, setWake] = useState(null);
			const [prefs, setPrefs] = useState(readPrefs);
			const [keyDraft, setKeyDraft] = useState("");
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState("");
			const pollRef = useRef(0);
			const wakePollRef = useRef(0);
			const playerRef = useRef(null);
			const speedTimer = useRef(0);

			const fetchStatus = async () => {
				try {
					const response = await fetch("/api/orb/voice");
					const data = await response.json();
					setStatus(data);
					return data;
				} catch {
					return null;
				}
			};

			const fetchWake = async () => {
				try {
					const response = await fetch("/api/orb/wake");
					const data = await response.json();
					setWake(data);
					return data;
				} catch {
					return null;
				}
			};

			const fetchSpeech = async () => {
				try {
					const response = await fetch("/api/orb/speech");
					const data = await response.json();
					if (typeof data?.error !== "string") setSpeech(data);
					return data;
				} catch {
					return null;
				}
			};

			const postSpeech = async (body) => {
				try {
					const response = await fetch("/api/orb/speech", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					});
					const data = await response.json();
					if (typeof data?.error === "string") {
						setNotice(data.error);
						return null;
					}
					setSpeech(data);
					setNotice("");
					return data;
				} catch {
					setNotice("没保存上，再试一次？");
					return null;
				}
			};

			const stopPreview = () => {
				const player = playerRef.current;
				playerRef.current = null;
				if (player !== null) {
					player.onended = null;
					player.onerror = null;
					player.pause();
				}
			};

			useEffect(() => {
				void fetchStatus();
				void fetchSpeech();
				void fetchWake();
			}, []);

			useEffect(
				() => () => {
					clearInterval(pollRef.current);
					clearInterval(wakePollRef.current);
					clearTimeout(speedTimer.current);
					pollRef.current = 0;
					wakePollRef.current = 0;
					speedTimer.current = 0;
					stopPreview();
				},
				[],
			);

			const set = (next) => {
				setPrefs((old) => ({ ...old, ...next }));
				savePrefs(next);
				setNotice("");
			};

			const download = async () => {
				setNotice("");
				try {
					const response = await fetch("/api/orb/voice", { method: "POST" });
					setStatus(await response.json());
				} catch {
					return;
				}
				if (pollRef.current !== 0) clearInterval(pollRef.current);
				pollRef.current = window.setInterval(() => {
					void fetchStatus().then((data) => {
						if (data === null || data.downloading !== true) {
							clearInterval(pollRef.current);
							pollRef.current = 0;
						}
					});
				}, 1000);
			};

			const downloadWake = async () => {
				setNotice("");
				try {
					const response = await fetch("/api/orb/wake", { method: "POST" });
					setWake(await response.json());
				} catch {
					return;
				}
				if (wakePollRef.current !== 0) clearInterval(wakePollRef.current);
				wakePollRef.current = window.setInterval(() => {
					void fetchWake().then((data) => {
						if (data === null || data.downloading !== true) {
							clearInterval(wakePollRef.current);
							wakePollRef.current = 0;
						}
					});
				}, 1000);
			};

			const preview = async () => {
				stopPreview();
				setNotice("");
				if (status !== null && status.present !== true) {
					setNotice("先把语音模型下载下来，才能出声。");
					return;
				}
				setBusy(true);
				try {
					const response = await fetch("/api/orb/speak", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							text: "你好，我是 Solo 的助理。换成这个音色，听起来怎么样？",
							speed: prefs.speed,
							voice: prefs.voice,
						}),
					});
					const data = await response.json().catch(() => ({}));
					if (data?.needModel === true) {
						setNotice("先把语音模型下载下来，才能出声。");
						void fetchStatus();
						return;
					}
					if (typeof data?.wav !== "string") {
						setNotice(typeof data?.error === "string" ? data.error : "没合成出来，再试一次？");
						return;
					}
					const player = new Audio(`data:audio/wav;base64,${data.wav}`);
					playerRef.current = player;
					player.onended = () => {
						playerRef.current = null;
					};
					await player.play();
				} catch (error) {
					setNotice(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			};

			const voices = status?.voices ?? [];
			const voice = status;
			const modelRow =
				voice === null
					? h("p", { className: "ov-note" }, "正在看模型…")
					: h(
							"div",
							{ className: "ov-row" },
							h(
								"div",
								{ className: "ov-row-main" },
								h(
									"b",
									null,
									voice.present === true
										? "已下载"
										: voice.downloading === true
											? `正在下载 ${String(Math.round((voice.progress ?? 0) * 100))}%`
											: "还没下载",
								),
								h(
									"span",
									null,
									`Kokoro-82M · 约 ${String(Math.round((voice.bytes ?? 0) / 1_048_576))} MB · 下到本机后离线可用`,
								),
							),
							voice.present === true || voice.downloading === true
								? null
								: h(
										"button",
										{ type: "button", className: "ov-btn", onClick: () => void download() },
										typeof voice.error === "string" && voice.error !== "" ? "重试" : "下载",
									),
						);

			return h(
				"section",
				{ className: "ov", "aria-label": "悬浮球语音" },
				h(
					"div",
					{ className: "ov-head", "data-host": inPanel ? "panel" : "modal" },
					inPanel
						? null
						: h(
								"button",
								{ type: "button", className: "ov-back", "aria-label": "回到设置", onClick: () => store.closePluginView() },
								h(
									"svg",
									{
										width: 18,
										height: 18,
										viewBox: "0 0 24 24",
										fill: "none",
										stroke: "currentColor",
										strokeWidth: 1.8,
										strokeLinecap: "round",
										strokeLinejoin: "round",
									},
									h("path", { d: "M15 6l-6 6 6 6" }),
								),
							),
					h(
						"div",
						null,
						h("h2", null, "悬浮球语音"),
						h("p", null, speech?.engine === "qwen" ? "听的是千问云端的声音，说的仍在本机转写" : "说的、听的都在本机"),
					),
				),
				h(
					"div",
					{ className: "ov-body" },
					h(
						"div",
						{ className: "ov-inner" },
						h(
							"div",
							{ className: "ov-sec" },
							h("h3", null, "播报引擎"),
							speech === null
								? h("p", { className: "ov-note" }, "正在读语音设置…")
								: h(
										"div",
										{ className: "ov-engines", role: "radiogroup", "aria-label": "播报引擎" },
										[
											["local", "本机 Kokoro", "离线 · 免费 · 8 个中文音色"],
											["qwen", "千问云端", "阿里云百炼 · 自然得多"],
										].map(([engine, label, note]) =>
											h(
												"button",
												{
													key: engine,
													type: "button",
													className: "ov-engine",
													role: "radio",
													"aria-checked": speech.engine === engine,
													"data-on": speech.engine === engine ? "true" : "false",
													onClick: () => void postSpeech({ engine }),
												},
												h("b", null, label),
												h("span", null, note),
											),
										),
									),
							speech?.engine === "qwen"
								? h(
										React.Fragment,
										null,
										h(
											"div",
											{ className: "ov-row" },
											h(
												"div",
												{ className: "ov-row-main" },
												h("b", null, speech.hasKey === true ? "API Key 已保存" : "填阿里云百炼 API Key"),
												h(
													"span",
													null,
													speech.hasKey === true
														? "留空不改；粘贴一串新的就会覆盖"
														: "在百炼控制台创建。Key 只存在本机，不进日志",
												),
											),
											h("input", {
												className: "ov-key",
												type: "password",
												value: keyDraft,
												"aria-label": "千问 API Key",
												placeholder: "sk-…",
												onChange: (event) => setKeyDraft(event.target.value),
											}),
											h(
												"button",
												{
													type: "button",
													className: "ov-btn",
													disabled: keyDraft.trim() === "",
													onClick: () =>
														void postSpeech({ apiKey: keyDraft }).then((data) => {
															if (data !== null) setKeyDraft("");
														}),
												},
												"保存",
											),
										),
										h(
											"div",
											{ className: "ov-row" },
											h(
												"div",
												{ className: "ov-row-main" },
												h("b", null, "音色"),
												h("span", null, "48 个系统音色，含方言"),
											),
											h(
												"select",
												{
													className: "ov-select",
													value: speech.qwenVoice,
													"aria-label": "千问音色",
													onChange: (event) => void postSpeech({ qwenVoice: event.target.value }),
												},
												h(
													"optgroup",
													{ label: "普通话与多语种" },
													speech.voices
														.filter((item) => item.group === "standard")
														.map((item) => h("option", { key: item.voice, value: item.voice }, item.label)),
												),
												h(
													"optgroup",
													{ label: "方言" },
													speech.voices
														.filter((item) => item.group === "dialect")
														.map((item) => h("option", { key: item.voice, value: item.voice }, item.label)),
												),
											),
										),
										h(
											"div",
											{ className: "ov-row" },
											h(
												"div",
												{ className: "ov-speed" },
												h("input", {
													type: "range",
													min: "0.5",
													max: "2",
													step: "0.1",
													value: speech.qwenSpeed,
													"aria-label": "千问语速",
													onChange: (event) => {
														const value = Number(event.target.value);
														setSpeech({ ...speech, qwenSpeed: value });
														clearTimeout(speedTimer.current);
														speedTimer.current = window.setTimeout(() => void postSpeech({ qwenSpeed: value }), 400);
													},
												}),
												h("b", null, `${speech.qwenSpeed.toFixed(1)}×`),
											),
											h(
												"button",
												{
													type: "button",
													className: "ov-btn",
													disabled: busy || speech.hasKey !== true,
													onClick: () => void preview(),
												},
												busy ? "合成中…" : "试听",
											),
										),
										speech.hasKey === true
											? null
											: h("p", { className: "ov-note" }, "填了 Key 才会出声。选了千问就不再回退本机。"),
									)
								: null,
						),
						h(
							"div",
							{ className: "ov-sec" },
							h("h3", null, "朗读"),
							h(
								"div",
								{ className: "ov-row" },
								h(
									"div",
									{ className: "ov-row-main" },
									h("b", null, "助理的回复自动念出来"),
									h("span", null, "面板打开着时，新回复一到就读；面板右上角的喇叭也能随时开关"),
								),
								h(
									"button",
									{
										type: "button",
										role: "switch",
										"aria-checked": prefs.speak,
										"aria-label": "朗读回复",
										className: "plugin-switch",
										"data-on": prefs.speak ? "true" : "false",
										onClick: () => set({ speak: !prefs.speak }),
									},
									h("span", { className: "knob" }),
								),
							),
						),
						speech?.engine === "qwen"
							? null
							: h(
							"div",
							{ className: "ov-sec" },
							h("h3", null, "音色"),
							voices.length === 0
								? h("p", { className: "ov-note" }, "正在读音色列表…")
								: h(
										"select",
										{
											className: "ov-voice-select",
											"aria-label": "音色",
											value: prefs.voice,
											onChange: (event) => set({ voice: event.target.value, voiceMigrated: true }),
										},
										h(
											"optgroup",
											{ label: "女声" },
											voices
												.filter((item) => item.name.startsWith("zf_"))
												.map((item) =>
													h(
														"option",
														{ key: item.name, value: item.name },
														item.note === "默认" ? item.label + "（默认）" : item.label,
													),
												),
										),
										h(
											"optgroup",
											{ label: "男声" },
											voices
												.filter((item) => item.name.startsWith("zm_"))
												.map((item) => h("option", { key: item.name, value: item.name }, item.label)),
										),
									),
							h("p", null, "Kokoro-82M 的中文音色，100 个。换一个不用重新下载模型，点完下一句就变；想先听就点下面的「试听」。"),
						),
						speech?.engine === "qwen"
							? null
							: h(
							"div",
							{ className: "ov-sec" },
							h("h3", null, "语速"),
							h(
								"div",
								{ className: "ov-row" },
								h(
									"div",
									{ className: "ov-speed" },
									h("input", {
										type: "range",
										min: "0.7",
										max: "1.5",
										step: "0.05",
										value: prefs.speed,
										"aria-label": "语速",
										onChange: (event) => set({ speed: Number(event.target.value) }),
									}),
									h("b", null, `${prefs.speed.toFixed(2)}×`),
								),
								h(
									"button",
									{ type: "button", className: "ov-btn", disabled: busy, onClick: () => void preview() },
									busy ? "合成中…" : "试听",
								),
							),
							notice === "" ? null : h("p", { className: "ov-note" }, notice),
						),
						speech?.engine === "qwen"
							? null
							: h(
							"div",
							{ className: "ov-sec" },
							h("h3", null, "语音模型"),
							modelRow,
							typeof voice?.error === "string" && voice.error !== ""
								? h("p", { className: "ov-note" }, `上次没下成：${voice.error}`)
								: null,
							// 老用户：v1.0 存的是数字 sid，v1.1 里那 8 个名字一个都没有，不能静默换人，
							// 所以这里请他重选一次。选完（或点「知道了」）就把 `voiceMigrated` 写进
							// localStorage，重启也不再弹。
							prefs.voiceMigrated === false
								? h(
										"div",
										{ className: "ov-banner", role: "status" },
										h("b", null, "音色换了一批，请重新选一次。"),
										h("span", null, "新版有 100 个中文音色，原来那 8 个声音这套模型里没有了。选完记住了，以后升级不会再变。"),
										h(
											"button",
											{ type: "button", className: "ov-btn", onClick: () => set({ voiceMigrated: true }) },
											"知道了",
										),
									)
								: null,
						),
						h(
							"div",
							{ className: "ov-sec" },
							h("h3", null, "唤醒词"),
							h(
								"div",
								{ className: "ov-row" },
								h(
									"div",
									{ className: "ov-row-main" },
									h("b", null, "说「你好索罗」叫醒"),
									h("span", null, "面板关着时常听一小段；叫醒后自动开面板收音。这个模型只认中文发音，「你好 Solo」念英文认不出"),
								),
								h(
									"button",
									{
										type: "button",
										role: "switch",
										"aria-checked": prefs.wake,
										"aria-label": "唤醒词",
										className: "plugin-switch",
										"data-on": prefs.wake ? "true" : "false",
										onClick: () => {
											const next = !prefs.wake;
											set({ wake: next });
											if (next && wake?.present !== true) void downloadWake();
										},
									},
									h("span", { className: "knob" }),
								),
							),
							wake === null
								? h("p", { className: "ov-note" }, "正在看唤醒模型…")
								: wake.present === true
									? h("p", { className: "ov-note" }, `唤醒模型已就绪（约 ${String(Math.round((wake.bytes ?? 0) / 1_048_576))} MB，本机运行）`)
									: h(
											"div",
											{ className: "ov-row" },
											h(
												"div",
												{ className: "ov-row-main" },
												h("b", null, wake.downloading === true ? `正在下载唤醒模型 ${String(Math.round((wake.progress ?? 0) * 100))}%` : "唤醒模型还没下载"),
												h("span", null, `约 ${String(Math.round((wake.bytes ?? 0) / 1_048_576))} MB · 本机识别，音频不出机器`),
											),
											wake.downloading === true
												? null
												: h("button", { type: "button", className: "ov-btn", onClick: () => void downloadWake() }, "下载"),
										),
							typeof wake?.error === "string" && wake.error !== "" ? h("p", { className: "ov-note" }, `上次没下成：${wake.error}`) : null,
						),
						h(
							"div",
							{ className: "ov-sec" },
							h(
								"p",
								{ className: "ov-note" },
								speech?.engine === "qwen"
									? "说的在本机转写；读的交给阿里云百炼（千问）。API Key 存在本机，合成的文字会发到阿里云。"
									: "全部在本机：转写用 macOS 26 自带的端侧模型，朗读用本地 Kokoro（Apache-2.0，可商用）。不接云端、不要 API key、音频不出本机。",
							),
						),
					),
				),
			);
		}

		// 桌面主窗口不画球（球在独立悬浮窗里，ADR-116）；设置里的入口两边都要有。
		if (ORB_MODE !== "none") ui.register("overlays", { id: "orb", component: Orb });
		ui.register("app.entry", { id: "entry", component: VoiceEntry });
		ui.register("app.page", { id: "page", label: "悬浮球语音", component: VoicePage });
	},
};
