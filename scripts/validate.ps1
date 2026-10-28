<#
.SYNOPSIS
  Runs every check and test suite and writes one report to send back for review.

.DESCRIPTION
  Static checks (lint, typecheck, Prisma schema, Python lint, PowerShell syntax), builds,
  server unit + integration tests, dashboard tests, AI service tests, agent tests, the real
  end-to-end tests and a dependency audit. Every step runs even if an earlier one fails.

  Output: logs\validation-<timestamp>\report.md plus one log file per step.
  Needs: scripts\install.ps1 completed, MySQL running, Microsoft Edge, a desktop session
  (agent UI Automation tests need one; run from Remote Desktop, not plain SSH).
  WinAgent itself does not need to be running; tests start what they need on other ports.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\validate.ps1
  powershell -ExecutionPolicy Bypass -File scripts\validate.ps1 -SkipE2E -IncludeLifecycle
#>
[CmdletBinding()]
param(
  [switch]$SkipE2E,
  # Also run scripts\test-lifecycle.ps1 (install/update/rollback in a sandbox; slow, needs ~4 GB free RAM).
  [switch]$IncludeLifecycle
)

. "$PSScriptRoot\lib\common.ps1"

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$outDir = Join-Path $script:LogDir "validation-$stamp"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$results = New-Object System.Collections.Generic.List[object]

# Summary lines worth showing from each tool's output.
$SummaryPattern = '^\s*(Tests:|Test Suites:|Test Files|Tests\s+\d)|\d+ passed|\d+ failed|\d+ skipped|All checks passed|Found \d+ error|problems? \(|error TS\d+|vulnerabilities|is valid|built in|SyntaxError'

function Invoke-Check([string]$Name, [string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $script:Root) {
  Write-Step $Name
  $log = Join-Path $outDir (($Name -replace '[^A-Za-z0-9]+', '-').Trim('-') + '.log')
  $started = Get-Date
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments *> $log
    $code = $LASTEXITCODE
  } catch {
    $_ | Out-File -Append $log
    $code = 1
  } finally {
    Pop-Location
    $ErrorActionPreference = $previous
  }
  $summary = @(Select-String -Path $log -Pattern $SummaryPattern -ErrorAction SilentlyContinue | Select-Object -Last 4 | ForEach-Object { ($_.Line -replace '\x1b\[[0-9;]*m', '').Trim() }) -join ' | '
  $status = if ($code -eq 0) { 'PASS' } else { 'FAIL' }
  if ($status -eq 'PASS') { Write-Ok "$status  $summary" } else { Write-Warn "$status (exit $code)  $summary  -> $log" }
  $results.Add([pscustomobject]@{ Step = $Name; Status = $status; Exit = $code; Seconds = [int]((Get-Date) - $started).TotalSeconds; Summary = $summary; Log = Split-Path $log -Leaf })
}

$py = $script:Python
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'

Invoke-Check 'Environment' 'powershell.exe' @('-NoProfile', '-Command', "node --version; npm --version; & '$py' --version; (Get-CimInstance Win32_OperatingSystem).Caption; Get-Service MySQL* | Format-Table -AutoSize Name,Status | Out-String")
Invoke-Check 'PowerShell syntax' 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'lib\check-ps-syntax.ps1'))
Invoke-Check 'Lint (server, web)' 'npm.cmd' @('run', 'lint')
Invoke-Check 'Typecheck (server, web)' 'npm.cmd' @('run', 'typecheck')
Invoke-Check 'Typecheck (electron)' 'npx.cmd' @('tsc', '--noEmit', '-p', 'electron\tsconfig.json')
Invoke-Check 'Python lint (ruff)' $py @('-m', 'ruff', 'check', 'ai-service', 'agent')
Invoke-Check 'Prisma schema' 'npm.cmd' @('run', 'prisma:validate', '--workspace', 'server')
Invoke-Check 'Database migrations' 'npm.cmd' @('run', 'db:migrate')
Invoke-Check 'Build (server, web)' 'npm.cmd' @('run', 'build')
Invoke-Check 'Server tests (unit + integration)' 'npm.cmd' @('run', 'test', '--workspace', 'server')
Invoke-Check 'Dashboard tests' 'npm.cmd' @('run', 'test', '--workspace', 'web')
Invoke-Check 'AI service tests' $py @('-m', 'pytest', '-q') (Join-Path $script:Root 'ai-service')
Invoke-Check 'Agent tests (real files, Edge, UI Automation, OCR)' $py @('-m', 'pytest', '-q', '-rs') (Join-Path $script:Root 'agent')
if (-not $SkipE2E) { Invoke-Check 'End-to-end tests (real agent)' 'npm.cmd' @('run', 'test:e2e') }
if ($IncludeLifecycle) { Invoke-Check 'Install/update/rollback lifecycle' 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-lifecycle.ps1')) }
Invoke-Check 'Dependency audit (production)' 'npm.cmd' @('audit', '--omit=dev')

$failed = @($results | Where-Object Status -eq 'FAIL')
$report = Join-Path $outDir 'report.md'
$lines = @(
  "# WinAgent validation report",
  "",
  "- Run: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')) on $env:COMPUTERNAME",
  "- Version: $(Get-ProjectVersion)",
  "- Result: **$(if ($failed.Count) { "$($failed.Count) step(s) FAILED" } else { 'all steps passed' })**",
  "",
  "| Step | Result | Exit | Seconds | Summary | Log |",
  "|---|---|---|---|---|---|"
) + ($results | ForEach-Object { "| $($_.Step) | $($_.Status) | $($_.Exit) | $($_.Seconds) | $($_.Summary -replace '\|', '/') | $($_.Log) |" })
Set-Content -Path $report -Value $lines -Encoding UTF8

Write-Step "Report: $report"
if ($failed.Count) {
  Write-Warn "Send report.md and the failed step logs: $(($failed | ForEach-Object Log) -join ', ')"
  exit 1
}
