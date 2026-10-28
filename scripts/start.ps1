<#
.SYNOPSIS
  Starts the WinAgent AI service and server (and optionally the agent) in the background.

.DESCRIPTION
  Uses the built server (server\dist) which also serves the dashboard. Output goes to
  logs\<component>.log; process IDs are kept in data\run.json for scripts\stop.ps1.
  Never starts tasks: anything that was running before is INTERRUPTED until resumed.
  Run -Agent as the normal Windows user the agent should act for (it refuses to run elevated).
#>
[CmdletBinding()]
param(
  # Also start the paired local agent.
  [switch]$Agent,
  # Run the automation browser without a window.
  [switch]$Headless,
  [int]$TimeoutSeconds = 90
)

. "$PSScriptRoot\lib\common.ps1"

$running = @(Get-RunState | Where-Object { Test-ProcessAlive $_.pid })
if ($running.Count) {
  throw "WinAgent is already running ($($running.name -join ', ')). Use scripts\stop.ps1 first."
}
foreach ($required in @('server\dist\main.js', 'web\dist\index.html', '.venv\Scripts\python.exe', 'server\.env')) {
  if (-not (Test-Path (Join-Path $script:Root $required))) { throw "$required is missing. Run scripts\install.ps1 first." }
}
New-Item -ItemType Directory -Force -Path $script:LogDir, $script:DataDir | Out-Null
$ports = Get-Ports

function Start-Component([string]$Name, [string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
  $log = Join-Path $script:LogDir "$Name.log"
  $err = Join-Path $script:LogDir "$Name.err.log"
  $proc = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $log -RedirectStandardError $err -WindowStyle Hidden -PassThru
  Write-Ok "$Name started (pid $($proc.Id), log logs\$Name.log)"
  [pscustomobject]@{ name = $Name; pid = $proc.Id; startedAt = (Get-Date).ToUniversalTime().ToString('o') }
}

$state = @()
try {
  Write-Step 'Starting AI service'
  $state += Start-Component 'ai-service' $script:Python @('-m', 'app.main') (Join-Path $script:Root 'ai-service')
  if (-not (Wait-Http "http://127.0.0.1:$($ports.Ai)/health" $TimeoutSeconds)) { throw "AI service did not become healthy; see logs\ai-service.err.log" }

  Write-Step 'Starting server'
  $state += Start-Component 'server' 'node.exe' @('dist\main.js') (Join-Path $script:Root 'server')
  if (-not (Wait-Http "$(Get-ServerBaseUrl)/api/health" $TimeoutSeconds)) { throw "Server did not become healthy; see logs\server.err.log" }

  if ($Agent) {
    Write-Step 'Starting agent'
    Push-Location (Join-Path $script:Root 'agent')
    try { $status = & $script:Python -m winagent status 2>$null | Out-String | ConvertFrom-Json } finally { Pop-Location }
    if (-not $status.paired) { throw 'The agent is not paired. Create a pairing code in the dashboard, then run: .venv\Scripts\python -m winagent pair --code <CODE> (in the agent folder).' }
    $agentArgs = @('-m', 'winagent', 'run')
    if ($Headless) { $agentArgs += '--headless' }
    $state += Start-Component 'agent' $script:Python $agentArgs (Join-Path $script:Root 'agent')
    Start-Sleep -Seconds 3
    if (-not (Test-ProcessAlive $state[-1].pid)) { throw 'The agent exited immediately; see logs\agent.err.log (is this an elevated terminal?)' }
  }
} catch {
  # Never leave half a stack running.
  foreach ($s in $state) { Stop-Process -Id $s.pid -Force -ErrorAction SilentlyContinue }
  throw
} finally {
  if ($state.Count) { ConvertTo-Json @($state) | Set-Content -Path $script:RunFile -Encoding UTF8 }
}

$public = (Get-ServerEnv)["PUBLIC_ORIGIN"]
Write-Step "WinAgent is running: $(if ($public) { $public } else { Get-ServerBaseUrl })"
