@echo off
chcp 65001 >nul
echo ========================================================
echo   Отправка проекта Звоночек 2.1 в ваш GitHub-репозиторий
echo ========================================================
echo.
set /p GH_USER="Введите ваш логин GitHub: "
set /p GH_REPO="Введите название репозитория (например, zvonochek2): "
set /p GH_TOKEN="Вставьте ваш НОВЫЙ GitHub Personal Access Token: "

if not exist .git (
    git init
    git branch -M main
)

git add .
git commit -m "feat: Zvonochek 2.1 with Invite system, WebRTC queue, and Go libp2p Audio Bridge"

git remote remove origin 2>nul
git remote add origin https://%GH_USER%:%GH_TOKEN%@github.com/%GH_USER%/%GH_REPO%.git

echo.
echo Отправка кода на GitHub...
git push -u origin main

REM Удаляем токен из URL локального git конфига после отправки для безопасности
git remote set-url origin https://github.com/%GH_USER%/%GH_REPO%.git

echo.
echo [ГОТОВО] Код отправлен в https://github.com/%GH_USER%/%GH_REPO%
pause
