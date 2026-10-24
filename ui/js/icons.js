/**
 * 内联 SVG 图标。
 *
 * 统一 24 网格、1.7 描边、round 端点；颜色继承 currentColor。
 * 只在这里加图标，组件里不手写 path。
 */

const PATHS = {
	org: `<rect x="9.5" y="3" width="5" height="4" rx="1"/><rect x="3" y="16.5" width="5" height="4" rx="1"/><rect x="16" y="16.5" width="5" height="4" rx="1"/><path d="M12 7v5M12 12H5.5v4.5M12 12h6.5v4.5"/>`,
	tree: `<rect x="9.5" y="3" width="5" height="4" rx="1"/><rect x="3" y="16.5" width="5" height="4" rx="1"/><rect x="16" y="16.5" width="5" height="4" rx="1"/><path d="M12 7v5M12 12H5.5v4.5M12 12h6.5v4.5"/>`,
	inbox: `<path d="M4 13.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5.5"/><path d="M4 13.5 6.2 5.6A1 1 0 0 1 7.2 5h9.6a1 1 0 0 1 1 .6L20 13.5"/><path d="M4 13.5h4.5l1 2h5l1-2H20"/>`,
	chat: `<path d="M20 12.5a7.6 7.6 0 0 1-8 7.5 8.8 8.8 0 0 1-2.6-.4L4 21l1.4-4.1A7.3 7.3 0 0 1 4 12.5 7.6 7.6 0 0 1 12 5a7.6 7.6 0 0 1 8 7.5Z"/><path d="M8.5 11.5h7M8.5 14.5h4.5"/>`,
	terminal: `<path d="m5 8 4 4-4 4"/><path d="M12.5 17H19"/>`,
	file: `<path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z"/><path d="M14 3v5h4.5"/>`,
	filePlus: `<path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z"/><path d="M14 3v5h4.5"/><path d="M12 12v5M9.5 14.5h5"/>`,
	edit: `<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m13.5 6.5 3 3"/>`,
	users: `<circle cx="9" cy="8.2" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3 3 0 0 1 0 5.5"/><path d="M17.5 14.2a5.2 5.2 0 0 1 3 4.4"/>`,
	userPlus: `<circle cx="9" cy="8.2" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M18.5 7v6M15.5 10h6"/>`,
	userCheck: `<circle cx="9" cy="8.2" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="m15.5 10.5 1.8 1.8 3.2-3.6"/>`,
	userMinus: `<circle cx="9" cy="8.2" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M15.5 10h5.5"/>`,
	folder: `<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8A1.5 1.5 0 0 1 20.5 10v7.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>`,
	folderPlus: `<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8A1.5 1.5 0 0 1 20.5 10v7.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M12 11.5v5M9.5 14h5"/>`,
	clipboard: `<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5V3.8A1.3 1.3 0 0 1 10.3 2.5h3.4A1.3 1.3 0 0 1 15 3.8v.7"/><path d="M9 11h6M9 15h4"/>`,
	stop: `<rect x="6" y="6" width="12" height="12" rx="2.5"/>`,
	trash: `<path d="M4 7h16M9.5 7V4.8A1 1 0 0 1 10.5 4h3a1 1 0 0 1 1 .8V7"/><path d="M6.5 7l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10 11v6M14 11v6"/>`,
	send: `<path d="M20.5 3.5 10 14M20.5 3.5l-6.2 17-4.3-6.5L3.5 9.7z"/>`,
	arrowUp: `<path d="M12 19V5M6 11l6-6 6 6"/>`,
	arrowDown: `<path d="M12 5v14M6 13l6 6 6-6"/>`,
	arrowUpRight: `<path d="M7 17 17 7M8 7h9v9"/>`,
	arrowRight: `<path d="M5 12h14M13 6l6 6-6 6"/>`,
	check: `<path d="m5 12.5 4.5 4.5L19 7"/>`,
	checkCircle: `<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>`,
	wallet: `<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 18 19H6.5A2.5 2.5 0 0 1 4 16.5z"/><path d="M4 8h15.5"/><path d="M16 12.5h1.5"/>`,
	chart: `<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V7M16 16v-8"/>`,
	spark: `<path d="M12 3.5c.7 4.8 3.7 7.8 8.5 8.5-4.8.7-7.8 3.7-8.5 8.5-.7-4.8-3.7-7.8-8.5-8.5 4.8-.7 7.8-3.7 8.5-8.5Z"/>`,
	tool: `<path d="M14.5 6.5a4 4 0 0 0 5.2 5.2l-9 9a2.6 2.6 0 0 1-3.7-3.7z"/><path d="m13 4 7 7"/>`,
	copy: `<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>`,
	chevronDown: `<path d="m6 9 6 6 6-6"/>`,
	chevronRight: `<path d="m9 5 7 7-7 7"/>`,
	chevronLeft: `<path d="m15 5-7 7 7 7"/>`,
	chevronUp: `<path d="m6 15 6-6 6 6"/>`,
	x: `<path d="M6 6l12 12M18 6 6 18"/>`,
	loader: `<path d="M12 3a9 9 0 1 0 9 9"/>`,
	brain: `<path d="M12 5.2a3 3 0 0 0-5.8.9A2.7 2.7 0 0 0 4.6 10a3 3 0 0 0 1.2 4.7A3 3 0 0 0 12 18V5.2Z"/><path d="M12 5.2a3 3 0 0 1 5.8.9A2.7 2.7 0 0 1 19.4 10a3 3 0 0 1-1.2 4.7A3 3 0 0 1 12 18V5.2Z"/>`,
	alert: `<path d="M12 4 3.5 19.5h17z"/><path d="M12 10v4.5M12 17.2v.2"/>`,
	refresh: `<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4.5h-4.5"/>`,
	message: `<path d="M4 5.5h16v11H9l-4 3.5v-3.5H4z"/>`,
	image: `<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-5 4 4 2.5-2.5L20 18"/>`,
	search: `<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>`,
	link: `<path d="M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.8"/><path d="M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.3-1.3"/>`,
	clock: `<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`,
	more: `<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>`,
	panelRight: `<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/>`,
	info: `<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>`,
	plus: `<path d="M12 5v14M5 12h14"/>`,
	pulse: `<path d="M3 12h3.5L9 5.5l4 13 2.5-6.5H21"/>`,
	key: `<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21M17 12v3M20 12v2.5"/>`,
	palette: `<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.3 0 1.8-.8 1.8-1.7 0-1.2-1-1.5-1-2.6 0-.9.8-1.6 1.8-1.6h1.6a3.3 3.3 0 0 0 3.3-3.3C19.5 6.6 16.2 3.5 12 3.5Z"/><circle cx="8" cy="9" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="7" cy="13.5" r="1"/>`,
};

export function icon(name, size = 16, className = "") {
	const paths = PATHS[name] ?? PATHS.tool;
	return `<svg class="ico${className ? ` ${className}` : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export const ICON_NAMES = Object.keys(PATHS);
