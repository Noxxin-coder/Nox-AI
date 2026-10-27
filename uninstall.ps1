[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$WaitForProcessId
)

$ErrorActionPreference = 'Stop'

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

$installDirectory = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$markerPath = Join-Path $installDirectory 'nox-install.json'
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "Refusing to remove an unrecognized directory: '$installDirectory'."
}
$marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if ($marker.productId -ne 'nox-ai') {
    throw "Refusing to remove an unrecognized installation: '$installDirectory'."
}
$parent = Split-Path -Parent $installDirectory
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA is unavailable; refusing to remove this installation.'
}
$expectedInstallDirectory = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\Nox AI')).TrimEnd('\')
if (-not $installDirectory.Equals($expectedInstallDirectory, [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path -Leaf $parent) -ne 'Programs') {
    throw "Refusing to remove installation outside the expected per-user Programs directory: '$installDirectory'."
}

$launcher = Join-Path $installDirectory 'nox.cmd'
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
    & $launcher stop
    if ($LASTEXITCODE -ne 0) {
        throw "Nox AI could not stop its managed backend (exit code $LASTEXITCODE); installation was left in place."
    }
}

$nodeExecutable = Join-Path $installDirectory 'runtime\node.exe'
while ($true) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $WaitForProcessId" -ErrorAction Stop
    if (-not $process -or
        -not $process.ExecutablePath.Equals($nodeExecutable, [StringComparison]::OrdinalIgnoreCase) -or
        -not $process.CommandLine.Contains('cli.js')) {
        break
    }
    Start-Sleep -Milliseconds 250
}

for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try {
        Remove-Item -LiteralPath $installDirectory -Recurse -Force
        break
    }
    catch {
        if ($attempt -eq 9) {
            throw "Could not remove application files from '$installDirectory'. User data remains untouched. $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 1
    }
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not [string]::IsNullOrWhiteSpace($userPath)) {
    $remainingEntries = @()
    foreach ($entry in ($userPath -split ';')) {
        if ([string]::IsNullOrWhiteSpace($entry)) {
            continue
        }
        try {
            $normalized = [IO.Path]::GetFullPath($entry).TrimEnd('\')
            if (-not $normalized.Equals($installDirectory, [StringComparison]::OrdinalIgnoreCase)) {
                $remainingEntries += $entry
            }
        }
        catch {
            $remainingEntries += $entry
        }
    }
    [Environment]::SetEnvironmentVariable('Path', ($remainingEntries -join ';'), 'User')
    Notify-UserEnvironmentChanged
}
$dataDirectory = if (-not [string]::IsNullOrWhiteSpace($env:NOX_DATA_DIR)) { $env:NOX_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'Nox AI' }
Write-Output "Nox AI application files were removed. User data was preserved at '$dataDirectory'."
