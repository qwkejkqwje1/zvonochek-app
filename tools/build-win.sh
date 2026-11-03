#!/usr/bin/env bash
# Кросс-сборка установщика Windows (NSIS) из Linux: tools/build-win.sh [x86_64|aarch64]
# Нужны: rustup target, cargo-xwin, tauri-cli, makensis (NSIS ≥ 3.9). Ключ подписи обновлений —
# TAURI_SIGNING_PRIVATE_KEY (или файл $ZV_UPDATER_KEY).
set -euo pipefail
ARCH="${1:-x86_64}"
TARGET="$ARCH-pc-windows-msvc"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -n "${ZV_UPDATER_KEY:-}" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$ZV_UPDATER_KEY")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
fi
# tauri-cli на Linux проверяет библиотеку трея Linux даже для цели Windows — подсовываем заглушку pkg-config
export PKG_CONFIG_PATH="$ROOT/tools/fakepc${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}" TAURI_LINUX_AYATANA_APPINDICATOR=1
# ring на aarch64-windows собирает C через «clang», а не clang-cl — подменяем обёрткой (см. tools/xwin-clang)
if [ "$ARCH" = "aarch64" ]; then
  export ZV_REAL_CLANG="${ZV_REAL_CLANG:-$(command -v clang)}" PATH="$ROOT/tools/xwin-clang:$PATH"
fi
cd "$ROOT/app"
tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis "${@:2}"
