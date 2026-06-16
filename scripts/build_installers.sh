#!/usr/bin/env bash
# Build the Cortex IDE one-click installers (.dmg / .exe / .AppImage).
#
# Prerequisites (dev machine only — NOT shipped to end users):
#   - Python env with requirements.txt installed  (the `mind-palace` conda env)
#   - PyInstaller            : pip install pyinstaller
#   - Rust toolchain         : https://rustup.rs
#   - Tauri CLI              : cargo install tauri-cli --version "^2"
#
# Produces: src-tauri/target/release/bundle/{dmg,nsis,appimage}/…
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> 1/3  Bundling the Python backend with PyInstaller"
pyinstaller --noconfirm cortex_backend.spec

echo "==> 2/3  Staging the backend binary as the Tauri sidecar"
mkdir -p src-tauri/binaries
# Tauri expects the sidecar named with the Rust target triple suffix.
TRIPLE="$(rustc -Vv | sed -n 's/host: //p')"
BIN="dist/cortex-backend/cortex-backend"
[ -f "$BIN" ] || BIN="dist/cortex-backend"
cp "$BIN" "src-tauri/binaries/cortex-backend-${TRIPLE}"
chmod +x "src-tauri/binaries/cortex-backend-${TRIPLE}"

echo "==> 3/3  Building the native installer via Tauri"
cd src-tauri
cargo tauri build

echo "✅  Installers are in src-tauri/target/release/bundle/"
