#!/bin/sh
# Komari Agent 下载安装任务（由 rpcd ucode 插件以 setsid 方式拉起）
# 参数：$1=下载URL  $2=期望sha256  $3=期望字节数  $4=版本号
# 所有参数在调用前已由插件做格式校验；本脚本只做机械动作。

URL="$1"
DIGEST="$2"
SIZE="$3"
VERSION="$4"

S=/tmp/komari.install.status
T=/tmp/komari-agent.download
NEW=/usr/bin/.komari-agent.new
DEST=/usr/bin/komari-agent
VERDIR=/usr/share/komari-agent

st() {
	printf '{"phase":"%s","message":"%s","total":%s}\n' "$1" "$2" "$SIZE" > "$S"
}

st downloading "正在下载"
rm -f "$T"

if ! uclient-fetch -q -O "$T" --timeout=30 "$URL" >/dev/null 2>&1; then
	st error "下载失败（网络不可达或 GitHub 拒绝连接）"
	rm -f "$T"
	exit 1
fi

GOT=$(wc -c < "$T")
if [ "$GOT" != "$SIZE" ]; then
	st error "大小校验失败：收到 $GOT 字节，期望 $SIZE"
	rm -f "$T"
	exit 1
fi

st verifying "正在校验 SHA256"
ACT=$(sha256sum "$T" | cut -d' ' -f1)
if [ "$ACT" != "$DIGEST" ]; then
	st error "SHA256 校验失败（文件可能被篡改或下载损坏）"
	rm -f "$T"
	exit 1
fi

st installing "正在安装"
if ! { cp -f "$T" "$NEW" && chmod 0755 "$NEW" && mv -f "$NEW" "$DEST"; }; then
	st error "写入 $DEST 失败"
	rm -f "$T"
	exit 1
fi

mkdir -p "$VERDIR"
printf '%s\n' "$VERSION" > "$VERDIR/version"
rm -f "$T"

st done "安装完成"
if [ "$(uci -q get komari_agent.agent.enabled)" = "1" ]; then
	/etc/init.d/komari-agent restart >/dev/null 2>&1
fi
exit 0
