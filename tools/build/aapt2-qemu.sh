#!/usr/bin/env bash
# aapt2 代理：在 aarch64 Linux 上，用 qemu-user 跑 Android build-tools 里自带的 x86_64 aapt2。
#
# 背景：Google 发布的 build-tools / AGP 依赖的 aapt2 只有 linux-x86_64、windows、darwin 产物，
#       aarch64 主机上直接跑会报 "cannot execute binary file" 或 "exec format error"。
#       AGP 提供了 -Pandroid.aapt2FromMavenOverride=<file> 用来指定自定义 aapt2，
#       把它指向本脚本即可完成整个 assembleDebug。
#
# 前置：
#   qemu-x86_64-static（Debian/Ubuntu: qemu-user-static 提供）位于 PATH
#   X86ROOT 指向一个装了 amd64 版 libc6 / libstdc++6 / libgcc-s1 / zlib1g 的目录（见 docs/09）
#   AAPT2 指向 build-tools 里的 aapt2（默认 $ANDROID_SDK_ROOT/build-tools/34.0.0/aapt2）
#
# 用法：
#   ./gradlew assembleDebug -Pandroid.aapt2FromMavenOverride="$PWD/../tools/build/aapt2-qemu.sh"
exec "${QEMU:-qemu-x86_64-static}" -L "${X86ROOT:-/opt/x86root}" \
     "${AAPT2:-${ANDROID_SDK_ROOT:-/opt/android-sdk}/build-tools/34.0.0/aapt2}" "$@"
