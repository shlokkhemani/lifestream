#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

DEVELOPER_DIR=$(./xcode.sh)
export DEVELOPER_DIR
derived_data=$PWD/.build/shoot
app=$derived_data/Build/Products/Debug-iphonesimulator/Lifestream.app
lock=/tmp/lifestream-simulator-by-hand.lock

wheres=()
flags=()
parse() {
  while [ $# -gt 0 ]; do
    if [ "$1" = -- ]; then
      shift
      flags=("$@")
      return
    fi
    wheres+=("$1")
    shift
  done
}

if [ "${1:-}" = --holding ]; then
  udid=$2 folder=$3
  shift 3
  parse "$@"
  ./simulator.sh boot "$udid"
  xcrun simctl install "$udid" "$app"
  xcrun simctl status_bar "$udid" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 --batteryState discharging --batteryLevel 100
  bundle=$(plutil -extract CFBundleIdentifier raw "$app/Info.plist")
  n=0
  for where in "${wheres[@]}"; do
    n=$((n + 1))
    file=$folder/$(printf '%02d-%s' "$n" "$(printf '%s' "$where" | tr -c 'A-Za-z0-9_-' _)").png
    xcrun simctl launch --terminate-running-process "$udid" "$bundle" \
      --ui-testing --ui-test-reset --ui-test-started --ui-test-dark-appearance \
      --ui-test-open "$where" ${flags[@]+"${flags[@]}"} >/dev/null
    : > "$file.last"
    SECONDS=0
    while :; do
      sleep 1
      xcrun simctl io "$udid" screenshot "$file" >/dev/null 2>&1
      if cmp -s "$file" "$file.last"; then break; fi
      if [ "$SECONDS" -ge 15 ]; then
        echo "shoot.sh: $where still moved after 15 s; shot as it stood" >&2
        break
      fi
      cp "$file" "$file.last"
    done
    rm -f "$file.last"
    echo "$file"
  done
  xcrun simctl terminate "$udid" "$bundle" 2>/dev/null || true
  xcrun simctl status_bar "$udid" clear
  exit 0
fi

parse "$@"
if [ ${#wheres[@]} -eq 0 ]; then
  echo "usage: ./shoot.sh <where>… [-- <launch flag>…]   (where: AppNavigation.openForDesign's destinations)" >&2
  exit 2
fi
udid=$(env -u LIFESTREAM_TEST_PHONE lockf -k "$lock" "$PWD/simulator.sh")
echo "Simulator: $udid (iPhone 16 Pro by hand)"
xcodebuild build \
  -project LifestreamCapture.xcodeproj \
  -scheme LifestreamCapture \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$udid" \
  -derivedDataPath "$derived_data" \
  -packageCachePath "$derived_data/PackageCache" \
  -quiet
folder=$PWD/.build/shots/$(date +%Y%m%d-%H%M%S)
mkdir -p "$folder"
if ! lockf -t 0 -k "$lock" true 2>/dev/null; then echo "Waiting for another shoot.sh on the simulator…" >&2; fi
lockf -k "$lock" "$PWD/shoot.sh" --holding "$udid" "$folder" "$@"
echo "Shots: $folder"
