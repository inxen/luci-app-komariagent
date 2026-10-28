# SPDX-License-Identifier: MIT
#
# luci-app-komari —— Komari Agent 的 LuCI 控制器
# Agent 二进制不随包分发，由 LuCI 从 GitHub Release 下载或手动上传。

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-komari
PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=inxen

include $(INCLUDE_DIR)/package.mk

# 纯文件包：没有上游源码，显式声明空的构建步骤
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
endef

define Package/luci-app-komari
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=Komari Agent controller
  DEPENDS:=+luci-base +ca-bundle
  PKGARCH:=all
  URL:=https://github.com/komari-monitor/komari-agent
endef

define Package/luci-app-komari/description
 Komari Agent 控制器：配置、运行状态、日志，以及从 GitHub Release
 检查更新/安装或手动上传 Agent 二进制。二进制不随本包分发。
endef

define Package/luci-app-komari/conffiles
/etc/config/komari_agent
endef

define Package/luci-app-komari/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	chmod 600 /etc/config/komari_agent 2>/dev/null
	/etc/init.d/komari-agent enable 2>/dev/null
	/etc/init.d/rpcd restart 2>/dev/null
}
exit 0
endef

define Package/luci-app-komari/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/komari-agent stop 2>/dev/null
	/etc/init.d/komari-agent disable 2>/dev/null
}
exit 0
endef

define Package/luci-app-komari/install
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_DIR) $(1)/usr/libexec/komari
	$(INSTALL_DIR) $(1)/usr/share/rpcd/ucode
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/komari

	$(INSTALL_CONF) ./root/etc/config/komari_agent $(1)/etc/config/komari_agent
	$(INSTALL_BIN) ./root/etc/init.d/komari-agent $(1)/etc/init.d/komari-agent
	$(INSTALL_BIN) ./root/etc/uci-defaults/60_luci-komari $(1)/etc/uci-defaults/60_luci-komari
	$(INSTALL_BIN) ./root/usr/libexec/komari/install-job.sh $(1)/usr/libexec/komari/install-job.sh

	$(INSTALL_DATA) ./root/usr/share/rpcd/ucode/komari $(1)/usr/share/rpcd/ucode/komari
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-komari.json $(1)/usr/share/rpcd/acl.d/luci-app-komari.json
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-komari.json $(1)/usr/share/luci/menu.d/luci-app-komari.json

	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/komari/overview.js $(1)/www/luci-static/resources/view/komari/overview.js
endef

$(eval $(call BuildPackage,luci-app-komari))
