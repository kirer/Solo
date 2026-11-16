#!/usr/bin/env bash
# tag 推上去「一条 run 都不起」的元凶：commit message（或标签说明）里有 GitHub 的 skip 指令。
# 这种 push GitHub 直接不给建 run —— 写在 release.yml 里的检查永远没机会跑，
# 所以这道闸只能挂在 `create` 事件上（tag 一建就起），再由这里判文字。
#
# 用法：tag-skip-guard.sh --stdin   < 一段文字（提交信息、标签说明都行）
#       tag-skip-guard.sh "一段文字"
# 命中 → 打印命中的那几行、退出码 1；没命中 → 退出码 0。

set -uo pipefail

if [ "${1:-}" = "--stdin" ]; then
	text=$(cat)
else
	text="${1:-}"
fi

# GitHub 认这五种写法（大小写不敏感），别只拦 [skip ci]。
pattern='\[(skip[ -]?ci|ci[ -]?skip|no[ -]?ci|skip[ -]?actions|actions[ -]?skip)\]'

if hits=$(printf '%s\n' "${text}" | grep -Ei "${pattern}"); then
	echo "这段信息里有 GitHub 的 skip 指令，推 tag 时发版那趟根本不会启动："
	printf '%s\n' "${hits}"
	exit 1
fi

echo "没有 skip 指令"
exit 0
