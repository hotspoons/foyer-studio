#Requires -Version 5.1
<#
.SYNOPSIS
    Foyer Studio installer for Windows.

.DESCRIPTION
    Mirror of install.sh for Windows. Foyer's audio shim is Linux/macOS-only
    (the Ardour build it targets ships those platforms); Windows users run
    Foyer's backend in a Docker Desktop container. This installer drops the
    desktop shell + CLI binary into %LOCALAPPDATA%\Foyer Studio, adds a
    Start Menu shortcut, and appends the bin dir to the user PATH.

.PARAMETER Command
    install (default) | uninstall

.PARAMETER Version
    Tag to install. Default 'latest'.

.PARAMETER LatestCi
    Pull the most recent passing CI build via nightly.link instead of a
    tagged release. Useful when no formal release has been cut yet.

.PARAMETER FromBundle
    Use an already-extracted bundle directory instead of downloading. The
    directory must contain foyer.exe + foyer-desktop.exe at its root.

.PARAMETER NoPathEdit
    Skip the user PATH append. The shortcut + binaries still install.

.PARAMETER Purge
    Uninstall mode only: also wipe the install prefix entirely
    (config + state).

.EXAMPLE
    # Recommended one-liner:
    irm https://raw.githubusercontent.com/hotspoons/foyer-studio/main/install.ps1 | iex

.EXAMPLE
    # Latest passing CI build:
    .\install.ps1 -LatestCi

.EXAMPLE
    # Remove everything:
    .\install.ps1 uninstall -Purge
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'uninstall', 'help')]
    [string]$Command = 'install',

    [string]$Version = 'latest',

    [switch]$LatestCi,

    [string]$FromBundle = '',

    [switch]$NoPathEdit,

    [switch]$Purge
)

$ErrorActionPreference = 'Stop'

# ── Constants. Mirrors install.sh's env-override shape so an admin
#    can pin the install via $env:FOYER_RELEASE_REPO / FOYER_PREFIX. ──
$Repo   = if ($env:FOYER_RELEASE_REPO) { $env:FOYER_RELEASE_REPO } else { 'hotspoons/foyer-studio' }
$Prefix = if ($env:FOYER_PREFIX)       { $env:FOYER_PREFIX }       else { Join-Path $env:LOCALAPPDATA 'Foyer Studio' }
$BinDir = Join-Path $Prefix 'bin'
$CiBranch = if ($env:FOYER_CI_BRANCH)  { $env:FOYER_CI_BRANCH }    else { 'main' }
$StartMenuShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Foyer Studio.lnk'
$PathSentinelTag = 'foyer-studio-installer'

function Note($msg) { Write-Host "==> $msg" }
function Die($msg)  { Write-Error "install.ps1: $msg"; exit 1 }

function Get-Arch {
    # Win11 ARM64 boxes still report x64 for some build artifacts because
    # of x64 emulation, but the install dir for us is purely binary
    # selection. We default to x86_64 and only flip to arm64 when the
    # OS reports native arm64. Foyer doesn't ship a Windows arm64 build
    # yet — if the user is on one, fall back to x86_64 (emulation works
    # under Prism).
    $native = (Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture
    # 9 = x64, 12 = ARM64, 5 = ARM (32). We only treat 12 as arm64 today.
    if ($native -eq 12 -and (Test-Path "$env:SystemRoot\System32\arm64\cmd.exe")) {
        return 'arm64'
    }
    return 'x86_64'
}

function Get-AssetUrl {
    param([string]$Ver, [string]$Arch)
    $asset = "foyer-windows-$Arch.zip"
    if (-not $Ver -or $Ver -eq 'latest') {
        return "https://github.com/$Repo/releases/latest/download/$asset"
    }
    return "https://github.com/$Repo/releases/download/$Ver/$asset"
}

function Get-CiAssetUrl {
    param([string]$Arch)
    return "https://nightly.link/$Repo/workflows/ci/$CiBranch/foyer-windows-$Arch.zip"
}

function Download-And-Extract {
    param([string]$Url, [string]$WorkDir)
    $zipPath = Join-Path $WorkDir 'foyer.zip'
    Note "fetching $Url"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $zipPath
    } catch {
        Die "download failed (URL: $Url): $($_.Exception.Message)"
    }
    Expand-Archive -Path $zipPath -DestinationPath $WorkDir -Force
    # Release zip layout is foyer-windows-<arch>/{foyer.exe, foyer-desktop.exe}.
    # Nightly.link CI zip flattens to root. Probe both.
    $candidate = Get-ChildItem -Path $WorkDir -Directory -Filter 'foyer-*' | Select-Object -First 1
    if ($candidate -and (Test-Path (Join-Path $candidate.FullName 'foyer.exe'))) {
        return $candidate.FullName
    }
    if (Test-Path (Join-Path $WorkDir 'foyer.exe')) {
        return $WorkDir
    }
    Die "extracted bundle layout unrecognized at $WorkDir"
}

function Install-Files {
    param([string]$SourceDir)
    $foyerSrc       = Join-Path $SourceDir 'foyer.exe'
    $foyerDesktopSrc = Join-Path $SourceDir 'foyer-desktop.exe'

    if (-not (Test-Path $foyerSrc)) {
        Die "bundle missing foyer.exe at $foyerSrc"
    }

    if (-not (Test-Path $BinDir)) {
        New-Item -ItemType Directory -Path $BinDir | Out-Null
    }

    Copy-Item -Path $foyerSrc -Destination (Join-Path $BinDir 'foyer.exe') -Force
    Note "installed $BinDir\foyer.exe"

    if (Test-Path $foyerDesktopSrc) {
        Copy-Item -Path $foyerDesktopSrc -Destination (Join-Path $BinDir 'foyer-desktop.exe') -Force
        Note "installed $BinDir\foyer-desktop.exe"
    } else {
        Note "bundle has no foyer-desktop.exe — installing CLI only"
    }
}

function Install-StartMenu-Shortcut {
    $target = Join-Path $BinDir 'foyer-desktop.exe'
    if (-not (Test-Path $target)) {
        return
    }
    # WScript.Shell is the only zero-dep way to write a .lnk from
    # pure PowerShell. We could shell out to powershell.exe -c
    # "(New-Object -ComObject..." but the inline call is shorter.
    try {
        $wsh = New-Object -ComObject WScript.Shell
        $shortcut = $wsh.CreateShortcut($StartMenuShortcut)
        $shortcut.TargetPath = $target
        $shortcut.WorkingDirectory = $BinDir
        $shortcut.IconLocation = "$target,0"
        $shortcut.Description = 'Foyer Studio — web-native DAW control surface'
        $shortcut.WindowStyle = 1
        $shortcut.Save()
        Note "installed $StartMenuShortcut"
    } catch {
        Note "WARN: failed to create Start Menu shortcut: $($_.Exception.Message)"
    }
}

function Remove-StartMenu-Shortcut {
    if (Test-Path $StartMenuShortcut) {
        Remove-Item $StartMenuShortcut -Force
        Note "removed $StartMenuShortcut"
    }
}

# Append $BinDir to user PATH. We tag the segment with a sentinel so
# the uninstall path can find + remove it idempotently. The user-scope
# PATH lives in HKCU\Environment and is read on each new process; the
# user has to open a new shell to see the change.
function Add-ToPath {
    if ($NoPathEdit) {
        Note "NoPathEdit set, skipping PATH edit"
        return
    }
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ([string]::IsNullOrEmpty($current)) { $current = '' }
    $segments = $current -split ';' | Where-Object { $_ -ne '' }
    if ($segments -contains $BinDir) {
        Note "user PATH already contains $BinDir"
        return
    }
    $new = if ($segments.Count -gt 0) { ($segments -join ';') + ";$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable('Path', $new, 'User')
    Note "added $BinDir to user PATH (open a new shell to pick it up)"
}

function Remove-FromPath {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ([string]::IsNullOrEmpty($current)) { return }
    $segments = $current -split ';' | Where-Object { $_ -ne '' -and $_ -ne $BinDir }
    $new = $segments -join ';'
    [Environment]::SetEnvironmentVariable('Path', $new, 'User')
    Note "cleaned $BinDir from user PATH"
}

function Print-Post-Install-Hint {
    Write-Host ''
    Write-Host 'Foyer Studio installed.'
    Write-Host ''
    Write-Host 'Launch from:'
    Write-Host '  Start Menu > Foyer Studio'
    Write-Host '  Or run:    foyer-desktop'
    Write-Host ''
    Write-Host 'Windows users run the audio backend via Docker Desktop. On'
    Write-Host 'first launch the mode-picker will check for Docker Desktop'
    Write-Host 'and walk you through the audio integration choice.'
    Write-Host ''
    Write-Host 'Install Docker Desktop if you don''t have it:'
    Write-Host '  https://www.docker.com/products/docker-desktop/'
    Write-Host ''
    Write-Host 'Uninstall later:'
    Write-Host "  irm https://raw.githubusercontent.com/$Repo/main/install.ps1 | iex; .\install.ps1 uninstall"
    Write-Host '  (-Purge to also wipe config / state)'
}

function Do-Install {
    if ($LatestCi -and $FromBundle) {
        Die '-LatestCi and -FromBundle are mutually exclusive'
    }
    if ($LatestCi -and $Version -ne 'latest') {
        Die '-LatestCi and -Version are mutually exclusive'
    }

    $arch = Get-Arch
    Note "target: windows/$arch"
    Note "prefix: $Prefix"
    if ($LatestCi) {
        Note "source: latest passing CI on $CiBranch (via nightly.link)"
    }

    $cleanupWork = $null
    if ($FromBundle) {
        if (-not (Test-Path $FromBundle -PathType Container)) {
            Die "-FromBundle path not a directory: $FromBundle"
        }
        $sourceDir = (Resolve-Path $FromBundle).Path
    } else {
        $workDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "foyer-install-$(Get-Random)")
        $cleanupWork = $workDir.FullName
        $url = if ($LatestCi) { Get-CiAssetUrl -Arch $arch } else { Get-AssetUrl -Ver $Version -Arch $arch }
        $sourceDir = Download-And-Extract -Url $url -WorkDir $workDir.FullName
    }

    Install-Files -SourceDir $sourceDir
    Install-StartMenu-Shortcut
    Add-ToPath
    Print-Post-Install-Hint

    if ($cleanupWork -and (Test-Path $cleanupWork)) {
        Remove-Item $cleanupWork -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Do-Uninstall {
    Note "prefix: $Prefix"
    if (Test-Path (Join-Path $BinDir 'foyer.exe')) {
        Remove-Item (Join-Path $BinDir 'foyer.exe') -Force
        Note "removed $BinDir\foyer.exe"
    }
    if (Test-Path (Join-Path $BinDir 'foyer-desktop.exe')) {
        Remove-Item (Join-Path $BinDir 'foyer-desktop.exe') -Force
        Note "removed $BinDir\foyer-desktop.exe"
    }
    Remove-StartMenu-Shortcut
    Remove-FromPath

    if ($Purge) {
        if (Test-Path $Prefix) {
            Remove-Item $Prefix -Recurse -Force
            Note "purged $Prefix"
        }
    } else {
        # Best-effort: drop the bin dir if it's empty, leave any
        # session/config data put.
        if (Test-Path $BinDir) {
            $remaining = Get-ChildItem $BinDir -Force -ErrorAction SilentlyContinue
            if (-not $remaining) {
                Remove-Item $BinDir -Force
            }
        }
    }
    Note 'foyer uninstalled.'
}

function Show-Usage {
    Get-Help $MyInvocation.MyCommand.Path -Detailed
}

switch ($Command) {
    'install'   { Do-Install }
    'uninstall' { Do-Uninstall }
    'help'      { Show-Usage }
    default     { Show-Usage; Die "unknown command: $Command" }
}
