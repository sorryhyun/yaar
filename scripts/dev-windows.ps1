# Start YAAR in app-window mode (simulates exe behavior from source).
# Opens a standalone Chrome/Edge --app window, then keeps the server running.
# Press Ctrl+C to stop.
#
# Usage: powershell -File scripts/dev-windows.ps1 [claude|codex]

param(
    [string]$Provider = "claude"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "Using provider: $Provider"

# Build prerequisite packages
Write-Host "Building shared package..."
bun run --filter @yaar/shared build
Write-Host "Building compiler package..."
bun run --filter @yaar/compiler build
Write-Host "Building frontend..."
bun run --filter @yaar/frontend build

# Determine port
$Port = if ($env:PORT) { $env:PORT } else { "8000" }

# Start server in background, capturing stdout to extract the token
$LogFile = Join-Path ([System.IO.Path]::GetTempPath()) "yaar-server-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).log"

Write-Host "Starting server..."
$env:PROVIDER = $Provider
$env:REMOTE = "1"
$ServerProc = Start-Process -FilePath "bun" `
    -ArgumentList "run","--filter","@yaar/server","dev","--elide-lines=0" `
    -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err"

# Cleanup function
function Stop-All {
    Write-Host "`nShutting down..."
    if ($ServerProc -and !$ServerProc.HasExited) {
        Stop-Process -Id $ServerProc.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -Force $LogFile -ErrorAction SilentlyContinue
    Remove-Item -Force "$LogFile.err" -ErrorAction SilentlyContinue
}

# Wait for server to be ready
Write-Host "Waiting for server on port $Port..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    if ($ServerProc.HasExited) {
        Write-Host "Server output:"
        if (Test-Path $LogFile) { Get-Content $LogFile }
        if (Test-Path "$LogFile.err") { Get-Content "$LogFile.err" }
        Write-Error "Server process died."
        exit 1
    }
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 1
        $ready = $true
        Write-Host "Server is ready."
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}

if (-not $ready) {
    Write-Error "Server did not start within 60 seconds."
    Stop-All
    exit 1
}

# Extract remote token from server log output (banner prints "Token:   <token>")
$Token = $null
if (Test-Path $LogFile) {
    $logContent = Get-Content $LogFile -Raw
    if ($logContent -match "Token:\s+(\S+)") {
        $Token = $Matches[1]
    }
}

$Url = "http://127.0.0.1:$Port"
if ($Token) {
    $Url = "$Url/#remote=$Token"
    Write-Host "Got remote token."
} else {
    Write-Host "Warning: Could not extract remote token from server output."
}

# Find a Chromium browser (prefer Chrome over Edge)
function Find-Chromium {
    # Most reliable: check Windows registry for Chrome install path
    $regPaths = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
    )
    foreach ($reg in $regPaths) {
        try {
            $p = (Get-ItemProperty $reg -ErrorAction Stop).'(Default)'
            if ($p -and (Test-Path $p)) { return $p }
        } catch {}
    }

    # Filesystem fallback for Chrome
    $dirs = @($env:LOCALAPPDATA, $env:PROGRAMFILES, ${env:PROGRAMFILES(X86)})
    foreach ($dir in $dirs) {
        if (-not $dir) { continue }
        $p = Join-Path $dir "Google\Chrome\Application\chrome.exe"
        if (Test-Path $p) { return $p }
    }

    # Edge as last resort
    foreach ($dir in @($env:PROGRAMFILES, ${env:PROGRAMFILES(X86)})) {
        if (-not $dir) { continue }
        $p = Join-Path $dir "Microsoft\Edge\Application\msedge.exe"
        if (Test-Path $p) { return $p }
    }
    return $null
}

$Browser = Find-Chromium

if (-not $Browser) {
    Write-Host "No Chromium browser found. Open manually: $Url"
    Write-Host "Press Ctrl+C to stop the server."
    try { $ServerProc.WaitForExit() } finally { Stop-All }
    exit 0
}

# Launch in --app mode with isolated user-data-dir so Chrome starts a fresh
# process instead of delegating to an already-running instance.
$UserDataDir = Join-Path ([System.IO.Path]::GetTempPath()) "yaar-app-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null

Write-Host "Opening: $Url"
Start-Process -FilePath $Browser -ArgumentList @(
    "--app=$Url",
    "--user-data-dir=$UserDataDir",
    "--disable-background-networking",
    "--disable-default-apps",
    "--no-first-run"
)

# Keep server running until Ctrl+C
Write-Host "Press Ctrl+C to stop the server."
try {
    $ServerProc.WaitForExit()
} finally {
    Stop-All
}
