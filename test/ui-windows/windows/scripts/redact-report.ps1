param(
  [Parameter(Mandatory = $true)][string]$ReportDir
)

$ErrorActionPreference = "Stop"
$patterns = @(
  'Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+',
  '"apiKey"\s*:\s*"[^"]+"',
  'sk-[A-Za-z0-9_-]{12,}'
)

$changed = @()
Get-ChildItem -Path $ReportDir -Recurse -File | Where-Object {
  $_.Extension -match '\.(json|md|txt|log)$'
} | ForEach-Object {
  $path = $_.FullName
  $text = Get-Content -Raw -LiteralPath $path
  $next = $text
  foreach ($pattern in $patterns) {
    $next = [regex]::Replace($next, $pattern, '[REDACTED]')
  }
  if ($next -ne $text) {
    Set-Content -LiteralPath $path -Value $next -Encoding utf8
    $changed += $path
  }
}

@{
  redactedAt = (Get-Date).ToString("o")
  files = $changed
} | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $ReportDir "redaction-report.json")
