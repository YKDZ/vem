[CmdletBinding()]
param(
  [string]$RuntimeDirectory = "C:\VEM\bringup",
  [string]$DaemonDataDirectory = "C:\ProgramData\VEM\vending-daemon",
  [string]$VisionAppDirectory = "C:\VEM\vision\app",
  [string]$VisionDataDirectory = "C:\ProgramData\VEM\vision",
  [string]$VisionAiModelPackRoot,
  [string]$VisionAiAcceptanceEvidenceRoot,
  [string]$KioskUser = "VEMKiosk",
  [string]$KioskPassword,
  [ValidateRange(1, 65535)][int]$MachineUiWebViewDebugPort = 0,
  [string]$OwnerManifestPath = "C:\ProgramData\VEM\runtime-owners\owner-manifest.json"
)

$ErrorActionPreference = "Stop"

function Assert-OwnerPath([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
}

function Get-NormalizedOwnerDirectory([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
    throw "$Label must be an absolute directory: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label must be a regular non-reparse directory: $Path"
  }
  return [IO.Path]::GetFullPath($item.FullName).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-OwnerChildPath([string]$Path, [string]$Parent, [string]$Label) {
  $normalizedPath = Get-NormalizedOwnerDirectory $Path $Label
  $normalizedParent = Get-NormalizedOwnerDirectory $Parent "$Label authority root"
  $prefix = $normalizedParent + [IO.Path]::DirectorySeparatorChar
  if (-not $normalizedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be contained by $normalizedParent"
  }
  return $normalizedPath
}

function Assert-VisionAiModelPack([string]$ModelRoot, [string]$VisionRoot) {
  $normalizedRoot = Assert-OwnerChildPath $ModelRoot (Join-Path $VisionRoot "ai-model-packs\packs") "Vision AI model pack root"
  $descriptorPath = Join-Path $VisionAppDirectory "_internal\official-ai-model-pack-descriptor.json"
  Assert-OwnerPath $descriptorPath "bundled official AI model descriptor"
  $manifestPath = Join-Path $normalizedRoot "ai-model-manifest.json"
  Assert-OwnerPath $manifestPath "AI model manifest"
  $descriptorBytes = [IO.File]::ReadAllBytes($descriptorPath)
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  $manifestMatchesDescriptor = $descriptorBytes.Length -eq $manifestBytes.Length
  for ($index = 0; $manifestMatchesDescriptor -and $index -lt $descriptorBytes.Length; $index += 1) {
    if ($descriptorBytes[$index] -ne $manifestBytes[$index]) { $manifestMatchesDescriptor = $false }
  }
  if (-not $manifestMatchesDescriptor) {
    throw "AI model manifest does not match the bundled official descriptor"
  }
  try {
    $descriptor = [Text.Encoding]::UTF8.GetString($descriptorBytes) | ConvertFrom-Json
  } catch {
    throw "bundled official AI model descriptor is not valid JSON: $($_.Exception.Message)"
  }
  if ($descriptor.schemaVersion -ne "vem-official-ai-model-pack-descriptor/v2" -or
      $descriptor.totalByteSize -isnot [long] -or $descriptor.totalByteSize -lt 1 -or
      @($descriptor.files).Count -lt 1) {
    throw "bundled official AI model descriptor has an unsupported identity"
  }
  $expectedPaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $totalBytes = [long]0
  foreach ($file in @($descriptor.files)) {
    $relativePath = [string]$file.path
    if ([string]::IsNullOrWhiteSpace($relativePath) -or [IO.Path]::IsPathRooted($relativePath) -or
        $relativePath.Contains("\") -or $relativePath.Contains(":") -or
        @($relativePath.Split("/") | Where-Object { $_ -eq "" -or $_ -eq "." -or $_ -eq ".." }).Count -gt 0 -or
        -not $expectedPaths.Add($relativePath)) {
      throw "bundled official AI model descriptor contains an unsafe or duplicate path"
    }
    $candidatePath = Join-Path $normalizedRoot ($relativePath.Replace("/", [IO.Path]::DirectorySeparatorChar))
    $candidate = Get-Item -LiteralPath $candidatePath -Force -ErrorAction Stop
    if ($candidate.PSIsContainer -or (($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw "AI model file must be regular and non-reparse: $relativePath"
    }
    $expectedSize = [long]$file.byteSize
    if ($expectedSize -lt 1 -or [long]$candidate.Length -ne $expectedSize) {
      throw "AI model file size mismatch: $relativePath"
    }
    $expectedSha = [string]$file.sha256
    if ($expectedSha -cnotmatch '^[0-9a-f]{64}$' -or
        (Get-FileHash -LiteralPath $candidate.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedSha) {
      throw "AI model file digest mismatch: $relativePath"
    }
    $totalBytes += $expectedSize
  }
  if ($totalBytes -ne [long]$descriptor.totalByteSize) {
    throw "AI model descriptor totalByteSize mismatch"
  }
  $modelEntries = @(Get-ChildItem -LiteralPath $normalizedRoot -Recurse -Force)
  if (@($modelEntries | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) {
    throw "AI model pack contains a reparse entry"
  }
  $actualRelativePaths = @($modelEntries | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
    $_.FullName.Substring($normalizedRoot.Length + 1).Replace("\", "/")
  } | Where-Object { $_ -ne "ai-model-manifest.json" } | Sort-Object)
  $expectedRelativePaths = @($expectedPaths | Sort-Object)
  if (($actualRelativePaths -join "`n") -cne ($expectedRelativePaths -join "`n")) {
    throw "AI model pack file set does not match the bundled official descriptor"
  }
  return $normalizedRoot
}

function Resolve-VisionAiOwnerEnvironment {
  $hasModel = -not [string]::IsNullOrWhiteSpace($VisionAiModelPackRoot)
  $hasSink = -not [string]::IsNullOrWhiteSpace($VisionAiAcceptanceEvidenceRoot)
  if ($hasModel -ne $hasSink) {
    throw "VisionAiModelPackRoot and VisionAiAcceptanceEvidenceRoot must be provided together"
  }
  if (-not $hasModel) { return $null }
  $modelRoot = Assert-VisionAiModelPack $VisionAiModelPackRoot $VisionDataDirectory
  $sinkAuthority = Join-Path $VisionDataDirectory "acceptance"
  $sinkRoot = Assert-OwnerChildPath $VisionAiAcceptanceEvidenceRoot $sinkAuthority "Vision AI acceptance evidence root"
  if (@(Get-ChildItem -LiteralPath $sinkRoot -Force).Count -ne 0) {
    throw "Vision AI acceptance evidence root must be empty"
  }
  return [ordered]@{ modelPackRoot = $modelRoot; acceptanceEvidenceRoot = $sinkRoot }
}

function Invoke-Sc([string[]]$Arguments, [string]$Operation) {
  $output = & sc.exe @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "failed to $Operation ($LASTEXITCODE): $($output -join "`n")"
  }
}

function Grant-OwnerAccess([string]$Path, [string]$Rights) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  & icacls.exe $Path /grant:r "${KioskUser}:(OI)(CI)$Rights" /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "failed to grant $KioskUser access: $Path" }
}

function Protect-VisionAiModelPack([string]$Path) {
  & icacls.exe $Path `
    /inheritance:r `
    /grant:r "*S-1-5-18:(OI)(CI)F" `
    /grant:r "*S-1-5-32-544:(OI)(CI)F" `
    /grant:r "${KioskUser}:(OI)(CI)(RX)" `
    /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "failed to protect the verified Vision AI model pack: $Path" }
}

function Write-InteractiveLauncher(
  [string]$LauncherPath,
  [string]$ProcessName,
  [string]$ExecutablePath,
  [string[]]$ArgumentList,
  [string[]]$InheritedEnvironmentVariableNames = @(),
  [hashtable]$ExplicitEnvironmentVariables = @{}
) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LauncherPath) | Out-Null
  $argumentString = ($ArgumentList | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join " "
  $argumentStringLiteral = "'" + $argumentString.Replace("'", "''") + "'"
  $environmentNamesLiteral = if ($InheritedEnvironmentVariableNames.Count -eq 0) {
    "@()"
  } else {
    "@(" + (($InheritedEnvironmentVariableNames | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ", ") + ")"
  }
  $explicitEnvironmentLiteral = if ($ExplicitEnvironmentVariables.Count -eq 0) {
    "@{}"
  } else {
    "@{" + (($ExplicitEnvironmentVariables.GetEnumerator() | Sort-Object Name | ForEach-Object {
      "'" + ([string]$_.Key).Replace("'", "''") + "' = '" + ([string]$_.Value).Replace("'", "''") + "'"
    }) -join "; ") + "}"
  }
  $content = @"
`$ErrorActionPreference = "Stop"
`$startInfo = [Diagnostics.ProcessStartInfo]::new()
`$startInfo.FileName = '$ExecutablePath'
`$startInfo.WorkingDirectory = '$(Split-Path -Parent $ExecutablePath)'
`$startInfo.UseShellExecute = `$false
`$startInfo.Arguments = $argumentStringLiteral
foreach (`$name in $environmentNamesLiteral) {
  `$userValue = [Environment]::GetEnvironmentVariable(`$name, "User")
  `$machineValue = [Environment]::GetEnvironmentVariable(`$name, "Machine")
  `$value = if (-not [string]::IsNullOrWhiteSpace(`$userValue)) { `$userValue } else { `$machineValue }
	  if (-not [string]::IsNullOrWhiteSpace(`$value)) {
	    Set-Item -LiteralPath "Env:`$name" -Value `$value
	    `$startInfo.EnvironmentVariables[`$name] = `$value
	  }
	}
`$explicitEnvironment = $explicitEnvironmentLiteral
foreach (`$entry in `$explicitEnvironment.GetEnumerator()) {
  `$value = [string]`$entry.Value
  if (-not [string]::IsNullOrWhiteSpace(`$value)) {
    Set-Item -LiteralPath "Env:`$(`$entry.Key)" -Value `$value
    `$startInfo.EnvironmentVariables[[string]`$entry.Key] = `$value
  }
}
`$staleProcesses = @(Get-CimInstance Win32_Process -Filter "Name = '$ProcessName'" -ErrorAction SilentlyContinue)
foreach (`$staleProcess in `$staleProcesses) {
  Stop-Process -Id ([int]`$staleProcess.ProcessId) -Force -ErrorAction SilentlyContinue
}
[Diagnostics.Process]::Start(`$startInfo) | Out-Null
"@
  $temporaryLauncher = "$LauncherPath.$PID.tmp"
  $backupLauncher = "$LauncherPath.$PID.backup"
  try {
    [IO.File]::WriteAllText($temporaryLauncher, $content, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $LauncherPath -PathType Leaf) {
      [IO.File]::Replace($temporaryLauncher, $LauncherPath, $backupLauncher, $true)
      Remove-Item -LiteralPath $backupLauncher -Force -ErrorAction Stop
    } else {
      Move-Item -LiteralPath $temporaryLauncher -Destination $LauncherPath -ErrorAction Stop
    }
  } finally {
    Remove-Item -LiteralPath $temporaryLauncher -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupLauncher -Force -ErrorAction SilentlyContinue
  }
}

function Register-InteractiveOwnerTask(
  [string]$TaskName,
  [string]$LauncherPath,
  [string]$WorkingDirectory
) {
  $action = New-ScheduledTaskAction `
    -Execute "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$LauncherPath`"" `
    -WorkingDirectory $WorkingDirectory
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $KioskUser
  $principal = New-ScheduledTaskPrincipal -UserId $KioskUser -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances Parallel `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "VEM installed runtime owner: $TaskName" `
    -Force | Out-Null
}

function Test-RuntimeExecutableReference([string]$Text, [string[]]$ExpectedPaths) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  if (@($ExpectedPaths | Where-Object { $Text -match [regex]::Escape($_) }).Count -gt 0) {
    return $true
  }
  return $Text -match '(?i)(^|[\\/"''\s])(?:machine|vending-vision|vending-daemon)\.exe\b'
}

function Get-CompetingOwners(
  [string]$DaemonExecutable,
  [string]$MachineExecutable,
  [string]$VisionExecutable
) {
  $expectedTasks = @("VEMMachineUI", "VEMVisionRuntime")
  $expectedPaths = @($DaemonExecutable, $MachineExecutable, $VisionExecutable)
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
    if ([string]$service.Name -eq "VemVendingDaemon") { continue }
    if (Test-RuntimeExecutableReference ([string]$service.PathName) $expectedPaths) {
      $conflicts.Add("service $($service.Name)") | Out-Null
    }
  }

  return @($conflicts | Select-Object -Unique)
}

function Assert-NoDuplicateRuntimeProcesses {
  foreach ($processName in @("vending-daemon.exe", "machine.exe", "vending-vision.exe")) {
    $instances = @(Get-CimInstance Win32_Process -Filter "Name = '$processName'" -ErrorAction SilentlyContinue)
    if ($instances.Count -gt 1) {
      throw "duplicate runtime process detected: $processName ($($instances.Count))"
    }
  }
}

function Write-OwnerManifest(
  [string]$DaemonExecutable,
  [string]$MachineExecutable,
  [string]$VisionExecutable,
  [string]$MachineLauncher,
  [string]$VisionLauncher
) {
  $visionOwner = [ordered]@{
    kind = "scheduledTask"
    name = "VEMVisionRuntime"
    taskPath = "\"
    trigger = "AtLogon"
    user = $KioskUser
    executablePath = $VisionExecutable
    arguments = @("--config", (Join-Path $VisionDataDirectory "site.json"))
    launcherPath = $VisionLauncher
    workingDirectory = $VisionAppDirectory
  }
  if ($null -ne $script:VisionAiOwner) {
    $visionOwner["ai"] = $script:VisionAiOwner
  }
  $acl = [Collections.Generic.List[object]]::new()
  @(
    [ordered]@{ path = $RuntimeDirectory; user = $KioskUser; rights = "RX" },
    [ordered]@{ path = $DaemonDataDirectory; user = $KioskUser; rights = "M" },
    [ordered]@{ path = $VisionAppDirectory; user = $KioskUser; rights = "RX" },
    [ordered]@{ path = $VisionDataDirectory; user = $KioskUser; rights = "M" }
  ) | ForEach-Object { $acl.Add($_) }
  if ($null -ne $script:VisionAiOwner) {
    $acl.Add([ordered]@{ path = $script:VisionAiOwner.modelPackRoot; user = $KioskUser; rights = "RX" })
    $acl.Add([ordered]@{ path = $script:VisionAiOwner.acceptanceEvidenceRoot; user = $KioskUser; rights = "M" })
  }
  $manifest = [ordered]@{
    schemaVersion = "vem-runtime-owners/v1"
    installedAt = [DateTime]::UtcNow.ToString("o")
    kiosk = [ordered]@{
      user = $KioskUser
      autoAdminLogon = [ordered]@{
        registryPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
        userName = $KioskUser
        domainName = "."
      }
    }
    owners = [ordered]@{
      daemon = [ordered]@{
        kind = "service"
        name = "VemVendingDaemon"
        account = "LocalSystem"
        startType = "Automatic"
        executablePath = $DaemonExecutable
        arguments = @("--data-dir", $DaemonDataDirectory)
        crashRecovery = [ordered]@{ firstFailure = "restart"; delayMilliseconds = 5000 }
      }
      machineUi = [ordered]@{
        kind = "scheduledTask"
        name = "VEMMachineUI"
        taskPath = "\"
        trigger = "AtLogon"
        user = $KioskUser
        executablePath = $MachineExecutable
        launcherPath = $MachineLauncher
        workingDirectory = $RuntimeDirectory
      }
      vision = $visionOwner
    }
    acl = @($acl)
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OwnerManifestPath) | Out-Null
  $temporaryPath = "$OwnerManifestPath.$PID.tmp"
  try {
    [IO.File]::WriteAllText($temporaryPath, ($manifest | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $OwnerManifestPath -Force
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
  return $manifest
}

$daemonExecutable = Join-Path $RuntimeDirectory "vending-daemon.exe"
$machineExecutable = Join-Path $RuntimeDirectory "machine.exe"
$visionExecutable = Join-Path $VisionAppDirectory "vending-vision.exe"
$machineLauncher = Join-Path $RuntimeDirectory "launch-vem-machine-ui.ps1"
$visionLauncher = Join-Path $RuntimeDirectory "launch-vem-vision.ps1"

Assert-OwnerPath $daemonExecutable "daemon executable"
Assert-OwnerPath $machineExecutable "Machine UI executable"
Assert-OwnerPath $visionExecutable "Vision executable"
$script:VisionAiOwner = Resolve-VisionAiOwnerEnvironment
if ($null -eq (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue)) {
  throw "required interactive user is missing: $KioskUser"
}
if ([string]::IsNullOrWhiteSpace($KioskPassword)) {
  throw "KioskPassword is required to configure VEMKiosk automatic logon"
}

$conflicts = @(Get-CompetingOwners $daemonExecutable $machineExecutable $visionExecutable)
if ($conflicts.Count -gt 0) {
  throw "competing runtime owners detected; remove them manually before installing: $($conflicts -join ', ')"
}
Assert-NoDuplicateRuntimeProcesses

$daemonArguments = "`"$daemonExecutable`" --data-dir `"$DaemonDataDirectory`""
$daemonService = Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
if ($null -eq $daemonService) {
  New-Service -Name "VemVendingDaemon" -BinaryPathName $daemonArguments -DisplayName "VEM Vending Daemon" -StartupType Automatic | Out-Null
} else {
  Invoke-Sc @("config", "VemVendingDaemon", "binPath=", $daemonArguments) "update daemon service binary path"
}
Invoke-Sc @("config", "VemVendingDaemon", "obj=", "LocalSystem", "start=", "auto") "configure daemon service account and startup"
Set-Service -Name "VemVendingDaemon" -StartupType Automatic
Invoke-Sc @("failure", "VemVendingDaemon", "reset=", "86400", "actions=", 'restart/5000/""/0/""/0') "configure daemon crash recovery"
Invoke-Sc @("failureflag", "VemVendingDaemon", "1") "enable daemon crash recovery"

$winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-ItemProperty -Path $winlogon -Name "DefaultUserName" -Value $KioskUser
Set-ItemProperty -Path $winlogon -Name "DefaultDomainName" -Value "."
Set-ItemProperty -Path $winlogon -Name "DefaultPassword" -Value $KioskPassword
Set-ItemProperty -Path $winlogon -Name "AutoAdminLogon" -Value "1"
Remove-ItemProperty -Path $winlogon -Name "AutoLogonCount" -ErrorAction SilentlyContinue

Grant-OwnerAccess $RuntimeDirectory "(RX)"
Grant-OwnerAccess $DaemonDataDirectory "(M)"
Grant-OwnerAccess $VisionAppDirectory "(RX)"
Grant-OwnerAccess $VisionDataDirectory "(M)"
if ($null -ne $script:VisionAiOwner) {
  Protect-VisionAiModelPack $script:VisionAiOwner.modelPackRoot
  Grant-OwnerAccess $script:VisionAiOwner.acceptanceEvidenceRoot "(M)"
}

$machineUiEnvironment = @{}
if ($MachineUiWebViewDebugPort -gt 0) {
  $machineUiEnvironment["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=$MachineUiWebViewDebugPort"
}
Write-InteractiveLauncher $machineLauncher "machine.exe" $machineExecutable @() @() $machineUiEnvironment
$visionEnvironment = @{}
if ($null -ne $script:VisionAiOwner) {
  $visionEnvironment["VEM_AI_MODEL_PACK"] = $script:VisionAiOwner.modelPackRoot
  $visionEnvironment["VEM_AI_ACCEPTANCE_EVIDENCE_ROOT"] = $script:VisionAiOwner.acceptanceEvidenceRoot
}
Write-InteractiveLauncher $visionLauncher "vending-vision.exe" $visionExecutable @("--config", (Join-Path $VisionDataDirectory "site.json")) @() $visionEnvironment
Register-InteractiveOwnerTask "VEMMachineUI" $machineLauncher $RuntimeDirectory
Register-InteractiveOwnerTask "VEMVisionRuntime" $visionLauncher $VisionAppDirectory

Write-OwnerManifest $daemonExecutable $machineExecutable $visionExecutable $machineLauncher $visionLauncher | ConvertTo-Json -Depth 12
