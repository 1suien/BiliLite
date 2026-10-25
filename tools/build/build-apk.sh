#!/usr/bin/env bash
# 从 app/ 源码构建 BiliLite 0.4.4 debug APK。
#
# 前置（x86_64 Linux / macOS / Windows 的常规机器）：
#   - Node 20+、npm
#   - JDK 17（JAVA_HOME 指向它；Gradle 8.2.1 不支持 JDK 21+）
#   - Android SDK：platforms;android-34、build-tools;34.0.0（ANDROID_SDK_ROOT）
# 在 aarch64 上跑时 aapt2 只有 x86_64 版本，需要 tools/build/aapt2-qemu.sh 代理
# （或 /opt/toolchain/aapt2-bin/aapt2），并把 qemu-x86_64-static 放进 PATH，
# 见 docs/09-生成可安装APK.md。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"

cd "$ROOT/app"

npm install
npm run build                        # dist/
npm run sync                         # cap sync android → app/android/app/src/main/assets/public

cd android
if [ -n "$SDK" ]; then
  printf 'sdk.dir=%s\n' "$SDK" > local.properties
fi

# aarch64 主机：加 -Pandroid.aapt2FromMavenOverride=/path/to/tools/build/aapt2-qemu.sh
./gradlew assembleDebug

echo
echo "APK: $ROOT/app/android/app/build/outputs/apk/debug/app-debug.apk"
ls -l app/build/outputs/apk/debug/app-debug.apk
