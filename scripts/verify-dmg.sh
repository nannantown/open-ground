#!/usr/bin/env bash
#
# verify-dmg.sh — sanity-check a built OPEN GROUND .dmg: mount it, read the app's
# version + binary architecture, optionally probe a feature marker, then detach
# cleanly. Use it after `npm run dist` or after downloading a release artifact, to
# confirm "the dmg I think is vX.Y.Z really contains vX.Y.Z, arm64".
#
#   scripts/verify-dmg.sh <path-to.dmg> [expected-version] [feature-marker]
#
# Example:
#   scripts/verify-dmg.sh ~/Downloads/"OPEN GROUND-0.11.11-arm64.dmg" 0.11.11 swarmOrchestrator
#
# ---------------------------------------------------------------------------
# TWO FOOTGUNS THIS SCRIPT EXISTS TO AVOID (2026-06-25 release post-mortem,
# memory reference_og_dmg_verify_and_autoupdate). Both are about reading the
# WRONG thing during verification, which is far more dangerous than a build bug:
#
#   1. MOUNT-VOLUME MIX-UP. Mounting several OG dmgs leaves multiple
#      "/Volumes/OPEN GROUND …" volumes (macOS appends " 1", " 2" on name
#      collisions). Selecting the volume with `ls -d /Volumes/OPEN\ GROUND* | head`
#      grabs an UNRELATED (different-version) volume and misreads its version. That
#      once produced a phantom "v0.11.7 dmg actually contains 0.10.1" → an
#      /Applications DOWNGRADE + an imaginary "CI bug" + a panic release. The fix:
#      take the mount point from THIS attach's OWN hdiutil output, never from a
#      directory listing of /Volumes.
#
#   2. ROSETTA ARCH MISREAD. Under Rosetta 2 a shell can run as x86_64 on Apple
#      Silicon, so `uname -m` reports the HARDWARE as Intel. We read the real
#      machine with `sysctl` (untranslated), and the artifact's arch with `lipo`
#      (the actual Mach-O), never `uname -m`.
# ---------------------------------------------------------------------------
set -euo pipefail

die() { printf 'verify-dmg: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

DMG="${1:-}"
EXPECTED_VERSION="${2:-}"
FEATURE_MARKER="${3:-}"

[ -n "$DMG" ] || die "usage: verify-dmg.sh <path-to.dmg> [expected-version] [feature-marker]"
[ -f "$DMG" ] || die "no such dmg: $DMG"
# `uname -s` (kernel name) is fine — Rosetta only mistranslates `uname -m` (machine).
[ "$(uname -s)" = "Darwin" ] || die "macOS only (needs hdiutil / lipo / sysctl)"

# --- 1. Host architecture via sysctl, NEVER `uname -m` ----------------------
# Use `var=$(cmd) || var=default`, NOT `var=$(cmd || echo default)`: under `set -e`
# the latter double-captures when a failing cmd also prints to stdout (e.g. grep -c
# prints "0" AND exits 1 → "0\n0" → a later `[ -gt ]` is an integer-expr error).
host_brand=$(sysctl -n machdep.cpu.brand_string 2>/dev/null) || host_brand='unknown'
# hw.optional.arm64 is 1 on Apple Silicon, absent/0 on Intel — true hardware,
# unaffected by a Rosetta-translated shell.
host_is_arm=$(sysctl -n hw.optional.arm64 2>/dev/null) || host_is_arm=0
echo "Host machine (sysctl, Rosetta-proof):"
note "cpu      : $host_brand"
note "arm64 hw : $([ "$host_is_arm" = "1" ] && echo 'yes (Apple Silicon)' || echo 'no (Intel)')"
echo

# --- 2. Attach the dmg; read the mount point from hdiutil's OWN output -------
# Detach on EVERY exit so a failed verification never leaks a mounted volume.
# `cleanup` resolves DEV/VOL at call time (set below), so defining it first is safe.
cleanup() {
  local target="${DEV:-$VOL}" i
  for i in 1 2 3; do
    hdiutil detach "$target" >/dev/null 2>&1 && return 0
    sleep 1
  done
  hdiutil detach "$target" -force >/dev/null 2>&1 || true
}

echo "Mounting $DMG …"
attach_out=$(hdiutil attach -nobrowse -noverify -noautoopen "$DMG" 2>&1) \
  || die "hdiutil attach failed:
$attach_out"

# The mount point is the /Volumes/… path printed by THIS attach (last such line —
# the mounted data partition). This is the anti-footgun #1 line: it comes from
# attach output, not from `ls /Volumes | head`, so it is always THIS dmg's volume
# even when other OG volumes are mounted.
VOL=$(printf '%s\n' "$attach_out" | grep -oE '/Volumes/.*' | tail -1 || true)
# The whole-image dev node (e.g. /dev/disk4) for a robust detach-by-device — names
# can collide, device nodes don't.
DEV=$(printf '%s\n' "$attach_out" | grep -oE '/dev/disk[0-9]+' | head -1 || true)
# Arm the detach NOW — BEFORE the mount-point sanity checks — so a `die` on an
# unparseable/odd VOL still detaches the device (a trap armed after these checks
# would strand /dev/diskN; Rev2 F1).
trap cleanup EXIT
[ -n "$VOL" ] || die "could not find a mount point in hdiutil output:
$attach_out"
[ -d "$VOL" ] || die "mount point does not exist: $VOL"

note "volume   : $VOL"
note "device   : ${DEV:-<unknown>}"
echo

# --- 3. Read version + binary arch from the mounted .app --------------------
APP=$(/bin/ls -d "$VOL"/*.app 2>/dev/null | head -1 || true)
[ -n "$APP" ] && [ -d "$APP" ] || die "no .app found inside $VOL"
INFO="$APP/Contents/Info.plist"
[ -f "$INFO" ] || die "no Info.plist in $APP"

version=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$INFO" 2>/dev/null) || version=''
exe_name=$(/usr/libexec/PlistBuddy -c "Print CFBundleExecutable" "$INFO" 2>/dev/null) || exe_name=''
[ -n "$version" ] || die "could not read CFBundleShortVersionString from $INFO"

BIN="$APP/Contents/MacOS/$exe_name"
arch='unknown'
if [ -n "$exe_name" ] && [ -f "$BIN" ]; then
  # lipo reads the Mach-O's real slices — the artifact's arch, not the host's.
  arch=$(lipo -archs "$BIN" 2>/dev/null || file -b "$BIN" 2>/dev/null || echo 'unknown')
fi

echo "Bundle ($APP):"
note "version  : $version"
note "arch     : $arch"

# --- 4. Optional feature probe (anti-footgun: confirm content, not just name) -
if [ -n "$FEATURE_MARKER" ]; then
  server_bundle="$APP/Contents/Resources/app/server/dist/index.cjs"
  if [ -f "$server_bundle" ]; then
    # -F: match the marker as a literal string (markers are identifiers, but never
    # let a `.`/`*` in one be taken as a regex). `… || hits=0` keeps the no-match
    # exit-1 from double-capturing under `set -e` (see §1 comment).
    hits=$(grep -Fc "$FEATURE_MARKER" "$server_bundle" 2>/dev/null) || hits=0
    note "marker   : '$FEATURE_MARKER' in $hits line(s) of server/dist/index.cjs"
    [ "$hits" -gt 0 ] || die "feature marker '$FEATURE_MARKER' NOT found — wrong/stale build?"
  else
    note "marker   : (skipped — $server_bundle not present in this bundle layout)"
  fi
fi
echo

# --- 5. Verdict -------------------------------------------------------------
status=0
if [ -n "$EXPECTED_VERSION" ]; then
  if [ "$version" = "$EXPECTED_VERSION" ]; then
    echo "✓ version matches expected ($EXPECTED_VERSION)"
  else
    echo "✗ version MISMATCH: bundle is $version, expected $EXPECTED_VERSION" >&2
    status=1
  fi
fi
case "$arch" in
  *arm64*) ;;
  *) echo "⚠ artifact arch is '$arch' (no arm64 slice) — OPEN GROUND ships arm64" >&2 ;;
esac

[ "$status" -eq 0 ] && echo "verify-dmg: OK"
exit "$status"
