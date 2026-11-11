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

# 时区：优先使用系统 zoneinfo；OpenWrt 默认不装（/etc/localtime 只是文本 "CST-8"，
# Go 无法解析会退回 UTC），此时回退到插件自带的 Asia/Shanghai TZif 文件。
TZ_NAME=$(uci -q get system.@system[0].zonename)
TZ_POSIX=$(uci -q get system.@system[0].timezone)
if [ -n "$TZ_NAME" ] && [ -f "/usr/share/zoneinfo/$TZ_NAME" ]; then
	export TZ="$TZ_NAME"
elif [ "$TZ_POSIX" = "CST-8" ] && [ -f /usr/share/komari-agent/tzif/Asia/Shanghai ]; then
	export TZ=/usr/share/komari-agent/tzif/Asia/Shanghai
else
	export TZ=UTC
fi

echo "$(date '+%Y/%m/%d %H:%M:%S') --- komari-agent starting ---" >> "$LOG"

# exec 保持 PID 不变，procd 仍能正确跟踪/回收
exec /usr/bin/komari-agent "$@" >> "$LOG" 2>&1
