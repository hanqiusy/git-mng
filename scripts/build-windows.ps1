[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $projectRoot '.tools'
$nodeRoot = Join-Path $toolRoot 'node'
$nodeExe = Join-Path $nodeRoot 'node.exe'
$nodeVersion = 'v24.18.0'
$nodeArchive = Join-Path $toolRoot "node-$nodeVersion-win-x64.zip"
$nodeExtracted = Join-Path $toolRoot "node-$nodeVersion-win-x64"
$npmCli = Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js'
$rustupExe = Join-Path $env:USERPROFILE '.cargo\bin\rustup.exe'
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$portableExe = Join-Path $projectRoot 'dist-portable\git-mng\git-mng.exe'
$outputDir = Join-Path $projectRoot 'dist-windows'
$outputExe = Join-Path $outputDir 'git-mng-windows-x64.exe'

function Install-PortableNode {
    if (Test-Path -LiteralPath $nodeExe -PathType Leaf) {
        return
    }

    New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
    $nodeUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
    Write-Host "Node.js was not found. Downloading $nodeVersion for this project..."
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeArchive
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $toolRoot -Force
    if (Test-Path -LiteralPath $nodeRoot) {
        Remove-Item -LiteralPath $nodeRoot -Recurse -Force
    }
    Move-Item -LiteralPath $nodeExtracted -Destination $nodeRoot
    Remove-Item -LiteralPath $nodeArchive -Force
}

function Install-Rust {
    if (Test-Path -LiteralPath $rustupExe -PathType Leaf) {
        return
    }

    $rustupInstaller = Join-Path $env:TEMP 'rustup-init.exe'
    Write-Host 'Rust was not found. Installing the stable MSVC toolchain for the current user...'
    Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile $rustupInstaller
    & $rustupInstaller -y --default-toolchain stable-msvc
    if ($LASTEXITCODE -ne 0) {
        throw "Rust installation failed with exit code $LASTEXITCODE."
    }
}

function Import-VisualCppEnvironment {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
        throw 'Visual Studio Build Tools with the C++ workload are required to build the Windows executable.'
    }

    $installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ([string]::IsNullOrWhiteSpace($installationPath)) {
        throw 'Visual Studio Build Tools with the C++ workload are required to build the Windows executable.'
    }

    $vcvars = Join-Path $installationPath 'VC\Auxiliary\Build\vcvars64.bat'
    if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) {
        throw "Visual C++ environment script was not found: $vcvars"
    }

    foreach ($line in (& cmd.exe /c "`"$vcvars`" >nul && set")) {
        if ($line -match '^([^=]+)=(.*)$') {
            Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
        }
    }
}

Install-PortableNode
Install-Rust
$env:Path = "$nodeRoot;$cargoBin;$env:Path"
Import-VisualCppEnvironment

Push-Location $projectRoot
try {
    & $nodeExe $npmCli ci
    if ($LASTEXITCODE -ne 0) {
        throw "Dependency installation failed with exit code $LASTEXITCODE."
    }

    & $nodeExe $npmCli run build:desktop
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop build failed with exit code $LASTEXITCODE."
    }

    if (-not (Test-Path -LiteralPath $portableExe -PathType Leaf)) {
        throw "Expected executable was not created: $portableExe"
    }

    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
    Copy-Item -LiteralPath $portableExe -Destination $outputExe -Force
    Write-Host "Windows executable created: $outputExe"

    $process = Start-Process -FilePath $outputExe -PassThru
    Start-Sleep -Seconds 5
    if ($process.HasExited) {
        throw "Executable smoke test failed: it exited with code $($process.ExitCode)."
    }
    Stop-Process -Id $process.Id -Force
    Write-Host 'Executable smoke test passed.'
}
finally {
    Pop-Location
}
