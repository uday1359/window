<#
.SYNOPSIS
  Creates a self-signed TLS certificate so agents on other computers can connect securely.

.DESCRIPTION
  Writes, under data\tls (git-ignored):
    server.pfx  certificate + private key for the server (protected by a random passphrase)
    server.pem  public certificate to copy to each remote agent PC (no secret inside)
  and sets TLS_PFX_FILE, TLS_PFX_PASSPHRASE, HOST and PUBLIC_ORIGIN in server\.env.
  The passphrase is written only to server\.env and never printed.

  On the agent PC:  python -m winagent pair --code <CODE> --server https://<HostName>:<Port> --ca-file <path>\server.pem

  For a production network, prefer a certificate from your organisation's CA (set
  TLS_PFX_FILE / TLS_PFX_PASSPHRASE yourself).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\new-tls-cert.ps1 -HostName winagent-vm.example.com
#>
[CmdletBinding()]
param(
  # The name (or IP address) agents will use to reach this server.
  [Parameter(Mandatory)][string]$HostName,
  # Interface to listen on. 0.0.0.0 = all; prefer a specific address where possible.
  [string]$ListenAddress = '0.0.0.0',
  [int]$ValidDays = 365
)

. "$PSScriptRoot\lib\common.ps1"

$tlsDir = Join-Path $script:DataDir 'tls'
New-Item -ItemType Directory -Force -Path $tlsDir | Out-Null
$isIp = [Net.IPAddress]::TryParse($HostName, [ref]$null)
$san = if ($isIp) { "IPAddress=$HostName" } else { "DNS=$HostName" }

Write-Step "Creating a self-signed certificate for $HostName (valid $ValidDays days)"
$cert = New-SelfSignedCertificate -Subject "CN=$HostName" -TextExtension @("2.5.29.17={text}$san") `
  -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 3072 `
  -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays($ValidDays) -FriendlyName 'WinAgent server'

$alphabet = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$passphrase = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })

$pfxPath = Join-Path $tlsDir 'server.pfx'
$pemPath = Join-Path $tlsDir 'server.pem'
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password (ConvertTo-SecureString $passphrase -AsPlainText -Force) | Out-Null
$der = $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
$pem = "-----BEGIN CERTIFICATE-----`n" + ([Convert]::ToBase64String($der) -replace '(.{64})', "`$1`n").TrimEnd("`n") + "`n-----END CERTIFICATE-----`n"
[IO.File]::WriteAllText($pemPath, $pem, (New-Object Text.ASCIIEncoding))
# The private key now lives in server.pfx; do not leave a second copy in the user's store.
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey

# Only this user (and SYSTEM/Administrators) may read the private key bundle.
& icacls.exe $pfxPath /inheritance:r /grant:r "${env:USERNAME}:R" /grant:r 'SYSTEM:F' /grant:r 'Administrators:F' | Out-Null

Write-Step 'Updating server\.env'
$envPath = Join-Path $script:Root 'server\.env'
$port = (Get-Ports).Server
$updates = [ordered]@{
  HOST = $ListenAddress
  TLS_PFX_FILE = ($pfxPath -replace '\\', '/')
  TLS_PFX_PASSPHRASE = $passphrase
  PUBLIC_ORIGIN = "https://${HostName}:$port"
}
$lines = @(Get-Content $envPath -Encoding UTF8 | Where-Object { $_ -notmatch "^\s*($(($updates.Keys) -join '|'))\s*=" })
$lines += $updates.Keys | ForEach-Object { "$_=$($updates[$_])" }
Set-Content -Path $envPath -Value $lines -Encoding UTF8
$passphrase = $null

Write-Step 'Done'
Write-Host @"
    Server certificate : data\tls\server.pfx (private; never copy it to other machines)
    Agent trust file   : data\tls\server.pem (public; copy to each remote agent PC)
    Dashboard          : https://${HostName}:$port  (browsers will warn about the self-signed certificate)
    Restart WinAgent   : scripts\stop.ps1; scripts\start.ps1
    Allow the port in Windows Firewall and your cloud security group for trusted source IPs only.
"@
