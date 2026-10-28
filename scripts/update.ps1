<#
.SYNOPSIS
  Updates WinAgent to a new version from a folder or .zip, with automatic rollback.

.DESCRIPTION
  1. Stops WinAgent.
  2. Snapshots the current release into backups\releases\<timestamp>: source code, both .env
     files and a full mysqldump of the database.
  3. Copies the new source over this folder. Installation state (node_modules, .venv, data,
     logs, backups, .env files, keys) is never overwritten or deleted.
  4. Installs dependencies, applies migrations, builds, starts and health-checks.
  If any step after the snapshot fails, scripts\rollback.ps1 restores the snapshot.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\update.ps1 -Source ..\winagent-1.1.0.zip
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Source,
  # Leave WinAgent stopped after a successful update.
  [switch]$NoStart
)

. "$PSScriptRoot\lib\common.ps1"

# ------------------------------------------------------------------ validate the new release
$Source = (Resolve-Path $Source).Path
$staging = $null
if ($Source -like '*.zip') {
  $staging = Join-Path ([IO.Path]::GetTempPath()) "winagent-update-$([guid]::NewGuid().ToString('N'))"
  Expand-Archive -LiteralPath $Source -DestinationPath $staging
  # Accept archives with or without a single top-level folder.
  $top = @(Get-ChildItem $staging)
  $Source = if ($top.Count -eq 1 -and $top[0].PSIsContainer) { $top[0].FullName } else { $staging }
}
$newManifest = Join-Path $Source 'package.json'
if (-not (Test-Path $newManifest) -or -not (Test-Path (Join-Path $Source 'server\prisma\schema.prisma'))) {
  throw "$Source does not look like a WinAgent source folder (package.json / server\prisma missing)."
}
$newPackage = Get-Content $newManifest -Raw | ConvertFrom-Json
if ($newPackage.name -ne 'winagent') { throw "$Source contains '$($newPackage.name)', not WinAgent." }
if ((Resolve-Path $Source).Path -eq $script:Root) { throw 'Source must be a different folder than this installation.' }

$fromVersion = Get-ProjectVersion
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$release = Join-Path $script:ReleasesDir $stamp
$manifestPath = Join-Path $release 'manifest.json'
function Save-Manifest([string]$Status, [string]$ErrorMessage = $null) {
  [pscustomobject]@{ stamp = $stamp; fromVersion = $fromVersion; toVersion = $newPackage.version; status = $Status; error = $ErrorMessage; at = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -Path $manifestPath -Encoding UTF8
}
Write-Step "Updating WinAgent $fromVersion -> $($newPackage.version)"

# ------------------------------------------------------------------ stop + snapshot
& "$PSScriptRoot\stop.ps1"

Write-Step "Snapshotting the current release to backups\releases\$stamp"
New-Item -ItemType Directory -Force -Path (Join-Path $release 'config') | Out-Null
Save-Manifest 'snapshotting'
Invoke-Robocopy -Source $script:Root -Destination (Join-Path $release 'code')
Copy-Item (Join-Path $script:Root 'server\.env') (Join-Path $release 'config\server.env')
$aiEnv = Join-Path $script:Root 'ai-service\.env'
if (Test-Path $aiEnv) { Copy-Item $aiEnv (Join-Path $release 'config\ai-service.env') }
$db = Get-DbInfo
Invoke-MySqlTool -Tool mysqldump -User $db.User -Password $db.Password -DbHost $db.Host -Port $db.Port `
  -Arguments @('--single-transaction', '--routines', '--no-tablespaces', "--result-file=$(Join-Path $release 'database.sql')", $db.Database)
Save-Manifest 'snapshot-complete'
Write-Ok 'Snapshot complete (code, configuration, database).'

# ------------------------------------------------------------------ apply
try {
  Write-Step 'Copying the new release'
  Invoke-Robocopy -Source $Source -Destination $script:Root -Mirror
  Save-Manifest 'files-copied'

  Write-Step 'Installing dependencies'
  $env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
  Invoke-Native -FilePath 'npm.cmd' -Arguments @('ci', '--no-audit', '--no-fund')
  Invoke-Native -FilePath $script:Python -Arguments @('-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', 'requirements-dev.txt')
  # New configuration keys get their defaults; existing values are preserved.
  Invoke-Native -FilePath 'node.exe' -Arguments @('scripts\setup-env.mjs')

  Write-Step 'Applying database migrations'
  Invoke-Native -FilePath 'npm.cmd' -Arguments @('run', 'db:migrate')

  Write-Step 'Building'
  Invoke-Native -FilePath 'npm.cmd' -Arguments @('run', 'build')

  if (-not $NoStart) {
    & "$PSScriptRoot\start.ps1"
  }
  Save-Manifest 'applied'
  Write-Step "Updated to WinAgent $($newPackage.version). Snapshot kept in backups\releases\$stamp (scripts\rollback.ps1 -Release $stamp)."
} catch {
  $message = $_.Exception.Message
  Write-Warn "Update failed: $message"
  Save-Manifest 'failed' $message
  Write-Step 'Rolling back automatically'
  & "$PSScriptRoot\rollback.ps1" -Release $stamp -Force -NoStart:$NoStart
  throw "Update to $($newPackage.version) failed and was rolled back to $fromVersion. Cause: $message"
} finally {
  if ($staging) { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
