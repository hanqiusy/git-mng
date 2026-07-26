[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$portableExe = Join-Path $projectRoot 'dist-portable\git-mng\git-mng.exe'
$outputDir = Join-Path $projectRoot 'dist-windows'
$outputExe = Join-Path $outputDir 'git-mng-windows-x64.exe'

Push-Location $projectRoot
try {
    & npm.cmd run build:desktop
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop build failed with exit code $LASTEXITCODE."
    }

    if (-not (Test-Path -LiteralPath $portableExe -PathType Leaf)) {
        throw "Expected executable was not created: $portableExe"
    }

    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
    Copy-Item -LiteralPath $portableExe -Destination $outputExe -Force
    Write-Host "Windows executable created: $outputExe"
}
finally {
    Pop-Location
}
