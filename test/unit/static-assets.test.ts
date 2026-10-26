/**
 * 静态资源的压缩协商与条件请求。
 *
 * 这一组钉的是两个真实缺陷（首屏 480 KB / 23 个文件，走隧道时原样跨境传输）：
 * ① `serve` 以前完全不压缩，也没有 `Vary`；
 * ② 只发 `Cache-Control: no-cache` 却没有任何 ETag / Last-Modified，
 *    浏览器每次条件请求都只能拿 200 全量响应 —— `no-cache` 的语义是
 *    「可以存但用前要验证」，没有验证凭据就等于每次重传 480 KB。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	type AssetEntry,
	bodyFor,
	compressible,
	etagFor,
	loadAsset,
	matchesEtag,
	negotiateEncoding,
	notModifiedSince,
	resetAssetCache,
} from "../../src/server/static-assets.ts";

describe("negotiateEncoding", () => {
	test("缺省 / 空头得到 identity", () => {
		expect(negotiateEncoding(undefined)).toBe("identity");
		expect(negotiateEncoding("")).toBe("identity");
		expect(negotiateEncoding("   ")).toBe("identity");
	});

	test("同时支持时优先 brotli（同内容比 gzip 再小约 15%）", () => {
		expect(negotiateEncoding("br, gzip")).toBe("br");
		expect(negotiateEncoding("gzip, br")).toBe("br");
	});

	test("只支持 gzip 时用 gzip", () => {
		expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
	});

	test("q 权重起作用：br;q=0 表示明确不要 br", () => {
		expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
		expect(negotiateEncoding("br;q=0.5, gzip;q=1")).toBe("gzip");
		expect(negotiateEncoding("br;q=1, gzip;q=0.5")).toBe("br");
	});

	test("只列了不支持的编码时退回 identity，不报错", () => {
		expect(negotiateEncoding("identity")).toBe("identity");
		expect(negotiateEncoding("deflate")).toBe("identity");
	});

	test("`*` 兜底：只写 * 时按 brotli 处理", () => {
		expect(negotiateEncoding("*")).toBe("br");
	});
});

describe("compressible", () => {
	test("文本类要压", () => {
		expect(compressible("text/html; charset=utf-8")).toBe(true);
		expect(compressible("text/css; charset=utf-8")).toBe(true);
		expect(compressible("text/javascript; charset=utf-8")).toBe(true);
		expect(compressible("application/json; charset=utf-8")).toBe(true);
		expect(compressible("image/svg+xml")).toBe(true);
	});

	test("已压缩的二进制不压（woff2 内部已是 brotli，再压只会更慢更大）", () => {
		expect(compressible("image/png")).toBe(false);
		expect(compressible("font/woff2")).toBe(false);
		expect(compressible("application/octet-stream")).toBe(false);
	});
});

describe("ETag 与条件请求", () => {
	let dir = "";
	let entry: AssetEntry;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "ai-company-static-"));
		// 长一点，让压缩效果可观测
		await writeFile(join(dir, "a.js"), "const a = 1;\n".repeat(200));
		await writeFile(join(dir, "b.js"), "other");
		const loaded = await loadAsset(join(dir, "a.js"));
		if (loaded === undefined) throw new Error("预加载失败");
		entry = loaded;
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("同内容不同编码的 ETag 必须不同（是不同的 representation）", () => {
		// 共用 ETag 会让客户端拿 br 的凭据验证 identity 的响应，缓存语义就错了。
		expect(etagFor(entry, "br")).not.toBe(etagFor(entry, "identity"));
		expect(etagFor(entry, "gzip")).not.toBe(etagFor(entry, "identity"));
		expect(etagFor(entry, "br")).not.toBe(etagFor(entry, "gzip"));
	});

	test("identity 的 ETag 是带引号的强 ETag", () => {
		expect(entry.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
	});

	test("If-None-Match 命中 / 不命中", () => {
		const tag = etagFor(entry, "identity");
		expect(matchesEtag(tag, tag)).toBe(true);
		expect(matchesEtag('"nope"', tag)).toBe(false);
		expect(matchesEtag(undefined, tag)).toBe(false);
	});

	test("弱 ETag（W/ 前缀）也命中 —— GET 用弱比较", () => {
		const tag = etagFor(entry, "identity");
		expect(matchesEtag(`W/${tag}`, tag)).toBe(true);
	});

	test("`*` 命中任意现有表示", () => {
		expect(matchesEtag("*", etagFor(entry, "br"))).toBe(true);
	});

	test("多值列表里命中其中一个即可", () => {
		const tag = etagFor(entry, "br");
		expect(matchesEtag(`"a", ${tag}, "b"`, tag)).toBe(true);
	});

	test("If-Modified-Since 命中 / 不命中", () => {
		const lm = entry.lastModified;
		expect(notModifiedSince(lm, lm)).toBe(true);
		expect(notModifiedSince("Thu, 01 Jan 1970 00:00:00 GMT", lm)).toBe(false);
		expect(notModifiedSince(undefined, lm)).toBe(false);
		// 坏日期不能让缓存永远命中不了
		expect(notModifiedSince("not a date", lm)).toBe(false);
	});

	test("压缩后确实更小", async () => {
		for (const encoding of ["gzip", "br"] as const) {
			const result = await bodyFor(entry, encoding);
			expect(result.encoding).toBe(encoding);
			expect(result.body.length).toBeLessThan(entry.identity.length);
		}
	});

	test("压缩结果被复用（同一编码第二次不再重算）", async () => {
		const first = await bodyFor(entry, "gzip");
		const second = await bodyFor(entry, "gzip");
		expect(second.body).toBe(first.body);
	});

	test("identity 请求不发压缩体", async () => {
		const result = await bodyFor(entry, "identity");
		expect(result.encoding).toBe("identity");
		expect(result.body).toBe(entry.identity);
	});

	test("文件改动后缓存失效（改完 ui/ 刷新就生效，不用重启）", async () => {
		resetAssetCache();
		const before = await loadAsset(join(dir, "b.js"));
		expect(before?.identity.toString()).toBe("other");
		await writeFile(join(dir, "b.js"), "changed!");
		const after = await loadAsset(join(dir, "b.js"));
		expect(after?.identity.toString()).toBe("changed!");
		expect(after?.stamp).not.toBe(before?.stamp);
	});

	test("重复取同一文件复用缓存对象（不重复读盘）", async () => {
		const first = await loadAsset(join(dir, "a.js"));
		const second = await loadAsset(join(dir, "a.js"));
		expect(second).toBe(first);
	});

	test("不存在的文件返回 undefined（交给 SPA 回退 / 404 判断）", async () => {
		expect(await loadAsset(join(dir, "nope.js"))).toBeUndefined();
		// 目录不是文件
		expect(await loadAsset(dir)).toBeUndefined();
	});
});
