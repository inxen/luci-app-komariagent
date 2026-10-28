#!/usr/bin/env python3
"""Assemble an OpenWrt .ipk (opkg) package without the SDK.

Local packaging helper: produces the same file layout as the buildroot
package output. Release builds use the OpenWrt SDK or GitHub Actions,
see .github/workflows/build.yml.

The produced package uses the OpenWrt 24.10+ layout: a gzip-compressed tar
containing ./debian-binary, ./data.tar.gz and ./control.tar.gz (the legacy
ar-based ipk is no longer produced by the buildroot).

Usage:
    python scripts/build-ipk.py [--out dist] [--version 0.1.0] [--release 1]
"""
import argparse
import gzip
import hashlib
import io
import posixpath
import re
import tarfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG_NAME = "luci-app-komari"

# (source relative to repo root, destination inside package, mode)
FILES = [
    ("root/etc/config/komari_agent", "etc/config/komari_agent", 0o600),
    ("root/etc/init.d/komari-agent", "etc/init.d/komari-agent", 0o755),
    ("root/etc/uci-defaults/60_luci-komari", "etc/uci-defaults/60_luci-komari", 0o755),
    ("root/usr/libexec/komari/install-job.sh", "usr/libexec/komari/install-job.sh", 0o755),
    ("root/usr/share/rpcd/ucode/komari", "usr/share/rpcd/ucode/komari", 0o644),
    ("root/usr/share/rpcd/acl.d/luci-app-komari.json", "usr/share/rpcd/acl.d/luci-app-komari.json", 0o644),
    ("root/usr/share/luci/menu.d/luci-app-komari.json", "usr/share/luci/menu.d/luci-app-komari.json", 0o644),
    ("htdocs/luci-static/resources/view/komari/overview.js", "www/luci-static/resources/view/komari/overview.js", 0o644),
]

POSTINST = """#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
\tchmod 600 /etc/config/komari_agent 2>/dev/null
\t/etc/init.d/komari-agent enable 2>/dev/null
\t/etc/init.d/rpcd restart 2>/dev/null
}
exit 0
"""

PRERM = """#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] || {
\t/etc/init.d/komari-agent stop 2>/dev/null
\t/etc/init.d/komari-agent disable 2>/dev/null
}
exit 0
"""


def read_makefile_version():
    text = (ROOT / "Makefile").read_text(encoding="utf-8")
    ver = re.search(r"^PKG_VERSION:=(.+)$", text, re.M)
    rel = re.search(r"^PKG_RELEASE:=(.+)$", text, re.M)
    return (ver.group(1).strip() if ver else "0.0.1",
            rel.group(1).strip() if rel else "1")


def make_tar_gz(entries, epoch, root_entry=True):
    """entries: list of (name, data|None, mode) — None data means directory."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.GNU_FORMAT) as tf:
        if root_entry:
            ti = tarfile.TarInfo("./")
            ti.mode = 0o755
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            ti.mtime = epoch
            ti.type = tarfile.DIRTYPE
            tf.addfile(ti)
        for name, data, mode in entries:
            ti = tarfile.TarInfo(name)
            ti.mode = mode
            ti.uid = 0
            ti.gid = 0
            ti.uname = "root"
            ti.gname = "root"
            ti.mtime = epoch
            if data is None:
                ti.type = tarfile.DIRTYPE
                ti.size = 0
                tf.addfile(ti)
            else:
                ti.size = len(data)
                tf.addfile(ti, io.BytesIO(data))
    return gzip.compress(buf.getvalue(), compresslevel=9, mtime=epoch)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="dist")
    ap.add_argument("--version", default=None)
    ap.add_argument("--release", default=None)
    args = ap.parse_args()

    ver, rel = read_makefile_version()
    version = args.version or ver
    release = args.release or rel
    epoch = int(time.time())

    data_entries = []
    all_dirs = {"etc", "usr", "www"}
    for _, dest, _ in FILES:
        parent = posixpath.dirname(dest)
        parts = parent.split("/") if parent else []
        for i in range(1, len(parts) + 1):
            all_dirs.add("/".join(parts[:i]))
    for d in sorted(all_dirs):
        data_entries.append(("./" + d + "/", None, 0o755))

    installed_size = 0
    for src, dest, mode in FILES:
        data = (ROOT / src).read_bytes()
        installed_size += len(data)
        data_entries.append(("./" + dest, data, mode))

    control = (
        f"Package: {PKG_NAME}\n"
        f"Version: {version}-r{release}\n"
        "Depends: luci-base, ca-bundle\n"
        "Source: package/luci-app-komari\n"
        f"SourceName: {PKG_NAME}\n"
        "License: MIT\n"
        "Section: luci\n"
        "Category: LuCI\n"
        f"SourceDateEpoch: {epoch}\n"
        "URL: https://github.com/komari-monitor/komari-agent\n"
        "Architecture: all\n"
        f"Installed-Size: {installed_size}\n"
        "Description: LuCI 控制器：Komari Agent 的配置、状态、日志与手动更新"
        "（Agent 二进制不随包分发，由页面从 GitHub 下载或手动上传）\n"
    )

    control_entries = [
        ("./control", control.encode(), 0o644),
        ("./conffiles", b"/etc/config/komari_agent\n", 0o644),
        ("./postinst", POSTINST.encode(), 0o755),
        ("./prerm", PRERM.encode(), 0o755),
    ]

    pkg_tar = make_tar_gz(
        [
            ("./debian-binary", b"2.0\n", 0o644),
            ("./control.tar.gz", make_tar_gz(control_entries, epoch), 0o644),
            ("./data.tar.gz", make_tar_gz(data_entries, epoch), 0o644),
        ],
        epoch,
        root_entry=False,
    )

    out_dir = ROOT / args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{PKG_NAME}_{version}-r{release}_all.ipk"
    out_file.write_bytes(pkg_tar)

    print(f"built: {out_file}")
    print(f"size:  {len(pkg_tar)} bytes")
    print(f"sha256: {hashlib.sha256(pkg_tar).hexdigest()}")


if __name__ == "__main__":
    main()
