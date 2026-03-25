# YAAR installer for Windows (PowerShell)
#
# Usage:
#   irm https://raw.githubusercontent.com/sorryhyun/yaar/master/install.ps1 | iex
#
# Options (env vars):
#   $env:INSTALL_DIR  — where to put the binary (default: ~\.local\bin)
#   $env:VERSION      — specific version tag (default: latest)

$ErrorActionPreference = "Stop"

$Repo = "sorryhyun/yaar"
$BinaryName = "yaar"
$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $HOME ".local\bin" }

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
    Invoke-WebRequest -Uri $Url -OutFile $TmpFile -UseBasicParsing
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
