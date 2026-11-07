/**
 * 一套表单控件：输入 / 多行 / 下拉。
 *
 * 设置页、资料页、插件的输入框长同一个样：34 高、`--raised` 底、9 圆角、
 * 平时只有发丝边，hover 深一档、focus 带一圈很淡的光。
 * 插件（`client.js`）不能 import 这里，所以样式挂在全局类名上，插件直接用
 * `ui-input` / `ui-select` / `ui-textarea` 就能长成同一副样子。
 */
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const classes = (base: string, extra: string | undefined): string =>
	extra === undefined || extra === "" ? base : `${base} ${extra}`;

export function TextField(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
	const { className, ...rest } = props;
	return <input className={classes("ui-input", className)} {...rest} />;
}

export function TextAreaField(props: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
	const { className, ...rest } = props;
	return <textarea className={classes("ui-textarea", className)} {...rest} />;
}

export function SelectField(props: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
	const { className, ...rest } = props;
	return <select className={classes("ui-select", className)} {...rest} />;
}
