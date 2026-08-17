Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:OwnerContext = $null

function Initialize-TestbedAiVisionOwnerContext {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$DeploymentRoot,
    [Parameter(Mandatory = $true)][string]$DaemonDataRoot,
    [string]$AcceptanceAuthorityRoot,
    [hashtable]$TestOperations
  )
  foreach ($entry in @($RepoRoot, $RuntimeRoot, $DeploymentRoot, $DaemonDataRoot)) {
    if (-not [IO.Path]::IsPathFullyQualified($entry)) { throw "AI owner context paths must be absolute" }
  }
  $script:OwnerContext = [ordered]@{
    repoRoot = [IO.Path]::GetFullPath($RepoRoot)
    runtimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
    deploymentRoot = [IO.Path]::GetFullPath($DeploymentRoot)
    daemonDataRoot = [IO.Path]::GetFullPath($DaemonDataRoot)
    acceptanceAuthorityRoot = if ([string]::IsNullOrWhiteSpace($AcceptanceAuthorityRoot)) {
      "C:\ProgramData\VEM\vision\acceptance"
    } elseif ($env:NODE_ENV -ceq "test" -and [IO.Path]::IsPathFullyQualified($AcceptanceAuthorityRoot)) {
      [IO.Path]::GetFullPath($AcceptanceAuthorityRoot)
    } else {
      throw "custom AI acceptance authority is test-only and must be absolute"
    }
    testOperations = if ($null -ne $TestOperations -and $env:NODE_ENV -ceq "test") { $TestOperations } elseif ($null -ne $TestOperations) {
      throw "AI owner test operations are test-only"
    } else { $null }
  }
}

function Assert-TestbedAiOwnerContext {
  if ($null -eq $script:OwnerContext) { throw "AI Vision owner context is not initialized" }
  return $script:OwnerContext
}

function New-TestbedAiVisionOwnerConfiguration {
  param(
    [Parameter(Mandatory = $true)][object]$GuestInput,
    [Parameter(Mandatory = $true)][ValidateSet("short", "long", "recovery", "corrupt", "worker")][string]$EvidencePhase,
    [string]$ModelPackRoot
  )
  $context = Assert-TestbedAiOwnerContext
  $inputsProperty = $GuestInput.PSObject.Properties["aiVirtualTryOn"]
  $inputs = if ($null -eq $inputsProperty) { $null } else { $inputsProperty.Value }
  if ($null -eq $inputs) { throw "AI owner configuration requires aiVirtualTryOn guest inputs" }
  $selectedModelPackRoot = if ([string]::IsNullOrWhiteSpace($ModelPackRoot)) { [string]$inputs.materializedModelPackRoot } else { $ModelPackRoot }
  if ([string]::IsNullOrWhiteSpace($selectedModelPackRoot) -or -not [IO.Path]::IsPathRooted($selectedModelPackRoot)) {
    throw "AI owner configuration requires an absolute materializedModelPackRoot"
  }
  if ([string]$GuestInput.runId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') {
    throw "AI owner configuration runId is invalid"
  }
  $evidenceAuthority = Join-Path $context.acceptanceAuthorityRoot ([string]$GuestInput.runId)
  New-Item -ItemType Directory -Force -Path $evidenceAuthority | Out-Null
  $evidenceRoot = Join-Path $evidenceAuthority $EvidencePhase
  if (Test-Path -LiteralPath $evidenceRoot) { throw "AI acceptance evidence root already exists: $evidenceRoot" }
  New-Item -ItemType Directory -Path $evidenceRoot | Out-Null
  $evidenceItem = Get-Item -LiteralPath $evidenceRoot -Force
  if (-not $evidenceItem.PSIsContainer -or (($evidenceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
      @(Get-ChildItem -LiteralPath $evidenceRoot -Force).Count -ne 0) {
    throw "AI acceptance evidence root is not a fresh regular empty directory"
  }
  return [ordered]@{ modelPackRoot = [IO.Path]::GetFullPath($selectedModelPackRoot); acceptanceEvidenceRoot = $evidenceRoot; phase = $EvidencePhase }
}

function Get-TestbedKioskPassword([object]$GuestInput) {
  if (-not [string]::IsNullOrWhiteSpace([string]$GuestInput.interactiveUserPassword)) {
    return [string]$GuestInput.interactiveUserPassword
  }
  $winlogon = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -ErrorAction Stop
  if ($winlogon.DefaultUserName -ine "VEMKiosk" -or $winlogon.DefaultDomainName -ne "." -or
      [string]::IsNullOrWhiteSpace([string]$winlogon.DefaultPassword)) {
    throw "AI owner restart requires the baseline VEMKiosk AutoAdminLogon identity"
  }
  return [string]$winlogon.DefaultPassword
}

function Wait-TestbedVisionReady {
  $context = Assert-TestbedAiOwnerContext
  if ($null -ne $context.testOperations -and $context.testOperations.ContainsKey("WaitReady")) {
    return & $context.testOperations.WaitReady
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    try {
      $health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:7892/health" -TimeoutSec 2
      if ($null -ne $health -and $health.fastReady -eq $true -and $health.visionBusinessReady -eq $true -and @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 7892 -State Listen -ErrorAction SilentlyContinue).Count -eq 1) { return $health }
    } catch {}
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "managed Vision owner did not become ready on 127.0.0.1:7892"
}

function Get-TestbedProcessTreeIds([int[]]$RootProcessIds) {
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $owned = [Collections.Generic.HashSet[int]]::new()
  foreach ($processId in $RootProcessIds) { if ($processId -gt 0) { [void]$owned.Add($processId) } }
  do {
    $changed = $false
    foreach ($process in $processes) {
      if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  return @($owned)
}

function Stop-TestbedCanonicalVision([string]$AppDirectory, [string]$ConfigurationPath) {
  $visionModule = Import-Module (Join-Path $PSScriptRoot "..\windows\vision-main-artifacts.psm1") -Force -PassThru
  try {
    & $visionModule {
      param($CanonicalAppDirectory, $CanonicalConfigurationPath)
      Stop-VisionMainTask -AppDirectory $CanonicalAppDirectory -ConfigurationPath $CanonicalConfigurationPath
    } $AppDirectory $ConfigurationPath
  } catch {
    if ($_.FullyQualifiedErrorId -notlike "NoProcessFoundForGivenId,*StopProcessCommand") { throw }
  }
}

function Get-TestbedCanonicalVisionProcesses([string]$AppDirectory, [string]$ConfigurationPath) {
  $canonicalExecutable = [IO.Path]::GetFullPath((Join-Path $AppDirectory "vending-vision.exe"))
  $canonicalConfiguration = [IO.Path]::GetFullPath($ConfigurationPath)
  $visionModule = Import-Module (Join-Path $PSScriptRoot "..\windows\vision-main-artifacts.psm1") -Force -PassThru
  $canonical = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $canonicalExecutable -and
      -not ($_.CommandLine -and $_.CommandLine.Contains("--multiprocessing-fork"))
  })
  $managed = @($canonical | Where-Object {
    $_.CommandLine -and (& $visionModule {
      param($CommandLine, $ConfigurationPath)
      Test-VisionMainCanonicalConfigurationCommandLine $CommandLine $ConfigurationPath
    } $_.CommandLine $canonicalConfiguration)
  })
  return [pscustomobject]@{
    managed = $managed
    unknown = @($canonical | Where-Object { [int]$_.ProcessId -notin @($managed | ForEach-Object { [int]$_.ProcessId }) })
  }
}

function Stop-TestbedAiVisionOwner([string]$AppDirectory, [string]$ConfigurationPath) {
  $context = Assert-TestbedAiOwnerContext
  if ($null -ne $context.testOperations -and $context.testOperations.ContainsKey("StopOwner")) {
    & $context.testOperations.StopOwner $AppDirectory $ConfigurationPath
    return
  }
  $initial = Get-TestbedCanonicalVisionProcesses $AppDirectory $ConfigurationPath
  $initialCanonical = @($initial.managed) + @($initial.unknown)
  $owned = @(Get-TestbedProcessTreeIds @($initialCanonical | ForEach-Object { [int]$_.ProcessId }))
  $canonicalExecutable = [IO.Path]::GetFullPath((Join-Path $AppDirectory "vending-vision.exe"))
  Stop-ScheduledTask -TaskName "VEMVisionRuntime" -ErrorAction SilentlyContinue
  Stop-TestbedCanonicalVision $AppDirectory $ConfigurationPath
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    $processes = Get-TestbedCanonicalVisionProcesses $AppDirectory $ConfigurationPath
    $remaining = @($processes.managed) + @($processes.unknown)
    foreach ($process in $remaining) {
      Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
    $remaining = @($owned | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
    $forkChildren = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ExecutablePath -and [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $canonicalExecutable -and
        $_.CommandLine -and $_.CommandLine.Contains("--multiprocessing-fork")
    })
    foreach ($fork in $forkChildren) {
      Stop-Process -Id ([int]$fork.ProcessId) -Force -ErrorAction SilentlyContinue
    }
    $listeners = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 7892 -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
      Stop-Process -Id ([int]$listener.OwningProcess) -Force -ErrorAction SilentlyContinue
    }
    if (@($processes.managed).Count + @($processes.unknown).Count + $forkChildren.Count -eq 0 -and $remaining.Count -eq 0 -and $listeners.Count -eq 0) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "managed Vision owner did not become physically dead before restart"
}

function Install-TestbedVisionOwner([object]$GuestInput, [object]$Configuration) {
  $context = Assert-TestbedAiOwnerContext
  if ($null -ne $context.testOperations -and $context.testOperations.ContainsKey("InstallOwner")) {
    & $context.testOperations.InstallOwner $GuestInput $Configuration
    return
  }
  $arguments = @{
    RuntimeDirectory = $context.deploymentRoot
    DaemonDataDirectory = $context.daemonDataRoot
    VisionAppDirectory = "C:\VEM\vision\app"
    VisionDataDirectory = "C:\ProgramData\VEM\vision"
    KioskPassword = Get-TestbedKioskPassword $GuestInput
    MachineUiWebViewDebugPort = 9222
    OwnerManifestPath = Join-Path $context.runtimeRoot "runtime-owners\owner-manifest.json"
  }
  if ($null -ne $Configuration) {
    $arguments.VisionAiModelPackRoot = [string]$Configuration.modelPackRoot
    $arguments.VisionAiAcceptanceEvidenceRoot = [string]$Configuration.acceptanceEvidenceRoot
  }
  & (Join-Path $context.repoRoot "scripts\windows\install-vem-runtime-owners.ps1") @arguments | Out-Null
}

function Install-TestbedCorruptVisionOwner([object]$GuestInput, [object]$Configuration) {
  $context = Assert-TestbedAiOwnerContext
  Install-TestbedVisionOwner $GuestInput $null
  if ($null -ne $context.testOperations -and $context.testOperations.ContainsKey("InstallCorruptOwner")) {
    & $context.testOperations.InstallCorruptOwner $GuestInput $Configuration
    return
  }
  $modelRoot = [string]$Configuration.modelPackRoot
  $evidenceRoot = [string]$Configuration.acceptanceEvidenceRoot
  if ($modelRoot.Contains([char]34) -or $evidenceRoot.Contains([char]34)) { throw "corrupt owner launcher path is invalid" }
  $content = @"
`$ErrorActionPreference = "Stop"
`$startInfo = [Diagnostics.ProcessStartInfo]::new()
`$startInfo.FileName = "C:\VEM\vision\app\vending-vision.exe"
`$startInfo.WorkingDirectory = "C:\VEM\vision\app"
`$startInfo.UseShellExecute = `$false
`$startInfo.Arguments = '"--config" "C:\ProgramData\VEM\vision\site.json"'
`$startInfo.EnvironmentVariables["VEM_AI_MODEL_PACK"] = "$modelRoot"
`$startInfo.EnvironmentVariables["VEM_AI_ACCEPTANCE_EVIDENCE_ROOT"] = "$evidenceRoot"
[Diagnostics.Process]::Start(`$startInfo) | Out-Null
"@
  $launcher = Join-Path $context.deploymentRoot "launch-vem-vision.ps1"
  $temporary = "$launcher.$PID.corrupt.tmp"
  try {
    [IO.File]::WriteAllText($temporary, $content, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $launcher -Force -ErrorAction Stop
  } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Disable-TestbedAiVisionWorker([object]$Configuration) {
  $context = Assert-TestbedAiOwnerContext
  if ($null -ne $context.testOperations -and $context.testOperations.ContainsKey("DisableWorker")) {
    return & $context.testOperations.DisableWorker $Configuration
  }
  $canonicalPath = "C:\VEM\vision\app\vending-vision-ai-worker\vending-vision-ai-worker.exe"
  $disabledPath = Join-Path ([string]$Configuration.acceptanceEvidenceRoot) "vending-vision-ai-worker.exe.disabled"
  if (-not (Test-Path -LiteralPath $canonicalPath -PathType Leaf)) {
    throw "canonical installed AI worker is missing before worker-failure proof"
  }
  if (Test-Path -LiteralPath $disabledPath) {
    throw "worker-failure disabled worker destination already exists"
  }
  $worker = Get-Item -LiteralPath $canonicalPath -Force
  if (($worker.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "canonical installed AI worker must be a regular file"
  }
  $sha256 = (Get-FileHash -LiteralPath $canonicalPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  Move-Item -LiteralPath $canonicalPath -Destination $disabledPath -ErrorAction Stop
  return [ordered]@{
    canonicalWorkerPath = $canonicalPath
    disabledWorkerPath = $disabledPath
    workerExecutableSha256 = $sha256
  }
}

function Restore-TestbedAiVisionWorkerFault([Parameter(Mandatory = $true)][object]$WorkerFault) {
  $context = Assert-TestbedAiOwnerContext
  if ($null -ne $context.testOperations -and $context.testOperations.ContainsKey("RestoreWorker")) {
    return & $context.testOperations.RestoreWorker $WorkerFault
  }
  $canonicalPath = [IO.Path]::GetFullPath([string]$WorkerFault.canonicalWorkerPath)
  $disabledPath = [IO.Path]::GetFullPath([string]$WorkerFault.disabledWorkerPath)
  $expectedSha256 = [string]$WorkerFault.workerExecutableSha256
  if ($canonicalPath -ine "C:\VEM\vision\app\vending-vision-ai-worker\vending-vision-ai-worker.exe" -or
      [string]::IsNullOrWhiteSpace($disabledPath) -or $expectedSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw "worker-failure restoration identity is invalid"
  }
  if (Test-Path -LiteralPath $canonicalPath) { throw "canonical installed AI worker already exists during restoration" }
  if (-not (Test-Path -LiteralPath $disabledPath -PathType Leaf)) { throw "disabled installed AI worker is missing during restoration" }
  Move-Item -LiteralPath $disabledPath -Destination $canonicalPath -ErrorAction Stop
  $restoredSha256 = (Get-FileHash -LiteralPath $canonicalPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  if ($restoredSha256 -cne $expectedSha256) { throw "restored installed AI worker identity mismatched" }
  return [ordered]@{ workerExecutableSha256 = $restoredSha256 }
}

function Restore-TestbedDefaultVisionOwner([object]$GuestInput) {
  $context = Assert-TestbedAiOwnerContext
  $app = "C:\VEM\vision\app"
  $configuration = "C:\ProgramData\VEM\vision\site.json"
  Stop-TestbedAiVisionOwner $app $configuration
  Install-TestbedVisionOwner $GuestInput $null
  if ($null -ne $context.testOperations -and $context.testOperations.ContainsKey("StartOwner")) { & $context.testOperations.StartOwner }
  else { Start-ScheduledTask -TaskName "VEMVisionRuntime" -ErrorAction Stop }
  $health = Wait-TestbedVisionReady
  if ($null -ne $context.testOperations -and $context.testOperations.ContainsKey("ReadOwnerIdentity")) {
    $owner = & $context.testOperations.ReadOwnerIdentity
  } else {
    $processes = Get-TestbedCanonicalVisionProcesses $app $configuration
    if (@($processes.managed).Count -ne 1) { throw "default Vision owner identity is ambiguous after recovery" }
    $owner = @($processes.managed)[0]
  }
  return [ordered]@{
    aiEnvironmentCleared = $true
    executablePath = [string]$owner.ExecutablePath
    healthReady = $null -ne $health
    processId = [int]$owner.ProcessId
  }
}

function Restart-TestbedAiVisionOwner {
  param(
    [Parameter(Mandatory = $true)][object]$GuestInput,
    [Parameter(Mandatory = $true)][ValidateSet("short", "long", "recovery")][string]$EvidencePhase,
    [Parameter(Mandatory = $true)][string]$ModelPackRoot
  )
  [void](Assert-TestbedAiOwnerContext)
  $configuration = New-TestbedAiVisionOwnerConfiguration $GuestInput $EvidencePhase
  if ([IO.Path]::GetFullPath($configuration.modelPackRoot) -ine [IO.Path]::GetFullPath($ModelPackRoot)) {
    throw "AI owner restart model root changed between attempts"
  }
  $app = "C:\VEM\vision\app"
  $site = "C:\ProgramData\VEM\vision\site.json"
  try {
    # Stopping the current owner is itself mutating. It belongs inside the
    # recovery transaction so a partial stop can never strand the machine.
    Stop-TestbedAiVisionOwner $app $site
    Install-TestbedVisionOwner $GuestInput $configuration
    $context = Assert-TestbedAiOwnerContext
    if ($null -ne $context.testOperations -and $context.testOperations.ContainsKey("StartOwner")) { & $context.testOperations.StartOwner }
    else { Start-ScheduledTask -TaskName "VEMVisionRuntime" -ErrorAction Stop }
    $health = Wait-TestbedVisionReady
    if ($health.aiReady -ne $true -or [string]$health.aiReadinessDiagnostic -cne "ready") {
      throw "verified AI owner did not expose ready model and worker identities"
    }
    $configuration.health = $health
    return $configuration
  } catch {
    $primary = $_.Exception
    try { Restore-TestbedDefaultVisionOwner $GuestInput }
    catch { throw [AggregateException]::new("AI Vision owner restart and default-owner recovery both failed", @($primary, $_.Exception)) }
    throw $primary
  }
}

function Restart-TestbedAiDegradedVisionOwner {
  param(
    [Parameter(Mandatory = $true)][object]$GuestInput,
    [Parameter(Mandatory = $true)][ValidateSet("missing", "corrupt", "worker")][string]$Fault,
    [string]$ModelPackRoot
  )
  [void](Assert-TestbedAiOwnerContext)
  $app = "C:\VEM\vision\app"
  $site = "C:\ProgramData\VEM\vision\site.json"
  $configuration = $null
  $workerFault = $null
  try {
    Stop-TestbedAiVisionOwner $app $site
    if ($Fault -ceq "missing") {
      Install-TestbedVisionOwner $GuestInput $null
      $expectedDiagnostic = "model_pack_missing"
    } else {
      if ([string]::IsNullOrWhiteSpace($ModelPackRoot) -or -not [IO.Path]::IsPathRooted($ModelPackRoot)) { throw "$Fault AI degradation requires an absolute model root" }
      if ($Fault -ceq "corrupt") {
        $configuration = New-TestbedAiVisionOwnerConfiguration -GuestInput $GuestInput -EvidencePhase corrupt -ModelPackRoot $ModelPackRoot
        Install-TestbedCorruptVisionOwner $GuestInput $configuration
        $expectedDiagnostic = "model_pack_invalid"
      } else {
        $configuration = New-TestbedAiVisionOwnerConfiguration -GuestInput $GuestInput -EvidencePhase worker -ModelPackRoot $ModelPackRoot
        Install-TestbedVisionOwner $GuestInput $configuration
        $workerFault = Disable-TestbedAiVisionWorker $configuration
        $expectedDiagnostic = "worker_unavailable"
      }
    }
    $context = Assert-TestbedAiOwnerContext
    if ($null -ne $context.testOperations -and $context.testOperations.ContainsKey("StartOwner")) { & $context.testOperations.StartOwner }
    else { Start-ScheduledTask -TaskName "VEMVisionRuntime" -ErrorAction Stop }
    $health = Wait-TestbedVisionReady
    if ($health.aiReady -ne $false -or [string]$health.aiReadinessDiagnostic -cne $expectedDiagnostic) { throw "managed Vision owner did not expose $expectedDiagnostic" }
    if ($Fault -ceq "corrupt") {
      return [ordered]@{ acceptanceEvidenceRoot = [string]$configuration.acceptanceEvidenceRoot; health = $health; modelPackRoot = [string]$configuration.modelPackRoot }
    }
    if ($Fault -ceq "worker") {
      return [ordered]@{ acceptanceEvidenceRoot = [string]$configuration.acceptanceEvidenceRoot; health = $health; modelPackRoot = [string]$configuration.modelPackRoot; workerFault = $workerFault }
    }
    return $health
  } catch {
    $primary = $_.Exception
    try {
      if ($null -ne $workerFault) { Restore-TestbedAiVisionWorkerFault $workerFault | Out-Null }
      Restore-TestbedDefaultVisionOwner $GuestInput | Out-Null
    }
    catch { throw [AggregateException]::new("AI degradation owner and default-owner recovery both failed", @($primary, $_.Exception)) }
    if ($null -ne $configuration -and (Test-Path -LiteralPath ([string]$configuration.acceptanceEvidenceRoot))) {
      Remove-Item -LiteralPath ([string]$configuration.acceptanceEvidenceRoot) -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw $primary
  }
}

Export-ModuleMember -Function Initialize-TestbedAiVisionOwnerContext, New-TestbedAiVisionOwnerConfiguration, Restart-TestbedAiVisionOwner, Restart-TestbedAiDegradedVisionOwner, Restore-TestbedAiVisionWorkerFault, Restore-TestbedDefaultVisionOwner
