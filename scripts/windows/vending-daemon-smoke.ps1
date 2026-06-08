param(
  [Parameter(Mandatory = $true)][string]$DaemonExe,
  [Parameter(Mandatory = $true)][string]$MachineUiExe,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [string]$MachineConfig = "",
  [string]$ServiceName = "VemVendingDaemon",
  [string]$ComPort = "COM3",
  [string]$ScannerPort = "COM4",
  [string]$SensitivePaymentCode = ""
)

$ErrorActionPreference = "Stop"
$record = [ordered]@{
  startedAt = (Get-Date).ToString("o")
  os = (Get-CimInstance Win32_OperatingSystem).Caption
  webView2 = $null
  serviceName = $ServiceName
  dataDir = $DataDir
  machineConfig = $MachineConfig
  comPort = $ComPort
  scannerPort = $ScannerPort
  checks = @()
}

function Add-Check([string]$Name, [bool]$Passed, [string]$Detail) {
  $record.checks += [ordered]@{ name = $Name; passed = $Passed; detail = $Detail }
  if (-not $Passed) { throw "$Name failed: $Detail" }
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
if ($MachineConfig.Length -gt 0) {
  Add-Check "machine-config-source-exists" (Test-Path $MachineConfig) $MachineConfig
  $targetConfig = Join-Path $DataDir "machine-config.json"
  Copy-Item -Force -Path $MachineConfig -Destination $targetConfig
  Add-Check "machine-config-seeded" (Test-Path $targetConfig) $targetConfig
}
$acl = Get-Acl $DataDir
Add-Check "data-dir-acl-readable" ($acl.Access.Count -gt 0) "ACL entries: $($acl.Access.Count)"

$webViewKey = "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients"
$webView = Get-ChildItem $webViewKey -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ItemProperty $_.PsPath } |
  Where-Object { $_.name -like "*WebView2*" } |
  Select-Object -First 1
$record.webView2 = $webView.pv
Add-Check "webview2-installed" ($null -ne $webView) "version=$($webView.pv)"

$readyFile = Join-Path $DataDir "daemon-ready.json"

if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}
sc.exe create $ServiceName binPath= "`"$DaemonExe`" --data-dir `"$DataDir`" --print-ready-file `"$readyFile`"" start= auto | Out-Null
sc.exe failure $ServiceName reset= 60 actions= restart/5000/restart/5000/""/5000 | Out-Null
Start-Service $ServiceName
Start-Sleep -Seconds 5
$svc = Get-Service $ServiceName
Add-Check "service-running" ($svc.Status -eq "Running") "status=$($svc.Status)"

Add-Check "ready-file-exists" (Test-Path $readyFile) $readyFile
$ready = Get-Content $readyFile | ConvertFrom-Json
$health = Invoke-RestMethod $ready.healthzUrl
Add-Check "healthz-json" ($null -ne $health.status) ($health | ConvertTo-Json -Compress)
$baseUrl = $ready.healthzUrl -replace "/healthz$", ""
$headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
$scanner = Invoke-RestMethod "$baseUrl/v1/scanner/status" -Headers $headers
Add-Check "scanner-adapter-serial-text" ($scanner.adapter -eq "serial_text") ($scanner | ConvertTo-Json -Compress)
Add-Check "scanner-status-diagnostic" ($scanner.code.Length -gt 0 -and $scanner.message.Length -gt 0) ($scanner | ConvertTo-Json -Compress)

$ports = [System.IO.Ports.SerialPort]::GetPortNames()
Add-Check "lower-controller-com-port-present" ($ports -contains $ComPort) ($ports -join ",")
Add-Check "scanner-com-port-present" ($ports -contains $ScannerPort) ($ports -join ",")

$previousReadyFile = [Environment]::GetEnvironmentVariable("VEM_DAEMON_READY_FILE", "Process")
$previousDataDir = [Environment]::GetEnvironmentVariable("VEM_DAEMON_DATA_DIR", "Process")
[Environment]::SetEnvironmentVariable("VEM_DAEMON_READY_FILE", $readyFile, "Process")
[Environment]::SetEnvironmentVariable("VEM_DAEMON_DATA_DIR", $DataDir, "Process")
try {
  $ui = Start-Process -FilePath $MachineUiExe -PassThru
} finally {
  [Environment]::SetEnvironmentVariable("VEM_DAEMON_READY_FILE", $previousReadyFile, "Process")
  [Environment]::SetEnvironmentVariable("VEM_DAEMON_DATA_DIR", $previousDataDir, "Process")
}
Start-Sleep -Seconds 5
Add-Check "kiosk-started" (-not $ui.HasExited) "pid=$($ui.Id)"
$ui.Kill()

Restart-Service $ServiceName
Start-Sleep -Seconds 5
$svc = Get-Service $ServiceName
Add-Check "service-restart-running" ($svc.Status -eq "Running") "status=$($svc.Status)"

if ($SensitivePaymentCode.Length -gt 0) {
  $logText = Get-ChildItem -Path $DataDir -Recurse -File |
    Where-Object { $_.Extension -in ".json",".jsonl",".log",".txt" } |
    ForEach-Object { Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue } |
    Out-String
  Add-Check "payment-code-plaintext-absent" (-not $logText.Contains($SensitivePaymentCode)) "data dir text scanned"
}

$record.finishedAt = (Get-Date).ToString("o")
$out = Join-Path $DataDir "windows-hardware-acceptance.json"
$record | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $out
Write-Output "acceptance record: $out"
