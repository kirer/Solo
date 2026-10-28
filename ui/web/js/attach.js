/**
 * 附件：上传、待发送队列、以及消息里怎么画。
 *
 * 为什么单独一个文件：这件事的核心不是「一个按钮」，是**三处一致**——
 * 上传时算的 `kind`、队列里画的样子、消息里最终画的样子，必须是同一套判断，
 * 否则会出现「选的时候是图片、发出去变成一个文件行」这种怪事。所以判断只在
 * `kindOfFile` 一处，队列和消息共用 `attachChip` / `attachThumbs`。
 *
 * 与后端的分工：`kind` 与 `mime` 由服务端按真实内容重算（`src/core/shell/uploads.ts`），
 * 这里算的一份只为**上传前**画预览。客户端说了不算，这是故意的。
 */

/** 上传上限，与 `src/core/shell/uploads.ts` 的 `UPLOAD_MAX_BYTES` 对齐（前端先拦一道，省一次白跑）。 */
export const MAX_BYTES = 25 * 1024 * 1024;
/** 一条消息最多几个，与 `UPLOAD_PER_MESSAGE` 对齐。 */
export const MAX_PER_MESSAGE = 10;

/** 能内联显示的图片类型（不含 SVG：SVG 能跑脚本，一律按文件处理）。 */
const INLINE_IMAGE = /^image\/(png|jpeg|webp|gif|avif|bmp)$/;

/** 由 File 判断类别。与服务端同一条正则。 */
export function kindOfFile(file) {
	return INLINE_IMAGE.test(String(file?.type ?? "")) ? "image" : "file";
}

/** 人看的大小。1 位小数就够，再多是噪音。 */
export function humanBytes(bytes) {
	const value = Number(bytes);
	if (!Number.isFinite(value) || value <= 0) return "0 B";
	if (value < 1024) return `${Math.round(value)} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
	return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** 文件名截断：中间省略，保留扩展名 —— 「报告-关…v2.pdf」比「报告-关于…」有用。 */
export function shortName(name, max = 28) {
	const text = String(name ?? "");
	if ([...text].length <= max) return text;
	const dot = text.lastIndexOf(".");
	const keep = max - 1;
	if (dot <= 0 || text.length - dot > 8) return `${[...text].slice(0, keep).join("")}…`;
	const ext = text.slice(dot);
	const head = [...text.slice(0, dot)].slice(0, keep - ext.length).join("");
	return `${head}…${ext}`;
}

function escape(text) {
	return String(text ?? "").replace(
		/[&<>"']/g,
		(one) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[one],
	);
}

/** 文件图标：按扩展名分三种（文档 / 压缩 / 其它），不用 emoji。 */
const FILE_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.8H4.6A1.6 1.6 0 0 0 3 3.4v9.2A1.6 1.6 0 0 0 4.6 14.2h6.8a1.6 1.6 0 0 0 1.6-1.6V5.8z"/><path d="M9 1.8v4h4"/></svg>`;

/** 一个文件的 chip（消息里与队列里共用）。 */
export function attachChip(item) {
	return `<a class="attach-file" href="/api/uploads/${encodeURIComponent(item.id)}?download=1" download="${escape(
		item.name,
	)}" target="_blank" rel="noreferrer"><span class="attach-ico">${FILE_ICON}</span><span class="attach-name">${escape(
		shortName(item.name),
	)}</span><span class="attach-size">${humanBytes(item.bytes)}</span></a>`;
}

/** 图片缩略图（消息里用：点击开灯箱，所以是 button）。 */
export function attachThumbs(list) {
	return `<div class="attach-grid" data-count="${Math.min(list.length, 4)}">${list
		.map(
			(item) =>
				`<button class="attach-thumb" type="button" data-lightbox="/api/uploads/${encodeURIComponent(
					item.id,
				)}" title="${escape(item.name)}"><img src="/api/uploads/${encodeURIComponent(
					item.id,
				)}" alt="${escape(item.name)}" loading="lazy" decoding="async" /></button>`,
		)
		.join("")}</div>`;
}

/** 一条消息的全部附件（图片在前，文件在后 —— 图先被看见）。 */
export function attachmentsHtml(attachments) {
	const list = Array.isArray(attachments) ? attachments.filter((item) => item?.id) : [];
	if (list.length === 0) return "";
	const images = list.filter((item) => item.kind === "image");
	const files = list.filter((item) => item.kind !== "image");
	return `${images.length > 0 ? attachThumbs(images) : ""}${
		files.length > 0 ? `<div class="attach-files">${files.map(attachChip).join("")}</div>` : ""
	}`;
}

/**
 * 上传一个文件。返回 `{ id, name, kind, bytes }`；失败抛中文错误。
 *
 * 用 `x-filename` 头传名字（头部是 latin-1，中文要先编码，服务端会解一次），
 * body 直接是文件本身 —— 不走 multipart，那需要一个几百行的解析器。
 */
export async function uploadOne(file, { onProgress } = {}) {
	if (file.size > MAX_BYTES) throw new Error(`「${shortName(file.name, 16)}」超过 25MB`);
	const response = await fetch("/api/uploads", {
		method: "POST",
		headers: {
			"content-type": file.type || "application/octet-stream",
			"x-filename": encodeURIComponent(file.name || "附件"),
		},
		body: file,
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(body?.error ?? `上传失败（${response.status}）`);
	}
	const saved = await response.json();
	onProgress?.(1);
	return saved;
}

/** 从粘贴/拖拽事件里捞出文件。`items` 只在 paste 上有，`files` 覆盖两边。 */
export function filesOf(event) {
	const out = [];
	const items = event?.clipboardData?.items ?? event?.dataTransfer?.items ?? [];
	for (const item of items) {
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (file) out.push(file);
	}
	if (out.length > 0) return out;
	for (const file of event?.dataTransfer?.files ?? []) out.push(file);
	return out;
}

/** 队列里的一项画成什么。`state: "uploading" | "done" | "error"`。 */
export function queueItemHtml(item, index) {
	const preview =
		item.kind === "image" && item.preview !== undefined
			? `<img src="${item.preview}" alt="" />`
			: `<span class="attach-ico">${FILE_ICON}</span>`;
	return `<div class="q-item" data-index="${index}" data-state="${item.state}">
	<span class="q-preview">${preview}${item.state === "uploading" ? '<span class="q-bar"></span>' : ""}</span>
	<span class="q-meta"><span class="q-name">${escape(shortName(item.name))}</span><span class="q-size">${
		item.state === "uploading" ? "上传中…" : item.state === "error" ? "失败" : humanBytes(item.bytes)
	}</span></span>
	<button class="q-x" type="button" data-drop="${index}" title="移除" aria-label="移除 ${escape(item.name)}">✕</button>
</div>`;
}
