#!/bin/bash
# Пароль профиля и обновление в zv-devhost: тестовый релиз (update-fixture.mjs) на http.server :8797,
# devhost --vault на :8791 (данные — /tmp/zvdev8791), тест devhost-update-vault.mjs.
#   tests/e2e/update-vault.sh [путь к zv-devhost]
set -e
cd "$(dirname "$0")/../.."
DEVHOST=${1:-target/debug/zv-devhost}
FIX=/tmp/zvupd8797
rm -rf "$FIX" /tmp/zvdev8791
KEY=$(node tests/e2e/update-fixture.mjs "$FIX" http://127.0.0.1:8797)
(cd "$FIX" && exec python3 -m http.server 8797 --bind 127.0.0.1 > /tmp/zvupd8797.log 2>&1) &
HTTP=$!
ZV_UPDATE_URL=http://127.0.0.1:8797/latest.json ZV_UPDATE_KEY=$KEY "$DEVHOST" --port 8791 --ui ui --data /tmp/zvdev8791 --vault > /tmp/zvdev8791.log 2>&1 &
DEV=$!
trap 'kill $HTTP $DEV 2>/dev/null' EXIT
sleep 3
node tests/e2e/devhost-update-vault.mjs http://127.0.0.1:8791
