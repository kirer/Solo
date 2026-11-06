/**
 * 第一次打开：欢迎 → 接上模型（稿子 10 / 11）。
 *
 * 只有一台机器上一只模型都没有时才出现（`bootstrap` 判的）。两步都是整屏，
 * 走 `body[data-pane]` 之外的那条路：这里不画列表、不画输入框，只画这一件事。
 */

import { useState, type ReactNode } from "react";
import { probeSetup, saveSetup, type SetupBody, type SetupChoice } from "../api/client.ts";
import { brandMarkSvg } from "../lib/brand.ts";
import { bootstrap, setSetupStep } from "../state/store.ts";
import { useStore } from "../state/useStore.ts";

const OPTIONS: readonly { choice: SetupChoice; label: string; sub: string; pill?: string }[] = [
	{ choice: "opus", label: "Claude Opus 5.5", sub: "最强，团队里的事都交给它想", pill: "推荐" },
	{ choice: "sonnet", label: "Claude Sonnet 5.5", sub: "更快更省，日常够用" },
	{ choice: "custom", label: "自定义接口", sub: "任何 OpenAI 兼容的地址" },
];

type Status =
	| { kind: "idle" }
	| { kind: "checking" }
	| { kind: "ok"; ms: number }
	| { kind: "error"; text: string };

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : "没接上";
}

export function SetupPage(): JSX.Element {
	const step = useStore((state) => state.setupStep);
	return (
		<section className="page setup-screen" id="page-setup" aria-label="第一次打开">
			{step === "model" ? <ModelStep /> : <WelcomeStep />}
		</section>
	);
}

function WelcomeStep(): JSX.Element {
	return (
		<>
			<div className="setup-welcome">
				<span className="setup-mark" dangerouslySetInnerHTML={{ __html: brandMarkSvg(96) }} />
				<h1>Solo</h1>
				<p>
					你和一支 AI 团队。
					<br />
					说一句要什么，剩下的它去安排。
				</p>
				<div className="setup-points">
					<Point icon={<path d="M12 5v14M5 12h14" />}>
						<b>找它就够了。</b>不用管谁擅长什么，它替你分派、盯进度、把结论拿回来。
					</Point>
					<Point
						icon={
							<>
								<path d="M4 7.5h9.5M18 7.5h2M4 16.5h3.5M12 16.5h8" />
								<circle cx="15.8" cy="7.5" r="2.2" />
								<circle cx="9.8" cy="16.5" r="2.2" />
							</>
						}
					>
						<b>人是有档的。</b>每个人的职责、记忆、手艺都写在磁盘上的文件里，改一个字下一句就生效。
					</Point>
					<Point
						icon={
							<>
								<rect x="4" y="4" width="16" height="16" rx="4" />
								<path d="M9 12h6" />
							</>
						}
					>
						<b>都在你这台机器上。</b>模型由你接，数据不出本机。
					</Point>
				</div>
			</div>
			<div className="setup-foot">
				<button type="button" className="setup-primary" onClick={() => setSetupStep("model")}>
					开始
				</button>
			</div>
		</>
	);
}

function Point(props: { icon: JSX.Element; children: ReactNode }): JSX.Element {
	return (
		<div className="setup-point">
			<span className="setup-ico">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
					{props.icon}
				</svg>
			</span>
			<span>{props.children}</span>
		</div>
	);
}

function ModelStep(): JSX.Element {
	const [choice, setChoice] = useState<SetupChoice>("opus");
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [model, setModel] = useState("");
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const [busy, setBusy] = useState(false);
	/** 「获取模型」拉回来的清单；空 = 还没拉过。手打永远可用。 */
	const [fetched, setFetched] = useState<readonly string[]>([]);
	const [fetching, setFetching] = useState(false);

	const ready =
		choice === "custom" ? baseUrl.trim() !== "" && model.trim() !== "" : apiKey.trim() !== "";

	const body: SetupBody = {
		choice,
		apiKey: apiKey.trim(),
		...(choice === "custom" ? { baseUrl: baseUrl.trim(), model: model.trim() } : {}),
	};

	/** 换选项 / 改值之后旧的结论就不算数了。 */
	function reset(next: () => void): void {
		next();
		setStatus({ kind: "idle" });
	}

	async function check(): Promise<void> {
		if (!ready || status.kind === "checking") return;
		setStatus({ kind: "checking" });
		try {
			const result = await probeSetup(body);
			if (choice === "custom" && result.models.length > 0) setFetched(result.models);
			setStatus({ kind: "ok", ms: result.ms });
		} catch (error) {
			setStatus({ kind: "error", text: messageOf(error) });
		}
	}

	/** 「获取模型」：拿地址和密钥去问这家有哪些模型。没列出来就手填。 */
	async function fetchModels(): Promise<void> {
		if (baseUrl.trim() === "" || fetching || status.kind === "checking") return;
		setFetching(true);
		setStatus({ kind: "checking" });
		try {
			const result = await probeSetup({ choice: "custom", apiKey: apiKey.trim(), baseUrl: baseUrl.trim() });
			setFetched(result.models);
			setStatus(
				result.models.length === 0
					? { kind: "error", text: "这家没给出模型清单，手动填一个" }
					: { kind: "ok", ms: result.ms },
			);
		} catch (error) {
			setStatus({ kind: "error", text: messageOf(error) });
		} finally {
			setFetching(false);
		}
	}

	async function finish(): Promise<void> {
		if (!ready || busy) return;
		setBusy(true);
		try {
			await saveSetup(body);
			// 接上了：重新走一遍首屏（模型清单现在非空，`bootstrap` 会把人放进助理私聊）。
			setSetupStep(null);
			await bootstrap();
		} catch (error) {
			setStatus({ kind: "error", text: messageOf(error) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<header className="nav">
				<button type="button" className="icon-btn" aria-label="返回" onClick={() => setSetupStep("welcome")}>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
						<path d="M14.5 5.5 8 12l6.5 6.5" />
					</svg>
				</button>
				<div className="nav-main">
					<h1 className="nav-title">接上模型</h1>
					<div className="nav-sub">Solo 自己不产模型，跑在你选的这个上</div>
				</div>
			</header>

			<div className="setup-body">
				<div className="setup-lead">先选一个。之后随时能换，也能给某个人单独换。</div>

				<div className="setup-card">
					{OPTIONS.map((item) => (
						<button
							type="button"
							key={item.choice}
							className="setup-opt"
							data-on={choice === item.choice ? "true" : "false"}
							onClick={() => reset(() => setChoice(item.choice))}
						>
							<span className="setup-radio" aria-hidden="true" />
							<span className="setup-main">
								<span className="setup-label">{item.label}</span>
								<span className="setup-sub">{item.sub}</span>
							</span>
							{item.pill === undefined ? null : <span className="setup-pill">{item.pill}</span>}
						</button>
					))}
				</div>

				{choice === "custom" ? (
					<div className="setup-card">
						<Field
							label="地址"
							placeholder="https://…"
							value={baseUrl}
							onChange={(value) => reset(() => setBaseUrl(value))}
						/>
						<Field
							label="模型"
							placeholder="选一个，或直接填"
							value={model}
							onChange={(value) => reset(() => setModel(value))}
							action={
								<button
									type="button"
									className="setup-fetch"
									disabled={baseUrl.trim() === "" || fetching}
									onClick={() => void fetchModels()}
								>
									{fetching ? "获取中…" : "获取模型"}
								</button>
							}
						/>
						{fetched.length === 0 ? null : (
							<div className="setup-picks">
								{fetched.map((id) => (
									<button
										type="button"
										key={id}
										className="setup-chip"
										data-on={model === id ? "true" : "false"}
										onClick={() => reset(() => setModel(id))}
									>
										{id}
									</button>
								))}
							</div>
						)}
					</div>
				) : null}

				<div className="setup-card">
					<Field
						label="密钥"
						placeholder={choice === "custom" ? "本机网关可以留空" : "sk-ant-…"}
						value={apiKey}
						secret
						onChange={(value) => reset(() => setApiKey(value))}
						onBlur={() => void check()}
					/>
				</div>

				{status.kind === "idle" ? null : status.kind === "checking" ? (
					<div className="setup-status">正在连…</div>
				) : status.kind === "ok" ? (
					<div className="setup-status" data-tone="ok">
						<span className="setup-dot" aria-hidden="true" />已连通 · {(status.ms / 1000).toFixed(1)}s
					</div>
				) : (
					<div className="setup-status" data-tone="error">
						{status.text}
					</div>
				)}
			</div>

			<div className="setup-foot">
				<button type="button" className="setup-primary" disabled={!ready || busy} onClick={() => void finish()}>
					{busy ? "正在接上…" : "就用这个"}
				</button>
			</div>
		</>
	);
}

function Field(props: {
	label: string;
	placeholder: string;
	value: string;
	secret?: boolean;
	/** 行尾的动作（只有「模型」那一行有：获取模型）。 */
	action?: ReactNode;
	onChange: (value: string) => void;
	onBlur?: () => void;
}): JSX.Element {
	return (
		<div className="setup-field">
			<span className="setup-label">{props.label}</span>
			<input
				className="setup-input"
				type={props.secret === true ? "password" : "text"}
				inputMode={props.secret === true ? "text" : "url"}
				autoComplete="off"
				spellCheck={false}
				aria-label={props.label}
				placeholder={props.placeholder}
				value={props.value}
				onChange={(event) => props.onChange(event.target.value)}
				onBlur={props.onBlur}
			/>
			{props.action}
		</div>
	);
}
