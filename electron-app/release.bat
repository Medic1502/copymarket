@echo off
title Jonin CT — Publish New Version
cls
echo.
echo  ================================================
echo    Jonin CT — Publish New Version to GitHub
echo  ================================================
echo.

REM Show current version
for /f "tokens=2 delims=:," %%a in ('findstr /i "\"version\"" package.json') do (
    set CURVER=%%a
    goto :found
)
:found
set CURVER=%CURVER: =%
set CURVER=%CURVER:"=%

echo  Current version: %CURVER%
echo.
set /p NEWVER= New version (e.g. 1.3.0):
if "%NEWVER%"=="" (echo  ERROR: Version cannot be empty. & pause & exit /b 1)

echo.
echo  Get your token at: github.com ^> Settings ^> Developer settings ^> Personal access tokens
echo  Required scope: repo
echo.
set /p GH_TOKEN= GitHub token (ghp_...):
if "%GH_TOKEN%"=="" (echo  ERROR: Token cannot be empty. & pause & exit /b 1)

echo.
echo  [1/4] Updating package.json to v%NEWVER%...
powershell -NoProfile -Command ^
  "$f = 'package.json'; $c = Get-Content $f -Raw; $c = $c -replace '\"version\": \"%CURVER%\"', '\"version\": \"%NEWVER%\"'; Set-Content $f $c -Encoding UTF8"

echo  [2/4] Updating Discord bot download link...
powershell -NoProfile -Command ^
  "$f = '..\discord-bot\index.js'; $c = Get-Content $f -Raw; $c = $c -replace 'DOWNLOAD_VERSION = ''[^'']+''', 'DOWNLOAD_VERSION = ''%NEWVER%'''; $c = $c -replace 'releases/download/v[^/]+/Jonin', 'releases/download/v%NEWVER%/Jonin'; $c = $c -replace 'Jonin-CT-Setup-[^.]+\.[^.]+\.[^'']+', 'Jonin-CT-Setup-%NEWVER%'; Set-Content $f $c -Encoding UTF8"

echo  [3/4] Installing dependencies...
call npm install --silent 2>nul
if errorlevel 1 (echo  ERROR: npm install failed. & pause & exit /b 1)

echo  [4/4] Building and publishing v%NEWVER%...
set GH_TOKEN=%GH_TOKEN%
call npm run publish
if errorlevel 1 (echo  ERROR: publish failed. Check token and internet connection. & pause & exit /b 1)

echo.
echo  ================================================
echo    SUCCESS! v%NEWVER% is live on GitHub Releases
echo  ================================================
echo.
echo  Next steps:
echo   1. Go to: github.com/Medic1502/copymarket/releases
echo      and make sure the release is published (not draft)
echo.
echo   2. In Discord, run:
echo      /postdownload version:%NEWVER% link:https://github.com/Medic1502/copymarket/releases/download/v%NEWVER%/Jonin-CT-Setup-%NEWVER%.exe
echo.
echo   3. Existing users will auto-update within ~5 minutes
echo.
pause
