<#
.SYNOPSIS
  Tests install, start, stop, update, rollback and automatic rollback in an isolated sandbox.

.DESCRIPTION
  Copies this source tree to %TEMP%\winagent-lifecycle-<stamp>, gives it its own database
  (winagent_lifecycle) and ports (3720 / 8720), then:
    install -> start/health -> stop -> update to 1.0.1 -> rollback (marker table must vanish)
    -> update to a deliberately broken 1.0.2 (must fail and roll back automatically).
  The sandbox folder and database are removed afterwards. Your real installation and data are
  not touched. Needs the MySQL credentials in server\.env and ~4 GB of free memory.
#>
[CmdletBinding()]
param([switch]$KeepSandbox)

. "$PSScriptRoot\lib\common.ps1"

$source = $script:Root
$base = Join-Path $env:TEMP "winagent-lifecycle-$((Get-Date).ToString('yyyyMMddHHmmss'))"
$sandbox = Join-Path $base 'install'
$good = Join-Path $base 'release-1.0.1'
$broken = Join-Path $base 'release-1.0.2-broken'
$dbName = 'winagent_lifecycle'
$results = New-Object System.Collections.Generic.List[string]

function Check([string]$Name, [bool]$Pass, [string]$Detail = '') {
  $line = '{0} {1} {2}' -f $(if ($Pass) { 'PASS' } else { 'FAIL' }), $Name, $Detail
  $results.Add($line)
  if ($Pass) { Write-Ok $line } else { Write-Warn $line; throw "Check failed: $Name" }
}
function Run([string]$Script, [string[]]$Arguments = @()) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $sandbox "scripts\$Script") @Arguments | Out-Host
  $LASTEXITCODE
}
function Version { (Get-Content (Join-Path $sandbox 'package.json') -Raw | ConvertFrom-Json).version }
function Http([string]$Url) { try { (Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 10).StatusCode } catch { 0 } }
function SandboxSql([string]$Sql) {
  $db = Get-DbInfo
  $env:MYSQL_PWD = $db.Password
  try { $Sql | & (Join-Path (Get-MySqlBin) 'mysql.exe') -h $db.Host -P $db.Port -u $db.User -N $dbName 2>$null } finally { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }
}
function New-Release([string]$Path, [string]$Version) {
  Invoke-Robocopy -Source $source -Destination $Path
  $pkg = Join-Path $Path 'package.json'
  (Get-Content $pkg -Raw) -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`"" | Set-Content $pkg -Encoding UTF8 -NoNewline
  Set-Content (Join-Path $Path 'RELEASE_MARKER.txt') "release $Version" -Encoding UTF8
}

$db = Get-DbInfo
try {
  Write-Step "Creating sandbox in $base"
  Invoke-Robocopy -Source $source -Destination $sandbox
  $envText = (Get-Content (Join-Path $source 'server\.env') -Raw)
  $envText = $envText -replace "(?m)^(DATABASE_URL=mysql://[^\r\n]*?/)[A-Za-z0-9_]+", "`${1}$dbName" -replace '(?m)^PORT=.*$', 'PORT=3720' -replace '(?m)^AI_SERVICE_URL=.*$', 'AI_SERVICE_URL=http://127.0.0.1:8720' -replace '(?m)^(STORAGE_DIR|BACKUP_DIR|HOST|TLS_[A-Z_]+|PUBLIC_ORIGIN)=.*$', ''
  Set-Content (Join-Path $sandbox 'server\.env') $envText -Encoding UTF8 -NoNewline
  $aiText = (Get-Content (Join-Path $source 'ai-service\.env') -Raw) -replace '(?m)^AI_PORT=.*$', 'AI_PORT=8720' -replace '(?m)^SECRET_STORE_PATH=.*$', ''
  Set-Content (Join-Path $sandbox 'ai-service\.env') $aiText -Encoding UTF8 -NoNewline
  Invoke-MySqlTool -Tool mysql -User $db.User -Password $db.Password -DbHost $db.Host -Port $db.Port -InputSql "DROP DATABASE IF EXISTS $dbName; CREATE DATABASE $dbName CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  New-Release $good '1.0.1'
  New-Release $broken '1.0.2'
  Add-Content (Join-Path $broken 'server\src\main.ts') "`nconst brokenOnPurpose: number = 'not a number';`n"

  Check 'install' ((Run 'install.ps1') -eq 0)
  Check 'start' ((Run 'start.ps1') -eq 0)
  Check 'server health' ((Http 'http://127.0.0.1:3720/api/health') -eq 200)
  Check 'dashboard served' ((Http 'http://127.0.0.1:3720/') -eq 200)
  Check 'ai health' ((Http 'http://127.0.0.1:8720/health') -eq 200)
  Check 'stop' ((Run 'stop.ps1') -eq 0)
  Check 'stopped' ((Http 'http://127.0.0.1:3720/api/health') -eq 0)

  Check 'update to 1.0.1' ((Run 'update.ps1' @('-Source', $good)) -eq 0)
  Check 'version is 1.0.1' ((Version) -eq '1.0.1') (Version)
  Check 'new file present' (Test-Path (Join-Path $sandbox 'RELEASE_MARKER.txt'))
  Check 'source folder server\src\backups kept' (Test-Path (Join-Path $sandbox 'server\src\backups\backups.service.ts'))
  Check 'healthy after update' ((Http 'http://127.0.0.1:3720/api/health') -eq 200)
  Check 'configuration preserved' ([bool](Select-String -Path (Join-Path $sandbox 'server\.env') -Pattern '^PORT=3720' -Quiet))
  SandboxSql 'CREATE TABLE rollback_marker (id INT);' | Out-Null
  Check 'marker table created' (@(SandboxSql "SHOW TABLES LIKE 'rollback_marker';").Count -eq 1)

  Check 'rollback' ((Run 'rollback.ps1' @('-Force')) -eq 0)
  Check 'version is 1.0.0 again' ((Version) -ne '1.0.1') (Version)
  Check 'new file removed' (-not (Test-Path (Join-Path $sandbox 'RELEASE_MARKER.txt')))
  Check 'marker table gone (database restored)' (@(SandboxSql "SHOW TABLES LIKE 'rollback_marker';").Count -eq 0)
  Check 'migrations restored' ([int](SandboxSql 'SELECT COUNT(*) FROM _prisma_migrations;') -ge 1)
  Check 'healthy after rollback' ((Http 'http://127.0.0.1:3720/api/health') -eq 200)

  $code = Run 'update.ps1' @('-Source', $broken)
  Check 'broken update reports failure' ($code -ne 0) "exit=$code"
  Check 'still on the previous version' ((Version) -ne '1.0.2') (Version)
  Check 'healthy after automatic rollback' ((Http 'http://127.0.0.1:3720/api/health') -eq 200)
  $latest = Get-ChildItem (Join-Path $sandbox 'backups\releases') -Directory | Sort-Object Name -Descending | Select-Object -First 1
  $status = (Get-Content (Join-Path $latest.FullName 'manifest.json') -Raw | ConvertFrom-Json).status
  Check 'snapshot marked rolled-back' ($status -eq 'rolled-back') $status
} finally {
  if (Test-Path (Join-Path $sandbox 'scripts\stop.ps1')) { Run 'stop.ps1' | Out-Null }
  if (-not $KeepSandbox) {
    Invoke-MySqlTool -Tool mysql -User $db.User -Password $db.Password -DbHost $db.Host -Port $db.Port -InputSql "DROP DATABASE IF EXISTS $dbName;" -ErrorAction SilentlyContinue
    Remove-Item $base -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Step 'Lifecycle summary'
  $results | ForEach-Object { Write-Host "    $_" }
}
if ($results | Where-Object { $_ -like 'FAIL*' }) { exit 1 }
