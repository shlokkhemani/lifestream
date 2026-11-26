#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
feed=""
carry=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --feed) feed="https://get.lifestreamprotocol.org/7d17c9a3d9/mac/appcast.xml"; shift ;;
    --release) carry="${2:?build-app.sh --release names a release folder}"; shift 2 ;;
    *) break ;;
  esac
done
if [ -n "$carry" ]; then
  carried_commit="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["commit"])' "$carry/RELEASE.json")"
  if [ "$carried_commit" != "$(git rev-parse HEAD)" ]; then
    echo "build-app.sh --release carries $carried_commit, and this checkout is $(git rev-parse HEAD): the app and its release come from one commit" >&2
    exit 1
  fi
fi
sources=(Sources Package.swift Package.resolved make-icon.swift ../homelink ../design/swift)
if [ -n "$(git status --porcelain -- "${sources[@]}")" ]; then
  echo "build-app.sh builds the app and its release from one clean commit: commit or set aside these changes first" >&2
  git status --short -- "${sources[@]}" >&2
  exit 1
fi
if [ "$(node -v)" != "v$(cat ../.nvmrc)" ]; then
  echo "The shell must supply Node v$(cat ../.nvmrc); found $(node -v)" >&2
  exit 1
fi
sdk="$(xcrun --sdk macosx --show-sdk-version 2>/dev/null || true)"
if [ "${sdk%%.*}" -lt 27 ] 2>/dev/null || [ -z "$sdk" ]; then
  echo "build-app.sh needs Xcode 27's macOS SDK, and $(xcode-select -p 2>/dev/null || echo 'no developer folder') gives ${sdk:-none}: install Xcode 27, then run sudo xcode-select -s /Applications/Xcode.app (docs/contributing/develop.md)" >&2
  exit 1
fi
if [ -n "$feed" ]; then
  key="${SPARKLE_PUBLIC_ED_KEY:-}"
  if [ -z "$key" ]; then
    tools="$(bash sparkle-tools.sh)"
    key="$("$tools/generate_keys" --account lifestream -p 2>/dev/null || true)"
  fi
  if ! python3 -c 'import base64, sys; sys.exit(len(base64.b64decode(sys.argv[1], validate=True)) != 32)' "$key" 2>/dev/null; then
    echo "build-app.sh --feed needs the update key: none in SPARKLE_PUBLIC_ED_KEY, and generate_keys --account lifestream -p found none in the login Keychain" >&2
    exit 1
  fi
fi
swift build -c release
output="${1:-dist}"
case "$output" in /*) ;; *) output="$PWD/$output" ;; esac
app="$output/Lifestream.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp .build/release/Lifestream "$app/Contents/MacOS/Lifestream"
mkdir -p "$app/Contents/Frameworks"
ditto .build/release/Sparkle.framework "$app/Contents/Frameworks/Sparkle.framework"
rm -rf "$app/Contents/Frameworks/Sparkle.framework/XPCServices" \
  "$app/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices"
iconset="$(mktemp -d)/AppIcon.iconset"
swift make-icon.swift "$iconset"
iconutil -c icns -o "$app/Contents/Resources/AppIcon.icns" "$iconset"
rm -rf "$(dirname "$iconset")"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.lifestreamprotocol.screen-capture</string>
<key>CFBundleName</key><string>Lifestream</string>
<key>CFBundleDisplayName</key><string>Lifestream</string>
<key>CFBundleExecutable</key><string>Lifestream</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.2</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAudioCaptureUsageDescription</key><string>Lifestream records the other side of your calls and meetings, while an app is using the mic.</string>
<key>NSBluetoothAlwaysUsageDescription</key><string>Lifestream notes when Bluetooth devices connect and disconnect, into your own capture folder.</string>
<key>NSMicrophoneUsageDescription</key><string>Lifestream records both sides of your calls and meetings, and the voice notes you send Chat.</string>
<key>NSPhotoLibraryUsageDescription</key><string>Lifestream keeps every photo and video in your library, so your days have their pictures.</string>
</dict></plist>
PLIST
plutil -insert CFBundleVersion -string "$(date -u +%Y%m%d.%H%M%S)" "$app/Contents/Info.plist"
if [ -n "$carry" ]; then
  release="$carry"
else
  if ! built="$(cd .. && npx tsx packages/home/cli.ts build --commit HEAD 2>&1)"; then
    printf '%s\n' "$built" >&2
    echo "build-app.sh: the release did not build: lifestream build said why, above" >&2
    exit 1
  fi
  built="$(printf '%s\n' "$built" | tail -n 1)"
  release="$(printf '%s' "$built" | python3 -c 'import json, sys; print(json.load(sys.stdin)["release"])')"
fi
ditto "$release" "$app/Contents/Resources/release"
version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["generation"])' "$release/RELEASE.json")"
plutil -insert CFBundleShortVersionString -string "$version" "$app/Contents/Info.plist"
"$app/Contents/MacOS/Lifestream" agents --output "$app/Contents/Library/LaunchAgents"
plutil -insert LifestreamCommit -string "$(git rev-parse --short HEAD)" "$app/Contents/Info.plist"
if [ -n "$feed" ]; then
  plist="$app/Contents/Info.plist"
  plutil -insert SUFeedURL -string "$feed" "$plist"
  plutil -insert SUPublicEDKey -string "$key" "$plist"
  plutil -insert SUEnableAutomaticChecks -bool YES "$plist"
  plutil -insert SUScheduledCheckInterval -integer 3600 "$plist"
  plutil -insert SUAutomaticallyUpdate -bool YES "$plist"
  plutil -insert SUEnableSystemProfiling -bool NO "$plist"
fi
python3 sign-app.py "$app"
if [ -n "$feed" ] && ! grep -q '^Authority=Developer ID Application:' <<< "$(codesign -dvv "$app" 2>&1)"; then
  rm -rf "$app"
  echo "build-app.sh --feed signs with Developer ID only, and this build was signed with another identity" >&2
  exit 1
fi
printf '%s\n' "$app"
