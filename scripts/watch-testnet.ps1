# Runs one Tripwire watcher execution against the live Monad testnet deployment (CRE simulator, --broadcast)
# and appends the result to .watcher/watcher.log. Registered as the "Tripwire Watcher" scheduled task during
# hackathon judging; it stops doing anything after 2026-10-28.
# Needs: CRE CLI logged in (cre login), Bun, and workflow/.env.testnet (testnet-only key, git-ignored).
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root '.watcher'
$Log = Join-Path $LogDir 'watcher.log'
New-Item -ItemType Directory -Force $LogDir | Out-Null

function Write-Log([string]$Line) { Add-Content -Path $Log -Value ("{0:u} {1}" -f (Get-Date).ToUniversalTime(), $Line) -Encoding utf8 }

if ((Get-Date) -gt [datetime]'2026-10-28') { Write-Log 'judging period over; nothing to do'; exit 0 }

$env:Path = @(
  "$env:LOCALAPPDATA\Programs\cre",
  "$env:USERPROFILE\.bun\bin",
  "$env:USERPROFILE\.foundry\bin",
  $env:Path
) -join ';'

$Workflow = Join-Path $Root 'workflow'
Copy-Item (Join-Path $Workflow '.env.testnet') (Join-Path $Workflow '.env') -Force
Push-Location $Workflow
try {
  $out = & cre workflow simulate tripwire --target testnet-settings --non-interactive --trigger-index 0 --broadcast 2>&1 | Out-String
  $clean = $out -replace "`e\[[0-9;]*m", ''
  $lines = $clean -split "`r?`n" | Where-Object { $_ -match '\[USER LOG\]|^"tWETH|not logged in|failed|Error' -and $_ -notmatch 'NativeCommandError|FullyQualifiedErrorId|CategoryInfo|At line|^\s*\+' }
  if (-not $lines) { $lines = @('no workflow output (see full run below)', $clean.Trim()) }
  foreach ($l in $lines) { Write-Log $l.Trim() }
} finally {
  Pop-Location
}
