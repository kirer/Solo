#!/usr/bin/env node
/**
 * 自建更新源 —— 一个只读的静态文件服务。
 *
 * 客户端是 `electron-updater` 的 `generic` provider：它要的只有一份版本清单
 * （`latest-mac.yml` / `latest.yml`）和清单里点名的 zip / exe / blockmap。
 * 清单里的 `files[].url` 是相对路径时，provider 会以清单所在地址为基准拼出绝对地址，
 * 所以这里**原样发文件就够了**，不改写 URL、不存库、不认账号。
 *
 * 发布就是把 electron-builder 的产物丢进一个目录（二进制先传，清单最后传），
 * 然后用这个服务发出去；跨机器搬运用 rsync / scp，不走这里。
 *
 * 用法：`npm run update:serve -- [--dir feed] [--port 8899] [--host 127.0.0.1]`
 *
 * 刻意没有的：Range / 断点续传（客户端整包下载，一次拿完）、上传接口、鉴权、TLS
 * （前面挂 nginx / caddy）。这些等客户端真的接上再按需长。
 */
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import { pipeline } from "node:stream/promises";

export type UpdateServer = {
	readonly port: number;
	readonly host: string;
	readonly url: string;
	close(): Promise<void>;
};

export type UpdateServerOptions = {
	readonly dir: string;
	readonly port: number;
	readonly host: string;
	/** 每行日志；测试里传空函数。 */
	readonly log?: (line: string) => void;
};

/** 清单必须每次现取（它是「最新版本是谁」的答案），产物文件带版本号、永不改，可以长缓存。 */
function cacheControlOf(path: string): string {
	const ext = extname(path).toLowerCase();
	return ext === ".yml" || ext === ".yaml" || ext === ".json"
		? "no-cache"
		: "public, max-age=31536000, immutable";
}

function contentTypeOf(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".yml":
		case ".yaml":
			return "application/yaml";
		case ".json":
			return "application/json";
		case ".zip":
			return "application/zip";
		default:
			return "application/octet-stream";
	}
}

function bytes(n: number): string {
	return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function end(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
	response.end(text);
}

/** 目录里有什么：一眼看出发布了哪些版本。只列一层。 */
async function list(root: string): Promise<string> {
	const entries = await readdir(root, { withFileTypes: true });
	const rows: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile()) continue;
		const info = await stat(join(root, entry.name));
		rows.push(`${bytes(info.size).padStart(9)}  ${entry.name}`);
	}
	return rows.length === 0 ? "（空）把 electron-builder 的产物放进这个目录\n" : `${rows.join("\n")}\n`;
}

/**
 * 把请求路径翻译成目录里的绝对路径。
 *
 * 越界一律 `undefined`：`%2e%2e%2f` 这种编码过的穿越也要挡住，所以先解码再 resolve，
 * 最后用 `root + sep` 比前缀 —— 和 `interface/http/static-assets.ts` 的 `insideRoot` 同一条思路，
 * 但那边属于内核的 interface 层，这里不 import 过来。
 */
function resolveInside(root: string, pathname: string): string | undefined {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return undefined;
	}
	const target = resolve(root, `.${decoded}`);
	return target === root || target.startsWith(root + sep) ? target : undefined;
}

export async function createUpdateServer(options: UpdateServerOptions): Promise<UpdateServer> {
	const root = resolve(options.dir);
	const log = options.log ?? ((line: string) => console.log(line));
	await mkdir(root, { recursive: true });

	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const method = request.method ?? "GET";
		const pathname = (request.url ?? "/").split("?")[0] ?? "/";
		const refuse = (status: number, text: string): void => {
			log(`[feed] ${status} ${method} ${pathname}`);
			end(response, status, text);
		};
		if (method !== "GET" && method !== "HEAD") return refuse(405, "只读服务\n");

		if (pathname === "/") {
			const body = await list(root);
			log(`[feed] 200 ${method} /`);
			response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
			response.end(method === "HEAD" ? undefined : body);
			return;
		}

		const target = resolveInside(root, pathname);
		if (target === undefined) return refuse(404, "没找到\n");
		const info = await stat(target).catch(() => undefined);
		if (info === undefined || !info.isFile()) return refuse(404, "没找到\n");

		log(`[feed] 200 ${method} ${pathname} ${bytes(info.size)}`);
		response.writeHead(200, {
			"Content-Type": contentTypeOf(target),
			"Content-Length": String(info.size),
			"Cache-Control": cacheControlOf(target),
		});
		if (method === "HEAD") {
			response.end();
			return;
		}
		// 流发到一半出错时头已经发出去了，只能断开：别让客户端把半个包当成完整的。
		await pipeline(createReadStream(target), response).catch(() => response.destroy());
	};

	const server = createServer((request, response) => {
		void handle(request, response).catch((error: unknown) => {
			// handler 里任何位置抛错（读目录失败之类）都兜在这里，别让进程倒下。
			log(`[feed] 500 ${request.method ?? "GET"} ${request.url ?? "/"}`);
			if (!response.headersSent) end(response, 500, "服务端出错\n");
			else response.destroy();
			console.warn(`[feed] ${error instanceof Error ? error.message : String(error)}`);
		});
	});

	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(options.port, options.host, () => {
			server.off("error", fail);
			done();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;

	return {
		port,
		host: options.host,
		url: `http://${options.host}:${String(port)}`,
		close: () =>
			new Promise<void>((done) => {
				server.close(() => done());
			}),
	};
}

type Args = {
	readonly dir: string;
	readonly port: number;
	readonly host: string;
};

function parseArgs(argv: readonly string[]): Args {
	try {
		const { values } = parseNodeArgs({
			args: [...argv],
			options: {
				dir: { type: "string" },
				port: { type: "string" },
				host: { type: "string" },
			},
			strict: true,
		});
		return {
			dir: values.dir ?? join(process.cwd(), "feed"),
			port: values.port === undefined ? 8899 : Number(values.port),
			host: values.host ?? "127.0.0.1",
		};
	} catch (error) {
		console.error(`[feed] 参数不对：${(error as Error).message}`);
		console.error("用法：npm run update:serve -- [--dir feed] [--port 8899] [--host 127.0.0.1]");
		process.exit(2);
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const server = await createUpdateServer(args);
	console.log(`[feed] ${server.url}`);
	console.log(`[feed] 目录：${resolve(args.dir)}`);
	console.log("[feed] 把 electron-builder 的产物（latest*.yml + zip / exe / blockmap）放进这个目录就能发布");

	const shutdown = async (signal: string): Promise<void> => {
		console.log(`\n[feed] ${signal}，正在关闭…`);
		await server.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

await main();
