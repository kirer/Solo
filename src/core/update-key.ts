/**
 * 更新清单的 Ed25519 公钥。`npm run update:key` 生成；私钥不在仓库里。
 *
 * 这和 `desktop/src/update-key.ts` 是**同一把钥匙的两份拷贝**：桌面壳 `rootDir` 卡在 `desktop/src`，
 * 引不到这里，两处又都得各自能编译。改钥匙要两边一起改 + 重新签清单，
 * 一字不差有 `test/core/update-key.test.ts` 盯着。
 */
export const UPDATE_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAgnk+uz+e4fvO8ZvWLqh6jtYH9rY6G39PFOxeUzkrjjQ=\n-----END PUBLIC KEY-----\n";
