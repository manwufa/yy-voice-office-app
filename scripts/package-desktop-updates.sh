#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=${APP_ROOT:-/home/wufa/YY}
VERSION=${VERSION:-0.1.5}
ELECTRON_VERSION=${ELECTRON_VERSION:-42.2.0}
PUBLIC_BASE=${PUBLIC_BASE:-http://xz42/wufa/YY/updates}
MIRROR=${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
ASSET_DIR=${ASSET_DIR:-$REPO_ROOT/packaging}
CACHE_DIR="$APP_ROOT/.package-cache/electron"
WORK_DIR="$APP_ROOT/.package-work"
DOWNLOAD_DIR="$APP_ROOT/updates/downloads"
INCREMENTAL_DIR="$DOWNLOAD_DIR/incremental"
MANIFEST_WORK="$WORK_DIR/manifest"

mkdir -p "$CACHE_DIR" "$WORK_DIR" "$DOWNLOAD_DIR" "$INCREMENTAL_DIR" "$MANIFEST_WORK"
rm -rf "$MANIFEST_WORK" "$INCREMENTAL_DIR"
mkdir -p "$MANIFEST_WORK" "$INCREMENTAL_DIR"

download_electron() {
  local platform_arch="$1"
  local file="electron-v${ELECTRON_VERSION}-${platform_arch}.zip"
  local target="$CACHE_DIR/$file"

  if [ ! -s "$target" ]; then
    curl -fL "$MIRROR/$ELECTRON_VERSION/$file" -o "$target"
  fi
}

copy_app_payload() {
  local app_dir="$1"

  rm -rf "$app_dir"
  mkdir -p "$app_dir/dist"
  cp "$ASSET_DIR/app-package.json" "$app_dir/package.json"
  cp -a "$APP_ROOT/dist/electron" "$app_dir/dist/"
  cp -a "$APP_ROOT/dist/renderer" "$app_dir/dist/"
}

write_file_manifest() {
  local platform_key="$1"
  local source_root="$2"
  local path_prefix="$3"
  local manifest_file="$MANIFEST_WORK/$platform_key.json"
  local incremental_root="$INCREMENTAL_DIR/$platform_key"

  python3 - "$platform_key" "$source_root" "$path_prefix" "$incremental_root" "$PUBLIC_BASE" "$VERSION" "$manifest_file" <<'PY'
import hashlib
import json
import os
import shutil
import sys

platform_key, source_root, path_prefix, incremental_root, public_base, version, manifest_file = sys.argv[1:]
files = []

for current_root, _dirs, names in os.walk(source_root):
    for name in names:
        source_path = os.path.join(current_root, name)
        relative_source = os.path.relpath(source_path, source_root).replace(os.sep, "/")
        relative_path = f"{path_prefix}/{relative_source}" if path_prefix else relative_source
        target_path = os.path.join(incremental_root, *relative_path.split("/"))
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        shutil.copy2(source_path, target_path)
        with open(source_path, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        files.append({
            "path": relative_path,
            "size": os.path.getsize(source_path),
            "sha256": digest,
            "url": f"{public_base}/downloads/incremental/{platform_key}/{relative_path}",
        })

files.sort(key=lambda item: item["path"])
with open(manifest_file, "w", encoding="utf-8") as handle:
    json.dump({"version": version, "files": files}, handle, ensure_ascii=False, indent=2)
PY
}

package_windows() {
  local name="YY-Voice-Office-${VERSION}-windows-x64"
  local runtime_zip="$CACHE_DIR/electron-v${ELECTRON_VERSION}-win32-x64.zip"
  local runtime_dir="$WORK_DIR/$name"

  download_electron win32-x64
  rm -rf "$runtime_dir"
  mkdir -p "$runtime_dir"
  unzip -q "$runtime_zip" -d "$runtime_dir"
  mv "$runtime_dir/electron.exe" "$runtime_dir/YY Voice Office.exe"
  copy_app_payload "$runtime_dir/resources/app"
  write_file_manifest "win32-x64" "$runtime_dir/resources/app" "resources/app"

  rm -f "$DOWNLOAD_DIR/$name.zip"
  (cd "$WORK_DIR" && zip -qr "$DOWNLOAD_DIR/$name.zip" "$name")
}

package_macos() {
  local arch="$1"
  local name="YY-Voice-Office-${VERSION}-macos-${arch}"
  local platform_key="darwin-${arch}"
  local runtime_zip="$CACHE_DIR/electron-v${ELECTRON_VERSION}-darwin-${arch}.zip"
  local runtime_dir="$WORK_DIR/$name"
  local app_path="$runtime_dir/YY Voice Office.app"
  local plist="$app_path/Contents/Info.plist"

  download_electron "darwin-${arch}"
  rm -rf "$runtime_dir"
  mkdir -p "$runtime_dir"
  unzip -q "$runtime_zip" -d "$runtime_dir"
  mv "$runtime_dir/Electron.app" "$app_path"
  copy_app_payload "$app_path/Contents/Resources/app"

  perl -0pi -e 's#(<key>CFBundleName</key>\s*<string>)[^<]+(</string>)#${1}YY Voice Office${2}#' "$plist"
  perl -0pi -e 's#(<key>CFBundleDisplayName</key>\s*<string>)[^<]+(</string>)#${1}YY Voice Office${2}#' "$plist"
  perl -0pi -e 's#(<key>CFBundleIdentifier</key>\s*<string>)[^<]+(</string>)#${1}com.wufa.yy.voiceoffice${2}#' "$plist"
  perl -0pi -e 's#(<key>CFBundleShortVersionString</key>\s*<string>)[^<]+(</string>)#${1}'"$VERSION"'${2}#' "$plist"
  perl -0pi -e 's#(<key>CFBundleVersion</key>\s*<string>)[^<]+(</string>)#${1}'"$VERSION"'${2}#' "$plist"
  if ! grep -q 'NSMicrophoneUsageDescription' "$plist"; then
    perl -0pi -e 's#</dict>#\t<key>NSMicrophoneUsageDescription</key>\n\t<string>用于语音办公通话。</string>\n</dict>#' "$plist"
  fi

  # The upstream Electron.app signature becomes invalid after replacing the app
  # payload on Linux. Removing the stale top-level signature avoids the macOS
  # "damaged app" path; the first-run helper can ad-hoc sign it locally.
  rm -rf "$app_path/Contents/_CodeSignature"

  cat > "$runtime_dir/Open YY Voice Office.command" <<'SH'
#!/bin/sh
set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP="$DIR/YY Voice Office.app"

if [ ! -d "$APP" ]; then
  echo "YY Voice Office.app was not found in this folder."
  echo "Please keep this command file next to YY Voice Office.app."
  printf "\nPress Enter to close this window."
  read -r _unused
  exit 1
fi

echo "Preparing YY Voice Office for first launch..."
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

if /usr/bin/codesign --force --deep --sign - "$APP" >/dev/null 2>&1; then
  echo "Local ad-hoc signature completed."
else
  echo "Local ad-hoc signature failed; trying to open the app anyway."
fi

/usr/bin/open "$APP"
SH
  chmod 0755 "$runtime_dir/Open YY Voice Office.command"

  cat > "$runtime_dir/README-macOS.txt" <<'TXT'
macOS 首次打开说明

这个包不是用 Apple 开发者证书签名和公证的，所以 macOS 首次打开时可能提示“无法验证开发者”或“应用已损坏”。

推荐方式：
1. 解压 zip。
2. 双击 Open YY Voice Office.command。
3. 如果系统阻止脚本运行，请右键点击 Open YY Voice Office.command，选择“打开”。

手动方式：
打开“终端”，cd 到解压后的文件夹，然后执行：

xattr -dr com.apple.quarantine "YY Voice Office.app"
codesign --force --deep --sign - "YY Voice Office.app"
open "YY Voice Office.app"

如果要做到完全无提示的一键安装，需要 Apple Developer 账号，并在 macOS 机器上进行正式签名和 notarization。
TXT

  write_file_manifest "$platform_key" "$app_path/Contents/Resources/app" "Contents/Resources/app"

  rm -f "$DOWNLOAD_DIR/$name.zip"
  (cd "$runtime_dir" && zip -qry "$DOWNLOAD_DIR/$name.zip" "YY Voice Office.app" "Open YY Voice Office.command" "README-macOS.txt")
}

package_windows
package_macos arm64
package_macos x64

cp "$ASSET_DIR/download.html" "$APP_ROOT/updates/download.html"

python3 - "$VERSION" "$PUBLIC_BASE" "$MANIFEST_WORK" "$APP_ROOT/updates/latest.json" <<'PY'
import json
import os
import sys

version, public_base, manifest_work, output_path = sys.argv[1:]
packages = {}
for platform_key in ("win32-x64", "darwin-arm64", "darwin-x64"):
    with open(os.path.join(manifest_work, f"{platform_key}.json"), "r", encoding="utf-8") as handle:
        packages[platform_key] = json.load(handle)

manifest = {
    "version": version,
    "notes": "桌面客户端支持软件内增量更新。",
    "downloads": {
        "windows": f"{public_base}/downloads/YY-Voice-Office-{version}-windows-x64.zip",
        "macos": f"{public_base}/downloads/YY-Voice-Office-{version}-macos-arm64.zip"
    },
    "packages": packages
}

with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

sha256sum "$DOWNLOAD_DIR"/YY-Voice-Office-"$VERSION"-*.zip > "$DOWNLOAD_DIR/SHA256SUMS.txt"
ls -lh "$DOWNLOAD_DIR"
