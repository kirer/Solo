/**
 * 输入卡。
 *
 * 一件事：**把我打的字变成一条消息**。所有花活（拖拽、粘贴、@ 弹层、附件队列）
 * 都是这条主线的旁支，任何一个出错都不许让「发送」失效 —— 所以发送路径上
 * 没有异步准备，附件先传完再允许发（在传的过程中按钮就是灰的）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getMentionable, uploadFile } from "../api/client.ts";
import type { Uploaded } from "../api/types.ts";
import { avatarSvg } from "../lib/avatar.ts";
import { humanBytes } from "../lib/format.ts";
import { send, setReply } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PER_MESSAGE = 10;

type Draft = {
	key: string;
	name: string;
	kind: "image" | "file";
	preview: string;
	state: "uploading" | "done" | "error";
	uploaded?: Uploaded;
	error?: string;
};

type Candidate = { id: number; label: string; slug: string; title: string };

export function Composer(props: { toast: (text: string, tone?: "info" | "error") => void }): JSX.Element {
	const currentId = useStore((state) => state.currentId);
	const reply = useStore((state) => state.reply);

	const [text, setText] = useState("");
	const [drafts, setDrafts] = useState<Draft[]>([]);
	const [menu, setMenu] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [mention, setMention] = useState<{ at: number; query: string } | null>(null);
	const [candidates, setCandidates] = useState<Candidate[]>([]);
	const [pick, setPick] = useState(0);

	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const dragDepth = useRef(0);

	const uploading = drafts.some((draft) => draft.state === "uploading");
	const canSend = (text.trim() !== "" || drafts.some((draft) => draft.state === "done")) && !uploading;

	/* 自增高：先归零再量，否则 textarea 只会越撑越高。 */
	useEffect(() => {
		const input = inputRef.current;
		if (input === null) return;
		input.style.height = "auto";
		input.style.height = `${String(Math.min(input.scrollHeight, 200))}px`;
	}, [text]);

	/* @ 弹层：只在这个频道里能被叫醒的人。 */
	useEffect(() => {
		if (mention === null || currentId === null) {
			setCandidates([]);
			return;
		}
		let live = true;
		void getMentionable(currentId)
			.then((data) => {
				if (!live) return;
				const query = mention.query.toLowerCase();
				setCandidates(
					data.candidates.filter(
						(item) =>
							query === "" ||
							item.label.toLowerCase().includes(query) ||
							item.slug.toLowerCase().includes(query) ||
							item.title.toLowerCase().includes(query),
					),
				);
				setPick(0);
			})
			.catch(() => setCandidates([]));
		return () => {
			live = false;
		};
	}, [mention?.query, currentId, mention]);

	const addFiles = useCallback(
		async (files: FileList | File[]) => {
			const list = [...files];
			if (list.length === 0) return;
			const room = MAX_PER_MESSAGE - drafts.length;
			if (room <= 0) {
				props.toast(`一条消息最多带 ${String(MAX_PER_MESSAGE)} 个附件`, "error");
				return;
			}
			for (const file of list.slice(0, room)) {
				const key = `${String(Date.now())}-${file.name}-${String(Math.random()).slice(2, 7)}`;
				const kind = file.type.startsWith("image/") ? "image" : "file";
				const preview = kind === "image" ? URL.createObjectURL(file) : "";
				if (file.size > MAX_BYTES) {
					setDrafts((current) => [
						...current,
						{ key, name: file.name, kind, preview, state: "error", error: `超过 ${humanBytes(MAX_BYTES)}` },
					]);
					props.toast(`${file.name} 太大（上限 ${humanBytes(MAX_BYTES)}）`, "error");
					continue;
				}
				setDrafts((current) => [...current, { key, name: file.name, kind, preview, state: "uploading" }]);
				try {
					const uploaded = await uploadFile(file);
					setDrafts((current) =>
						current.map((draft) => (draft.key === key ? { ...draft, state: "done", uploaded } : draft)),
					);
				} catch (error) {
					setDrafts((current) =>
						current.map((draft) =>
							draft.key === key
								? { ...draft, state: "error", error: error instanceof Error ? error.message : "上传失败" }
								: draft,
						),
					);
				}
			}
		},
		[drafts.length, props],
	);

	const dropDraft = useCallback((key: string) => {
		setDrafts((current) => {
			const found = current.find((draft) => draft.key === key);
			if (found !== undefined && found.preview !== "") URL.revokeObjectURL(found.preview);
			return current.filter((draft) => draft.key !== key);
		});
	}, []);

	const clearDrafts = useCallback(() => {
		setDrafts((current) => {
			for (const draft of current) if (draft.preview !== "") URL.revokeObjectURL(draft.preview);
			return [];
		});
	}, []);

	const submit = useCallback(async () => {
		if (!canSend) return;
		const body = text.trim();
		const ids = drafts.flatMap((draft) => (draft.state === "done" && draft.uploaded !== undefined ? [draft.uploaded.id] : []));
		setText("");
		clearDrafts();
		setMention(null);
		setMenu(false);
		try {
			await send(body, ids);
		} catch (error) {
			// 发失败就把字还回去 —— 让人重打一遍是最糟的错误处理。
			setText(body);
			props.toast(error instanceof Error ? error.message : "发送失败", "error");
		}
	}, [canSend, text, drafts, clearDrafts, props]);

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			// 中文输入法合成期间的回车是「选词」，不是「发送」。
			// keyCode 229 是老浏览器里合成期的唯一可靠信号，两样都判。
			if (event.nativeEvent.isComposing || event.keyCode === 229) return;

			if (mention !== null && candidates.length > 0) {
				if (event.key === "ArrowDown") {
					event.preventDefault();
					setPick((current) => (current + 1) % candidates.length);
					return;
				}
				if (event.key === "ArrowUp") {
					event.preventDefault();
					setPick((current) => (current - 1 + candidates.length) % candidates.length);
					return;
				}
				if (event.key === "Enter" || event.key === "Tab") {
					event.preventDefault();
					applyMention(candidates[pick]);
					return;
				}
				if (event.key === "Escape") {
					event.preventDefault();
					setMention(null);
					return;
				}
			}

			if (event.key === "Enter" && !event.shiftKey && !event.metaKey) {
				event.preventDefault();
				void submit();
			}
			if (event.key === "Escape" && reply !== null) {
				event.preventDefault();
				setReply(null);
			}
		},
		[mention, candidates, pick, reply, submit],
	);

	const applyMention = useCallback(
		(candidate: Candidate | undefined) => {
			if (candidate === undefined || mention === null) return;
			const input = inputRef.current;
			const caret = input?.selectionStart ?? text.length;
			const head = text.slice(0, mention.at);
			const tail = text.slice(caret);
			const next = `${head}@${candidate.label} ${tail}`;
			setText(next);
			setMention(null);
			// 光标落到补进来的那个 @名字 之后。`useEffect` 里量高度会抢焦点，所以用微任务。
			requestAnimationFrame(() => {
				const node = inputRef.current;
				if (node === null) return;
				const at = head.length + candidate.label.length + 2;
				node.setSelectionRange(at, at);
				node.focus();
			});
		},
		[mention, text],
	);

	const onInput = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
		const value = event.target.value;
		const caret = event.target.selectionStart ?? value.length;
		setText(value);
		const before = value.slice(0, caret);
		// 词首的 `@` 就弹：行首、空白、标点都算；中文不写空格也认（`麻烦@林越`）。
		const found = /(?:^|[^\p{L}\p{N}._-])@([\p{L}\p{N}._-]*)$/u.exec(before);
		if (found === null) setMention(null);
		else setMention({ at: before.length - found[1]!.length - 1, query: found[1]! });
	}, []);

	const hint = useMemo(() => {
		if (reply !== null) return "";
		if (drafts.length > 0) return `${String(drafts.length)} 个附件`;
		return "";
	}, [reply, drafts.length]);

	// 窄屏上那句提示会被切掉半截（「…Enter 发送,」），所以窄屏只说「发消息…」。
	const placeholder = useMemo(() => {
		if (hint !== "") return hint;
		const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 620px)").matches;
		return narrow ? "发消息…" : "发消息…（@ 提人，Enter 发送，Shift+Enter 换行）";
	}, [hint]);

	return (
		<form
			className="composer"
			id="composer"
			data-drag={dragging ? "true" : "false"}
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
			onDragEnter={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				dragDepth.current += 1;
				setDragging(true);
			}}
			onDragOver={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
			}}
			onDragLeave={(event) => {
				if (!hasFiles(event)) return;
				dragDepth.current = Math.max(0, dragDepth.current - 1);
				if (dragDepth.current === 0) setDragging(false);
			}}
			onDrop={(event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				dragDepth.current = 0;
				setDragging(false);
				if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files);
			}}
		>
			<input
				type="file"
				id="file-input"
				className="sr-only"
				multiple
				ref={fileRef}
				onChange={(event) => {
					const files = event.target.files;
					// 先清空 value：同一个文件选第二次不会再触发 change。
					event.target.value = "";
					if (files !== null) void addFiles(files);
				}}
			/>

			<div className="attach-tray" id="attach-tray" hidden={drafts.length === 0}>
				{drafts.map((draft) => (
					<div className="q-item" key={draft.key} data-state={draft.state}>
						{draft.kind === "image" && draft.preview !== "" ? (
							<img className="q-preview" src={draft.preview} alt="" />
						) : (
							<span className="q-file" aria-hidden="true">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
									<path d="M5 4h9l5 5v11H5z" />
									<path d="M14 4v5h5" />
								</svg>
							</span>
						)}
						<span className="q-meta">
							<span className="q-name">{draft.name}</span>
							<span className="q-size">
								{draft.state === "uploading"
									? "上传中…"
									: draft.state === "error"
										? (draft.error ?? "失败")
										: humanBytes(draft.uploaded?.bytes ?? 0)}
							</span>
						</span>
						{draft.state === "uploading" ? <span className="q-bar" aria-hidden="true" /> : null}
						<button
							type="button"
							className="q-x"
							aria-label={`移除 ${draft.name}`}
							onClick={() => dropDraft(draft.key)}
						>
							×
						</button>
					</div>
				))}
			</div>

			{reply === null ? null : (
				<div className="reply" id="reply-bar">
					<span className="reply-text" id="reply-text">
						<span className="reply-who">{reply.label}</span>
						{reply.excerpt}
					</span>
					<button type="button" className="reply-x" id="reply-cancel" aria-label="取消引用" onClick={() => setReply(null)}>
						×
					</button>
				</div>
			)}

			<div className="composer-card">
				<div className="menu-anchor">
					<button
						type="button"
						className="plus"
						id="plus-btn"
						aria-label="添加"
						title="添加"
						aria-expanded={menu}
						onClick={() => setMenu((current) => !current)}
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
							<path d="M12 5v14M5 12h14" />
						</svg>
					</button>
					{menu ? (
						<div className="menu pop-menu" id="plus-menu" role="menu">
							<button
								type="button"
								className="menu-item"
								role="menuitem"
								data-plus="image"
								onClick={() => {
									if (fileRef.current !== null) fileRef.current.accept = "image/*";
									fileRef.current?.click();
									setMenu(false);
								}}
							>
								发图片
							</button>
							<button
								type="button"
								className="menu-item"
								role="menuitem"
								data-plus="file"
								onClick={() => {
									if (fileRef.current !== null) fileRef.current.accept = "";
									fileRef.current?.click();
									setMenu(false);
								}}
							>
								发文件
							</button>
							<button
								type="button"
								className="menu-item"
								role="menuitem"
								data-plus="quote"
								onClick={() => {
									setMenu(false);
									const feed = document.querySelector(".feed");
									const last = feed?.querySelectorAll<HTMLElement>(".row-say");
									const node = last?.[last.length - 1];
									if (node === undefined) {
										props.toast("这个频道还没有可以引用的话");
										return;
									}
									const seq = Number(node.dataset["seq"] ?? "0");
									const body = node.querySelector(".md")?.textContent ?? "";
									setReply({ seq, label: "引用最后一条", excerpt: body.slice(0, 60) });
								}}
							>
								引用最后一条
							</button>
						</div>
					) : null}
				</div>

				<textarea
					id="input"
					ref={inputRef}
					rows={1}
					value={text}
					placeholder={placeholder}
					onChange={onInput}
					onKeyDown={onKeyDown}
					onPaste={(event) => {
						const files = [...event.clipboardData.files];
						if (files.length === 0) return;
						event.preventDefault();
						void addFiles(files);
					}}
					onBlur={() => window.setTimeout(() => setMention(null), 120)}
				/>

				<button
					type="submit"
					className="send"
					id="send"
					disabled={!canSend}
					aria-label="发送"
					title="发送（Enter）"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M12 19V5M6 11l6-6 6 6" />
					</svg>
				</button>
			</div>

			{mention === null ? null : (
				<div className="mention" id="mention-pop" role="listbox" aria-label="提到谁">
					{candidates.length === 0 ? (
						<div className="mention-none">这个频道里没有叫「{mention.query}」的人</div>
					) : (
						<div className="mention-list" id="mention-list">
							{candidates.slice(0, 6).map((candidate, index) => (
								<button
									type="button"
									key={candidate.slug}
									role="option"
									aria-selected={index === pick}
									className="mention-item"
									data-slug={candidate.slug}
									onMouseEnter={() => setPick(index)}
									onMouseDown={(event) => {
										event.preventDefault();
										applyMention(candidate);
									}}
								>
									<span
										className="mention-av"
										aria-hidden="true"
										dangerouslySetInnerHTML={{
											__html: avatarSvg({ slug: candidate.slug, name: candidate.label, size: 20, state: "idle" }),
										}}
									/>
									<span className="mention-name">{candidate.label}</span>
									<span className="mention-sub">{candidate.title}</span>
									<span className="mention-slug">@{candidate.slug}</span>
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</form>
	);
}

function hasFiles(event: React.DragEvent<HTMLElement>): boolean {
	return [...event.dataTransfer.types].includes("Files");
}
