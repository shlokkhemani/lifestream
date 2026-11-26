#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

fail() {
  echo "CONTRACT CHECK FAILED: $*" >&2
  exit 1
}

for index_mode in "0 location" "1 fetch" "2 processing"; do
  set -- $index_mode
  [[ "$(/usr/libexec/PlistBuddy -c "Print :UIBackgroundModes:$1" LifestreamCapture/Resources/Info.plist)" == "$2" ]] ||
    fail "UIBackgroundModes entry $1 must be $2"
done
if /usr/libexec/PlistBuddy -c 'Print :UIBackgroundModes:3' LifestreamCapture/Resources/Info.plist >/dev/null 2>&1; then
  fail "an undeclared fourth background mode is present"
fi
[[ "$(/usr/libexec/PlistBuddy -c 'Print :BGTaskSchedulerPermittedIdentifiers:0' LifestreamCapture/Resources/Info.plist)" == "org.lifestreamprotocol.phone.refresh" ]] &&
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :BGTaskSchedulerPermittedIdentifiers:1' LifestreamCapture/Resources/Info.plist)" == "org.lifestreamprotocol.phone.processing" ]] ||
  fail "the two scheduled sync identifiers must be permitted"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :BGTaskSchedulerPermittedIdentifiers:2' LifestreamCapture/Resources/Info.plist)" == '$(PRODUCT_BUNDLE_IDENTIFIER).continued.*' ]] ||
  fail "the continued task the person starts (Bring in all photos) must be permitted"
rg -Fq 'continuedIdentifier = continued(under: Bundle.main.bundleIdentifier)' LifestreamCapture/Shipping/BackgroundSync.swift &&
  rg -Fq '(bundle ?? "org.lifestreamprotocol.phone") + ".continued"' LifestreamCapture/Shipping/BackgroundSync.swift ||
  fail "a continued task's identifier must fall under the permitted pattern"
for entitlements in LifestreamCapture/Resources/LifestreamCapture.entitlements LifestreamCapture/Resources/LifestreamCapture-AppStore.entitlements; do
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.healthkit' "$entitlements")" == "true" ]] ||
    fail "HealthKit entitlement is missing from $entitlements"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.healthkit.background-delivery' "$entitlements")" == "true" ]] ||
    fail "HealthKit background-delivery entitlement is missing from $entitlements"
done

for entitlements in LifestreamCapture/Resources/LifestreamCapture.entitlements UsageMonitorExtension/UsageMonitorExtension.entitlements; do
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.family-controls' "$entitlements")" == "true" ]] ||
    fail "Family Controls entitlement is missing from $entitlements"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups:0' "$entitlements")" == 'group.$(LIFESTREAM_BUNDLE_PREFIX).phone' ]] ||
    fail "usage monitor App Group drifted in $entitlements"
done
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.family-controls.app-and-website-usage' LifestreamCapture/Resources/LifestreamCapture.entitlements)" == "true" ]] ||
  fail "expanded usage entitlement declaration is missing"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :NSExtension:NSExtensionPointIdentifier' UsageMonitorExtension/Info.plist)" == "com.apple.deviceactivity.monitor-extension" ]] ||
  fail "DeviceActivity monitor extension point drifted"
if rg -q 'family-controls' LifestreamCapture/Resources/LifestreamCapture-AppStore.entitlements; then
  fail "the AppStore entitlements must not name Family Controls"
fi
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups:0' LifestreamCapture/Resources/LifestreamCapture-AppStore.entitlements)" == 'group.$(LIFESTREAM_BUNDLE_PREFIX).phone' ]] ||
  fail "the AppStore entitlements' App Group drifted"
rg -q 'EXCLUDED_SOURCE_FILE_NAMES = UsageMonitorExtension.appex;' LifestreamCapture.xcodeproj/project.pbxproj ||
  fail "the AppStore configuration must not embed the usage monitor"
for manifest in LifestreamCapture/Resources/PrivacyInfo.xcprivacy ShareExtension/PrivacyInfo.xcprivacy UsageMonitorExtension/PrivacyInfo.xcprivacy; do
  plutil -lint -s "$manifest" || fail "$manifest is not a property list"
done
rg -q 'CA92\.1' LifestreamCapture/Resources/PrivacyInfo.xcprivacy || fail "the app's privacy manifest must give UserDefaults its reason"
for manifest in LifestreamCapture/Resources/PrivacyInfo.xcprivacy ShareExtension/PrivacyInfo.xcprivacy; do
  rg -q 'C617\.1' "$manifest" && rg -q '3B52\.1' "$manifest" || fail "$manifest must give file timestamps both C617.1 and 3B52.1"
done
[[ "$(plutil -extract NSAppTransportSecurity json -o - LifestreamCapture/Resources/Info.plist)" == '{"NSAllowsArbitraryLoads":true}' ]] ||
  fail "App Transport Security is off, so plain http reaches the home at a Tailscale address; HomeLink.isPrivate keeps it there"
for key in NSLocationWhenInUseUsageDescription NSLocationAlwaysAndWhenInUseUsageDescription NSMotionUsageDescription \
  NSHealthShareUsageDescription NSCameraUsageDescription NSMicrophoneUsageDescription NSContactsUsageDescription \
  NSPhotoLibraryUsageDescription NSLocalNetworkUsageDescription; do
  purpose=$(/usr/libexec/PlistBuddy -c "Print :$key" LifestreamCapture/Resources/Info.plist)
  rg -q 'your Mac' <<<"$purpose" || fail "$key must say what it reads goes to the person's Mac"
  ! rg -qiw 'home' <<<"$purpose" || fail "$key must not name a home: the person reads \"your Mac\""
done
rg -q 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = "\$\(inherited\) APP_STORE";' LifestreamCapture.xcodeproj/project.pbxproj ||
  fail "the AppStore configuration must set the APP_STORE condition"
rg -Uq 'LifestreamCapture-AppStore\.entitlements";[^}]*EXCLUDED_SOURCE_FILE_NAMES = UsageMonitorExtension\.appex;[^}]*SWIFT_ACTIVE_COMPILATION_CONDITIONS = "\$\(inherited\)";[^}]*\};\s*name = PersonalTeam;' LifestreamCapture.xcodeproj/project.pbxproj ||
  fail "the PersonalTeam configuration is what a free Apple Account signs: no Family Controls entitlement, no usage monitor, no SCREEN_TIME"
[[ "$(rg -l --glob '*.swift' 'ExperimentsView|DeliberateCrash|markExperiment' LifestreamCapture | LC_ALL=C sort | tr '\n' ' ')" == \
   'LifestreamCapture/App/Experiments.swift LifestreamCapture/Connectors/ConnectorsView.swift ' ]] ||
  fail "the Experiments screen and its crash live in Experiments.swift alone, linked only from Streams"
unguarded=$(rg -l --glob '*.swift' '^import (FamilyControls|DeviceActivity|ManagedSettings)' LifestreamCapture | xargs awk '
  FNR == 1 { inside = 0 }
  /^#if SCREEN_TIME/ { inside = 1 } /^#(else|endif)/ { inside = 0 }
  /^import (FamilyControls|DeviceActivity|ManagedSettings)/ && !inside { print FILENAME }')
[[ -z "$unguarded" ]] || fail "Screen Time frameworks imported outside #if SCREEN_TIME: $unguarded"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups:0' ShareExtension/ShareExtension.entitlements)" == 'group.$(LIFESTREAM_BUNDLE_PREFIX).phone' ]] ||
  fail "share extension App Group drifted"
for entitlements in LifestreamCapture/Resources/LifestreamCapture-Onboarding.entitlements ShareExtension/ShareExtension-Onboarding.entitlements \
  UsageMonitorExtension/UsageMonitorExtension-Onboarding.entitlements; do
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups:0' "$entitlements")" == 'group.$(LIFESTREAM_BUNDLE_PREFIX).phone.onboarding' ]] ||
    fail "the Onboarding App Group drifted in $entitlements"
done
for plist in LifestreamCapture/Resources/Info.plist ShareExtension/Info.plist UsageMonitorExtension/Info.plist; do
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :LifestreamAppGroup' "$plist")" == '$(LIFESTREAM_APP_GROUP)' ]] ||
    fail "$plist must state the App Group the build names (LifestreamAppGroup), which AppGroup.identifier reads"
done
[[ "$(rg -c '^				LIFESTREAM_APP_GROUP = "group\.\$\(LIFESTREAM_BUNDLE_PREFIX\)\.phone";$' LifestreamCapture.xcodeproj/project.pbxproj)" == 5 ]] &&
  [[ "$(rg -c '^				LIFESTREAM_APP_GROUP = "group\.\$\(LIFESTREAM_BUNDLE_PREFIX\)\.phone\.onboarding";$' LifestreamCapture.xcodeproj/project.pbxproj)" == 1 ]] ||
  fail "the App Group is group.\$(LIFESTREAM_BUNDLE_PREFIX).phone, and .phone.onboarding in the Onboarding build"
if rg -n --glob '*.swift' 'group\.org\.lifestreamprotocol|(forSecurityApplicationGroupIdentifier|appGroup): "' LifestreamCapture ShareExtension UsageMonitorExtension Sources; then
  fail "no Swift file names an App Group: AppGroup.identifier reads the one the build states"
fi
[[ "$(/usr/libexec/PlistBuddy -c 'Print :NSExtension:NSExtensionPointIdentifier' ShareExtension/Info.plist)" == "com.apple.share-services" ]] ||
  fail "share extension point drifted"
/usr/libexec/PlistBuddy -c 'Print :NSExtension:NSExtensionAttributes:NSExtensionActivationRule' ShareExtension/Info.plist |
  rg -Fq 'NOT ($type UTI-CONFORMS-TO "public.url")' || fail "the share extension must not be offered for a link it refuses"

[[ "$(rg -v '^\s*(//.*)?$' Signing/Signing.xcconfig)" == 'DEVELOPMENT_TEAM = 4HH63Q6JYM
LIFESTREAM_BUNDLE_PREFIX = org.lifestreamprotocol
#include? "Local.xcconfig"' ]] ||
  fail "Signing/Signing.xcconfig states the project's team and bundle prefix, then includes the person's Local.xcconfig, and nothing else"
[[ "$(rg -c 'baseConfigurationReference = [0-9A-F]{24} /\* Signing\.xcconfig \*/;' LifestreamCapture.xcodeproj/project.pbxproj)" == 6 ]] ||
  fail "each of the project's six configurations is based on Signing/Signing.xcconfig"
if rg -n 'DEVELOPMENT_TEAM = ' LifestreamCapture.xcodeproj/project.pbxproj; then
  fail "the team is Signing/Signing.xcconfig's alone: a DEVELOPMENT_TEAM in project.yml beats the person's Local.xcconfig"
fi
rg -q 'PRODUCT_BUNDLE_IDENTIFIER = "\$\(LIFESTREAM_BUNDLE_PREFIX\)\.phone";' LifestreamCapture.xcodeproj/project.pbxproj ||
  fail "phone bundle identifier drifted"
if rg -n 'PRODUCT_BUNDLE_IDENTIFIER = ' LifestreamCapture.xcodeproj/project.pbxproj | rg -v '"\$\(LIFESTREAM_BUNDLE_PREFIX\)\.phone[.";]'; then
  fail "every bundle identifier is under \$(LIFESTREAM_BUNDLE_PREFIX).phone, so a person's Local.xcconfig moves them all"
fi
rg -q 'IPHONEOS_DEPLOYMENT_TARGET = 26\.0;' LifestreamCapture.xcodeproj/project.pbxproj ||
  fail "iOS 26 deployment target drifted"
rg -q 'SWIFT_VERSION = 6\.0;' LifestreamCapture.xcodeproj/project.pbxproj ||
  fail "strict Swift 6 mode drifted"
rg -q 'Self.setFact\(Fact.installID' Sources/LifestreamCaptureCore/CaptureStore.swift ||
  fail "the install id must live in the capture database"
if rg -n 'pasted_serial|pastedSerial|daily_phone_since|enrollment\.serial' LifestreamCapture Sources LifestreamCaptureUITests; then
  fail "the phone asks for no serial and states none; the home names the phone"
fi
rg -q 'CLMonitor\("[[:alnum:]]+"\)' LifestreamCapture/Location/GeofenceMonitor.swift ||
  fail "CLMonitor name must remain alphanumeric for iOS 27"
rg -q 'nonisolated func didReceive\(_ payloads: \[MXMetricPayload\]\)' LifestreamCapture/App/CaptureStateMonitor.swift ||
  fail "MetricKit callback must remain nonisolated from the main actor"
rg -q 'nonisolated private static func liveActivityHandler' LifestreamCapture/Motion/MotionRecorder.swift ||
  fail "Core Motion callback must retain its nonisolated Swift 6 bridge"
if rg -n 'extension (CMMotionActivity|CMPedometerData):.*unchecked Sendable' LifestreamCapture; then
  fail "Core Motion objects must be snapshotted before crossing isolation"
fi
rg -q 'nonisolated private static func observerHandler' LifestreamCapture/Health/HealthRecorder.swift ||
  fail "HealthKit observer callback must retain its nonisolated Swift 6 bridge"
rg -q 'appendReplayBatch' LifestreamCapture/Motion/MotionRecorder.swift ||
  fail "Motion history must retain durable replay suppression"
rg -q 'getRequestStatusForAuthorization' LifestreamCapture/Health/HealthRecorder.swift ||
  fail "Health queries must remain authorization-gated"

if rg -n 'org\.lifestream\.|vnd\.lifestream\.' LifestreamCapture Sources Tests LifestreamCaptureTests LifestreamCaptureUITests; then
  fail "superseded namespace found"
fi
if rg -n 'import CloudKit|CKContainer|NSUbiquitous' LifestreamCapture Sources; then
  fail "cloud transport is not allowed"
fi
if rg -n 'BGTaskScheduler|BGAppRefreshTask|BGProcessingTask|BGContinuedProcessingTask' LifestreamCapture Sources --glob '*.swift' --glob '!**/Shipping/BackgroundSync.swift'; then
  fail "only BackgroundSync may schedule background tasks"
fi
rg -Fq 'shipping.registerBackgroundSync()' LifestreamCapture/App/AppRuntime.swift ||
  fail "runtime bootstrap must register the scheduled wakes before launch finishes"
rg -Fq 'PhotosServices.shared.run' LifestreamCapture/Shipping/ShippingService.swift ||
  fail "shipping must run the photo pass on its own triggers"
if rg -n 'import Network|URLSession' LifestreamCapture Sources \
  --glob '!**/Shipping/ShippingService.swift' \
  --glob '!**/App/AppDelegate.swift' \
  --glob '!**/Connectors/LoopbackListener.swift'; then
  fail "only the shipper may own network transport"
fi
if rg -n 'URLSession|NWConnection\(to|NWConnection\(host' LifestreamCapture/Connectors/LoopbackListener.swift ||
  ! rg -Fq '.hostPort(host: .ipv4(.loopback), port: .any)' LifestreamCapture/Connectors/LoopbackListener.swift; then
  fail "the sign-in's listener binds 127.0.0.1 alone and opens no connection"
fi
if [[ -e LifestreamCapture/Private/google-places-api-key.txt ]]; then
  fail "LifestreamCapture/Private/google-places-api-key.txt: the phone holds no Google key; delete it"
fi
rg -Fq 'if pressed { return .now }' LifestreamCapture/Shipping/PhoneShipper.swift &&
  rg -Fq 'link.mobile(pressed: false).decide(.new, bytes:' LifestreamCapture/Shipping/PhoneShipper.swift ||
  fail "shipping asks HomeLink's MobileData of every bundle, but a pressed one (Ship now, Refresh now)"
rg -Fq 'AppRuntime.shared.bootstrap(launchOptions: launchOptions)' LifestreamCapture/App/AppDelegate.swift ||
  fail "all launches must bootstrap without waiting for a view"
if rg -n 'Task[ ({.]' LifestreamCapture/Location/AppOwnedRecorder.swift; then
  fail "the recorder makes no Task: its timers work in their blocks (MainActor.assumeIsolated)"
fi
[[ "$(rg -c 'MainActor.assumeIsolated' LifestreamCapture/Location/AppOwnedRecorder.swift)" == 2 ]] ||
  fail "the watch timer and the settle timer each do their work in their block"
rg -Fq 'shipping.shipper.ask(.wake)' LifestreamCapture/App/AppRuntime.swift ||
  fail "runtime bootstrap must start shipping on background launch"
if rg -n 'Timer' LifestreamCapture/Shipping/ShippingService.swift LifestreamCapture/Shipping/PhoneShipper.swift; then
  fail "the send clock's one timer is the shipper's own task"
fi
if find . -path './.build' -prune -o -type f \( -name '*.zip' -o -name '*.lifestream' -o -name '*.xcresult' \) -print | grep -q .; then
  fail "personal/runtime artifacts must not land in ios-app"
fi

rg -q 'CNContactVCardSerialization.descriptorForRequiredKeys\(\)' LifestreamCapture/Contacts/ContactSource.swift || fail "Contacts must fetch the serializer required keys"
if rg -n '(^|[[:space:]])import Contacts([[:space:]]|$)' LifestreamCapture Sources Tests LifestreamCaptureTests LifestreamCaptureUITests UsageMonitorExtension --glob '!LifestreamCapture/Contacts/**'; then fail "Contacts framework must stay inside LifestreamCapture/Contacts"; fi

echo "IOS CONTRACT CHECKS PASSED"
