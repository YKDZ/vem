$ErrorActionPreference = "Stop"

$version = "7.4.6"
$root = "D:\runtime-cache\v1\powershell\$version"

function Test-CachedPowerShell {
  param(
    [Parameter(Mandatory = $true)]
    [string] $InstallRoot
  )

  $candidateExecutable = Join-Path $InstallRoot "pwsh.exe"
  if (-not (Test-Path -LiteralPath $candidateExecutable -PathType Leaf)) { return $false }

  try {
    $probeOutput = @(& $candidateExecutable -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' 2>&1)
    $probeExitCode = $LASTEXITCODE
  } catch {
    Write-Warning "PowerShell cache probe could not start: $($_.Exception.Message)"
    return $false
  }

  if ($probeExitCode -ne 0) {
    $probeOutput | ForEach-Object { Write-Warning "PowerShell cache probe: $_" }
  }
  return ($probeExitCode -eq 0 -and @($probeOutput).Count -eq 1 -and [string]$probeOutput[0] -eq "7.4.6")
}

if (-not (Test-CachedPowerShell -InstallRoot $root)) {
  $archive = Join-Path $env:TEMP "PowerShell-$version-win-x64.zip"
  $pending = "$root.pending"
  $previous = "$root.previous"

  try {
    foreach ($path in @($archive, $pending, $previous)) {
      if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
      }
    }

    New-Item -ItemType Directory -Force -Path $pending | Out-Null
    $url = "https://github.com/PowerShell/PowerShell/releases/download/v$version/PowerShell-$version-win-x64.zip"
    & curl.exe --fail --location --retry 3 --ssl-no-revoke --output $archive $url
    if ($LASTEXITCODE -ne 0) {
      throw "PowerShell download failed with curl exit code $LASTEXITCODE"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $pending -Force
    if (-not (Test-CachedPowerShell -InstallRoot $pending)) {
      throw "Downloaded PowerShell cache failed integrity probe"
    }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $root) | Out-Null
    $previousReady = $false
    if (Test-Path -LiteralPath $root) {
      try {
        Move-Item -LiteralPath $root -Destination $previous -ErrorAction Stop
        $previousReady = $true
      } catch {
        throw "Failed to preserve invalid PowerShell cache before replacement: $($_.Exception.Message)"
      }
    }

    try {
      Move-Item -LiteralPath $pending -Destination $root -ErrorAction Stop
    } catch {
      $replacementError = $_.Exception.Message
      if ($previousReady) {
        try {
          Move-Item -LiteralPath $previous -Destination $root -ErrorAction Stop
        } catch {
          throw "Failed to replace PowerShell cache ($replacementError) and restore the previous cache: $($_.Exception.Message)"
        }
      }
      throw "Failed to replace PowerShell cache: $replacementError"
    }

    if ($previousReady) {
      try {
        Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction Stop
      } catch {
        Write-Warning "PowerShell cache replacement succeeded, but previous cache cleanup failed: $($_.Exception.Message)"
      }
    }
  } finally {
    foreach ($path in @($archive, $pending)) {
      if (Test-Path -LiteralPath $path) {
        try {
          Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
        } catch {
          Write-Warning "PowerShell cache temporary cleanup failed for ${path}: $($_.Exception.Message)"
        }
      }
    }
  }
}

if (-not (Test-CachedPowerShell -InstallRoot $root)) {
  throw "cached PowerShell installation is invalid"
}
$root | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
