$ErrorActionPreference = "Stop"

$version = "7.4.6"
$root = "D:\runtime-cache\v1\powershell\$version"
$executable = Join-Path $root "pwsh.exe"

function Test-CachedPowerShell {
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { return $false }
  $probeOutput = @(& $executable -NoProfile -Command @'
if ($PSVersionTable.PSVersion.ToString() -ne "7.4.6") { exit 1 }
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$null = '{}' | ConvertFrom-Json -ErrorAction Stop
'@
  2>&1)
  $probeExitCode = $LASTEXITCODE
  if ($probeExitCode -ne 0) {
    $probeOutput | ForEach-Object { Write-Warning "PowerShell cache probe: $_" }
  }
  return ($probeExitCode -eq 0)
}

if (-not (Test-CachedPowerShell)) {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  $archive = Join-Path $env:TEMP "PowerShell-$version-win-x64.zip"
  $pending = "$root.pending"
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pending -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $pending | Out-Null
  try {
    $url = "https://github.com/PowerShell/PowerShell/releases/download/v$version/PowerShell-$version-win-x64.zip"
    & curl.exe --fail --location --retry 3 --output $archive $url
    if ($LASTEXITCODE -ne 0) {
      throw "PowerShell download failed with curl exit code $LASTEXITCODE"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $pending -Force
    if (-not (Test-Path -LiteralPath (Join-Path $pending "pwsh.exe") -PathType Leaf)) {
      throw "PowerShell archive did not contain pwsh.exe"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $root) | Out-Null
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $pending -Destination $root
  } finally {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pending -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Test-CachedPowerShell)) {
  throw "cached PowerShell installation is invalid"
}
$root | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
