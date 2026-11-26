#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mode=named
[ -n "${IOS_UNIT_TESTS:-}${IOS_UI_TESTS:-}" ] || mode=whole
case ${1:-} in
  "") ;;
  --whole) mode=whole ;;
  --build) mode=build ;;
  *)
    echo "usage: check.sh [--whole | --build]   with IOS_UNIT_TESTS or IOS_UI_TESTS it runs those classes alone; --whole, every step too; --build, the app in Debug and Release and every test compiled, nothing run, no slot taken" >&2
    exit 64
    ;;
esac
case "${IOS_UNIT_TESTS:-}${IOS_UI_TESTS:-}" in
  *" "*) echo "check.sh: IOS_UNIT_TESTS and IOS_UI_TESTS name classes by commas, with no space" >&2; exit 2 ;;
esac
case ",${IOS_UI_TESTS:-}," in
  *,SpeedUITests,* | *,SpeedUITests/*)
    echo "IOS_UI_TESTS names SpeedUITests: the check never runs them; ./speed.py does, by hand (SPEED.md)" >&2
    exit 2
    ;;
esac
ui_tests_most=40
test_allowance_s=120
build_and_unit_tests_s=1500
if [ $mode != build ] && [ -z "${LIFESTREAM_TEST_PHONE:-}" ]; then
  LIFESTREAM_TEST_CAP="${LIFESTREAM_TEST_CAP:-$((ui_tests_most * test_allowance_s + build_and_unit_tests_s))}" LIFESTREAM_TEST_LOCKED="" LIFESTREAM_TEST_SLOT=phone exec "$PWD/../tools/test-lock.sh" "$PWD/$(basename "$0")" "$@"
fi

derived_data="${IOS_DERIVED_DATA_PATH:-$PWD/.build/xcode}"
xcodegen_version=2.46.0

missing=()
if DEVELOPER_DIR=$(./xcode.sh); then export DEVELOPER_DIR; else missing+=("Xcode (the line above says how)"); fi
if ! command -v xcodegen >/dev/null; then
  missing+=("xcodegen $xcodegen_version")
elif [ "$(xcodegen --version | awk '{ print $NF }')" != "$xcodegen_version" ]; then
  missing+=("xcodegen $xcodegen_version (this Mac has $(xcodegen --version | awk '{ print $NF }'))")
fi
command -v rg >/dev/null || missing+=("rg (contract-check.sh)")
if [ ${#missing[@]} -gt 0 ]; then
  printf 'MISSING: %s\n' "${missing[@]}" >&2
  exit 1
fi

if [ $mode = build ]; then
  destination="generic/platform=iOS Simulator"
  udid=""
elif [ -n "${IOS_TEST_DESTINATION:-}" ]; then
  destination=$IOS_TEST_DESTINATION
  udid=$(sed -n 's/.*id=\([0-9A-Fa-f-]\{36\}\).*/\1/p' <<< "$destination")
else
  udid=$(./simulator.sh)
  destination="platform=iOS Simulator,id=$udid"
  echo "Simulator: $udid"
fi
app_preferences="$(./signing.sh LIFESTREAM_BUNDLE_PREFIX).phone"
prepare() {
  xcrun simctl spawn "$1" log config --subsystem com.apple.dt.xctest --mode level:off
  xcrun simctl spawn "$1" defaults write com.apple.keyboard.preferences KeyboardHardwareKeyboardsSeen '<array><integer>13</integer></array>'
  xcrun simctl spawn "$1" defaults delete "$app_preferences" >/dev/null 2>&1 || true
}

if [ $mode = whole ]; then
echo "== 1/4 Swift 6 core tests =="
core_skip=()
while read -r test; do core_skip+=(--skip "$test"); done < <(awk '$1 ~ /^ios-app\/[A-Za-z]+\/[A-Za-z]+\/[A-Za-z0-9_]+$/ && $1 !~ /^ios-app\/LifestreamCapture(UI)?Tests\// { split($1, id, "/"); print "^" id[2] "\\." id[3] "/" id[4] "$" }' ../testing/quarantine.txt)
swift test --parallel --num-workers 3 --cache-path "$PWD/.build/swift-cache" ${core_skip[@]+"${core_skip[@]}"} -Xswiftc -warnings-as-errors
fi

echo
echo "== 2/4 Generate project + verify ratified contract =="
generated_paths=(
  LifestreamCapture.xcodeproj
  LifestreamCapture/Resources/Info.plist
  UsageMonitorExtension/Info.plist
  ShareExtension/Info.plist
)
mkdir -p .build
comparison_dir="$(mktemp -d .build/xcodegen-check.XXXXXX)"
trap 'rm -rf "$comparison_dir"' EXIT
for generated_path in "${generated_paths[@]}"; do
  mkdir -p "$comparison_dir/$(dirname "$generated_path")"
  cp -R "$generated_path" "$comparison_dir/$generated_path"
done
xcodegen generate
for generated_path in "${generated_paths[@]}"; do
  if ! diff -qr "$comparison_dir/$generated_path" "$generated_path"; then
    echo "XCODEGEN OUTPUT DRIFTED: regenerate files from project.yml and rerun" >&2
    exit 1
  fi
done
rm -rf "$comparison_dir"
trap - EXIT
./contract-check.sh

if [ $mode != named ]; then
echo
echo "== 3/4 Release build =="
xcodebuild build \
  -project LifestreamCapture.xcodeproj \
  -scheme LifestreamCapture \
  -configuration Release \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived_data" \
  -packageCachePath "$derived_data/PackageCache" \
  -quiet \
  ARCHS=arm64 \
  SWIFT_OPTIMIZATION_LEVEL=-Onone \
  CODE_SIGNING_ALLOWED=NO
fi

if [ $mode = build ]; then
  echo
  echo "== Debug app and every test compiled =="
  xcodebuild build-for-testing \
    -project LifestreamCapture.xcodeproj \
    -scheme LifestreamCapture \
    -destination "$destination" \
    -derivedDataPath "$derived_data" \
    -packageCachePath "$derived_data/PackageCache" \
    -quiet \
    ARCHS=arm64 \
    SWIFT_TREAT_WARNINGS_AS_ERRORS=YES
  swift build --build-tests --cache-path "$PWD/.build/swift-cache" -Xswiftc -warnings-as-errors
  echo
  echo "IOS BUILDS PASSED"
  exit 0
fi

echo
echo "== 4/4 App-hosted tests + the UI test classes named == $(uptime | sed 's/.*load/load/')"
shares=()
IFS=',' read -ra unit_classes <<< "${IOS_UNIT_TESTS:-}"
if [ ${#unit_classes[@]} -gt 0 ]; then
  unit_share=""
  for unit_class in "${unit_classes[@]}"; do unit_share+=" -only-testing:LifestreamCaptureTests/$unit_class"; done
  shares+=("${unit_share# }")
elif [ $mode = whole ]; then
  shares+=(-only-testing:LifestreamCaptureTests)
fi
IFS=',' read -ra ui_classes <<< "${IOS_UI_TESTS:-}"
while read -r _ ui_class; do shares+=("-only-testing:LifestreamCaptureUITests/$ui_class"); done < <(
  for ui_class in ${ui_classes[@]+"${ui_classes[@]}"}; do
    awk -v entry="$ui_class" '
      BEGIN { split(entry, part, "/"); if (part[2] != "") { found = 1; count = 1 } }
      match($0, /class [A-Za-z0-9_]+/) { current = substr($0, RSTART + 6, RLENGTH - 6) }
      !found && current == part[1] && /func test/ { count++ }
      END { print count + 0, entry }' LifestreamCaptureUITests/*.swift
  done | sort -rn
)
skip=()
while read -r test; do skip+=("-skip-testing:$test"); done < <(awk '$1 ~ /^ios-app\/LifestreamCapture(UI)?Tests\// { sub(/^ios-app\//, "", $1); print $1 }' ../testing/quarantine.txt)

workers_most=3
destinations=("$destination")
test_udids=()
[ -z "$udid" ] || test_udids+=("$udid")
worker_udids=()
if [ -z "${IOS_TEST_DESTINATION:-}" ]; then
  while [ ${#destinations[@]} -lt $workers_most ] && [ ${#destinations[@]} -lt ${#shares[@]} ]; do
    worker_udid=$(./simulator.sh worker $((${#destinations[@]} + 1)))
    worker_udids+=("$worker_udid")
    test_udids+=("$worker_udid")
    destinations+=("platform=iOS Simulator,id=$worker_udid")
  done
fi
shut_workers() {
  for worker_udid in ${worker_udids[@]+"${worker_udids[@]}"}; do xcrun simctl shutdown "$worker_udid" >/dev/null 2>&1 || true; done
}
trap shut_workers EXIT
boots=()
for test_udid in ${test_udids[@]+"${test_udids[@]}"}; do
  ./simulator.sh boot "$test_udid" &
  boots+=($!)
done

rm -f "$derived_data"/Build/Products/*.xctestrun
xcodebuild build-for-testing \
  -project LifestreamCapture.xcodeproj \
  -scheme LifestreamCapture \
  -derivedDataPath "$derived_data" \
  -packageCachePath "$derived_data/PackageCache" \
  -destination "$destination" \
  -quiet \
  SWIFT_TREAT_WARNINGS_AS_ERRORS=YES
xctestruns=("$derived_data"/Build/Products/*.xctestrun)
if [ ${#xctestruns[@]} != 1 ] || [ ! -f "${xctestruns[0]}" ]; then
  echo "build-for-testing left ${#xctestruns[@]} test plans where one was due: ${xctestruns[*]}" >&2
  exit 1
fi
xctestrun=${xctestruns[0]}
for boot in ${boots[@]+"${boots[@]}"}; do wait "$boot"; done
for test_udid in ${test_udids[@]+"${test_udids[@]}"}; do prepare "$test_udid"; done
results="$derived_data/Logs/Test/check"
claims="$results/claims"
rm -rf "$results"
mkdir -p "$claims"

run_share() {
  local worker_destination=$1 index=$2 share
  read -ra share <<< "${shares[$index]}"
  echo "== ${shares[$index]} on ${worker_destination##*=} =="
  xcodebuild test-without-building \
    -xctestrun "$xctestrun" \
    -derivedDataPath "$derived_data" \
    -destination "$worker_destination" \
    -resultBundlePath "$results/$index.xcresult" \
    -parallel-testing-enabled NO \
    -test-timeouts-enabled YES \
    -default-test-execution-time-allowance 120 \
    -maximum-test-execution-time-allowance 120 \
    -collect-test-diagnostics never \
    "${share[@]}" \
    ${skip[@]+"${skip[@]}"} 2>&1 | awk '{ print; fflush() }'
}
work() {
  local worker_destination=$1 status=0 index
  for index in "${!shares[@]}"; do
    mkdir "$claims/$index" 2>/dev/null || continue
    run_share "$worker_destination" "$index" || status=1
  done
  return $status
}
workers=()
for worker_destination in "${destinations[@]}"; do
  work "$worker_destination" &
  workers+=($!)
done
failed=0
for worker in "${workers[@]}"; do wait "$worker" || failed=1; done
if [ $failed != 0 ]; then
  echo
  xcrun python3 -I reds.py "$results" "$PWD/.build/crashes/$(date +%Y-%m-%d_%H-%M-%S)" || true
  echo
  echo "IOS TESTS FAILED: the lines above name each red test"
  exit 1
fi

echo
echo "IOS CHECKS PASSED"
