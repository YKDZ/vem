param(
  [Parameter(Mandatory = $true)][string]$DaemonExe,
  [Parameter(Mandatory = $true)][string]$MachineUiExe,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [string]$ServiceName = "VemVendingDaemon",
  [string]$ComPort = "COM3",
  [string]$ScannerPort = "COM4"
)

$ErrorActionPreference = "Stop"
$record = [ordered]@{
  startedAt = (Get-Date).ToString("o")
  os = (Get-CimInstance Win32_OperatingSystem).Caption
  webView2 = $null
  serviceName = $ServiceName
  dataDir = $DataDir
  comPort = $ComPort
  scannerPort = $ScannerPort
  checks = @()
}

function Add-Check([string]$Name, [bool]$Passed, [string]$Detail) {
  $record.checks += [ordered]@{ name = $Name; passed = $Passed; detail = $Detail }
  if (-not $Passed) { throw "$Name failed: $Detail" }
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$acl = Get-Acl $DataDir
Add-Check "data-dir-acl-readable" ($acl.Access.Count -gt 0) "ACL entries: $($acl.Access.Count)"

$webViewKey = "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients"
$webView = Get-ChildItem $webViewKey -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ItemProperty $_.PsPath } |
  Where-Object { $_.name -like "*WebView2*" } |
  Select-Object -First 1
$record.webView2 = $webView.pv
Add-Check "webview2-installed" ($null -ne $webView) "version=$($webView.pv)"

if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}
sc.exe create $ServiceName binPath= "`"$DaemonExe`" --data-dir `"$DataDir`"" start= auto | Out-Null
sc.exe failure $ServiceName reset= 60 actions= restart/5000/restart/5000/""/5000 | Out-Null
Start-Service $ServiceName
Start-Sleep -Seconds 5
$svc = Get-Service $ServiceName
Add-Check "service-running" ($svc.Status -eq "Running") "status=$($svc.Status)"

$readyFile = Join-Path $DataDir "daemon-ready.json"
Add-Check "ready-file-exists" (Test-Path $readyFile) $readyFile
$ready = Get-Content $readyFile | ConvertFrom-Json
$health = Invoke-RestMethod $ready.healthzUrl
Add-Check "healthz-ok" ($health.status -eq "ok") ($health | ConvertTo-Json -Compress)

$ports = [System.IO.Ports.SerialPort]::GetPortNames()
Add-Check "lower-controller-com-port-present" ($ports -contains $ComPort) ($ports -join ",")
Add-Check "scanner-com-port-present" ($ports -contains $ScannerPort) ($ports -join ",")

$ui = Start-Process -FilePath $MachineUiExe -PassThru
Start-Sleep -Seconds 5
Add-Check "kiosk-started" (-not $ui.HasExited) "pid=$($ui.Id)"
$ui.Kill()

Restart-Service $ServiceName
Start-Sleep -Seconds 5
$svc = Get-Service $ServiceName
Add-Check "service-restart-running" ($svc.Status -eq "Running") "status=$($svc.Status)"

$record.finishedAt = (Get-Date).ToString("o")
$out = Join-Path $DataDir "windows-hardware-acceptance.json"
$record | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $out
Write-Output "acceptance record: $out"
