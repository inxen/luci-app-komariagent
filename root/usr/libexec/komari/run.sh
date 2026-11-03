#!/bin/sh
# Komari Agent 启动包装
#
# 目的：agent 的 stdout/stderr 写入 tmpfs 文件（/tmp/log，内存），
# 不进入 OpenWrt 系统日志（logd/syslog）。
#
# 由 /etc/init.d/komari-agent 以 procd 主实例方式调用，参数原样透传。

LOG_DIR=/tmp/log
LOG=$LOG_DIR/komari-agent.log

MAX_KB=$(uci -q get komari_agent.agent.log_max_size)
case "$MAX_KB" in ''|*[!0-9]*) MAX_KB=256 ;; esac
[ "$MAX_KB" -lt 32 ] && MAX_KB=32
LIMIT=$((MAX_KB * 1024))

mkdir -p "$LOG_DIR"
[ -f "$LOG" ] || : > "$LOG"
chmod 644 "$LOG" 2>/dev/null

# 启动前按上限裁剪，保留尾部一半
if [ -f "$LOG" ]; then
	SZ=$(wc -c < "$LOG" 2>/dev/null)
	if [ -n "$SZ" ] && [ "$SZ" -gt "$LIMIT" ]; then
		tail -c $((LIMIT / 2)) "$LOG" > "$LOG.tmp" 2>/dev/null &&
			cat "$LOG.tmp" > "$LOG" && rm -f "$LOG.tmp"
	fi
fi

# 与 agent 自身日志统一用 UTC（LuCI 页面负责转本地时区显示）
echo "$(date -u '+%Y/%m/%d %H:%M:%S') --- komari-agent starting ---" >> "$LOG"

# exec 保持 PID 不变，procd 仍能正确跟踪/回收
exec /usr/bin/komari-agent "$@" >> "$LOG" 2>&1
