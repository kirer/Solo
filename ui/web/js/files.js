/**
 * 右栏的「文件」页：读工作区，只读。
 *
 * 三件事必须由后端说了算，这里一律不猜：
 *   1. **能看什么** —— 路径越界由 `/api/files` 拦（403），前端不做字符串判断；
 *   2. **是不是文本** —— 后端读前 4KB 看有没有 NUL，二进制只报大小，不硬转成乱码；
 *   3. **有多大** —— 超过 200KB 不往回传，只显示大小。
 *
 * 所以这个文件里没有一个 `fs`、没有一个 `..`，只有「把 JSON 画出来」。
 * 唯一的本地状态是「当前在哪一层」和「正在看哪个文件」—— 刷新就回到根目录。
 */
import { escapeHtml } from "./format.js";

const ICON_DIR =
	'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 4.6c0-.6.5-1.1 1.1-1.1h2.6l1.2 1.4h5.4c.6 0 1.1.5 1.1 1.1v6c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1z"/></svg>';
const ICON_FILE =
	'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 1.9H4.4c-.6 0-1.1.5-1.1 1.1v10c0 .6.5 1.1 1.1 1.1h7.2c.6 0 1.1-.5 1.1-1.1V5.2z"/><path d="M9.2 1.9v3.3h3.5"/></svg>';

const TEXT_EXT = new Set(["md", "txt", "ts", "js", "json", "css", "html", "yml", "yaml", "mjs", "tsx", "sh"]);

function bytesLabel(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function extOf(name) {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function crumbHtml(path) {
	const parts = path === "" ? [] : path.split("/");
	const trail = ['<button class="file-crumb" type="button" data-file-go="">工作区</button>'];
	parts.forEach((part, index) => {
		const to = parts.slice(0, index + 1).join("/");
		trail.push('<span class="file-slash">/</span>');
		trail.push(`<button class="file-crumb" type="button" data-file-go="${escapeHtml(to)}">${escapeHtml(part)}</button>`);
	});
	return trail.join("");
}

/**
 * 挂载到右栏的 `#files-body`。返回 `{ reload }`。
 *
 * @param {HTMLElement} host
 * @param {{ load: (path: string) => Promise<any>, onToast?: (text: string, tone?: string) => void }} options
 */
export function mountFiles(host, options) {
	let path = "";
	let busy = false;

	function headHtml(chrome) {
		const back =
			chrome.parent === null
				? ""
				: '<button class="file-back" type="button" data-file-go="' +
					escapeHtml(chrome.parent) +
					'" title="上一层" aria-label="上一层">↑</button>';
		return `<div class="file-head">${back}<div class="file-path">${crumbHtml(chrome.path)}</div></div>`;
	}

	function renderDirectory(data) {
		const rows = data.entries
			.map((entry, index) => {
				const icon = entry.kind === "dir" ? ICON_DIR : ICON_FILE;
				const size = entry.kind === "dir" ? "" : bytesLabel(entry.bytes);
				// `--i` 只喂给 CSS 的 animation-delay：一行一行落下来，一眼看得出「这是刚加载的」。
				return `<button class="file-row" type="button" data-file="${
					entry.kind === "dir" ? "go" : "open"
				}" data-path="${escapeHtml(data.path === "" ? entry.name : `${data.path}/${entry.name}`)}" style="--i:${index}">
					<span class="file-ico${entry.kind === "dir" ? " is-dir" : ""}${entry.kind === "file" && TEXT_EXT.has(extOf(entry.name)) ? " is-text" : ""}">${icon}</span>
					<span class="file-name">${escapeHtml(entry.name)}</span>
					<span class="file-size">${size}</span>
				</button>`;
			})
			.join("");
		const empty = data.entries.length === 0 ? '<p class="file-empty">这个文件夹是空的。</p>' : "";
		host.innerHTML = `${headHtml(data)}<div class="file-list">${rows}${empty}</div>`;
	}

	function renderFile(data, from) {
		const file = data.file ?? {};
		const body = file.binary
			? `<p class="file-empty">这是二进制文件（${bytesLabel(file.bytes ?? 0)}），这里只能看文本。</p>`
			: `<pre class="file-text">${escapeHtml(file.text ?? "")}</pre>`;
		host.innerHTML = `${headHtml(data)}<div class="file-view"><div class="file-view-head"><b>${escapeHtml(
			file.name ?? "",
		)}</b><span class="file-size">${bytesLabel(file.bytes ?? 0)}</span></div>${body}</div>`;
		host.dataset.from = from;
	}

	async function show(next) {
		if (busy) return;
		busy = true;
		host.dataset.state = "loading";
		try {
			const data = await options.load(next);
			path = data.path ?? next;
			if (data.file !== undefined) renderFile(data, next);
			else renderDirectory(data);
			host.dataset.state = "ready";
		} catch (error) {
			host.dataset.state = "error";
			const text = error instanceof Error ? error.message : String(error);
			host.innerHTML = `<div class="file-head"><div class="file-path">${crumbHtml(path)}</div></div><p class="file-empty">读不到：${escapeHtml(text)}</p>`;
			options.onToast?.(`读不到文件：${text}`, "error");
		} finally {
			busy = false;
		}
	}

	host.addEventListener("click", (event) => {
		const target = /** @type {HTMLElement | null} */ (event.target instanceof Element ? event.target.closest("[data-file-go],[data-file]") : null);
		if (target === null) return;
		const go = target.dataset.fileGo;
		if (go !== undefined) {
			void show(go);
			return;
		}
		// 目录与文件都只是「看下一层」：后端按 stat 结果决定返回列表还是内容。
		void show(target.dataset.path ?? "");
	});

	return {
		reload: () => show(path),
	};
}
