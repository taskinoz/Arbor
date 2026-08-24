#!/usr/bin/env bash
# Builds the Tauri app in release mode and installs the .app bundle into
# ~/Applications, replacing any previous copy.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_NAME="Arbor"
BUNDLE_DIR="src-tauri/target/release/bundle/macos"
DEST_DIR="$HOME/Applications"

echo "==> Building ${APP_NAME}.app (release)..."
npm run tauri -- build --bundles app

SRC_APP="${BUNDLE_DIR}/${APP_NAME}.app"
if [ ! -d "$SRC_APP" ]; then
  echo "error: build succeeded but ${SRC_APP} was not found" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
DEST_APP="${DEST_DIR}/${APP_NAME}.app"

echo "==> Installing to ${DEST_APP}"
rm -rf "$DEST_APP"
cp -R "$SRC_APP" "$DEST_APP"

echo "==> Done. ${APP_NAME}.app installed to ${DEST_DIR}"
