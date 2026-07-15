param(
  [switch]$PrintPlan,
  [string]$ValidateFixturePath,
  [string]$EvidencePath,
  [string]$MachineUiPath = "C:\VEM\bringup\machine.exe",
  [string]$RuntimeAcceptanceReportPath = "C:\ProgramData\VEM\vending-daemon\runtime-acceptance-report.json",
  [string]$ManagedUpdateManifestPath,
  [string]$ManagedUpdateEvidencePath,
  [string]$ExpectedTestbedHost = "DESKTOP-2STVS5B",
  [string]$CdpEndpoint = "http://127.0.0.1:9222"
)

$ErrorActionPreference = "Stop"

$plan = [ordered]@{
  schemaVersion = "protected-touch-keyboard-acceptance-plan/v1"
  stage = "L2_windows_vm_runtime"
  requiredSessionUser = "VEMKiosk"
  allowedRoutes = @("bring-up", "maintenance")
  deniedRoutes = @("boot", "catalog", "checkout", "payment", "dispensing", "result")
  observations = @(
    [ordered]@{
      code = "bring_up_touch_entry"
      instruction = "在 Bring-Up 的可编辑字段上仅用触摸打开应用内键盘，完成字符、数字、布局切换和删除。"
    },
    [ordered]@{
      code = "bring_up_native_submit"
      instruction = "在隔离 testbed 的安全 Bring-Up 表单中用键盘确认键提交，并观察与物理键盘相同的校验/提交结果。"
    },
    [ordered]@{
      code = "maintenance_unauthorized_denied"
      instruction = "进入未认证 Maintenance，聚焦 PIN 字段，确认应用内键盘不可见。"
    },
    [ordered]@{
      code = "maintenance_authorized_touch_entry"
      instruction = "用物理键盘完成 Maintenance 认证后，聚焦非敏感可编辑字段，确认应用内键盘可输入并可收起。"
    },
    [ordered]@{
      code = "customer_route_denied"
      instruction = "切换到 Boot 和客户路由，确认键盘立即关闭且不能重新调用。"
    },
    [ordered]@{
      code = "physical_keyboard_preserved"
      instruction = "回到已授权字段，用物理键盘输入并提交，确认行为未被应用内键盘拦截。"
    }
  )
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "required evidence file is missing: $Path"
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Normalize-Sha256([object]$Value, [string]$Label) {
  $normalized = ([string]$Value).Trim().ToLowerInvariant()
  if ($normalized -notmatch "^[0-9a-f]{64}$") {
    throw "$Label must be a SHA-256 digest"
  }
  return $normalized
}

function Normalize-WindowsPath([object]$Value) {
  return ([string]$Value).Trim().Replace("/", "\").TrimEnd("\").ToLowerInvariant()
}

function Normalize-CdpEndpoint([object]$Value) {
  $candidate = ([string]$Value).Trim()
  if ($candidate -cnotmatch '^http://(?<host>127\.0\.0\.1|(?i:localhost)):(?<port>[0-9]{1,5})/?$') {
    throw "CDP endpoint must be an exact loopback HTTP endpoint"
  }
  $port = [int]$Matches.port
  if ($port -lt 1 -or $port -gt 65535) {
    throw "CDP endpoint port must be between 1 and 65535"
  }
  return "http://127.0.0.1:$port"
}

function Test-TauriHashRouteUrl([object]$Value) {
  try {
    $uri = [System.Uri]::new([string]$Value)
    return (
      $uri.Scheme -eq "http" -and
      $uri.Host -eq "tauri.localhost" -and
      $uri.AbsolutePath -eq "/" -and
      $uri.Fragment.StartsWith("#/")
    )
  } catch {
    return $false
  }
}

function Get-SingleComponent([object]$Components, [string]$Label) {
  $matches = @($Components | Where-Object { [string]$_.component -eq "ui" })
  if ($matches.Count -ne 1) {
    throw "$Label must contain exactly one ui component"
  }
  return $matches[0]
}

function Assert-ComponentSourceBindings([object]$ManifestComponents, [object]$BoundComponents) {
  $manifestItems = @($ManifestComponents)
  $boundItems = @($BoundComponents)
  if ($manifestItems.Count -ne $boundItems.Count) {
    throw "managed-update source binding component count does not match manifest"
  }
  foreach ($manifestComponent in $manifestItems) {
    $matches = @($boundItems | Where-Object {
        [string]$_.component -ceq [string]$manifestComponent.component -and
        (Normalize-WindowsPath $_.targetPath) -ceq (Normalize-WindowsPath $manifestComponent.targetPath)
      })
    if ($matches.Count -ne 1) {
      throw "managed-update source binding must uniquely identify every manifest component"
    }
    $boundComponent = $matches[0]
    if ((Normalize-Sha256 $boundComponent.sha256 "source-bound component") -cne (Normalize-Sha256 $manifestComponent.sha256 "manifest component")) {
      throw "managed-update source binding component hash does not match manifest"
    }
    $manifestSidecars = if ($null -eq $manifestComponent.sidecars) { @() } else { @($manifestComponent.sidecars) }
    $boundSidecars = if ($null -eq $boundComponent.sidecars) { @() } else { @($boundComponent.sidecars) }
    if ($manifestSidecars.Count -ne $boundSidecars.Count) {
      throw "managed-update source binding sidecar count does not match manifest"
    }
    foreach ($manifestSidecar in $manifestSidecars) {
      $sidecarMatches = @($boundSidecars | Where-Object {
          (Normalize-WindowsPath $_.targetPath) -ceq (Normalize-WindowsPath $manifestSidecar.targetPath)
        })
      if (
        $sidecarMatches.Count -ne 1 -or
        (Normalize-Sha256 $sidecarMatches[0].sha256 "source-bound sidecar") -cne (Normalize-Sha256 $manifestSidecar.sha256 "manifest sidecar")
      ) {
        throw "managed-update source binding sidecar does not match manifest"
      }
    }
  }
}

function Assert-InstalledComponentBindings([object]$BoundComponents, [object]$InstalledComponents) {
  $boundItems = @($BoundComponents)
  $installedItems = @($InstalledComponents)
  if ($boundItems.Count -ne $installedItems.Count) {
    throw "managed-update installed component count does not match source binding"
  }
  foreach ($boundComponent in $boundItems) {
    $matches = @($installedItems | Where-Object {
        [string]$_.component -ceq [string]$boundComponent.component -and
        (Normalize-WindowsPath $_.targetPath) -ceq (Normalize-WindowsPath $boundComponent.targetPath)
      })
    if ($matches.Count -ne 1) {
      throw "managed-update evidence must uniquely identify every installed component"
    }
    $installedComponent = $matches[0]
    $boundSha256 = Normalize-Sha256 $boundComponent.sha256 "source-bound component"
    if (
      -not [bool]$installedComponent.ok -or
      (Normalize-Sha256 $installedComponent.expectedSha256 "installed component expected") -cne $boundSha256 -or
      (Normalize-Sha256 $installedComponent.installedSha256 "installed component actual") -cne $boundSha256
    ) {
      throw "managed-update installed component hash does not match source binding"
    }
    $boundSidecars = if ($null -eq $boundComponent.sidecars) { @() } else { @($boundComponent.sidecars) }
    $installedSidecars = if ($null -eq $installedComponent.sidecars) { @() } else { @($installedComponent.sidecars) }
    if ($boundSidecars.Count -ne $installedSidecars.Count) {
      throw "managed-update installed sidecar count does not match source binding"
    }
    foreach ($boundSidecar in $boundSidecars) {
      $sidecarMatches = @($installedSidecars | Where-Object {
          (Normalize-WindowsPath $_.targetPath) -ceq (Normalize-WindowsPath $boundSidecar.targetPath)
        })
      $boundSidecarSha256 = Normalize-Sha256 $boundSidecar.sha256 "source-bound sidecar"
      if (
        $sidecarMatches.Count -ne 1 -or
        (Normalize-Sha256 $sidecarMatches[0].expectedSha256 "installed sidecar expected") -cne $boundSidecarSha256 -or
        (Normalize-Sha256 $sidecarMatches[0].installedSha256 "installed sidecar actual") -cne $boundSidecarSha256
      ) {
        throw "managed-update installed sidecar hash does not match source binding"
      }
    }
  }
}

function Assert-AcceptanceFixture([object]$Fixture, [string]$ExpectedHost) {
  if ([string]$Fixture.host.computerName -cne $ExpectedHost) {
    throw "acceptance fixture host does not match the dedicated testbed"
  }

  $artifactSha256 = Normalize-Sha256 $Fixture.artifact.sha256 "deployed machine UI"
  if ([long]$Fixture.artifact.sizeBytes -le 0) {
    throw "deployed machine UI size must be positive"
  }

  $runtime = $Fixture.runtimeAcceptance
  if (-not ([string]$runtime.target.machineCode).StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) {
    throw "runtime acceptance must use a VEM-TESTBED-* machine identity"
  }
  if (
    [string]$runtime.result.runtimeReady.status -ne "passed" -or
    -not [bool]$runtime.result.runtimeReady.asserted
  ) {
    throw "authoritative runtime acceptance must have passed"
  }
  if ((Normalize-Sha256 $runtime.artifacts.machineUiSha256 "runtime acceptance machine UI") -cne $artifactSha256) {
    throw "runtime acceptance machine UI hash does not match the deployed artifact"
  }

  $machine = $Fixture.liveRuntime.machineProcess
  $listener = $Fixture.liveRuntime.cdpListener
  $target = $Fixture.liveRuntime.cdpTarget
  $kiosk = $runtime.kioskRuntime
  $cdpEndpoint = Normalize-CdpEndpoint $Fixture.liveRuntime.cdpEndpoint
  $cdpPort = ([System.Uri]$cdpEndpoint).Port
  if (
    [string]$machine.sessionUser -cne "VEMKiosk" -or
    [int]$machine.processId -le 0 -or
    [int]$machine.sessionId -le 0
  ) {
    throw "live machine.exe must belong to the VEMKiosk interactive session"
  }
  if (
    -not [bool]$listener.bound -or
    [int]$listener.processId -le 0 -or
    [int]$listener.sessionId -ne [int]$machine.sessionId -or
    [int]$listener.machineAncestorProcessId -ne [int]$machine.processId -or
    [string]$listener.localAddress -cne "127.0.0.1" -or
    [int]$listener.localPort -ne $cdpPort
  ) {
    throw "live CDP listener must be in the kiosk session and descend from machine.exe"
  }
  if (-not (Test-TauriHashRouteUrl $target.url) -or [string]::IsNullOrWhiteSpace([string]$target.id)) {
    throw "live CDP target must be a bound tauri.localhost hash route"
  }
  if (
    -not [bool]$kiosk.webviewRunning -or
    -not [bool]$kiosk.cdpAvailable -or
    [string]$kiosk.sessionUser -cne "VEMKiosk" -or
    [int]$kiosk.processId -ne [int]$machine.processId -or
    [int]$kiosk.sessionId -ne [int]$machine.sessionId -or
    [int]$kiosk.cdpListenerProcessId -ne [int]$listener.processId -or
    [int]$kiosk.cdpListenerSessionId -ne [int]$listener.sessionId -or
    [int]$kiosk.cdpMachineAncestorProcessId -ne [int]$machine.processId -or
    [string]$kiosk.cdpTargetId -cne [string]$target.id -or
    [string]$kiosk.url -cne [string]$target.url
  ) {
    throw "live CDP/process/session facts do not match authoritative runtime acceptance"
  }

  $delivery = $Fixture.delivery
  $manifest = $delivery.manifest
  $managedUpdate = $delivery.evidence
  $manifestSha256 = Normalize-Sha256 $delivery.manifestSha256 "deployed managed-update manifest"
  $sourceCommit = ([string]$manifest.sourceCommit).Trim().ToLowerInvariant()
  if ($sourceCommit -notmatch "^[0-9a-f]{40}$") {
    throw "managed-update manifest must bind a full Git sourceCommit"
  }
  $sourceBinding = $managedUpdate.sourceBinding
  if (
    [string]$sourceBinding.schemaVersion -cne "managed-update-source-binding/v1" -or
    (Normalize-Sha256 $sourceBinding.manifestSha256 "managed-update evidence manifest") -cne $manifestSha256 -or
    ([string]$sourceBinding.sourceCommit).Trim().ToLowerInvariant() -cne $sourceCommit -or
    [string]$sourceBinding.updateId -cne [string]$manifest.updateId
  ) {
    throw "managed-update evidence source binding does not match the deployed manifest"
  }
  Assert-ComponentSourceBindings $manifest.components $sourceBinding.components
  Assert-InstalledComponentBindings $sourceBinding.components $managedUpdate.components
  if (
    [string]::IsNullOrWhiteSpace([string]$manifest.updateId) -or
    [string]$managedUpdate.updateId -cne [string]$manifest.updateId -or
    -not [bool]$managedUpdate.ok -or
    [string]$managedUpdate.host -cne $ExpectedHost -or
    (Normalize-WindowsPath $managedUpdate.manifestPath) -cne (Normalize-WindowsPath $delivery.manifestPath)
  ) {
    throw "managed-update evidence does not bind the supplied delivery manifest"
  }
  $manifestUi = Get-SingleComponent $manifest.components "managed-update manifest"
  $evidenceUi = Get-SingleComponent $managedUpdate.components "managed-update evidence"
  $artifactPath = Normalize-WindowsPath $Fixture.artifact.path
  if (
    (Normalize-WindowsPath $manifestUi.targetPath) -cne $artifactPath -or
    (Normalize-WindowsPath $evidenceUi.targetPath) -cne $artifactPath -or
    (Normalize-Sha256 $manifestUi.sha256 "manifest ui") -cne $artifactSha256 -or
    (Normalize-Sha256 $evidenceUi.expectedSha256 "managed-update expected ui") -cne $artifactSha256 -or
    (Normalize-Sha256 $evidenceUi.installedSha256 "managed-update installed ui") -cne $artifactSha256 -or
    -not [bool]$evidenceUi.ok
  ) {
    throw "managed-update manifest/evidence does not bind the deployed machine UI bytes"
  }

  return [ordered]@{
    status = "passed"
    sourceCommit = $sourceCommit
    machineUiSha256 = $artifactSha256
    machineProcessId = [int]$machine.processId
    cdpListenerProcessId = [int]$listener.processId
    sessionId = [int]$machine.sessionId
  }
}

if ($PrintPlan) {
  $plan | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

if (-not [string]::IsNullOrWhiteSpace($ValidateFixturePath)) {
  $fixture = Read-JsonFile $ValidateFixturePath
  $validation = Assert-AcceptanceFixture $fixture $ExpectedTestbedHost
  $validation | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

if ([string]::IsNullOrWhiteSpace($EvidencePath)) {
  throw "-EvidencePath is required"
}
if ([string]::IsNullOrWhiteSpace($ManagedUpdateManifestPath)) {
  throw "-ManagedUpdateManifestPath is required"
}
if ([string]::IsNullOrWhiteSpace($ManagedUpdateEvidencePath)) {
  throw "-ManagedUpdateEvidencePath is required"
}
$normalizedCdpEndpoint = Normalize-CdpEndpoint $CdpEndpoint
if ($env:OS -ne "Windows_NT") {
  throw "interactive touch-keyboard acceptance must run on Windows"
}
if ($env:COMPUTERNAME -cne $ExpectedTestbedHost) {
  throw "refusing non-testbed host $($env:COMPUTERNAME); expected $ExpectedTestbedHost"
}
if (-not (Test-Path -LiteralPath $MachineUiPath -PathType Leaf)) {
  throw "machine UI artifact is missing: $MachineUiPath"
}

$artifact = Get-Item -LiteralPath $MachineUiPath
$artifactHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $MachineUiPath).Hash.ToLowerInvariant()
$machineCim = @(
  Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" |
    Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq [System.IO.Path]::GetFullPath($MachineUiPath)) }
)
if ($machineCim.Count -ne 1) {
  throw "expected exactly one canonical machine.exe process, found $($machineCim.Count)"
}
$machineProcess = Get-Process -Id $machineCim[0].ProcessId
$ownerResult = Invoke-CimMethod -InputObject $machineCim[0] -MethodName GetOwner

$runtimeAcceptance = Read-JsonFile $RuntimeAcceptanceReportPath
$manifest = Read-JsonFile $ManagedUpdateManifestPath
$managedUpdateEvidence = Read-JsonFile $ManagedUpdateEvidencePath
$authoritativeKiosk = $runtimeAcceptance.kioskRuntime
$listenerCim = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$authoritativeKiosk.cdpListenerProcessId)"
$bound = $false
$cursor = $listenerCim
for ($depth = 0; $depth -lt 32 -and $null -ne $cursor; $depth += 1) {
  if ([int]$cursor.ProcessId -eq [int]$machineProcess.Id) {
    $bound = $true
    break
  }
  $parentId = [int]$cursor.ParentProcessId
  if ($parentId -le 0 -or $parentId -eq [int]$cursor.ProcessId) { break }
  $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
}
$listenerSocket = @(
  Get-NetTCPConnection -LocalPort ([System.Uri]$normalizedCdpEndpoint).Port -State Listen |
    Where-Object {
      [int]$_.OwningProcess -eq [int]$listenerCim.ProcessId -and
      [string]$_.LocalAddress -ceq "127.0.0.1"
    }
)
if ($listenerSocket.Count -eq 0) {
  throw "authoritative CDP listener PID is not listening on the configured endpoint"
}
$targets = @(Invoke-RestMethod -Uri "$normalizedCdpEndpoint/json" -TimeoutSec 5)
$target = @($targets | Where-Object { [string]$_.id -ceq [string]$authoritativeKiosk.cdpTargetId })
if ($target.Count -ne 1) {
  throw "authoritative CDP target is not present on the live listener"
}

$fixture = [ordered]@{
  host = [ordered]@{ computerName = $env:COMPUTERNAME }
  artifact = [ordered]@{
    path = $MachineUiPath
    sizeBytes = [long]$artifact.Length
    sha256 = $artifactHash
  }
  liveRuntime = [ordered]@{
    cdpEndpoint = $normalizedCdpEndpoint
    machineProcess = [ordered]@{
      processId = [int]$machineProcess.Id
      sessionId = [int]$machineProcess.SessionId
      sessionUser = [string]$ownerResult.User
    }
    cdpListener = [ordered]@{
      processId = [int]$listenerCim.ProcessId
      sessionId = [int]$listenerCim.SessionId
      machineAncestorProcessId = if ($bound) { [int]$machineProcess.Id } else { $null }
      bound = $bound
      localAddress = [string]$listenerSocket[0].LocalAddress
      localPort = [int]$listenerSocket[0].LocalPort
    }
    cdpTarget = [ordered]@{
      id = [string]$target[0].id
      url = [string]$target[0].url
    }
  }
  runtimeAcceptance = $runtimeAcceptance
  delivery = [ordered]@{
    manifestPath = $ManagedUpdateManifestPath
    manifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ManagedUpdateManifestPath).Hash.ToLowerInvariant()
    evidencePath = $ManagedUpdateEvidencePath
    manifest = $manifest
    evidence = $managedUpdateEvidence
  }
}
$validation = Assert-AcceptanceFixture $fixture $ExpectedTestbedHost

Write-Host "受保护触摸键盘 Windows 交互验收"
Write-Host "仅在专用 testbed 的临时身份/数据上执行；敏感值只可输入 kiosk 表单，禁止在本脚本终端输入或回显。"
Write-Host "构件: $($validation.machineUiSha256)；源: $($validation.sourceCommit)；会话: VEMKiosk/$($validation.sessionId)"

$results = @()
foreach ($observation in $plan.observations) {
  Write-Host ""
  Write-Host "[$($observation.code)] $($observation.instruction)"
  $answer = (Read-Host "现场观察是否通过？输入 YES").Trim()
  if ($answer -cne "YES") {
    throw "interactive acceptance failed or was not observed: $($observation.code)"
  }
  $results += [ordered]@{
    code = $observation.code
    status = "passed"
    observedAt = (Get-Date).ToUniversalTime().ToString("o")
    source = "physical_touch_observation"
  }
}

$evidence = [ordered]@{
  schemaVersion = "protected-touch-keyboard-acceptance-evidence/v1"
  stage = $plan.stage
  status = "passed"
  sourceCommit = $validation.sourceCommit
  recordedAt = (Get-Date).ToUniversalTime().ToString("o")
  authority = [ordered]@{
    runtimeAcceptanceReportPath = $RuntimeAcceptanceReportPath
    managedUpdateManifestPath = $ManagedUpdateManifestPath
    managedUpdateEvidencePath = $ManagedUpdateEvidencePath
  }
  host = $fixture.host
  artifact = $fixture.artifact
  interactiveRuntime = [ordered]@{
    processId = $validation.machineProcessId
    sessionId = $validation.sessionId
    sessionUser = "VEMKiosk"
    cdpListenerProcessId = $validation.cdpListenerProcessId
    cdpTargetId = [string]$target[0].id
    pageUrl = [string]$target[0].url
  }
  observations = $results
  secretValuesRecorded = $false
}

$parent = Split-Path -Parent $EvidencePath
if (-not [string]::IsNullOrWhiteSpace($parent)) {
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
}
$evidence | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
$evidence | ConvertTo-Json -Depth 10 -Compress
