/**
 * 正文里点到的那个文件：右栏推入的一层（不是弹窗 —— 和插件页同一叠纸）。
 *
 * 读的是 `GET /api/files/preview?path=…`，**按响应的 Content-Type 决定怎么画**，
 * 不看扩展名：后端已经把 HTML / SVG 降成纯文本、把认不出的格式回成 415。
 * 认不出的、没有的、太大的，都把它那句话原样摆出来 —— 一个路径不该变成死链接。
 */
import { useEffect, useState } from "react";
import { filePreviewUrl, stageFile } from "../api/client.ts";
import { stageToComposer } from "../state/store.ts";

type State =
	| { readonly kind: "loading" }
	| { readonly kind: "image" | "pdf"; readonly url: string }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "note"; readonly text: string; readonly error: boolean };

export function FilePreview(props: { readonly path: string }): JSX.Element {
	const [state, setState] = useState<State>({ kind: "loading" });
	/** 「转成附件」的状态：空闲 / 转着 / 上一次失败的那句话。 */
	const [staging, setStaging] = useState<{ readonly busy: boolean; readonly error: string }>({ busy: false, error: "" });

	useEffect(() => {
		let live = true;
		let objectUrl: string | undefined;
		setState({ kind: "loading" });
		fetch(filePreviewUrl(props.path))
			.then(async (response) => {
				const type = response.headers.get("content-type") ?? "";
				if (!response.ok) {
					// 404 / 415 都是后端写好的中文原因（找不到 / 这种格式不支持预览）。
					const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
					const text = typeof payload.error === "string" ? payload.error : `读不了这个文件（${String(response.status)}）`;
					if (live) setState({ kind: "note", text, error: true });
					return;
				}
				if (type.startsWith("image/") || type === "application/pdf") {
					const blob = await response.blob();
					objectUrl = URL.createObjectURL(blob);
					if (live) setState({ kind: type.startsWith("image/") ? "image" : "pdf", url: objectUrl });
					return;
				}
				const text = await response.text();
				if (live) setState({ kind: "text", text });
			})
			.catch((error: unknown) => {
				const text = error instanceof Error ? error.message : String(error);
				if (live) setState({ kind: "note", text, error: true });
			});
		return () => {
			live = false;
			if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
		};
	}, [props.path]);

	return (
		<div className="fp" aria-label={props.path}>
			<p className="fp-path mono">{props.path}</p>
			{/* 路径 → 附件（老板 2026-11-10）：点了就进输入卡的队列，可以发到任何频道。
			    能不能转由后端说了算 —— 它是一个普通附件，和手选上传的没区别。 */}
			<div className="fp-actions">
				<button
					type="button"
					className="fp-stage"
					disabled={staging.busy || state.kind === "note"}
					onClick={() => {
						if (staging.busy) return;
						setStaging({ busy: true, error: "" });
						stageFile(props.path)
							.then((uploaded) => {
								setStaging({ busy: false, error: "" });
								stageToComposer({ path: props.path, id: uploaded.id, name: uploaded.name, kind: uploaded.kind, bytes: uploaded.bytes });
							})
							.catch((error: unknown) => {
								const text = error instanceof Error ? error.message : String(error);
								setStaging({ busy: false, error: text });
							});
					}}
				>
					{staging.busy ? "转成附件…" : "转成附件发出去"}
				</button>
				{staging.error === "" ? null : <span className="fp-stage-note">{staging.error}</span>}
			</div>
			{state.kind === "loading" ? <p className="fp-note">读文件…</p> : null}
			{state.kind === "note" ? <p className="fp-note" data-error={state.error ? "true" : "false"}>{state.text}</p> : null}
			{state.kind === "image" ? <img className="fp-image" src={state.url} alt={props.path} /> : null}
			{state.kind === "pdf" ? <iframe className="fp-pdf" src={state.url} title={props.path} sandbox="" /> : null}
			{state.kind === "text" ? <pre className="fp-text">{state.text}</pre> : null}
		</div>
	);
}
