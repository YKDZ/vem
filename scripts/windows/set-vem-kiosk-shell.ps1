[CmdletBinding()]
param(
  [string]$KioskUser = "VEMKiosk",
  [string]$RuntimeDirectory = "C:\VEM\bringup",
  [string]$HolderScriptName = "kiosk-shell-holder.ps1",
  [string]$ProfileRoot = "C:\Users",
  [switch]$Disable
)

$ErrorActionPreference = "Stop"

# Replaces the VEMKiosk shell with the runtime holder so the interactive session
# has no desktop shell, plus the matching EdgeUI policy so screen-edge swipes
# cannot surface shell surfaces even if a shell is running.
#
# -Disable restores explorer.exe and removes the edge policy (operator escape).

function Invoke-Reg {
  param([string[]]$Arguments, [switch]$IgnoreFailure)
  & reg.exe @Arguments | Out-Null
  if (-not $IgnoreFailure -and $LASTEXITCODE -ne 0) {
    throw "reg.exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
}

$edgeUiKey = "HKLM\SOFTWARE\Policies\Microsoft\Windows\EdgeUI"
$holderPath = Join-Path $RuntimeDirectory $HolderScriptName

$user = Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue
if ($null -eq $user) { throw "required kiosk user is missing: $KioskUser" }
$sid = [string]$user.SID
if ($sid -notmatch '^S-\d-\d+(-\d+)+$') { throw "failed to resolve a SID for $KioskUser" }

$userHive = "HKU\$sid"
$userWinlogonKey = "$userHive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
$hivePath = Join-Path (Join-Path $ProfileRoot $KioskUser) "NTUSER.DAT"
$hiveLoaded = $false

if ($Disable) {
  Invoke-Reg @("delete", $edgeUiKey, "/v", "AllowEdgeSwipe", "/f") -IgnoreFailure
} else {
  Invoke-Reg @("add", $edgeUiKey, "/v", "AllowEdgeSwipe", "/t", "REG_DWORD", "/d", "0", "/f")
}

if (-not (Test-Path -LiteralPath "Registry::$userHive")) {
  if (-not (Test-Path -LiteralPath $hivePath -PathType Leaf)) {
    throw "kiosk user hive is not loaded and cannot be found: $hivePath"
  }
  Invoke-Reg @("load", $userHive, $hivePath)
  $hiveLoaded = $true
}

try {
  if ($Disable) {
    Invoke-Reg @("add", $userWinlogonKey, "/v", "Shell", "/t", "REG_SZ", "/d", "explorer.exe", "/f")
  } else {
    if (-not (Test-Path -LiteralPath $holderPath -PathType Leaf)) {
      throw "kiosk shell holder is missing: $holderPath"
    }
    $shellValue = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$holderPath`""
    Invoke-Reg @("add", $userWinlogonKey, "/v", "Shell", "/t", "REG_SZ", "/d", $shellValue, "/f")
  }
} finally {
  if ($hiveLoaded) {
    Invoke-Reg @("unload", $userHive) -IgnoreFailure
  }
}

if ($Disable) {
  Write-Output "kiosk shell disabled: $KioskUser runs explorer.exe, edge swipe policy removed"
} else {
  Write-Output "kiosk shell installed: $KioskUser shell -> $holderPath, AllowEdgeSwipe=0"
}
