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
$modelRoot = Join-Path $visionData "ai-model-packs\packs\verified"
$sinkRoot = Join-Path $visionData "acceptance\short"
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
  New-Item -ItemType Directory -Force -Path $runtime, $daemonData, $visionApp, $visionData, $modelRoot, $sinkRoot, (Join-Path $visionApp "_internal") | Out-Null
  New-Item -ItemType File -Force -Path (Join-Path $runtime "vending-daemon.exe"), (Join-Path $runtime "machine.exe"), (Join-Path $visionApp "vending-vision.exe"), (Join-Path $visionData "site.json") | Out-Null
  [IO.File]::WriteAllText((Join-Path $modelRoot "model.bin"), "model", [Text.UTF8Encoding]::new($false))
  $modelSha = (Get-FileHash -LiteralPath (Join-Path $modelRoot "model.bin") -Algorithm SHA256).Hash.ToLowerInvariant()
  $descriptor = [ordered]@{
    catvtonSourceRevision = "3b795364a4d2f3b5adb365f39cdea376d20bc53c"
    files = @([ordered]@{ byteSize = 5; format = "bin"; path = "model.bin"; role = "fixture"; sha256 = $modelSha; upstream = "fixture"; upstreamPath = "model.bin" })
    schemaVersion = "vem-official-ai-model-pack-descriptor/v2"
    totalByteSize = 5
    upstreams = @([ordered]@{ id = "fixture"; repository = "fixture/repository"; revision = "a" * 40 })
  }
  $descriptorRaw = $descriptor | ConvertTo-Json -Compress -Depth 8
  [IO.File]::WriteAllText((Join-Path $visionApp "_internal\official-ai-model-pack-descriptor.json"), $descriptorRaw, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $modelRoot "ai-model-manifest.json"), $descriptorRaw, [Text.UTF8Encoding]::new($false))

  $aiInputFailures = [System.Collections.Generic.List[string]]::new()
  $commonInstallerArguments = @{
    RuntimeDirectory = $runtime
    DaemonDataDirectory = $daemonData
    VisionAppDirectory = $visionApp
    VisionDataDirectory = $visionData
    KioskPassword = "prototype-password"
    OwnerManifestPath = $manifestPath
  }
  try {
    & (Join-Path $PSScriptRoot "install-vem-runtime-owners.ps1") @commonInstallerArguments -VisionAiModelPackRoot $modelRoot | Out-Null
  } catch {
    if ($_.Exception.Message -match "must be provided together") { $aiInputFailures.Add("unpaired") | Out-Null }
  }
  try {
    & (Join-Path $PSScriptRoot "install-vem-runtime-owners.ps1") @commonInstallerArguments -VisionAiModelPackRoot ".\relative-model" -VisionAiAcceptanceEvidenceRoot $sinkRoot | Out-Null
  } catch {
    if ($_.Exception.Message -match "must be an absolute directory") { $aiInputFailures.Add("relative") | Out-Null }
  }
  [IO.File]::WriteAllText((Join-Path $sinkRoot "stale.json"), "{}", [Text.UTF8Encoding]::new($false))
  try {
    & (Join-Path $PSScriptRoot "install-vem-runtime-owners.ps1") @commonInstallerArguments -VisionAiModelPackRoot $modelRoot -VisionAiAcceptanceEvidenceRoot $sinkRoot | Out-Null
  } catch {
    if ($_.Exception.Message -match "must be empty") { $aiInputFailures.Add("nonempty") | Out-Null }
  } finally {
    Remove-Item -LiteralPath (Join-Path $sinkRoot "stale.json") -Force
  }
  [IO.File]::WriteAllText((Join-Path $modelRoot "model.bin"), "other", [Text.UTF8Encoding]::new($false))
  try {
    & (Join-Path $PSScriptRoot "install-vem-runtime-owners.ps1") @commonInstallerArguments -VisionAiModelPackRoot $modelRoot -VisionAiAcceptanceEvidenceRoot $sinkRoot | Out-Null
  } catch {
    if ($_.Exception.Message -match "(?:size|digest) mismatch") { $aiInputFailures.Add("model-mismatch") | Out-Null }
  } finally {
    [IO.File]::WriteAllText((Join-Path $modelRoot "model.bin"), "model", [Text.UTF8Encoding]::new($false))
  }
  $modelLink = Join-Path $visionData "ai-model-packs\packs\linked"
  try {
    New-Item -ItemType SymbolicLink -Path $modelLink -Target $modelRoot | Out-Null
    try {
      & (Join-Path $PSScriptRoot "install-vem-runtime-owners.ps1") @commonInstallerArguments -VisionAiModelPackRoot $modelLink -VisionAiAcceptanceEvidenceRoot $sinkRoot | Out-Null
    } catch {
      if ($_.Exception.Message -match "non-reparse") { $aiInputFailures.Add("reparse") | Out-Null }
    }
  } finally {
    Remove-Item -LiteralPath $modelLink -Force -ErrorAction SilentlyContinue
  }
  Assert-Equal ($aiInputFailures -join ",") "unpaired,relative,nonempty,model-mismatch,reparse" "AI owner input rejections"

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
    -VisionAiModelPackRoot $modelRoot `
    -VisionAiAcceptanceEvidenceRoot $sinkRoot `
    -OwnerManifestPath $manifestPath | Out-Null

  $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
  $aiOwnerTasks = @($global:OwnerHarnessTasks)
  Assert-Equal $manifest.schemaVersion "vem-runtime-owners/v1" "owner manifest schema"
  Assert-Equal $manifest.owners.daemon.name "VemVendingDaemon" "daemon owner"
  Assert-Equal $manifest.owners.machineUi.name "VEMMachineUI" "Machine UI owner"
  Assert-Equal $manifest.owners.vision.name "VEMVisionRuntime" "Vision owner"
  Assert-Equal $manifest.owners.vision.ai.modelPackRoot $modelRoot "Vision AI model root"
  Assert-Equal $manifest.owners.vision.ai.acceptanceEvidenceRoot $sinkRoot "Vision AI evidence root"
  Assert-Equal $manifest.acl.Count 6 "AI owner manifest ACL count"
  Assert-Equal @($manifest.acl | Where-Object { $_.path -ceq $modelRoot })[0].rights "RX" "AI model manifest ACL"
  Assert-Equal @($manifest.acl | Where-Object { $_.path -ceq $sinkRoot })[0].rights "M" "AI sink manifest ACL"
  Assert-Equal $global:OwnerHarnessTasks.Count 2 "registered task count"
  Assert-True (@($global:OwnerHarnessScCalls | Where-Object { $_[0] -eq "config" -and $_ -contains "obj=" -and $_ -contains "LocalSystem" -and $_ -contains "start=" -and $_ -contains "auto" }).Count -eq 1) "daemon service did not configure LocalSystem automatic startup"
  Assert-True (@($global:OwnerHarnessScCalls | Where-Object { $_[0] -eq "failure" -and $_ -contains "actions=" -and $_ -contains 'restart/5000/""/0/""/0' }).Count -eq 1) "daemon crash recovery call was not captured"
  Assert-Equal $global:OwnerHarnessAclCalls.Count 6 "runtime ACL call count"
  Assert-True (@($global:OwnerHarnessAclCalls | Where-Object { $_ -contains "/inheritance:r" -and $_ -contains "VEMKiosk:(OI)(CI)(RX)" }).Count -eq 1) "AI model pack did not receive read-only owner ACL"
  $aiAclCalls = @($global:OwnerHarnessAclCalls)
  Assert-True (@($global:OwnerHarnessRegistryWrites | Where-Object { $_.name -eq "DefaultPassword" -and $_.value -eq "<redacted>" }).Count -eq 1) "DefaultPassword was not written"
  foreach ($task in @($global:OwnerHarnessTasks)) {
    Assert-Equal $task.action.Execute "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" "interactive owner action executable"
    Assert-Equal $task.trigger.kind "AtLogon" "interactive owner trigger"
    Assert-Equal $task.trigger.UserId "VEMKiosk" "interactive owner trigger user"
    Assert-Equal $task.principal.UserId "VEMKiosk" "interactive owner principal"
    Assert-Equal $task.settings.MultipleInstances "Parallel" "interactive owner multiple-instance policy"
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

  $global:OwnerHarnessScheduledTasks = @()
  $global:OwnerHarnessServices = @()

  $aiVisionLauncher = Get-Content -Raw -LiteralPath (Join-Path $runtime "launch-vem-vision.ps1")
  $aiMachineLauncher = Get-Content -Raw -LiteralPath (Join-Path $runtime "launch-vem-machine-ui.ps1")
  Assert-True ($aiVisionLauncher.Contains("VEM_AI_MODEL_PACK")) "AI launcher omitted model root"
  Assert-True ($aiVisionLauncher.Contains($modelRoot)) "AI launcher omitted exact model root"
  Assert-True ($aiVisionLauncher.Contains("VEM_AI_ACCEPTANCE_EVIDENCE_ROOT")) "AI launcher omitted evidence root"
  Assert-True ($aiVisionLauncher.Contains($sinkRoot)) "AI launcher omitted exact evidence root"

  & (Join-Path $PSScriptRoot "install-vem-runtime-owners.ps1") `
    -RuntimeDirectory $runtime `
    -DaemonDataDirectory $daemonData `
    -VisionAppDirectory $visionApp `
    -VisionDataDirectory $visionData `
    -KioskPassword "prototype-password" `
    -OwnerManifestPath $manifestPath | Out-Null
  $defaultVisionLauncher = Get-Content -Raw -LiteralPath (Join-Path $runtime "launch-vem-vision.ps1")
  Assert-True (-not $defaultVisionLauncher.Contains("VEM_AI_MODEL_PACK")) "default launcher inherited model root"
  Assert-True (-not $defaultVisionLauncher.Contains("VEM_AI_ACCEPTANCE_EVIDENCE_ROOT")) "default launcher enabled acceptance sink"

  [ordered]@{
    schemaVersion = "vem-runtime-owners-harness/v2"
    manifest = $manifest
    machineLauncher = $aiMachineLauncher
    visionLauncher = $aiVisionLauncher
    defaultVisionLauncher = $defaultVisionLauncher
    daemonDataDirectory = $daemonData
    missingPasswordRejected = $missingPasswordRejected
    legacyOwnerRejected = $legacyOwnerRejected
    aiInputFailures = @($aiInputFailures)
    registeredTasks = @($aiOwnerTasks)
    scCalls = @($global:OwnerHarnessScCalls)
    aclCalls = @($aiAclCalls)
    registryWrites = @($global:OwnerHarnessRegistryWrites)
  } | ConvertTo-Json -Depth 16
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
