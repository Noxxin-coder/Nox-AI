[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Repository = 'Noxxin-coder/Nox-AI',
    [string]$PackagePath,
    [string]$Sha256
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-ReleaseAsset {
    param([object[]]$Assets, [string]$Name)

    $selectedAssets = @($Assets | Where-Object { $_.name -ceq $Name })
    if ($selectedAssets.Count -ne 1) {
        throw "The selected GitHub release must contain exactly one '$Name' asset."
    }
    return $selectedAssets[0]
}

function Get-ReleaseDownloadUri {
    param([object]$Asset, [string]$ExpectedPath)

    $uri = [Uri]$Asset.browser_download_url
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com' -or -not $uri.AbsolutePath.StartsWith($ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Release asset '$($Asset.name)' has an unexpected download URL."
    }
    return $uri.AbsoluteUri
}

function Notify-UserEnvironmentChanged {
    if (-not ('NoxAiEnvironmentBroadcast' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NoxAiEnvironmentBroadcast {
    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, UInt32 Msg, UIntPtr wParam, string lParam,
        UInt32 fuFlags, UInt32 uTimeout, out UIntPtr lpdwResult);
}
'@
    }
    $result = [UIntPtr]::Zero
    [void][NoxAiEnvironmentBroadcast]::SendMessageTimeout(
        [IntPtr]0xffff,
        0x001A,
        [UIntPtr]::Zero,
        'Environment',
        0x0002,
        5000,
        [ref]$result
    )
}

function Assert-SafeArchive {
    param([string]$ArchivePath)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        if ($archive.Entries.Count -eq 0 -or $archive.Entries.Count -gt 1000) {
            throw 'The release archive has an invalid number of entries.'
        }
        $totalLength = 0L
        foreach ($entry in $archive.Entries) {
            $totalLength += $entry.Length
            if ($entry.Length -gt 400MB -or $totalLength -gt 400MB) {
                throw 'The expanded release archive exceeds the 400 MB safety limit.'
            }
            if (($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000) {
                throw "Archive contains a symbolic link: '$($entry.FullName)'."
            }
            $name = $entry.FullName.Replace('\', '/')
            if ($name.StartsWith('/') -or $name.Contains(':') -or @($name.Split('/')) -contains '..') {
                throw "Archive contains an unsafe path: '$($entry.FullName)'."
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Add-UserPathEntry {
    param([string]$InstallDirectory)

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @()
    if (-not [string]::IsNullOrWhiteSpace($userPath)) {
        $entries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    $normalizedTarget = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
    $userHasTarget = $false
    foreach ($entry in $entries) {
        try {
            if ([IO.Path]::GetFullPath($entry).TrimEnd('\').Equals($normalizedTarget, [StringComparison]::OrdinalIgnoreCase)) {
                $userHasTarget = $true
                break
            }
        }
        catch {
            continue
        }
    }
    $processEntries = @($env:Path -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $processHasTarget = $false
    foreach ($entry in $processEntries) {
        try {
            if ([IO.Path]::GetFullPath($entry.Trim('"')).TrimEnd('\').Equals($normalizedTarget, [StringComparison]::OrdinalIgnoreCase)) {
                $processHasTarget = $true
                break
            }
        }
        catch {
            continue
        }
    }
    if (-not $userHasTarget) {
        $entries += $normalizedTarget
        [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
    }
    if (-not $processHasTarget) {
        $env:Path = "$normalizedTarget;$env:Path"
    }
    if (-not $userHasTarget -or -not $processHasTarget) {
        Notify-UserEnvironmentChanged
    }
}

function Assert-NoCommandCollision {
    param([string]$InstallDirectory)

    $target = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
    $pathEntries = @()
    foreach ($scope in @('Process', 'User', 'Machine')) {
        $pathValue = [Environment]::GetEnvironmentVariable('Path', $scope)
        if (-not [string]::IsNullOrWhiteSpace($pathValue)) {
            $pathEntries += @($pathValue -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        }
    }
    foreach ($entry in ($pathEntries | Select-Object -Unique)) {
        try {
            $directory = [IO.Path]::GetFullPath($entry.Trim('"')).TrimEnd('\')
        }
        catch {
            continue
        }
        if ($directory.Equals($target, [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        foreach ($name in @('nox.cmd', 'nox.exe')) {
            $candidate = Join-Path $directory $name
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                throw "Another '$name' is already available from '$directory'. Resolve the command conflict before installing Nox AI."
            }
        }
    }
}

function Read-InstallMarker {
    param([string]$InstallDirectory)

    $markerPath = Join-Path $InstallDirectory 'nox-install.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        return $null
    }
    try {
        $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Existing installation marker is invalid: $markerPath"
    }
    if ($marker.productId -ne 'nox-ai' -or [string]::IsNullOrWhiteSpace([string]$marker.version)) {
        throw "Refusing to replace an unrecognized installation at '$InstallDirectory'."
    }
    return $marker
}

function Test-InstallContents {
    param([string]$Directory)

    $required = @(
        'nox.cmd',
        'nox-install.json',
        'uninstall.ps1',
        'README.md',
        'LICENSE',
        'runtime\node.exe',
        'dist\src\cli.js',
        'dist\src\server.js',
        'dist\src\web\index.html'
    )
    foreach ($relativePath in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Directory $relativePath) -PathType Leaf)) {
            throw "Release package is missing required file '$relativePath'."
        }
    }
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Nox AI currently provides a Windows installer only.'
    }
    if ([Environment]::OSVersion.Version.Major -lt 10) {
        throw 'Nox AI requires Windows 10 or later.'
    }
    if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -ne 'X64') {
        throw 'This release supports 64-bit x64 Windows only.'
    }
    if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
        throw 'Repository must have the form owner/repository.'
    }
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is not available; install from a normal per-user Windows session.'
    }

    $installParent = Join-Path $env:LOCALAPPDATA 'Programs'
    $installDirectory = Join-Path $installParent 'Nox AI'
    $dataDirectory = Join-Path $env:LOCALAPPDATA 'Nox AI'
    $drive = [System.IO.DriveInfo]::new([IO.Path]::GetPathRoot($installParent))
    if ($drive.AvailableFreeSpace -lt 500MB) {
        throw 'At least 500 MB of free space is required for the application, its bundled runtime, and a safe upgrade.'
    }
    $temporaryDrive = [System.IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetTempPath()))
    if ($temporaryDrive.AvailableFreeSpace -lt 500MB) {
        throw 'At least 500 MB of free space is required on the temporary download/extraction volume.'
    }
    foreach ($runtimeFile in @('vcruntime140.dll', 'msvcp140.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $env:WINDIR "System32\$runtimeFile") -PathType Leaf)) {
            throw "Required Microsoft Visual C++ runtime file '$runtimeFile' is missing. Install the official Microsoft Visual C++ 2015-2022 x64 Redistributable from https://aka.ms/vs/17/release/vc_redist.x64.exe, then rerun the installer."
        }
    }

    $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("nox-ai-install-" + [Guid]::NewGuid().ToString('N'))
    $stageDirectory = $null
    $backupDirectory = $null
    New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $archivePath = Join-Path $temporaryDirectory 'nox-release.zip'
        $expectedHash = $Sha256

        if (-not [string]::IsNullOrWhiteSpace($PackagePath)) {
            if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
                throw "Package file does not exist: $PackagePath"
            }
            if ($expectedHash -notmatch '^[A-Fa-f0-9]{64}$') {
                throw 'A 64-character SHA-256 value is required when installing a local package.'
            }
            Copy-Item -LiteralPath $PackagePath -Destination $archivePath
        }
        else {
            $headers = @{ 'User-Agent' = 'Nox-AI-Installer'; 'Accept' = 'application/vnd.github+json' }
            $releaseUri = "https://api.github.com/repos/$Repository/releases/latest"
            try {
                $release = Invoke-RestMethod -Uri $releaseUri -Headers $headers -TimeoutSec 30
            }
            catch {
                throw "Could not read the latest stable release from $Repository. No installation was changed. $($_.Exception.Message)"
            }
            if ($release.draft -or $release.prerelease -or [string]::IsNullOrWhiteSpace([string]$release.tag_name)) {
                throw 'GitHub did not return a published stable release.'
            }
            $tag = [string]$release.tag_name
            $packageName = "nox-ai-$tag-win-x64.zip"
            $packageAsset = Get-ReleaseAsset -Assets $release.assets -Name $packageName
            $checksumAsset = Get-ReleaseAsset -Assets $release.assets -Name 'SHA256SUMS.txt'
            if ($packageAsset.size -gt 250MB) {
                throw 'The release archive exceeds the 250 MB download limit.'
            }
            $assetPathPrefix = "/$Repository/releases/download/$tag/"
            $packageUri = Get-ReleaseDownloadUri -Asset $packageAsset -ExpectedPath $assetPathPrefix
            $checksumUri = Get-ReleaseDownloadUri -Asset $checksumAsset -ExpectedPath $assetPathPrefix
            $checksumPath = Join-Path $temporaryDirectory 'SHA256SUMS.txt'
            Invoke-WebRequest -Uri $checksumUri -OutFile $checksumPath -TimeoutSec 120 -UseBasicParsing
            if ((Get-Item -LiteralPath $checksumPath).Length -gt 1MB) {
                throw 'The release checksum file exceeds the 1 MB safety limit.'
            }
            Invoke-WebRequest -Uri $packageUri -OutFile $archivePath -TimeoutSec 300 -UseBasicParsing
            $checksumLines = @(Get-Content -LiteralPath $checksumPath |
                Where-Object { $_ -match ('^\s*([A-Fa-f0-9]{64})\s+\*?' + [Regex]::Escape($packageName) + '\s*$') } |
                Select-Object -First 2)
            if ($checksumLines.Count -ne 1) {
                throw "SHA256SUMS.txt must contain exactly one valid checksum for '$packageName'."
            }
            $expectedHash = [Regex]::Match($checksumLines[0], '([A-Fa-f0-9]{64})').Groups[1].Value
            if ($packageAsset.digest -and $packageAsset.digest -ne "sha256:$($expectedHash.ToLowerInvariant())") {
                throw 'GitHub release asset digest does not match the published checksum file.'
            }
        }

        if ((Get-Item -LiteralPath $archivePath).Length -gt 250MB) {
            throw 'The release archive exceeds the 250 MB download limit.'
        }
        $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
        if (-not $actualHash.Equals($expectedHash, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Release checksum verification failed. Expected $expectedHash; received $actualHash."
        }
        Assert-SafeArchive -ArchivePath $archivePath

        $stageDirectory = Join-Path $installParent ('.Nox-AI-install-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $installParent -Force | Out-Null
        $parentItem = Get-Item -LiteralPath $installParent -Force
        if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to install through a junction or symbolic link at '$installParent'."
        }
        New-Item -ItemType Directory -Path $stageDirectory -Force | Out-Null
        Expand-Archive -LiteralPath $archivePath -DestinationPath $stageDirectory
        Test-InstallContents -Directory $stageDirectory

        $newMarker = Get-Content -LiteralPath (Join-Path $stageDirectory 'nox-install.json') -Raw | ConvertFrom-Json
        if ($newMarker.productId -ne 'nox-ai') {
            throw 'The package has an unexpected product identity.'
        }
        $oldMarker = Read-InstallMarker -InstallDirectory $installDirectory
        if ((Test-Path -LiteralPath $installDirectory) -and -not $oldMarker) {
            throw "An unmanaged directory already exists at '$installDirectory'; it was not changed."
        }
        if (Test-Path -LiteralPath $installDirectory) {
            $existingItem = Get-Item -LiteralPath $installDirectory -Force
            if (($existingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to replace a junction or symbolic link at '$installDirectory'."
            }
        }
        Assert-NoCommandCollision -InstallDirectory $installDirectory

        if ($PSCmdlet.ShouldProcess($installDirectory, 'Install verified Nox AI release')) {
            if ($oldMarker) {
                $launcher = Join-Path $installDirectory 'nox.cmd'
                if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
                    throw 'The existing managed installation is missing its launcher; upgrade aborted without replacing it.'
                }
                & $launcher stop
                if ($LASTEXITCODE -ne 0) {
                    throw "Could not stop the current Nox AI backend (exit code $LASTEXITCODE); upgrade aborted."
                }
            }

            if ($oldMarker) {
                $backupDirectory = Join-Path $installParent ('.Nox-AI-backup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N'))
                Move-Item -LiteralPath $installDirectory -Destination $backupDirectory
            }
            $originalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            $originalProcessPath = $env:Path
            try {
                Move-Item -LiteralPath $stageDirectory -Destination $installDirectory
                Add-UserPathEntry -InstallDirectory $installDirectory
                $stageDirectory = $null
            }
            catch {
                if (Test-Path -LiteralPath $installDirectory) {
                    Move-Item -LiteralPath $installDirectory -Destination $stageDirectory
                }
                if ($backupDirectory -and (Test-Path -LiteralPath $backupDirectory)) {
                    Move-Item -LiteralPath $backupDirectory -Destination $installDirectory
                }
                [Environment]::SetEnvironmentVariable('Path', $originalUserPath, 'User')
                $env:Path = $originalProcessPath
                Notify-UserEnvironmentChanged
                throw
            }
            Write-Output "Nox AI $($newMarker.version) installed to $installDirectory"
            Write-Output "Conversation and settings data remain in $dataDirectory and are not removed during upgrades or uninstallation."
            Write-Output 'Open a new PowerShell window, then run: nox start'
            Write-Output 'No model runtime or model weights were downloaded by this installer.'
            if ($backupDirectory) {
                Write-Output "The previous application files were preserved at $backupDirectory."
            }
        }
    }
    finally {
        if ($stageDirectory -and (Test-Path -LiteralPath $stageDirectory)) {
            Remove-Item -LiteralPath $stageDirectory -Recurse -Force
        }
        if (Test-Path -LiteralPath $temporaryDirectory) {
            Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
        }
    }
}
catch {
    [Console]::Error.WriteLine("Nox AI installer: $($_.Exception.Message)")
    throw
}
