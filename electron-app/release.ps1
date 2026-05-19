$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host " ================================================" -ForegroundColor Cyan
Write-Host "   Jonin CT - Publish New Version to GitHub" -ForegroundColor Cyan
Write-Host " ================================================" -ForegroundColor Cyan
Write-Host ""

# Read current version
$pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
$curVer = $pkg.version
Write-Host " Current version: $curVer" -ForegroundColor Yellow
Write-Host ""

# Ask for new version
$newVer = Read-Host " New version (e.g. 1.3.0)"
if ([string]::IsNullOrWhiteSpace($newVer)) { Write-Host "ERROR: Version cannot be empty." -ForegroundColor Red; exit 1 }

# Auto-fix X.Y -> X.Y.0
if ($newVer -match '^\d+\.\d+$') {
    $newVer = "$newVer.0"
    Write-Host " Auto-fixed to: $newVer" -ForegroundColor Green
}

# Validate X.Y.Z format
if ($newVer -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "ERROR: Version must be in format X.Y.Z (e.g. 1.3.0)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host " Get your token at: github.com > Settings > Developer settings > Personal access tokens" -ForegroundColor Gray
Write-Host " Required scope: repo" -ForegroundColor Gray
Write-Host ""
$ghToken = Read-Host " GitHub token (ghp_...)"
if ([string]::IsNullOrWhiteSpace($ghToken)) { Write-Host "ERROR: Token cannot be empty." -ForegroundColor Red; exit 1 }

Write-Host ""

# Helper: write UTF-8 WITHOUT BOM (required for JSON files)
function WriteUtf8NoBom($path, $content) {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Resolve-Path $path).Path, $content, $utf8)
}

# [1/4] Update package.json
Write-Host " [1/4] Updating package.json to v$newVer..."
$content = Get-Content "package.json" -Raw
$content = $content -replace '"version": "[^"]+"', "`"version`": `"$newVer`""
WriteUtf8NoBom "package.json" $content

# [2/4] Update Discord bot
Write-Host " [2/4] Updating Discord bot download link..."
$botFile = "..\discord-bot\index.js"
if (Test-Path $botFile) {
    $content = Get-Content $botFile -Raw
    $content = $content -replace "DOWNLOAD_VERSION = '[^']+'", "DOWNLOAD_VERSION = '$newVer'"
    $content = $content -replace 'releases/download/v[\d\.]+/', "releases/download/v$newVer/"
    $content = $content -replace 'Jonin-CT-Setup-[\d\.]+\.exe', "Jonin-CT-Setup-$newVer.exe"
    WriteUtf8NoBom $botFile $content
}

# [3/4] npm install
Write-Host " [3/4] Installing dependencies..."
npm install --silent 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: npm install failed." -ForegroundColor Red; exit 1 }

# [4/4] Publish
Write-Host " [4/4] Building and publishing v$newVer..."
$env:GH_TOKEN = $ghToken
npm run publish
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Publish failed. Check your GitHub token." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host " ================================================" -ForegroundColor Green
Write-Host "   SUCCESS! v$newVer published to GitHub" -ForegroundColor Green
Write-Host " ================================================" -ForegroundColor Green
Write-Host ""
Write-Host " Next steps:" -ForegroundColor Yellow
Write-Host "  1. Check: github.com/Medic1502/copymarket/releases"
Write-Host "     Make sure release is NOT a draft (click Publish if needed)"
Write-Host ""
Write-Host "  2. In Discord run:"
Write-Host "     /postdownload version:$newVer link:https://github.com/Medic1502/copymarket/releases/download/v$newVer/Jonin-CT-Setup-$newVer.exe"
Write-Host ""
Write-Host "  3. Existing users auto-update within ~5 minutes"
Write-Host ""
Read-Host " Press Enter to close"
