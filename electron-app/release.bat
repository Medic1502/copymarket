@echo off
title Jonin CT — Publish New Version
cls
echo.
echo  ================================================
echo    Jonin CT — Publish New Version to GitHub
echo  ================================================
echo.

REM Read current version
for /f "tokens=2 delims=:," %%a in ('findstr /i "\"version\"" package.json') do (
    set CURVER=%%a
    goto :found
)
:found
set CURVER=%CURVER: =%
set CURVER=%CURVER:"=%

echo  Current version: %CURVER%
echo.
set /p NEWVER= New version (must be X.Y.Z, e.g. 1.3.0):
if "%NEWVER%"=="" (echo  ERROR: Version cannot be empty. & pause & exit /b 1)

REM Auto-add .0 if user typed X.Y instead of X.Y.Z
echo %NEWVER% | findstr /r "^[0-9][0-9]*\.[0-9][0-9]*$" >nul 2>&1
if not errorlevel 1 (
    set NEWVER=%NEWVER%.0
    echo  Auto-fixed to: %NEWVER%
)

REM Validate format X.Y.Z
echo %NEWVER% | findstr /r "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Version must be in format X.Y.Z ^(e.g. 1.3.0^)
    pause & exit /b 1
)

echo.
echo  Get your token at: github.com ^> Settings ^> Developer settings ^> Personal access tokens
echo  Required scope: repo
echo.
set /p GH_TOKEN= GitHub token (ghp_...):
if "%GH_TOKEN%"=="" (echo  ERROR: Token cannot be empty. & pause & exit /b 1)

echo.
echo  [1/4] Updating package.json to v%NEWVER%...
powershell -NoProfile -Command ^
  "$f = 'package.json'; $c = Get-Content $f -Raw; $c = $c -replace '\"version\": \"[^\"]+\"', '\"version\": \"%NEWVER%\"'; Set-Content $f $c -Encoding UTF8"

echo  [2/4] Updating Discord bot download link...
powershell -NoProfile -Command ^
  "$f = '..\discord-bot\index.js'; $c = Get-Content $f -Raw; $c = $c -replace \"DOWNLOAD_VERSION = '[^']+'\", \"DOWNLOAD_VERSION = '%NEWVER%'\"; $c = $c -replace 'releases/download/v[0-9]+\.[0-9]+\.[0-9]+/', 'releases/download/v%NEWVER%/'; $c = $c -replace 'Jonin-CT-Setup-[0-9]+\.[0-9]+\.[0-9]+\.exe', 'Jonin-CT-Setup-%NEWVER%.exe'; Set-Content $f $c -Encoding UTF8"

echo  [3/4] Installing dependencies...
call npm install --silent 2>nul
if errorlevel 1 (echo  ERROR: npm install failed. & pause & exit /b 1)

echo  [4/4] Building and publishing v%NEWVER%...
set GH_TOKEN=%GH_TOKEN%
call npm run publish
if errorlevel 1 (echo  ERROR: Publish failed. Check your GitHub token and internet connection. & pause & exit /b 1)

echo.
echo  ================================================
echo    SUCCESS! v%NEWVER% published to GitHub
echo  ================================================
echo.
echo  Next steps:
echo   1. Check: github.com/Medic1502/copymarket/releases
echo      Make sure release is NOT a draft ^(click Publish if needed^)
echo.
echo   2. In Discord run:
echo      /postdownload version:%NEWVER% link:https://github.com/Medic1502/copymarket/releases/download/v%NEWVER%/Jonin-CT-Setup-%NEWVER%.exe
echo.
echo   3. Existing users auto-update within ~5 minutes
echo.
pause
