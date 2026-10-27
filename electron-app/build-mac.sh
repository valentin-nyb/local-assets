#!/bin/sh
# Builds the a™ .dmg files (Apple Silicon and Intel) into ./dist.
# The project folder's name has a colon ("LOCAL : ASSETS"), which breaks the build tools, so the
# build runs in a temporary folder.
#
# Signed and notarized when this Mac has a "Developer ID Application" certificate in its Keychain:
# the download then opens with no warning. Once, before the first signed build:
#   1. Xcode → Settings → Accounts → your Apple ID → Manage Certificates → + → Developer ID Application
#   2. In Terminal (your Apple ID, Team ID and an app-specific password from account.apple.com):
#        xcrun notarytool store-credentials la-notary --apple-id YOU@EXAMPLE.COM --team-id TEAMID
#      It asks for the password itself and keeps it in the Keychain; it never goes in a file.
# Without the certificate it builds ad-hoc signed, as before (macOS asks to Open Anyway once).
# Usage (from electron-app): sh build-mac.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d /tmp/la-macapp.XXXXXX)
PROFILE=${LA_NOTARY_PROFILE:-la-notary}
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)

for a in x64 arm64; do
  [ -x "$HERE/vendor/$a/ffmpeg" ] || { mkdir -p "$HERE/vendor/$a"; curl -sL --fail "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-$a.gz" | gunzip > "$HERE/vendor/$a/ffmpeg"; chmod +x "$HERE/vendor/$a/ffmpeg"; }
done
cp -R "$HERE/main.js" "$HERE/preload.js" "$HERE/this-mac.js" "$HERE/offline.html" "$HERE/package.json" "$HERE/entitlements.mac.plist" "$HERE/icons" "$HERE/vendor" "$TMP/"
# The venue relay and multi-camera edits, shared with the Terminal relay (relay/ in the site)
cp "$HERE/../relay/la-camera-relay.mjs" "$HERE/../relay/la-multicam.mjs" "$TMP/"
cd "$TMP" && npm install --no-audit --no-fund --silent

if [ -n "$IDENTITY" ]; then
  echo "Signing with: $IDENTITY"
  # electron-builder signs every part of the app (ffmpeg included) with the hardened runtime
  export CSC_NAME="${IDENTITY#Developer ID Application: }"
  node node_modules/electron-builder/cli.js --mac dmg --arm64 --x64 -c.mac.notarize=false
  for f in dist/local-assets-*.dmg; do
    echo "Notarizing $f (a few minutes)…"
    xcrun notarytool submit "$f" --keychain-profile "$PROFILE" --wait
    xcrun stapler staple "$f"
  done
else
  echo "No Developer ID certificate in the Keychain: building ad-hoc signed (macOS will ask to Open Anyway once)."
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  node node_modules/electron-builder/cli.js --mac dir --arm64 --x64
  for d in dist/mac dist/mac-arm64; do
    codesign --force --sign - "$d/a™.app/Contents/Resources/ffmpeg"
    codesign --force --deep --sign - "$d/a™.app"
  done
  node node_modules/electron-builder/cli.js --mac dmg --x64 --prepackaged "dist/mac/a™.app" -c.mac.identity=null
  node node_modules/electron-builder/cli.js --mac dmg --arm64 --prepackaged "dist/mac-arm64/a™.app" -c.mac.identity=null
fi
mkdir -p "$HERE/dist" && cp dist/local-assets-*.dmg "$HERE/dist/"
rm -rf "$TMP"
echo "Built: $HERE/dist/local-assets-arm64.dmg and local-assets-x64.dmg"
