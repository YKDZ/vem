Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-kiosk-shell-harness-" + [Guid]::NewGuid().ToString("N"))
$runtime = Join-Path $root "runtime"
$profileRoot = Join-Path $root "Users"
New-Item -ItemType Directory -Force -Path $runtime, (Join-Path $profileRoot "VEMKiosk") | Out-Null
Set-Content -LiteralPath (Join-Path $runtime "kiosk-shell-holder.ps1") -Value "# holder" -Encoding ASCII
Set-Content -LiteralPath (Join-Path $profileRoot "VEMKiosk\NTUSER.DAT") -Value "hive" -Encoding ASCII

$global:RegCalls = [System.Collections.Generic.List[string]]::new()

function global:reg.exe {
  param([Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  $global:RegCalls.Add((@($Arguments) -join " ")) | Out-Null
  $global:LASTEXITCODE = 0
}

function global:Get-LocalUser {
  param([string]$Name)
  return [pscustomobject]@{ Name = $Name; SID = "S-1-5-21-1-2-3-1002" }
}

function global:Test-Path {
  param([string]$LiteralPath, [string]$PathType)
  if ($LiteralPath -like "Registry::*") { return $false }
  return [bool](Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath)
}

$scriptPath = Join-Path $PSScriptRoot "set-vem-kiosk-shell.ps1"

$expectationPath = Join-Path $root "kiosk\shell-expected.json"

$null = & $scriptPath -KioskUser "VEMKiosk" -RuntimeDirectory $runtime -ProfileRoot $profileRoot -ExpectationPath $expectationPath *>&1
$installCalls = @($global:RegCalls)
$expectation = if (Test-Path -LiteralPath $expectationPath) { Get-Content -LiteralPath $expectationPath -Raw | ConvertFrom-Json } else { $null }

$global:RegCalls.Clear()
$null = & $scriptPath -KioskUser "VEMKiosk" -RuntimeDirectory $runtime -ProfileRoot $profileRoot -Disable -ExpectationPath $expectationPath *>&1
$disableCalls = @($global:RegCalls)
$expectationRemoved = -not (Test-Path -LiteralPath $expectationPath)

$global:RegCalls.Clear()
$null = & $scriptPath -KioskUser "VEMKiosk" -RuntimeDirectory $runtime -ProfileRoot $profileRoot -DryRun -ExpectationPath (Join-Path $root "kiosk\dry-run.json") *>&1
$whatIfCalls = @($global:RegCalls)

$result = [ordered]@{
  schemaVersion = "vem-kiosk-shell-harness/v1"
  install = [ordered]@{
    edgeSwipeDisabled = @($installCalls | Where-Object { $_ -match "AllowEdgeSwipe" -and $_ -match "/d 0" }).Count -ge 1
    hiveLoaded = @($installCalls | Where-Object { $_ -match "^load " }).Count -ge 1
    hiveUnloaded = @($installCalls | Where-Object { $_ -match "^unload " }).Count -ge 1
    shellUsesHolder = @($installCalls | Where-Object { $_ -match "Winlogon" -and $_ -match "kiosk-shell-holder\.ps1" }).Count -ge 1
    expectationWritten = ($null -ne $expectation) -and ([string]$expectation.holderPath -match "kiosk-shell-holder\.ps1")
    calls = $installCalls
  }
  disable = [ordered]@{
    edgePolicyRemoved = @($disableCalls | Where-Object { $_ -match "^delete " -and $_ -match "AllowEdgeSwipe" }).Count -ge 1
    shellRestored = @($disableCalls | Where-Object { $_ -match "Winlogon" -and $_ -match "explorer\.exe" }).Count -ge 1
    expectationRemoved = $expectationRemoved
    calls = $disableCalls
  }
  whatIf = [ordered]@{
    performedNoWrites = $whatIfCalls.Count -eq 0
    calls = $whatIfCalls
  }
}

Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
$result | ConvertTo-Json -Depth 6 -Compress
