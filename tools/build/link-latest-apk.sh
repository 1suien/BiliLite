#!/usr/bin/env bash
# 把仓库根的 BiliLite-latest.apk 软链指到版本号最大的 BiliLite-x.y.z-debug.apk。
#
# 用途：给浏览器一个「固定文件名」的下载入口
#   http://127.0.0.1:3080/dl/BiliLite-latest.apk
# 每次出完新包跑一遍本脚本，重复下载同名文件时选择「替换」即可覆盖本地那份。
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

latest="$(ls -1 BiliLite-[0-9]*.[0-9]*.[0-9]*-debug.apk 2>/dev/null | sort -V | tail -1)"
if [ -z "${latest}" ]; then
  echo "没有找到 BiliLite-x.y.z-debug.apk（请先在仓库根放好构建产物）" >&2
  exit 1
fi

ln -sfn "${latest}" BiliLite-latest.apk
echo "BiliLite-latest.apk -> ${latest}"
