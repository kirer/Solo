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
const BALL = 46;
/** 拖过右缘多近算「贴边」。 */
const DOCK_AT = 12;
/**
 * 球长在哪（`ui/app/src/main.tsx` 写在 `<html data-orb>` 上）：
 * - `inline`：浏览器，球浮在页面里（原来的样子）；
 * - `window`：桌面壳的独立透明窗，坐标固定，拖球 = 挪整扇窗；
 * - `none`：桌面主窗口，不画球（球只在一处，ADR-116）。
 */
const ORB_MODE = typeof document === "undefined" ? "inline" : (document.documentElement.dataset.orb ?? "inline");
const WINDOW_MODE = ORB_MODE === "window";

/** 默认音色：Kokoro 的 `zf_xiaoxiao`；中文音色就 45–52 这八个。 */
const DEFAULT_SID = 47;
const VOICE_IDS = [45, 46, 47, 48, 49, 50, 51, 52];

/** 位置、贴边、朗读开关与音色记在本机：换个屏幕再打开，还是你上次的那一套。 */
function readPrefs() {
	const fallback = { right: 18, top: null, docked: false, speak: false, wake: false, sid: DEFAULT_SID, speed: 1 };
	try {
		const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PREF_KEY);
		if (raw === null) return fallback;
		const value = JSON.parse(raw);
		return {
			right: Number.isFinite(value?.right) ? value.right : 18,
			top: Number.isFinite(value?.top) ? value.top : null,
			docked: value?.docked === true,
			speak: value?.speak === true,
			wake: value?.wake === true,
			sid: VOICE_IDS.includes(value?.sid) ? value.sid : DEFAULT_SID,
			speed: Number.isFinite(value?.speed) ? clamp(value.speed, 0.7, 1.5) : 1,
		};
	} catch {
		return fallback;
	}
}

function savePrefs(next) {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(PREF_KEY, JSON.stringify({ ...readPrefs(), ...next }));
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
		/* 球面就是应用的标识（S + 蓝点，与窗口图标同形）。深底固定：
		   桌面壁纸什么颜色都认得出来，也一眼看出是 Solo 而不是一颗渐变球。 */
		.orb-ball {
			--rail-mark-bg: #20242b;
			--rail-mark-ink: #f2e3c9;
			--rail-mark-dot: #93aece;
			--rail-mark-line: rgb(255 255 255 / 0.08);
			pointer-events: auto;
			position: relative;
			display: grid; place-items: center;
			width: 46px; height: 46px; padding: 0;
			border: 0; border-radius: 13px;
			background: transparent;
			box-shadow: 0 12px 30px rgb(0 0 0 / 0.32), 0 2px 8px rgb(0 0 0 / 0.18);
			cursor: grab; touch-action: none;
			transition: transform 160ms ease, box-shadow 160ms ease;
		}
		.orb-ball:hover { transform: scale(1.05); box-shadow: 0 16px 36px rgb(0 0 0 / 0.36), 0 2px 8px rgb(0 0 0 / 0.2); }
		.orb-ball:active { cursor: grabbing; }
		.orb[data-open="true"] .orb-ball { cursor: pointer; }
		/* 贴边：只留一条边。悬停滑出来，松手不动它就还回去 —— 和 dsh 那颗球一个意思。 */
		.orb[data-docked="true"] .orb-ball { transform: translateX(34px); }
		.orb[data-docked="true"] .orb-ball:hover { transform: none; }

		/* 标识填满球面；SVG 自己带圆角底，按钮只负责阴影与命中。 */
		.orb-mark { display: block; width: 46px; height: 46px; border-radius: 13px; overflow: hidden; }
		.orb-mark svg { display: block; width: 100%; height: 100%; }
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
		.orb-badge {
			position: absolute; top: -3px; right: -3px;
			min-width: 17px; height: 17px; padding: 0 4px;
			border-radius: 999px; box-sizing: border-box;
			background: var(--accent-solid); color: var(--on-accent);
			font-size: 10px; line-height: 17px; font-weight: 600;
			font-variant-numeric: tabular-nums; text-align: center;
		}

		.orb-panel {
			pointer-events: auto;
			position: absolute;
			display: flex; flex-direction: column;
			width: min(320px, calc(100vw - 84px));
			max-height: min(480px, calc(100dvh - 32px));
			background: var(--ground);
			border: 0.5px solid var(--line);
			border-radius: 16px;
			box-shadow: var(--shadow, 0 18px 48px rgb(0 0 0 / 0.22));
			overflow: hidden;
			animation: orb-in 140ms ease;
		}
		@keyframes orb-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
		@media (prefers-reduced-motion: reduce) {
			.orb-ball, .orb-panel, .orb-ring, .orb-icon[data-rec="true"] { transition: none; animation: none; }
		}

		.orb-head {
			display: flex; flex: none; align-items: center; gap: 8px;
			padding: 10px 12px; border-bottom: 0.5px solid var(--rule);
		}
		/* 面板抬头的小标识：主题色跟着纸走（和助理头像同一份），干活时一圈微光。 */
		.orb-face { flex: none; display: grid; place-items: center; width: 22px; height: 22px; }
		.orb-face svg { display: block; }
		.orb-face[data-busy="true"] { filter: drop-shadow(0 0 5px var(--accent)); }
		.orb-who { display: flex; flex-direction: column; min-width: 0; }
		.orb-who b { font-size: 12.5px; line-height: 17px; font-weight: 600; color: var(--ink); }
		.orb-who span { font-size: 11px; line-height: 15px; color: var(--ink-3); }
		.orb-grow { flex: 1 1 auto; }
		.orb-ghost {
			flex: none; height: 26px; padding: 0 9px;
			border: 0; border-radius: 8px; background: transparent;
			color: var(--ink-3); font: inherit; font-size: 11.5px; cursor: pointer;
		}
		.orb-ghost:hover { background: var(--hover); color: var(--ink); }

		.orb-list {
			flex: 1 1 auto; min-height: 60px; overflow: auto;
			display: flex; flex-direction: column; gap: 10px;
			padding: 10px 12px;
		}
		.orb-msg { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
		.orb-msg[data-me="true"] { align-items: flex-end; }
		.orb-from { font-size: 10.5px; line-height: 14px; color: var(--ink-3); }
		.orb-text {
			margin: 0; max-width: 100%; max-height: 132px; overflow: auto;
			padding: 6px 9px; border-radius: 10px;
			background: var(--field); border: 0.5px solid var(--rule);
			color: var(--ink-2); font-size: 12.5px; line-height: 19px;
			white-space: pre-wrap; word-break: break-word;
		}
		.orb-msg[data-me="true"] .orb-text { background: var(--accent-dim); border-color: transparent; color: var(--ink); }
		.orb-empty { margin: auto; padding: 18px; color: var(--ink-3); font-size: 12px; line-height: 19px; text-align: center; }
		.orb-error { margin: 0; padding: 0 12px 8px; color: var(--danger); font-size: 11.5px; line-height: 16px; }
		.orb-model {
			display: flex; align-items: center; gap: 8px;
			margin: 0 12px 8px; padding: 7px 9px;
			background: var(--hover); border-radius: 9px;
			color: var(--ink-2); font-size: 11.5px; line-height: 16px;
		}
		.orb-model span { flex: 1; min-width: 0; }
		.orb-model button {
			flex: none; padding: 3px 9px;
			border: 0; border-radius: 7px; background: var(--accent); color: #fff;
			font: inherit; font-size: 11.5px; cursor: pointer;
		}

		.orb-form {
			display: flex; flex: none; align-items: flex-end; gap: 8px;
			padding: 9px 10px; border-top: 0.5px solid var(--rule);
		}
		.orb-input {
			flex: 1 1 auto; min-width: 0;
			min-height: 32px; max-height: 92px; resize: none;
			padding: 7px 9px; box-sizing: border-box;
			border: 0.5px solid var(--control); border-radius: 10px;
			background: var(--field); color: var(--ink);
			font: inherit; font-size: 12.5px; line-height: 18px;
		}
		.orb-input:focus { outline: none; border-color: var(--accent); }
		.orb-send {
			flex: none; height: 32px; padding: 0 12px;
			border: 0; border-radius: 9px;
			background: var(--accent-solid); color: var(--on-accent);
			font: inherit; font-size: 12.5px; cursor: pointer;
		}
		.orb-send:disabled { opacity: 0.45; cursor: default; }
		/* 语音：麦克风与朗读都是面板里的小方块，和输入框同一行高。 */
		.orb-icon {
			display: grid; place-items: center; flex: none;
			width: 32px; height: 32px; padding: 0;
			border: 0.5px solid var(--control); border-radius: 9px;
			background: var(--field); color: var(--ink-3);
			cursor: pointer; touch-action: manipulation;
		}
		.orb-icon:hover { color: var(--ink); }
		.orb-icon:disabled { opacity: 0.45; cursor: default; }
		.orb-icon[data-rec="true"] {
			color: var(--on-accent); background: var(--accent-solid); border-color: transparent;
			animation: orb-rec 1.2s ease-in-out infinite;
		}
		@keyframes orb-rec { 50% { box-shadow: 0 0 0 4px var(--accent-dim); } }
		.orb-sound { display: grid; place-items: center; width: 26px; padding: 0; }
		.orb-sound[aria-pressed="true"] { color: var(--accent); }
		.orb-voice {
			display: flex; flex: none; align-items: center; gap: 6px;
			margin: 0; padding: 7px 12px 0;
			color: var(--ink-3); font-size: 11px; line-height: 15px;
		}
		.orb-voice[data-live="true"] { color: var(--accent); }
		.orb-voice b { font-weight: 600; font-variant-numeric: tabular-nums; }

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
		const { h, React, api, store, useStore, brandMarkSvg } = ui;
		const { useEffect, useRef, useState } = React;

		/** 独立窗的桥（`desktop/src/orb-preload.cts`）；浏览器里没有，调用全是 no-op。 */
		const bridge = () => (typeof window === "undefined" ? undefined : window.soloOrb);

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
			const [open, setOpen] = useState(false);
			const [pinned, setPinned] = useState(false);
			const [menu, setMenu] = useState(false);
			const [draft, setDraft] = useState("");
			const [detail, setDetail] = useState(null);
			const [error, setError] = useState("");
			const [sending, setSending] = useState(false);
			const [speakOn, setSpeakOn] = useState(prefs.speak === true);
			const [recording, setRecording] = useState(false);
			const [elapsed, setElapsed] = useState(0);
			const [transcribing, setTranscribing] = useState(false);
			/** 本地语音模型的状态（`GET /api/orb/voice`）：没下就显示一行下载。 */
			const [voice, setVoice] = useState(null);

			const drag = useRef(null);
			const skipClick = useRef(false);
			const hoverTimer = useRef(0);
			/** 离开球 / 面板后晚一点再关命中，别在两者之间挪动时漏掉点击。 */
			const passTimer = useRef(0);
			const listRef = useRef(null);
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
			const voicePollRef = useRef(0);
			/** 面板开着没有：只决定「报错往哪儿写」，不再决定「念不念」。 */
			const openRef = useRef(false);

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
				speakingRef.current = false;
				const player = audioRef.current;
				audioRef.current = null;
				if (player !== null) {
					player.onended = null;
					player.onerror = null;
					player.pause();
				}
			};

			/**
			 * 念不出来就说出来：面板开着写进面板，收着就攒着，下次打开补在显眼处。
			 * 以前这些分支全是 `return` —— 用户只看到「开关是开的」，别的什么都没有。
			 */
			const reportSpeech = (why) => {
				const line = `没念出来：${why}`;
				speechProblemRef.current = line;
				if (openRef.current) setError(line);
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
				reportSpeech(`${why}（音频没能播放，检查系统输出设备）`);
			};

			const playNext = () => {
				const next = queueRef.current.shift();
				if (next === undefined) {
					speakingRef.current = false;
					audioRef.current = null;
					return;
				}
				const player = new Audio(`data:audio/wav;base64,${next}`);
				audioRef.current = player;
				speakingRef.current = true;
				player.onended = playNext;
				player.onerror = () => speechFailed((player.error?.message ?? "") || "解码失败");
				void player.play().catch((error_) => {
					// NotAllowedError = 浏览器不给自动放（没有用户手势）：这也要说出来，
					// 否则「开关开着却没有声音」又变成一件只能猜的事。
					speechFailed(error_ instanceof Error ? error_.message : String(error_));
				});
			};

			/** 本地神经音色念一句：切成小片合成，第一片先出声。 */
			const speakText = async (raw) => {
				const text = plainText(raw).slice(0, 1200);
				if (text === "") return;
				// 音色与语速每次现读：设置里刚改完，下一句就照新的念，不用重开面板。
				const prefs = readPrefs();
				for (const piece of splitSpeech(text)) {
					try {
						const response = await fetch("/api/orb/speak", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ text: piece, speed: prefs.speed, sid: prefs.sid }),
						});
						const data = await response.json().catch(() => ({}));
						// 面板收着也照样念：以前这里 `if (!openRef.current) return`，
						// 合成回来时面板刚收起，这一片就静默丢了 —— 老板听到的「开关开着没声音」。
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

			openRef.current = open;

			// 正在看的这条私聊：直接吃 store（SSE 在推）；别的频道才用自己拉的那份。
			const shown = currentId === dmId ? liveDetail : detail;
			const messages = (shown?.messages ?? []).filter((message) => message.kind === "chat").slice(-14);
			const activity = assistant?.activity;
			const busy = activity !== undefined;
			const unread = dm?.unread ?? 0;

			// 面板跟着球走，但整块留在窗口里：球在右边时面板在左，球挪到中间 / 左边
			// 就换到右边，两边都不够就贴边（375 宽下会盖住球，球画在后面，仍点得到）。
			const viewport =
				typeof window === "undefined" ? { width: 375, height: 812 } : { width: window.innerWidth, height: window.innerHeight };
			const panelWidth = Math.min(320, viewport.width - 84);
			const panelHeight = Math.min(480, viewport.height - 32);
			const orbLeft = viewport.width - right - BALL;
			const place = (width, height) => {
				const gap = 8;
				let left = orbLeft - gap - width;
				if (left < 8) left = orbLeft + BALL + gap;
				left = clamp(left, 8, Math.max(8, viewport.width - width - 8));
				const placedTop = clamp(top, 8, Math.max(8, viewport.height - height - 8));
				return { left: `${String(left - orbLeft)}px`, top: `${String(placedTop - top)}px` };
			};
			const panelPlace = place(panelWidth, panelHeight);
			const menuPlace = place(148, 148);

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

			const closeAll = () => {
				cancelHover();
				// 收起面板：正在录的丢掉（麦克风不能让它在后台开着），
				// 但**正在念的不掐**——面板收起也要念完（老板 2026-11-09 定的）。
				const recorder = recorderRef.current;
				if (recorder !== null && recorder.state !== "inactive") {
					cancelledRef.current = true;
					recorder.stop();
				}
				setOpen(false);
				setPinned(false);
				setMenu(false);
			};

			// 补私聊消息：正在看这条私聊时 store 已经在推，不用再拉。
			//
			// **收起面板也照拉**（老板 2026-11-10）：这个开关叫「收着也要念」，可收起时恰恰
			// 没人拉私聊，最该响的时候一声不响。面板收起 = 老板在干别的，才更需要被叫。
			useEffect(() => {
				if (dmId === null || currentId === dmId) return undefined;
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

			// 新消息来了滚到底 —— 和聊天区同一条规矩：打开着才追。
			useEffect(() => {
				const node = listRef.current;
				if (open && node !== null) node.scrollTop = node.scrollHeight;
			}, [open, messages.length, dmId]);

			// 面板收起也接着念（老板 2026-11-09：收着也要念）。念不出来时攒在
			// `speechProblemRef` 里，下次打开面板补一句——收着的时候没人看得见，但话不能丢。
			useEffect(() => {
				if (!open) return;
				const problem = speechProblemRef.current;
				if (problem !== "") setError(problem);
			}, [open]);

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
				const bySeq = new Map();
				for (const message of [...inDm, ...named]) bySeq.set(message.seq, message);
				const chats = [...bySeq.values()];
				if (!primedRef.current) {
					for (const message of chats) spokenRef.current.add(message.seq);
					primedRef.current = true;
					return;
				}
				const fresh = chats.filter((message) => !spokenRef.current.has(message.seq));
				for (const message of chats) spokenRef.current.add(message.seq);
				// 只看开关，不看面板开没开：以前这里是 `if (!speakOn || !open) return`，
				// 面板收着（默认状态）就等于「朗读开着却一句都不念」，而且一点痕迹都不留。
				// 网页版（inline）不后台念：那一屏可能根本没在看，出声会打扰；桌面独立窗才念。
				if (!speakOn || ORB_MODE === "inline") return;
				for (const message of fresh) void speakText(message.text);
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [shown, speakOn, open, assistant, detail, liveDetail]);

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

			// Esc 收起；菜单开着时先收菜单。
			useEffect(() => {
				if (!open && !menu) return undefined;
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					const recorder = recorderRef.current;
					if (recorder !== null && recorder.state !== "inactive") {
						// 录音中按 Esc = 取消这段，不关面板。
						cancelledRef.current = true;
						recorder.stop();
						return;
					}
					if (menu) setMenu(false);
					else closeAll();
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [open, menu]);

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

			const enter = () => {
				cancelHover();
				holdInteractive(true);
				if (docked || drag.current !== null) return;
				hoverTimer.current = window.setTimeout(() => setOpen(true), 160);
			};

			const leave = () => {
				cancelHover();
				// 拖着的时候别把命中关掉，不然拖到一半窗口就点不动了。
				if (drag.current === null) holdInteractive(false);
				if (pinned || drag.current !== null) return;
				hoverTimer.current = window.setTimeout(() => {
					setOpen(false);
					setMenu(false);
				}, 320);
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
					setOpen(false);
					setPinned(false);
					return;
				}
				const nextDocked = state.lastRight < DOCK_AT;
				setDocked(nextDocked);
				if (nextDocked) setRight(0);
				savePrefs({ right: nextDocked ? 0 : state.lastRight, top: state.lastTop, docked: nextDocked });
				setOpen(false);
				setPinned(false);
			};

			const onClick = () => {
				if (skipClick.current) {
					skipClick.current = false;
					return;
				}
				// 刚点开时别让上一轮悬停留下的「移开就收」把它合上。
				cancelHover();
				if (docked) {
					// 贴着边点一下 = 把它请出来，并钉住。
					setDocked(false);
					savePrefs({ right: 18, top, docked: false });
					setRight(18);
					setOpen(true);
					setPinned(true);
					return;
				}
				if (pinned) {
					setPinned(false);
					setOpen(false);
					return;
				}
				setPinned(true);
				setOpen(true);
			};

			const onContextMenu = (event) => {
				event.preventDefault();
				cancelHover();
				setOpen(true);
				setPinned(true);
				setMenu(true);
			};

			const toggleDock = () => {
				const next = !docked;
				setDocked(next);
				if (next) setRight(0);
				savePrefs({ right: next ? 0 : right, top, docked: next });
				setMenu(false);
				if (next) {
					setOpen(false);
					setPinned(false);
				}
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
				setError("");
				try {
					await api.sendMessage(dmId, { text: value });
					setDraft("");
					if (currentId !== dmId) {
						const next = await api.getChannel(dmId, 20).catch(() => null);
						if (next !== null) setDetail(next);
					}
				} catch (error_) {
					setError(`没发出去：${error_ instanceof Error ? error_.message : String(error_)}`);
				} finally {
					setSending(false);
				}
			};

			const send = async () => {
				if (sending) return;
				await sendText(draft);
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
					setError("太短了，没听清");
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
				setTranscribing(true);
				setError("");
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
						setError(data.error);
						return;
					}
					const text = typeof data?.text === "string" ? data.text.trim() : "";
					if (text === "") {
						setError("没听清，再说一次？");
						return;
					}
					await sendText(text);
				} catch (error_) {
					setError(`没转成：${error_ instanceof Error ? error_.message : String(error_)}`);
				} finally {
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
					setError("助理私聊还没建好");
					return;
				}
				if (recording || transcribing) return;
				if (typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia === undefined) {
					setError("这个环境不支持录音");
					return;
				}
				setError("");
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
					setError(
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
					const ctx = new AudioCtx({ sampleRate: 16_000 });
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
						const copy = new Float32Array(input.length);
						copy.set(input);
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
				setOpen(true);
				setPinned(true);
				setError("");
				await new Promise((resolve) => window.setTimeout(resolve, 160));
				await startRecording();
			};

			useEffect(() => {
				const tick = () => {
					const want = readPrefs().wake === true;
					setWakeOn(want);
					if (want && !open && !recording && !transcribing) void startWake();
					else stopWake();
				};
				const timer = window.setInterval(tick, 1500);
				tick();
				return () => {
					clearInterval(timer);
					stopWake();
				};
			}, [open, recording, transcribing]);

			// 还没接模型时主界面在引导页；独立窗里照旧留着球，别让一扇透明窗空着。
			if (setupStep !== null && !WINDOW_MODE) return null;

			const ball = h(
				"button",
				{
					type: "button",
					className: "orb-ball",
					id: "orb-ball",
					"aria-label": unread > 0 ? `助理（${String(unread)} 条未读）` : "助理",
					"aria-expanded": open,
					"data-tip":
						wakeOn && wakeFail === ""
							? "说「你好索罗」叫醒，或点一下"
							: wakeOn
								? `唤醒没开成：${wakeFail}`
								: "跟助理说一句",
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
				// 球面就是应用标识（同一份 SVG）：不另画一颗渐变球。
				h("span", {
					className: "orb-mark",
					"aria-hidden": "true",
					dangerouslySetInnerHTML: { __html: brandMarkSvg(46) },
				}),
				unread > 0 ? h("span", { className: "orb-badge" }, unread > 99 ? "99+" : String(unread)) : null,
			);

			const menuBox = menu
				? h(
						"div",
						{ className: "orb-menu", role: "menu", ref: menuRef, style: { ...menuPlace, width: "148px" } },
						WINDOW_MODE
							? null
							: h(
									"button",
									{
										type: "button",
										role: "menuitem",
										disabled: dmId === null,
										onClick: () => {
											if (dmId === null) return;
											closeAll();
											void store.openChannel(dmId);
										},
									},
									"打开助理私聊",
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
							: h("button", { type: "button", role: "menuitem", onClick: toggleDock }, docked ? "从边上请出来" : "贴到右边收起"),
						h("button", { type: "button", role: "menuitem", onClick: recenter }, "回到默认位置"),
					)
				: null;

			const panel = open
				? h(
						"section",
						{
							className: "orb-panel",
							role: "dialog",
							"aria-label": "助理",
							style: { ...panelPlace, width: `${String(panelWidth)}px`, maxHeight: `${String(panelHeight)}px` },
							onPointerEnter: enter,
							onPointerLeave: leave,
						},
						h(
							"header",
							{ className: "orb-head" },
							h("span", {
							className: "orb-face",
							"data-busy": busy ? "true" : "false",
							"aria-hidden": "true",
							dangerouslySetInnerHTML: { __html: brandMarkSvg(22) },
						}),
							h(
								"div",
								{ className: "orb-who" },
								h("b", null, assistant?.label ?? "助理"),
								h("span", null, activity === undefined ? "待命" : activity.state === "thinking" ? "在想" : "正在干活"),
							),
							h("span", { className: "orb-grow" }),
							h(
								"button",
								{
									type: "button",
									className: "orb-ghost orb-sound",
									"aria-pressed": speakOn,
									"aria-label": speakOn ? "关掉朗读" : "朗读回复",
									title: speakOn ? "关掉朗读" : "朗读回复",
									onClick: toggleSpeak,
								},
								speakerIcon(speakOn),
							),
							// 独立窗里没有「主界面」可切，这颗键留着只会点了没反应。
							dmId === null || WINDOW_MODE
								? null
								: h(
										"button",
										{
											type: "button",
											className: "orb-ghost",
											onClick: () => {
												closeAll();
												void store.openChannel(dmId);
											},
										},
										"打开",
									),
						),
						h(
							"div",
							{ className: "orb-list", ref: listRef },
							messages.length === 0
								? h(
										"p",
										{ className: "orb-empty" },
										dmId === null
											? "助理私聊还没建好 —— 打开一次助理就会建。"
											: "还没说过话。想到什么，直接说。",
									)
								: messages.map((message) =>
										h(
											"div",
											{ key: message.seq, className: "orb-msg", "data-me": message.fromSlug === "owner" ? "true" : "false" },
											h("span", { className: "orb-from" }, `${message.fromLabel} · ${ago(message.at)}`),
											h("p", { className: "orb-text" }, message.text),
										),
									),
						),
						recording || transcribing
							? h(
									"p",
									{ className: "orb-voice", "data-live": recording ? "true" : "false" },
									recording
										? `在听… ${String(Math.floor(elapsed / 60))}:${String(elapsed % 60).padStart(2, "0")} · 点麦克风结束`
										: "转写中…",
								)
							: null,
						voice !== null && voice.present !== true
							? h(
									"div",
									{ className: "orb-model" },
									h(
										"span",
										null,
										voice.downloading === true
											? `正在下载语音模型 ${String(Math.round((voice.progress ?? 0) * 100))}%`
											: typeof voice.error === "string" && voice.error !== ""
												? `语音模型没下成：${voice.error}`
												: `语音模型还没下载（约 ${String(Math.round((voice.bytes ?? 0) / 1_048_576))} MB）`,
									),
									voice.downloading === true
										? null
										: h(
												"button",
												{ type: "button", onClick: () => void downloadVoice() },
												typeof voice.error === "string" && voice.error !== "" ? "重试" : "下载",
											),
								)
							: null,
						error === "" ? null : h("p", { className: "orb-error" }, error),
						h(
							"div",
							{ className: "orb-form" },
							h("textarea", {
								className: "orb-input",
								rows: 1,
								placeholder: dmId === null ? "助理还没准备好" : "跟助理说一句…",
								value: draft,
								disabled: dmId === null,
								onChange: (event) => setDraft(event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										void send();
									}
								},
							}),
							h(
								"button",
								{
									type: "button",
									className: "orb-icon",
									"data-rec": recording ? "true" : "false",
									disabled: dmId === null || transcribing,
									"aria-label": recording ? "结束录音" : "语音输入",
									title: recording ? "结束并发送" : transcribing ? "转写中…" : "点一下说话",
									onClick: () => (recording ? stopRecording(false) : void startRecording()),
								},
								recording ? stopIcon() : micIcon(),
							),
							h(
								"button",
								{
									type: "button",
									className: "orb-send",
									disabled: dmId === null || sending || transcribing || draft.trim() === "",
									onClick: () => void send(),
								},
								sending ? "…" : "发送",
							),
						),
					)
				: null;

			return h(
				"div",
				{
					className: "orb",
					"data-docked": docked ? "true" : "false",
					"data-open": open ? "true" : "false",
					style: { right: `${String(right)}px`, top: `${String(top)}px` },
				},
				panel,
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
					"data-tip": "悬浮球语音",
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
		 * 音色就是 Kokoro 的 speaker id；后端 `GET /api/orb/voice` 把八个中文音色一并给出来，
		 * 这里只负责挑。挑完写进本机（`localStorage["solo.orb"]`），面板下一句就照新的念。
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
							sid: prefs.sid,
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
										"div",
										{ className: "ov-voices", role: "radiogroup", "aria-label": "音色" },
										voices.map((item) =>
											h(
												"button",
												{
													key: item.id,
													type: "button",
													className: "ov-voice",
													role: "radio",
													"aria-checked": prefs.sid === item.id,
													"data-on": prefs.sid === item.id ? "true" : "false",
													onClick: () => set({ sid: item.id }),
												},
												h("b", null, item.label),
												h("span", null, item.note),
											),
										),
									),
							h("p", null, "Kokoro-82M 的中文音色，八个。换一个不用重新下载模型。"),
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
