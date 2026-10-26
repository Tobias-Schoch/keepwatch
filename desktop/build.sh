#!/bin/sh
# Builds Keepwatch.app with its widget extension (no Xcode project needed) and signs it.
#   ./build.sh             build only (build/Keepwatch.app)
#   ./build.sh --install   build, install to /Applications/Keepwatch.app and launch it
#
# Signing: KEEPWATCH_SIGN_IDENTITY="Developer ID Application: ..." if set, otherwise the first
# "Developer ID Application" identity in your keychain, otherwise ad hoc (the widgets then only
# show sample data - see README).
# Notarization: only if a notarytool profile exists (KEEPWATCH_NOTARY_PROFILE, default
# "keepwatch-notary"); a locally built app needs none.
set -eu

cd "$(dirname "$0")"
ROOT=$(pwd)
BUILD="$ROOT/build"
APP="$BUILD/Keepwatch.app"
DEST="/Applications/Keepwatch.app"
BUNDLE_ID="io.github.keepwatch.desktop"
VERSION="1.0"
BUILD_NO=$(date +%Y%m%d%H%M)
ARCH=$(uname -m)
TARGET="$ARCH-apple-macos15.0"
APPEX="$APP/Contents/PlugIns/KeepwatchWidgets.appex"
NOTARY=${KEEPWATCH_NOTARY_PROFILE:-keepwatch-notary}

INSTALL=0
case "${1:-}" in
  --install) INSTALL=1 ;;
  ""|--no-copy) ;;
  *) echo "usage: $0 [--install]" >&2; exit 2 ;;
esac

command -v swiftc >/dev/null || { echo "swiftc missing: install the Xcode Command Line Tools (xcode-select --install)" >&2; exit 1; }

SIGN_ID=${KEEPWATCH_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Developer ID Application/ {print $2; exit}')}
# The app group must start with the team ID (macOS form, no provisioning profile needed).
TEAM=$(printf '%s' "$SIGN_ID" | sed -nE 's/.*\(([A-Z0-9]{10})\)$/\1/p')
if [ -n "$TEAM" ]; then GROUP="$TEAM.$BUNDLE_ID"; else GROUP="$BUNDLE_ID"; fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APPEX/Contents/MacOS" "$BUILD/tmp"

echo "> Compiling the app ($ARCH)"
swiftc -O -swift-version 5 -parse-as-library \
  -target "$TARGET" \
  -module-name Keepwatch \
  -o "$APP/Contents/MacOS/Keepwatch" \
  Sources/*.swift Shared/*.swift Widgets/Model.swift

echo "> Compiling the widgets"
# Entry point like Xcode: _NSExtensionMain (Foundation) sets up the extension and then calls the
# WidgetBundle's @main. Without it the extension aborts ("Unrecognized extension type").
swiftc -O -swift-version 5 -parse-as-library -application-extension \
  -target "$TARGET" \
  -module-name KeepwatchWidgets \
  -Xlinker -e -Xlinker _NSExtensionMain \
  -o "$APPEX/Contents/MacOS/KeepwatchWidgets" \
  Widgets/*.swift Shared/*.swift

if [ -f ../lib/backup-pull.sh ]; then
  echo "> Bundling the backup pull script"
  cp ../lib/backup-pull.sh "$APP/Contents/Resources/backup-pull.sh"
  chmod 755 "$APP/Contents/Resources/backup-pull.sh"
else
  echo "> ../lib/backup-pull.sh not found - \"Pull Backup\" will not work in this build"
fi

echo "> Drawing the icon"
swiftc -O -swift-version 5 -o "$BUILD/tmp/MakeIcon" Tools/MakeIcon.swift
rm -rf "$BUILD/tmp/AppIcon.iconset"
"$BUILD/tmp/MakeIcon" "$BUILD/tmp/AppIcon.iconset" >/dev/null
iconutil -c icns "$BUILD/tmp/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>Keepwatch</string>
  <key>CFBundleDisplayName</key><string>Keepwatch</string>
  <key>CFBundleExecutable</key><string>Keepwatch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NO</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppleEventsUsageDescription</key><string>Keepwatch opens Terminal with an SSH session to your server.</string>
  <key>NSHumanReadableCopyright</key><string>Desktop client for Keepwatch. Open source.</string>
  <key>KeepwatchAppGroup</key><string>$GROUP</string>
  <!-- The admin UIs come through the SSH tunnel from http://localhost:<port>. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <!-- Widget click: keepwatch://open/<page> -->
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>$BUNDLE_ID</string>
    <key>CFBundleURLSchemes</key><array><string>keepwatch</string></array>
  </dict></array>
</dict>
</plist>
PLIST

cat > "$APPEX/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID.widgets</string>
  <key>CFBundleName</key><string>KeepwatchWidgets</string>
  <key>CFBundleDisplayName</key><string>Keepwatch</string>
  <key>CFBundleExecutable</key><string>KeepwatchWidgets</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NO</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>KeepwatchAppGroup</key><string>$GROUP</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
PLIST

cat > "$BUILD/tmp/entitlements.plist" <<ENT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <!-- "Open Terminal" drives Terminal via AppleScript. -->
  <key>com.apple.security.automation.apple-events</key><true/>
  <!-- Shared with the widgets (snapshot, "last pulled"). Team ID prefix: no profile needed. -->
  <key>com.apple.security.application-groups</key><array><string>$GROUP</string></array>
</dict></plist>
ENT
# Widgets always run sandboxed and without network: they only read the snapshot the app fetches
# through its SSH tunnel and stores in the app group.
cat > "$BUILD/tmp/widgets.entitlements.plist" <<ENT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.application-groups</key><array><string>$GROUP</string></array>
</dict></plist>
ENT
if [ -n "$SIGN_ID" ]; then
  echo "> Signing: $SIGN_ID (hardened runtime)"
  # Extension first, then the app (no --deep, otherwise the extension loses its entitlements).
  codesign --force --options runtime --timestamp --entitlements "$BUILD/tmp/widgets.entitlements.plist" -s "$SIGN_ID" "$APPEX"
  codesign --force --options runtime --timestamp --entitlements "$BUILD/tmp/entitlements.plist" -s "$SIGN_ID" "$APP"
else
  # Ad hoc there is no team ID: the app group is not granted, the widgets only show the sample.
  echo "> Signing ad hoc (no Developer ID in the keychain - widgets without data)"
  codesign --force -s - --entitlements "$BUILD/tmp/widgets.entitlements.plist" "$APPEX"
  codesign --force -s - --entitlements "$BUILD/tmp/entitlements.plist" "$APP"
fi
codesign --verify --strict --deep "$APP"

# Notarize if a notarytool profile exists - once:
#   xcrun notarytool store-credentials keepwatch-notary --apple-id <apple-id> --team-id <team> --password <app-specific password>
if [ -n "$SIGN_ID" ] && xcrun notarytool history --keychain-profile "$NOTARY" >/dev/null 2>&1; then
  echo "> Notarizing with Apple (takes 1-3 min)"
  ditto -c -k --keepParent "$APP" "$BUILD/tmp/Keepwatch.zip"
  xcrun notarytool submit "$BUILD/tmp/Keepwatch.zip" --keychain-profile "$NOTARY" --wait
  xcrun stapler staple "$APP"
  spctl --assess --type execute "$APP" && echo "  Gatekeeper: accepted"
fi

if [ "$INSTALL" = 1 ]; then
  # Quit the running copy so the new one starts cleanly
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  pkill -f "Keepwatch.app/Contents/MacOS/Keepwatch" 2>/dev/null || true
  sleep 1
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  # Make it known to Spotlight and Launchpad
  LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  "$LSREG" -f "$DEST" >/dev/null 2>&1 || true
  # Offer the widgets only from /Applications, not twice from build/.
  "$LSREG" -u "$APP" >/dev/null 2>&1 || true
  pluginkit -r "$APPEX" >/dev/null 2>&1 || true
  pluginkit -a "$DEST/Contents/PlugIns/KeepwatchWidgets.appex" >/dev/null 2>&1 || true
  mdimport "$DEST" >/dev/null 2>&1 || true
  open "$DEST"
  echo "OK $DEST (launched)"
else
  echo "OK $APP  (install with: $0 --install)"
fi
