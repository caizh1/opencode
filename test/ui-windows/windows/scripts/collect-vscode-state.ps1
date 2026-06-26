param(
  [Parameter(Mandatory = $true)][string]$CodeCmd,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$UserDataDir = "",
  [string]$ExtensionsDir = ""
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

& $CodeCmd --version | Out-File -Encoding utf8 (Join-Path $OutDir "vscode-version.txt")
if ($ExtensionsDir) {
  & $CodeCmd --extensions-dir $ExtensionsDir --list-extensions --show-versions | Out-File -Encoding utf8 (Join-Path $OutDir "installed-extensions.txt")
} else {
  & $CodeCmd --list-extensions --show-versions | Out-File -Encoding utf8 (Join-Path $OutDir "installed-extensions.txt")
}

$envInfo = [ordered]@{
  timestamp = (Get-Date).ToString("o")
  computerName = $env:COMPUTERNAME
  userName = $env:USERNAME
  userDataDir = $UserDataDir
  extensionsDir = $ExtensionsDir
}
$envInfo | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $OutDir "environment.json")
