#!/bin/zsh
# Sign + notarize "OPEN GROUND.app" for distribution outside the Mac App
# Store. Run after `scripts/make-app.sh`.
#
# Prerequisites (one-time setup):
#   1. Apple Developer Program membership ($99/yr).
#   2. A "Developer ID Application" certificate installed in Keychain.
#      Find it in Xcode → Settings → Accounts → Manage Certificates.
#   3. An app-specific password for notarytool:
#      https://support.apple.com/en-us/HT204397
#   4. Store the credentials in a keychain profile once so this script
#      doesn't have to read secrets from env vars every run. Fill in YOUR OWN
#      Apple ID and Team ID — these are placeholders:
#        xcrun notarytool store-credentials "openground-notary" \
#          --apple-id "${APPLE_ID:-you@example.com}" \
#          --team-id "${APPLE_TEAM_ID:-YOUR_TEAM_ID}" \
#          --password xxxx-xxxx-xxxx-xxxx
#
# Env vars this script reads:
#   DEVELOPER_ID  — exact identity string of YOUR cert, e.g.
#                   "Developer ID Application: Your Name (YOUR_TEAM_ID)".
#                   Required. (YOUR_TEAM_ID = your 10-char Apple Team ID.)
#   NOTARY_PROFILE — name of the keychain profile created above.
#                    Defaults to "openground-notary".
#
# Output: a signed, notarized, stapled .app ready to be zipped + uploaded
# to GitHub Releases (or similar).

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
APP="$PROJECT_DIR/OPEN GROUND.app"
ENTITLEMENTS="$PROJECT_DIR/scripts/entitlements.plist"

if [[ -z "$DEVELOPER_ID" ]]; then
  echo "FATAL: DEVELOPER_ID env var is required."
  echo "  e.g. export DEVELOPER_ID=\"Developer ID Application: Your Name (ABCDE12345)\""
  exit 1
fi
NOTARY_PROFILE="${NOTARY_PROFILE:-openground-notary}"

if [[ ! -d "$APP" ]]; then
  echo "FATAL: $APP not found. Run scripts/make-app.sh first."
  exit 1
fi
if [[ ! -f "$ENTITLEMENTS" ]]; then
  echo "FATAL: $ENTITLEMENTS not found."
  exit 1
fi

echo "[sign] codesign --options runtime --entitlements $ENTITLEMENTS"
# --deep walks the bundle and signs nested binaries. --force overwrites
# any prior signature (re-runs after a fresh make-app.sh).
codesign --force --deep --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --sign "$DEVELOPER_ID" \
  "$APP"

echo "[sign] verifying signature…"
codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose "$APP" || echo "[sign] spctl reports unsigned bystanders; investigate before shipping"

# Notarization requires a zip; .app bundles can't be uploaded directly.
ZIP="$PROJECT_DIR/OPEN-GROUND.app.zip"
echo "[notarize] creating $ZIP for upload…"
rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"

echo "[notarize] submitting to Apple notary service (may take 1–5 minutes)…"
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait

echo "[notarize] stapling the notarization ticket to the .app…"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

# The zip is rebuilt with the stapled .app inside so downloaders get a
# fully-validated bundle even before they double-click.
rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"

echo "Done. Signed, notarized, stapled bundle at:"
echo "  $APP"
echo "Distributable zip at:"
echo "  $ZIP"
