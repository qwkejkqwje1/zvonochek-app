#!/usr/bin/env bash
# Синхронизация встроенной копии веб-клиента: ui/web ← репозиторий веба на заданном коммите.
# Заменяется только signaling.js (мост к ядру, ui/desktop/signaling.js); service worker не регистрируется (preload).
#   WEB_DIR=../zvonochek.github.io tools/sync-web.sh [коммит]   (веб: github.com/ZVONochek/zvonochek.github.io)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="${WEB_DIR:-$ROOT/../zvonochek.github.io}"
REV="${1:-HEAD}"
OUT="$ROOT/ui/web"
COMMIT="$(git -C "$WEB_DIR" rev-parse --short "$REV")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git -C "$WEB_DIR" archive "$COMMIT" | tar -x -C "$TMP"
VER="$(sed -n 's/^export const APP_VERSION = \([0-9]*\);.*/\1/p' "$TMP/app.js")"
[ -n "$VER" ] || { echo "не нашёл APP_VERSION" >&2; exit 1; }
rm -rf "$OUT"
mkdir -p "$OUT"
# только то, что нужно клиенту в браузере
for f in index.html style.css manifest.webmanifest version.json icon.svg sw.js; do
  [ -f "$TMP/$f" ] && cp "$TMP/$f" "$OUT/"
done
cp "$TMP"/*.js "$OUT/"
mkdir -p "$OUT/vendor" "$OUT/icons"
cp "$TMP"/vendor/qrcode.js "$TMP"/vendor/secp256k1.js "$OUT/vendor/"
cp "$TMP"/icons/* "$OUT/icons/"
# мост к ядру вместо signaling.js
sed "s/__WEBVER__/$VER/g" "$ROOT/ui/desktop/signaling.js" > "$OUT/signaling.js"
# проверка: интерфейс Signaling, который зовёт app.js, не изменился
grep -q "import { Signaling } from './signaling.js?v=$VER'" "$OUT/app.js" || { echo "app.js импортирует signaling иначе — проверь мост" >&2; exit 1; }
for api in "S.sig.start()" "S.sig.onTransportUp" "sendByeBeacon" "deliveryStats"; do
  grep -qF "$api" "$OUT/app.js" || { echo "app.js больше не использует $api — проверь мост" >&2; exit 1; }
done
printf 'commit=%s\nver=%s\nsource=https://github.com/ZVONochek/zvonochek.github.io\n' "$COMMIT" "$VER" > "$OUT/WEB_VERSION"
echo "ui/web ← $COMMIT (v$VER)"
