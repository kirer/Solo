/**
 * 星海背景（Three.js）：低密度星点 + 极慢漂移 + 轻微指针视差。
 *
 * 用户原话：面板整体像 3D 悬浮、宇宙星河背景，但「别太复杂」。所以这里只有：
 * - 两层 Points（远 150 颗 / 近 62 颗，总共 212 个点、2 个 draw call），
 *   没有 bloom、没有星云体积光、没有粒子风暴、没有光照；
 * - 星点颜色只取 tokens 的中性色（--faint / --muted），透明度很低；
 * - 漂移是每秒 0.09° 的整体旋转，视差是跟着指针 3%  frustum 的位移。
 *
 * 导入即自挂载到 #stage-bg（ui/index.html 提供的挂载点），不需要参数：
 *   import "./starfield.js";
 *
 * 降级（任何一条满足就不创建 canvas，保留 .stage-bg 的静态渐变）：
 * - prefers-reduced-motion: reduce
 * - 视口 ≤ 860px（手机）
 * - 没有可用的 WebGL 上下文
 * 另外页面隐藏、窗口变窄、用户开启减少动效时会暂停渲染（不销毁，恢复即继续）。
 *
 * three.js 已 vendor 到 ui/vendor/three.module.js（r170），运行时不依赖 CDN。
 */
import * as THREE from "../vendor/three.module.js";

const HOST_ID = "stage-bg";
const MOBILE_MAX_WIDTH = 860;
const DPR_CAP = 1.5;
/** 星场范围（正交相机里 y ∈ [-1,1]，x 随宽高比展开；故意铺宽一点，超宽屏也满）。 */
const FIELD_X = 2.9;
const FIELD_Y = 1.35;
/** 每秒弧度：0.0016 rad/s ≈ 0.09°/s，一分钟才挪 5°。 */
const DRIFT_RAD_PER_SEC = 0.0016;
const PARALLAX_X = 0.045;
const PARALLAX_Y = 0.03;

const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`);

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

function readToken(name, fallback) {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value === "" ? fallback : value;
}

/** WebGL 可用性探测：失败 / 被禁用都只是「不启动」，不影响页面。 */
function supportsWebGL() {
	try {
		if (typeof window.WebGLRenderingContext === "undefined") return false;
		const probe = document.createElement("canvas");
		const context = probe.getContext("webgl2") ?? probe.getContext("webgl");
		if (context === null) return false;
		context.getExtension("WEBGL_lose_context")?.loseContext();
		return true;
	} catch {
		return false;
	}
}

/** 一层星点：位置固定，颜色用灰度顶点色，材质色从 token 读。 */
function makeCloud(spec) {
	const positions = new Float32Array(spec.count * 3);
	const colors = new Float32Array(spec.count * 3);
	for (let index = 0; index < spec.count; index += 1) {
		positions[index * 3] = (Math.random() * 2 - 1) * FIELD_X;
		positions[index * 3 + 1] = (Math.random() * 2 - 1) * FIELD_Y;
		positions[index * 3 + 2] = 0;
		const brightness =
			spec.darkest + Math.random() * (spec.brightest - spec.darkest);
		colors[index * 3] = brightness;
		colors[index * 3 + 1] = brightness;
		colors[index * 3 + 2] = brightness;
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
	const material = new THREE.PointsMaterial({
		size: spec.size,
		sizeAttenuation: false,
		transparent: true,
		opacity: spec.opacity,
		vertexColors: true,
		depthWrite: false,
		depthTest: false,
		blending: THREE.NormalBlending,
	});
	const points = new THREE.Points(geometry, material);
	points.frustumCulled = false;
	return points;
}

/**
 * 启动星海。重复调用返回同一个实例；降级时返回 null（不会抛错）。
 */
export function startStarfield() {
	if (window.__aicStarfield !== undefined) return window.__aicStarfield;
	const bail = () => {
		window.__aicStarfield = null;
		return null;
	};

	if (reducedMotionQuery.matches) return bail();
	if (mobileQuery.matches) return bail();
	if (!supportsWebGL()) return bail();

	const host = document.getElementById(HOST_ID);
	if (host === null) return bail();
	const stage = host.closest(".stage") ?? host.parentElement;
	if (stage === null) return bail();

	let renderer;
	try {
		renderer = new THREE.WebGLRenderer({
			alpha: true,
			antialias: false,
			powerPreference: "low-power",
		});
	} catch {
		return bail();
	}
	renderer.setClearColor(0x000000, 0);
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
	renderer.domElement.setAttribute("aria-hidden", "true");
	host.append(renderer.domElement);

	const scene = new THREE.Scene();
	const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
	camera.position.set(0, 0, 10);

	const group = new THREE.Group();
	const farCloud = makeCloud({ count: 150, size: 1.4, opacity: 0.48, darkest: 0.35, brightest: 1 });
	const nearCloud = makeCloud({ count: 62, size: 2.2, opacity: 0.64, darkest: 0.5, brightest: 1 });
	group.add(farCloud, nearCloud);
	scene.add(group);

	/** 素材颜色跟着主题走：深色主题亮星，浅色主题是纸上的一点墨。 */
	function paint() {
		farCloud.material.color.setStyle(readToken("--faint", "#7b8490"));
		nearCloud.material.color.setStyle(readToken("--muted", "#9098a4"));
	}
	paint();

	// ── 尺寸 ──────────────────────────────────────────────────────────────
	/**
	 * 把 #stage-bg 固定到 .stage 的矩形上。
	 *
	 * 不能用 `inset: 0`：.stage 不是定位容器，fixed 会铺满视口、盖到对话面板上；
	 * 这里显式写行内 left/top/width/height，只覆盖组织图所在的舞台。
	 */
	function layout() {
		const rect = stage.getBoundingClientRect();
		host.style.left = `${Math.round(rect.left)}px`;
		host.style.top = `${Math.round(rect.top)}px`;
		host.style.width = `${Math.round(rect.width)}px`;
		host.style.height = `${Math.round(rect.height)}px`;
		return {
			width: Math.max(1, Math.round(rect.width || stage.clientWidth)),
			height: Math.max(1, Math.round(rect.height || stage.clientHeight)),
		};
	}

	function resize() {
		const { width, height } = layout();
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
		// updateStyle=false：布局尺寸交给 CSS（.stage-bg canvas { width/height:100% }）
		renderer.setSize(width, height, false);
		const aspect = width / height;
		camera.left = -aspect;
		camera.right = aspect;
		camera.top = 1;
		camera.bottom = -1;
		camera.updateProjectionMatrix();
	}
	resize();

	// ── 指针视差 ──────────────────────────────────────────────────────────
	const pointer = { x: 0, y: 0 };

	function onPointerMove(event) {
		const halfWidth = window.innerWidth / 2 || 1;
		const halfHeight = window.innerHeight / 2 || 1;
		pointer.x = clamp((event.clientX - halfWidth) / halfWidth, -1, 1);
		pointer.y = -clamp((event.clientY - halfHeight) / halfHeight, -1, 1);
	}

	function resetPointer() {
		pointer.x = 0;
		pointer.y = 0;
	}

	document.addEventListener("pointermove", onPointerMove, { passive: true });
	document.addEventListener("pointerleave", resetPointer, { passive: true });
	window.addEventListener("blur", resetPointer);

	// ── 渲染循环 ──────────────────────────────────────────────────────────
	let running = false;
	let lastTime = 0;
	let elapsed = 0;
	let frames = 0;
	let renderMs = 0;
	let disposed = false;

	function frame(time) {
		const now = Number.isFinite(time) ? time : performance.now();
		if (lastTime === 0) lastTime = now;
		// 切回前台时 dt 可能很大，夹住避免星场瞬移
		const delta = clamp((now - lastTime) / 1000, 0, 0.05);
		lastTime = now;
		elapsed += delta;

		const ease = 1 - Math.exp(-delta * 2.5);
		camera.position.x += (pointer.x * PARALLAX_X - camera.position.x) * ease;
		camera.position.y += (pointer.y * PARALLAX_Y - camera.position.y) * ease;
		group.rotation.z = elapsed * DRIFT_RAD_PER_SEC;
		// 近层再多挪一点，两层之间才有深度差
		nearCloud.position.x = -pointer.x * 0.02;
		nearCloud.position.y = -pointer.y * 0.012;

		const startedAt = performance.now();
		renderer.render(scene, camera);
		const cost = performance.now() - startedAt;
		renderMs = renderMs === 0 ? cost : renderMs * 0.9 + cost * 0.1;
		frames += 1;
	}

	function shouldRun() {
		return (
			!disposed &&
			!document.hidden &&
			!mobileQuery.matches &&
			!reducedMotionQuery.matches &&
			stage.clientWidth > 0 &&
			stage.clientHeight > 0
		);
	}

	function sync() {
		if (disposed) return;
		const next = shouldRun();
		if (next === running) return;
		running = next;
		if (running) {
			lastTime = 0;
			renderer.setAnimationLoop(frame);
			host.classList.add("is-live");
		} else {
			renderer.setAnimationLoop(null);
			host.classList.remove("is-live");
		}
	}

	function onResize() {
		resize();
		sync();
	}

	const resizeObserver =
		typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
	resizeObserver?.observe(stage);
	window.addEventListener("resize", onResize);
	document.addEventListener("visibilitychange", sync);
	mobileQuery.addEventListener("change", sync);
	reducedMotionQuery.addEventListener("change", sync);

	// 主题切换时重取 token（浅色下星星要变成纸上墨点）
	const themeObserver =
		typeof MutationObserver === "function"
			? new MutationObserver(() => paint())
			: null;
	themeObserver?.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme", "data-resolved"],
	});

	renderer.domElement.addEventListener("webglcontextlost", (event) => {
		event.preventDefault();
		running = false;
		renderer.setAnimationLoop(null);
		host.classList.remove("is-live");
	});

	function destroy() {
		if (disposed) return;
		disposed = true;
		running = false;
		renderer.setAnimationLoop(null);
		resizeObserver?.disconnect();
		themeObserver?.disconnect();
		window.removeEventListener("resize", onResize);
		document.removeEventListener("visibilitychange", sync);
		document.removeEventListener("pointermove", onPointerMove);
		document.removeEventListener("pointerleave", resetPointer);
		window.removeEventListener("blur", resetPointer);
		mobileQuery.removeEventListener("change", sync);
		reducedMotionQuery.removeEventListener("change", sync);
		for (const cloud of [farCloud, nearCloud]) {
			cloud.geometry.dispose();
			cloud.material.dispose();
			cloud.dispose();
		}
		renderer.dispose();
		renderer.domElement.remove();
		host.classList.remove("is-live");
	}

	const controller = {
		get running() {
			return running;
		},
		get frames() {
			return frames;
		},
		get renderMs() {
			return renderMs;
		},
		/** 当前帧的 draw call 数（2：远层 + 近层）。 */
		get drawCalls() {
			return renderer.info.render.calls;
		},
		get starCount() {
			return (
				farCloud.geometry.attributes.position.count +
				nearCloud.geometry.attributes.position.count
			);
		},
		pause() {
			if (disposed || !running) return;
			running = false;
			renderer.setAnimationLoop(null);
			host.classList.remove("is-live");
		},
		resume() {
			sync();
		},
		destroy,
	};

	window.__aicStarfield = controller;
	sync();
	return controller;
}

// 导入即挂载：不需要调用方传参数。降级时静默返回 null。
startStarfield();
