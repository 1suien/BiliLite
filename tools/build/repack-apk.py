#!/usr/bin/env python3
"""备用出包方案：不跑 Gradle / aapt2，直接把还原工程构建出的 web 资源
替换进官方 APK 的 assets/public，重新 zipalign + 签名。

适用于没有 JDK/Android SDK、或 aarch64 上没法跑 aapt2 的场景。
（产物 shell 与官方 APK 逐字节相同，只有 web 资源是本工程重新构建的。）

用法：
  python3 tools/build/repack-apk.py \
      --base  .work/BiliLite-0.4.3-android-debug.apk \
      --web   app/android/app/src/main/assets/public \
      --out   /tmp/repacked-unsigned.apk
之后（build-tools 34）：
  zipalign -p -f 4 /tmp/repacked-unsigned.apk /tmp/repacked-aligned.apk
  apksigner sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android \
      --min-sdk-version 22 --out BiliLite-0.4.3-debug.apk /tmp/repacked-aligned.apk
"""
import argparse
import os
import zipfile

SKIP_PREFIX = "assets/public/"
SKIP_SIG = {"META-INF/MANIFEST.MF", "META-INF/CERT.SF", "META-INF/CERT.RSA", "META-INF/CERT.EC"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="官方 APK（提供 classes.dex / 资源 / 原生壳）")
    ap.add_argument("--web", required=True, help="新的 web 资源目录（dist 或 cap sync 后的 public）")
    ap.add_argument("--out", required=True, help="输出未签名 APK")
    args = ap.parse_args()

    files = []
    for root, _dirs, names in os.walk(args.web):
        for name in names:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, args.web).replace(os.sep, "/")
            files.append(("assets/public/" + rel, full))

    with zipfile.ZipFile(args.base) as zin, zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            if info.filename.startswith(SKIP_PREFIX) or info.filename in SKIP_SIG:
                continue
            zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            zi.compress_type = info.compress_type
            zi.external_attr = info.external_attr
            zi.internal_attr = info.internal_attr
            zi.create_system = info.create_system
            zout.writestr(zi, zin.read(info.filename))
        for arc, full in files:
            zi = zipfile.ZipInfo(arc, date_time=(2026, 10, 16, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            with open(full, "rb") as fh:
                zout.writestr(zi, fh.read())

    print(f"web entries: {len(files)} → {args.out}")


if __name__ == "__main__":
    main()
