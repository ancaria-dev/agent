<#
.SYNOPSIS
    Packs the agent and puts it into the game folder.

.DESCRIPTION
    Reads the game path from .local.settings, which is not committed:

        sacred=D:\SteamLibrary\steamapps\common\Sacred Gold

    Regenerates src/gen/addr.js, packs dist/agent/, and replaces
    <game>/launcher/agent/ with it. The new folder is written beside the old
    one as agent.new and swapped in, so a failed copy leaves the old agent.
    Restart the game afterwards: a running game keeps the agent it was given.

.EXAMPLE
    pwsh tools/install.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$settings = Join-Path $root '.local.settings'

if (-not (Test-Path $settings)) {
    throw "No .local.settings file found. Create it with a line like:`n" +
          "    sacred=D:\SteamLibrary\steamapps\common\Sacred Gold"
}
$sacred = (Get-Content $settings |
    Where-Object { $_ -match '^\s*sacred\s*=' } |
    Select-Object -First 1) -replace '^\s*sacred\s*=\s*', ''
if (-not $sacred) { throw "No `sacred=` line found in .local.settings" }
$sacred = $sacred.Trim().Trim('"')
# The same names tools/game.py looks for, in the same order.
$executables = 'pureHD.exe', 'Sacred.exe', 'Game.exe'
$game = $executables | Where-Object { Test-Path (Join-Path $sacred $_) } | Select-Object -First 1
if (-not $game) {
    throw "No game found in $sacred. Checked for $($executables -join ', '). Is this the game folder?"
}

Push-Location $root
try {
    python tools/addr.py
    if ($LASTEXITCODE -ne 0) { throw 'tools/addr.py failed' }
    node tools/pack.mjs
    if ($LASTEXITCODE -ne 0) { throw 'tools/pack.mjs failed' }
} finally {
    Pop-Location
}

$launcher = Join-Path $sacred 'launcher'
$target = Join-Path $launcher 'agent'
$staged = Join-Path $launcher 'agent.new'
$old = Join-Path $launcher 'agent.old'

New-Item -ItemType Directory -Force $launcher | Out-Null
foreach ($path in $staged, $old) {
    if (Test-Path $path) { Remove-Item -Recurse -Force $path }
}
Copy-Item (Join-Path $root 'dist/agent') $staged -Recurse
if (Test-Path $target) { Move-Item $target $old }
Move-Item $staged $target
if (Test-Path $old) { Remove-Item -Recurse -Force $old }

Write-Host "Installed the agent in $target"
