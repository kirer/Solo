/**
 * 后端就绪那一行。
 *
 * `src/core/shell/main.ts` 起来后会打印 `[core] http://127.0.0.1:<port>/`
 * （`serveCore` 把真实端口写回，`--port 0` 时也一样）。桌面壳就靠这一行知道端口，
 * 因此**不改后端的命令行**：多一个 `--print-port` 就多一条要同步的契约。
 * 行文案真要改，先改这里的正则和它的单测。
 */
const READY = /^\[core\] (https?:\/\/\S+)$/;

export function parseReadyLine(line: string): string | undefined {
	return READY.exec(line.trim())?.[1];
}
