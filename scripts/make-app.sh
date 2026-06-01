#!/bin/zsh
# DEPRECATED (Hono 移行): このスクリプトは旧 Next 前提の shell launcher を
# 生成する。通常配布は `npm run dist` (Electron / electron-builder, arm64,
# 固定ポート 47776) を使うこと。これは dogfood が安定するまで温存している
# legacy fallback であり、いずれ削除される。動作はまだ維持する。
#
# Generates "OPEN GROUND.app" — a double-click launcher for OPEN GROUND.
# Re-run this after replacing scripts/app-icon.png, or after the project
# folder is moved or renamed (the launcher script path is baked into the
# bundle's executable at build time).
#
# **port 47776 固定、単一インスタンス契約**
# The bundle enforces a fixed port (47776) and a single-instance contract:
# at most one OPEN GROUND dev server + Chrome --app window exists per user
# session. Re-launching the .app brings the existing window to the front
# (via Chrome AppleScript — hence NSAppleEventsUsageDescription below) and
# never spawns a second server or window. Port collisions on 47776 are a
# fatal error, not an auto-incremented fallback.

set -e

print -u2 "[DEPRECATED] make-app.sh は旧 Next 前提の legacy launcher。通常は npm run dist (Electron) を使ってください。dogfood 安定までの fallback です。"

# Derive PROJECT_DIR from this script's location so the build follows the
# repo if the folder is renamed or moved (no hardcoded absolute path).
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
APP="$PROJECT_DIR/OPEN GROUND.app"
LAUNCHER="$PROJECT_DIR/scripts/openground-launch.sh"
EXEC_NAME="OPEN GROUND"
ICON_NAME="OPEN GROUND"

cd "$PROJECT_DIR"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# --- Info.plist ---------------------------------------------------------
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>OPEN GROUND</string>
  <key>CFBundleDisplayName</key><string>OPEN GROUND</string>
  <key>CFBundleIdentifier</key><string>local.openground.launcher</string>
  <key>CFBundleVersion</key><string>2.0</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>${EXEC_NAME}</string>
  <key>CFBundleIconFile</key><string>${ICON_NAME}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSAppleEventsUsageDescription</key><string>OPEN GROUND uses Apple Events to bring its window to the front in Google Chrome.</string>
</dict>
</plist>
PLIST

# --- executable ---------------------------------------------------------
# Run the launcher under a login+interactive zsh so it inherits the full
# PATH (node via nvm, claude in ~/.local/bin). `exec` keeps a single PID
# so Cmd+Q delivers SIGTERM straight to the launcher's cleanup trap.
cat > "$APP/Contents/MacOS/${EXEC_NAME}" <<EXE
#!/bin/bash
exec /bin/zsh -lic 'exec "$LAUNCHER"'
EXE
chmod +x "$APP/Contents/MacOS/${EXEC_NAME}"

# --- icon ---------------------------------------------------------------
# Build the .icns from scripts/app-icon.png: give the artwork native macOS
# rounded corners (~22.4% radius) once at 1024 px, then downscale per size.
TMP="$(mktemp -d)"
ICONSET="$TMP/${ICON_NAME}.iconset"
MASTER="$TMP/master.png"
mkdir -p "$ICONSET"
magick scripts/app-icon.png -resize 1024x1024 \
  \( -size 1024x1024 xc:none -fill white -draw 'roundrectangle 0,0,1023,1023,229,229' \) \
  -compose CopyOpacity -composite "$MASTER"
for spec in 16:16x16 32:16x16@2x 32:32x32 64:32x32@2x 128:128x128 256:128x128@2x 256:256x256 512:256x256@2x 512:512x512 1024:512x512@2x; do
  px="${spec%%:*}"
  name="${spec##*:}"
  magick "$MASTER" -resize "${px}x${px}" "$ICONSET/icon_${name}.png"
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/${ICON_NAME}.icns"
rm -rf "$TMP"

# Nudge Finder/Dock to pick up the new icon.
touch "$APP"

echo "Built $APP"
