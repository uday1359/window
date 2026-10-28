<#
.SYNOPSIS
  Stops the WinAgent processes started by scripts\start.ps1.

.DESCRIPTION
  The agent is stopped first so it cannot pick up new work, then the server and AI service.
  Tasks that were running become INTERRUPTED and are never resumed automatically.
#>
[CmdletBinding()]
param()

. "$PSScriptRoot\lib\common.ps1"

$state = @(Get-RunState)
if (-not $state.Count) { Write-Ok 'WinAgent is not running (no data\run.json).'; return }

$order = @('agent', 'server', 'ai-service')
foreach ($entry in ($state | Sort-Object { [array]::IndexOf($order, $_.name) })) {
  if (Test-ProcessAlive $entry.pid) {
    Stop-Process -Id $entry.pid -Force
    Wait-Process -Id $entry.pid -Timeout 15 -ErrorAction SilentlyContinue
    Write-Ok "$($entry.name) stopped (pid $($entry.pid))"
  } else {
    Write-Ok "$($entry.name) was not running"
  }
}
Remove-Item $script:RunFile -Force
