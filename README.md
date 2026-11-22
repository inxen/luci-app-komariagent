# luci-app-komari

Komari Agent 的 LuCI 管理插件，只做控制器，**不打包 Agent 二进制**。

二进制的获取有两条路径，都在页面内完成：

- 从 GitHub Release 检查并安装（安装前校验 SHA256）
- 手动上传本地二进制（校验 ELF / ARM64 头后原子替换）

上游 Agent：<https://github.com/komari-monitor/komari-agent>（MIT）

## 特性

单页界面：**服务 → Komari Agent**

- **服务状态**：二进制是否已安装及大小、procd 运行状态与 PID、版本、服务端探测（`/ping` + `/api/version`）、最近一次 WebSocket 连接成功时间、最近错误
- **更新与安装**：检查 GitHub 最新 Release，显示版本 / 发布时间 / 资产大小 / SHA256；后台下载并安装，页面轮询进度；也可手动上传二进制
- **下载设置**：开关决定是否用镜像（关闭＝只直连 GitHub），镜像前缀由用户填写，可换成任意其他镜像站。开启后先镜像、失败回退直连；SHA256 仍以 GitHub API 返回值为准，镜像无法替换内容
- **连接设置**：服务端地址、Agent Token（不回显，留空保持不变）、上报间隔、禁用远程控制、忽略 TLS 证书错误
- **采集范围**：网卡过滤（默认仅 `pppoe-wan`）、挂载点过滤（默认仅 `/`）、重连间隔、最大重试次数
- **日志**：写入 `/tmp/log`（tmpfs 内存，不占闪存、不写系统日志），大小上限可配置，超过后自动裁剪；页面展示最近记录，Token 自动脱敏，时间跟随系统时区
- 启动 / 停止 / 重启，带确认

## 安全默认

| 项 | 默认 | 说明 |
|---|---|---|
| 远程控制（Web SSH / 远程命令 / 文件管理） | 禁用 | 开启等于把本机 root 交给面板管理员 |
| Agent 自更新 | 强制禁用 | 二进制由本插件管理，避免绕过包管理器改动文件 |
| TLS 证书校验 | 开启 | 仅自签名证书且知情时关闭 |
| Token 存储 | `/etc/config/komari_agent` 权限 600 | 经环境变量传入进程，不进 `ps` 可见的 cmdline |
| Token 显示 | 不回显 | 日志输出前自动脱敏 |

## 目录结构

```
luci-app-komari/
├── Makefile                              # OpenWrt 包定义（PKGARCH:=all）
├── LICENSE
├── root/
│   ├── etc/config/komari_agent           # UCI 默认配置（conffile, 0600）
│   ├── etc/init.d/komari-agent           # procd 服务
│   ├── etc/uci-defaults/60_luci-komari   # 收紧配置权限
│   ├── usr/libexec/komari/install-job.sh # 下载安装任务（下载→校验→原子替换）
│   └── usr/share/
│       ├── rpcd/ucode/komari             # rpcd 插件：状态/探测/更新/上传/服务动作
│       ├── rpcd/acl.d/luci-app-komari.json
│       └── luci/menu.d/luci-app-komari.json
├── htdocs/luci-static/resources/view/komari/overview.js
├── scripts/build-ipk.py                  # 不依赖 SDK 的本地打包脚本
└── .github/workflows/build.yml           # CI：24.10 ipk / 25.12 apk / ImmortalWrt 25.12 apk
```

## 构建

**本地打包（无需 SDK）**

```sh
python3 scripts/build-ipk.py
# 产物：dist/luci-app-komari_<version>-r<release>_all.ipk
```

OpenWrt 24.10 的 `.ipk` 是 gzip 包裹的 tar（`./debian-binary`、`./control.tar.gz`、`./data.tar.gz`），
脚本按该格式生成。

**SDK 构建**

```sh
mkdir -p package && cp -a /path/to/luci-app-komari package/
make defconfig
make package/luci-app-komari/compile V=s
# 产物：bin/packages/<arch>/base/luci-app-komari_*
```

**GitHub Actions**

`.github/workflows/build.yml` 覆盖 OpenWrt 24.10（ipk）、OpenWrt 25.12（apk）、
ImmortalWrt 25.12（apk）；推送 `v*` 标签时自动创建 Release 并附加产物。

> 25.12 的 apk 是 apk-tools 3 的包格式，需要用 SDK 或 CI 构建，不能像 ipk 那样手工拼装。

## 安装

```sh
# OpenWrt 24.10（opkg）
opkg install luci-app-komari_*_all.ipk

# OpenWrt 25.12+ / ImmortalWrt 25.12（apk）
apk add --allow-untrusted luci-app-komari-*.apk
```

安装后 rpcd 会由 postinst 重启，菜单出现在「服务 → Komari Agent」。

## 使用

1. 打开「服务 → Komari Agent」
2. 「更新与安装」里点 **检查更新** → **安装此版本**（或手动上传）
3. 「连接设置」填服务端地址与 Token（在 Komari 面板添加节点后获取），勾选「启用服务」
4. **保存并应用**，回到顶部确认状态为「运行中」；「测试连接」可验证服务端可达性

## 下载与镜像

`api.github.com` 在境内通常可达（检查更新能拿到版本与 SHA256），但 Release 资产所在的
`github.com` / `release-assets.githubusercontent.com` 经常连不通，表现为进度条长时间停在
`正在下载（0 B / x MB）`。插件的处理方式：

1. 「下载设置」决定下载源：开关**关闭**＝只直连 GitHub；**开启**＝先用镜像、失败回退直连
2. 镜像前缀自行填写，可换成任意镜像站（例如 `https://gh-proxy.org/`、`https://ghfast.top/`），
   必须是 `http(s)://主机/路径/` 且以 `/` 结尾；默认留空
3. 单个源连接超时 20 秒，不会无限挂在 `正在下载（0 B / x MB）`
4. 两个源都失败才报错，错误信息里带每个源的真实原因

**校验不受镜像影响**：期望 SHA256 与字节数来自 `api.github.com`，
镜像返回的内容只要有一个字节不同就会被拒绝安装。

## 升级与卸载

- 插件升级：替换 ipk / apk，`/etc/config/komari_agent` 会作为 conffile 保留
- 二进制升级：页面「检查更新」→「安装此版本」，安装前校验 SHA256
- 卸载：`opkg remove luci-app-komari` 或 `apk del luci-app-komari`
  - 保留 `/etc/config/komari_agent`、`/usr/bin/komari-agent`、`/usr/share/komari-agent/`
  - 彻底清除时手工删除以上路径

## 实现说明

- **版本来源**：上游 Agent 没有 `--version`，版本取自安装时写入的
  `/usr/share/komari-agent/version`；手动上传的二进制在启动后从新增日志行 `Komari Agent x.y.z` 回填
- **上传分块**：经 uhttpd 的 ubus JSON-RPC 单次载荷超过约 64KB 会被拒绝，分块取 24KB（base64 约 32KB）
- **参数传递**：配置以 argv 数组交给 procd，不经 shell 二次解析；Token 经 `AGENT_TOKEN` 环境变量传入
- **配置变更**：保存并应用后由页面显式触发服务重载，保证启用状态与进程一致
- **服务管理**：procd 实例级管理，停止/卸载不影响其他进程
- **日志分流**：Agent 的 stdout/stderr 由 `run.sh` 重定向到 `/tmp/log/komari-agent.log`，
  不再经 procd 进入 logd/syslog。`logd.sh` 每 20 秒检查一次，超过 `log_max_size`（KB）
  就裁掉前半部分、保留尾部一半，裁剪时保持 inode 不变以免 Agent 写到已删除的文件上。
  日志文件随重启消失（tmpfs），历史日志只保留在页面上
- **时区**：OpenWrt 的 `/etc/localtime` 是纯文本（`CST-8`），Go 无法解析会退回 UTC。
  `run.sh` 从 UCI `system.@system[0].timezone` 取时区并以 `TZ` 环境变量传给 agent，
  日志时间因此与系统本地时间一致；页面直接展示日志原文，不做二次转换

## 已知限制

- 「服务端探测」只证明 `/ping` 可达，不等同于 Agent 已成功上报
- LuCI 多用户 ACL 仅在 root 下验证过

## License

MIT
