# Reader Windows launcher build script (ASCII-only for Windows PowerShell 5.1 compatibility)
# ---------------------------------------------------------------------------
# What it does:
#   1. Uses the custom multi-size icon at launcher/reader.ico
#   2. Compiles launcher/ReaderLauncher.cs with the .NET Framework csc.exe shipped with Windows
#   3. Embeds all front-end assets (html/js/css/content books) into a single dist/Reader.exe
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File launcher\build.ps1
#   powershell -ExecutionPolicy Bypass -File launcher\build.ps1 -CreateShortcut
#
# Requires: .NET Framework 4.x (bundled with Windows 10/11). No Go/Node/Python needed.
# ---------------------------------------------------------------------------
param(
    [string]$OutputDir = '',
    [switch]$CreateShortcut
)

$ErrorActionPreference = 'Stop'

$launcherDir = $PSScriptRoot
$root = Split-Path -Parent $launcherDir
if (-not $OutputDir) {
    $OutputDir = Join-Path $root 'dist'
}
$objDir = Join-Path $launcherDir 'obj'
$csPath = Join-Path $launcherDir 'ReaderLauncher.cs'
if (-not (Test-Path -LiteralPath $csPath)) {
    throw ('launcher source not found: ' + $csPath + '. Rename ReaderLauncher_reviewed.cs to ReaderLauncher.cs.')
}

Write-Host '== Reader launcher build ==' -ForegroundColor Cyan
Write-Host ('repo root : ' + $root)
Write-Host ('output    : ' + $OutputDir)

# ---------- 1. locate csc.exe ----------
$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $null
foreach ($candidate in $cscCandidates) {
    if (Test-Path $candidate) { $csc = $candidate; break }
}
if (-not $csc) {
    throw 'csc.exe not found. .NET Framework 4.x is required (bundled with Windows 10/11).'
}
Write-Host ('csc       : ' + $csc)

New-Item -ItemType Directory -Force -Path $objDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# ---------- 2. use custom application icon ----------
$iconPath = Join-Path $launcherDir 'reader.ico'
if (-not (Test-Path -LiteralPath $iconPath)) {
    throw ('custom icon missing: ' + $iconPath + '. Put reader.ico alongside build.ps1.')
}
Write-Host ('icon      : ' + $iconPath)

# ---------- 3. collect front-end assets ----------
$singleAssets = @(
    'index.html',
    'app.js',
    'i18n.js',
    'styles.css',
    'pdf-reader.css',
    'appearance.css',
    'lang-detect.js',
    'pdf-chapters.js',
    'pdf-loader.js',
    'pdf-import.js',
    'pdf-reader.js',
    'background.js',
    'content/library.json',
    'content/manifest.json',
    'tools/db-migration.html',
    'tools/manifest-generator.html'
)
$assets = New-Object System.Collections.Generic.List[string]
foreach ($rel in $singleAssets) { $assets.Add($rel) }
foreach ($langDir in @('zh', 'en')) {
    $files = Get-ChildItem -Path (Join-Path $root ('content\' + $langDir)) -Filter '*.md' -File | Sort-Object Name
    foreach ($file in $files) { $assets.Add('content/' + $langDir + '/' + $file.Name) }
}
Write-Host ('assets    : ' + $assets.Count + ' files')

# ---------- 4. build resource map ----------
$mapLines = New-Object System.Collections.Generic.List[string]
$resourceArgs = New-Object System.Collections.Generic.List[string]
$index = 0
foreach ($rel in $assets) {
    $full = Join-Path $root ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $full)) {
        throw ('missing front-end asset: ' + $rel)
    }
    $logical = ('asset{0:D3}' -f $index)
    $resourceArgs.Add(('/resource:' + $full + ',' + $logical))
    $mapLines.Add($rel + '|' + $logical)
    $index += 1
}
$mapFile = Join-Path $objDir 'assets.map'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($mapFile, $mapLines, $utf8NoBom)
$resourceArgs.Add(('/resource:' + $mapFile + ',assets.map'))
$resourceArgs.Add(('/resource:' + $iconPath + ',reader.favicon'))

# ---------- 5. compile ----------
$exePath = Join-Path $OutputDir 'Reader.exe'
if (Test-Path $exePath) { Remove-Item $exePath -Force }

$cscArgs = @(
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/codepage:65001',
    ('/win32icon:' + $iconPath),
    ('/out:' + $exePath),
    '/r:System.dll',
    '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll'
)
$cscArgs += $resourceArgs.ToArray()
$cscArgs += $csPath

& $csc $cscArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exePath)) {
    throw ('compile failed, csc exit code: ' + $LASTEXITCODE)
}

$sizeMB = [Math]::Round((Get-Item $exePath).Length / 1MB, 2)
Write-Host ('built     : ' + $exePath + ' (' + $sizeMB + ' MB)') -ForegroundColor Green
Write-Host ''
Write-Host 'Run: double-click dist\Reader.exe. A small status window opens and the browser is launched automatically.'
Write-Host 'Port: default localhost:8080 (same origin as python -m http.server 8080).'
Write-Host 'Tip : first run of an unsigned exe may trigger SmartScreen; choose "Run anyway" if you trust the build.'
Write-Host ''

# ---------- 6. optional desktop shortcut ----------
if ($CreateShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop 'Reader.lnk'
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $exePath
    $shortcut.WorkingDirectory = $OutputDir
    $shortcut.IconLocation = $exePath + ',0'
    $shortcut.Description = 'Reader'
    $shortcut.Save()
    Write-Host ('shortcut  : ' + $shortcutPath) -ForegroundColor Green
}
