#!/bin/sh
# Builds the a™ .dmg files (Apple Silicon and Intel) into ./dist.
# The project folder's name has a colon ("LOCAL : ASSETS"), which breaks the build tools, so the
# build runs in a temporary folder. Signing is ad-hoc until an Apple Developer ID is added.
# Usage (from electron-app): sh build-mac.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d /tmp/la-macapp.XXXXXX)
for a in x64 arm64; do
  [ -x "$HERE/vendor/$a/ffmpeg" ] || { mkdir -p "$HERE/vendor/$a"; curl -sL --fail "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-$a.gz" | gunzip > "$HERE/vendor/$a/ffmpeg"; chmod +x "$HERE/vendor/$a/ffmpeg"; }
done
cp -R "$HERE/main.js" "$HERE/preload.js" "$HERE/this-mac.js" "$HERE/offline.html" "$HERE/package.json" "$HERE/icons" "$HERE/vendor" "$TMP/"
cd "$TMP" && npm install --no-audit --no-fund --silent
export CSC_IDENTITY_AUTO_DISCOVERY=false
node node_modules/electron-builder/cli.js --mac dir --arm64 --x64
for d in dist/mac dist/mac-arm64; do
  codesign --force --sign - "$d/a™.app/Contents/Resources/ffmpeg"
  codesign --force --deep --sign - "$d/a™.app"
done
node node_modules/electron-builder/cli.js --mac dmg --x64 --prepackaged "dist/mac/a™.app" -c.mac.identity=null
node node_modules/electron-builder/cli.js --mac dmg --arm64 --prepackaged "dist/mac-arm64/a™.app" -c.mac.identity=null
mkdir -p "$HERE/dist" && cp dist/local-assets-*.dmg "$HERE/dist/"
rm -rf "$TMP"
echo "Built: $HERE/dist/local-assets-arm64.dmg and local-assets-x64.dmg"
