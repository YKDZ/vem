[CmdletBinding()]
param(
  [string]$DaemonDataDirectory = "C:\ProgramData\VEM\vending-daemon",
  [string]$OwnerManifestPath = "C:\ProgramData\VEM\runtime-owners\owner-manifest.json",
  [switch]$RequireHealthy
)

$ErrorActionPreference = "Stop"

function Invoke-LocalJsonGet {
  param([string]$Uri, [hashtable]$Headers = @{})
  try {
    return [ordered]@{
      ok = $true
      value = Invoke-RestMethod -Method Get -Uri $Uri -Headers $Headers -TimeoutSec 5
      error = $null
    }
  } catch {
    return [ordered]@{ ok = $false; value = $null; error = $_.Exception.Message }
  }
}

function Read-OwnerManifest([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "runtime owner manifest is missing: $Path" }
  $manifest = Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
  if ([string]$manifest.schemaVersion -cne "vem-runtime-owners/v1") { throw "runtime owner manifest is invalid: $Path" }
  return $manifest
}

function Get-ProcessEvidence([string]$ProcessName) {
  return @(
    Get-CimInstance Win32_Process -Filter "Name = '$ProcessName'" -ErrorAction SilentlyContinue | ForEach-Object {
      $process = $_
      $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction SilentlyContinue
      $sessionId = if ($null -ne $process.PSObject.Properties["SessionId"]) { [int]$process.SessionId } else { $null }
      [ordered]@{
        id = [int]$process.ProcessId
        path = [string]$process.ExecutablePath
        commandLine = [string]$process.CommandLine
        sessionId = $sessionId
        user = if ($null -ne $owner -and $owner.ReturnValue -eq 0) { "$($owner.Domain)\$($owner.User)" } else { $null }
      }
    }
  )
}

function Get-VisionConfigurationPath($VisionOwner) {
  $arguments = @($VisionOwner.arguments)
  $configIndexes = @(
    for ($index = 0; $index -lt $arguments.Count; $index += 1) {
      if ([string]$arguments[$index] -ceq "--config") { $index }
    }
  )
  if ($configIndexes.Count -ne 1 -or $configIndexes[0] -ge ($arguments.Count - 1)) { return $null }
  $configurationPath = [string]$arguments[$configIndexes[0] + 1]
  if ([string]::IsNullOrWhiteSpace($configurationPath)) { return $null }
  return $configurationPath
}

function Get-VisionProcessTopology($VisionOwner, [object[]]$ObservedProcesses) {
  $issues = [System.Collections.Generic.List[string]]::new()
  $configurationPath = Get-VisionConfigurationPath $VisionOwner
  if ([string]::IsNullOrWhiteSpace($configurationPath)) {
    $issues.Add("Vision owner manifest does not declare one configuration path") | Out-Null
    return [ordered]@{ mainProcesses = @(); workerProcesses = @(); issues = @($issues) }
  }
  try {
    $visionModule = Import-Module (Join-Path $PSScriptRoot "vision-main-artifacts.psm1") -Force -PassThru
    $binding = & $visionModule {
      param($AppDirectory, $ConfigurationPath)
      Get-VisionMainCanonicalProcessBinding $AppDirectory $ConfigurationPath
    } (Split-Path -Parent ([string]$VisionOwner.executablePath)) $configurationPath
  } catch {
    $issues.Add("Vision process topology could not be observed: $($_.Exception.Message)") | Out-Null
    return [ordered]@{ mainProcesses = @(); workerProcesses = @(); issues = @($issues) }
  }
  if ($null -eq $binding) {
    $issues.Add("Vision process topology is invalid") | Out-Null
    return [ordered]@{ mainProcesses = @(); workerProcesses = @(); issues = @($issues) }
  }
  $mainProcessId = [int]$binding.mainProcess.ProcessId
  $mainProcesses = @($ObservedProcesses | Where-Object { [int]$_.id -eq $mainProcessId })
  $workerProcessIds = @($binding.workerProcesses | ForEach-Object { [int]$_.ProcessId })
  $workerProcesses = @($ObservedProcesses | Where-Object { [int]$_.id -in $workerProcessIds })
  if ($mainProcesses.Count -ne 1 -or $workerProcesses.Count -ne $workerProcessIds.Count) {
    $issues.Add("Vision process topology changed while evidence was collected") | Out-Null
    return [ordered]@{ mainProcesses = @(); workerProcesses = @(); issues = @($issues) }
  }
  return [ordered]@{ mainProcesses = $mainProcesses; workerProcesses = $workerProcesses; issues = @($issues) }
}

function Test-KioskIdentity([string]$Identity, [string]$KioskUser) {
  if ([string]::IsNullOrWhiteSpace($Identity)) { return $false }
  if ($Identity -ieq $KioskUser) { return $true }
  $parts = $Identity -split "\\", 2
  if ($parts.Count -ne 2 -or $parts[1] -ine $KioskUser) { return $false }
  return $parts[0] -eq "." -or $parts[0] -ieq $env:COMPUTERNAME
}

function Test-NoTaskRestartPolicy($Settings) {
  if ($null -eq $Settings) { return $true }
  $restartCount = if ($null -ne $Settings.PSObject.Properties["RestartCount"] -and $null -ne $Settings.RestartCount) { [int]$Settings.RestartCount } else { 0 }
  $restartInterval = if ($null -ne $Settings.PSObject.Properties["RestartInterval"]) { [string]$Settings.RestartInterval } else { "" }
  return $restartCount -eq 0 -and ($restartInterval -in @("", "PT0S", "P0D", "00:00:00"))
}

function Get-TaskOwnerDefinition($Task, $Owner, [string]$KioskUser) {
  $issues = [System.Collections.Generic.List[string]]::new()
  if ($null -eq $Task) {
    $issues.Add("scheduled task is missing") | Out-Null
    return [ordered]@{ name = [string]$Owner.name; taskPath = [string]$Owner.taskPath; present = $false; issues = @($issues) }
  }

  if (-not (Test-KioskIdentity ([string]$Task.Principal.UserId) $KioskUser)) {
    $issues.Add("task principal is not $KioskUser") | Out-Null
  }
  $hasLogonTrigger = @($Task.Triggers | Where-Object {
    $className = if ($null -ne $_.CimClass) { [string]$_.CimClass.CimClassName } else { [string]$_.CimClassName }
    $className -match "TaskLogonTrigger" -and (Test-KioskIdentity ([string]$_.UserId) $KioskUser)
  }).Count -gt 0
  if (-not $hasLogonTrigger) { $issues.Add("task does not have a $KioskUser AtLogon trigger") | Out-Null }
  if (-not (Test-NoTaskRestartPolicy $Task.Settings)) { $issues.Add("task has a restart policy") | Out-Null }

  $expectedPowerShell = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
  $hasExpectedAction = @($Task.Actions | Where-Object {
    [string]$_.Execute -ieq $expectedPowerShell -and
    [string]$_.Arguments -match [regex]::Escape([string]$Owner.launcherPath) -and
    [string]$_.WorkingDirectory -ieq [string]$Owner.workingDirectory
  }).Count -gt 0
  if (-not $hasExpectedAction) { $issues.Add("task action does not use the installed owner launcher and working directory") | Out-Null }

  return [ordered]@{
    name = [string]$Owner.name
    taskPath = [string]$Owner.taskPath
    present = $true
    state = [string]$Task.State
    user = [string]$Task.Principal.UserId
    hasKioskAtLogonTrigger = $hasLogonTrigger
    hasRestartPolicy = -not (Test-NoTaskRestartPolicy $Task.Settings)
    hasExpectedAction = $hasExpectedAction
    issues = @($issues)
  }
}

function Get-CurrentIdentityName {
  try { return [Security.Principal.WindowsIdentity]::GetCurrent().Name } catch { return $env:USERNAME }
}

function Test-RuntimeExecutableReference([string]$Text, [string[]]$ExpectedPaths) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  if (@($ExpectedPaths | Where-Object { $Text -match [regex]::Escape($_) }).Count -gt 0) {
    return $true
  }
  return $Text -match '(?i)(^|[\\/"''\s])(?:machine|vending-vision|vending-daemon)\.exe\b'
}

function Get-CompetingOwners($Manifest) {
  $expectedTasks = @([string]$Manifest.owners.machineUi.name, [string]$Manifest.owners.vision.name)
  $expectedPaths = @(
    [string]$Manifest.owners.daemon.executablePath,
    [string]$Manifest.owners.machineUi.executablePath,
    [string]$Manifest.owners.vision.executablePath
  )
  $conflicts = [System.Collections.Generic.List[string]]::new()
  foreach ($task in @(Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    if ($expectedTasks -contains [string]$task.TaskName) { continue }
    $actionText = @($task.Actions | ForEach-Object { "$( [string]$_.Execute ) $( [string]$_.Arguments )" }) -join " "
    $isLegacyVisionTask = [string]$task.TaskPath -ieq "\VEM\" -and [string]$task.TaskName -ieq "StartVisionServer"
    $usesLegacyVisionLauncher = $actionText -match '(?i)start_vision\.(bat|cmd)\b'
    if ($isLegacyVisionTask -or $usesLegacyVisionLauncher -or (Test-RuntimeExecutableReference $actionText $expectedPaths)) {
      $conflicts.Add("scheduled task $($task.TaskPath)$($task.TaskName)") | Out-Null
    }
  }
  foreach ($service in @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue)) {
    if ([string]$service.Name -eq [string]$Manifest.owners.daemon.name) { continue }
    if (Test-RuntimeExecutableReference ([string]$service.PathName) $expectedPaths) {
      $conflicts.Add("service $($service.Name)") | Out-Null
    }
  }
  return @($conflicts | Select-Object -Unique)
}

$owners = Read-OwnerManifest $OwnerManifestPath
$readyPath = Join-Path $DaemonDataDirectory "daemon-ready.json"
$observedProcesses = [ordered]@{
  daemon = @(Get-ProcessEvidence "vending-daemon.exe")
  machineUi = @(Get-ProcessEvidence "machine.exe")
  vision = @(Get-ProcessEvidence "vending-vision.exe")
}
$visionTopology = Get-VisionProcessTopology $owners.owners.vision @($observedProcesses.vision)
$processes = [ordered]@{
  daemon = @($observedProcesses.daemon)
  machineUi = @($observedProcesses.machineUi)
  vision = @($visionTopology.mainProcesses)
}
$visionWorkers = @($visionTopology.workerProcesses)
$duplicateProcesses = @(
  foreach ($entry in @($processes.GetEnumerator() | Where-Object { $_.Key -in @("daemon", "machineUi") })) {
    if ($entry.Value.Count -gt 1) { [ordered]@{ component = $entry.Key; count = $entry.Value.Count } }
  }
  if ($visionTopology.issues.Count -gt 0 -and $observedProcesses.vision.Count -gt 1) {
    [ordered]@{ component = "vision"; count = $observedProcesses.vision.Count }
  }
)
$missingProcesses = @(
  foreach ($entry in $processes.GetEnumerator()) {
    if ($entry.Value.Count -eq 0) { $entry.Key }
  }
)
$expectedProcessPaths = [ordered]@{
  daemon = [string]$owners.owners.daemon.executablePath
  machineUi = [string]$owners.owners.machineUi.executablePath
  vision = [string]$owners.owners.vision.executablePath
}
$unexpectedProcesses = @(
  foreach ($entry in $observedProcesses.GetEnumerator()) {
    foreach ($process in @($entry.Value)) {
      if ([string]$process.path -ine [string]$expectedProcessPaths[$entry.Key]) {
        [ordered]@{
          component = $entry.Key
          id = [int]$process.id
          expectedPath = [string]$expectedProcessPaths[$entry.Key]
          actualPath = [string]$process.path
        }
      }
    }
  }
)

$tasks = foreach ($owner in @($owners.owners.machineUi, $owners.owners.vision)) {
  $task = Get-ScheduledTask -TaskName ([string]$owner.name) -TaskPath ([string]$owner.taskPath) -ErrorAction SilentlyContinue
  Get-TaskOwnerDefinition $task $owner ([string]$owners.kiosk.user)
}
$service = Get-Service -Name ([string]$owners.owners.daemon.name) -ErrorAction SilentlyContinue
$serviceConfig = Get-CimInstance Win32_Service -Filter "Name = '$([string]$owners.owners.daemon.name)'" -ErrorAction SilentlyContinue
$winlogon = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -ErrorAction Stop
$serviceDefinitionIssues = [System.Collections.Generic.List[string]]::new()
if ($null -eq $serviceConfig) {
  $serviceDefinitionIssues.Add("daemon service definition is missing") | Out-Null
} else {
  if ([string]$serviceConfig.StartName -ine "LocalSystem") { $serviceDefinitionIssues.Add("daemon service account is not LocalSystem") | Out-Null }
  if ([string]$serviceConfig.StartMode -notin @("Auto", "Automatic")) { $serviceDefinitionIssues.Add("daemon service does not start automatically") | Out-Null }
  if ([string]$serviceConfig.PathName -notmatch [regex]::Escape([string]$owners.owners.daemon.executablePath)) { $serviceDefinitionIssues.Add("daemon service path does not use the owner manifest executable") | Out-Null }
}
$interactiveProcessOwnerIssues = @(
  foreach ($component in @("machineUi", "vision")) {
    foreach ($process in @($observedProcesses[$component])) {
      if (-not [string]::IsNullOrWhiteSpace([string]$process.user) -and -not (Test-KioskIdentity ([string]$process.user) ([string]$owners.kiosk.user))) {
        "$component process $($process.id) is not owned by $($owners.kiosk.user)"
      }
      if ($null -ne $process.sessionId -and [int]$process.sessionId -le 0) {
        "$component process $($process.id) is not in an interactive session"
      }
    }
  }
)

$daemon = [ordered]@{ readyFilePresent = $false }
if (Test-Path -LiteralPath $readyPath -PathType Leaf) {
  try {
    $ready = Get-Content -LiteralPath $readyPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $origin = ([uri]$ready.readyzUrl).GetLeftPart([UriPartial]::Authority)
    $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
    $daemon = [ordered]@{
      readyFilePresent = $true
      origin = $origin
      health = Invoke-LocalJsonGet "$origin/healthz"
      readiness = Invoke-LocalJsonGet $ready.readyzUrl $headers
      saleStartCapability = Invoke-LocalJsonGet "$origin/v1/sale-start-capability" $headers
      hardwareBindings = Invoke-LocalJsonGet "$origin/v1/hardware-bindings" $headers
      runtimeConfiguration = Invoke-LocalJsonGet "$origin/v1/runtime-configuration" $headers
    }
  } catch {
    $daemon = [ordered]@{ readyFilePresent = $true; error = $_.Exception.Message }
  }
}

$result = [ordered]@{
  schemaVersion = "vem-field-probe/v3"
  observedAt = [DateTime]::UtcNow.ToString("o")
  host = [ordered]@{
    computerName = $env:COMPUTERNAME
    user = Get-CurrentIdentityName
  }
  ownerManifest = [ordered]@{ path = $OwnerManifestPath; schemaVersion = [string]$owners.schemaVersion }
  kiosk = [ordered]@{
    user = [string]$owners.kiosk.user
    autoAdminLogon = [string]$winlogon.AutoAdminLogon -eq "1" -and [string]$winlogon.DefaultUserName -ieq [string]$owners.kiosk.user -and [string]$winlogon.DefaultDomainName -eq "." -and -not [string]::IsNullOrWhiteSpace([string]$winlogon.DefaultPassword)
    passwordConfigured = -not [string]::IsNullOrWhiteSpace([string]$winlogon.DefaultPassword)
  }
  service = [ordered]@{
    name = [string]$owners.owners.daemon.name
    present = $null -ne $service
    state = if ($null -ne $service) { [string]$service.Status } else { $null }
    startMode = if ($null -ne $serviceConfig) { [string]$serviceConfig.StartMode } else { $null }
    account = if ($null -ne $serviceConfig) { [string]$serviceConfig.StartName } else { $null }
    pathName = if ($null -ne $serviceConfig) { [string]$serviceConfig.PathName } else { $null }
    definitionIssues = @($serviceDefinitionIssues)
  }
  tasks = @($tasks)
  processes = $processes
  visionWorkers = $visionWorkers
  visionTopologyIssues = @($visionTopology.issues)
  competingOwners = @(Get-CompetingOwners $owners)
  duplicateProcesses = $duplicateProcesses
  missingProcesses = $missingProcesses
  unexpectedProcesses = $unexpectedProcesses
  interactiveProcessOwnerIssues = $interactiveProcessOwnerIssues
  daemon = $daemon
}

$result | ConvertTo-Json -Depth 20
if ($RequireHealthy) {
  $failures = [System.Collections.Generic.List[string]]::new()
  if (-not $result.kiosk.autoAdminLogon) { $failures.Add("VEMKiosk automatic logon prerequisites are incomplete") | Out-Null }
  if (-not $result.service.present -or $result.service.state -ne "Running") { $failures.Add("daemon service is not running") | Out-Null }
  if ($result.service.definitionIssues.Count -gt 0) { $failures.Add("daemon owner definition is invalid: $($result.service.definitionIssues -join ', ')") | Out-Null }
  foreach ($task in @($result.tasks)) {
    if ($task.issues.Count -gt 0) { $failures.Add("task owner definition is invalid for $($task.name): $($task.issues -join ', ')") | Out-Null }
  }
  if ($result.competingOwners.Count -gt 0) { $failures.Add("competing runtime owners: $($result.competingOwners -join ', ')") | Out-Null }
  if ($result.duplicateProcesses.Count -gt 0) { $failures.Add("duplicate runtime processes") | Out-Null }
  if ($result.missingProcesses.Count -gt 0) { $failures.Add("missing runtime processes: $($result.missingProcesses -join ', ')") | Out-Null }
  if ($result.visionTopologyIssues.Count -gt 0) { $failures.Add("Vision process topology is invalid") | Out-Null }
  if ($result.unexpectedProcesses.Count -gt 0) { $failures.Add("runtime process path differs from the owner manifest") | Out-Null }
  if ($result.interactiveProcessOwnerIssues.Count -gt 0) { $failures.Add("interactive runtime process ownership is invalid: $($result.interactiveProcessOwnerIssues -join ', ')") | Out-Null }
  if (-not $result.daemon.readyFilePresent -or -not $result.daemon.readiness.ok) { $failures.Add("daemon readiness is unavailable") | Out-Null }
  if ($failures.Count -gt 0) { throw ($failures -join "; ") }
}
