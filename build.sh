#!/bin/bash
set -e

echo "=== Сборка Звоночек 2.1 (Linux / macOS) ==="
go mod tidy
go build -ldflags="-s -w" -o zvonochek ./cmd/zvonochek
go build -ldflags="-s -w" -o zvonochek-relay ./cmd/relay
echo "Сборка завершена: ./zvonochek и ./zvonochek-relay"
