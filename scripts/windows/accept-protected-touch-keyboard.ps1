param(
  [switch]$PrintPlan,
  [string]$EvidencePath,
  [string]$MachineUiPath = "C:\VEM\bringup\machine.exe",
  [string]$ExpectedMachineUiSha256,
  [string]$SourceCommit,
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

if ($PrintPlan) {
  $plan | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

if ([string]::IsNullOrWhiteSpace($EvidencePath)) {
  throw "-EvidencePath is required"
}
if ($ExpectedMachineUiSha256 -notmatch "^[A-Fa-f0-9]{64}$") {
  throw "-ExpectedMachineUiSha256 must be a SHA-256 digest"
}
if ([string]::IsNullOrWhiteSpace($SourceCommit)) {
  throw "-SourceCommit is required"
}
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
if ($artifactHash -cne $ExpectedMachineUiSha256.ToLowerInvariant()) {
  throw "machine UI artifact hash does not match the accepted delivery unit"
}

$machineCim = @(
  Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" |
    Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq [System.IO.Path]::GetFullPath($MachineUiPath)) }
)
if ($machineCim.Count -ne 1) {
  throw "expected exactly one canonical machine.exe process, found $($machineCim.Count)"
}
$machineProcess = Get-Process -Id $machineCim[0].ProcessId
$ownerResult = Invoke-CimMethod -InputObject $machineCim[0] -MethodName GetOwner
$sessionUser = [string]$ownerResult.User
if ($sessionUser -cne $plan.requiredSessionUser) {
  throw "machine UI must run in the VEMKiosk interactive session, found $sessionUser"
}

$targets = @(Invoke-RestMethod -Uri "$($CdpEndpoint.TrimEnd('/'))/json" -TimeoutSec 5)
$tauriTargets = @($targets | Where-Object { [string]$_.url -match '^http://tauri\.localhost/#/' })
if ($tauriTargets.Count -ne 1) {
  throw "expected one tauri.localhost CDP target, found $($tauriTargets.Count)"
}
$target = $tauriTargets[0]

Write-Host "受保护触摸键盘 Windows 交互验收"
Write-Host "仅在专用 testbed 的临时身份/数据上执行；敏感值只可输入 kiosk 表单，禁止在本脚本终端输入或回显。"
Write-Host "构件: $artifactHash；会话: $sessionUser/$($machineProcess.SessionId)；页面: $($target.url)"

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
  sourceCommit = $SourceCommit
  recordedAt = (Get-Date).ToUniversalTime().ToString("o")
  host = [ordered]@{
    computerName = $env:COMPUTERNAME
    expectedTestbedHost = $ExpectedTestbedHost
  }
  artifact = [ordered]@{
    path = $MachineUiPath
    sizeBytes = [long]$artifact.Length
    sha256 = $artifactHash
  }
  interactiveRuntime = [ordered]@{
    processId = [int]$machineProcess.Id
    sessionId = [int]$machineProcess.SessionId
    sessionUser = $sessionUser
    cdpTargetId = [string]$target.id
    pageUrl = [string]$target.url
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
