param(
  [string]$Config = ".\test-config.json",
  [string]$ReportRoot = ".\reports"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = Join-Path $Root "bin\node-win-x64\node.exe"
if (-not (Test-Path $Node)) {
  throw "Bundled node.exe was not found at $Node. Rebuild the runner-only package with --node-win-x64."
}

& $Node (Join-Path $Root "runner\main.js") --bundle-root $Root --config $Config --mode full --report-root $ReportRoot
exit $LASTEXITCODE
