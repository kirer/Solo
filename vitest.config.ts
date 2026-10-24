import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// 每个测试文件用独立临时目录与独立 SQLite，避免并发互相干扰。
		pool: "forks",
	},
});
