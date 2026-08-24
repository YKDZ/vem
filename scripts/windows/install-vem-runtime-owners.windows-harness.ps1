$ErrorActionPreference = "Stop"

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-runtime-owners-harness-" + [guid]::NewGuid().ToString("N"))
$runtime = Join-Path $root "bringup"
$daemonData = Join-Path $root "daemon-data"
$visionApp = Join-Path $root "vision-app"
$visionData = Join-Path $root "vision-data"
$manifestPath = Join-Path $root "runtime-owners\owner-manifest.json"
$global:OwnerHarnessTasks = [Collections.Generic.List[object]]::new()
$global:OwnerHarnessScCalls = [Collections.Generic.List[object]]::new()
$global:OwnerHarnessAclCalls = [Collections.Generic.List[object]]::new()
$global:OwnerHarnessRegistryWrites = [Collections.Generic.List[object]]::new()
$global:OwnerHarnessScheduledTasks = @()
$global:OwnerHarnessServices = @()
$global:OwnerHarnessProcesses = @()
$global:OwnerHarnessListeners = @()

function global:Get-LocalUser { param([string]$Name) return [pscustomobject]@{ Name = $Name } }
function global:Get-ScheduledTask {
  param([string]$TaskName, [string]$TaskPath, [Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  if ([string]::IsNullOrWhiteSpace($TaskName)) { return @($global:OwnerHarnessScheduledTasks) }
  return @($global:OwnerHarnessScheduledTasks | Where-Object { $_.TaskName -eq $TaskName -and $_.TaskPath -eq $TaskPath })
}
function global:Get-CimInstance {
  param([string]$ClassName, [string]$Filter, [Parameter(ValueFromRemainingArguments = $true)]$Arguments)
  if ($ClassName -eq "Win32_Service") { return @($global:OwnerHarnessServices) }
  if ($ClassName -eq "Win32_Process") {
    if ($Filter -match "Name = '([^']+)'") {
      return @($global:OwnerHarnessProcesses | Where-Object { [string]$_.Name -eq $Matches[1] })
    }
    if ($Filter -match "ProcessId = ([0-9]+)") {
      return @($global:OwnerHarnessProcesses | Where-Object { [int]$_.ProcessId -eq [int]$Matches[1] }) | Select-Object -First 1
    }
    return @($global:OwnerHarnessProcesses)
  }
  return @()
}
function global:Get-NetTCPConnection { param([Parameter(ValueFromRemainingArguments = $true)]$Arguments) return @($global:OwnerHarnessListeners) }
function global:Get-Service { param([Parameter(ValueFromRemainingArguments = $true)]$Arguments) return $null }
function global:New-Service { param([Parameter(ValueFromRemainingArguments = $true)]$Arguments) return [pscustomobject]@{} }
function global:Set-Service { param([Parameter(ValueFromRemainingArguments = $true)]$Arguments) }
function global:Set-ItemProperty {
  param([string]$Path, [string]$Name, $Value)
  $global:OwnerHarnessRegistryWrites.Add([pscustomobject]@{ name = $Name; value = if ($Name -eq "DefaultPassword") { "<redacted>" } else { [string]$Value } }) | Out-Null
}
function global:Remove-ItemProperty { param([Parameter(ValueFromRemainingArguments = $true)]$Arguments) }
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
  $global:OwnerHarnessTasks.Add([pscustomobject]@{ name = $TaskName; action = $Action; trigger = $Trigger; principal = $Principal; settings = $Settings }) | Out-Null
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
    -MachineUiWebViewDebugPort 9222 `
    -OwnerManifestPath $manifestPath | Out-Null

  $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
  Assert-True ($manifest.schemaVersion -eq "vem-runtime-owners/v1") "owner manifest schema"
  Assert-True ($manifest.owners.daemon.name -eq "VemVendingDaemon") "daemon owner"
  Assert-True ($manifest.owners.machineUi.name -eq "VEMMachineUI") "Machine UI owner"
  Assert-True ($manifest.owners.vision.name -eq "VEMVisionRuntime") "Vision owner"
  Assert-True ($manifest.acl.Count -eq 5) "runtime owner manifest ACL count"
  Assert-True ($global:OwnerHarnessTasks.Count -eq 2) "registered task count"
  Assert-True (@($global:OwnerHarnessScCalls | Where-Object { $_[0] -eq "config" -and $_ -contains "obj=" -and $_ -contains "LocalSystem" -and $_ -contains "start=" -and $_ -contains "auto" }).Count -eq 1) "daemon service did not configure LocalSystem automatic startup"
  Assert-True (@($global:OwnerHarnessScCalls | Where-Object { $_[0] -eq "failure" -and $_ -contains "actions=" }).Count -eq 1) "daemon crash recovery call was not captured"
  Assert-True (@($global:OwnerHarnessRegistryWrites | Where-Object { $_.name -eq "DefaultPassword" -and $_.value -eq "<redacted>" }).Count -eq 1) "DefaultPassword was not written"
  foreach ($task in @($global:OwnerHarnessTasks)) {
    Assert-True ($task.action.Execute -eq "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe") "interactive owner action executable"
    Assert-True ($task.trigger.kind -eq "AtLogon") "interactive owner trigger"
    Assert-True ($task.principal.UserId -eq "VEMKiosk") "interactive owner principal"
    Assert-True ($task.settings.MultipleInstances -eq "IgnoreNew") "interactive owner multiple-instance policy"
  }

  $machineLauncher = Get-Content -Raw -LiteralPath (Join-Path $runtime "launch-vem-machine-ui.ps1")
  $visionLauncher = Get-Content -Raw -LiteralPath (Join-Path $runtime "launch-vem-vision.ps1")
  foreach ($generatedLauncher in @($machineLauncher, $visionLauncher)) {
    $tokens = $null
    $parseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseInput($generatedLauncher, [ref]$tokens, [ref]$parseErrors)
    Assert-True ($parseErrors.Count -eq 0) "generated interactive owner launcher is not valid PowerShell"
  }
  Assert-True ($machineLauncher.Contains("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")) "Machine launcher omitted its debug port"
  Assert-True ($visionLauncher.Contains("vending-vision.exe")) "Vision launcher omitted the owned executable"
  Assert-True ($machineLauncher.Contains("vem-runtime-owner-launch-result/v1")) "Machine launcher omitted its flat terminal result"
  Assert-True ($machineLauncher.Contains("owner_already_ready")) "Machine launcher does not preserve an existing canonical owner"
  Assert-True ($machineLauncher.Contains("Threading.Mutex")) "Machine launcher does not serialize reentry"
  Assert-True (-not $machineLauncher.Contains("Stop-Process")) "Machine launcher still terminates a healthy or competing owner"
  Assert-True ($manifest.owners.machineUi.launchResultPath -like "*runtime-owners*results*machine-ui.json") "Machine owner result path is not canonical"
  Assert-True ($manifest.owners.vision.launchResultPath -like "*runtime-owners*results*vision.json") "Vision owner result path is not canonical"
  Assert-True (-not $visionLauncher.Contains(("VEM_" + "AI_"))) "Vision launcher retained an AI environment"
  $installerSource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "install-vem-runtime-owners.ps1")
  Assert-True (-not $installerSource.Contains(("Vision" + "Ai"))) "installer retained an AI owner path"

  $currentSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $global:OwnerHarnessProcesses = @([pscustomobject]@{
    Name = "machine.exe"
    ProcessId = 4101
    ParentProcessId = 1
    SessionId = $currentSessionId
    ExecutablePath = (Join-Path $runtime "machine.exe")
    CommandLine = ('"' + (Join-Path $runtime "machine.exe") + '"')
  }, [pscustomobject]@{
    Name = "msedgewebview2.exe"
    ProcessId = 5101
    ParentProcessId = 4101
    SessionId = $currentSessionId
    ExecutablePath = "C:\Program Files\Microsoft\EdgeWebView\msedgewebview2.exe"
    CommandLine = 'msedgewebview2.exe --remote-debugging-port=9222'
  })
  $global:OwnerHarnessListeners = @([pscustomobject]@{ OwningProcess = 5101 })
  $firstReentry = (& (Join-Path $runtime "launch-vem-machine-ui.ps1") -Adapter manual | ConvertFrom-Json)
  $secondReentry = (& (Join-Path $runtime "launch-vem-machine-ui.ps1") -Adapter manual | ConvertFrom-Json)
  Assert-True ($firstReentry.status -eq "ready" -and $firstReentry.reasonCode -eq "owner_already_ready") "manual adapter replaced an already ready owner"
  Assert-True ($secondReentry.processId -eq 4101 -and $secondReentry.invocationId -ne $firstReentry.invocationId) "repeated manual adapter did not converge to the same owner"

  [ordered]@{
    schemaVersion = "vem-runtime-owners-harness/v3"
    manifest = $manifest
    machineLauncher = $machineLauncher
    visionLauncher = $visionLauncher
    daemonDataDirectory = $daemonData
    missingPasswordRejected = $missingPasswordRejected
    registeredTasks = @($global:OwnerHarnessTasks)
    scCalls = @($global:OwnerHarnessScCalls)
    aclCalls = @($global:OwnerHarnessAclCalls)
    registryWrites = @($global:OwnerHarnessRegistryWrites)
    reentryResults = @($firstReentry, $secondReentry)
  } | ConvertTo-Json -Depth 16
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
