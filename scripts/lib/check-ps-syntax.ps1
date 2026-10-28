# Parses every PowerShell script under scripts\ and reports syntax errors (exit 1 if any).
$bad = 0
foreach ($f in Get-ChildItem (Join-Path $PSScriptRoot '..') -Recurse -Filter *.ps1) {
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errors)
  foreach ($e in @($errors)) { Write-Output "$($f.Name):$($e.Extent.StartLineNumber): $($e.Message)"; $bad++ }
}
if ($bad) { Write-Output "Found $bad error(s)"; exit 1 }
Write-Output 'All checks passed'
