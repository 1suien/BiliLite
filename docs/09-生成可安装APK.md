# 09 生成可安装 APK（2026-10-25 实测通过）

本工程的源码**已经真正构建出可安装的 debug APK**。当前产物是 0.4.4（2026-10-25 从 0.4.3 升级后二次出包），0.4.3 的首次出包记录保留在下面。

## 当前产物：`BiliLite-0.4.4-debug.apk`

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.4-debug.apk` |
| 大小 | 4,107,559 B（官方 0.4.4 APK 是 4,104,456 B） |
| SHA-256 | `d7ceccfe86aa17e582b7b380c26f337acb62e1dd0e09bf4ad031004e5fcc81c0` |
| package | `com.bililite.app` |
| versionCode / versionName | `8` / `0.4.4` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2 |
| 构建 | 增量 `assembleDebug` 55s（264 tasks，29 executed）；`clean assembleDebug` 冷构建 **1m50s**（275 tasks，230 executed） |
| 可复现 | `clean` 后重建的 APK 与增量构建 sha256 **完全相同** |

0.4.4 相对 0.4.3 只同步了 3 处版本号 + 1 处安卓剧场模式 CSS 修复（上游 `v0.4.4`），过程、逐条目比对与校验细节见 [11-0.4.4同步记录.md](11-0.4.4同步记录.md)。要点：

- `aapt dump badging`：versionCode `8` / versionName `0.4.4` / minSdk 22 / target 34 / label `BiliLite`；
- `apksigner verify` v1+v2 通过；`zipalign -c -p 4` 通过；APK 内 `assets/public` 与 `app/dist` 逐字节一致；
- **与官方 0.4.4 APK 逐条目比对**（排除 `assets/public` 与 `META-INF`）：445 个条目中 444 个 sha256 相同，唯一差异是 `assets/capacitor.config.json` 的 `webDir`（`dist` vs `www`，还原工程刻意保留）；4 个 `classes*.dex` / `AndroidManifest.xml` / `resources.arsc` 与官方**逐字节相同**。

## 首次出包记录：`BiliLite-0.4.3-debug.apk`（2026-10-25）

| 项目 | 值 |
|---|---|
| 文件 | `BiliLite-0.4.3-debug.apk`（仓库内保留作对照） |
| 大小 | 4,107,542 B（官方 0.4.3 APK 是 4,104,453 B） |
| SHA-256 | `b4fd3333abe25a1e2881ca142ee187ad7bca0d015398c4cd81babb0e7350abe3` |
| package | `com.bililite.app` |
| versionCode / versionName | `7` / `0.4.3` |
| minSdk / targetSdk / compileSdk | 22 / 34 / 34 |
| 签名 | debug，CN=Android Debug，APK Signature Scheme v1 + v2 |
| 构建 | `./gradlew assembleDebug`，BUILD SUCCESSFUL in 4m 39s，264 tasks |

构建来源：`app/`（还原工程）→ `npm run build` → `npm run sync` → `app/android`（官方 Gradle 工程）→ `gradlew assembleDebug`。中间产物在 `app/android/app/build/outputs/apk/debug/app-debug.apk`。

## 校验结果

```bash
# 包信息
aapt dump badging BiliLite-0.4.4-debug.apk
#   package: name='com.bililite.app' versionCode='8' versionName='0.4.4'
#   sdkVersion:'22'  targetSdkVersion:'34'  application-label:'BiliLite'

# 签名
apksigner verify --verbose BiliLite-0.4.4-debug.apk
#   Verified using v1 scheme (JAR signing): true
#   Verified using v2 scheme (APK Signature Scheme v2): true

# 对齐（resources.arsc 必须 4 字节对齐且不压缩，Android 11+ 强制检查）
zipalign -c -p 4 BiliLite-0.4.4-debug.apk   # → 通过
# zip 检查：resources.arsc compress_type=0（stored）296,232 B

# web 资源与本工程构建产物逐字节一致
unzip -q BiliLite-0.4.4-debug.apk 'assets/public/*'
diff -r assets/public app/dist   # → 无差异
```

0.4.4 出包后原生侧与官方 APK 的关系变了：`classes.dex`（及 `classes2/3/4.dex`）、`AndroidManifest.xml`、`resources.arsc`、`res/**` 与官方 0.4.4 APK **逐字节相同**，唯一差异是 `assets/capacitor.config.json` 的 `webDir`（`dist` vs `www`，还原工程刻意保留）——逐条目比对见 [11-0.4.4同步记录.md](11-0.4.4同步记录.md)。0.4.3 首次出包时这几项与官方不同（当时是本地重新编译、AGP 版本与签名顺序不同），属正常。

## 构建环境（aarch64、无 root、无 Java/SDK 的机器上从零搭出来）

这台机器是 aarch64、非 root、起初没有 JDK / Android SDK，且 `apt-get` 安装需要 root。做法是全部解压到 `/opt/toolchain` 用户目录，不碰系统：

| 组件 | 版本 / 做法 |
|---|---|
| JDK | Temurin **17.0.13** aarch64（Gradle 8.2.1 不支持 JDK 21；Debian 只提供 21，且其 `java.security` 在 `/etc` 下，解压后不可用） |
| Android SDK | cmdline-tools **12.0** → `sdkmanager "platforms;android-34" "build-tools;34.0.0"`（sdkmanager 必须用 JDK 17 跑，JDK 21 的 Debian 包会抛 `JceSecurity` 异常） |
| Gradle | wrapper 自动下载 `gradle-8.2.1-bin.zip`（约 130 MB），依赖从 Google Maven 拉取（缓存约 540 MB） |
| aapt2 | **关键坑**：Google 的 aapt2 只有 x86_64 版。用 `qemu-x86_64-static` + amd64 glibc rootfs（`/opt/x86root`：libc6 / libstdc++6 / libgcc-s1 / zlib1g 的 amd64 deb 解压）跑 `build-tools/34.0.0/aapt2`，再通过 AGP 的 `-Pandroid.aapt2FromMavenOverride=` 指过去（脚本见 `tools/build/aapt2-qemu.sh`） |
| 内存 | 主机剩余内存不足 1 GB，用 `-Dorg.gradle.jvmargs="-Xmx900m -XX:MaxMetaspaceSize=320m"` 临时覆盖（增量构建可用 `-Xmx1200m`），不改 `app/android/gradle.properties` 里的 `-Xmx2560m` |

复现命令（0.4.4 实测通过的形态）：

```bash
cd app
npm run build && npm run typecheck
npm run sync    # = cap sync android

cd android
printf 'sdk.dir=/opt/android-sdk\n' > local.properties
JAVA_HOME=/opt/toolchain/jdk17 PATH=/opt/toolchain/jdk17/bin:$PATH \
GRADLE_USER_HOME=/tmp/gradle-home ./gradlew --no-daemon --max-workers=2 --offline \
  -Pandroid.aapt2FromMavenOverride=/opt/toolchain/aapt2-bin/aapt2 \
  -Dorg.gradle.jvmargs="-Xmx900m -XX:MaxMetaspaceSize=320m -Dfile.encoding=UTF-8" \
  clean assembleDebug
# 产物：app/android/app/build/outputs/apk/debug/app-debug.apk
```

aarch64 上跑之前要把 qemu 加进 PATH（`export PATH=/opt/toolchain/usr/bin:$PATH`，`qemu-x86_64-static` 在 `/opt/toolchain/usr/bin`），aapt2 代理也可换成 `tools/build/aapt2-qemu.sh`；x86_64 机器上不需要 qemu，直接 `tools/build/build-apk.sh`（JDK 17 + Android SDK 即可）。本沙箱 uid 在 `/etc/passwd` 里没有条目，`cap sync` 会抛 `uv_os_get_passwd returned ENOENT`，用 `NODE_OPTIONS="--require /tmp/patch-userinfo.cjs"` 兜一下（普通机器不需要）。

## 备用出包方案（不需要 JDK / Gradle / aapt2）

aarch64 上如果不想折腾 qemu，也可以「重打包」：官方 APK 的原生壳（classes.dex、资源、Manifest）与我们的壳完全相同，只要把 `assets/public` 换成自己构建的产物再重签：

```bash
python3 tools/build/repack-apk.py \
  --base .work/apk-0.4.4/BiliLite-0.4.4-android-debug.apk \
  --web  app/dist \
  --out  /tmp/repacked-unsigned.apk
zipalign -p -f 4 /tmp/repacked-unsigned.apk /tmp/repacked-aligned.apk
apksigner sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android \
  --min-sdk-version 22 --out BiliLite-0.4.4-repacked.apk /tmp/repacked-aligned.apk
```

此方案在 0.4.3 上实测通过（3,781,178 B，签名/对齐/安装校验同样通过；`classes.dex`、`AndroidManifest.xml`、`resources.arsc` 与官方 APK 逐字节相同），适合只改了 web 资源、想快速出包的场景。注意重打包产物的原生侧就等于官方包，出包后仍要做一遍 `apksigner verify` / `zipalign -c` 和 web 资源 diff。

## 安装

```bash
adb install -r BiliLite-0.4.4-debug.apk
# 或拷到手机点安装（需允许「安装未知来源应用」）
```

注意：与官方 APK **包名相同、签名不同**，手机上已装官方 0.4.3/0.4.4 的话会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，需要先卸载官方版（卸载会清掉该应用本地数据）；装的是本仓库 0.4.3 产物的可以直接覆盖升级（同签名、versionCode 8 > 7）。

## 未验证

- 真机启动、登录、播放（B 站接口需要外网与本机 cookie）；
- 沉浸式全屏与画中画（`ImmersivePlugin` / `PipPlugin`）没有真机可测；
- 本机没有 `adb`/模拟器，安装与首启未实测，只做了 apksigner/zipalign/aapt 层面的静态校验。
