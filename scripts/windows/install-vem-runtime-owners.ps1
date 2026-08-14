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
$script:OwnerDirectoryLeases = [Collections.Generic.List[object]]::new()

function Initialize-OwnerDirectoryLeaseApi {
  if ($env:OS -cne "Windows_NT" -or ("VemOwnerDirectoryLease" -as [type])) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class VemOwnerDirectoryLease {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, System.Text.StringBuilder path, uint length, uint flags);
  public static SafeFileHandle Open(string path) {
    var handle = CreateFileW(path, 0x80, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "failed to lease owner directory: " + path);
    return handle;
  }
  public static string FinalPath(SafeFileHandle handle) {
    var buffer = new System.Text.StringBuilder(32768);
    var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
    if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error(), "failed to resolve leased owner directory");
    var value = buffer.ToString();
    return value.StartsWith(@"\\?\") ? value.Substring(4) : value;
  }
}
'@
}

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

function Add-OwnerDirectoryLease([string]$Path, [string]$Label) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label contains a reparse or non-directory component: $Path"
  }
  if ($env:OS -ceq "Windows_NT") {
    Initialize-OwnerDirectoryLeaseApi
    $handle = [VemOwnerDirectoryLease]::Open($item.FullName)
    try {
      $finalPath = [IO.Path]::GetFullPath([VemOwnerDirectoryLease]::FinalPath($handle))
      if ($finalPath -ine [IO.Path]::GetFullPath($item.FullName)) {
        throw "$Label component resolved to a different final path: $Path"
      }
      $script:OwnerDirectoryLeases.Add([pscustomobject]@{ path = $finalPath; handle = $handle; label = $Label })
      $handle = $null
    } finally {
      if ($null -ne $handle) { $handle.Dispose() }
    }
  } else {
    $script:OwnerDirectoryLeases.Add([pscustomobject]@{
      path = [IO.Path]::GetFullPath($item.FullName)
      handle = $null
      label = $Label
      creationTimeUtc = $item.CreationTimeUtc.Ticks
      lastWriteTimeUtc = $item.LastWriteTimeUtc.Ticks
    })
  }
}

function Assert-OwnerDirectoryLeases {
  foreach ($lease in $script:OwnerDirectoryLeases) {
    $item = Get-Item -LiteralPath $lease.path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw "$($lease.label) directory identity changed: $($lease.path)"
    }
    if ($null -ne $lease.handle) {
      $finalPath = [IO.Path]::GetFullPath([VemOwnerDirectoryLease]::FinalPath($lease.handle))
      if ($finalPath -ine [IO.Path]::GetFullPath($item.FullName)) { throw "$($lease.label) directory identity changed: $($lease.path)" }
    } elseif ($lease.creationTimeUtc -ne $item.CreationTimeUtc.Ticks -or $lease.lastWriteTimeUtc -ne $item.LastWriteTimeUtc.Ticks) {
      throw "$($lease.label) directory identity changed: $($lease.path)"
    }
  }
}

function Close-OwnerDirectoryLeases {
  foreach ($lease in $script:OwnerDirectoryLeases) {
    if ($null -ne $lease.handle) { $lease.handle.Dispose() }
  }
  $script:OwnerDirectoryLeases.Clear()
}

trap {
  Close-OwnerDirectoryLeases
  throw $_
}

function Assert-OwnerChildPath([string]$Path, [string]$Parent, [string]$Label) {
  $normalizedPath = Get-NormalizedOwnerDirectory $Path $Label
  $normalizedParent = Get-NormalizedOwnerDirectory $Parent "$Label authority root"
  $prefix = $normalizedParent + [IO.Path]::DirectorySeparatorChar
  if (-not $normalizedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be contained by $normalizedParent"
  }
  $cursor = $normalizedParent
  Add-OwnerDirectoryLease $cursor $Label
  foreach ($component in $normalizedPath.Substring($prefix.Length).Split([IO.Path]::DirectorySeparatorChar)) {
    $cursor = Join-Path $cursor $component
    Add-OwnerDirectoryLease $cursor $Label
  }
  return $normalizedPath
}

function Assert-VisionAiModelPack([string]$ModelRoot, [string]$VisionRoot) {
  $normalizedRoot = Get-NormalizedOwnerDirectory $ModelRoot "Vision AI model pack root"
  Add-OwnerDirectoryLease $normalizedRoot "Vision AI model pack root"
  $descriptorPath = Join-Path $VisionAppDirectory "_internal\official-ai-model-pack-descriptor.json"
  Assert-OwnerPath $descriptorPath "bundled official AI model descriptor"
  $manifestPath = Join-Path $normalizedRoot "ai-model-manifest.json"
  Assert-OwnerPath $manifestPath "AI model manifest"
  $descriptorBytes = [IO.File]::ReadAllBytes($descriptorPath)
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  $manifestMatchesDescriptor = $descriptorBytes.Length -eq $manifestBytes.Length -or
    ($descriptorBytes.Length -eq $manifestBytes.Length + 1 -and $descriptorBytes[$descriptorBytes.Length - 1] -eq 10)
  for ($index = 0; $manifestMatchesDescriptor -and $index -lt $manifestBytes.Length; $index += 1) {
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
foreach (`$name in @("VEM_AI_MODEL_PACK", "VEM_AI_ACCEPTANCE_EVIDENCE_ROOT")) {
  Remove-Item -LiteralPath "Env:`$name" -ErrorAction SilentlyContinue
  [void]`$startInfo.EnvironmentVariables.Remove(`$name)
}
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

Assert-NoDuplicateRuntimeProcesses
Assert-OwnerDirectoryLeases

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

Assert-OwnerDirectoryLeases
Grant-OwnerAccess $RuntimeDirectory "(RX)"
Grant-OwnerAccess $DaemonDataDirectory "(M)"
Grant-OwnerAccess $VisionAppDirectory "(RX)"
Grant-OwnerAccess $VisionDataDirectory "(M)"
if ($null -ne $script:VisionAiOwner) {
  Grant-OwnerAccess $script:VisionAiOwner.acceptanceEvidenceRoot "(M)"
}

Assert-OwnerDirectoryLeases
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
Assert-OwnerDirectoryLeases
Register-InteractiveOwnerTask "VEMMachineUI" $machineLauncher $RuntimeDirectory
Register-InteractiveOwnerTask "VEMVisionRuntime" $visionLauncher $VisionAppDirectory

Assert-OwnerDirectoryLeases
$ownerManifest = Write-OwnerManifest $daemonExecutable $machineExecutable $visionExecutable $machineLauncher $visionLauncher
Assert-OwnerDirectoryLeases
Close-OwnerDirectoryLeases
$ownerManifest | ConvertTo-Json -Depth 12
