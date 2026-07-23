# YAAR installer for Windows (PowerShell)
#
# Usage:
#   irm https://github.com/sorryhyun/yaar/releases/latest/download/install.ps1 | iex
#
# Options (env vars):
#   $env:INSTALL_DIR  — where to put the binary (default: ~\.local\bin)
#   $env:VERSION      — specific version tag (default: latest)

$ErrorActionPreference = "Stop"

# Invoke-WebRequest redraws a progress bar on every response chunk, which throttles
# large downloads (the YAAR binary is tens of MB) by an order of magnitude. Silencing
# it is the single biggest speedup; the curl.exe fast path below is faster still.
$ProgressPreference = "SilentlyContinue"

$Repo = "sorryhyun/yaar"
$BinaryName = "yaar"
$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $HOME ".local\bin" }

# — Download helper ————————————————————————————————————————————————————
#
# Prefer curl.exe (bundled with Windows 10 1803+): it streams to disk without .NET's
# response buffering and is markedly faster on large files. Fall back to
# Invoke-WebRequest (progress bar already disabled above) when curl is absent.
$CurlExe = Get-Command curl.exe -ErrorAction SilentlyContinue

function Get-File {
    param([string]$Uri, [string]$OutFile)

    if ($CurlExe) {
        # -L follow redirects (GitHub asset URLs redirect to a CDN), -f fail on HTTP
        # errors so a 404 body is not written as if it were the file, --retry for
        # transient CDN blips.
        & $CurlExe.Source -sSL -f --retry 3 -o $OutFile $Uri
        if ($LASTEXITCODE -ne 0) { throw "curl.exe failed to download $Uri (exit $LASTEXITCODE)" }
    } else {
        Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
    }
}

# — Resolve version ——————————————————————————————————————————————————

function Resolve-Version {
    if ($env:VERSION) { return $env:VERSION }

    try {
        $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
        return $release.tag_name
    } catch {
        Write-Error "Could not determine latest version."
        exit 1
    }
}

# — Main ——————————————————————————————————————————————————————————————

$Version = Resolve-Version
$AssetName = "$BinaryName-windows-x64.exe"
$Url = "https://github.com/$Repo/releases/download/$Version/$AssetName"

Write-Host "Installing YAAR $Version for windows-x64..."

# Download
$TmpFile = Join-Path ([System.IO.Path]::GetTempPath()) $AssetName
try {
    Get-File -Uri $Url -OutFile $TmpFile
} catch {
    Write-Error "Failed to download: $Url`nCheck that version '$Version' exists."
    exit 1
}

# Install
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Dest = Join-Path $InstallDir "$BinaryName.exe"
Move-Item -Force $TmpFile $Dest

Write-Host ""
Write-Host "Installed to: $Dest"

# Bundled apps — the exe reads them from apps\ next to the binary, so extract the
# (platform-independent) apps archive into $InstallDir. Non-fatal on failure.
$AppsUrl = "https://github.com/$Repo/releases/download/$Version/yaar-apps.tar.gz"
$AppsTmp = Join-Path ([System.IO.Path]::GetTempPath()) "yaar-apps.tar.gz"
try {
    Get-File -Uri $AppsUrl -OutFile $AppsTmp
    tar -xzf $AppsTmp -C $InstallDir
    Remove-Item -Force $AppsTmp -ErrorAction SilentlyContinue
    Write-Host "Installed bundled apps to: $(Join-Path $InstallDir 'apps')"
} catch {
    Write-Host "Could not download bundled apps ($AppsUrl); YAAR will start with no apps."
}

# Check PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$InstallDir;$UserPath", "User")
    Write-Host ""
    Write-Host "$InstallDir added to your PATH. Restart your terminal, then run 'yaar'."
} else {
    Write-Host "Run 'yaar' to start."
}

# Create desktop shortcut
try {
    $DesktopPath = [Environment]::GetFolderPath("Desktop")
    $ShortcutPath = Join-Path $DesktopPath "YAAR.lnk"
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $Dest
    $Shortcut.WorkingDirectory = $InstallDir
    $Shortcut.Description = "YAAR - AI Interface"
    $Shortcut.Save()
    Write-Host "Desktop shortcut created."
} catch {
    Write-Host "Could not create desktop shortcut: $_"
}
