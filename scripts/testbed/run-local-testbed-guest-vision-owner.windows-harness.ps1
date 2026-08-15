$ErrorActionPreference = "Stop"

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-baseline-vision-owner-" + [guid]::NewGuid().ToString("N"))
$guestScriptPath = Join-Path $PSScriptRoot "run-local-testbed-guest.ps1"

try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  if ($null -eq (Get-PSDrive -Name C -ErrorAction SilentlyContinue)) {
    New-PSDrive -Name C -PSProvider FileSystem -Root $root | Out-Null
    $createdCDrive = $true
  }
  $script:repoRoot = "C:\repo"
  $script:runtimeRoot = "C:\ProgramData\VEM"
  $script:daemonDataRoot = "C:\ProgramData\VEM\vending-daemon"
  $script:deploymentRoot = "C:\VEM\bringup"
  New-Item -ItemType Directory -Force -Path "$repoRoot\scripts\windows", $runtimeRoot, $daemonDataRoot, $deploymentRoot | Out-Null
  @'
@{} | ConvertTo-Json -Compress
'@ | Set-Content -LiteralPath "$repoRoot\scripts\windows\install-vem-runtime-owners.ps1" -Encoding utf8
  @'
@{ processes = @{ vision = @(@{ id = 5900 }) }; visionWorkers = @(@{ id = 7920 }, @{ id = 5656 }) } | ConvertTo-Json -Compress -Depth 4
'@ | Set-Content -LiteralPath "$repoRoot\scripts\windows\probe-vem-runtime.ps1" -Encoding utf8

  $guestScript = Get-Content -LiteralPath $guestScriptPath -Raw
  $guestScriptRoot = Split-Path -Parent $guestScriptPath
  $evidenceFunctions = [regex]::Match(
    $guestScript,
    '(?s)function Get-CanonicalProcessEvidence\(.*?\r?\n\}\r?\n\r?\nfunction Invoke-InstalledTauriRouteAdmission'
  ).Value
  $startFunction = [regex]::Match(
    $guestScript,
    '(?s)function Start-TestbedInstalledRuntimeOwners \{.*?\r?\n\}\r?\n\r?\nfunction Stop-TestbedCanonicalVision'
  ).Value
  Assert-True (-not [string]::IsNullOrWhiteSpace($evidenceFunctions)) "could not extract installed owner evidence functions"
  Assert-True (-not [string]::IsNullOrWhiteSpace($startFunction)) "could not extract installed owner start function"
  $evidenceFunctions = $evidenceFunctions.Replace('$PSScriptRoot', '$guestScriptRoot')
  Invoke-Expression ($evidenceFunctions -replace '\r?\nfunction Invoke-InstalledTauriRouteAdmission$', '')
  Invoke-Expression ($startFunction -replace '\r?\nfunction Stop-TestbedCanonicalVision$', '')

  function Write-TestbedPhase([string]$Name) {}
  function Install-TestbedStartupVisionArtifact([object]$GuestInput) {}
  function Clear-TestbedLegacyRuntimeOwnersForStartup {}
  function Get-TestbedKioskPassword([object]$GuestInput) { return "harness-password" }
  function Start-Service { param([string]$Name) }
  function Wait-RuntimeReady { return [pscustomobject]@{ ready = [pscustomobject]@{} } }
  function Initialize-TestbedHardwareBindings {}
  function Start-ScheduledTask { param([string]$TaskName) }
  function Invoke-InstalledTauriRouteAdmission { param([string]$Endpoint) }
  function Wait-InstalledTauriRoute([string]$ExpectedRoute) {
    return [pscustomobject]@{ url = "http://tauri.localhost/#/catalog" }
  }
  function Convert-TestbedStartupProbeToReadiness {
    param($Probe, $OwnerManifest, $MachineEvidence, $VisionEvidence, $Route)
    return [ordered]@{
      vision = [ordered]@{
        processCount = @($Probe.processes.vision).Count
        workerCount = @($Probe.visionWorkers).Count
        mainProcessId = [int]$VisionEvidence.processId
      }
    }
  }
  function Start-Sleep { param([int]$Milliseconds); throw "unexpected observer retry: $lastError" }

  function global:Get-CimInstance {
    param([string]$ClassName, [string]$Filter)
    if ($ClassName -ne "Win32_Process") { throw "unexpected CIM class: $ClassName" }
    if ($Filter -match "Name = '([^']+)'") {
      $name = [string]$Matches[1]
      $found = @($global:VisionOwnerHarnessProcesses | Where-Object { [string]$_.Name -ceq $name })
      return $found
    }
    if ($Filter -match 'ProcessId = (\d+)') {
      $processId = [int]$Matches[1]
      return @($global:VisionOwnerHarnessProcesses | Where-Object { [int]$_.ProcessId -eq $processId })
    }
    return @($global:VisionOwnerHarnessProcesses)
  }
  function global:Get-NetTCPConnection {
    param([string]$LocalAddress, [int]$LocalPort, [string]$State)
    return @($global:VisionOwnerHarnessListeners)
  }
  function global:Get-Process {
    param([int]$Id)
    if (-not ($global:VisionOwnerHarnessProcesses.ProcessId -contains $Id)) { throw "missing process $Id" }
    return [pscustomobject]@{ Id = $Id; SessionId = 3 }
  }
  function global:Invoke-CimMethod {
    param([object]$InputObject, [string]$MethodName)
    return [pscustomobject]@{ Domain = "VEM"; User = [string]$InputObject.OwnerUser }
  }

  $canonicalPath = [IO.Path]::GetFullPath((Join-Path "C:\VEM\vision\app" "vending-vision.exe"))
  $canonicalConfig = [IO.Path]::GetFullPath("C:\ProgramData\VEM\vision\site.json")
  function Set-VisionOwnerFixture([object[]]$Processes, [object[]]$Listeners) {
    $global:VisionOwnerHarnessProcesses = @($Processes)
    $global:VisionOwnerHarnessListeners = @($Listeners)
  }
  function New-VisionProcess([int]$ProcessId, [int]$ParentProcessId, [string]$CommandLine, [string]$OwnerUser = "VEMKiosk") {
    return [pscustomobject]@{
      Name = "vending-vision.exe"
      ProcessId = $ProcessId
      ParentProcessId = $ParentProcessId
      ExecutablePath = $canonicalPath
      CommandLine = $CommandLine
      OwnerUser = $OwnerUser
    }
  }
  function Invoke-OwnerStart([object[]]$Processes, [object[]]$Listeners) {
    Set-VisionOwnerFixture -Processes $Processes -Listeners $Listeners
    return Start-TestbedInstalledRuntimeOwners `
      -GuestInput ([pscustomobject]@{ interactiveUserPassword = "harness-password" }) `
      -DaemonPath "C:\VEM\bringup\vending-daemon.exe" `
      -MachinePath ([IO.Path]::GetFullPath("C:\VEM\bringup\machine.exe")) `
      -VisionAiModelPackRoot $null `
      -VisionAiAcceptanceEvidenceRoot $null
  }

  $main = New-VisionProcess 5900 1892 "`"$canonicalPath`" --config `"$canonicalConfig`""
  $machine = [pscustomobject]@{
    Name = "machine.exe"; ProcessId = 5800; ParentProcessId = 1892
    ExecutablePath = [IO.Path]::GetFullPath("C:\VEM\bringup\machine.exe"); CommandLine = "machine.exe"; OwnerUser = "VEMKiosk"
  }
  $workerOne = New-VisionProcess 7920 5900 "`"$canonicalPath`" --multiprocessing-fork parent_pid=5900"
  $workerTwo = New-VisionProcess 5656 5900 "`"$canonicalPath`" --multiprocessing-fork parent_pid=5900"
  $listener = [pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 7892; OwningProcess = 5900 }
  $wrongMainExecutable = New-VisionProcess 5900 1892 "`"$canonicalPath`" --config `"$canonicalConfig`""
  $wrongMainExecutable.ExecutablePath = [IO.Path]::GetFullPath((Join-Path "C:\VEM\vision\other" "vending-vision.exe"))

  $baseline = Invoke-OwnerStart -Processes @($machine, $main, $workerOne, $workerTwo) -Listeners @($listener)
  Assert-True ([int]$baseline.visionEvidence.processId -eq 5900) "baseline observer did not select the listener-owning Vision main"
  Assert-True ([int]$baseline.readiness.vision.processCount -eq 1) "startup readiness counted Vision fork workers as owners"
  Assert-True ([int]$baseline.readiness.vision.workerCount -eq 2) "startup readiness omitted Vision fork-worker evidence"

  foreach ($case in @(
    @{ name = "second listener"; processes = @($machine, $main, $workerOne); listeners = @($listener, [pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 7892; OwningProcess = 7920 }) },
    @{ name = "canonical sibling"; processes = @($machine, $main, $workerOne, (New-VisionProcess 6001 1892 "`"$canonicalPath`" --config `"$canonicalConfig`"")); listeners = @($listener) },
    @{ name = "wrong worker parent"; processes = @($machine, $main, (New-VisionProcess 7920 5999 "`"$canonicalPath`" --multiprocessing-fork parent_pid=5900")); listeners = @($listener) },
    @{ name = "missing worker fork token"; processes = @($machine, $main, (New-VisionProcess 7920 5900 "`"$canonicalPath`" --worker")); listeners = @($listener) },
    @{ name = "duplicate canonical PID"; processes = @($machine, $main, (New-VisionProcess 5900 5900 "`"$canonicalPath`" --multiprocessing-fork parent_pid=5900")); listeners = @($listener) },
    @{ name = "nonpositive canonical PID"; processes = @($machine, $main, (New-VisionProcess 0 5900 "`"$canonicalPath`" --multiprocessing-fork parent_pid=5900")); listeners = @($listener) },
    @{ name = "wrong main executable"; processes = @($machine, $wrongMainExecutable); listeners = @($listener) },
    @{ name = "wrong main config"; processes = @($machine, (New-VisionProcess 5900 1892 "`"$canonicalPath`" --config C:\ProgramData\VEM\vision\wrong.json")); listeners = @($listener) },
    @{ name = "owner drift"; processes = @($machine, (New-VisionProcess 5900 1892 "`"$canonicalPath`" --config `"$canonicalConfig`"" "OtherUser")); listeners = @($listener) },
    @{ name = "noncanonical listener owner"; processes = @($machine, $main); listeners = @([pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 7892; OwningProcess = 9000 }) }
  )) {
    $failure = $null
    try { Invoke-OwnerStart -Processes $case.processes -Listeners $case.listeners | Out-Null } catch { $failure = $_.Exception.Message }
    Assert-True (-not [string]::IsNullOrWhiteSpace($failure)) "baseline observer accepted $($case.name)"
  }

  [ordered]@{ schemaVersion = "vem-baseline-vision-owner-harness/v1"; mainProcessId = 5900; processCount = [int]$baseline.readiness.vision.processCount; workerCount = [int]$baseline.readiness.vision.workerCount } | ConvertTo-Json -Compress
} finally {
  if ($createdCDrive) { Remove-PSDrive -Name C -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
