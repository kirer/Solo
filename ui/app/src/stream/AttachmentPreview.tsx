/**
 * 附件预览：非图片的附件点开看一眼，而不是只能下载。
 *
 * 能内联的：图片（`<img>`）、PDF（`<iframe>`）、文本（`<pre>`，代码按语言标出来）。
 * 其余老实说「这种格式不支持预览，点下载」—— 把一个 zip 读成字符串只会给出一屏乱码，
 * 假装能预览比不给预览更糟。
 *
 * 判断**看响应头**，不看文件名：文件名是用户起的，`a.txt` 可以是任何东西；服务端
 * 已经按**真实 mime** 决定发什么 `Content-Type`（HTML 永远降成 `text/plain`）。
 * 那一层是唯一的判据，这里只负责把三类画出来。
 */
import { useEffect, useState } from "react";
import type { Attachment } from "../api/types.ts";
import { uploadUrl } from "../api/client.ts";

/** 代码附件按文件名的后缀标个语言名；认不出的照旧按纯文本读，只是不带标。 */
const CODE_LANG: readonly (readonly [string, string])[] = [
	["ts", "TypeScript"], ["tsx", "TypeScript"], ["js", "JavaScript"], ["jsx", "JavaScript"],
	["mjs", "JavaScript"], ["cjs", "JavaScript"], ["json", "JSON"], ["jsonl", "JSON Lines"],
	["md", "Markdown"], ["markdown", "Markdown"], ["css", "CSS"], ["html", "HTML"], ["htm", "HTML"],
	["py", "Python"], ["sh", "Shell"], ["bash", "Shell"], ["zsh", "Shell"], ["sql", "SQL"],
	["yml", "YAML"], ["yaml", "YAML"], ["toml", "TOML"], ["xml", "XML"], ["csv", "CSV"], ["tsv", "TSV"],
	["rs", "Rust"], ["go", "Go"], ["java", "Java"], ["c", "C"], ["h", "C"], ["cpp", "C++"], ["rb", "Ruby"],
];

/** 文本附件有上限：一次读一整个 25 MB 的日志会把界面卡死，超过就不预览了。 */
const TEXT_LIMIT = 1024 * 1024;

export function langOf(name: string): string {
	const dot = name.lastIndexOf(".");
	const ext = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
	for (const [key, label] of CODE_LANG) if (key === ext) return label;
	return "";
}

type State =
	| { readonly kind: "loading" }
	| { readonly kind: "image" | "pdf"; readonly url: string }
	| { readonly kind: "text"; readonly text: string; readonly cut: boolean }
	| { readonly kind: "none" }
	| { readonly kind: "error"; readonly text: string };

export function AttachmentPreview(props: {
	readonly file: Attachment | null;
	readonly onClose: () => void;
}): JSX.Element | null {
	const { file, onClose } = props;
	const [state, setState] = useState<State>({ kind: "loading" });

	useEffect(() => {
		if (file === null) return undefined;
		setState({ kind: "loading" });
		let live = true;
		let objectUrl: string | undefined;
		fetch(`${uploadUrl(file.id)}?preview=1`)
			.then(async (response) => {
				const type = response.headers.get("content-type") ?? "";
				if (type.startsWith("image/") || type === "application/pdf") {
					const blob = await response.blob();
					objectUrl = URL.createObjectURL(blob);
					if (live) setState({ kind: type.startsWith("image/") ? "image" : "pdf", url: objectUrl });
					return;
				}
				if (type.startsWith("text/")) {
					// 响应头里有长度就先看一眼：超过上限不去读，免得界面卡在这里。
					const size = Number(response.headers.get("content-length") ?? "0");
					const truncated = size > TEXT_LIMIT;
					const text = truncated ? (await response.text()).slice(0, TEXT_LIMIT) : await response.text();
					if (live) setState({ kind: "text", text, cut: truncated });
					return;
				}
				if (live) setState({ kind: "none" });
			})
			.catch((error: unknown) => {
				if (live) setState({ kind: "error", text: error instanceof Error ? error.message : String(error) });
			});
		return () => {
			live = false;
			if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
		};
	}, [file]);

	useEffect(() => {
		if (file === null) return undefined;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [file, onClose]);

	if (file === null) return null;
	return (
		<div className="lightbox attach-view" role="dialog" aria-modal="true" aria-label={file.name} onClick={onClose}>
			<div className="attach-view-body" onClick={(event) => event.stopPropagation()}>
				<div className="attach-view-head">
					<span className="attach-view-name">{file.name}</span>
					<a className="attach-view-dl" href={`${uploadUrl(file.id)}?download=1`} download={file.name}>
						下载
					</a>
				</div>
				{state.kind === "loading" ? <div className="attach-view-note">读文件…</div> : null}
				{state.kind === "image" ? <img src={state.url} alt={file.name} /> : null}
				{state.kind === "pdf" ? <iframe src={state.url} title={file.name} sandbox="" /> : null}
				{state.kind === "text" ? (
					<>
						{langOf(file.name) === "" ? null : (
							<div className="attach-view-lang mono">{langOf(file.name)}</div>
						)}
						<pre className="attach-view-text">{state.text}</pre>
						{state.cut ? <div className="attach-view-note">文件太大，只显示前 1 MB，完整内容请下载。</div> : null}
					</>
				) : null}
				{state.kind === "none" ? (
					<div className="attach-view-note">
						这种格式不支持预览（{file.name.split(".").pop() ?? "未知"}），点上面的「下载」到本地打开。
					</div>
				) : null}
				{state.kind === "error" ? <div className="attach-view-note">{state.text}</div> : null}
			</div>
		</div>
	);
}
