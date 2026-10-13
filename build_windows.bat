@echo off
chcp 65001 >nul
echo ========================================================
echo   Сборка и проверка Звоночек 2.2 (Клиент + Relay + Тесты)
echo ========================================================

set GOOS=windows
set GOARCH=amd64

echo [1/4] Загрузка и проверка зависимостей (go mod tidy)...
go mod tidy
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Не удалось выполнить go mod tidy.
    pause
    exit /b 1
)

echo [2/4] Запуск модульных тестов менеджера соединений и протокола (go test ./...)...
go test -v ./internal/...
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Модульные тесты не прошли!
    pause
    exit /b 1
)

echo [3/4] Компиляция клиента zvonochek.exe...
go build -ldflags="-s -w" -o zvonochek.exe ./cmd/zvonochek
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Не удалось собрать zvonochek.exe
    pause
    exit /b 1
)

echo [4/4] Компиляция ретранслятора zvonochek-relay.exe...
go build -ldflags="-s -w" -o zvonochek-relay.exe ./cmd/relay
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Не удалось собрать zvonochek-relay.exe
    pause
    exit /b 1
)

echo.
echo ========================================================
echo [УСПЕХ] Тесты пройдены, сборка успешно завершена!
echo   - Клиент:        zvonochek.exe
echo   - Relay-сервер:  zvonochek-relay.exe
echo ========================================================
pause
