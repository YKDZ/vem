# VEM Win10 machine provisioning script
#
# Idempotently configures production machine startup:
#   - VemVendingDaemon Windows service, automatic startup.
#   - VEMMachineUI logon task, starts Tauri UI in the interactive session.
#   - VEM\StartVisionServer logon task, starts vision in the user session.
#   - launch-machine-ui.vbs, starts the UI visibly and enables WebView CDP.
#   - Optional Winlogon auto-logon.
#
# Typical usage from elevated PowerShell:
#   .\setup-scheduled-tasks.ps1
#
# Configure auto-logon. Prefer setting the password through an operator shell
# environment variable so it is not left in command history:
#   $env:VEM_AUTOLOGON_PASSWORD = "..."
#   .\setup-scheduled-tasks.ps1 -ConfigureAutoLogon
#
# If the local Admin account is intentionally passwordless:
#   .\setup-scheduled-tasks.ps1 -ConfigureAutoLogon -AllowBlankAutoLogonPassword

[CmdletBinding()]
param(
  [string]$RunAsUser = "Admin",
  [string]$AutoLogonDomain = $env:COMPUTERNAME,

  [string]$BringupDir = "C:\VEM\bringup",
  [string]$DaemonExe = "C:\VEM\bringup\vending-daemon.exe",
  [string]$MachineUiExe = "C:\VEM\bringup\machine.exe",
  [string]$MachineUiLauncher = "C:\VEM\bringup\launch-machine-ui.vbs",
  [string]$MachineUiShortcutName = "VEM Machine UI.lnk",
  [string]$VisionLauncher = "C:\VEM\start_vision.bat",
  [string]$VisionWorkingDirectory = "D:\ai-cv\vending_vision",

  [switch]$ConfigureAutoLogon,
  [string]$AutoLogonPassword = $env:VEM_AUTOLOGON_PASSWORD,
  [switch]$AllowBlankAutoLogonPassword,
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session"
  }
}

function Escape-XmlText {
  param([string]$Value)
  return [System.Security.SecurityElement]::Escape($Value)
}

function Ensure-Directory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Ensure-MachineUiLauncher {
  param(
    [string]$LauncherPath,
    [string]$ExePath,
    [string]$WorkingDirectory
  )

  Ensure-Directory -Path (Split-Path -Parent $LauncherPath)
  $content = @(
    'Set oShell = CreateObject("WScript.Shell")',
    'Set env = oShell.Environment("PROCESS")',
    'env("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") = "--remote-debugging-port=9222"',
    ('oShell.CurrentDirectory = "{0}"' -f $WorkingDirectory),
    ('oShell.Run """{0}""", 1, False' -f $ExePath)
  )
  Set-Content -LiteralPath $LauncherPath -Value $content -Encoding ASCII
}

function Ensure-DaemonService {
  param([string]$ExePath)

  if (-not (Test-Path -LiteralPath $ExePath)) {
    Write-Warning "daemon exe not found; skipping service creation: $ExePath"
    return
  }

  $existing = Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
  if (-not $existing) {
    New-Service `
      -Name "VemVendingDaemon" `
      -BinaryPathName ('"{0}"' -f $ExePath) `
      -DisplayName "VEM Vending Daemon" `
      -StartupType Automatic | Out-Null
  } else {
    sc.exe config VemVendingDaemon binPath= ('"{0}"' -f $ExePath) start= auto | Out-Null
  }

  sc.exe failure VemVendingDaemon reset= 86400 actions= restart/5000/restart/15000/""/0 | Out-Null
}

function Ensure-MachineUiShortcut {
  param(
    [string]$ShortcutName,
    [string]$LauncherPath,
    [string]$WorkingDirectory,
    [string]$IconPath
  )

  $desktop = [Environment]::GetFolderPath("Desktop")
  if ([string]::IsNullOrWhiteSpace($desktop)) {
    Write-Warning "desktop folder not found; skipping machine UI shortcut"
    return
  }

  Ensure-Directory -Path $desktop
  $shortcutPath = Join-Path $desktop $ShortcutName
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = "C:\Windows\System32\wscript.exe"
  $shortcut.Arguments = ('"{0}"' -f $LauncherPath)
  $shortcut.WorkingDirectory = $WorkingDirectory
  if (Test-Path -LiteralPath $IconPath) {
    $shortcut.IconLocation = $IconPath
  }
  $shortcut.Description = "Start VEM kiosk full-screen machine UI"
  $shortcut.Save()
}

function Register-InteractiveLogonTask {
  param(
    [string]$TaskName,
    [string]$Command,
    [string]$Arguments,
    [string]$WorkingDirectory,
    [string]$DelayISO,
    [string]$User,
    [int]$RestartOnFailureCount = 0,
    [string]$RestartOnFailureIntervalISO = "PT1M"
  )

  $commandXml = Escape-XmlText -Value $Command
  $argumentsXml = Escape-XmlText -Value $Arguments
  $workingDirectoryXml = Escape-XmlText -Value $WorkingDirectory
  $userXml = Escape-XmlText -Value $User

  $argumentElement = if ($Arguments.Trim().Length -gt 0) {
    "<Arguments>$argumentsXml</Arguments>"
  } else {
    ""
  }
  $workingDirectoryElement = if ($WorkingDirectory.Trim().Length -gt 0) {
    "<WorkingDirectory>$workingDirectoryXml</WorkingDirectory>"
  } else {
    ""
  }
  $restartOnFailureElement = if ($RestartOnFailureCount -gt 0) {
    $restartIntervalXml = Escape-XmlText -Value $RestartOnFailureIntervalISO
    @"
    <RestartOnFailure>
      <Interval>$restartIntervalXml</Interval>
      <Count>$RestartOnFailureCount</Count>
    </RestartOnFailure>
"@
  } else {
    ""
  }

  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>VEM Provisioning</Author>
    <Description>$TaskName</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$userXml</UserId>
      <Delay>$DelayISO</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$userXml</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    $restartOnFailureElement
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$commandXml</Command>
      $argumentElement
      $workingDirectoryElement
    </Exec>
  </Actions>
</Task>
"@

  $tmpFile = [System.IO.Path]::GetTempFileName() + ".xml"
  try {
    [System.IO.File]::WriteAllText($tmpFile, $xml, [System.Text.Encoding]::Unicode)
    schtasks /Create /TN $TaskName /XML $tmpFile /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to register scheduled task: $TaskName"
    }
  } finally {
    Remove-Item $tmpFile -ErrorAction SilentlyContinue
  }
}

function Disable-EdgeAutoLaunch {
  $runPaths = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"
  )

  foreach ($path in $runPaths) {
    if (-not (Test-Path $path)) { continue }
    $item = Get-ItemProperty -Path $path
    foreach ($property in $item.PSObject.Properties) {
      if ($property.Name -match "Edge|msedge|MicrosoftEdge") {
        Remove-ItemProperty -Path $path -Name $property.Name -ErrorAction SilentlyContinue
      }
    }
  }
}

function Configure-WinlogonAutoLogon {
  param(
    [string]$User,
    [string]$Domain,
    [string]$Password,
    [bool]$AllowBlank
  )

  if ($Password.Length -eq 0 -and -not $AllowBlank) {
    throw "Auto-logon requires -AutoLogonPassword, env VEM_AUTOLOGON_PASSWORD, or explicit -AllowBlankAutoLogonPassword"
  }

  $path = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
  New-ItemProperty -Path $path -Name "AutoAdminLogon" -Value "1" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $path -Name "ForceAutoLogon" -Value "1" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $path -Name "DefaultUserName" -Value $User -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $path -Name "DefaultDomainName" -Value $Domain -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $path -Name "DefaultPassword" -Value $Password -PropertyType String -Force | Out-Null
}

function Show-Verification {
  Write-Host "`n=== VEM startup verification ===" -ForegroundColor Cyan
  Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue |
    Select-Object Name, Status, StartType | Format-Table -AutoSize
  schtasks /Query /TN "VEMMachineUI" /FO LIST 2>$null
  schtasks /Query /TN "VEM\StartVisionServer" /FO LIST 2>$null
  Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" |
    Select-Object AutoAdminLogon, ForceAutoLogon, DefaultUserName, DefaultDomainName |
    Format-List
}

Assert-Administrator
Ensure-Directory -Path $BringupDir

Write-Host "=== VEM Win10 machine provisioning ===" -ForegroundColor Cyan

Write-Host "[1/6] Write machine UI launcher" -ForegroundColor Yellow
Ensure-MachineUiLauncher `
  -LauncherPath $MachineUiLauncher `
  -ExePath $MachineUiExe `
  -WorkingDirectory $BringupDir

Write-Host "[2/6] Configure daemon service" -ForegroundColor Yellow
Ensure-DaemonService -ExePath $DaemonExe

Write-Host "[3/6] Configure VEMMachineUI logon task" -ForegroundColor Yellow
Register-InteractiveLogonTask `
  -TaskName "VEMMachineUI" `
  -Command "C:\Windows\System32\wscript.exe" `
  -Arguments ('"{0}"' -f $MachineUiLauncher) `
  -WorkingDirectory $BringupDir `
  -DelayISO "PT15S" `
  -User $RunAsUser

Write-Host "[3b/6] Create desktop shortcut" -ForegroundColor Yellow
Ensure-MachineUiShortcut `
  -ShortcutName $MachineUiShortcutName `
  -LauncherPath $MachineUiLauncher `
  -WorkingDirectory $BringupDir `
  -IconPath $MachineUiExe

Write-Host "[4/6] Configure VEM\StartVisionServer logon task" -ForegroundColor Yellow
if (Test-Path -LiteralPath $VisionLauncher) {
  Register-InteractiveLogonTask `
    -TaskName "VEM\StartVisionServer" `
    -Command "C:\Windows\System32\cmd.exe" `
    -Arguments ('/c ""{0}""' -f $VisionLauncher) `
    -WorkingDirectory $VisionWorkingDirectory `
    -DelayISO "PT10S" `
    -User $RunAsUser `
    -RestartOnFailureCount 999 `
    -RestartOnFailureIntervalISO "PT1M"
} else {
  Write-Warning "vision launcher not found; skipping VEM\StartVisionServer task: $VisionLauncher"
  schtasks /Query /TN "VEM\StartVisionServer" *> $null
  if ($LASTEXITCODE -eq 0) {
    schtasks /Delete /TN "VEM\StartVisionServer" /F | Out-Null
  }
}

Write-Host "[5/6] Remove Edge auto-launch entries" -ForegroundColor Yellow
Disable-EdgeAutoLaunch

Write-Host "[6/6] Auto-logon configuration" -ForegroundColor Yellow
if ($ConfigureAutoLogon) {
  $allowBlankAutoLogon = [bool]$AllowBlankAutoLogonPassword
  Configure-WinlogonAutoLogon -User $RunAsUser -Domain $AutoLogonDomain -Password $AutoLogonPassword -AllowBlank $allowBlankAutoLogon
  Write-Host "Enabled Winlogon auto-logon: $AutoLogonDomain\$RunAsUser"
} else {
  Write-Host "Auto-logon not enabled. Re-run with -ConfigureAutoLogon for unattended cold boot."
}

if ($StartNow) {
  Start-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
  schtasks /Run /TN "VEM\StartVisionServer" | Out-Null
  schtasks /Run /TN "VEMMachineUI" | Out-Null
}

Show-Verification
Write-Host "`nDone." -ForegroundColor Green
