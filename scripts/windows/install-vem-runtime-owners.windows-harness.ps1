$ErrorActionPreference = "Stop"

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message; expected $Expected, got $Actual" }
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-runtime-owners-harness-" + [guid]::NewGuid().ToString("N"))
$runtime = Join-Path $root "bringup"
$daemonData = Join-Path $root "daemon-data"
$visionApp = Join-Path $root "vision-app"
$visionData = Join-Path $root "vision-data"
$manifestPath = Join-Path $root "runtime-owners\owner-manifest.json"
$global:OwnerHarnessTasks = [System.Collections.Generic.List[object]]::new()
$global:OwnerHarnessScCalls = [System.Collections.Generic.List[object]]::new()
$global:OwnerHarnessAclCalls = [System.Collections.Generic.List[object]]::new()
$global:OwnerHarnessRegistryWrites = [System.Collections.Generic.List[object]]::new()
$global:OwnerHarnessScheduledTasks = @()
$global:OwnerHarnessServices = @()

function global:Get-LocalUser { param([string]$Name) return [pscustomobject]@{ Name = $Name } }
function global:Get-ScheduledTask {
  param([string]$TaskName, [string]$TaskPath, [Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  if ([string]::IsNullOrWhiteSpace($TaskName)) { return @($global:OwnerHarnessScheduledTasks) }
  return @($global:OwnerHarnessScheduledTasks | Where-Object { $_.TaskName -eq $TaskName -and $_.TaskPath -eq $TaskPath })
}
function global:Get-CimInstance {
  param([string]$ClassName, [Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  if ($ClassName -eq "Win32_Service") { return @($global:OwnerHarnessServices) }
  return @()
}
function global:Get-Service { param([Parameter(ValueFromRemainingArguments = $true)]$Arguments) return $null }
function global:New-Service { param([string]$Name, [string]$BinaryPathName, [string]$DisplayName, [string]$StartupType) return [pscustomobject]@{} }
function global:Set-Service { param([string]$Name, [string]$StartupType) }
function global:Set-ItemProperty {
  param([string]$Path, [string]$Name, $Value)
  $global:OwnerHarnessRegistryWrites.Add([pscustomobject]@{ path = $Path; name = $Name; value = if ($Name -eq "DefaultPassword") { "<redacted>" } else { [string]$Value } }) | Out-Null
  if ($Name -eq "DefaultPassword") { Assert-Equal $Value "prototype-password" "autologon password write" }
}
function global:Remove-ItemProperty { param([string]$Path, [string]$Name, [switch]$ErrorAction) }
function global:icacls.exe {
  param([Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  $global:OwnerHarnessAclCalls.Add(@($Arguments)) | Out-Null
  $global:LASTEXITCODE = 0
}
function global:sc.exe {
  param([Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  $global:OwnerHarnessScCalls.Add(@($Arguments)) | Out-Null
  $global:LASTEXITCODE = 0
}
function global:New-ScheduledTaskAction { param([string]$Execute, [string]$Argument, [string]$WorkingDirectory) return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }
function global:New-ScheduledTaskTrigger { param([switch]$AtLogOn, [string]$User) return [pscustomobject]@{ kind = "AtLogon"; UserId = $User } }
function global:New-ScheduledTaskPrincipal { param([string]$UserId, [string]$LogonType, [string]$RunLevel) return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel } }
function global:New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$StartWhenAvailable, [string]$MultipleInstances, $ExecutionTimeLimit) return [pscustomobject]@{ MultipleInstances = $MultipleInstances; ExecutionTimeLimit = $ExecutionTimeLimit } }
function global:Register-ScheduledTask {
  param([string]$TaskName, $Action, $Trigger, $Principal, $Settings, [string]$Description, [switch]$Force)
  $global:OwnerHarnessTasks.Add([pscustomobject]@{ name = $TaskName; action = $Action; trigger = $Trigger; principal = $Principal; settings = $Settings; force = [bool]$Force }) | Out-Null
  return [pscustomobject]@{ TaskName = $TaskName }
}

try {
  New-Item -ItemType Directory -Force -Path $runtime, $daemonData, $visionApp, $visionData | Out-Null
  New-Item -ItemType File -Force -Path (Join-Path $runtime "vending-daemon.exe"), (Join-Path $runtime "machine.exe"), (Join-Path $visionApp "vending-vision.exe"), (Join-Path $visionData "site.json") | Out-Null

  $missingPasswordRejected = $false
  try {
    & (Join-Path $PSScriptRoot "install-vem-runtime-owners.ps1") -RuntimeDirectory $runtime -DaemonDataDirectory $daemonData -VisionAppDirectory $visionApp -VisionDataDirectory $visionData -OwnerManifestPath $manifestPath | Out-Null
  } catch {
    $missingPasswordRejected = $_.Exception.Message -match "KioskPassword is required"
  }
  Assert-True $missingPasswordRejected "installer accepted an incomplete automatic-logon contract"

  & (Join-Path $PSScriptRoot "install-vem-runtime-owners.ps1") `
    -RuntimeDirectory $runtime `
    -DaemonDataDirectory $daemonData `
    -VisionAppDirectory $visionApp `
    -VisionDataDirectory $visionData `
    -KioskPassword "prototype-password" `
    -OwnerManifestPath $manifestPath | Out-Null

  $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
  Assert-Equal $manifest.schemaVersion "vem-runtime-owners/v1" "owner manifest schema"
  Assert-Equal $manifest.owners.daemon.name "VemVendingDaemon" "daemon owner"
  Assert-Equal $manifest.owners.machineUi.name "VEMMachineUI" "Machine UI owner"
  Assert-Equal $manifest.owners.vision.name "VEMVisionRuntime" "Vision owner"
  Assert-Equal $global:OwnerHarnessTasks.Count 2 "registered task count"
  Assert-True (@($global:OwnerHarnessScCalls | Where-Object { $_[0] -eq "config" -and $_ -contains "obj= LocalSystem" -and $_ -contains "start= auto" }).Count -eq 1) "daemon service did not configure LocalSystem automatic startup"
  Assert-True (@($global:OwnerHarnessScCalls | Where-Object { $_[0] -eq "failure" -and $_ -contains 'actions= restart/5000/""/0/""/0' }).Count -eq 1) "daemon crash recovery call was not captured"
  Assert-Equal $global:OwnerHarnessAclCalls.Count 4 "runtime ACL call count"
  Assert-True (@($global:OwnerHarnessRegistryWrites | Where-Object { $_.name -eq "DefaultPassword" -and $_.value -eq "<redacted>" }).Count -eq 1) "DefaultPassword was not written"
  foreach ($task in @($global:OwnerHarnessTasks)) {
    Assert-Equal $task.action.Execute "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" "interactive owner action executable"
    Assert-Equal $task.trigger.kind "AtLogon" "interactive owner trigger"
    Assert-Equal $task.trigger.UserId "VEMKiosk" "interactive owner trigger user"
    Assert-Equal $task.principal.UserId "VEMKiosk" "interactive owner principal"
    Assert-Equal $task.settings.MultipleInstances "IgnoreNew" "interactive owner multiple-instance policy"
  }

  $global:OwnerHarnessScheduledTasks = @(
    [pscustomobject]@{ TaskPath = "\VEM\"; TaskName = "StartVisionServer"; Actions = @() },
    [pscustomobject]@{ TaskPath = "\"; TaskName = "LegacyVisionLauncher"; Actions = @([pscustomobject]@{ Execute = "C:\Windows\System32\cmd.exe"; Arguments = "/c C:\VEM\bringup\start_vision.cmd" }) },
    [pscustomobject]@{ TaskPath = "\"; TaskName = "LegacyMachineUI"; Actions = @([pscustomobject]@{ Execute = "C:\OldVEM\machine.exe"; Arguments = "" }) }
  )
  $global:OwnerHarnessServices = @(
    [pscustomobject]@{ Name = "LegacyDaemon"; PathName = '"C:\OldVEM\vending-daemon.exe" --console' }
  )
  $legacyOwnerRejected = $false
  try {
    & (Join-Path $PSScriptRoot "install-vem-runtime-owners.ps1") -RuntimeDirectory $runtime -DaemonDataDirectory $daemonData -VisionAppDirectory $visionApp -VisionDataDirectory $visionData -KioskPassword "prototype-password" -OwnerManifestPath $manifestPath | Out-Null
  } catch {
    $legacyOwnerRejected =
      $_.Exception.Message -match [regex]::Escape("\VEM\StartVisionServer") -and
      $_.Exception.Message -match "LegacyVisionLauncher" -and
      $_.Exception.Message -match "LegacyMachineUI" -and
      $_.Exception.Message -match "LegacyDaemon"
  }
  Assert-True $legacyOwnerRejected "installer accepted legacy Vision owners"

  [ordered]@{
    schemaVersion = "vem-runtime-owners-harness/v2"
    manifest = $manifest
    missingPasswordRejected = $missingPasswordRejected
    legacyOwnerRejected = $legacyOwnerRejected
    registeredTasks = @($global:OwnerHarnessTasks)
    scCalls = @($global:OwnerHarnessScCalls)
    aclCalls = @($global:OwnerHarnessAclCalls)
    registryWrites = @($global:OwnerHarnessRegistryWrites)
  } | ConvertTo-Json -Depth 16
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
