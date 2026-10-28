<#
.SYNOPSIS
  Restores a release snapshot made by scripts\update.ps1 (code, configuration, database).

.DESCRIPTION
  The database is dropped and recreated from the snapshot's dump, so anything recorded after
  the snapshot (tasks, audit events, settings) is lost. You are asked to confirm unless -Force.
  Without -Release, the newest snapshot is used.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\rollback.ps1
  powershell -ExecutionPolicy Bypass -File scripts\rollback.ps1 -Release 20261028-101500 -SkipDatabase
#>
[CmdletBinding()]
param(
  [string]$Release,
  # Restore code and configuration only; keep the current database.
  [switch]$SkipDatabase,
  # Do not ask for confirmation (used by update.ps1 after a failed update).
  [switch]$Force,
  [switch]$NoStart
)

. "$PSScriptRoot\lib\common.ps1"

if (-not (Test-Path $script:ReleasesDir)) { throw 'No release snapshots exist (backups\releases is empty).' }
if (-not $Release) {
  $latest = Get-ChildItem $script:ReleasesDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $latest) { throw 'No release snapshots exist.' }
  $Release = $latest.Name
}
if ($Release -notmatch '^\d{8}-\d{6}$') { throw "Invalid release name '$Release' (expected yyyyMMdd-HHmmss)." }
$snapshot = Join-Path $script:ReleasesDir $Release
$code = Join-Path $snapshot 'code'
$dump = Join-Path $snapshot 'database.sql'
if (-not (Test-Path (Join-Path $code 'package.json'))) { throw "Snapshot $Release has no code; it cannot be restored." }
if (-not $SkipDatabase -and -not (Test-Path $dump)) { throw "Snapshot $Release has no database dump. Use -SkipDatabase to restore code only." }

$manifest = Get-Content (Join-Path $snapshot 'manifest.json') -Raw | ConvertFrom-Json
Write-Step "Rolling back to WinAgent $($manifest.fromVersion) (snapshot $Release)"
if (-not $Force) {
  $what = if ($SkipDatabase) { 'code and configuration' } else { 'code, configuration AND the database (data recorded after the snapshot will be lost)' }
  $answer = Read-Host "This restores $what. Type YES to continue"
  if ($answer -cne 'YES') { Write-Warn 'Rollback cancelled.'; return }
}

& "$PSScriptRoot\stop.ps1"

Write-Step 'Restoring code and configuration'
Invoke-Robocopy -Source $code -Destination $script:Root -Mirror
Copy-Item (Join-Path $snapshot 'config\server.env') (Join-Path $script:Root 'server\.env') -Force
$aiEnv = Join-Path $snapshot 'config\ai-service.env'
if (Test-Path $aiEnv) { Copy-Item $aiEnv (Join-Path $script:Root 'ai-service\.env') -Force }

Write-Step 'Reinstalling dependencies for the restored version'
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
Invoke-Native -FilePath 'npm.cmd' -Arguments @('ci', '--no-audit', '--no-fund')
Invoke-Native -FilePath $script:Python -Arguments @('-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', 'requirements-dev.txt')

if (-not $SkipDatabase) {
  Write-Step 'Restoring the database from the snapshot'
  # Recreate rather than overwrite: tables added by the failed version must not survive.
  $db = Get-DbInfo
  if ($db.Database -notmatch '^winagent[a-z0-9_]*$') { throw "Refusing to recreate unexpected database '$($db.Database)'." }
  Invoke-MySqlTool -Tool mysql -User $db.User -Password $db.Password -DbHost $db.Host -Port $db.Port `
    -InputSql "DROP DATABASE IF EXISTS ``$($db.Database)``; CREATE DATABASE ``$($db.Database)`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  Invoke-MySqlTool -Tool mysql -User $db.User -Password $db.Password -DbHost $db.Host -Port $db.Port -Arguments @($db.Database) -InputFile $dump
}

Write-Step 'Building the restored version'
Invoke-Native -FilePath 'npm.cmd' -Arguments @('run', 'build')

if (-not $NoStart) { & "$PSScriptRoot\start.ps1" }

$manifest.status = 'rolled-back'
$manifest | Add-Member -NotePropertyName rolledBackAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o') -Force
$manifest | ConvertTo-Json | Set-Content -Path (Join-Path $snapshot 'manifest.json') -Encoding UTF8
Write-Step "Rolled back to WinAgent $($manifest.fromVersion)."
