#!/bin/bash
#
# 一人公司网页服务 · 一键启动 / 停止 / 重启 / 状态 / 日志
#
# 为什么要 launchd 而不是 nohup：
#   nohup 只挡 SIGHUP，进程仍属于启动它的 shell 的进程组。在 agent 的 bash 里
#   （或任何终端关掉时）整个进程组会被回收，服务跟着死，只留一个残留 .lock。
#   launchd 托管后进程 PPID=1、独立进程组，终端/会话全关也不影响，异常退出还能自愈。
#
# 用法：
#   ./scripts/ai-company-service.sh start      # 启动（已在跑则只做健康检查），并打开浏览器
#   ./scripts/ai-company-service.sh stop       # 停止（干净退出，会落盘事件、释放数据库锁）
#   ./scripts/ai-company-service.sh restart    # 重启（保留数据与在途任务）
#   ./scripts/ai-company-service.sh status     # 看进程 / 端口 / 健康 / 待你拍板数量
#   ./scripts/ai-company-service.sh logs       # 跟踪日志（Ctrl+C 退出跟踪，不影响服务）
#   ./scripts/ai-company-service.sh open       # 只打开页面
#
# 安装成全局命令（已装好之后就不需要这一步）：
#   ln -sf "$PWD/scripts/ai-company-service.sh" /usr/local/bin/ai-company
#   ln -sf "$PWD/scripts/ai-company-service.sh" /usr/local/bin/ai-company-start
#   ln -sf "$PWD/scripts/ai-company-service.sh" /usr/local/bin/ai-company-stop
#   之后：ai-company-start / ai-company-stop / ai-company restart / ai-company status
#
# 可配置环境变量：
#   AI_COMPANY_PORT=7790        换端口（默认 7788；换端口后 start 会重写 plist）
#   AI_COMPANY_HOST=0.0.0.0    监听地址（默认 127.0.0.1；要手机/同事访问用 0.0.0.0，
#                              注意服务无鉴权，只应在可信内网使用，见 docs/DEPLOY.md）
#   AI_COMPANY_DB=...          换数据库（默认 <项目>/workspace/company.sqlite）
#   AI_COMPANY_WORKSPACE=...   换工作空间根目录（默认 <项目>/workspace）
#   AI_COMPANY_NO_OPEN=1       start / restart 后不自动开浏览器
#
# 只依赖 macOS 自带命令（launchctl / lsof / curl / plutil）。

set -uo pipefail

LABEL="com.aicompany.web-ui"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# ---------- 定位项目根目录（支持从 /usr/local/bin 的软链调用） ----------

SELF="$0"
while [ -L "$SELF" ]; do
    TARGET="$(readlink "$SELF")"
    case "$TARGET" in
        /*) SELF="$TARGET" ;;
        *) SELF="$(dirname "$SELF")/$TARGET" ;;
    esac
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

NODE_BIN="/opt/homebrew/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"

PORT="${AI_COMPANY_PORT:-7788}"
# 从 plist 里读出实际参数，避免「上次用 7790 启动、这次忘了带环境变量」导致状态看错
read_arg_from_plist() {
    local flag="$1"
    [ -f "$PLIST" ] || return 0
    /usr/bin/plutil -extract ProgramArguments xml1 -o - "$PLIST" 2>/dev/null \
        | awk -v f="$flag" '$0 ~ "<string>" f "</string>" {getline; gsub(/.*<string>|<\/string>.*/,""); print; exit}'
}
if [ -z "${AI_COMPANY_PORT:-}" ]; then
    PLIST_PORT="$(read_arg_from_plist --port || true)"
    [ -n "${PLIST_PORT:-}" ] && PORT="$PLIST_PORT"
fi

# 监听地址：默认只本机；0.0.0.0 = 局域网可访问（无鉴权，只限可信内网）
HOST="${AI_COMPANY_HOST:-}"
if [ -z "${HOST:-}" ]; then
    HOST="$(read_arg_from_plist --host || true)"
fi
HOST="${HOST:-127.0.0.1}"

# 展示/打开用的地址：0.0.0.0 与 :: 不能直接给浏览器
URL_HOST="$HOST"
case "$HOST" in
    0.0.0.0|::|"[::]") URL_HOST="127.0.0.1" ;;
esac
URL="http://$URL_HOST:$PORT/"

DB_PATH="${AI_COMPANY_DB:-}"
WS_PATH="${AI_COMPANY_WORKSPACE:-}"
LOG_DIR="$ROOT/workspace/logs"
OUT_LOG="$LOG_DIR/server.log"
ERR_LOG="$LOG_DIR/server.err.log"

# ---------- 小工具 ----------

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

job_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

job_pid() {
    launchctl list 2>/dev/null | awk -v l="$LABEL" '$3==l {print $1; exit}'
}

listener_pid() {
    lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1
}

healthy() {
    curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/org" 2>/dev/null
}

uptime_of() {
    ps -p "$1" -o etime= 2>/dev/null | tr -d ' '
}

# 数据库锁：pid 已死的残留锁删掉。
# 锁被活进程持有时分两种：就是本服务自己的 pid（正常，静默放过）；
# 或者是别的实例（真冲突，必须让调用方停下，否则两个写者会把在跑的服务搞崩）。
clean_stale_lock() {
    local lock="$ROOT/workspace/company.sqlite.lock"
    [ -n "$DB_PATH" ] && lock="$(cd "$(dirname "$DB_PATH")" 2>/dev/null && pwd)/$(basename "$DB_PATH").lock"
    [ -f "$lock" ] || return 0
    local holder own
    holder="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$lock" | head -1)"
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
        own="$(job_pid)"
        if [ "$holder" = "$own" ]; then
            return 0   # 本服务自己持锁，正常
        fi
        warn "数据库被进程 $holder 占用（不是本服务的 pid），可能有另一个实例在跑，先停掉它"
        return 1
    fi
    rm -f "$lock" && ok "清掉残留数据库锁（pid ${holder:-未知} 已不在）"
}

# 生成 / 更新 plist。返回 0=没变化，1=有变化（需要重新 bootstrap）
write_plist() {
    mkdir -p "$HOME/Library/LaunchAgents"
    local tmp extra=""
    if [ -n "$DB_PATH" ]; then
        extra="$extra
    <string>--db</string>
    <string>$DB_PATH</string>"
    fi
    if [ -n "$WS_PATH" ]; then
        extra="$extra
    <string>--workspace</string>
    <string>$WS_PATH</string>"
    fi
    # 监听地址显式写进 plist（默认 127.0.0.1 也写，方便状态里读回来）
    if [ -n "$HOST" ]; then
        extra="$extra
    <string>--host</string>
    <string>$HOST</string>"
    fi

    tmp="$(mktemp)"
    cat > "$tmp" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <!-- 一人公司网页界面：launchd 托管，后台常驻，不占终端 -->
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--experimental-strip-types</string>
    <string>$ROOT/src/server/main.ts</string>
    <string>--port</string>
    <string>$PORT</string>
    <string>--no-open</string>$extra
  </array>

  <!-- 必须绝对路径：main.ts 用 process.cwd() 推导默认库位置 -->
  <key>WorkingDirectory</key>
  <string>$ROOT</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>$OUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$ERR_LOG</string>

  <!-- 登录即启动 -->
  <key>RunAtLoad</key>
  <true/>

  <!-- 异常退出才拉起；正常退出不纠缠 -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

    if [ -f "$PLIST" ] && cmp -s "$tmp" "$PLIST"; then
        rm -f "$tmp"
        return 0
    fi
    mv "$tmp" "$PLIST"
    return 1
}

wait_healthy() {
    local i=0
    while [ "$i" -lt 60 ]; do
        if healthy; then return 0; fi
        sleep 0.5
        i=$((i + 1))
    done
    return 1
}

open_page() {
    [ "${AI_COMPANY_NO_OPEN:-0}" = "1" ] && return 0
    open "$URL" 2>/dev/null || true
}

show_status() {
    local pid holder
    pid="$(job_pid)"
    say ""
    say "  一人公司 · 服务状态"
    say "  ─────────────────────────────"
    say "  地址   $URL"
    say "  监听   $HOST:$PORT"
    if [ "$HOST" = "0.0.0.0" ] || [ "$HOST" = "::" ] || [ "$HOST" = "[::]" ]; then
        warn "局域网可访问（无鉴权，只应在可信内网使用；不要做公网端口映射）"
    fi

    if job_loaded; then
        ok "launchd 已注册（${LABEL}）"
    else
        bad "launchd 未注册（跑 ai-company-start 启动）"
    fi

    if [ -n "${pid:-}" ] && [ "$pid" != "-" ]; then
        ok "进程   pid $pid · 已运行 $(uptime_of "$pid")"
    else
        bad "进程   不在运行"
    fi

    if healthy; then
        ok "健康   /api/org 正常响应"
    else
        bad "健康   端口 $PORT 无响应"
    fi

    # 待你拍板数量：只在健康时取，失败不影响状态展示
    if healthy; then
        local pending
        pending="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/api/pending" 2>/dev/null \
            | grep -o '"id"' | wc -l | tr -d ' ')"
        say "  待办   ${pending:-0} 条待你拍板"
    fi

    holder="$(listener_pid)"
    if [ -n "${holder:-}" ] && [ "${holder:-}" != "${pid:-}" ]; then
        warn "端口 $PORT 由非本服务的进程 $holder 占用"
    fi
    say ""
}

# ---------- 动作 ----------

do_start() {
    if [ -z "$NODE_BIN" ]; then
        bad "找不到 node（需要 Node >= 22.19；brew install node）"
        exit 1
    fi
    if [ ! -f "$ROOT/src/server/main.ts" ]; then
        bad "找不到 $ROOT/src/server/main.ts，脚本可能被移到了项目外"
        exit 1
    fi

    say ""
    say "启动一人公司 · $URL"

    # 已经在跑且健康：什么都不动（幂等），尤其不要碰数据库锁
    if job_loaded && healthy; then
        ok "服务已在运行（pid $(job_pid)），无需重启"
        open_page
        show_status
        return 0
    fi

    # 端口被别的进程占着：直接说清楚，不要拉起来再崩成 EADDRINUSE
    local holder
    holder="$(listener_pid)"
    if [ -n "${holder:-}" ]; then
        bad "端口 $PORT 已被进程 $holder 占用："
        ps -p "$holder" -o pid=,command= 2>/dev/null | sed 's/^/      /'
        exit 1
    fi

    mkdir -p "$LOG_DIR"
    clean_stale_lock || exit 1

    local changed=0
    write_plist || changed=1

    if job_loaded; then
        [ "$changed" = "1" ] && { launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true; sleep 1; }
        ok "配置有变化或进程僵住，重启服务"
        launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    else
        launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null \
            || launchctl load -w "$PLIST" >/dev/null 2>&1 \
            || { bad "launchctl 加载失败，看 $ERR_LOG"; exit 1; }
    fi

    if wait_healthy; then
        ok "已就绪（pid $(job_pid)）"
        ok "日志 $OUT_LOG"
        open_page
        show_status
    else
        bad "启动后 30 秒内端口 $PORT 仍无响应"
        say "  最近的错误日志："
        tail -20 "$ERR_LOG" 2>/dev/null | sed 's/^/      /'
        say "  完整输出：$OUT_LOG"
        exit 1
    fi
}

do_stop() {
    say ""
    say "停止一人公司 · $URL"

    if job_loaded; then
        launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
        # 等进程真正退出，最多 10 秒（要留时间落盘事件、释放数据库锁）
        local i=0
        while [ "$i" -lt 40 ]; do
            [ -z "$(listener_pid)" ] && [ -z "$(job_pid | grep -v '^-$' || true)" ] && break
            sleep 0.25
            i=$((i + 1))
        done
        ok "已停止（launchd 不会再自动拉起）"
    else
        warn "launchd 未注册，服务本来就没在跑"
    fi

    local holder
    holder="$(listener_pid)"
    if [ -n "${holder:-}" ]; then
        bad "端口 $PORT 仍被进程 $holder 占用"
        ps -p "$holder" -o pid=,command= 2>/dev/null | sed 's/^/      /'
        say "  这不是本脚本启动的进程，不替你杀；确认后可用：kill $holder"
        exit 1
    fi

    clean_stale_lock || true
    show_status
}

do_restart() {
    say ""
    say "重启一人公司 · $URL"
    if ! job_loaded; then
        do_start
        return
    fi
    clean_stale_lock || true
    write_plist >/dev/null || true
    launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 \
        || { bad "kickstart 失败，改用 stop + start"; do_stop >/dev/null 2>&1; do_start; return; }
    if wait_healthy; then
        ok "已重启（pid $(job_pid)）· 数据与在途任务保留"
        open_page
        show_status
    else
        bad "重启后 30 秒内无响应，看 $ERR_LOG"
        tail -20 "$ERR_LOG" 2>/dev/null | sed 's/^/      /'
        exit 1
    fi
}

do_logs() {
    mkdir -p "$LOG_DIR"
    say "跟踪日志（Ctrl+C 只退出跟踪，不影响服务）："
    say "  $OUT_LOG"
    say "  $ERR_LOG"
    say ""
    tail -n 40 -f "$OUT_LOG" "$ERR_LOG" 2>/dev/null
}

case "$(basename "$0")" in
    ai-company-start) CMD=start ;;
    ai-company-stop)  CMD=stop ;;
    *)                CMD="${1:-status}" ;;
esac
case "$CMD" in
    start)   do_start ;;
    stop)    do_stop ;;
    restart|r) do_restart ;;
    status|s) show_status ;;
    logs|log) do_logs ;;
    open)     open_page ;;
    *)
        say "用法：$(basename "$0") {start|stop|restart|status|logs|open}"
        exit 2
        ;;
esac
