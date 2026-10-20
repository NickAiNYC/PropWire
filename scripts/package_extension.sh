#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
EXT_DIR="$DIST_DIR/extension"

echo "==> Packaging PROP·WIRE Manifest V3 Chrome Extension Side Panel..."

rm -rf "$EXT_DIR" "$DIST_DIR/propwire-extension-v1.2.0.zip"
mkdir -p "$EXT_DIR/icons"

# 1. Copy viewer assets (static frontend)
cp -R "$ROOT_DIR/viewer/"* "$EXT_DIR/"

# 2. Copy extension manifest and background worker
cp "$ROOT_DIR/extension/manifest.json" "$EXT_DIR/"
cp "$ROOT_DIR/extension/background.js" "$EXT_DIR/"

# 3. Copy icons
cp -R "$ROOT_DIR/extension/icons/"* "$EXT_DIR/icons/"

# 4. Create ZIP bundle
(cd "$DIST_DIR" && zip -q -r "propwire-extension-v1.2.0.zip" "extension")

echo "==> Build complete:"
echo "    - Unpacked directory : $EXT_DIR"
echo "    - Distribution bundle: $DIST_DIR/propwire-extension-v1.2.0.zip"
