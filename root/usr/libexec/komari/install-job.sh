#!/bin/sh
# Komari Agent 下载安装任务（由 rpcd ucode 插件以 setsid 方式拉起）
# 参数：$1=下载URL  $2=期望sha256  $3=期望字节数  $4=版本号  $5=镜像前缀（可空）
# 所有参数在调用前已由插件做格式校验；本脚本只做机械动作。
#
# 下载顺序：配了镜像就先镜像、失败再直连 GitHub；没配镜像只直连。
# 期望 SHA256 来自 GitHub API，经镜像取回的文件仍受同一摘要约束，镜像无法伪造内容。
# 每个源只试一次，超时由 uclient-fetch 的 --timeout 兜住，不会无限挂起在「正在下载」。

URL="$1"
DIGEST="$2"
SIZE="$3"
VERSION="$4"
MIRROR="$5"

S=/tmp/komari.install.status
T=/tmp/komari-agent.download
E=/tmp/komari-agent.fetch.err
NEW=/usr/bin/.komari-agent.new
DEST=/usr/bin/komari-agent
VERDIR=/usr/share/komari-agent
TIMEOUT=20

# message/src 会直接进前端 JSON，必须去掉引号/反斜杠/换行
# 注意不要用 cut 截断：busybox cut 按字节切，会把中文尾部切成半个字符
clean() {
	printf '%s' "$1" | tr -d '"' | tr -d '\\' | tr '\n\r\t' '   '
}

# ts/pid 供插件判断「任务是否还活着」「卡了多久」；
# src 是当前下载源的名字，插件据它把 connecting 改写成 downloading。
st() {
	printf '{"phase":"%s","message":"%s","total":%s,"ts":%s,"pid":%s,"src":"%s"}\n' \
		"$1" "$(clean "$2")" "$SIZE" "$(date +%s)" "$$" "$(clean "$3")" > "$S"
}

# 候选源：配了镜像就镜像优先，直连作为回退
if [ -n "$MIRROR" ]; then
	set -- "${MIRROR}${URL}" "$URL"
else
	set -- "$URL"
fi

OK=0
ERR=''

for SRC in "$@"; do
	HOST=${SRC#*://}
	HOST=${HOST%%/*}
	[ -z "$HOST" ] && HOST=unknown

	case "$SRC" in
		"${MIRROR:-__none__}"*)
			LABEL="镜像 $HOST"
			;;
		*)
			LABEL="GitHub 直连"
			;;
	esac

	st connecting '' "$LABEL"

	rm -f "$T" "$E"
	if uclient-fetch -q -O "$T" --timeout="$TIMEOUT" "$SRC" 2>"$E"; then
		OK=1
		break
	fi

	REASON=$(tail -n 1 "$E" 2>/dev/null)
	[ -z "$REASON" ] && REASON='连接超时或被拒绝'
	ERR="${ERR}${HOST}: ${REASON}; "
done
rm -f "$E"

if [ "$OK" != "1" ]; then
	ERR=$(printf '%s' "$ERR" | sed 's/[; ]*$//')
	if [ -n "$MIRROR" ]; then
		st error "下载失败：$ERR"
	else
		st error "下载失败：$ERR；可在「下载设置」开启镜像并填写前缀，或手动上传二进制"
	fi
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
