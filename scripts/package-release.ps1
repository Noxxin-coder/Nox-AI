[CmdletBinding()]
param(
    [string]$Version,
    [string]$OutputDirectory = 'artifacts'
)

$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'The Windows release package must be built on Windows.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = [string]$package.version
}
if ($Version -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') {
    throw "Invalid release version: '$Version'."
}
if ($Version -notmatch '^v') {
    $Version = "v$Version"
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodeExecutable = $nodeCommand.Source
$nodeVersion = (& $nodeExecutable -p 'process.version').Trim()
$nodeArchitecture = (& $nodeExecutable -p 'process.arch').Trim()
if ($nodeArchitecture -ne 'x64' -or $nodeVersion -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "A stable x64 Node.js runtime is required to build the Windows release (found $nodeVersion/$nodeArchitecture)."
}

$outputPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $OutputDirectory))
$archiveName = "nox-ai-$Version-win-x64.zip"
$archivePath = Join-Path $outputPath $archiveName
$checksumPath = Join-Path $outputPath 'SHA256SUMS.txt'
if ((Test-Path -LiteralPath $archivePath) -or (Test-Path -LiteralPath $checksumPath)) {
    throw "Release output already exists under '$outputPath'; choose another output directory rather than overwriting files."
}

$stagePath = Join-Path ([IO.Path]::GetTempPath()) ("nox-ai-package-" + [Guid]::NewGuid().ToString('N'))
$runtimePath = Join-Path ([IO.Path]::GetTempPath()) ("nox-ai-runtime-" + [Guid]::NewGuid().ToString('N'))
$runtimeArchiveName = "node-$nodeVersion-win-x64.zip"
$runtimeArchivePath = Join-Path $runtimePath $runtimeArchiveName
$runtimeChecksumsPath = Join-Path $runtimePath 'SHASUMS256.txt'
Push-Location $repositoryRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        throw "Build failed with exit code $LASTEXITCODE."
    }
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) {
        throw "Typecheck failed with exit code $LASTEXITCODE."
    }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) {
        throw "Tests failed with exit code $LASTEXITCODE."
    }

    $runtimeBaseUri = "https://nodejs.org/dist/$nodeVersion/"
    New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
    Invoke-WebRequest -Uri "${runtimeBaseUri}SHASUMS256.txt" -OutFile $runtimeChecksumsPath -TimeoutSec 60 -UseBasicParsing
    $runtimeChecksumLine = Get-Content -LiteralPath $runtimeChecksumsPath |
        Where-Object { $_ -match ('^\s*([A-Fa-f0-9]{64})\s+\*?' + [Regex]::Escape($runtimeArchiveName) + '\s*$') } |
        Select-Object -First 1
    if (-not $runtimeChecksumLine) {
        throw "The official Node.js SHA256 manifest does not contain '$runtimeArchiveName'."
    }
    $runtimeExpectedHash = [Regex]::Match($runtimeChecksumLine, '([A-Fa-f0-9]{64})').Groups[1].Value
    Invoke-WebRequest -Uri "${runtimeBaseUri}${runtimeArchiveName}" -OutFile $runtimeArchivePath -TimeoutSec 300 -UseBasicParsing
    $runtimeActualHash = (Get-FileHash -LiteralPath $runtimeArchivePath -Algorithm SHA256).Hash
    if (-not $runtimeActualHash.Equals($runtimeExpectedHash, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Official Node.js runtime checksum verification failed; no release package was created.'
    }
    Expand-Archive -LiteralPath $runtimeArchivePath -DestinationPath $runtimePath
    $runtimeRoot = Join-Path $runtimePath "node-$nodeVersion-win-x64"
    $bundledNodeExecutable = Join-Path $runtimeRoot 'node.exe'
    $nodeLicense = Join-Path $runtimeRoot 'LICENSE'
    if (-not (Test-Path -LiteralPath $bundledNodeExecutable -PathType Leaf) -or
        -not (Test-Path -LiteralPath $nodeLicense -PathType Leaf)) {
        throw 'The verified Node.js archive is missing its executable or license notice.'
    }

    $stageDist = Join-Path $stagePath 'dist\src'
    New-Item -ItemType Directory -Path (Join-Path $stageDist 'providers') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stageDist 'web') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stagePath 'runtime') -Force | Out-Null
    foreach ($file in @('cli.js', 'server.js', 'config.js', 'conversations.js', 'runtime.js')) {
        Copy-Item -LiteralPath (Join-Path $repositoryRoot "dist\src\$file") -Destination $stageDist
    }
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'dist\src\providers\openaiCompatible.js') -Destination (Join-Path $stageDist 'providers')
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'dist\src\web\index.html') -Destination (Join-Path $stageDist 'web')
    Copy-Item -LiteralPath $bundledNodeExecutable -Destination (Join-Path $stagePath 'runtime\node.exe')
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $stagePath 'NODE-LICENSE')
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'nox.cmd') -Destination $stagePath
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'uninstall.ps1') -Destination $stagePath
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'README.md') -Destination $stagePath
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'LICENSE') -Destination $stagePath

    $metadata = [ordered]@{
        productId = 'nox-ai'
        version = $Version.TrimStart('v')
        nodeVersion = $nodeVersion
        architecture = 'win-x64'
    }
    $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stagePath 'nox-install.json') -Encoding UTF8

    New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $stagePath,
        $archivePath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $archiveName" | Set-Content -LiteralPath $checksumPath -Encoding ASCII
    Write-Output "Created $archivePath"
    Write-Output "SHA-256: $hash"
    Write-Output "Node.js runtime bundled: $($metadata.nodeVersion)"
}
finally {
    if (Test-Path -LiteralPath $stagePath) {
        Remove-Item -LiteralPath $stagePath -Recurse -Force
    }
    if (Test-Path -LiteralPath $runtimePath) {
        Remove-Item -LiteralPath $runtimePath -Recurse -Force
    }
    Pop-Location
}
