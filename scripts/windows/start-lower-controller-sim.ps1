param(
  [string]$SimPort,
  [string]$DaemonPort,
  [string]$TcpListen,
  [string]$SimulatorExe = "C:\VEM\bringup\lower-controller-sim.exe",
  [string]$DaemonConfig = "C:\ProgramData\VEM\vending-daemon\machine-config.json",
  [string]$BringupConfig = "C:\VEM\bringup\machine-config.json",
  [string]$ServiceName = "VemVendingDaemon",
  [ValidateSet("normal", "pickup-timeout-success", "pickup-timeout-blocked", "mechanical-fault")]
  [string]$Scenario = "normal",
  [int]$HeartbeatMs = 500,
  [int]$DispenseToOutletMs = 1500,
  [int]$PickupCompleteMs = 2000,
  [int]$ResetMs = 1000,
  [int]$PickupWarning1Ms = 15000,
  [int]$PickupWarning2Ms = 25000,
  [int]$PickupFinalTimeoutMs = 30000,
  [switch]$Trace,
  [switch]$StdinControl,
  [switch]$Foreground,
  [switch]$StartSimulator,
  [switch]$RestartDaemon,
  [switch]$RestoreLatestBackup,
  [switch]$StopExistingSimulator,
  [switch]$SkipPortPresenceCheck
)

$ErrorActionPreference = "Stop"
trap {
  Write-Error $_
  exit 1
}

function Normalize-ComPort([string]$Port) {
  $trimmed = $Port.Trim().ToUpperInvariant()
  if ($trimmed -notmatch "^COM\d+$") {
    throw "serial port must look like COM9, got: $Port"
  }
  return $trimmed
}

function Get-AvailableComPorts {
  return @([System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { $_.ToUpperInvariant() } | Sort-Object)
}

function Read-JsonObject([string]$Path) {
  if (-not (Test-Path $Path)) {
    throw "config not found: $Path"
  }
  return [System.IO.File]::ReadAllText(
    $Path,
    [System.Text.Encoding]::UTF8
  ) | ConvertFrom-Json
}

function Set-JsonProperty($Object, [string]$Name, $Value) {
  if ($Object.PSObject.Properties.Name -contains $Name) {
    $Object.$Name = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

function Write-JsonObject([string]$Path, $Object) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $json = $Object | ConvertTo-Json -Depth 20
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Backup-File([string]$Path) {
  if (-not (Test-Path $Path)) {
    return $null
  }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backup = "$Path.bak-lower-controller-sim-$stamp"
  Copy-Item -Force -Path $Path -Destination $backup
  return $backup
}

function Restore-LatestBackup([string]$Path) {
  $latest = Get-ChildItem -Path "$Path.bak-lower-controller-sim-*" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $latest) {
    return $null
  }
  Copy-Item -Force -Path $latest.FullName -Destination $Path
  return [pscustomobject]@{ path = $Path; restoredFrom = $latest.FullName }
}

function Update-DaemonConfigForSerial([string]$Path, [string]$SerialPath) {
  $config = Read-JsonObject $Path
  $backup = Backup-File $Path
  Set-JsonProperty $config "hardwareAdapter" "serial"
  Set-JsonProperty $config "serialPortPath" $SerialPath
  Set-JsonProperty $config "lowerControllerUsbIdentity" $null
  Write-JsonObject $Path $config
  return [pscustomobject]@{ path = $Path; backup = $backup }
}

function Quote-CmdArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + ($Value -replace '"', '\"') + '"'
}

if ($RestoreLatestBackup) {
  $restored = @()
  $daemonRestored = Restore-LatestBackup $DaemonConfig
  if ($null -eq $daemonRestored) {
    throw "no lower-controller-sim backup found for $DaemonConfig"
  }
  $restored += $daemonRestored
  if (Test-Path $BringupConfig) {
    $bringupRestored = Restore-LatestBackup $BringupConfig
    if ($null -ne $bringupRestored) {
      $restored += $bringupRestored
    }
  }
  if ($StopExistingSimulator) {
    Get-Process lower-controller-sim -ErrorAction SilentlyContinue | Stop-Process -Force
  }
  if ($RestartDaemon) {
    Restart-Service -Name $ServiceName -Force
  }
  [pscustomobject]@{
    mode = "restore_latest_backup"
    restored = $restored
    stoppedExistingSimulator = [bool]$StopExistingSimulator
    restartDaemon = [bool]$RestartDaemon
  } | ConvertTo-Json -Depth 8
  return
}

$tcpMode = -not [string]::IsNullOrWhiteSpace($TcpListen)
if ($tcpMode) {
  if (-not [string]::IsNullOrWhiteSpace($SimPort) -or -not [string]::IsNullOrWhiteSpace($DaemonPort)) {
    throw "TcpListen cannot be combined with SimPort or DaemonPort"
  }
  $tcpListenNormalized = $TcpListen.Trim()
  if ($tcpListenNormalized -notmatch "^[^:]+:\d+$") {
    throw "TcpListen must look like 127.0.0.1:17991, got: $TcpListen"
  }
  $daemonSerialPath = "tcp://$tcpListenNormalized"
  $simPortNormalized = $null
  $daemonPortNormalized = $null
} else {
  if ([string]::IsNullOrWhiteSpace($SimPort) -or [string]::IsNullOrWhiteSpace($DaemonPort)) {
    throw "either provide TcpListen, or provide both SimPort and DaemonPort"
  }
  $simPortNormalized = Normalize-ComPort $SimPort
  $daemonPortNormalized = Normalize-ComPort $DaemonPort
  if ($simPortNormalized -eq $daemonPortNormalized) {
    throw "SimPort and DaemonPort must be different ports"
  }
  $daemonSerialPath = $daemonPortNormalized
}

if (-not (Test-Path $SimulatorExe)) {
  throw "simulator exe not found: $SimulatorExe"
}

$availablePorts = @()
if (-not $tcpMode) {
  $availablePorts = Get-AvailableComPorts
}
if (-not $tcpMode -and -not $SkipPortPresenceCheck) {
  $missing = @(@($simPortNormalized, $daemonPortNormalized) | Where-Object { $availablePorts -notcontains $_ })
  if ($missing.Count -gt 0) {
    throw "serial port(s) not present: $($missing -join ', '). Available ports: $($availablePorts -join ', ')"
  }
}

$updated = @()
$updated += Update-DaemonConfigForSerial $DaemonConfig $daemonSerialPath
if (Test-Path $BringupConfig) {
  $updated += Update-DaemonConfigForSerial $BringupConfig $daemonSerialPath
}

$simArgs = @(
  "--scenario", $Scenario,
  "--heartbeat-ms", "$HeartbeatMs",
  "--dispense-to-outlet-ms", "$DispenseToOutletMs",
  "--pickup-complete-ms", "$PickupCompleteMs",
  "--reset-ms", "$ResetMs",
  "--pickup-warning-1-ms", "$PickupWarning1Ms",
  "--pickup-warning-2-ms", "$PickupWarning2Ms",
  "--pickup-final-timeout-ms", "$PickupFinalTimeoutMs"
)
if ($tcpMode) {
  $simArgs = @("--tcp-listen", $tcpListenNormalized) + $simArgs
} else {
  $simArgs = @("--port", $simPortNormalized) + $simArgs
}
if ($Trace) { $simArgs += "--trace" }
if ($StdinControl) { $simArgs += "--stdin-control" }

$process = $null
$processId = $null
$ranForeground = $false
if ($StopExistingSimulator) {
  Get-Process lower-controller-sim -ErrorAction SilentlyContinue | Stop-Process -Force
}

if ($StartSimulator -and -not $Foreground) {
  $logDir = "C:\ProgramData\VEM\lower-controller-sim"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdout = Join-Path $logDir "lower-controller-sim-$stamp.out.log"
  $stderr = Join-Path $logDir "lower-controller-sim-$stamp.err.log"
  $quotedExe = '"' + $SimulatorExe + '"'
  $quotedArgs = @($simArgs | ForEach-Object { Quote-CmdArgument ([string]$_) }) -join " "
  $command = "$quotedExe $quotedArgs > `"$stdout`" 2> `"$stderr`""
  $commandLine = 'cmd.exe /c "' + $command + '"'
  $creation = Invoke-CimMethod `
    -ClassName Win32_Process `
    -MethodName Create `
    -Arguments @{ CommandLine = $commandLine; CurrentDirectory = (Split-Path -Parent $SimulatorExe) }
  if ([int]$creation.ReturnValue -ne 0) {
    throw "start lower-controller-sim failed via Win32_Process.Create: return=$($creation.ReturnValue)"
  }
  $processId = [int]$creation.ProcessId
  Start-Sleep -Milliseconds 500
  $process = Get-Process lower-controller-sim -ErrorAction SilentlyContinue | Select-Object -First 1
}

if ($RestartDaemon) {
  Restart-Service -Name $ServiceName -Force
}

if ($StartSimulator -and $Foreground) {
  $ranForeground = $true
  & $SimulatorExe @simArgs
}

[pscustomobject]@{
  mode = if ($tcpMode) { "tcp" } else { "serial_port_pair" }
  simPort = $simPortNormalized
  daemonPort = $daemonPortNormalized
  tcpListen = if ($tcpMode) { $tcpListenNormalized } else { $null }
  daemonSerialPath = $daemonSerialPath
  availablePorts = $availablePorts
  configUpdates = $updated
  simulatorStarted = $null -ne $process -or $ranForeground
  simulatorPid = if ($null -ne $process) { $process.Id } else { $processId }
  launcherPid = $processId
  stoppedExistingSimulator = [bool]$StopExistingSimulator
  restartDaemon = [bool]$RestartDaemon
  scenario = $Scenario
} | ConvertTo-Json -Depth 8
