<#
.SYNOPSIS
  One-file setup of WinAgent on a new Windows 10/11 or Windows Server machine.

.DESCRIPTION
  1. Software (one administrator prompt): installs whatever is missing of Git, Node.js LTS,
     Python 3.13, the Visual C++ runtime and MySQL 8.4 LTS (configured as the MySQL84
     service on 127.0.0.1:3306), and checks for Microsoft Edge. Everything is downloaded
     from the official sites and verified (Windows code signature + published checksum)
     before it runs. winget and the Microsoft Store are not used.
  2. Project (as the normal user): clones or updates https://github.com/uday1359/window,
     installs npm and Python packages, creates the database user and databases, migrates
     and builds (scripts\install.ps1). With -Validate it then runs every test.

  Asks for one password: the MySQL root password (the new one on a fresh machine, the
  existing one otherwise). It is never written to disk in plain text.

  Run it from a NORMAL PowerShell window (not "Run as administrator"); it asks for admin
  rights only for the software step. The local agent refuses to run elevated.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup-windows.ps1
  powershell -ExecutionPolicy Bypass -File setup-windows.ps1 -Validate
#>
[CmdletBinding()]
param(
  # Where the project goes. Default: the folder this script is in if it is the project, else %USERPROFILE%\WINDOW.
  [string]$ProjectDir,
  # Run scripts\validate.ps1 -IncludeLifecycle after the setup.
  [switch]$Validate,
  # Internal: the elevated software step.
  [ValidateSet('All', 'Software')][string]$Phase = 'All',
  [string]$SecretFile,
  [string]$LogFile
)

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/uday1359/window.git'
$PythonVersion = '3.13.17'
$MySqlVersion = '8.4.13'
$MySqlMd5 = 'FF44ED8AF9F45ACA5ECE06BB0DB5E5DB'
$MySqlService = 'MySQL84'
$MySqlBase = "$env:ProgramFiles\MySQL\MySQL Server 8.4"
$MySqlData = "$env:ProgramData\MySQL\MySQL Server 8.4"
$Downloads = Join-Path $env:TEMP 'winagent-setup'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }

function Test-Admin {
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Test-Command([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Get-File([string]$Url, [string]$Name) {
  New-Item -ItemType Directory -Force -Path $Downloads | Out-Null
  $path = Join-Path $Downloads $Name
  Write-Host "    downloading $Name ..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $Url -OutFile $path -UseBasicParsing
  return $path
}

# Refuses anything that is not validly signed by the expected publisher and, when known, does not
# match the published checksum. -HashIsEnough accepts an unsigned file whose checksum matches.
function Assert-Genuine([string]$Path, [string]$SignerPattern, [string]$Algorithm, [string]$ExpectedHash, [switch]$HashIsEnough) {
  $name = [IO.Path]::GetFileName($Path)
  if ($ExpectedHash -and (Get-FileHash -Path $Path -Algorithm $Algorithm).Hash -ne $ExpectedHash.ToUpperInvariant()) { throw "${name}: checksum mismatch. Refusing to run it." }
  $sig = Get-AuthenticodeSignature -FilePath $Path
  if ($sig.Status -eq 'NotSigned' -and $HashIsEnough -and $ExpectedHash) { Write-Ok "verified $name (published checksum)"; return }
  if ($sig.Status -ne 'Valid') { throw "${name}: code signature is $($sig.Status). Refusing to run it." }
  if ($SignerPattern -and $sig.SignerCertificate.Subject -notmatch $SignerPattern) { throw "${name}: signed by '$($sig.SignerCertificate.Subject)', expected $SignerPattern. Refusing to run it." }
  Write-Ok "verified $name"
}

# Runs a native tool whose normal output goes to stderr (Windows PowerShell 5.1 would treat it as an error).
function Invoke-Quiet([string]$FilePath, [string[]]$Arguments, [string]$InputText) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($InputText) { $out = $InputText | & $FilePath @Arguments 2>&1 } else { $out = & $FilePath @Arguments 2>&1 }
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if ($code -ne 0) { throw "$([IO.Path]::GetFileName($FilePath)) failed (exit $code): $((@($out) | Select-Object -Last 3) -join ' ')" }
}

function Invoke-Installer([string]$FilePath, [string[]]$Arguments) {
  $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru
  # 3010 = success, restart required later.
  if ($p.ExitCode -notin 0, 3010) { throw "$([IO.Path]::GetFileName($FilePath)) failed with exit code $($p.ExitCode)" }
}

function Get-Python313 {
  if (Test-Command 'py.exe') {
    $v = & py.exe -3.13 -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0 -and $v -eq '3.13') { return $true }
  }
  return $false
}

function Get-NodeMajor {
  if (-not (Test-Command 'node.exe')) { return 0 }
  [int]((& node.exe --version).TrimStart('v').Split('.')[0])
}

# =================================================================== software (elevated)

function Install-Software([string]$RootPassword) {
  Update-SessionPath

  Write-Step 'Visual C++ runtime (needed by MySQL)'
  $vcKey = 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64'
  if ((Get-ItemProperty $vcKey -ErrorAction SilentlyContinue).Installed -eq 1) { Write-Ok 'already installed' }
  else {
    $f = Get-File 'https://aka.ms/vs/17/release/vc_redist.x64.exe' 'vc_redist.x64.exe'
    Assert-Genuine $f 'O=Microsoft Corporation'
    Invoke-Installer $f @('/install', '/quiet', '/norestart')
    Write-Ok 'installed'
  }

  Write-Step 'Git'
  if (Test-Command 'git.exe') { Write-Ok "already installed ($(& git.exe --version))" }
  else {
    $release = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing
    $asset = $release.assets | Where-Object { $_.name -match '^Git-.*-64-bit\.exe$' } | Select-Object -First 1
    if (-not $asset) { throw 'Could not find the Git for Windows installer in the latest release.' }
    $f = Get-File $asset.browser_download_url $asset.name
    $sha = if ($asset.digest -match '^sha256:([0-9a-f]{64})$') { $Matches[1] } else { $null }
    Assert-Genuine $f 'Johannes Schindelin' 'SHA256' $sha
    Invoke-Installer $f @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES')
    Write-Ok 'installed'
  }

  Write-Step 'Node.js LTS'
  if ((Get-NodeMajor) -ge 22) { Write-Ok "already installed ($(& node.exe --version))" }
  else {
    $lts = (Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing) | Where-Object { $_.lts -and $_.files -contains 'win-x64-msi' } | Select-Object -First 1
    $name = "node-$($lts.version)-x64.msi"
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/$($lts.version)/SHASUMS256.txt" -UseBasicParsing).Content
    $sha = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($name))$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
    if (-not $sha) { throw "No published checksum for $name" }
    $f = Get-File "https://nodejs.org/dist/$($lts.version)/$name" $name
    Assert-Genuine $f 'OpenJS Foundation' 'SHA256' $sha
    Invoke-Installer 'msiexec.exe' @('/i', "`"$f`"", '/qn', '/norestart')
    Write-Ok "installed $($lts.version)"
  }

  Write-Step "Python $PythonVersion"
  if (Get-Python313) { Write-Ok 'Python 3.13 already installed' }
  else {
    $f = Get-File "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe" "python-$PythonVersion-amd64.exe"
    Assert-Genuine $f 'Python Software Foundation'
    Invoke-Installer $f @('/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_launcher=1', 'InstallLauncherAllUsers=1', 'Include_test=0')
    Write-Ok 'installed (the py launcher selects it with py -3.13)'
  }

  Write-Step "MySQL $MySqlVersion"
  $service = Get-Service -Name 'MySQL*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($service) {
    if ($service.Status -ne 'Running') { Start-Service $service.Name }
    Write-Ok "service $($service.Name) already exists and is running; your existing root password will be used"
  } else {
    # Never configure MySQL with an empty root password.
    if (-not $RootPassword) { throw 'The MySQL root password was not received by the administrator step. Run this script from an account that is a local administrator.' }
    if (-not (Test-Path "$MySqlBase\bin\mysqld.exe")) {
      $f = Get-File "https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-$MySqlVersion-winx64.msi" "mysql-$MySqlVersion-winx64.msi"
      Assert-Genuine $f 'Oracle' 'MD5' $MySqlMd5 -HashIsEnough
      Invoke-Installer 'msiexec.exe' @('/i', "`"$f`"", '/qn', '/norestart')
    }
    if (-not (Test-Path "$MySqlBase\bin\mysqld.exe")) { throw "MySQL was not installed to $MySqlBase" }
    Write-Host '    configuring MySQL (service MySQL84, 127.0.0.1:3306) ...'
    New-Item -ItemType Directory -Force -Path $MySqlData | Out-Null
    $ini = Join-Path $MySqlData 'my.ini'
    $base = $MySqlBase -replace '\\', '/'
    $data = (Join-Path $MySqlData 'Data') -replace '\\', '/'
    Set-Content -Path $ini -Encoding ASCII -Value @(
      '[mysqld]', "basedir=`"$base`"", "datadir=`"$data`"", 'port=3306', 'bind-address=127.0.0.1',
      'character-set-server=utf8mb4', 'collation-server=utf8mb4_unicode_ci', '[client]', 'port=3306'
    )
    if (-not (Test-Path (Join-Path $MySqlData 'Data'))) {
      Invoke-Quiet "$MySqlBase\bin\mysqld.exe" @("--defaults-file=$ini", '--initialize-insecure', '--console')
    }
    Invoke-Quiet "$MySqlBase\bin\mysqld.exe" @('--install', $MySqlService, "--defaults-file=$ini")
    Set-Service $MySqlService -StartupType Automatic
    Start-Service $MySqlService
    Start-Sleep -Seconds 5
    # The new root password goes in on stdin, never on the command line.
    $quoted = $RootPassword.Replace("'", "''")
    Invoke-Quiet "$MySqlBase\bin\mysql.exe" @('-u', 'root', '--skip-password', '-h', '127.0.0.1') "ALTER USER 'root'@'localhost' IDENTIFIED BY '$quoted';"
    Write-Ok 'installed, running as service MySQL84, root password set'
  }

  Write-Step 'Microsoft Edge (used by the agent for browser automation)'
  if ((Test-Path "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe") -or (Test-Path "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")) { Write-Ok 'already installed' }
  else { Write-Warn 'NOT installed: install it from https://www.microsoft.com/edge, then re-run this script.' }
}

if ($Phase -eq 'Software') {
  if ($LogFile) { Start-Transcript -Path $LogFile -Force | Out-Null }
  $exitCode = 0
  try {
    $root = ''
    # Readable only if UAC elevated this same Windows user (DPAPI); otherwise stays empty.
    if ($SecretFile -and (Test-Path $SecretFile)) {
      try {
        $s = Get-Content $SecretFile | ConvertTo-SecureString
        $root = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
      } catch { $root = '' }
    }
    Install-Software $root
  } catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
  } finally {
    if ($LogFile) { Stop-Transcript | Out-Null }
  }
  exit $exitCode
}

# =================================================================== main (normal user)

Write-Step 'WinAgent setup'
$caption = (Get-CimInstance Win32_OperatingSystem).Caption
Write-Ok "$caption, PowerShell $($PSVersionTable.PSVersion)"

$secure = Read-Host 'MySQL root password (new password on a fresh machine, or your existing one)' -AsSecureString
$rootPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $rootPassword) { throw 'A MySQL root password is required.' }

# --- 1. software
Update-SessionPath
$missing = @()
if (-not (Test-Command 'git.exe')) { $missing += 'Git' }
if ((Get-NodeMajor) -lt 22) { $missing += 'Node.js' }
if (-not (Get-Python313)) { $missing += 'Python 3.13' }
if (-not (Get-Service -Name 'MySQL*' -ErrorAction SilentlyContinue)) { $missing += 'MySQL' }
if ($missing.Count -eq 0) {
  Write-Step 'All required software is already installed'
} elseif (Test-Admin) {
  Install-Software $rootPassword
} else {
  Write-Step "Installing: $($missing -join ', ') (approve the administrator prompt)"
  New-Item -ItemType Directory -Force -Path $Downloads | Out-Null
  # DPAPI-encrypted for this Windows user; the elevated step runs as the same user.
  $secretFile = Join-Path $Downloads 'root.secret'
  $log = Join-Path $Downloads 'software.log'
  $secure | ConvertFrom-SecureString | Set-Content $secretFile
  try {
    $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Phase Software -SecretFile `"$secretFile`" -LogFile `"$log`""
    $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait -PassThru
  } finally { Remove-Item $secretFile -Force -ErrorAction SilentlyContinue }
  if (Test-Path $log) { Get-Content $log | Where-Object { $_ -match '^(==>|    |ERROR)' } | ForEach-Object { Write-Host $_ } }
  if ($p.ExitCode -ne 0) { throw "Software installation failed (see $log)." }
}
Update-SessionPath
foreach ($tool in 'git.exe', 'node.exe', 'npm.cmd', 'py.exe') { if (-not (Test-Command $tool)) { throw "$tool is still not available. Open a new PowerShell window and run this script again." } }

# --- 2. project
if (-not $ProjectDir) {
  $here = Split-Path -Parent $PSCommandPath
  $ProjectDir = if (Test-Path (Join-Path $here 'scripts\install.ps1')) { $here } else { Join-Path $HOME 'WINDOW' }
}
Write-Step "Project folder: $ProjectDir"
if (Test-Path (Join-Path $ProjectDir '.git')) {
  & git.exe -C $ProjectDir pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw 'git pull failed (local changes?). Resolve them or use a new -ProjectDir.' }
} elseif (Test-Path (Join-Path $ProjectDir 'scripts\install.ps1')) {
  Write-Warn 'Not a git clone: using the files as they are (no automatic updates).'
} else {
  & git.exe clone $RepoUrl $ProjectDir
  if ($LASTEXITCODE -ne 0) { throw "git clone $RepoUrl failed" }
}

Write-Step 'Installing packages, database and build (scripts\install.ps1)'
$env:WINAGENT_MYSQL_ROOT_PASSWORD = $rootPassword
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectDir 'scripts\install.ps1')
  $installCode = $LASTEXITCODE
} finally {
  Remove-Item Env:WINAGENT_MYSQL_ROOT_PASSWORD -ErrorAction SilentlyContinue
  $rootPassword = $null
}
if ($installCode -ne 0) { throw 'scripts\install.ps1 failed; see the messages above.' }

if ($Validate) {
  if (Test-Admin) {
    Write-Warn 'Skipping tests: this window is elevated and the agent refuses to run as administrator. Run scripts\validate.ps1 from a normal window.'
  } else {
    Write-Step 'Running all checks and tests (scripts\validate.ps1 -IncludeLifecycle, 15-30 minutes)'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectDir 'scripts\validate.ps1') -IncludeLifecycle
  }
}

Write-Step 'Done'
Write-Host @"
    Start WinAgent : powershell -ExecutionPolicy Bypass -File "$ProjectDir\scripts\start.ps1"
    Dashboard      : http://127.0.0.1:3710  (create the first administrator there)
    Run all tests  : powershell -ExecutionPolicy Bypass -File "$ProjectDir\scripts\validate.ps1" -IncludeLifecycle
"@
