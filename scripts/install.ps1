<#
.SYNOPSIS
  Installs WinAgent from this source folder on a Windows machine.

.DESCRIPTION
  1. Checks prerequisites (Node.js 22+, Python 3.11+, MySQL 8 server and client tools,
     Microsoft Edge). With -InstallPrerequisites, missing ones are installed with winget.
  2. Installs Node and Python dependencies.
  3. On first install, creates the MySQL user 'winagent' with a random password and the
     winagent, winagent_shadow and winagent_test databases (needs the MySQL root password,
     read from WINAGENT_MYSQL_ROOT_PASSWORD or prompted securely; never stored).
  4. Writes server\.env and ai-service\.env (scripts\setup-env.mjs), migrates and builds.

  Safe to re-run: existing configuration and data are kept.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -CheckOnly
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallPrerequisites -Desktop
#>
[CmdletBinding()]
param(
  # Only report which prerequisites are present.
  [switch]$CheckOnly,
  # Install missing prerequisites with winget (needs an administrator prompt).
  [switch]$InstallPrerequisites,
  # Also download the Electron runtime for the desktop shell.
  [switch]$Desktop,
  [switch]$SkipBuild
)

. "$PSScriptRoot\lib\common.ps1"

$EdgePaths = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
$WingetIds = @{ Node = 'OpenJS.NodeJS.LTS'; Python = 'Python.Python.3.13'; MySql = 'Oracle.MySQL'; Edge = 'Microsoft.Edge' }

function Get-NodeMajor {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  [int]((& node.exe --version).TrimStart('v').Split('.')[0])
}

function Get-SystemPython {
  # Prefer the tested versions: the pinned packages ship prebuilt wheels for them, while a newer
  # Python (e.g. 3.15) makes pip compile pydantic-core and needs Visual C++ build tools.
  foreach ($candidate in @(@('py.exe', '-3.13'), @('py.exe', '-3.12'), @('py.exe', '-3.11'), @('py.exe', '-3'), @('python.exe'))) {
    $cmd = Get-Command $candidate[0] -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    $launcherArgs = @($candidate | Select-Object -Skip 1)
    $version = & $cmd.Source @launcherArgs -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0 -and $version) { return [pscustomobject]@{ Path = $cmd.Source; Args = $launcherArgs; Version = [version]$version } }
  }
  return $null
}

function Get-Prerequisites {
  $python = Get-SystemPython
  $mysqlService = Get-Service -Name 'MySQL*' -ErrorAction SilentlyContinue | Select-Object -First 1
  $mysqlClient = $true
  try { Get-MySqlBin | Out-Null } catch { $mysqlClient = $false }
  [ordered]@{
    Node = (Get-NodeMajor) -ge 22
    Python = [bool]($python -and $python.Version -ge [version]'3.11' -and $python.Version -lt [version]'3.14')
    MySql = [bool]($mysqlService -and $mysqlClient)
    Edge = [bool]($EdgePaths | Where-Object { Test-Path $_ })
  }
}

function Show-Prerequisites($state) {
  foreach ($name in $state.Keys) {
    if ($state[$name]) { Write-Ok "${name}: found" } else { Write-Warn "${name}: MISSING" }
  }
}

# ------------------------------------------------------------------ 1. prerequisites
Write-Step 'Checking prerequisites'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'WinAgent runs on Windows only.' }
$state = Get-Prerequisites
Show-Prerequisites $state
$missing = @($state.Keys | Where-Object { -not $state[$_] })

if ($missing.Count -and $InstallPrerequisites) {
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw "winget is not available on this machine. Install manually: $($missing -join ', '). See docs\DEPLOYMENT.md."
  }
  foreach ($name in $missing) {
    Write-Step "Installing $name with winget ($($WingetIds[$name]))"
    Invoke-Native -FilePath 'winget.exe' -Arguments @('install', '--id', $WingetIds[$name], '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements')
  }
  # Pick up PATH changes made by the installers without opening a new terminal.
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $state = Get-Prerequisites
  Show-Prerequisites $state
  $missing = @($state.Keys | Where-Object { -not $state[$_] })
  if ($state.Keys -contains 'MySql' -and -not $state['MySql']) {
    Write-Warn 'MySQL was installed but its server is not configured yet: run MySQL Configurator (set a root password, keep port 3306), then re-run this script.'
  }
}
if ($CheckOnly) { if ($missing.Count) { exit 1 } else { exit 0 } }
if ($missing.Count) { throw "Missing prerequisites: $($missing -join ', '). Re-run with -InstallPrerequisites or install them manually (docs\DEPLOYMENT.md)." }

# ------------------------------------------------------------------ 2. dependencies
Write-Step 'Installing Node.js dependencies (npm ci)'
if (-not $Desktop) { $env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1' }
Invoke-Native -FilePath 'npm.cmd' -Arguments @('ci', '--no-audit', '--no-fund')
if ($Desktop) {
  # npm does not run Electron's install script (it is not in allowScripts), so fetch the runtime explicitly.
  Write-Step 'Downloading the Electron runtime for the desktop shell'
  Invoke-Native -FilePath 'node.exe' -Arguments @('node_modules\electron\install.js')
}

Write-Step 'Installing Python dependencies'
if (Test-Path $script:Python) {
  # A venv made with an unsupported Python (e.g. 3.15) cannot install the pinned packages: rebuild it.
  $venvVersion = & $script:Python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
  if (-not $venvVersion -or [version]$venvVersion -lt [version]'3.11' -or [version]$venvVersion -ge [version]'3.14') {
    Write-Warn "Recreating .venv: it uses Python $venvVersion; WinAgent needs 3.11-3.13."
    Remove-Item (Join-Path $script:Root '.venv') -Recurse -Force
  }
}
if (-not (Test-Path $script:Python)) {
  $sys = Get-SystemPython
  Invoke-Native -FilePath $sys.Path -Arguments ($sys.Args + @('-m', 'venv', '.venv'))
}
Invoke-Native -FilePath $script:Python -Arguments @('-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', 'requirements-dev.txt')

# ------------------------------------------------------------------ 3. database + configuration
function Read-RootPassword {
  if ($env:WINAGENT_MYSQL_ROOT_PASSWORD) { return $env:WINAGENT_MYSQL_ROOT_PASSWORD }
  $secure = Read-Host 'MySQL root password (used once, not stored)' -AsSecureString
  [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

# Creates (or resets) the winagent user with this password and the three databases.
function Set-DatabaseUser([string]$RootPassword, [string]$DbPassword) {
  $quoted = $DbPassword.Replace("'", "''")
  $sql = @"
CREATE USER IF NOT EXISTS 'winagent'@'localhost' IDENTIFIED BY '$quoted';
ALTER USER 'winagent'@'localhost' IDENTIFIED BY '$quoted';
GRANT ALL PRIVILEGES ON ``winagent%``.* TO 'winagent'@'localhost';
CREATE DATABASE IF NOT EXISTS winagent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS winagent_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS winagent_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
"@
  Invoke-MySqlTool -Tool mysql -User 'root' -Password $RootPassword -InputSql $sql
}

function Test-DatabaseLogin {
  $db = Get-DbInfo
  try {
    Invoke-MySqlTool -Tool mysql -User $db.User -Password $db.Password -DbHost $db.Host -Port $db.Port -InputSql 'SELECT 1;' | Out-Null
    return $true
  } catch { return $false }
}

$serverEnv = Get-ServerEnv
if (-not $serverEnv['DATABASE_URL']) {
  Write-Step 'Creating the MySQL user and databases (first install)'
  $rootPassword = Read-RootPassword
  # URL-safe characters only, so the password needs no escaping in DATABASE_URL.
  $alphabet = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $dbPassword = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
  Set-DatabaseUser -RootPassword $rootPassword -DbPassword $dbPassword
  $env:WINAGENT_DB_PASSWORD_URLENC = $dbPassword
  try { Invoke-Native -FilePath 'node.exe' -Arguments @('scripts\setup-env.mjs') }
  finally { Remove-Item Env:WINAGENT_DB_PASSWORD_URLENC -ErrorAction SilentlyContinue }
  $rootPassword = $null
  $dbPassword = $null
  Write-Ok 'Database user created; its random password exists only in server\.env (git-ignored).'
} else {
  Write-Step 'Configuration exists; refreshing generated defaults only'
  Invoke-Native -FilePath 'node.exe' -Arguments @('scripts\setup-env.mjs')
  # Another install on this machine (or a manual change) may have reset the winagent user's
  # password. Repair the MySQL side to match server\.env instead of failing the migration.
  Write-Step 'Checking the database login in server\.env'
  if (Test-DatabaseLogin) {
    Write-Ok 'Database login works.'
  } else {
    Write-Warn 'The winagent database login does not work (password changed or user missing). Repairing it with the MySQL root account.'
    Set-DatabaseUser -RootPassword (Read-RootPassword) -DbPassword (Get-DbInfo).Password
    if (-not (Test-DatabaseLogin)) { throw 'The database login still fails. Check the MySQL root password and that MySQL is running on 127.0.0.1:3306.' }
    Write-Ok 'Database login repaired.'
  }
}

Write-Step 'Applying database migrations'
Invoke-Native -FilePath 'npm.cmd' -Arguments @('run', 'db:migrate')

# ------------------------------------------------------------------ 4. build
if (-not $SkipBuild) {
  Write-Step 'Building server and dashboard'
  Invoke-Native -FilePath 'npm.cmd' -Arguments @('run', 'build')
  if ($Desktop) { Invoke-Native -FilePath 'npm.cmd' -Arguments @('run', 'build', '--workspace', 'electron') }
}

New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null
[pscustomobject]@{ version = Get-ProjectVersion; installedAt = (Get-Date).ToUniversalTime().ToString('o') } |
  ConvertTo-Json | Set-Content -Path (Join-Path $script:DataDir 'install.json') -Encoding UTF8

Write-Step "WinAgent $(Get-ProjectVersion) installed"
Write-Host @"
    Next:
      1. scripts\start.ps1                     (AI service + server; dashboard at http://127.0.0.1:$((Get-Ports).Server))
      2. Dashboard: create the first administrator, then Agent devices -> Create pairing code
      3. As a NORMAL user: .venv\Scripts\python -m winagent pair --code <CODE>   (run in the agent folder)
      4. scripts\start.ps1 -Agent              (starts the agent too)
"@
