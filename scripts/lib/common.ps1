# Shared helpers for the WinAgent install / start / stop / update / rollback scripts.
# Windows PowerShell 5.1 compatible. Dot-source it: . "$PSScriptRoot\lib\common.ps1"
# Secrets (database passwords) are never written to the console, logs or command lines:
# mysql.exe receives the password through the MYSQL_PWD environment variable only.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:Python = Join-Path $script:Root '.venv\Scripts\python.exe'
$script:DataDir = Join-Path $script:Root 'data'
$script:LogDir = Join-Path $script:Root 'logs'
$script:RunFile = Join-Path $script:DataDir 'run.json'
$script:ReleasesDir = Join-Path $script:Root 'backups\releases'

# Folders and files that belong to this installation (state, secrets, dependencies, build
# output) rather than to the source tree. Updates and rollbacks never copy, overwrite or
# delete them.
# Installation state lives at the project root only. These are excluded by full path, because
# robocopy matches bare names at any depth and server\src\backups is source code.
$script:PreservedRootDirs = @('backups', 'logs', 'data', 'storage')
# Never source code wherever they appear, so they are excluded by name.
$script:PreservedDirs = @('node_modules', '.venv', '.git', 'dist', 'generated', 'test-results', 'playwright-report', '.run', '__pycache__', '.pytest_cache', '.ruff_cache')
$script:PreservedFiles = @('.env', '.env.dbcreds', 'credentials.env', '*.pem', '*.key', '*.rdp')

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

# Runs a native program and throws when it fails. stderr is shown but does not count as
# failure: Windows PowerShell 5.1 would otherwise turn every stderr line into an error.
function Invoke-Native {
  param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @(), [string]$WorkingDirectory = $script:Root)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" }
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $previous
  }
  if ($code -ne 0) { throw "$([IO.Path]::GetFileName($FilePath)) $($Arguments -join ' ') failed with exit code $code" }
}

# robocopy uses exit codes 0-7 for success and 8+ for failure.
function Invoke-Robocopy {
  param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Destination, [switch]$Mirror)
  $mode = if ($Mirror) { '/MIR' } else { '/E' }
  # Root state folders are listed for both sides: /MIR must neither copy from nor purge them.
  $rootDirs = foreach ($d in $script:PreservedRootDirs) { Join-Path $Source $d; Join-Path $Destination $d }
  $robocopyArgs = @($Source, $Destination, $mode, '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD') + $script:PreservedDirs + @($rootDirs) + @('/XF') + $script:PreservedFiles
  & robocopy.exe @robocopyArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $Source -> $Destination failed with exit code $LASTEXITCODE" }
}

function Read-EnvFile([string]$Path) {
  $values = @{}
  if (-not (Test-Path $Path)) { return $values }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') { $values[$Matches[1]] = $Matches[2] }
  }
  return $values
}

function Get-ServerEnv { Read-EnvFile (Join-Path $script:Root 'server\.env') }

# credentials.env (see credentials.env.example and README "Credentials"). WINAGENT_CREDENTIALS_FILE
# overrides the location (setup-windows.cmd points it at the folder the .cmd was started from).
function Get-CredentialsPath {
  if ($env:WINAGENT_CREDENTIALS_FILE) { return $env:WINAGENT_CREDENTIALS_FILE }
  return (Join-Path $script:Root 'credentials.env')
}

# A credential from the environment or credentials.env; stops with instructions when it is missing.
function Get-RequiredCredential([string]$Name, [string]$Purpose) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if (-not $value) { $value = (Read-EnvFile (Get-CredentialsPath))[$Name] }
  if (-not $value) {
    throw "$Name is missing. $Purpose Copy credentials.env.example to credentials.env in the project folder, set $Name=..., then run this again (README: Credentials)."
  }
  return $value
}

function Get-Ports {
  $server = Get-ServerEnv
  $ai = Read-EnvFile (Join-Path $script:Root 'ai-service\.env')
  [pscustomobject]@{
    Server = if ($server.ContainsKey('PORT')) { [int]$server['PORT'] } else { 3710 }
    Ai = if ($ai.ContainsKey('AI_PORT')) { [int]$ai['AI_PORT'] } else { 8710 }
  }
}

# Connection details from server/.env DATABASE_URL (never printed).
function Get-DbInfo {
  $url = (Get-ServerEnv)['DATABASE_URL']
  if (-not $url) { throw 'server\.env has no DATABASE_URL. Run scripts\install.ps1 first.' }
  $uri = [Uri]$url
  $user, $password = $uri.UserInfo.Split(':', 2)
  [pscustomobject]@{
    Host = $uri.Host
    Port = if ($uri.Port -gt 0) { $uri.Port } else { 3306 }
    User = [Uri]::UnescapeDataString($user)
    Password = [Uri]::UnescapeDataString($password)
    Database = $uri.AbsolutePath.Trim('/')
  }
}

function Get-MySqlBin {
  $dir = (Get-ServerEnv)['MYSQL_BIN_DIR']
  if ($dir -and (Test-Path (Join-Path $dir 'mysql.exe'))) { return $dir }
  # The newest installed MySQL Server (8.0, 8.4 LTS, 9.x) under this machine's Program Files folder.
  $installed = Get-ChildItem (Join-Path $env:ProgramFiles 'MySQL') -Directory -Filter 'MySQL Server *' -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'bin\mysql.exe') } |
    Sort-Object { [version]($_.Name -replace '^MySQL Server ', '') } -Descending |
    Select-Object -First 1
  if ($installed) { return (Join-Path $installed.FullName 'bin') }
  $cmd = Get-Command mysql.exe -ErrorAction SilentlyContinue
  if ($cmd) { return Split-Path $cmd.Source }
  throw "mysql.exe not found. Install the MySQL 8 client tools or set MYSQL_BIN_DIR in server\.env."
}

# Runs mysql.exe or mysqldump.exe with the password passed only through MYSQL_PWD.
# SQL is sent on stdin so it never appears in the process list.
function Invoke-MySqlTool {
  param(
    [Parameter(Mandatory)][ValidateSet('mysql', 'mysqldump')][string]$Tool,
    [Parameter(Mandatory)][string]$User,
    [Parameter(Mandatory)][string]$Password,
    [string]$DbHost = '127.0.0.1',
    [int]$Port = 3306,
    [string[]]$Arguments = @(),
    [string]$InputSql,
    [string]$InputFile
  )
  $exe = Join-Path (Get-MySqlBin) "$Tool.exe"
  $baseArgs = @('-h', $DbHost, '-P', "$Port", '-u', $User, '--default-character-set=utf8mb4') + $Arguments
  $previousPwd = $env:MYSQL_PWD
  $previousPref = $ErrorActionPreference
  $env:MYSQL_PWD = $Password
  $ErrorActionPreference = 'Continue'
  try {
    if ($InputFile) {
      Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | & $exe @baseArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
    } elseif ($InputSql) {
      $InputSql | & $exe @baseArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
    } else {
      & $exe @baseArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
    }
    $code = $LASTEXITCODE
  } finally {
    $env:MYSQL_PWD = $previousPwd
    $ErrorActionPreference = $previousPref
  }
  if ($code -ne 0) { throw "$Tool failed with exit code $code" }
}

function Wait-Http {
  param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $res = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
      if ($res.StatusCode -eq 200) { return $true }
    } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

# Local base URL for health checks. With TLS the certificate names the public host, not
# 127.0.0.1, so validation is skipped for this loopback check only.
function Get-ServerBaseUrl {
  $server = Get-ServerEnv
  $port = (Get-Ports).Server
  if ($server['TLS_PFX_FILE'] -or $server['TLS_CERT_FILE']) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    [Net.ServicePointManager]::ServerCertificateValidationCallback = { param($s, $c, $ch, $e) $true }
    return "https://127.0.0.1:$port"
  }
  return "http://127.0.0.1:$port"
}

function Get-RunState {
  if (-not (Test-Path $script:RunFile)) { return @() }
  @(Get-Content $script:RunFile -Raw | ConvertFrom-Json)
}

function Test-ProcessAlive([int]$ProcessId) { [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) }

function Get-ProjectVersion { (Get-Content (Join-Path $script:Root 'package.json') -Raw | ConvertFrom-Json).version }
