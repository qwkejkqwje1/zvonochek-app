@echo off
rem Build Zvonochek for Windows (requires Go 1.26+ from https://go.dev/dl/).
rem   build_windows.bat        tests + build
rem   build_windows.bat fast   build only
setlocal EnableExtensions
cd /d "%~dp0"

where go >nul 2>nul
if errorlevel 1 (
  echo Go is not installed. Download it from https://go.dev/dl/ and run this script again.
  pause
  exit /b 1
)

set CGO_ENABLED=0
set COMMIT=dev
for /f %%i in ('git rev-parse --short HEAD 2^>nul') do set COMMIT=%%i
set LDFLAGS=-s -w -X zvonochek2/internal/version.Commit=%COMMIT%

if /i "%~1"=="fast" goto build
echo [1/3] go vet + go test
go vet ./...
if errorlevel 1 goto fail
go test -count=1 ./...
if errorlevel 1 goto fail

:build
if not exist dist mkdir dist
echo [2/3] dist\zvonochek.exe
go build -trimpath -ldflags "%LDFLAGS% -H windowsgui" -o dist\zvonochek.exe ./cmd/zvonochek
if errorlevel 1 goto fail
echo [3/3] dist\zvonochek-relay.exe
go build -trimpath -ldflags "%LDFLAGS%" -o dist\zvonochek-relay.exe ./cmd/zvonochek-relay
if errorlevel 1 goto fail
echo.
echo Done: %~dp0dist\zvonochek.exe
exit /b 0

:fail
echo.
echo BUILD FAILED
pause
exit /b 1
