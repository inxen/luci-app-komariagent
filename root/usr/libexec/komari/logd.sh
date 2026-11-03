#!/bin/sh
# Komari Agent 日志大小守护
#
# /tmp 是 tmpfs，日志占的是内存；断连重连风暴时日志会快速增长。
# 每 20 秒检查一次，超过 log_max_size（KB）就裁掉前半部分，只保留尾部一半。
#
# 裁剪用 "cat tmp > log" 而不是 mv，保持 inode 不变，
# 这样 agent 已打开的 fd 仍然指向同一个文件，不会写到已删除的 inode 上。

LOG=/tmp/log/komari-agent.log

while :; do
	MAX_KB=$(uci -q get komari_agent.agent.log_max_size)
	case "$MAX_KB" in ''|*[!0-9]*) MAX_KB=256 ;; esac
	[ "$MAX_KB" -lt 32 ] && MAX_KB=32
	LIMIT=$((MAX_KB * 1024))

	if [ -f "$LOG" ]; then
		SZ=$(wc -c < "$LOG" 2>/dev/null)
		if [ -n "$SZ" ] && [ "$SZ" -gt "$LIMIT" ]; then
			tail -c $((LIMIT / 2)) "$LOG" > "$LOG.tmp" 2>/dev/null &&
				cat "$LOG.tmp" > "$LOG" && rm -f "$LOG.tmp"
		fi
	fi

	sleep 20
done
