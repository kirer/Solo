/**
 * 附件预览：非图片的附件点开看一眼，而不是只能下载。
 *
 * 三种能内联的：图片（`<img>`）、PDF（`<iframe>`）、文本（`<pre>`）。其余老实说
 * 「不能预览，点下载」—— 把一个 zip 读成字符串只会给出一屏乱码。
 *
 * 判断**看响应头**，不看文件名：文件名是用户起的，`a.txt` 可以是任何东西；服务端
 * 已经按**真实 mime** 决定发什么 `Content-Type`（HTML 永远降成 `text/plain`）。
 */
import { useEffect, useState } from "react";
import type { Attachment } from "../api/types.ts";
import { uploadUrl } from "../api/client.ts";

type State =
	| { readonly kind: "loading" }
	| { readonly kind: "image" | "pdf"; readonly url: string }
	| { readonly kind: "text"; readonly text: string }
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
					const text = await response.text();
					if (live) setState({ kind: "text", text });
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
				{state.kind === "text" ? <pre className="attach-view-text">{state.text}</pre> : null}
				{state.kind === "none" ? <div className="attach-view-note">这个文件不能预览，点上面的「下载」。</div> : null}
				{state.kind === "error" ? <div className="attach-view-note">{state.text}</div> : null}
			</div>
		</div>
	);
}
