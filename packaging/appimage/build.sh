#!/usr/bin/env bash
# Build FlipWatch-x86_64.AppImage on Linux (x86_64).
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"
ARCH="$(uname -m)"
if [[ "$ARCH" != "x86_64" ]]; then
  echo "AppImage build currently supports x86_64 only (found: $ARCH)." >&2
  exit 1
fi

NODE_VERSION="${NODE_VERSION:-22.15.1}"
TOOLS_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/flipwatch-appimage"
APPDIR="$ROOT/.build/FlipWatch.AppDir"
mkdir -p "$TOOLS_DIR" "$ROOT/.build"

if [[ ! -x "$TOOLS_DIR/node-v$NODE_VERSION-linux-x64/bin/node" ]]; then
  archive="$TOOLS_DIR/node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$archive"
  tar -xJf "$archive" -C "$TOOLS_DIR"
fi
NODE_BIN="$TOOLS_DIR/node-v$NODE_VERSION-linux-x64/bin/node"
if [[ ! -x "$ROOT/node_modules/.bin/next" ]]; then
  echo "Dependencies are missing. Run npm ci first." >&2
  exit 1
fi

npm run build
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/share/flipwatch" "$APPDIR/usr/bin" "$APPDIR/usr/share/icons/hicolor/512x512/apps"
cp -a "$ROOT/.next/standalone/." "$APPDIR/usr/share/flipwatch/"
mkdir -p "$APPDIR/usr/share/flipwatch/.next"
cp -a "$ROOT/.next/static" "$APPDIR/usr/share/flipwatch/.next/static"
cp -a "$ROOT/public" "$APPDIR/usr/share/flipwatch/public"
cp "$NODE_BIN" "$APPDIR/usr/bin/node"
cp "$ROOT/packaging/appimage/AppRun" "$APPDIR/AppRun"
cp "$ROOT/packaging/appimage/flipwatch.desktop" "$APPDIR/flipwatch.desktop"
cp "$ROOT/public/icons/icon-512.png" "$APPDIR/usr/share/icons/hicolor/512x512/apps/flipwatch.png"
ln -s usr/share/icons/hicolor/512x512/apps/flipwatch.png "$APPDIR/flipwatch.png"
chmod +x "$APPDIR/AppRun"

APPIMAGETOOL="$TOOLS_DIR/appimagetool-x86_64.AppImage"
if [[ ! -x "$APPIMAGETOOL" ]]; then
  curl -fL --retry 3 "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage" -o "$APPIMAGETOOL"
  chmod +x "$APPIMAGETOOL"
fi
OUTPUT="$ROOT/FlipWatch-x86_64.AppImage"
ARCH=x86_64 "$APPIMAGETOOL" "$APPDIR" "$OUTPUT"
chmod +x "$OUTPUT"
echo "Built $OUTPUT"
