[CmdletBinding()]
param(
  [string]$RuntimeDirectory = "C:\VEM\bringup",
  [string]$DaemonDataDirectory = "C:\ProgramData\VEM\vending-daemon",
  [string]$VisionAppDirectory = "C:\VEM\vision\app",
  [string]$VisionDataDirectory = "C:\ProgramData\VEM\vision",
  [string]$KioskUser = "VEMKiosk",
  [string]$KioskPassword,
  [string]$OwnerManifestPath = "C:\ProgramData\VEM\runtime-owners\owner-manifest.json"
)

$ErrorActionPreference = "Stop"

function Assert-OwnerPath([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
}

function Invoke-Sc([string[]]$Arguments, [string]$Operation) {
  & sc.exe @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "failed to $Operation" }
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
  [string[]]$ArgumentList
) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LauncherPath) | Out-Null
  $argumentsLiteral = if ($ArgumentList.Count -eq 0) {
    "@()"
  } else {
    "@(" + (($ArgumentList | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ", ") + ")"
  }
  $content = @"
`$ErrorActionPreference = "Stop"
`$staleProcesses = @(Get-CimInstance Win32_Process -Filter "Name = '$ProcessName'" -ErrorAction SilentlyContinue)
foreach (`$staleProcess in `$staleProcesses) {
  Stop-Process -Id ([int]`$staleProcess.ProcessId) -Force -ErrorAction SilentlyContinue
}
Start-Process -FilePath '$ExecutablePath' -WorkingDirectory '$(Split-Path -Parent $ExecutablePath)' -ArgumentList $argumentsLiteral
"@
  [IO.File]::WriteAllText($LauncherPath, $content, [Text.UTF8Encoding]::new($false))
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
    -MultipleInstances IgnoreNew `
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
        arguments = @("--console", "--data-dir", $DaemonDataDirectory)
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
      vision = [ordered]@{
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
    }
    acl = @(
      [ordered]@{ path = $RuntimeDirectory; user = $KioskUser; rights = "RX" },
      [ordered]@{ path = $DaemonDataDirectory; user = $KioskUser; rights = "M" },
      [ordered]@{ path = $VisionAppDirectory; user = $KioskUser; rights = "RX" },
      [ordered]@{ path = $VisionDataDirectory; user = $KioskUser; rights = "M" }
    )
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

$daemonArguments = "`"$daemonExecutable`" --console --data-dir `"$DaemonDataDirectory`""
$daemonService = Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
if ($null -eq $daemonService) {
  New-Service -Name "VemVendingDaemon" -BinaryPathName $daemonArguments -DisplayName "VEM Vending Daemon" -StartupType Automatic | Out-Null
} else {
  Invoke-Sc @("config", "VemVendingDaemon", "binPath= $daemonArguments") "update daemon service binary path"
}
Invoke-Sc @("config", "VemVendingDaemon", "obj= LocalSystem", "start= auto") "configure daemon service account and startup"
Set-Service -Name "VemVendingDaemon" -StartupType Automatic
Invoke-Sc @("failure", "VemVendingDaemon", "reset= 86400", 'actions= restart/5000/""/0/""/0') "configure daemon crash recovery"
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

Write-InteractiveLauncher $machineLauncher "machine.exe" $machineExecutable @()
Write-InteractiveLauncher $visionLauncher "vending-vision.exe" $visionExecutable @("--config", (Join-Path $VisionDataDirectory "site.json"))
Register-InteractiveOwnerTask "VEMMachineUI" $machineLauncher $RuntimeDirectory
Register-InteractiveOwnerTask "VEMVisionRuntime" $visionLauncher $VisionAppDirectory

Write-OwnerManifest $daemonExecutable $machineExecutable $visionExecutable $machineLauncher $visionLauncher | ConvertTo-Json -Depth 12
