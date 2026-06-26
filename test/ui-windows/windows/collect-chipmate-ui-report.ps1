param(
  [string]$Reports = ".\reports",
  [string]$Out = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ReportsPath = Resolve-Path (Join-Path $Root $Reports)
if (-not $Out) {
  $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $Out = Join-Path $Root "chipmate-ui-report-$Stamp.zip"
}

if (Test-Path $Out) {
  Remove-Item $Out -Force
}

Compress-Archive -Path (Join-Path $ReportsPath "*") -DestinationPath $Out -Force
Write-Host "report=$Out"
