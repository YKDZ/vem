[CmdletBinding()]
param(
  [int] $ExpectedWidth = 1080,
  [int] $ExpectedHeight = 1920,
  [int] $ExpectedScalePercent = 100,
  [Parameter(Mandatory = $true)] [string] $ExpectedInteractiveUser,
  [Parameter(Mandatory = $true)] [string] $ExpectedRunnerUrl,
  [Parameter(Mandatory = $true)] [string] $ExpectedRunnerName,
  [Parameter(Mandatory = $true)] [string[]] $ExpectedRunnerLabels,
  [Parameter(Mandatory = $true)] [string] $ExpectedRunnerServiceName,
  [Parameter(Mandatory = $true)] [ValidatePattern("^[0-9a-f]{64}$")] [string] $ExpectedVirtioGpuDriverPackageSha256,
  [Parameter(Mandatory = $true)] [ValidateSet("ich9")] [string] $ExpectedAudioModel,
  [Parameter(Mandatory = $true)] [string[]] $ExpectedSerialRole,
  [Parameter(Mandatory = $true)] [int[]] $ExpectedSerialUsbPort,
  [string] $OutputPath = "C:\ProgramData\WindowsRuntimeBaseline\verification.json"
)

$ErrorActionPreference = "Stop"
$baselineRoot = "C:\ProgramData\WindowsRuntimeBaseline"
$toolchainRoot = "C:\ProgramData\VEM\Toolchains"
$cacheRoot = "D:\runtime-cache\v1"
$nodeVersion = "24.16.0"
$pnpmVersion = "11.9.0"
$turboVersion = "2.10.0"
$rustNamespace = "rust-1.96.0"
$pnpmNamespace = "pnpm-11.9.0"
$turboNamespace = "turbo-2.10.0"
$nodeNamespace = "node-24.16.0"
$interactiveDisplayReportPath = Join-Path $baselineRoot "interactive-display-report.json"
$runnerRegistrationPath = Join-Path $baselineRoot "runner-registration.json"
$virtioGpuDriverBindingPath = Join-Path $baselineRoot "virtio-gpu-driver-binding.json"
$virtioGpuDriverRoot = Join-Path $baselineRoot "media\virtio-gpu-driver"
$virtioGpuDriverIdentityPath = Join-Path $baselineRoot "media\virtio-gpu-driver-identity.json"
if (-not (Test-Path -LiteralPath $interactiveDisplayReportPath)) { throw "interactive autologon display report is unavailable" }
$interactiveDisplay = Get-Content -Raw -LiteralPath $interactiveDisplayReportPath | ConvertFrom-Json
if ($interactiveDisplay.schemaVersion -ne "win10-kvm-interactive-display/v1") { throw "interactive display report schema is invalid" }
if ($interactiveDisplay.interactiveUser -notmatch ("\\" + [regex]::Escape($ExpectedInteractiveUser) + "$")) { throw "interactive display report belongs to an unexpected user" }
$interactiveSessionId = 0
if (-not [int]::TryParse([string]$interactiveDisplay.interactiveSessionId, [ref]$interactiveSessionId) -or $interactiveSessionId -lt 1) { throw "interactive display report has an invalid session binding" }
if ($ExpectedSerialRole.Count -ne 2 -or $ExpectedSerialUsbPort.Count -ne $ExpectedSerialRole.Count -or @($ExpectedSerialRole | Select-Object -Unique).Count -ne $ExpectedSerialRole.Count -or @($ExpectedSerialUsbPort | Select-Object -Unique).Count -ne $ExpectedSerialUsbPort.Count) {
  throw "the verifier requires exactly two unique serial roles with matching QEMU USB ports"
}
if ($ExpectedSerialRole[0] -cne "lower-controller" -or $ExpectedSerialRole[1] -cne "scanner" -or $ExpectedSerialUsbPort[0] -ne 1 -or $ExpectedSerialUsbPort[1] -ne 2) {
  throw "the verifier requires lower-controller and scanner USB port roles in profile order"
}
if (-not (Test-Path -LiteralPath $runnerRegistrationPath -PathType Leaf)) { throw "runner registration evidence is unavailable" }
$runnerRegistration = Get-Content -Raw -LiteralPath $runnerRegistrationPath | ConvertFrom-Json
if ($runnerRegistration.schemaVersion -ne "win10-kvm-runner-registration/v1") { throw "runner registration evidence schema is invalid" }
$runnerConfigurationPath = "C:\actions-runner\.runner"
if (-not (Test-Path -LiteralPath $runnerConfigurationPath -PathType Leaf)) { throw "actions runner configuration is unavailable" }
$runnerConfiguration = Get-Content -Raw -LiteralPath $runnerConfigurationPath | ConvertFrom-Json
$runnerConfigurationUrl = [string]$runnerConfiguration.gitHubUrl
if ([string]::IsNullOrWhiteSpace($runnerConfigurationUrl)) { $runnerConfigurationUrl = [string]$runnerConfiguration.serverUrl }
$runnerService = Get-Service -Name $ExpectedRunnerServiceName -ErrorAction SilentlyContinue
$registeredRunnerLabels = @($runnerRegistration.runnerLabels | ForEach-Object { [string]$_ })
$expectedRunnerLabels = @($ExpectedRunnerLabels | ForEach-Object { [string]$_ })
$runnerLabelsMatch = $registeredRunnerLabels.Count -eq $expectedRunnerLabels.Count
if ($runnerLabelsMatch) {
  for ($index = 0; $index -lt $expectedRunnerLabels.Count; $index += 1) {
    if ($registeredRunnerLabels[$index] -cne $expectedRunnerLabels[$index]) {
      $runnerLabelsMatch = $false
      break
    }
  }
}

function Get-Sha256 {
  param([string] $Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Get-VerifiedVirtioGpuDriverBinding {
  if (-not (Test-Path -LiteralPath $virtioGpuDriverBindingPath -PathType Leaf)) { throw "VirtIO GPU driver binding evidence is unavailable" }
  $binding = Get-Content -Raw -LiteralPath $virtioGpuDriverBindingPath | ConvertFrom-Json
  if ($binding.schemaVersion -ne "win10-kvm-virtio-gpu-driver-binding/v1" -or [string]$binding.packageSha256 -cne $ExpectedVirtioGpuDriverPackageSha256) {
    throw "VirtIO GPU driver binding package identity does not match the published payload"
  }
  if (-not (Test-Path -LiteralPath $virtioGpuDriverIdentityPath -PathType Leaf)) { throw "VirtIO GPU driver package identity is unavailable" }
  $packageIdentity = Get-Content -Raw -LiteralPath $virtioGpuDriverIdentityPath | ConvertFrom-Json
  if ($packageIdentity.schemaVersion -ne "win10-kvm-virtio-gpu-driver-package/v2" -or [string]$packageIdentity.packageSha256 -cne $ExpectedVirtioGpuDriverPackageSha256) {
    throw "VirtIO GPU driver package identity does not match the published payload"
  }
  $files = @($packageIdentity.files | Sort-Object path)
  if ($files.Count -lt 3 -or @($files.path | Select-Object -Unique).Count -ne $files.Count) { throw "VirtIO GPU driver package file identity is invalid" }
  $identityText = New-Object Text.StringBuilder
  foreach ($file in $files) {
    if ([string]$file.path -notmatch "^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$" -or [string]$file.sha256 -notmatch "^[0-9a-f]{64}$") { throw "VirtIO GPU driver binding file identity is invalid" }
    $mediaPath = Join-Path $virtioGpuDriverRoot ([string]$file.path).Replace("/", "\")
    if (-not (Test-Path -LiteralPath $mediaPath -PathType Leaf) -or (Get-Sha256 -Path $mediaPath) -cne [string]$file.sha256) {
      throw "VirtIO GPU driver media no longer matches the published package identity"
    }
    [void]$identityText.Append([string]$file.path).Append([char]0).Append([string]$file.sha256).Append("`n")
  }
  foreach ($catalog in @(Get-ChildItem -LiteralPath $virtioGpuDriverRoot -Recurse -File -Filter "*.cat" -ErrorAction Stop)) {
    if ((Get-AuthenticodeSignature -LiteralPath $catalog.FullName).Status -ne "Valid") { throw "VirtIO GPU driver catalog signature is no longer valid" }
  }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $packageHash = -join ($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($identityText.ToString())) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha256.Dispose()
  }
  if ($packageHash -cne $ExpectedVirtioGpuDriverPackageSha256) { throw "VirtIO GPU driver binding aggregate identity is invalid" }

  $driverStoreFiles = @($packageIdentity.driverStoreFiles | Sort-Object path)
  $bindingFiles = @($binding.files | Sort-Object path)
  if ($driverStoreFiles.Count -lt 3 -or $bindingFiles.Count -ne $driverStoreFiles.Count) { throw "VirtIO GPU DriverStore binding identity is invalid" }
  for ($index = 0; $index -lt $driverStoreFiles.Count; $index += 1) {
    if ([string]$driverStoreFiles[$index].path -cne [string]$bindingFiles[$index].path -or [string]$driverStoreFiles[$index].sha256 -cne [string]$bindingFiles[$index].sha256) {
      throw "VirtIO GPU DriverStore binding is not part of the published package"
    }
  }

  $adapter = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq "OK" -and $_.ConfigManagerErrorCode -eq 0 -and $_.PNPDeviceID -ceq [string]$binding.pnpDeviceId } |
    Select-Object -First 1
  if ($null -eq $adapter) { throw "the exact VirtIO GPU PnP device is not healthy and active" }
  $signedDriver = Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue |
    Where-Object {
      $_.DeviceID -ceq [string]$binding.pnpDeviceId -and
      $_.IsSigned -eq $true -and
      $_.InfName -ceq [string]$binding.infName -and
      $_.DriverProviderName -ceq [string]$binding.provider -and
      $_.DriverVersion -ceq [string]$binding.version -and
      $_.Signer -ceq [string]$binding.signer
    } |
    Select-Object -First 1
  if ($null -eq $signedDriver) { throw "the bound VirtIO GPU signed-driver identity changed after preparation" }
  $driverPackage = Get-WindowsDriver -Online -Driver $signedDriver.InfName -ErrorAction Stop
  $driverStoreRoot = Split-Path -Parent ([string]$driverPackage.OriginalFileName)
  foreach ($file in $driverStoreFiles) {
    $storePath = Join-Path $driverStoreRoot ([string]$file.path).Replace("/", "\")
    if (-not (Test-Path -LiteralPath $storePath -PathType Leaf) -or (Get-Sha256 -Path $storePath) -cne [string]$file.sha256) {
      throw "the bound VirtIO GPU DriverStore package differs from the supplied payload"
    }
  }
  return $binding
}

$virtioGpuDriverBinding = Get-VerifiedVirtioGpuDriverBinding
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$webView2 = Get-ChildItem "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients" -ErrorAction SilentlyContinue |
  Get-ItemProperty -ErrorAction SilentlyContinue |
  Where-Object { $_.pv -and $_.name -match "WebView" } |
  Select-Object -First 1
$displayAdapter = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
  Where-Object { $_.Status -eq "OK" -and -not [string]::IsNullOrWhiteSpace($_.Name) } |
  Select-Object -First 1
$audioDeviceRoleType = [Windows.Media.Devices.AudioDeviceRole, Windows.Media.Devices, ContentType = WindowsRuntime]
$audioDeviceRole = [System.Enum]::Parse($audioDeviceRoleType, "Default")
$audioEndpoint = [Windows.Media.Devices.MediaDevice, Windows.Media.Devices, ContentType = WindowsRuntime]::GetDefaultAudioRenderId($audioDeviceRole)
$soundDevices = @(Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue)
$hdaAudioDevices = @($soundDevices | Where-Object { $_.PNPDeviceID -match "^HDAUDIO\\" })
$serialPorts = @(Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue | Where-Object { $_.PNPDeviceID -match "VID_0403&PID_6001" } | Sort-Object DeviceID)
$remainingSerialPorts = @($serialPorts)
$serialRoleDevices = @()
for ($index = 0; $index -lt $ExpectedSerialRole.Count; $index += 1) {
  $usbPort = $ExpectedSerialUsbPort[$index]
  $match = @($remainingSerialPorts | Where-Object {
    $locationPaths = @((Get-PnpDeviceProperty -InstanceId $_.PNPDeviceID -KeyName "DEVPKEY_Device_LocationPaths" -ErrorAction Stop).Data)
    @($locationPaths | Where-Object { $_ -match "(^|#)USB\($usbPort\)($|#)" }).Count -eq 1
  } | Select-Object -First 1)
  if ($match.Count -ne 1) { continue }
  $device = $match[0]
  $locationPaths = @((Get-PnpDeviceProperty -InstanceId $device.PNPDeviceID -KeyName "DEVPKEY_Device_LocationPaths" -ErrorAction Stop).Data)
  $serialRoleDevices += @{ role = $ExpectedSerialRole[$index]; expectedUsbPort = $usbPort; deviceId = $device.DeviceID; name = $device.Name; pnpDeviceId = $device.PNPDeviceID; locationPaths = $locationPaths }
  $remainingSerialPorts = @($remainingSerialPorts | Where-Object { $_.DeviceID -ne $device.DeviceID })
}
function Get-ToolVersion {
  param([string] $FilePath)
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& $FilePath "--version" 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) { return $null }
  $version = $output |
    ForEach-Object { ([string]$_).Trim() } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_ -notmatch "^info:" } |
    Select-Object -First 1
  if ($null -eq $version) { return $null }
  return [string]$version
}

$runtimeEnvironmentKeys = @(
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PNPM_HOME",
  "COREPACK_HOME",
  "CARGO_TARGET_DIR",
  "SCCACHE_DIR",
  "TURBO_CACHE_DIR",
  "npm_config_cache",
  "PNPM_STORE_PATH",
  "CARGO_REGISTRY_CACHE",
  "CARGO_GIT_CACHE"
)
foreach ($key in $runtimeEnvironmentKeys) {
  $machineValue = [Environment]::GetEnvironmentVariable($key, "Machine")
  if (-not [string]::IsNullOrWhiteSpace($machineValue)) {
    Set-Item -Path "Env:$key" -Value $machineValue
  }
}
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
if (-not [string]::IsNullOrWhiteSpace($machinePath)) {
  $env:Path = $machinePath + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

$tools = @("git", "node", "corepack", "pnpm", "turbo", "cargo", "rustc", "rustup") | ForEach-Object {
  $command = Get-Command $_ -ErrorAction SilentlyContinue
  @{
    name = $_
    available = $null -ne $command
    source = if ($null -eq $command) { $null } else { [string]$command.Source }
    version = if ($null -eq $command) { $null } else { Get-ToolVersion -FilePath $command.Source }
  }
}
$toolVersion = @{}
foreach ($tool in $tools) { $toolVersion[$tool.name] = $tool.version }
$expectedMachinePaths = @{
  CARGO_HOME = "$toolchainRoot\cargo\$rustNamespace"
  RUSTUP_HOME = "$toolchainRoot\rustup\$rustNamespace"
  PNPM_HOME = "$toolchainRoot\pnpm\$pnpmNamespace"
  COREPACK_HOME = "$toolchainRoot\corepack\$nodeNamespace"
  CARGO_TARGET_DIR = "$cacheRoot\target\$rustNamespace"
  SCCACHE_DIR = "$cacheRoot\sccache\$rustNamespace"
  TURBO_CACHE_DIR = "$cacheRoot\turbo\$turboNamespace"
  npm_config_cache = "$cacheRoot\npm\$nodeNamespace"
  PNPM_STORE_PATH = "$cacheRoot\pnpm-store\$pnpmNamespace"
  CARGO_REGISTRY_CACHE = "$cacheRoot\cargo-registry\$rustNamespace"
  CARGO_GIT_CACHE = "$cacheRoot\cargo-git\$rustNamespace"
}
$machinePaths = @{}
foreach ($entry in $expectedMachinePaths.GetEnumerator()) {
  $machinePaths[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Machine")
}
$machinePathsExact = @($expectedMachinePaths.GetEnumerator() | Where-Object {
  $machinePaths[$_.Key] -cne $_.Value
}).Count -eq 0
$executablesOnSystemDisk = @($tools | Where-Object {
  $_.available -and $_.source -notlike "C:\*"
}).Count -eq 0
$cargoRegistryLink = Get-Item -LiteralPath (Join-Path $expectedMachinePaths.CARGO_HOME "registry") -Force -ErrorAction SilentlyContinue
$cargoGitLink = Get-Item -LiteralPath (Join-Path $expectedMachinePaths.CARGO_HOME "git") -Force -ErrorAction SilentlyContinue
$cargoDownloadCachesOnD = $null -ne $cargoRegistryLink -and $cargoRegistryLink.LinkType -eq "Junction" -and @($cargoRegistryLink.Target) -contains "$cacheRoot\cargo-registry\$rustNamespace" -and $null -ne $cargoGitLink -and $cargoGitLink.LinkType -eq "Junction" -and @($cargoGitLink.Target) -contains "$cacheRoot\cargo-git\$rustNamespace"
$exactToolchainVersions = $toolVersion.node -ceq "v$nodeVersion" -and $toolVersion.pnpm -ceq $pnpmVersion -and $toolVersion.turbo -ceq $turboVersion -and $toolVersion.cargo -match "^cargo 1\.96\.0 " -and $toolVersion.rustc -match "^rustc 1\.96\.0 "
$cachePartition = Get-Partition -DriveLetter D -ErrorAction SilentlyContinue
$cacheVolume = if ($null -ne $cachePartition) {
  $cachePartition | Get-Volume -ErrorAction SilentlyContinue
} else {
  $null
}
$cacheWritable = $null -ne $cacheVolume -and $cacheVolume.FileSystem -eq "NTFS"
if ($cacheWritable) {
  $probe = "D:\runtime-cache\v1\.verification-write-test"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $probe) | Out-Null
  Set-Content -Encoding ascii -Path $probe -Value "ok"
  Remove-Item -Force $probe
}
$checks = @{
  desktop = $interactiveDisplay.desktop.width -eq $ExpectedWidth -and $interactiveDisplay.desktop.height -eq $ExpectedHeight -and $interactiveDisplay.desktop.scalePercent -eq $ExpectedScalePercent
  SSH = (Get-Service sshd -ErrorAction SilentlyContinue).Status -eq "Running"
  runner = $null -ne $runnerService -and $runnerService.Status -eq "Running" -and $runnerRegistration.runnerUrl -ceq $ExpectedRunnerUrl -and $runnerRegistration.runnerName -ceq $ExpectedRunnerName -and $runnerRegistration.serviceName -ceq $ExpectedRunnerServiceName -and $runnerConfiguration.agentName -ceq $ExpectedRunnerName -and $runnerConfigurationUrl -ceq $ExpectedRunnerUrl -and $runnerRegistration.runnerWorkRoot -ceq "C:\actions-runner\_work" -and $runnerLabelsMatch
  toolchain = @($tools | Where-Object { -not $_.available }).Count -eq 0 -and $exactToolchainVersions -and $machinePathsExact -and $executablesOnSystemDisk -and $cargoDownloadCachesOnD
  WebView2 = $null -ne $webView2
  displayAdapter = $null -ne $displayAdapter -and -not [string]::IsNullOrWhiteSpace([string]$interactiveDisplay.displayAdapter)
  displayDriverBinding = $null -ne $virtioGpuDriverBinding
  Audio = $ExpectedAudioModel -ceq "ich9" -and -not [string]::IsNullOrWhiteSpace($audioEndpoint) -and $hdaAudioDevices.Count -eq 1
  Serial = $serialPorts.Count -eq $ExpectedSerialRole.Count -and $serialRoleDevices.Count -eq $ExpectedSerialRole.Count -and $remainingSerialPorts.Count -eq 0
  cacheDisk = $cacheWritable
}
$report = @{
  schemaVersion = "win10-kvm-baseline-verification/v1"
  ok = @($checks.Values | Where-Object { -not $_ }).Count -eq 0
  checks = $checks
  desktop = @{ width = $interactiveDisplay.desktop.width; height = $interactiveDisplay.desktop.height; scalePercent = $interactiveDisplay.desktop.scalePercent; interactiveUser = $interactiveDisplay.interactiveUser; interactiveSessionId = $interactiveDisplay.interactiveSessionId; source = "interactive-autologon-report" }
  runner = @{ expected = @{ url = $ExpectedRunnerUrl; name = $ExpectedRunnerName; labels = $expectedRunnerLabels; serviceName = $ExpectedRunnerServiceName }; registration = $runnerRegistration; registrationLabelsMatch = $runnerLabelsMatch; configuration = @{ agentName = $runnerConfiguration.agentName; url = $runnerConfigurationUrl }; service = @{ name = $runnerService.Name; status = [string]$runnerService.Status } }
  virtualDevices = @{ serialRoles = $serialRoleDevices; expectedAudio = @{ model = $ExpectedAudioModel; guestBus = "HDAUDIO" }; defaultAudioRenderIdPresent = -not [string]::IsNullOrWhiteSpace($audioEndpoint); hdaAudioDevice = @{ name = $hdaAudioDevices[0].Name; pnpDeviceId = $hdaAudioDevices[0].PNPDeviceID }; displayAdapter = $displayAdapter.Name; displayDriverBinding = $virtioGpuDriverBinding; cacheDisk = @{ driveLetter = "D"; fileSystem = $cacheVolume.FileSystem; writable = $cacheWritable } }
  toolchain = @{ commands = $tools; expectedMachinePaths = $expectedMachinePaths; machinePaths = $machinePaths; exactVersions = $exactToolchainVersions; executablesOnSystemDisk = $executablesOnSystemDisk; cargoDownloadCachesOnD = $cargoDownloadCachesOnD }
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $OutputPath
if (-not $report.ok) { exit 1 }
