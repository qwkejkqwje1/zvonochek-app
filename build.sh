#!/usr/bin/env sh
# Сборка Звоночка для всех платформ в ./dist (нужен Go 1.26+).
#   ./build.sh               тесты + сборка
#   SKIP_TESTS=1 ./build.sh  только сборка
#   VERSION=3.0.1 ./build.sh своя версия (по умолчанию из internal/version)
set -eu
cd "$(dirname "$0")"

VERSION="${VERSION:-$(sed -n 's/^var Version = "\(.*\)"/\1/p' internal/version/version.go)}"
COMMIT="${COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
LDFLAGS="-s -w -X zvonochek2/internal/version.Version=${VERSION} -X zvonochek2/internal/version.Commit=${COMMIT}"
export CGO_ENABLED=0

if [ "${SKIP_TESTS:-0}" != "1" ]; then
	echo "==> go vet / go test"
	go vet ./...
	go test -count=1 ./...
fi

rm -rf dist
mkdir -p dist
echo "==> Звоночек ${VERSION} (${COMMIT})"

build() { # goos goarch output package [extra ldflags]
	GOOS="$1" GOARCH="$2" go build -trimpath -ldflags "${LDFLAGS} ${5:-}" -o "dist/$3" "./cmd/$4"
	echo "    dist/$3"
}

build windows amd64 zvonochek.exe                     zvonochek       "-H windowsgui"
build windows arm64 zvonochek-arm64.exe               zvonochek       "-H windowsgui"
build linux   amd64 zvonochek-linux-amd64             zvonochek
build windows amd64 zvonochek-relay-windows-amd64.exe zvonochek-relay
build linux   amd64 zvonochek-relay-linux-amd64       zvonochek-relay
build linux   arm64 zvonochek-relay-linux-arm64       zvonochek-relay

cd dist
if command -v sha256sum >/dev/null 2>&1; then sha256sum -- * > SHA256SUMS; else shasum -a 256 -- * > SHA256SUMS; fi
echo "==> dist/SHA256SUMS"
